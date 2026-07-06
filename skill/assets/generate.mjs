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
// Viewport helpers: a CSS-safe class per viewport name, and a thumbnail width
// scaled from the configured device width (desktop reads wide, mobile narrow).
const cssName = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-") || "vp";
const vpDefs = Array.isArray(cfg.viewports) && cfg.viewports.length
	? cfg.viewports
	: [{ name: "desktop", width: 1440 }, { name: "mobile", width: 390 }];
const vpThumbCss = vpDefs.map((v) =>
	`.shot.vp-${cssName(v.name)}{width:${Math.round(Math.max(180, Math.min(380, (v.width || 1200) / 4)))}px}`).join("\n  ");

function shotHtml(shot) {
	const label = shot.state ? shot.state : shot.viewport;
	return `
        <a class="shot vp-${cssName(shot.viewport)}" data-viewport="${esc(shot.viewport)}" href="${esc(shot.file)}"
           title="${esc(shot.file)}">
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
      <div class="shots-col">
        <div class="head"><span class="rname">${esc(route.name)}</span></div>
        <div class="shots">${shots}</div>
        <div class="no-vp" hidden>not captured at this viewport</div>
      </div>
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
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' rx='3' fill='%23161310'/%3E%3Ccircle cx='8' cy='8' r='4' fill='%23e8862e'/%3E%3C/svg%3E">
<title>Screenshot review — ${esc(project)}</title>
<style>
  /* Darkroom contact-sheet: warm charcoal, ember accent, mono annotations. */
  :root {
    --bg:#161310; --panel:#1d1915; --panel-2:#242019; --line:#332c23; --line-soft:#2a241d;
    --ink:#ece5da; --muted:#9c8f7d; --faint:#6e6355;
    --ember:#e8862e; --ember-soft:rgba(232,134,46,.14);
    --ok:#8fbf5f; --warn:#d9a13c; --err:#d95f5f;
    --font-ui:"Avenir Next","Avenir","Segoe UI Variable","Seravek",system-ui,sans-serif;
    --font-mono:ui-monospace,"SF Mono","Cascadia Mono",Menlo,Consolas,monospace;
  }
  * { box-sizing:border-box; }
  html { scroll-behavior:smooth; }
  body { margin:0; color:var(--ink); font:15px/1.5 var(--font-ui);
         background:
           radial-gradient(1100px 500px at 75% -12%, rgba(232,134,46,.06), transparent 60%),
           radial-gradient(900px 500px at -10% 110%, rgba(232,134,46,.03), transparent 55%),
           var(--bg); }
  header { position:sticky; top:0; z-index:10; background:rgba(22,19,16,.94);
           backdrop-filter:blur(10px); -webkit-backdrop-filter:blur(10px);
           border-bottom:1px solid var(--line); padding:12px 20px;
           display:flex; align-items:center; gap:16px; flex-wrap:wrap; }
  header h1 { margin:0; font:600 12px/1 var(--font-mono); letter-spacing:.22em;
              text-transform:uppercase; color:var(--ember); }
  .prog, .summary { color:var(--muted); font-size:13px; font-variant-numeric:tabular-nums; }
  .prog b { color:var(--ok); }
  .summary b { color:var(--ink); }
  .spacer { flex:1; }
  button, label.btn { background:var(--panel); color:var(--ink); border:1px solid var(--line);
           border-radius:8px; padding:7px 14px; font:13px var(--font-ui); cursor:pointer;
           transition:border-color .15s, background .15s; }
  button.primary { background:var(--ember); border-color:var(--ember); color:#171008; font-weight:700; }
  button.primary:hover { background:#f39a48; border-color:#f39a48; }
  button:hover, label.btn:hover { border-color:var(--muted); }
  input[type=file]{ display:none; }
  /* Viewport toggler */
  .vp-toggle { display:inline-flex; border:1px solid var(--line); border-radius:999px;
               background:var(--panel); padding:3px; gap:2px; }
  .vp-toggle button { border:0; border-radius:999px; padding:5px 14px; background:transparent;
                      color:var(--muted); font:12px var(--font-mono); letter-spacing:.06em; }
  .vp-toggle button:hover { color:var(--ink); }
  .vp-toggle button.active { background:var(--ember); color:#171008; font-weight:700; }
  .stale { display:none; margin:0; padding:12px 20px; background:rgba(217,161,60,.1);
           border-bottom:1px solid var(--warn); color:#e5bd6d; font-size:13px; }
  .stale.show { display:block; }
  main { max-width:1280px; margin:0 auto; padding:24px 20px 80px; }
  .part { margin:22px 0; border:1px solid var(--line); border-radius:14px; background:var(--panel);
          box-shadow:0 1px 0 rgba(0,0,0,.4), 0 12px 40px -30px rgba(0,0,0,.8); }
  .part > summary { list-style:none; cursor:pointer; padding:14px 18px;
                     display:flex; align-items:center; gap:12px; user-select:none; }
  .part > summary::-webkit-details-marker { display:none; }
  .part > summary::before { content:"▸"; color:var(--faint); font-size:12px; transition:transform .15s; }
  .part[open] > summary::before { transform:rotate(90deg); }
  .pname { font:700 15px var(--font-ui); letter-spacing:.01em; }
  .part > summary:hover .pname { color:var(--ember); }
  .part-count { color:var(--faint); font:12px var(--font-mono); }
  .count { color:var(--ember); font:700 12px var(--font-mono); }
  /* Row: shots left, comment pane right */
  .row { padding:18px; border-top:1px solid var(--line-soft); display:grid;
         grid-template-columns:minmax(0,1fr) minmax(260px,340px); gap:20px; align-items:start; }
  .head { margin-bottom:10px; }
  .rname { font-weight:600; font-size:14px; }
  .shots { display:flex; gap:14px; overflow-x:auto; padding-bottom:6px; }
  .shot { flex:0 0 auto; text-decoration:none; color:var(--muted); cursor:zoom-in; }
  .shot[hidden] { display:none; }
  .shot .frame { display:block; max-height:480px; overflow:hidden; border:1px solid var(--line);
                 border-radius:10px; background:#0c0a08;
                 transition:border-color .15s, transform .15s; }
  .shot:hover .frame { border-color:var(--ember); transform:translateY(-2px); }
  .shot img { width:100%; display:block; }
  .shot-label { display:block; margin-top:6px; font:11px var(--font-mono); letter-spacing:.08em;
                text-transform:lowercase; }
  .shot:hover .shot-label { color:var(--ember); }
  ${vpThumbCss}
  .no-shots, .no-vp { color:var(--faint); font-size:13px; font-style:italic; }
  .no-vp { padding:14px 0; }
  .pane { display:flex; flex-direction:column; gap:8px; position:sticky; top:76px; }
  .path { color:var(--muted); font:12px var(--font-mono); user-select:all; overflow-wrap:anywhere; }
  textarea.cmt { min-height:140px; flex:1; resize:vertical; background:var(--bg); color:var(--ink);
                 border:1px solid var(--line); border-radius:10px; padding:12px;
                 font:14px/1.5 var(--font-ui); transition:border-color .15s; }
  textarea.cmt:focus { outline:none; border-color:var(--ember); box-shadow:0 0 0 3px var(--ember-soft); }
  textarea.cmt.filled { border-color:var(--ok); }
  /* Flagged (gated / error) rows */
  .row.gated { border-left:4px solid var(--warn); }
  .row.error { border-left:4px solid var(--err); }
  .flag-main { display:flex; flex-direction:column; gap:10px; }
  .flag-head { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  .badge { font:700 11px var(--font-mono); letter-spacing:.06em; padding:3px 9px; border-radius:999px; }
  .row.gated .badge { background:rgba(217,161,60,.16); color:var(--warn); }
  .row.error .badge { background:rgba(217,95,95,.16); color:var(--err); }
  .flag-path { color:var(--muted); font:12px var(--font-mono); }
  .reason { color:var(--ink); font-size:13px; }
  .remedy-wrap { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .remedy-label { color:var(--faint); font:11px var(--font-mono); text-transform:uppercase; letter-spacing:.1em; }
  code.remedy { background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:6px 10px;
                font:13px var(--font-mono); color:var(--ink); cursor:pointer; }
  code.remedy:hover { border-color:var(--ember); }
  code.remedy.copied { border-color:var(--ok); color:var(--ok); }
  /* Lightbox: fixed overlay, scrollable for tall full-page shots */
  #lb { position:fixed; inset:0; z-index:50; display:none; overflow:auto;
        overscroll-behavior:contain; background:rgba(14,11,9,.94);
        -webkit-backdrop-filter:blur(6px); backdrop-filter:blur(6px); }
  #lb.open { display:block; }
  #lb .lb-bar { position:sticky; top:0; z-index:2; display:flex; align-items:center; gap:14px;
        padding:12px 20px; background:linear-gradient(rgba(14,11,9,.92), rgba(14,11,9,0)); }
  #lb .lb-file { color:var(--muted); font:12px var(--font-mono); overflow-wrap:anywhere; }
  #lb .lb-hint { color:var(--faint); font:11px var(--font-mono); letter-spacing:.06em; }
  #lb .lb-close { margin-left:auto; }
  #lb img { display:block; width:auto; max-width:min(1600px, 94vw); margin:8px auto 120px;
        border:1px solid var(--line); border-radius:8px; cursor:zoom-in;
        box-shadow:0 30px 80px -20px rgba(0,0,0,.9); }
  #lb.zoomed img { max-width:none; width:94vw; cursor:zoom-out; }
  body.lb-open { overflow:hidden; }
  @media (max-width:860px){
    .row { grid-template-columns:1fr; }
    .pane { position:static; }
    textarea.cmt { min-height:90px; }
  }
</style>
</head>
<body>
<header>
  <h1>Screenshot review</h1>
  <span class="prog"><b id="done">0</b> / ${totalRows} commented</span>
  <span class="summary">${summaryHtml}</span>
  <nav class="vp-toggle" id="vpToggle" aria-label="Viewport">${vpDefs.map((v) =>
		`<button data-vp="${esc(v.name)}">${esc(v.name)}</button>`).join("")}</nav>
  <span class="spacer"></span>
  <button id="collapseAll">Collapse all</button>
  <button id="expandAll">Expand all</button>
  <label class="btn">Import…<input type="file" id="import" accept=".json"></label>
  <button id="clear">Clear all</button>
  <button class="primary" id="export">Export COMMENTS.md</button>
</header>
<div class="stale" id="stale"></div>
<main>${partsHtml}</main>
<div id="lb" role="dialog" aria-modal="true" aria-label="Screenshot">
  <div class="lb-bar">
    <span class="lb-file" id="lbFile"></span>
    <span class="lb-hint">click to zoom · ←/→ next shot · esc to close</span>
    <button class="lb-close" id="lbClose">Close ✕</button>
  </div>
  <img id="lbImg" alt="">
</div>
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

// Viewport toggler: each row shows one viewport's shots; choice is remembered.
const VPKEY = KEY + ":vp";
const vpButtons = [...document.querySelectorAll("#vpToggle button")];
const vpNames = vpButtons.map(b => b.dataset.vp);
function setViewport(name){
  if (!vpNames.includes(name)) name = vpNames[0];
  vpButtons.forEach(b => b.classList.toggle("active", b.dataset.vp === name));
  document.querySelectorAll(".row").forEach(row => {
    const shots = [...row.querySelectorAll(".shot")];
    if (!shots.length) return;
    let visible = 0;
    shots.forEach(s => { const show = s.dataset.viewport === name; s.hidden = !show; if (show) visible++; });
    const note = row.querySelector(".no-vp");
    if (note) note.hidden = visible > 0;
  });
  try { localStorage.setItem(VPKEY, name); } catch {}
}
vpButtons.forEach(b => b.addEventListener("click", () => setViewport(b.dataset.vp)));
let savedVp = null; try { savedVp = localStorage.getItem(VPKEY); } catch {}
setViewport(savedVp || vpNames[0]);

// Lightbox: click a shot → enlarge in place. The overlay itself scrolls, so
// tall full-page captures can be read top to bottom without leaving the page.
const lb = document.getElementById("lb");
const lbImg = document.getElementById("lbImg");
const lbFile = document.getElementById("lbFile");
let lbList = [], lbIndex = -1;
function openLb(shot){
  lbList = [...document.querySelectorAll(".shot")].filter(s => !s.hidden);
  lbIndex = lbList.indexOf(shot);
  lbImg.src = shot.getAttribute("href");
  lbFile.textContent = shot.getAttribute("href");
  lb.classList.remove("zoomed");
  lb.classList.add("open");
  lb.scrollTop = 0;
  document.body.classList.add("lb-open");
}
function closeLb(){
  lb.classList.remove("open","zoomed");
  lbImg.removeAttribute("src");
  document.body.classList.remove("lb-open");
}
function stepLb(d){
  if (lbIndex === -1) return;
  const nextShot = lbList[lbIndex + d];
  if (nextShot) openLb(nextShot);
}
document.querySelectorAll(".shot").forEach(s => s.addEventListener("click", (e) => {
  e.preventDefault();
  openLb(s);
}));
lbImg.addEventListener("click", () => lb.classList.toggle("zoomed"));
document.getElementById("lbClose").addEventListener("click", closeLb);
lb.addEventListener("click", (e) => { if (e.target === lb) closeLb(); });
document.addEventListener("keydown", (e) => {
  if (!lb.classList.contains("open")) return;
  if (e.key === "Escape") closeLb();
  else if (e.key === "ArrowRight") { e.preventDefault(); stepLb(1); }
  else if (e.key === "ArrowLeft") { e.preventDefault(); stepLb(-1); }
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
