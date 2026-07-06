// Read a PNG's pixel dimensions straight from the IHDR chunk — no dependency.
// PNG layout: 8-byte signature, then the IHDR chunk whose data begins at byte 16
// with a 4-byte big-endian width followed by a 4-byte big-endian height.
import fs from "node:fs";

export function pngSize(file) {
	const fd = fs.openSync(file, "r");
	try {
		const buf = Buffer.alloc(24);
		const n = fs.readSync(fd, buf, 0, 24, 0);
		if (n < 24) throw new Error(`${file}: too small to be a PNG (${n} bytes)`);
		// Signature bytes 1-3 spell "PNG".
		if (buf.toString("ascii", 1, 4) !== "PNG") throw new Error(`${file}: not a PNG`);
		return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
	} finally {
		fs.closeSync(fd);
	}
}
