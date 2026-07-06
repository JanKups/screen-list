// server.mjs — optional shared dev-server lifecycle for the runner.
//
// capture.mjs can start each part's server itself, but when several scenarios
// hit the same fixture in one run it's faster (and avoids repeated cold starts /
// teardown grace) to bring the server up ONCE here and let every capture probe
// and reuse it. A reused server is "not ours" to capture.mjs, so it never stops
// it — the runner owns teardown.
import { spawn } from "node:child_process";
import { sleep } from "./proc.mjs";

async function up(url) {
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

export async function startServer(dir, command, url, readyMs = 120000) {
	if (await up(url)) return { child: null, started: false, url };
	const child = spawn(command, { cwd: dir, shell: true, detached: true, stdio: "ignore" });
	const deadline = Date.now() + readyMs;
	while (Date.now() < deadline) {
		if (await up(url)) return { child, started: true, url };
		if (child.exitCode !== null) throw new Error(`server for ${url} exited early (code ${child.exitCode})`);
		await sleep(500);
	}
	stopServer({ child });
	throw new Error(`server for ${url} did not become ready within ${readyMs}ms`);
}

export function stopServer(s) {
	if (!s || !s.child || !s.child.pid) return;
	try {
		process.kill(-s.child.pid, "SIGKILL");
	} catch {
		try {
			process.kill(s.child.pid, "SIGKILL");
		} catch {
			/* already gone */
		}
	}
}
