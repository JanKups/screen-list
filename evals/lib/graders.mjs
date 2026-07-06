// graders.mjs — reusable scripted graders. Each takes a Checks accumulator and
// adds one or more named, objectively-verifiable rows. No human judgment.
import fs from "node:fs";
import path from "node:path";
import { run } from "./proc.mjs";
import { pngSize } from "./png.mjs";

const SCAFFOLD_FILES = [
	"capture.mjs",
	"generate.mjs",
	"package.json",
	"README.md",
	"screenshots.config.jsonc",
	".gitignore",
];

// --- File-tree assertion ----------------------------------------------------
export function gradeScaffold(outDir, checks) {
	for (const f of SCAFFOLD_FILES) {
		checks.add(`scaffold: ${f} present`, fs.existsSync(path.join(outDir, f)), path.join(outDir, f));
	}
}

// --- Config-schema validation (via the real validator in capture.mjs) -------
// `--dry-run` loads + validates the config and prints the capture matrix without
// a browser or servers, exiting 0 only when the config is structurally valid.
export function dryRun(outDir) {
	return run(process.execPath, ["capture.mjs", "--dry-run"], { cwd: outDir, encoding: "utf8" });
}

export function gradeConfigValidates(outDir, checks) {
	const r = dryRun(outDir);
	checks.add(
		"config validates (capture.mjs --dry-run exits 0)",
		r.status === 0,
		(r.stderr || r.stdout || "").trim().split("\n").slice(-3).join(" | "),
	);
	return r.stdout;
}

// A route "name" is present in the matrix iff a `NN-<name>.` filename appears.
export function gradeRouteInMatrix(dryOut, name, present, checks) {
	const found = new RegExp(`/\\d\\d-${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.`).test(dryOut);
	checks.add(
		`route "${name}" ${present ? "present in" : "absent from"} capture matrix`,
		found === present,
		found ? "found" : "not found",
	);
}

// The batched dynamic-route question was answered → the matrix has a concrete
// URL, never a __MISSING_ placeholder.
export function gradeNoMissingParam(dryOut, checks) {
	checks.add("no unresolved dynamic params in matrix", !dryOut.includes("MISSING"), "");
}

export function gradeMatrixHasUrl(dryOut, url, checks) {
	checks.add(`matrix resolves URL ${url}`, dryOut.includes(url), "");
}

// The excluded non-rendering routes must never enter the capture matrix. We
// check the dry-run matrix (comments stripped, real route expansion) rather than
// the raw config text — the reference config's explanatory comments legitimately
// mention "/api/" and "callback", but no such route is ever authored/shot.
export function gradeMatrixExcludes(dryOut, urls, checks) {
	for (const u of urls) {
		checks.add(`route excluded from matrix: ${u}`, !dryOut.includes(u), "");
	}
}

// --- PNG existence + dimension checks ---------------------------------------
export function gradePng(outDir, rel, expectedWidth, checks) {
	const p = path.join(outDir, rel);
	const exists = fs.existsSync(p);
	checks.add(`PNG exists: ${rel}`, exists, p);
	if (exists && expectedWidth != null) {
		try {
			const { width } = pngSize(p);
			checks.add(`PNG width == ${expectedWidth}: ${rel}`, width === expectedWidth, `width=${width}`);
		} catch (e) {
			checks.add(`PNG width == ${expectedWidth}: ${rel}`, false, e.message);
		}
	}
}

export function countPngs(outDir, part) {
	const dir = path.join(outDir, part);
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir).filter((f) => f.endsWith(".png"));
}

export function gradePngCount(outDir, part, expected, checks) {
	const n = countPngs(outDir, part).length;
	checks.add(`exactly ${expected} PNG(s) under ${part}/`, n === expected, `found ${n}`);
}

// --- Manifest status checks -------------------------------------------------
export function readManifest(outDir) {
	return JSON.parse(fs.readFileSync(path.join(outDir, "capture-manifest.json"), "utf8"));
}

export function gradeManifestStatus(outDir, routePath, expected, checks) {
	const m = readManifest(outDir);
	const rec = m.runs.find((r) => r.route === routePath);
	checks.add(`manifest lists route ${routePath}`, !!rec, rec ? `status=${rec.status}` : "missing");
	if (rec) {
		checks.add(
			`manifest status ${routePath} == ${expected}`,
			rec.status === expected,
			`status=${rec.status}${rec.reason ? ` (${rec.reason})` : ""}`,
		);
	}
	return rec;
}

export function gradeManifestHasRoutes(outDir, routePaths, checks) {
	const m = readManifest(outDir);
	const have = new Set(m.runs.map((r) => r.route));
	const missing = routePaths.filter((p) => !have.has(p));
	checks.add(
		`manifest is complete (${routePaths.length} routes: merge kept every route)`,
		missing.length === 0,
		missing.length ? `missing: ${missing.join(", ")}` : "all present",
	);
}

// --- Gallery checks ---------------------------------------------------------
export function gradeGallery(outDir, mustMentionPaths, checks) {
	const p = path.join(outDir, "gallery.html");
	const exists = fs.existsSync(p);
	checks.add("gallery.html exists", exists, p);
	if (!exists) return;
	const html = fs.readFileSync(p, "utf8");
	checks.add(
		"gallery.html parses (well-formed document)",
		html.startsWith("<!doctype html>") && html.includes("</html>") && html.includes("<script>"),
		`${html.length} bytes`,
	);
	for (const routePath of mustMentionPaths || []) {
		checks.add(`gallery shows route ${routePath} (not dropped)`, html.includes(routePath), "");
	}
}

// --- Secret hygiene ---------------------------------------------------------
export function gradeNoSecretInConfig(outDir, secret, checks) {
	const cfg = fs.readFileSync(path.join(outDir, "screenshots.config.jsonc"), "utf8");
	checks.add("no secret literal in config file", !cfg.includes(secret), `looked for "${secret.slice(0, 4)}…"`);
}

export function gradeSecretsGitignored(outDir, repoRoot, checks) {
	const sf = path.join(outDir, ".screenshots-auth", "secrets.env");
	checks.add("secrets.env was written", fs.existsSync(sf), sf);
	const gi = fs.readFileSync(path.join(outDir, ".gitignore"), "utf8");
	checks.add("shipped .gitignore ignores .screenshots-auth/", /(^|\n)\.screenshots-auth\//.test(gi), "");
	checks.add("shipped .gitignore ignores **/*.png", gi.includes("**/*.png"), "");
	// git agrees the secret path is ignored in this repo.
	if (fs.existsSync(sf)) {
		const rel = path.relative(repoRoot, sf);
		const ci = run("git", ["check-ignore", rel], { cwd: repoRoot });
		checks.add("git check-ignore confirms secrets.env is ignored", ci.status === 0, ci.stdout.trim());
	}
}

// --- Git-check: no PNG and no secret is EVER tracked ------------------------
export function gradeGitClean(repoRoot, checks) {
	const r = run("git", ["ls-files"], { cwd: repoRoot });
	const tracked = r.stdout.split("\n").filter(Boolean);
	const pngs = tracked.filter((f) => f.toLowerCase().endsWith(".png"));
	checks.add("git-check: no PNG tracked anywhere in the repo", pngs.length === 0, pngs.slice(0, 5).join(", "));
	const secrets = tracked.filter((f) => /secrets\.env$|storageState\.json$/.test(f));
	checks.add("git-check: no secret / session file tracked", secrets.length === 0, secrets.join(", "));
}
