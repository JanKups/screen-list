// run.mjs — the eval-harness orchestrator (PLAN.md §10, issue #9).
//
// Usage:
//   node evals/run.mjs                 Run every scenario (E1–E5)
//   node evals/run.mjs E1 E4           Run a subset
//
// For each selected scenario it: ensures the fixture app exists (regenerating it
// from the committed setup script when missing), brings that fixture's dev server
// up ONCE (captures reuse it), runs the scenario's scripted graders against the
// real artifacts, and prints a per-check PASS/FAIL. Results are also written to
// evals/results/<id>.json. Exit code is non-zero if any scenario fails.
//
// The graders are fully scripted (no human judgment). Where a scenario also has a
// conversational step that only a driven agent session can exercise, that gap is
// printed under "driven-session" and documented in evals/README.md.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REPO_ROOT } from "./lib/driver.mjs";
import { ensureFixture, fixtureDir, fixtureServer } from "./lib/fixtures.mjs";
import { startServer, stopServer } from "./lib/server.mjs";

import E1 from "./scenarios/E1.mjs";
import E2 from "./scenarios/E2.mjs";
import E3 from "./scenarios/E3.mjs";
import E4 from "./scenarios/E4.mjs";
import E5 from "./scenarios/E5.mjs";

const ALL = { E1, E2, E3, E4, E5 };
const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(HERE, "results");

async function main() {
	const args = process.argv.slice(2).map((a) => a.toUpperCase());
	const ids = args.length ? args : Object.keys(ALL);
	for (const id of ids) if (!ALL[id]) throw new Error(`unknown scenario: ${id} (have ${Object.keys(ALL).join(", ")})`);
	const selected = ids.map((id) => ALL[id]);

	// Ensure fixtures + start each needed server exactly once.
	const neededFixtures = [...new Set(selected.flatMap((s) => s.fixtures))];
	const servers = [];
	for (const name of neededFixtures) {
		ensureFixture(name);
		const spec = fixtureServer(name);
		console.log(`[server] ensuring ${name} dev server at ${spec.url} …`);
		servers.push(await startServer(fixtureDir(name), spec.command, spec.url));
	}

	fs.mkdirSync(RESULTS_DIR, { recursive: true });
	const summary = [];
	try {
		for (const scenario of selected) {
			console.log(`\n${"=".repeat(66)}\n${scenario.id} — ${scenario.title}\n${"=".repeat(66)}`);
			let checks;
			try {
				checks = await scenario.run();
			} catch (e) {
				console.error(`  ✗ scenario threw: ${e.message}`);
				summary.push({ id: scenario.id, passed: false, error: e.message });
				fs.writeFileSync(path.join(RESULTS_DIR, `${scenario.id}.json`), JSON.stringify({ id: scenario.id, passed: false, error: e.message }, null, 2) + "\n");
				continue;
			}
			checks.print();
			const passedN = checks.items.filter((i) => i.passed).length;
			console.log(`  → ${scenario.id}: ${checks.passed ? "PASS" : "FAIL"} (${passedN}/${checks.items.length} checks)`);
			console.log(`  driven-session: ${scenario.drivenSession}`);
			summary.push({ id: scenario.id, passed: checks.passed, passedN, total: checks.items.length });
			fs.writeFileSync(
				path.join(RESULTS_DIR, `${scenario.id}.json`),
				JSON.stringify({ id: scenario.id, title: scenario.title, passed: checks.passed, checks: checks.items, drivenSession: scenario.drivenSession }, null, 2) + "\n",
			);
		}
	} finally {
		for (const s of servers) stopServer(s);
	}

	console.log(`\n${"=".repeat(66)}\nSUMMARY\n${"=".repeat(66)}`);
	for (const s of summary) {
		console.log(`  ${s.passed ? "PASS" : "FAIL"}  ${s.id}${s.error ? `  (${s.error})` : `  ${s.passedN}/${s.total}`}`);
	}
	const allPass = summary.every((s) => s.passed);
	console.log(`\n${allPass ? "All scenarios passed." : "Some scenarios FAILED."}`);
	process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
