// ============================================================================
// generate.mjs — build a self-contained comment-review gallery from a capture.
//
// Template copied into the target project's screenshots/ folder. Reads
// screenshots.config.jsonc + capture-manifest.json and emits gallery.html:
// one row per route (all viewports side by side under a single comment field),
// grouped part → route in config order. Comments autosave to localStorage and
// Export downloads COMMENTS.md + comments.json. See PLAN.md §9.
//
// ONE FILE, zero dependencies — the whole tool is capture.mjs + generate.mjs
// and the folder must be trivially copy-portable. Run from the screenshots/
// folder (where the config, manifest and <part>/ PNG dirs live).
//
// Usage:
//   node generate.mjs                     # config + manifest in cwd → gallery.html
//   node generate.mjs --config <path>     # alternate config file
// ============================================================================

import fs from "node:fs";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
let configPath = "screenshots.config.jsonc";
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
	if (argv[i] === "--config") configPath = argv[++i];
	else if (argv[i] === "--help" || argv[i] === "-h") {
		console.log("Usage: node generate.mjs [--config <path>]");
		process.exit(0);
	}
}

const MANIFEST_FILE = "capture-manifest.json";
const OUT_FILE = "gallery.html";

// ---------------------------------------------------------------------------
// JSONC parse (same tiny stripper as capture.mjs — no dependency)
// ---------------------------------------------------------------------------
function stripJsonc(src) {
	let out = "";
	let inStr = false, quote = "", inLine = false, inBlock = false;
	for (let i = 0; i < src.length; i++) {
		const c = src[i], n = src[i + 1];
		if (inLine) { if (c === "\n") { inLine = false; out += c; } continue; }
		if (inBlock) { if (c === "*" && n === "/") { inBlock = false; i++; } continue; }
		if (inStr) {
			out += c;
			if (c === "\\") { out += src[++i] ?? ""; continue; }
			if (c === quote) inStr = false;
			continue;
		}
		if (c === '"' || c === "'") { inStr = true; quote = c; out += c; continue; }
		if (c === "/" && n === "/") { inLine = true; i++; continue; }
		if (c === "/" && n === "*") { inBlock = true; i++; continue; }
		out += c;
	}
	return out.replace(/,(\s*[}\]])/g, "$1");
}

function fail(msg) { console.error(`generate.mjs: ${msg}`); process.exit(1); }

// ---------------------------------------------------------------------------
// Load config + manifest
// ---------------------------------------------------------------------------
let cfg;
try {
	cfg = JSON.parse(stripJsonc(fs.readFileSync(configPath, "utf8")));
} catch (e) {
	fail(`could not read config ${configPath}: ${e.message}`);
}
if (!Array.isArray(cfg.parts)) fail(`config ${configPath} has no "parts" array`);

const project = typeof cfg.project === "string" && cfg.project ? cfg.project : "app";
const viewportOrder = Array.isArray(cfg.viewports)
	? cfg.viewports.map((v) => v.name)
	: ["desktop", "mobile"];

let manifest = { runs: [] };
try {
	const parsed = JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf8"));
	if (Array.isArray(parsed.runs)) manifest = parsed;
} catch {
	console.warn(`Note: ${MANIFEST_FILE} not found — run capture.mjs first. Rows will show no shots.`);
}

// manifest entry lookup keyed by "part path"
const manifestByKey = new Map();
for (const r of manifest.runs) manifestByKey.set(`${r.part} ${r.route}`, r);

// ---------------------------------------------------------------------------
// Build the render model: config order, grouped part → route.
// Each route carries its manifest status/files/reason/remedy.
// ---------------------------------------------------------------------------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
	({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Parse a capture filename into { viewport, state }.
//   <part>/NN-name.viewport.png            → { viewport, state: null }
//   <part>/NN-name.state.viewport.png      → { viewport, state }
function parseShot(file) {
	const base = file.split("/").pop().replace(/\.png$/i, "");
	const segs = base.split(".");
	const viewport = segs[segs.length - 1];
	const state = segs.length >= 3 ? segs.slice(1, -1).join(".") : null;
	return { viewport, state };
}

// Sort shots: base shots first in viewport order, then states.
function orderShots(files) {
	const vpIndex = (v) => { const i = viewportOrder.indexOf(v); return i === -1 ? 99 : i; };
	return files
		.map((f) => ({ file: f, ...parseShot(f) }))
		.sort((a, b) => {
			if (!a.state && b.state) return -1;
			if (a.state && !b.state) return 1;
			if (a.state !== b.state) return String(a.state).localeCompare(String(b.state));
			return vpIndex(a.viewport) - vpIndex(b.viewport);
		});
}

const parts = [];
let okCount = 0, gatedCount = 0, errorCount = 0, totalRows = 0;

for (const part of cfg.parts) {
	const routes = Array.isArray(part.routes) ? part.routes : [];
	const modelRoutes = [];
	for (const route of routes) {
		const rec = manifestByKey.get(`${part.name} ${route.path}`);
		const status = rec ? rec.status : "ok";
		const files = rec && Array.isArray(rec.files) ? rec.files : [];
		const key = `${part.name} ${route.path}`; // comment key (part/route)
		modelRoutes.push({
			key,
			part: part.name,
			name: route.name || route.path,
			path: route.path,
			status,
			files,
			reason: rec && rec.reason,
			remedy: rec && rec.remedy,
			shots: orderShots(files),
		});
		totalRows++;
		if (status === "gated") gatedCount++;
		else if (status === "error") errorCount++;
		else okCount++;
	}
	if (modelRoutes.length) parts.push({ name: part.name, routes: modelRoutes });
}

// route metadata for the client-side exporter (DOM order)
const routeMeta = parts.flatMap((p) => p.routes.map((r) =>
	({ key: r.key, part: r.part, name: r.name, path: r.path })));

// ---------------------------------------------------------------------------
// HTML rendering
// ---------------------------------------------------------------------------
function shotHtml(shot) {
	const label = shot.state ? `${shot.state} · ${shot.viewport}` : shot.viewport;
	return `
        <a class="shot" href="${esc(shot.file)}" target="_blank" rel="noopener" title="${esc(shot.file)}">
          <span class="frame"><img loading="lazy" src="${esc(shot.file)}" alt="${esc(shot.file)}"></span>
          <span class="shot-label">${esc(label)}</span>
        </a>`;
}

function commentPane(route, placeholder) {
	return `
      <div class="pane">
        <div class="path">${esc(route.path)}</div>
        <textarea class="cmt" data-key="${esc(route.key)}" data-part="${esc(route.part)}"
          data-name="${esc(route.name)}" data-path="${esc(route.path)}"
          placeholder="${placeholder}"></textarea>
      </div>`;
}

function okRow(route) {
	const shots = route.shots.length
		? route.shots.map(shotHtml).join("")
		: `<span class="no-shots">no screenshots on file — run capture.mjs</span>`;
	return `
    <div class="row" data-key="${esc(route.key)}">
      <div class="head"><span class="rname">${esc(route.name)}</span></div>
      <div class="shots">${shots}</div>
      ${commentPane(route, "Comment on this screen…")}
    </div>`;
}

function flaggedRow(route) {
	const isError = route.status === "error";
	const badge = isError ? "⚠️ error" : "🔒 gated";
	const remedy = route.remedy
		? `<div class="remedy-wrap">
          <span class="remedy-label">remedy</span>
          <code class="remedy" data-copy="${esc(route.remedy)}" title="Click to copy">${esc(route.remedy)}</code>
        </div>`
		: "";
	return `
    <div class="row flagged ${isError ? "error" : "gated"}" data-key="${esc(route.key)}">
      <div class="flag-main">
        <div class="flag-head">
          <span class="badge">${badge}</span>
          <span class="rname">${esc(route.name)}</span>
          <span class="flag-path">${esc(route.path)}</span>
        </div>
        ${route.reason ? `<div class="reason">${esc(route.reason)}</div>` : ""}
        ${remedy}
      </div>
      ${commentPane(route, "Comment on this screen…")}
    </div>`;
}

const partsHtml = parts.map((p) => {
	const commented = `<span class="count" data-part="${esc(p.name)}"></span>`;
	const rows = p.routes.map((r) => (r.status === "ok" ? okRow(r) : flaggedRow(r))).join("");
	return `
    <details class="part" open data-part="${esc(p.name)}">
      <summary><span class="pname">${esc(p.name)}</span>
        <span class="part-count">${p.routes.length} route${p.routes.length === 1 ? "" : "s"}</span>
        ${commented}</summary>
      ${rows}
    </details>`;
}).join("");

// Header summary: "N screens · M gated[ · K error]"
const summaryParts = [`<b>${okCount}</b> screen${okCount === 1 ? "" : "s"}`];
summaryParts.push(`<b>${gatedCount}</b> gated`);
if (errorCount) summaryParts.push(`<b>${errorCount}</b> error${errorCount === 1 ? "" : "s"}`);
const summaryHtml = summaryParts.join(" · ");

const KEY = `sr:${project}:v1`;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Screenshot review — ${esc(project)}</title>
<style>
  :root {
    --bg:#0f1115; --panel:#171a21; --line:#262b36; --ink:#e6e9ef; --muted:#8a93a6;
    --accent:#7c83ff; --ok:#3ddc84; --warn:#f5a524; --err:#f0616d;
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink);
         font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  header { position:sticky; top:0; z-index:10; background:rgba(15,17,21,.92); backdrop-filter:blur(8px);
           border-bottom:1px solid var(--line); padding:12px 20px; display:flex; align-items:center;
           gap:16px; flex-wrap:wrap; }
  header h1 { font-size:15px; margin:0; font-weight:600; }
  .prog, .summary { color:var(--muted); font-variant-numeric:tabular-nums; }
  .prog b { color:var(--ok); }
  .summary b { color:var(--ink); }
  .spacer { flex:1; }
  button, label.btn { background:var(--panel); color:var(--ink); border:1px solid var(--line);
           border-radius:8px; padding:7px 14px; font-size:13px; cursor:pointer; }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; font-weight:600; }
  button:hover, label.btn:hover { border-color:var(--muted); }
  input[type=file]{ display:none; }
  .stale { display:none; margin:0; padding:12px 20px; background:rgba(245,165,36,.12);
           border-bottom:1px solid var(--warn); color:#f7c65e; font-size:13px; }
  .stale.show { display:block; }
  main { max-width:1200px; margin:0 auto; padding:20px; }
  .part { margin:20px 0; border:1px solid var(--line); border-radius:12px; background:var(--panel); }
  .part > summary { list-style:none; cursor:pointer; padding:14px 18px; font-size:16px; font-weight:700;
                     display:flex; align-items:center; gap:10px; user-select:none; }
  .part > summary::-webkit-details-marker { display:none; }
  .part > summary::before { content:"▸"; color:var(--muted); font-size:12px; transition:transform .15s; }
  .part[open] > summary::before { transform:rotate(90deg); }
  .part > summary:hover .pname { color:var(--accent); }
  .part-count { color:var(--muted); font-weight:400; font-size:13px; }
  .count { color:var(--accent); font-weight:700; font-size:13px; }
  .row { padding:16px 18px; border-top:1px solid var(--line); }
  .head { margin-bottom:10px; }
  .rname { font-weight:600; font-size:14px; }
  .shots { display:flex; gap:12px; overflow-x:auto; padding-bottom:6px; margin-bottom:12px; }
  .shot { flex:0 0 auto; width:260px; text-decoration:none; color:var(--muted); }
  .shot .frame { display:block; max-height:520px; overflow:hidden; border:1px solid var(--line);
                 border-radius:10px; background:#000; }
  .shot img { width:100%; display:block; }
  .shot-label { display:block; margin-top:6px; font:12px ui-monospace,Menlo,monospace; }
  .no-shots { color:var(--muted); font-size:13px; font-style:italic; }
  .pane { display:flex; flex-direction:column; gap:8px; }
  .path { color:var(--muted); font:12px ui-monospace,Menlo,monospace; user-select:all; }
  textarea.cmt { min-height:80px; resize:vertical; background:var(--bg); color:var(--ink);
                 border:1px solid var(--line); border-radius:10px; padding:12px; font:14px/1.5 inherit; }
  textarea.cmt:focus { outline:none; border-color:var(--accent); }
  textarea.cmt.filled { border-color:var(--ok); }
  /* Flagged (gated / error) rows */
  .row.flagged { display:grid; grid-template-columns:1fr; gap:12px; }
  .row.gated { border-left:4px solid var(--warn); }
  .row.error { border-left:4px solid var(--err); }
  .flag-head { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  .badge { font-size:12px; font-weight:700; padding:2px 8px; border-radius:999px; }
  .row.gated .badge { background:rgba(245,165,36,.18); color:var(--warn); }
  .row.error .badge { background:rgba(240,97,109,.18); color:var(--err); }
  .flag-path { color:var(--muted); font:12px ui-monospace,Menlo,monospace; }
  .reason { color:var(--ink); font-size:13px; }
  .remedy-wrap { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .remedy-label { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.05em; }
  code.remedy { background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:6px 10px;
                font:13px ui-monospace,Menlo,monospace; color:var(--ink); cursor:pointer; }
  code.remedy:hover { border-color:var(--accent); }
  code.remedy.copied { border-color:var(--ok); color:var(--ok); }
  .hint { color:var(--muted); font-size:12px; }
  @media (max-width:720px){ .shot{ width:200px; } }
</style>
</head>
<body>
<header>
  <h1>Screenshot review</h1>
  <span class="prog"><b id="done">0</b> / ${totalRows} commented</span>
  <span class="summary">${summaryHtml}</span>
  <span class="hint">focus a field → type or dictate → Cmd+Enter for next</span>
  <span class="spacer"></span>
  <button id="collapseAll">Collapse all</button>
  <button id="expandAll">Expand all</button>
  <label class="btn">Import…<input type="file" id="import" accept=".json"></label>
  <button id="clear">Clear all</button>
  <button class="primary" id="export">Export COMMENTS.md</button>
</header>
<div class="stale" id="stale"></div>
<main>${partsHtml}</main>
<script>
const KEY = ${JSON.stringify(KEY)};
const ROUTES = ${JSON.stringify(routeMeta)};
const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };
let data = load();
const areas = [...document.querySelectorAll("textarea.cmt")];

function refresh(){
  let done = 0;
  const perPart = {};
  areas.forEach(a => {
    const v = (data[a.dataset.key] || "").trim();
    a.value = data[a.dataset.key] || "";
    a.classList.toggle("filled", !!v);
    if (v) done++;
    const p = a.dataset.part;
    perPart[p] = (perPart[p]||0) + (v?1:0);
  });
  document.getElementById("done").textContent = done;
  document.querySelectorAll(".count").forEach(c => {
    const n = perPart[c.dataset.part]||0;
    c.textContent = n ? n + " commented" : "";
  });
}
refresh();

areas.forEach(a => {
  a.addEventListener("input", () => {
    if (a.value.trim()) data[a.dataset.key] = a.value;
    else delete data[a.dataset.key];
    localStorage.setItem(KEY, JSON.stringify(data));
    a.classList.toggle("filled", !!a.value.trim());
    refresh();
  });
  // Cmd/Ctrl+Enter jumps to the next field.
  a.addEventListener("keydown", (e) => {
    if ((e.metaKey||e.ctrlKey) && e.key === "Enter"){
      e.preventDefault();
      const i = areas.indexOf(a);
      const next = areas[i+1];
      if (next){ next.focus(); next.scrollIntoView({block:"center",behavior:"smooth"}); }
    }
  });
});

// Copyable remedy commands
document.querySelectorAll("code.remedy").forEach(c => {
  c.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(c.dataset.copy); } catch {}
    c.classList.add("copied");
    const t = c.textContent; c.textContent = "copied ✓";
    setTimeout(() => { c.textContent = t; c.classList.remove("copied"); }, 1200);
  });
});

// Export → COMMENTS.md + comments.json
function buildMarkdown(){
  let out = "# Screenshot review comments\\n\\n";
  ROUTES.forEach(r => {
    const v = (data[r.key]||"").trim();
    if (!v) return;
    out += "## " + r.part + " / " + r.name + " — \`" + r.path + "\`\\n\\n";
    v.split(/\\n+/).forEach(line => { if (line.trim()) out += "- " + line.trim() + "\\n"; });
    out += "\\n";
  });
  return out;
}
function download(name, text, type){
  const blob = new Blob([text], {type});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}
document.getElementById("export").addEventListener("click", () => {
  download("COMMENTS.md", buildMarkdown(), "text/markdown");
  download("comments.json", JSON.stringify(data, null, 2), "application/json");
});
document.getElementById("clear").addEventListener("click", () => {
  if (confirm("Clear all comments? (export first if you want a backup)")) {
    data = {}; localStorage.removeItem(KEY); refresh();
  }
});
document.getElementById("collapseAll").addEventListener("click", () => {
  document.querySelectorAll("details.part").forEach(d => d.open = false);
});
document.getElementById("expandAll").addEventListener("click", () => {
  document.querySelectorAll("details.part").forEach(d => d.open = true);
});
document.getElementById("import").addEventListener("change", (e) => {
  const f = e.target.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = () => { try { data = {...data, ...JSON.parse(r.result)};
    localStorage.setItem(KEY, JSON.stringify(data)); refresh(); } catch { alert("Bad JSON"); } };
  r.readAsText(f);
});

// Stale-gallery hint: if >50% of thumbnails fail to load, the PNGs are missing
// (fresh clone before running capture.mjs).
const imgs = [...document.querySelectorAll(".shot img")];
let failed = 0, settled = 0;
function checkStale(){
  if (!imgs.length || settled < imgs.length) return;
  if (failed / imgs.length > 0.5){
    const el = document.getElementById("stale");
    el.textContent = "Most screenshots are missing — this gallery references gitignored PNGs. Run "
      + "node capture.mjs to (re)generate them, then reload.";
    el.classList.add("show");
  }
}
imgs.forEach(img => {
  const done = (ok) => { settled++; if(!ok) failed++; checkStale(); };
  if (img.complete){ done(img.naturalWidth > 0); }
  else { img.addEventListener("load", () => done(true)); img.addEventListener("error", () => done(false)); }
});
checkStale();
</script>
</body>
</html>
`;

fs.writeFileSync(OUT_FILE, html);
console.log(`Wrote ${OUT_FILE} — ${totalRows} route(s): ${okCount} screens · ${gatedCount} gated${errorCount ? ` · ${errorCount} error` : ""}.`);
