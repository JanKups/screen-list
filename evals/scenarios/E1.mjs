// E1 — Fresh setup on next-fixture, auth DECLINED.
// Pass criteria (PLAN.md §10): scaffold complete; config validates; correct
// routes found (dynamic asked, api/callback excluded); N PNGs at both viewports;
// gallery parses; the middleware-gated /dashboard is flagged gated in the
// manifest + gallery, never dropped.
import path from "node:path";
import { Checks } from "../lib/checks.mjs";
import { fixtureDir } from "../lib/fixtures.mjs";
import { REPO_ROOT, scaffold, ensureDeps, writeConfig, capture } from "../lib/driver.mjs";
import * as g from "../lib/graders.mjs";

export default {
	id: "E1",
	title: "Fresh setup on next-fixture, decline auth",
	fixtures: ["next-fixture"],
	drivenSession:
		"A driven agent session additionally verifies the conversational choreography: the SINGLE batched question (dynamic sample values + pre-checked exclusions) and the auth-decline branch. This harness verifies the resulting artifacts.",
	async run() {
		const checks = new Checks("E1");
		const outDir = path.join(fixtureDir("next-fixture"), "sr-E1");

		scaffold(outDir);
		ensureDeps(outDir);
		writeConfig(outDir, "next-noauth.jsonc");

		// Scaffold + schema.
		g.gradeScaffold(outDir, checks);
		const dry = g.gradeConfigValidates(outDir, checks);

		// Correct routes: the five rendering routes present, the two exclusion-bait
		// routes never authored, and the dynamic route's sample value resolved.
		for (const name of ["home", "post-detail", "about", "login", "dashboard"]) {
			g.gradeRouteInMatrix(dry, name, true, checks);
		}
		g.gradeMatrixExcludes(dry, ["/api/health", "/auth/callback"], checks);
		g.gradeNoMissingParam(dry, checks);
		g.gradeMatrixHasUrl(dry, "/posts/hello-world", checks);

		// Real capture.
		const cap = capture(outDir);
		checks.add("capture.mjs exits 0", cap.status === 0, (cap.stderr || cap.stdout).trim().split("\n").slice(-2).join(" | "));

		// N PNGs at both viewports (4 public routes × 2; /dashboard is gated → no PNG).
		for (const nn of ["01-home", "02-post-detail", "03-about", "04-login"]) {
			g.gradePng(outDir, `web/${nn}.desktop.png`, 1440, checks);
			g.gradePng(outDir, `web/${nn}.mobile.png`, 390, checks);
		}
		g.gradePngCount(outDir, "web", 8, checks);

		// Gate handling: flagged gated, present in manifest + gallery, not dropped.
		g.gradeManifestStatus(outDir, "/dashboard", "gated", checks);
		g.gradeGallery(outDir, ["/dashboard", "/about", "/posts/[id]"], checks);

		// Nothing sensitive is ever tracked.
		g.gradeGitClean(REPO_ROOT, checks);
		return checks;
	},
};
