// driver.mjs — the deterministic stand-in for the skill's SETUP-mode *output*.
//
// The skill's conversational choreography (route Q&A, exclusion confirmation,
// auth probe, drift OFFER dialogue) needs a driven agent session and is graded
// there. What a correct session ultimately PRODUCES, though, is deterministic:
// a scaffolded screenshots/ folder + an authored config, then a real capture.
// This module produces exactly that from the committed reference configs, so the
// scripted graders run against genuine artifacts (real PNGs, real manifest, real
// gallery) with zero LLM in the loop. See evals/README.md for the split.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./proc.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");
const ASSETS = path.join(REPO_ROOT, "skill", "assets");

// Files the skill copies into the output folder (gitignore → .gitignore on copy).
export function scaffold(outDir) {
	fs.rmSync(outDir, { recursive: true, force: true });
	fs.mkdirSync(outDir, { recursive: true });
	for (const f of fs.readdirSync(ASSETS)) {
		const dest = f === "gitignore" ? ".gitignore" : f;
		fs.copyFileSync(path.join(ASSETS, f), path.join(outDir, dest));
	}
}

// Provide node_modules (Playwright). A fresh checkout runs `npm install`; set
// SR_EVAL_NODE_MODULES to an existing install to symlink it and skip the wait.
export function ensureDeps(outDir) {
	const nm = path.join(outDir, "node_modules");
	if (fs.existsSync(nm)) return;
	const preinstalled = process.env.SR_EVAL_NODE_MODULES;
	if (preinstalled && fs.existsSync(preinstalled)) {
		fs.symlinkSync(path.resolve(preinstalled), nm, "dir");
		return;
	}
	const r = run("npm", ["install", "--no-audit", "--no-fund"], { cwd: outDir, stdio: "inherit" });
	if (r.status !== 0) throw new Error(`npm install failed in ${outDir}`);
}

export function writeConfig(outDir, refConfigName) {
	const src = path.join(REPO_ROOT, "evals", "reference-configs", refConfigName);
	fs.copyFileSync(src, path.join(outDir, "screenshots.config.jsonc"));
}

export function writeSecrets(outDir, kv) {
	const dir = path.join(outDir, ".screenshots-auth");
	fs.mkdirSync(dir, { recursive: true });
	const body = Object.entries(kv).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
	fs.writeFileSync(path.join(dir, "secrets.env"), body);
}

// Run capture.mjs inside the output folder exactly as the skill would.
export function capture(outDir, args = []) {
	return run(process.execPath, ["capture.mjs", ...args], { cwd: outDir, encoding: "utf8" });
}
