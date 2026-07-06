// E2 — Setup with credentials auth.
// Pass criteria (PLAN.md §10): login succeeds; /dashboard PNG exists; secrets.env
// is gitignored; no secret string appears in the config.
import path from "node:path";
import { Checks } from "../lib/checks.mjs";
import { fixtureDir } from "../lib/fixtures.mjs";
import { REPO_ROOT, scaffold, ensureDeps, writeConfig, writeSecrets, capture } from "../lib/driver.mjs";
import * as g from "../lib/graders.mjs";

// Invented fixture credentials (defined in the fixture's app/login/page.tsx).
const FIXTURE_USER = "reviewer@example.com";
const FIXTURE_PASS = "fixture-pass-1";

export default {
	id: "E2",
	title: "Setup with credentials auth",
	fixtures: ["next-fixture"],
	drivenSession:
		"A driven session additionally verifies the auth-probe Q&A and selector auto-detection. Here the reference config already encodes the detected selectors + env-var names.",
	async run() {
		const checks = new Checks("E2");
		const outDir = path.join(fixtureDir("next-fixture"), "sr-E2");

		scaffold(outDir);
		ensureDeps(outDir);
		writeConfig(outDir, "next-auth.jsonc");
		// Secrets go in the gitignored file, referenced by env-var NAME in config.
		writeSecrets(outDir, { SR_WEB_USER: FIXTURE_USER, SR_WEB_PASSWORD: FIXTURE_PASS });

		g.gradeConfigValidates(outDir, checks);

		const cap = capture(outDir);
		checks.add("capture.mjs exits 0", cap.status === 0, (cap.stderr || cap.stdout).trim().split("\n").slice(-2).join(" | "));
		checks.add(
			"login succeeded (capture logged in via credentials)",
			/logged in via credentials/.test(cap.stdout),
			"",
		);

		// Login worked → /dashboard renders and captures (status ok, not gated).
		g.gradePng(outDir, "web/05-dashboard.desktop.png", 1440, checks);
		g.gradePng(outDir, "web/05-dashboard.mobile.png", 390, checks);
		g.gradeManifestStatus(outDir, "/dashboard", "ok", checks);

		// Secret hygiene.
		g.gradeNoSecretInConfig(outDir, FIXTURE_PASS, checks);
		g.gradeNoSecretInConfig(outDir, FIXTURE_USER, checks);
		g.gradeSecretsGitignored(outDir, REPO_ROOT, checks);
		g.gradeGitClean(REPO_ROOT, checks);
		return checks;
	},
};
