// E5 — vite-fixture setup (code-defined routes, no filesystem router).
// Pass criteria (PLAN.md §10): route extraction or graceful ask-the-user
// fallback; capture completes.
//
// Split: whether the skill grepped the `path:` strings out of src/router.tsx or
// asked the user is a driven-session concern. Either way it lands on the same
// five routes; this harness verifies that authored config validates and captures
// end-to-end against the running SPA.
import path from "node:path";
import { Checks } from "../lib/checks.mjs";
import { fixtureDir } from "../lib/fixtures.mjs";
import { REPO_ROOT, scaffold, ensureDeps, writeConfig, capture } from "../lib/driver.mjs";
import * as g from "../lib/graders.mjs";

export default {
	id: "E5",
	title: "vite-fixture setup (no-fs-router discovery path)",
	fixtures: ["vite-fixture"],
	drivenSession:
		"A driven session verifies the discovery branch (best-effort grep of createBrowserRouter vs. ask-the-user fallback). This harness verifies capture completes on the resulting config.",
	async run() {
		const checks = new Checks("E5");
		const outDir = path.join(fixtureDir("vite-fixture"), "sr-E5");

		scaffold(outDir);
		ensureDeps(outDir);
		writeConfig(outDir, "vite.jsonc");

		const dry = g.gradeConfigValidates(outDir, checks);
		g.gradeNoMissingParam(dry, checks);
		g.gradeMatrixHasUrl(dry, "/products/42", checks);

		const cap = capture(outDir);
		checks.add("capture.mjs completes (exits 0)", cap.status === 0, (cap.stderr || cap.stdout).trim().split("\n").slice(-2).join(" | "));

		for (const nn of ["01-home", "02-about", "03-products", "04-product-detail", "05-settings"]) {
			g.gradePng(outDir, `web/${nn}.desktop.png`, 1440, checks);
			g.gradePng(outDir, `web/${nn}.mobile.png`, 390, checks);
		}
		g.gradePngCount(outDir, "web", 10, checks);
		g.gradeManifestHasRoutes(outDir, ["/", "/about", "/products", "/products/[id]", "/settings"], checks);
		g.gradeGallery(outDir, ["/products/[id]", "/settings"], checks);

		g.gradeGitClean(REPO_ROOT, checks);
		return checks;
	},
};
