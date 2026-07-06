// E3 — Capture re-run after adding a route to the fixture (drift).
// Pass criteria (PLAN.md §10): drift is *offered*; on accept the route is
// appended with the correct NN; user-edited route names are untouched.
//
// Split: the drift OFFER (skill re-crawls, proposes, waits for approval) is a
// conversational step a driven session verifies. This harness verifies the
// script-level invariants the skill relies on and the accepted-drift outcome:
//   1. capture.mjs NEVER writes the config (so user edits can't be clobbered),
//   2. an appended route gets the next NN automatically (config-order numbering),
//   3. the user's hand-renamed route ("about-us") survives byte-for-byte.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Checks } from "../lib/checks.mjs";
import { fixtureDir } from "../lib/fixtures.mjs";
import { REPO_ROOT, scaffold, ensureDeps, writeConfig, capture } from "../lib/driver.mjs";
import * as g from "../lib/graders.mjs";

const REPORTS_PAGE = `export default function ReportsPage() {
  return (
    <main style={{ padding: 40, fontFamily: "system-ui, sans-serif" }}>
      <h1>Reports</h1>
      <p>A route added to the fixture after the first capture — drift bait.</p>
    </main>
  );
}
`;

function sha(file) {
	return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export default {
	id: "E3",
	title: "Capture re-run after adding a route (drift, accepted)",
	fixtures: ["next-fixture"],
	drivenSession:
		"A driven session verifies the drift is OFFERED (not auto-applied) and the user approves before the config changes. This harness verifies the accepted-drift invariants.",
	async run() {
		const checks = new Checks("E3");
		const fdir = fixtureDir("next-fixture");
		const outDir = path.join(fdir, "sr-E3");
		const configFile = path.join(outDir, "screenshots.config.jsonc");

		// Clean any /reports page from a previous run so the "before" state is honest.
		fs.rmSync(path.join(fdir, "app", "reports"), { recursive: true, force: true });

		scaffold(outDir);
		ensureDeps(outDir);
		writeConfig(outDir, "next-e3-base.jsonc"); // /about hand-renamed to "about-us"

		// First capture (5 routes, no /reports yet).
		const before = sha(configFile);
		const cap1 = capture(outDir);
		checks.add("first capture exits 0", cap1.status === 0, (cap1.stderr || cap1.stdout).trim().split("\n").slice(-2).join(" | "));

		// Invariant 1: capture.mjs did not rewrite the config (user edits are safe).
		checks.add("capture.mjs never writes the config file", sha(configFile) === before, "sha256 unchanged across capture");

		// Pre-drift: /reports is absent from the matrix.
		const dryBefore = g.dryRun(outDir).stdout;
		g.gradeRouteInMatrix(dryBefore, "reports", false, checks);

		// A new route appears in the fixture.
		fs.mkdirSync(path.join(fdir, "app", "reports"), { recursive: true });
		fs.writeFileSync(path.join(fdir, "app", "reports", "page.tsx"), REPORTS_PAGE);

		// User accepts the drift offer → the route is APPENDED (drifted config).
		writeConfig(outDir, "next-e3-drifted.jsonc");
		const cap2 = capture(outDir);
		checks.add("re-capture exits 0", cap2.status === 0, (cap2.stderr || cap2.stdout).trim().split("\n").slice(-2).join(" | "));

		// Invariant 2: appended route got the next NN (06), auto-named from the path.
		g.gradePng(outDir, "web/06-reports.desktop.png", 1440, checks);
		g.gradePng(outDir, "web/06-reports.mobile.png", 390, checks);
		g.gradeManifestStatus(outDir, "/reports", "ok", checks);

		// Invariant 3: the user's rename survived — the shot is named about-us, and
		// no default "about" name leaked in.
		g.gradePng(outDir, "web/03-about-us.desktop.png", 1440, checks);
		const cfg = fs.readFileSync(configFile, "utf8");
		checks.add('user edit preserved: route still named "about-us"', cfg.includes('"about-us"'), "");
		checks.add("no /reports PNG stomped an existing NN", !fs.existsSync(path.join(outDir, "web", "06-about-us.desktop.png")), "");

		g.gradeGitClean(REPO_ROOT, checks);
		return checks;
	},
};
