// Tiny synchronous process helper shared by the driver and graders.
import { spawnSync } from "node:child_process";

export function run(cmd, args, opts = {}) {
	const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
	return {
		status: r.status,
		stdout: r.stdout || "",
		stderr: r.stderr || "",
		error: r.error || null,
	};
}

export function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}
