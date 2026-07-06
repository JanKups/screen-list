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
//
// Scope note: auth strategies + --login (§5.4/§5.5) and gate detection +
// capture-manifest.json (§5.8) are intentionally seamed out here and land in a
// follow-up issue. Search this file for "SEAM(#4)" for every hand-off point.
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
  node capture.mjs --login <part>        Headed one-time login (not implemented yet)
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
// SECTION 4 — Auth resolution → browser context (§5.4)  ·  SEAM(#4)
// ============================================================================
//
// Issue #4 builds auth strategies (none | credentials | manual-session | header),
// the --login headed flow (§5.5), and gate detection (§5.8). Until then every
// context is a plain public context and routes flagged `auth: true` are captured
// as-is. This function is the single hand-off point: return the extra options to
// merge into browser.newContext() for a part.
async function resolveAuthContextOptions(_part) {
	// SEAM(#4): inspect _part.auth.strategy and return storageState /
	// extraHTTPHeaders / cookies, or mark routes gated when creds are missing.
	return {};
}

// SEAM(#4): gate detection after navigation. Returns null (not gated) for now.
function detectGate(_part, _finalUrl) {
	return null;
}

function loginStub(part) {
	console.error(`--login ${part}: not implemented yet (lands in the auth issue).`);
	process.exit(1);
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
			const authOpts = await resolveAuthContextOptions(part); // SEAM(#4)
			const baseUrl = part.server?.url?.replace(/\/$/, "") || "";
			for (const v of matrix.viewports) {
				const context = await browser.newContext({
					viewport: { width: v.width, height: v.height },
					...(settleBase.disableAnimations ? { reducedMotion: "reduce" } : {}),
					...authOpts,
				});
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
					const fullUrl = baseUrl + url;
					const routeSettle = { ...settleBase, ...(route.settle || {}) };
					const label = `${part.name} ${nn}-${route.name} [${v.name}]`;
					if (url.includes("__MISSING_")) {
						console.log(`  ✗ ${label}: missing route param — skipped`);
						recordOnce(results, part.name, route, "error", [], "missing route param");
						continue;
					}
					try {
						await navigateAndSettle(page, fullUrl, routeSettle, fullPage);
						const gate = detectGate(part, page.url()); // SEAM(#4)
						if (gate) {
							console.log(`  🔒 ${label}: gated (${gate})`);
							recordOnce(results, part.name, route, "gated", []);
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
function recordOnce(results, partName, route, status, files, reason) {
	let rec = findRec(results, partName, route);
	if (!rec) { rec = { part: partName, path: route.path, name: route.name, status, files: [] }; results.push(rec); }
	rec.status = status;
	if (reason) rec.reason = reason;
	for (const f of files) if (!rec.files.includes(f)) rec.files.push(f);
}
function addFile(results, partName, route, file) {
	let rec = findRec(results, partName, route);
	if (!rec) { rec = { part: partName, path: route.path, name: route.name, status: "ok", files: [] }; results.push(rec); }
	if (rec.status !== "error" && rec.status !== "gated") rec.status = "ok";
	if (!rec.files.includes(file)) rec.files.push(file);
}

// ============================================================================
// SECTION 10 — Stale PNG detection + prune (§5.7)
// ============================================================================

async function handleStale(matrix, results, prune) {
	const expected = new Set();
	for (const rec of results) for (const f of rec.files) expected.add(f);

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
		const gated = recs.filter((r) => r.status === "gated").length; // SEAM(#4): always 0 until gate detection lands
		const err = recs.filter((r) => r.status === "error").length;
		console.log(`  ${part.name.padEnd(16)} ${ok} captured · ${gated} gated · ${err} errored`);
	}
	console.log("-".repeat(52));
	console.log(`  wall time: ${(wallMs / 1000).toFixed(1)}s`);
	console.log("=".repeat(52));
}

// §5.9: attempt generate.mjs unless --no-gallery. It is still a placeholder in
// this repo, so detect that and skip gracefully with a note (SEAM: remove the
// placeholder check once generate.mjs is real).
async function runGallery(noGallery) {
	if (noGallery) return;
	const gen = "generate.mjs";
	let src;
	try { src = await fs.readFile(gen, "utf8"); } catch {
		console.log(`\nNote: ${gen} not found — skipping gallery. Run it once implemented.`);
		return;
	}
	if (/placeholder stub|Not yet written/i.test(src)) {
		console.log(`\nNote: ${gen} is still a placeholder — skipping gallery generation.`);
		console.log("      Once it's implemented, capture will build gallery.html automatically.");
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
	if (opts.login) loginStub(opts.login); // §5.5 SEAM(#4)

	await loadSecrets();
	const cfg = await loadConfig(opts.config);
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
		await handleStale(matrix, results, opts.prune);
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
