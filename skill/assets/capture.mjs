// ============================================================================
// capture.mjs — screenshot every configured route of a web app.
//
// Standalone, copy-portable script that lives in the target project's
// screenshots/ folder. Reads screenshots.config.jsonc, starts any dev servers
// it declares, screenshots every route at each viewport into
// <part>/NN-name.viewport.png, then hands off to generate.mjs for the gallery.
//
// ONE FILE by design (PLAN.md §5): the whole tool is capture.mjs + generate.mjs,
// and the folder must be readable top-to-bottom and trivially portable. Sections
// below are marked with banner comments and follow PLAN.md §5.1–5.9.
//
// The ONLY dependency is `playwright`. JSONC is parsed by a tiny inline
// comment-stripper (§5.2) — no config-parser dependency.
// ============================================================================

import { chromium } from "playwright";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

// ============================================================================
// SECTION 1 — CLI (§5.1)
// ============================================================================

const USAGE = `
capture.mjs — screenshot every configured route of a web app.

Usage:
  node capture.mjs                       Capture everything in the config
  node capture.mjs --part <name>         Only this part (repeatable)
  node capture.mjs --route "<glob>"      Filter routes by path glob (repeatable)
  node capture.mjs --viewport <name>     Only this viewport
  node capture.mjs --state <name>        Only states matching (base is always kept)
  node capture.mjs --login <part>        Headed one-time login → storageState
  node capture.mjs --keep-servers        Don't stop servers we started
  node capture.mjs --dry-run             Print the capture matrix, no browser
  node capture.mjs --no-gallery          Skip the generate.mjs gallery step
  node capture.mjs --prune               Delete stale PNGs from removed routes
  node capture.mjs --config <path>       Config file (default: screenshots.config.jsonc)
  node capture.mjs --help                Show this help
`.trimStart();

function parseArgs(argv) {
	const opts = {
		parts: [],
		routes: [],
		viewport: null,
		states: [],
		login: null,
		keepServers: false,
		dryRun: false,
		noGallery: false,
		prune: false,
		config: "screenshots.config.jsonc",
		help: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => {
			const v = argv[++i];
			if (v === undefined) fail(`flag ${a} needs a value`);
			return v;
		};
		switch (a) {
			case "--part": opts.parts.push(next()); break;
			case "--route": opts.routes.push(next()); break;
			case "--viewport": opts.viewport = next(); break;
			case "--state": opts.states.push(next()); break;
			case "--login": opts.login = next(); break;
			case "--keep-servers": opts.keepServers = true; break;
			case "--dry-run": opts.dryRun = true; break;
			case "--no-gallery": opts.noGallery = true; break;
			case "--prune": opts.prune = true; break;
			case "--config": opts.config = next(); break;
			case "-h":
			case "--help": opts.help = true; break;
			default: fail(`unknown flag: ${a}`);
		}
	}
	return opts;
}

function fail(msg) {
	console.error(`error: ${msg}`);
	process.exit(1);
}

// ============================================================================
// SECTION 2 — JSONC parse + config/secrets load (§5.2)
// ============================================================================

// ~20-line comment stripper: removes // line comments and /* block */ comments
// and trailing commas, while leaving string contents untouched. No dependency.
function stripJsonc(src) {
	let out = "";
	let inStr = false, quote = "", inLine = false, inBlock = false;
	for (let i = 0; i < src.length; i++) {
		const c = src[i], n = src[i + 1];
		if (inLine) { if (c === "\n") { inLine = false; out += c; } continue; }
		if (inBlock) { if (c === "*" && n === "/") { inBlock = false; i++; } continue; }
		if (inStr) {
			out += c;
			if (c === "\\") { out += src[++i] ?? ""; continue; }
			if (c === quote) inStr = false;
			continue;
		}
		if (c === '"' || c === "'") { inStr = true; quote = c; out += c; continue; }
		if (c === "/" && n === "/") { inLine = true; i++; continue; }
		if (c === "/" && n === "*") { inBlock = true; i++; continue; }
		out += c;
	}
	// Drop trailing commas: `,` followed by only whitespace then } or ]
	return out.replace(/,(\s*[}\]])/g, "$1");
}

async function loadConfig(configPath) {
	let raw;
	try {
		raw = await fs.readFile(configPath, "utf8");
	} catch {
		fail(`config not found: ${configPath}`);
	}
	let parsed;
	try {
		parsed = JSON.parse(stripJsonc(raw));
	} catch (e) {
		fail(`config is not valid JSONC (${configPath}): ${e.message}`);
	}
	validateConfig(parsed);
	return parsed;
}

// Secrets: load .screenshots-auth/secrets.env as KEY=value lines into
// process.env WITHOUT overriding already-set real environment variables.
async function loadSecrets() {
	const file = path.join(".screenshots-auth", "secrets.env");
	let raw;
	try {
		raw = await fs.readFile(file, "utf8");
	} catch {
		return; // optional
	}
	for (const line of raw.split("\n")) {
		const t = line.trim();
		if (!t || t.startsWith("#")) continue;
		const eq = t.indexOf("=");
		if (eq === -1) continue;
		const key = t.slice(0, eq).trim();
		let val = t.slice(eq + 1).trim();
		if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
			val = val.slice(1, -1);
		}
		if (process.env[key] === undefined) process.env[key] = val;
	}
}

// --- Structural validation with friendly, path-precise errors (§5.2) --------

class ConfigError extends Error {}

function validateConfig(cfg) {
	try {
		checkObject(cfg, "config");
		if (cfg.version !== 1) bad("version", "must be the number 1");
		if (cfg.project !== undefined && typeof cfg.project !== "string")
			bad("project", "must be a string");

		if (cfg.viewports !== undefined) {
			checkArray(cfg.viewports, "viewports");
			cfg.viewports.forEach((v, i) => {
				const p = `viewports[${i}]`;
				checkObject(v, p);
				if (typeof v.name !== "string") bad(p, "`name` must be a string");
				if (typeof v.width !== "number") bad(p, "`width` must be a number");
				if (typeof v.height !== "number") bad(p, "`height` must be a number");
			});
		}
		if (cfg.fullPage !== undefined && typeof cfg.fullPage !== "boolean")
			bad("fullPage", "must be a boolean");

		if (cfg.settle !== undefined) {
			checkObject(cfg.settle, "settle");
			for (const k of ["networkIdleMs", "timeoutMs", "extraDelayMs"]) {
				if (cfg.settle[k] !== undefined && typeof cfg.settle[k] !== "number")
					bad("settle", `\`${k}\` must be a number`);
			}
			if (cfg.settle.disableAnimations !== undefined && typeof cfg.settle.disableAnimations !== "boolean")
				bad("settle", "`disableAnimations` must be a boolean");
		}

		checkArray(cfg.parts, "parts");
		if (cfg.parts.length === 0) bad("parts", "must contain at least one part");
		cfg.parts.forEach((part, pi) => {
			const pp = `parts[${pi}]`;
			checkObject(part, pp);
			if (typeof part.name !== "string") bad(pp, "`name` must be a string");
			if (part.dir !== undefined && typeof part.dir !== "string") bad(pp, "`dir` must be a string");

			if (part.server !== undefined) {
				checkObject(part.server, `${pp}.server`);
				if (typeof part.server.url !== "string") bad(`${pp}.server`, "`url` must be a string");
			}
			if (part.companions !== undefined) {
				checkArray(part.companions, `${pp}.companions`);
				part.companions.forEach((c, ci) => {
					const cp = `${pp}.companions[${ci}]`;
					checkObject(c, cp);
					if (typeof c.command !== "string") bad(cp, "`command` must be a string");
					if (!c.url && !c.readyPattern)
						bad(cp, "must set either `url` or `readyPattern` for readiness");
				});
			}
			// auth block: parsed but semantics ignored here (SEAM(#4)).
			if (part.auth !== undefined) checkObject(part.auth, `${pp}.auth`);

			checkArray(part.routes, `${pp}.routes`);
			part.routes.forEach((r, ri) => {
				const rp = `${pp}.routes[${ri}]`;
				checkObject(r, rp);
				if (typeof r.path !== "string") bad(rp, "`path` must be a string");
				if (typeof r.name !== "string") bad(rp, "`name` must be a string");
				if (r.params !== undefined) checkObject(r.params, rp, "`params`");
				if (r.states !== undefined) {
					checkArray(r.states, rp, "`states`");
					r.states.forEach((s, si) => {
						checkObject(s, rp, `states[${si}]`);
						if (typeof s.name !== "string") bad(rp, `states[${si}].name must be a string`);
						if (!Array.isArray(s.actions)) bad(rp, `states[${si}].actions must be an array`);
					});
				}
			});
		});
	} catch (e) {
		if (e instanceof ConfigError) fail(`invalid config — ${e.message}`);
		throw e;
	}
}

function bad(pathStr, msg) { throw new ConfigError(`${pathStr}: ${msg}`); }
function checkObject(v, pathStr, field) {
	if (typeof v !== "object" || v === null || Array.isArray(v))
		bad(pathStr, field ? `\`${field}\` must be an object` : "must be an object");
}
function checkArray(v, pathStr, field) {
	if (!Array.isArray(v)) bad(pathStr, field ? `\`${field}\` must be an array` : "must be an array");
}

// ============================================================================
// SECTION 3 — Server lifecycle (§5.3)
// ============================================================================

// Only servers WE spawn are tracked here; probed/reused servers are never ours.
const startedServers = []; // { name, child, pgid }

async function probe(url, retries = 3, gapMs = 1000) {
	for (let i = 0; i < retries; i++) {
		if (await httpUp(url)) return true;
		if (i < retries - 1) await sleep(gapMs);
	}
	return false;
}

async function httpUp(url) {
	try {
		const ctrl = new AbortController();
		const t = setTimeout(() => ctrl.abort(), 2500);
		const res = await fetch(url, { redirect: "manual", signal: ctrl.signal });
		clearTimeout(t);
		return res.status < 500;
	} catch {
		return false;
	}
}

// Start a server unless its url is already up. Returns { ours: boolean }.
async function ensureServer(spec, repoRoot, logsDir) {
	const { name, command, cwd, url, readyPattern, readyTimeoutMs = 60000 } = spec;

	if (url && (await probe(url))) {
		console.log(`  · ${name}: already up at ${url} (reusing, not ours)`);
		return { ours: false };
	}
	if (!command) {
		fail(`server "${name}" is not up at ${url} and has no \`command\` to start it`);
	}

	const runCwd = path.resolve(repoRoot, cwd || spec.dir || ".");
	const logPath = path.join(logsDir, `${name}.log`);
	console.log(`  · ${name}: starting \`${command}\` in ${runCwd} (log: ${logPath})`);

	// Redirect the child's stdout/stderr STRAIGHT to the log file (not through a
	// parent pipe): this keeps the child fully independent of our process, so a
	// --keep-servers child survives our exit and never blocks on a full pipe or
	// dies from SIGPIPE. Readiness is read back from the file (readyPattern) or
	// polled from the url. detached:true gives the child its own process group so
	// process.kill(-pid) tears down the whole tree (e.g. `pnpm dev` children).
	const logFh = await fs.open(logPath, "a");
	const child = spawn(command, { cwd: runCwd, shell: true, detached: true, stdio: ["ignore", logFh.fd, logFh.fd] });
	const entry = { name, child, pgid: child.pid };
	startedServers.push(entry);
	await logFh.close(); // child holds its own dup of the fd

	const readyRe = readyPattern ? new RegExp(readyPattern) : null;
	const deadline = Date.now() + readyTimeoutMs;
	while (Date.now() < deadline) {
		if (readyRe) {
			const log = await fs.readFile(logPath, "utf8").catch(() => "");
			if (readyRe.test(log)) { console.log(`  · ${name}: ready (matched /${readyPattern}/)`); return { ours: true }; }
		} else if (url) {
			if (await httpUp(url)) { console.log(`  · ${name}: ready (${url})`); return { ours: true }; }
		}
		if (child.exitCode !== null) fail(`server "${name}" exited early (code ${child.exitCode}); see ${logPath}`);
		await sleep(500);
	}
	fail(`server "${name}" did not become ready within ${readyTimeoutMs}ms; see ${logPath}`);
}

// Teardown: SIGTERM the process group, 5s grace, then SIGKILL. Only ours.
async function teardownServers(keepServers) {
	if (keepServers) {
		if (startedServers.length) console.log(`\nLeaving ${startedServers.length} server(s) running (--keep-servers).`);
		// Children write to the log file (not a parent pipe) and have their own
		// process group, so unref() lets THIS process exit while they keep running.
		for (const s of startedServers.splice(0)) s.child.unref();
		return;
	}
	// SIGTERM the process groups, 5s grace, then SIGKILL survivors.
	const killing = startedServers.splice(0);
	for (const s of killing) killGroup(s.pgid, "SIGTERM");
	await sleep(5000);
	for (const s of killing) {
		if (s.child.exitCode === null && s.child.signalCode === null) killGroup(s.pgid, "SIGKILL");
	}
}

function killGroup(pid, signal) {
	if (!pid) return;
	try {
		process.kill(-pid, signal); // negative pid → whole process group
		console.log(`  · sent ${signal} to process group ${pid}`);
	} catch {
		try { process.kill(pid, signal); } catch { /* already gone */ }
	}
}

// Synchronous best-effort kill for signal handlers (async teardown can't run).
function killAllSync() {
	for (const s of startedServers.splice(0)) {
		try { process.kill(-s.pgid, "SIGKILL"); } catch { try { process.kill(s.pgid, "SIGKILL"); } catch { /* gone */ } }
	}
}

// ============================================================================
// SECTION 4 — Auth resolution → browser context (§5.4)
// ============================================================================
//
// Four strategies from the §4 config schema:
//   none            → plain context.
//   manual-session  → storageState from .screenshots-auth/<part>.storageState.json;
//                     missing file does NOT fail the run — auth:true routes become
//                     gated with the `--login` remedy, everything else captures.
//   credentials     → scripted form login ONCE per part per run; the resulting
//                     storageState is held in memory and reused across that part's
//                     viewport contexts. Missing env → same gated-not-failed path.
//   header          → inject a credential per the `inject` block:
//                     kind:header → extraHTTPHeaders, kind:cookie → addCookies,
//                     kind:query  → appended to every navigated URL.
//
// resolveAuth() returns a resolved auth context for a part:
//   { contextOptions, cookies, query, unmet }
//   - contextOptions : merged into browser.newContext() (storageState / headers)
//   - cookies        : passed to context.addCookies() after creation (kind:cookie)
//   - query          : "k=v" appended to every navigated URL (kind:query)
//   - unmet          : null, or { reason, remedy } when the credential is missing
//                      / login failed → auth:true routes are recorded gated, the
//                      run never fails.

function statePath(partName) {
	return path.join(".screenshots-auth", `${partName}.storageState.json`);
}

async function fileExists(f) {
	try { await fs.access(f); return true; } catch { return false; }
}

// Remedy string offered for a gated route, per the part's strategy.
function remedyFor(part) {
	const s = part.auth?.strategy;
	if (s === "credentials" || s === "manual-session") return `node capture.mjs --login ${part.name}`;
	if (s === "header") {
		const e = part.auth?.inject?.valueEnv;
		return `set ${e || "the credential env var"} in .screenshots-auth/secrets.env`;
	}
	return `configure auth for part "${part.name}"`;
}

// Verify a post-login URL against the config's `success` block. No block → we
// cannot verify, so assume success (caller may warn).
function verifySuccess(success, url) {
	if (!success) return true;
	if (success.urlNotMatching && url.includes(success.urlNotMatching)) return false;
	if (success.urlMatching && !url.includes(success.urlMatching)) return false;
	return true;
}

const NO_AUTH = { contextOptions: {}, cookies: [], query: "", unmet: null };

async function resolveAuth(part, browser, baseUrl) {
	const auth = part.auth;
	const strategy = auth?.strategy;
	if (!strategy || strategy === "none") return NO_AUTH;
	const remedy = remedyFor(part);

	if (strategy === "manual-session") {
		const file = statePath(part.name);
		if (await fileExists(file)) return { contextOptions: { storageState: file }, cookies: [], query: "", unmet: null };
		return { ...NO_AUTH, unmet: { reason: `no saved session (${file} missing)`, remedy } };
	}

	if (strategy === "header") return resolveHeaderInject(auth, baseUrl, remedy);

	if (strategy === "credentials") return resolveCredentials(part, browser, baseUrl, remedy);

	fail(`parts[].auth.strategy "${strategy}" is not supported (none | credentials | manual-session | header)`);
}

// header strategy: read the credential value from env (never from config), then
// place it as an HTTP header, a cookie, or a query param.
function resolveHeaderInject(auth, baseUrl, remedy) {
	const inject = auth.inject;
	if (!inject || !inject.kind) fail(`parts[].auth.inject must set { kind, name, valueEnv } for strategy "header"`);
	const val = process.env[inject.valueEnv];
	if (val === undefined || val === "") {
		return { ...NO_AUTH, unmet: { reason: `credential env ${inject.valueEnv} not set`, remedy: `set ${inject.valueEnv} in .screenshots-auth/secrets.env` } };
	}
	const formatted = inject.format ? inject.format.replace("{value}", val) : val;
	if (inject.kind === "header") {
		return { contextOptions: { extraHTTPHeaders: { [inject.name]: formatted } }, cookies: [], query: "", unmet: null };
	}
	if (inject.kind === "cookie") {
		const u = new URL(baseUrl || "http://localhost");
		return { contextOptions: {}, cookies: [{ name: inject.name, value: formatted, domain: u.hostname, path: "/" }], query: "", unmet: null };
	}
	if (inject.kind === "query") {
		return { contextOptions: {}, cookies: [], query: `${encodeURIComponent(inject.name)}=${encodeURIComponent(formatted)}`, unmet: null };
	}
	fail(`parts[].auth.inject.kind "${inject.kind}" is not supported (header | cookie | query)`);
}

// credentials strategy: scripted form login ONCE per part per run. Reads creds
// from env (names only in config), fills the login form, verifies `success`,
// returns the resulting storageState object to reuse across viewport contexts.
async function resolveCredentials(part, browser, baseUrl, remedy) {
	const auth = part.auth;
	const f = auth.fields || {};
	const env = auth.env || {};
	const user = process.env[env.username];
	const pass = process.env[env.password];
	if (!user || !pass) {
		return { ...NO_AUTH, unmet: { reason: `login credentials not set (env ${env.username}/${env.password} missing)`, remedy: `set ${env.username} and ${env.password} in .screenshots-auth/secrets.env` } };
	}
	const loginUrl = baseUrl + (auth.loginPath || "/login");
	const ctx = await browser.newContext();
	const page = await ctx.newPage();
	try {
		await page.goto(loginUrl, { waitUntil: "load" });
		await page.fill(f.username, user);
		await page.fill(f.password, pass);
		await page.click(f.submit);
		// Wait until we leave the login path (soft nav after a server-action redirect),
		// bounded — a failed login stays on loginPath and simply times out here.
		const loginPath = auth.loginPath || "/login";
		await page.waitForURL((u) => new URL(u).pathname !== loginPath, { timeout: 8000 }).catch(() => {});
		const url = page.url();
		if (!verifySuccess(auth.success, url)) {
			await ctx.close();
			return { ...NO_AUTH, unmet: { reason: `login failed (landed on ${url})`, remedy } };
		}
		const state = await ctx.storageState();
		await ctx.close();
		console.log(`  · ${part.name}: logged in via credentials (session cached for this run)`);
		return { contextOptions: { storageState: state }, cookies: [], query: "", unmet: null };
	} catch (e) {
		await ctx.close().catch(() => {});
		return { ...NO_AUTH, unmet: { reason: `login error: ${e.message}`, remedy } };
	}
}

// Gate detection (§5.8): after a navigation, decide whether the route bounced to
// a login wall. Returns a human-readable reason (→ gated, no PNG) or null.
// The login page itself (route path == loginPath / matches gateSignal) is NEVER
// gated — we still want to screenshot it.
async function detectGate(part, requestedPath, finalUrl, page) {
	const auth = part.auth;
	if (!auth) return null;
	const gs = auth.gateSignal;
	const loginPath = auth.loginPath;
	const isLoginRoute =
		(gs?.urlMatching && requestedPath.includes(gs.urlMatching)) ||
		(loginPath && requestedPath === loginPath);
	if (isLoginRoute) return null;
	if (gs?.urlMatching && finalUrl.includes(gs.urlMatching)) {
		return `redirected to ${gs.urlMatching} — not authenticated (session missing or expired)`;
	}
	const sel = auth.fields?.username;
	if (sel) {
		const present = await page.$(sel).then((el) => !!el).catch(() => false);
		if (present) return `login form present (${sel}) — not authenticated`;
	}
	return null;
}

// ============================================================================
// SECTION 4b — `--login <part>` headed one-time login (§5.5)
// ============================================================================
//
// Launch a HEADED Chromium at server.url + loginPath, let the human complete the
// login, press Enter, verify success/gateSignal if configured (warn but save
// anyway if unverifiable), and write .screenshots-auth/<part>.storageState.json.
// Also serves as a session refresh. Server lifecycle applies.
async function runLogin(cfg, partName) {
	const part = cfg.parts.find((p) => p.name === partName);
	if (!part) fail(`--login: no part named "${partName}" in config`);
	const auth = part.auth || {};
	const baseUrl = part.server?.url?.replace(/\/$/, "") || "";
	const loginPath = auth.loginPath || "/login";

	const logsDir = path.resolve(".logs");
	await fs.mkdir(logsDir, { recursive: true });
	await fs.mkdir(".screenshots-auth", { recursive: true });
	const repoRoot = path.resolve(process.cwd(), "..");

	const onSignal = () => { killAllSync(); process.exit(130); };
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);

	// Companions first, then the part server (started only if not already up).
	for (const comp of part.companions || []) await ensureServer({ ...comp, dir: part.dir }, repoRoot, logsDir);
	if (part.server) await ensureServer({ name: part.name, ...part.server, dir: part.dir }, repoRoot, logsDir);

	let browser;
	try {
		browser = await chromium.launch({ headless: false });
		const context = await browser.newContext();
		const page = await context.newPage();
		await page.goto(baseUrl + loginPath, { waitUntil: "load" }).catch((e) => console.warn(`goto warning: ${e.message}`));

		console.log("\n" + "=".repeat(60));
		console.log(`Complete the login in the browser window for part "${partName}".`);
		console.log("Press Enter here once you're on a logged-in page.");
		console.log("=".repeat(60));
		await waitForEnter();

		const url = page.url();
		const verifiable = auth.success || auth.gateSignal;
		if (verifiable) {
			const ok =
				verifySuccess(auth.success, url) &&
				!(auth.gateSignal?.urlMatching && url.includes(auth.gateSignal.urlMatching));
			if (ok) console.log(`Verified: on ${url}.`);
			else console.warn(`Warning: could not verify a logged-in page (still on ${url}); saving session anyway.`);
		} else {
			console.log("No success/gateSignal configured — saving session without verification.");
		}

		const file = statePath(partName);
		await context.storageState({ path: file });
		console.log(`Saved session → ${file}`);
		await context.close();
	} finally {
		if (browser) await browser.close();
		await teardownServers(false);
	}
}

// Resolve on the next line typed at stdin (Enter). Used only by --login.
function waitForEnter() {
	return new Promise((resolve) => {
		process.stdin.resume();
		process.stdin.once("data", () => { process.stdin.pause(); resolve(); });
	});
}

// ============================================================================
// SECTION 5 — Settle heuristic (§5.6)
// ============================================================================
//
// All seven steps in order, bounded overall by settle.timeoutMs. We run our own
// network-quiet tracker (NOT Playwright's deprecated `networkidle`) and DEGRADE
// gracefully: on any timeout we warn to the console and proceed — a settle
// hiccup must never fail a shot.

const DEFAULT_SETTLE = { networkIdleMs: 500, timeoutMs: 15000, extraDelayMs: 250, disableAnimations: true };

// Animation-freeze CSS injected when disableAnimations is on (paired with the
// context-level reducedMotion:'reduce'). Kills mid-fade / mid-transition shots.
const FREEZE_CSS = `*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;transition-delay:0s!important;scroll-behavior:auto!important;caret-color:transparent!important}`;

// Attach an in-flight request counter to a page. Returns a waiter.
function attachNetworkTracker(page) {
	let inflight = 0;
	let lastChange = Date.now();
	const bump = (d) => { inflight += d; lastChange = Date.now(); };
	page.on("request", () => bump(1));
	page.on("requestfinished", () => bump(-1));
	page.on("requestfailed", () => bump(-1));
	return {
		async waitQuiet(quietMs, deadline) {
			while (Date.now() < deadline) {
				if (inflight <= 0 && Date.now() - lastChange >= quietMs) return true;
				await sleep(50);
			}
			console.warn(`    ! network did not go quiet within budget (inflight=${inflight}) — proceeding`);
			return false;
		},
	};
}

async function navigateAndSettle(page, url, settle, fullPage) {
	const deadline = Date.now() + (settle.timeoutMs ?? DEFAULT_SETTLE.timeoutMs);
	const net = attachNetworkTracker(page);

	// 1. goto (load)
	try {
		await page.goto(url, { waitUntil: "load", timeout: settle.timeoutMs ?? DEFAULT_SETTLE.timeoutMs });
	} catch (e) {
		console.warn(`    ! goto(${url}) warning: ${e.message}`);
	}

	// 2. Network quiet (own tracker)
	await net.waitQuiet(settle.networkIdleMs ?? DEFAULT_SETTLE.networkIdleMs, deadline);

	// 3. Fonts ready
	await safe(() => page.evaluate(() => document.fonts && document.fonts.ready), deadline);

	// 4. Two rAFs (layout flushed)
	await safe(() => page.evaluate(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)))), deadline);

	// 5. Per-route waitFor selector
	if (settle.waitFor) {
		try {
			await page.waitForSelector(settle.waitFor, { timeout: Math.max(0, deadline - Date.now()) });
		} catch {
			console.warn(`    ! waitFor selector "${settle.waitFor}" not found in budget — proceeding`);
		}
	}

	// 6. Fixed tail
	await sleep(Math.min(settle.extraDelayMs ?? DEFAULT_SETTLE.extraDelayMs, Math.max(0, deadline - Date.now())));

	// 7. Long-page pass: scroll to bottom and back to trigger lazy loaders, then
	//    re-wait network quiet once.
	if (fullPage) {
		const long = await safe(() => page.evaluate(() => document.body && document.body.scrollHeight > window.innerHeight * 1.5), deadline);
		if (long) {
			await safe(() => page.evaluate(async () => {
				const step = window.innerHeight;
				for (let y = 0; y < document.body.scrollHeight; y += step) {
					window.scrollTo(0, y);
					await new Promise((r) => setTimeout(r, 30));
				}
				window.scrollTo(0, 0);
			}), deadline);
			await net.waitQuiet(settle.networkIdleMs ?? DEFAULT_SETTLE.networkIdleMs, deadline);
		}
	}
}

async function safe(fn, deadline) {
	try {
		if (Date.now() >= deadline) return undefined;
		return await fn();
	} catch {
		return undefined;
	}
}

// ============================================================================
// SECTION 6 — State actions (§4 vocabulary, §5.7)
// ============================================================================
//
// Tiny v1 vocabulary: click, fill ["sel","val"], hover, press <key>,
// waitFor <selector>, wait <ms>, scrollTo <selector>.
async function runAction(page, action) {
	const [verb, arg] = Object.entries(action)[0] ?? [];
	switch (verb) {
		case "click": await page.click(arg); break;
		case "fill": await page.fill(arg[0], arg[1]); break;
		case "hover": await page.hover(arg); break;
		case "press": await page.keyboard.press(arg); break;
		case "waitFor": await page.waitForSelector(arg); break;
		case "wait": await sleep(arg); break;
		case "scrollTo": await page.locator(arg).scrollIntoViewIfNeeded(); break;
		default: throw new Error(`unknown state action: ${verb}`);
	}
}

// ============================================================================
// SECTION 7 — Matrix build (route/param/state expansion + filters, §5.7)
// ============================================================================

function buildMatrix(cfg, opts) {
	const viewports = cfg.viewports?.length ? cfg.viewports : DEFAULT_VIEWPORTS;
	const parts = [];
	for (const part of cfg.parts) {
		if (opts.parts.length && !opts.parts.includes(part.name)) continue;
		const routes = [];
		part.routes.forEach((route, idx) => {
			const nn = String(idx + 1).padStart(2, "0"); // NN from CONFIG order
			if (opts.routes.length && !opts.routes.some((g) => globMatch(g, route.path))) return;
			const url = expandParams(route.path, route.params);
			const states = (route.states || []).filter(
				(s) => opts.states.length === 0 || opts.states.includes(s.name),
			);
			routes.push({ route, nn, url, states });
		});
		if (routes.length) parts.push({ part, routes });
	}
	const chosenViewports = opts.viewport
		? viewports.filter((v) => v.name === opts.viewport)
		: viewports;
	if (opts.viewport && chosenViewports.length === 0)
		fail(`viewport "${opts.viewport}" not found in config`);
	return { parts, viewports: chosenViewports };
}

const DEFAULT_VIEWPORTS = [
	{ name: "desktop", width: 1440, height: 900 },
	{ name: "mobile", width: 390, height: 844 },
];

function expandParams(routePath, params) {
	return routePath.replace(/\[(\.\.\.)?([^\]]+)\]/g, (_m, _spread, key) => {
		if (params && params[key] !== undefined) return String(params[key]);
		return `__MISSING_${key}__`;
	});
}

// Minimal glob: ** → any (incl /), * → any within a segment.
function globMatch(glob, str) {
	const re = new RegExp(
		"^" +
			glob
				.replace(/[.+^${}()|\\]/g, "\\$&")
				.replace(/\*\*/g, " ")
				.replace(/\*/g, "[^/]*")
				.replace(/ /g, ".*")
				.replace(/\?/g, ".") +
			"$",
	);
	return re.test(str);
}

function baseFile(partName, nn, name, viewport) {
	return `${partName}/${nn}-${name}.${viewport}.png`;
}
function stateFile(partName, nn, name, state, viewport) {
	return `${partName}/${nn}-${name}.${state}.${viewport}.png`;
}

// ============================================================================
// SECTION 8 — Dry run (§5.1 --dry-run)
// ============================================================================

function printMatrix(matrix) {
	console.log("Capture matrix (dry run — no browser, no servers):\n");
	let shots = 0;
	for (const { part, routes } of matrix.parts) {
		console.log(`part: ${part.name}`);
		for (const { route, nn, url, states } of routes) {
			for (const v of matrix.viewports) {
				const missing = url.includes("__MISSING_");
				console.log(`  ${baseFile(part.name, nn, route.name, v.name)}   → ${url}${missing ? "  [MISSING PARAM]" : ""}`);
				shots++;
				for (const s of states) {
					console.log(`  ${stateFile(part.name, nn, route.name, s.name, v.name)}   → ${url} [${s.name}]`);
					shots++;
				}
			}
		}
	}
	console.log(`\n${shots} screenshot(s) across ${matrix.viewports.length} viewport(s).`);
}

// ============================================================================
// SECTION 9 — Capture loop (§5.7)
// ============================================================================

async function capture(cfg, opts, matrix, repoRoot, logsDir) {
	const settleBase = { ...DEFAULT_SETTLE, ...(cfg.settle || {}) };
	const fullPage = cfg.fullPage !== false;
	const results = []; // {part, path, name, status, files}

	// --- Start servers (companions BEFORE the part server) ------------------
	for (const { part } of matrix.parts) {
		for (const comp of part.companions || []) {
			await ensureServer({ ...comp, dir: part.dir }, repoRoot, logsDir);
		}
		if (part.server) {
			await ensureServer({ name: part.name, ...part.server, dir: part.dir }, repoRoot, logsDir);
		}
	}

	const browser = await chromium.launch();
	try {
		for (const { part, routes } of matrix.parts) {
			const baseUrl = part.server?.url?.replace(/\/$/, "") || "";
			const auth = await resolveAuth(part, browser, baseUrl); // §5.4
			const remedy = remedyFor(part);
			for (const v of matrix.viewports) {
				const context = await browser.newContext({
					viewport: { width: v.width, height: v.height },
					...(settleBase.disableAnimations ? { reducedMotion: "reduce" } : {}),
					...auth.contextOptions,
				});
				if (auth.cookies.length) await context.addCookies(auth.cookies);
				if (settleBase.disableAnimations) {
					await context.addInitScript((css) => {
						const inject = () => {
							const s = document.createElement("style");
							s.textContent = css;
							(document.head || document.documentElement).appendChild(s);
						};
						if (document.documentElement) inject();
						else document.addEventListener("DOMContentLoaded", inject);
					}, FREEZE_CSS);
				}
				const page = await context.newPage();

				for (const { route, nn, url, states } of routes) {
					const routeSettle = { ...settleBase, ...(route.settle || {}) };
					const label = `${part.name} ${nn}-${route.name} [${v.name}]`;
					if (url.includes("__MISSING_")) {
						console.log(`  ✗ ${label}: missing route param — skipped`);
						recordOnce(results, part.name, route, "error", [], "missing route param");
						continue;
					}
					// Proactive gate: creds/session missing for this part → auth:true
					// routes are gated (no PNG), everything else still captures (§5.4).
					if (route.auth === true && auth.unmet) {
						console.log(`  🔒 ${label}: gated — ${auth.unmet.reason}`);
						recordOnce(results, part.name, route, "gated", [], auth.unmet.reason, auth.unmet.remedy);
						continue;
					}
					const fullUrl = baseUrl + url + (auth.query ? (url.includes("?") ? "&" : "?") + auth.query : "");
					try {
						await navigateAndSettle(page, fullUrl, routeSettle, fullPage);
						const gate = await detectGate(part, url, page.url(), page); // §5.8
						if (gate) {
							console.log(`  🔒 ${label}: gated — ${gate}`);
							recordOnce(results, part.name, route, "gated", [], gate, remedy);
							continue;
						}
						const file = baseFile(part.name, nn, route.name, v.name);
						await page.screenshot({ path: path.resolve(file), fullPage });
						console.log(`  ✓ ${file}`);
						addFile(results, part.name, route, file);

						// States: FRESH navigation each (independent, not cumulative).
						for (const s of states) {
							try {
								await navigateAndSettle(page, fullUrl, routeSettle, fullPage);
								for (const action of s.actions) await runAction(page, action);
								await navigateAndSettle_afterActions(page, routeSettle, fullPage);
								const sf = stateFile(part.name, nn, route.name, s.name, v.name);
								await page.screenshot({ path: path.resolve(sf), fullPage });
								console.log(`  ✓ ${sf}`);
								addFile(results, part.name, route, sf);
							} catch (e) {
								console.log(`  ✗ ${label} state "${s.name}": ${e.message}`);
								recordOnce(results, part.name, route, "error", [], `state ${s.name}: ${e.message}`);
							}
						}
					} catch (e) {
						console.log(`  ✗ ${label}: ${e.message}`);
						recordOnce(results, part.name, route, "error", [], e.message);
					}
				}
				await context.close();
			}
		}
	} finally {
		await browser.close();
	}
	return results;
}

// Settle after running state actions: we don't re-goto (that would undo the
// interaction), so run the non-navigation settle steps (network quiet + rAF +
// tail) against the current DOM.
async function navigateAndSettle_afterActions(page, settle, _fullPage) {
	const deadline = Date.now() + (settle.timeoutMs ?? DEFAULT_SETTLE.timeoutMs);
	const net = attachNetworkTracker(page);
	await net.waitQuiet(settle.networkIdleMs ?? DEFAULT_SETTLE.networkIdleMs, deadline);
	await safe(() => page.evaluate(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)))), deadline);
	await sleep(Math.min(settle.extraDelayMs ?? DEFAULT_SETTLE.extraDelayMs, Math.max(0, deadline - Date.now())));
}

// Results helpers — one record per (part,route); files accumulate.
function findRec(results, partName, route) {
	return results.find((r) => r.part === partName && r.path === route.path && r.name === route.name);
}
function recordOnce(results, partName, route, status, files, reason, remedy) {
	let rec = findRec(results, partName, route);
	if (!rec) { rec = { part: partName, path: route.path, name: route.name, status, files: [] }; results.push(rec); }
	rec.status = status;
	if (reason) rec.reason = reason;
	if (remedy) rec.remedy = remedy;
	for (const f of files) if (!rec.files.includes(f)) rec.files.push(f);
}
function addFile(results, partName, route, file) {
	let rec = findRec(results, partName, route);
	if (!rec) { rec = { part: partName, path: route.path, name: route.name, status: "ok", files: [] }; results.push(rec); }
	if (rec.status !== "error" && rec.status !== "gated") rec.status = "ok";
	if (!rec.files.includes(file)) rec.files.push(file);
}

// ============================================================================
// SECTION 9b — capture-manifest.json (§5.8)
// ============================================================================
//
// Every run rewrites capture-manifest.json with one entry per (part, route):
//   { part, route, name, status: "ok"|"gated"|"error", files, reason?, remedy? }
//
// MERGE semantics: a partial run (--part / --route / --viewport / --state) must
// leave the manifest reflecting the UNION of the latest capture of each route,
// so the gallery and stale-PNG detection never lose routes the run didn't touch.
//   - Full run (no filters): manifest = exactly this run's results, so route
//     renames/removals are reflected (stale PNGs get flagged).
//   - Partial run: routes this run touched get their fresh record (with files
//     unioned onto the previous record); every other route keeps its old record.

const MANIFEST_FILE = "capture-manifest.json";

async function readManifest() {
	try {
		const parsed = JSON.parse(await fs.readFile(MANIFEST_FILE, "utf8"));
		return Array.isArray(parsed.runs) ? parsed : { runs: [] };
	} catch {
		return { runs: [] };
	}
}

function isPartialRun(opts) {
	return !!(opts.parts.length || opts.routes.length || opts.viewport || opts.states.length);
}

async function writeManifest(results, opts) {
	const partial = isPartialRun(opts);
	const key = (part, routePath) => `${part} ${routePath}`;
	const old = await readManifest();
	const oldByKey = new Map(old.runs.map((r) => [key(r.part, r.route), r]));
	const touched = new Set(results.map((r) => key(r.part, r.path)));

	const runs = [];
	for (const r of results) {
		const entry = { part: r.part, route: r.path, name: r.name, status: r.status, files: [...r.files] };
		if (r.reason) entry.reason = r.reason;
		if (r.remedy) entry.remedy = r.remedy;
		if (partial) {
			// Union prior files (e.g. a --viewport run only recaptured one viewport;
			// keep the other viewport's PNG reference so the gallery stays complete).
			const prev = oldByKey.get(key(r.part, r.path));
			if (prev && Array.isArray(prev.files)) {
				for (const f of prev.files) if (!entry.files.includes(f)) entry.files.push(f);
			}
		}
		runs.push(entry);
	}
	if (partial) {
		for (const r of old.runs) if (!touched.has(key(r.part, r.route))) runs.push(r);
	}

	const manifest = { generatedAt: new Date().toISOString(), runs };
	await fs.writeFile(MANIFEST_FILE, JSON.stringify(manifest, null, 2) + "\n");
	return manifest;
}

// ============================================================================
// SECTION 10 — Stale PNG detection + prune (§5.7)
// ============================================================================

// `expected` is drawn from the MERGED manifest (the union across runs), NOT just
// this run's results — otherwise a --route-filtered run would report every PNG
// outside its filter as stale.
async function handleStale(matrix, manifest, prune) {
	const expected = new Set();
	for (const rec of manifest.runs) for (const f of rec.files || []) expected.add(f);

	const stale = [];
	for (const { part } of matrix.parts) {
		const dir = part.name;
		let entries;
		try { entries = await fs.readdir(dir); } catch { continue; }
		for (const e of entries) {
			if (!e.endsWith(".png")) continue;
			const rel = `${dir}/${e}`;
			if (!expected.has(rel)) stale.push(rel);
		}
	}
	if (!stale.length) return;
	if (prune) {
		for (const f of stale) { await fs.rm(f, { force: true }); console.log(`  pruned stale: ${f}`); }
	} else {
		console.log(`\n${stale.length} stale PNG(s) from removed/renamed routes (rerun with --prune to delete):`);
		for (const f of stale) console.log(`  ${f}`);
	}
}

// ============================================================================
// SECTION 11 — Exit report + gallery handoff (§5.9)
// ============================================================================

function printReport(matrix, results, wallMs) {
	console.log("\n" + "=".repeat(52));
	console.log("Capture report");
	console.log("=".repeat(52));
	for (const { part } of matrix.parts) {
		const recs = results.filter((r) => r.part === part.name);
		const ok = recs.filter((r) => r.status === "ok").length;
		const gated = recs.filter((r) => r.status === "gated").length;
		const err = recs.filter((r) => r.status === "error").length;
		console.log(`  ${part.name.padEnd(16)} ${ok} captured · ${gated} gated · ${err} errored`);
	}
	console.log("-".repeat(52));
	console.log(`  wall time: ${(wallMs / 1000).toFixed(1)}s`);
	console.log("=".repeat(52));
}

// §5.9: build the gallery via generate.mjs unless --no-gallery.
async function runGallery(noGallery) {
	if (noGallery) return;
	const gen = "generate.mjs";
	try { await fs.access(gen); } catch {
		console.log(`\nNote: ${gen} not found — skipping gallery. Open gallery.html manually once available.`);
		return;
	}
	console.log("\nGenerating gallery…");
	const res = spawnSync(process.execPath, [gen], { stdio: "inherit" });
	if (res.status === 0) console.log("Gallery ready → open gallery.html");
	else console.log(`Note: ${gen} exited with code ${res.status}; open gallery.html manually.`);
}

// ============================================================================
// SECTION 12 — main
// ============================================================================

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	if (opts.help) { console.log(USAGE); return; }

	await loadSecrets();
	const cfg = await loadConfig(opts.config);

	if (opts.login) { await runLogin(cfg, opts.login); return; } // §5.5

	const matrix = buildMatrix(cfg, opts);

	if (matrix.parts.length === 0) fail("nothing to capture (filters matched no routes)");

	if (opts.dryRun) { printMatrix(matrix); return; }

	// repoRoot = parent of the screenshots/ folder (where this script runs).
	const repoRoot = path.resolve(process.cwd(), "..");
	const logsDir = path.resolve(".logs");
	await fs.mkdir(logsDir, { recursive: true });
	for (const { part } of matrix.parts) await fs.mkdir(path.resolve(part.name), { recursive: true });

	// Kill our servers on Ctrl-C / termination.
	const onSignal = () => { killAllSync(); process.exit(130); };
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);

	const t0 = Date.now();
	let results = [];
	try {
		results = await capture(cfg, opts, matrix, repoRoot, logsDir);
		const manifest = await writeManifest(results, opts); // §5.8 (merge on partial runs)
		await handleStale(matrix, manifest, opts.prune);
	} finally {
		await teardownServers(opts.keepServers);
	}

	printReport(matrix, results, Date.now() - t0);
	await runGallery(opts.noGallery);
}

// ============================================================================
// utils
// ============================================================================

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

main().catch((e) => {
	killAllSync();
	console.error(e);
	process.exit(1);
});
