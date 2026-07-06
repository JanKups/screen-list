// E4 — Conversational partial: "re-shoot just /posts".
// Pass criteria (PLAN.md §10): only matching PNGs' mtimes change; the manifest is
// merged (every route kept); the gallery still shows all routes.
//
// Split: resolving the phrase "re-shoot just /posts" to the CLI flag
// `--route "/posts/**"` is the skill's job (a driven session verifies the
// mapping). This harness verifies the machinery that makes it correct — the
// route filter + manifest merge.
import fs from "node:fs";
import path from "node:path";
import { Checks } from "../lib/checks.mjs";
import { sleep } from "../lib/proc.mjs";
import { fixtureDir } from "../lib/fixtures.mjs";
import { REPO_ROOT, scaffold, ensureDeps, writeConfig, capture } from "../lib/driver.mjs";
import * as g from "../lib/graders.mjs";

function mtimes(dir) {
	const out = {};
	if (!fs.existsSync(dir)) return out;
	for (const f of fs.readdirSync(dir)) {
		if (f.endsWith(".png")) out[f] = fs.statSync(path.join(dir, f)).mtimeMs;
	}
	return out;
}

export default {
	id: "E4",
	title: 'Conversational partial: "re-shoot just /posts"',
	fixtures: ["next-fixture"],
	drivenSession:
		'A driven session verifies the skill resolves "re-shoot just /posts" to `--route "/posts/**"`. This harness runs that flag and verifies the selective re-shoot + merge.',
	async run() {
		const checks = new Checks("E4");
		const outDir = path.join(fixtureDir("next-fixture"), "sr-E4");
		const webDir = path.join(outDir, "web");

		scaffold(outDir);
		ensureDeps(outDir);
		writeConfig(outDir, "next-noauth.jsonc");

		// Full capture first.
		const cap1 = capture(outDir);
		checks.add("full capture exits 0", cap1.status === 0, (cap1.stderr || cap1.stdout).trim().split("\n").slice(-2).join(" | "));
		const before = mtimes(webDir);

		// mtime granularity guard, then the partial re-shoot.
		await sleep(1200);
		const cap2 = capture(outDir, ["--route", "/posts/**"]);
		checks.add("partial re-shoot exits 0", cap2.status === 0, (cap2.stderr || cap2.stdout).trim().split("\n").slice(-2).join(" | "));
		const after = mtimes(webDir);

		// Only the /posts PNGs were re-shot.
		const posts = Object.keys(before).filter((f) => f.startsWith("02-post-detail"));
		const others = Object.keys(before).filter((f) => !f.startsWith("02-post-detail"));
		checks.add(
			"only /posts PNGs re-shot: post-detail mtimes advanced",
			posts.length > 0 && posts.every((f) => after[f] > before[f]),
			posts.join(", "),
		);
		checks.add(
			"non-matching PNGs untouched (mtimes unchanged)",
			others.every((f) => after[f] === before[f]),
			`checked ${others.length} files`,
		);

		// Merge: the manifest keeps every route; the gallery still shows all.
		g.gradeManifestHasRoutes(outDir, ["/", "/posts/[id]", "/about", "/login", "/dashboard"], checks);
		g.gradeGallery(outDir, ["/", "/posts/[id]", "/about", "/login", "/dashboard"], checks);

		g.gradeGitClean(REPO_ROOT, checks);
		return checks;
	},
};
