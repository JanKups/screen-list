// fixtures.mjs — ensure a throwaway fixture exists under workspace/ by running
// its committed setup script (idempotent: the script rm -rf's and rebuilds).
import fs from "node:fs";
import path from "node:path";
import { run } from "./proc.mjs";
import { REPO_ROOT } from "./driver.mjs";

const FIXTURES = {
	"next-fixture": {
		script: "evals/fixtures/setup-next-fixture.sh",
		server: { command: "npm run dev", url: "http://localhost:3000" },
	},
	"vite-fixture": {
		script: "evals/fixtures/setup-vite-fixture.sh",
		server: { command: "npm run dev -- --port 5273", url: "http://localhost:5273" },
	},
};

export function fixtureDir(name) {
	return path.join(REPO_ROOT, "workspace", name);
}

export function fixtureServer(name) {
	return FIXTURES[name].server;
}

// Ensure the fixture app is present. Regenerates from the setup script when
// missing; a present fixture is reused as-is (workspace/ is gitignored & throwaway).
export function ensureFixture(name) {
	const dir = fixtureDir(name);
	if (fs.existsSync(path.join(dir, "package.json"))) return dir;
	const script = path.join(REPO_ROOT, FIXTURES[name].script);
	console.log(`\n[fixtures] regenerating ${name} via ${FIXTURES[name].script} …`);
	const r = run("bash", [script], { cwd: REPO_ROOT, stdio: "inherit" });
	if (r.status !== 0) throw new Error(`fixture setup failed for ${name}`);
	return dir;
}
