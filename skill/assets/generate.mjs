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
// Visual system: a restrained editorial / documentation UI (see design.md for
// the guiding principles) — near-black ink on a near-white canvas, 1px hairline
// flat cards, uppercase mono eyebrows, a plain surface carried by type and
// whitespace (no decorative graphics). All CSS and JS are inlined; the emitted
// file makes ZERO external requests and renders fully offline from file://
// (system fonts only, no webfonts).
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
        <div class="pane-top">
          <span class="pane-label">Notes</span>
          <span class="path">${esc(route.path)}</span>
        </div>
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
	const badge = isError ? "error" : "gated";
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

// Hero stat cells (spec-sheet style): big number over a mono eyebrow label
const heroStats = [`<div class="stat"><span class="stat-num">${okCount}</span><span class="stat-lbl">screen${okCount === 1 ? "" : "s"}</span></div>`];
heroStats.push(`<div class="stat"><span class="stat-num">${gatedCount}</span><span class="stat-lbl">gated</span></div>`);
if (errorCount) heroStats.push(`<div class="stat stat-err"><span class="stat-num">${errorCount}</span><span class="stat-lbl">error${errorCount === 1 ? "" : "s"}</span></div>`);
const heroStatsHtml = heroStats.join("");

const KEY = `sr:${project}:v1`;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' rx='4' fill='%23171717'/%3E%3Crect x='3.5' y='4.5' width='9' height='7' rx='1.5' fill='%23fafafa'/%3E%3C/svg%3E">
<title>Screenshot review — ${esc(project)}</title>
<style>
  :root {
    /* ---- Design tokens (design.md principles) resolved to concrete values ---- */
    --canvas:#fafafa; --elevated:#ffffff; --hairline-soft:#f2f2f2; --hairline:#ebebeb;
    --ink:#171717; --body:#4d4d4d; --mute:#8f8f8f; --faint:#a1a1a1;
    --link:#0070f3; --link-deep:#0761d1; --link-soft:#d3e5ff;
    --error:#ee0000; --error-deep:#c50000; --warning:#f5a623; --warning-deep:#a35c00;
    /* radius */
    --r-sm:6px; --r-md:12px; --r-lg:16px; --r-pill:100px; --r-full:9999px;
    /* elevation */
    --whisper:0 1px 1px rgba(0,0,0,.04);
    --float:0 2px 2px rgba(0,0,0,.06), 0 8px 16px -4px rgba(0,0,0,.10);
    /* type */
    --sans:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;
    --mono:ui-monospace,'SF Mono','JetBrains Mono',Menlo,Consolas,monospace;
  }
  * { box-sizing:border-box; }
  html { -webkit-text-size-adjust:100%; scroll-behavior:smooth; }
  body { margin:0; background:var(--canvas); color:var(--body);
         font:400 14px/1.5 var(--sans); -webkit-font-smoothing:antialiased; }
  ::selection { background:var(--link-soft); }

  /* Uppercase mono eyebrow — the system's section-labelling signature */
  .eyebrow { font:500 12px/16px var(--mono); letter-spacing:.06em; text-transform:uppercase;
         color:var(--mute); }

  /* ---------------------------------------------------------------- Hero */
  /* No decoration — the hero is carried entirely by type and whitespace. */
  .hero { background:var(--canvas); border-bottom:1px solid var(--hairline); }
  .hero-inner { max-width:1280px; margin:0 auto; padding:72px 24px 56px; }
  .hero .eyebrow { margin:0 0 18px; }
  .hero h1 { margin:0; font:600 52px/1.02 var(--sans); letter-spacing:-2.4px; color:var(--ink); }
  .hero-sub { margin:16px 0 0; font:400 17px/26px var(--sans); color:var(--body); max-width:56ch; }
  /* Quiet metadata line — small number + mono micro-label, not a focal point. */
  .hero-stats { display:flex; align-items:baseline; flex-wrap:wrap; gap:6px 22px;
         margin-top:26px; padding-top:18px; border-top:1px solid var(--hairline); }
  .stat { display:flex; align-items:baseline; gap:6px; }
  .stat-num { font:600 14px/1 var(--sans); letter-spacing:-.01em; color:var(--ink);
         font-variant-numeric:tabular-nums; }
  .stat-lbl { font:500 11px/1 var(--mono); letter-spacing:.08em; text-transform:uppercase;
         color:var(--mute); }
  .stat-err .stat-num { color:var(--error); }

  /* -------------------------------------------------------- Sticky toolbar */
  .bar { position:sticky; top:0; z-index:30; background:rgba(250,250,250,.82);
         backdrop-filter:saturate(180%) blur(12px); -webkit-backdrop-filter:saturate(180%) blur(12px);
         border-bottom:1px solid var(--hairline); transition:box-shadow .2s; }
  .bar.stuck { box-shadow:var(--whisper); }
  .bar-inner { max-width:1280px; margin:0 auto; padding:12px 24px;
         display:flex; align-items:center; gap:20px; flex-wrap:wrap; }
  .progress { display:flex; flex-direction:column; gap:7px; min-width:150px; }
  .progress-line { display:flex; align-items:baseline; gap:8px; }
  .prog { font:600 15px/1 var(--sans); color:var(--ink); font-variant-numeric:tabular-nums;
         letter-spacing:-.02em; }
  .prog #done { color:var(--link-deep); }
  .prog .prog-total { color:var(--faint); font-weight:400; }
  .prog-eyebrow { margin-left:2px; font:500 12px/16px var(--mono); letter-spacing:.06em;
         text-transform:uppercase; color:var(--mute); }
  .meter { height:4px; border-radius:var(--r-full); background:var(--hairline); overflow:hidden; }
  .meter i { display:block; height:100%; width:0; border-radius:var(--r-full);
         background:var(--link); transition:width .3s ease; }
  .spacer { flex:1; }
  .actions { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }

  /* Viewport toggler — segmented app control (6px square, ink-fill active) */
  .vp-toggle { display:inline-flex; gap:2px; padding:2px; border:1px solid var(--hairline);
         border-radius:var(--r-sm); background:var(--elevated); }
  .vp-toggle button { height:26px; padding:0 12px; border:0; border-radius:4px; background:transparent;
         color:var(--mute); font:500 12px/26px var(--mono); letter-spacing:.06em; text-transform:uppercase;
         cursor:pointer; transition:background .12s,color .12s; }
  .vp-toggle button:hover { background:var(--hairline-soft); color:var(--ink); }
  .vp-toggle button.active { background:var(--ink); color:#fff; }

  /* Buttons — 6px square ghost for app controls, black pill for the primary CTA */
  button, label.btn { font:500 14px/32px var(--sans); cursor:pointer;
         height:34px; padding:0 12px; border-radius:var(--r-sm);
         border:1px solid var(--hairline); background:var(--elevated); color:var(--ink);
         transition:background .12s,border-color .12s,color .12s; }
  button:hover, label.btn:hover { background:var(--hairline-soft); border-color:#dcdcdc; }
  button:active, label.btn:active { background:var(--hairline); }
  button.danger:hover { color:var(--error); border-color:#f2c4c4; background:#fef4f4; }
  button.primary { height:38px; padding:0 20px; border-radius:var(--r-pill);
         background:var(--ink); border-color:var(--ink); color:#fff; font-size:15px; }
  button.primary:hover { background:#000; border-color:#000; }
  button:focus-visible, label.btn:focus-visible, textarea:focus-visible, a.shot:focus-visible {
         outline:2px solid var(--link); outline-offset:2px; }
  input[type=file]{ display:none; }

  /* --------------------------------------------------------------- Stale */
  .stale { display:none; max-width:1280px; margin:16px auto 0; padding:12px 16px;
         background:var(--elevated); border:1px solid var(--hairline);
         border-left:3px solid var(--warning); border-radius:var(--r-sm);
         color:var(--warning-deep); font-size:13px; }
  .stale.show { display:block; }

  /* ---------------------------------------------------------------- Main */
  main { max-width:1280px; margin:0 auto; padding:28px 24px 96px; }

  /* Part = flat hairline card (feature-card) */
  .part { margin:0 0 20px; border:1px solid var(--hairline); border-radius:var(--r-md);
         background:var(--elevated); overflow:hidden; }
  .part > summary { list-style:none; cursor:pointer; padding:16px 22px; user-select:none;
         display:flex; align-items:center; gap:12px; }
  .part > summary:hover { background:var(--hairline-soft); }
  .part > summary::-webkit-details-marker { display:none; }
  .part > summary::before { content:""; width:8px; height:8px; flex:0 0 auto; margin-right:2px;
         border-right:1.5px solid var(--faint); border-bottom:1.5px solid var(--faint);
         transform:rotate(-45deg); transition:transform .18s; }
  .part[open] > summary::before { transform:rotate(45deg); }
  .pname { font:600 20px/1.2 var(--sans); letter-spacing:-.4px; color:var(--ink); }
  .part-count { font:500 12px/16px var(--mono); letter-spacing:.06em; text-transform:uppercase;
         color:var(--mute); }
  .count { font:500 12px/16px var(--sans); color:var(--link-deep); background:var(--link-soft);
         padding:3px 9px; border-radius:var(--r-full); margin-left:auto; }
  .count:empty { display:none; }

  /* Row: shots left, comment pane right */
  .row { padding:22px; border-top:1px solid var(--hairline); display:grid;
         grid-template-columns:minmax(0,1fr) minmax(260px,340px); gap:24px; align-items:start; }
  .shots-col { min-width:0; }
  .head { margin-bottom:14px; }
  .rname { font:600 20px/1.2 var(--sans); letter-spacing:-.4px; color:var(--ink); }
  .shots { display:flex; gap:16px; overflow-x:auto; padding:2px 2px 12px;
         scrollbar-width:thin; scrollbar-color:#d4d4d4 transparent; }
  .shots::-webkit-scrollbar { height:8px; }
  .shots::-webkit-scrollbar-thumb { background:#d4d4d4; border-radius:var(--r-full); }
  .shot { flex:0 0 auto; text-decoration:none; color:var(--mute); cursor:zoom-in; }
  .shot[hidden] { display:none; }
  .shot .frame { display:block; max-height:480px; overflow:hidden; background:var(--elevated);
         border:1px solid var(--hairline); border-radius:var(--r-md); transition:border-color .12s; }
  .shot:hover .frame { border-color:#d4d4d4; }
  .shot img { width:100%; display:block; }
  .shot-label { display:block; margin-top:9px; font:500 12px/16px var(--mono);
         letter-spacing:.06em; text-transform:uppercase; color:var(--mute); }
  ${vpThumbCss}
  .no-shots, .no-vp { color:var(--mute); font-size:14px; }
  .no-vp { padding:14px 0; }

  /* Comment pane — text-input (sticky beside the shots) */
  .pane { display:flex; flex-direction:column; gap:8px; position:sticky; top:72px; }
  .pane-top { display:flex; align-items:center; gap:10px; }
  .pane-label { font:500 12px/16px var(--mono); letter-spacing:.06em; text-transform:uppercase;
         color:var(--mute); }
  .path, .flag-path { font:400 12px/16px var(--mono); color:var(--body);
         background:var(--hairline-soft); border:1px solid var(--hairline);
         padding:2px 7px; border-radius:var(--r-sm); user-select:all; overflow-wrap:anywhere; }
  textarea.cmt { min-height:140px; flex:1; resize:vertical; width:100%; background:var(--elevated);
         color:var(--ink); border:1px solid var(--hairline); border-radius:var(--r-sm);
         padding:10px 12px; font:400 14px/1.55 var(--sans);
         transition:border-color .12s,box-shadow .12s; }
  textarea.cmt::placeholder { color:var(--faint); }
  textarea.cmt:focus { outline:none; border-color:var(--link);
         box-shadow:0 0 0 3px rgba(0,112,243,.16); }
  textarea.cmt.filled { border-color:var(--link); }
  textarea.cmt.filled:focus { box-shadow:0 0 0 3px rgba(0,112,243,.16); }

  /* Flagged rows — amber for gated, red for error; restrained tint + accent rule */
  .row.flagged .flag-main { border:1px solid var(--hairline); border-radius:var(--r-md);
         padding:16px 18px; background:var(--hairline-soft);
         display:flex; flex-direction:column; gap:12px; }
  .row.gated .flag-main { border-left:3px solid var(--warning); }
  .row.error .flag-main { border-left:3px solid var(--error); }
  .flag-head { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
  .badge { font:500 12px/16px var(--mono); letter-spacing:.06em; text-transform:uppercase;
         padding:2px 8px; border-radius:var(--r-sm); border:1px solid transparent; }
  .row.gated .badge { color:var(--warning-deep); border-color:#f0d9a8; background:#fdf6e7; }
  .row.error .badge { color:var(--error-deep); border-color:#f2c4c4; background:#fef4f4; }
  .reason { color:var(--body); font-size:14px; }
  .remedy-wrap { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  .remedy-label { color:var(--mute); font:500 12px/16px var(--mono); letter-spacing:.06em; text-transform:uppercase; }
  code.remedy { background:var(--elevated); border:1px solid var(--hairline); border-radius:var(--r-sm);
         padding:6px 10px; font:400 13px/1.4 var(--mono); color:var(--ink); cursor:pointer;
         transition:border-color .12s,color .12s; }
  code.remedy:hover { border-color:#d4d4d4; }
  code.remedy.copied { border-color:var(--link); color:var(--link-deep); }

  /* Lightbox: fixed overlay, scrollable for tall full-page shots */
  #lb { position:fixed; inset:0; z-index:50; display:none; overflow:auto;
         overscroll-behavior:contain; background:rgba(23,23,23,.72);
         -webkit-backdrop-filter:blur(4px); backdrop-filter:blur(4px); }
  #lb.open { display:block; }
  #lb .lb-bar { position:sticky; top:0; z-index:2; display:flex; align-items:center; gap:14px;
         padding:12px 20px; background:linear-gradient(rgba(23,23,23,.55), rgba(23,23,23,0)); }
  #lb .lb-file { font:500 12px/16px var(--mono); color:rgba(255,255,255,.82); overflow-wrap:anywhere; }
  #lb .lb-hint { font:500 11px/16px var(--mono); letter-spacing:.04em; color:rgba(255,255,255,.5); }
  #lb .lb-close { margin-left:auto; width:36px; height:36px; padding:0; border-radius:var(--r-full);
         border:1px solid rgba(255,255,255,.24); background:rgba(255,255,255,.10); color:#fff;
         font:400 18px/1 var(--sans); }
  #lb .lb-close:hover { background:rgba(255,255,255,.20); border-color:rgba(255,255,255,.4); }
  #lb img { display:block; width:auto; max-width:min(1600px, 94vw); margin:8px auto 120px;
         border:1px solid rgba(255,255,255,.14); border-radius:var(--r-md); cursor:zoom-in;
         background:var(--elevated); box-shadow:var(--float); }
  #lb.zoomed img { max-width:none; width:94vw; cursor:zoom-out; }
  body.lb-open { overflow:hidden; }

  /* Page-load reveal */
  @media (prefers-reduced-motion:no-preference){
    .part { animation:rise .45s cubic-bezier(.2,.7,.2,1) both; }
    .part:nth-child(1){animation-delay:.02s} .part:nth-child(2){animation-delay:.07s}
    .part:nth-child(3){animation-delay:.12s} .part:nth-child(4){animation-delay:.17s}
    .part:nth-child(n+5){animation-delay:.22s}
    @keyframes rise { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:none} }
  }

  /* Responsive */
  @media (max-width:860px){
    .row { grid-template-columns:1fr; gap:16px; }
    .pane { position:static; }
    textarea.cmt { min-height:90px; }
  }
  @media (max-width:640px){
    .hero-inner { padding:36px 16px 32px; }
    .hero h1 { font-size:34px; letter-spacing:-1.6px; }
    .hero-stats { gap:6px 18px; }
    .bar-inner, main { padding-left:16px; padding-right:16px; }
    .row, .part > summary { padding-left:16px; padding-right:16px; }
    .progress { flex:1 1 100%; }
  }
</style>
</head>
<body>
<header class="hero">
  <div class="hero-inner">
    <p class="eyebrow">Screenshot review</p>
    <h1>${esc(project)}</h1>
    <p class="hero-sub">Review the captured screens and leave notes. Comments autosave locally and export to Markdown.</p>
    <div class="hero-stats">${heroStatsHtml}</div>
  </div>
</header>
<div class="bar" id="bar">
  <div class="bar-inner">
    <div class="progress">
      <div class="progress-line">
        <span class="prog"><b id="done">0</b><span class="prog-total">/ ${totalRows}</span></span>
        <span class="prog-eyebrow">commented</span>
      </div>
      <div class="meter"><i id="meterFill"></i></div>
    </div>
    <nav class="vp-toggle" id="vpToggle" aria-label="Viewport">${vpDefs.map((v) =>
		`<button data-vp="${esc(v.name)}">${esc(v.name)}</button>`).join("")}</nav>
    <span class="spacer"></span>
    <div class="actions">
      <button id="collapseAll">Collapse all</button>
      <button id="expandAll">Expand all</button>
      <label class="btn">Import…<input type="file" id="import" accept=".json"></label>
      <button class="danger" id="clear">Clear all</button>
      <button class="primary" id="export">Export COMMENTS.md</button>
    </div>
  </div>
</div>
<div class="stale" id="stale"></div>
<main>${partsHtml}</main>
<div id="lb" role="dialog" aria-modal="true" aria-label="Screenshot">
  <div class="lb-bar">
    <span class="lb-file" id="lbFile"></span>
    <span class="lb-hint">click to zoom · ←/→ next shot · esc to close</span>
    <button class="lb-close" id="lbClose" aria-label="Close">×</button>
  </div>
  <img id="lbImg" alt="">
</div>
<script>
const KEY = ${JSON.stringify(KEY)};
const ROUTES = ${JSON.stringify(routeMeta)};
const TOTAL = ${totalRows};
const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };
let data = load();
const areas = [...document.querySelectorAll("textarea.cmt")];
const meterFill = document.getElementById("meterFill");

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
  if (meterFill) meterFill.style.width = (TOTAL ? (done/TOTAL*100) : 0) + "%";
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

// Sticky-bar elevation on scroll
const bar = document.getElementById("bar");
const onScroll = () => bar.classList.toggle("stuck", window.scrollY > 4);
window.addEventListener("scroll", onScroll, {passive:true}); onScroll();

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
