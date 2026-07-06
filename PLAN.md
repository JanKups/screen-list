# Architectural plan: `screenshot-review-web`

**Status:** plan for review — nothing built yet (per Jan's hold-off).
**Inputs:** locked design record (`project_screenshot_review_web_skill.md`, 10 decisions) + handoff doc (2026-07-06). Where this plan makes a call the design left open, it is marked **[architect's call]**.

A public, standalone Claude Code skill that, dropped into any web project, detects its shape, screenshots all rendering routes (auth included, 2 viewports, optional interaction states), and generates a self-contained comment-review gallery exporting `COMMENTS.md` + `comments.json`.

---

## 1. Repository layout (build workspace)

```
~/dev/screenshot-review-web/
├── PLAN.md                      ← this document
├── skill/                       ← the shipped skill (what gets packaged)
│   ├── SKILL.md
│   ├── references/
│   │   ├── route-discovery.md   ← per-framework crawl rules (§6)
│   │   ├── auth-setup.md        ← auth taxonomy + setup dialogues (§7)
│   │   └── config-reference.md  ← full JSONC schema doc (§4)
│   └── assets/                  ← templates COPIED into the target project
│       ├── capture.mjs
│       ├── generate.mjs
│       ├── package.json
│       ├── README.md
│       ├── gitignore            ← renamed to .gitignore on copy
│       └── screenshots.config.jsonc  ← annotated template (skill fills it in)
├── evals/                       ← skill-creator eval harness (§10)
└── workspace/                   ← throwaway fixture apps (gitignored)
```

**[architect's call]** Templates live in `assets/` (not `scripts/`): per skill-creator convention, `scripts/` is for helpers the skill *executes in place*; these files are *copied out* into the target project and run from there. Nothing in the skill executes from the skill directory.

---

## 2. What Setup scaffolds in the target project

Everything lands in one self-contained folder (default `screenshots/` at repo root; propose-and-confirm per decision 9):

```
screenshots/
├── screenshots.config.jsonc     ← the spine (committed)
├── package.json                 ← declares playwright only (committed)
├── README.md                    ← how to re-run standalone (committed)
├── .gitignore                   ← node_modules/, .screenshots-auth/, **/*.png, .logs/
├── capture.mjs                  ← committed
├── generate.mjs                 ← committed
├── gallery.html                 ← generated, committed (per decision 9)
├── capture-manifest.json        ← generated per run (committed; feeds gallery, §5.8)
├── .screenshots-auth/           ← GITIGNORED: secrets.env, <part>.storageState.json
├── .logs/                       ← GITIGNORED: dev-server stdout per run
└── <part>/                      ← PNGs, gitignored
    ├── 01-home.desktop.png
    ├── 01-home.mobile.png
    └── 03-item-detail.modal-open.desktop.png
```

Standalone contract: `cd screenshots && npm install && node capture.mjs` works with no skill present. Playwright installs local to this folder — host `package.json` / lockfile never touched. (In pnpm monorepos the folder is *not* added to the workspace; `npm install` inside it is isolated by design. README notes this.)

**Committed gallery caveat (accepted):** `gallery.html` references gitignored PNGs relatively, so on a fresh clone it shows broken thumbnails until `node capture.mjs` runs. README states this; the gallery header also shows a hint when >50% of images fail to load.

---

## 3. SKILL.md structure

Target: body ≤ ~150 lines; per-framework and per-auth detail pushed to `references/` (progressive disclosure).

```
---
name: screenshot-review-web
description: <drafted during build; optimized via skill-creator's description loop.
  Working draft: "Screenshot every route of a web app (Next.js, Remix, SvelteKit,
  Astro, Vite) into a comment-review gallery. Detects monorepo parts, dev servers,
  auth walls, and dynamic routes; captures desktop+mobile full-page shots; generates
  an HTML review sheet exporting COMMENTS.md. Use when the user wants screenshots of
  their web app, a visual review pass, a screenshot gallery, or to review all screens.">
---
```

Body outline:

1. **Mode selection** (first thing): glob `**/screenshots.config.jsonc` (depth ≤ 3, skip node_modules). Found → **Capture mode**; not found → **Setup mode**.
2. **Setup mode** — numbered procedure: detect shape (→ pointer to `references/route-discovery.md` for framework specifics) → ask which part(s) → crawl routes → ONE batched question for dynamic-route sample values + proposed exclusions → auth probe + setup (→ `references/auth-setup.md`) → propose output location → scaffold folder from `assets/` → fill config → `npm install` → run `--login` if needed → **CONFIRM with the user before first capture** → capture → generate gallery → report path + open instructions.
3. **Capture mode** — read config → drift check (§8) → resolve conversational target ("re-shoot admin", "just /dashboard subtree") to `capture.mjs` CLI flags → run → regenerate gallery → report.
4. **Hard rules** block (verbatim invariants):
   - Discover, then confirm — never assume.
   - Never clobber user edits to the config; drift updates are *offered*, applied only on approval.
   - Secrets never in the config file; only env-var *names*. Secrets live in `.screenshots-auth/` (gitignored).
   - Stop only servers this run started.
   - Unconfigured auth gate → capture public routes, flag gated ones in the gallery; never silently drop.
   - Storybook detected → say it's out of scope v1, continue with app routes.

`references/config-reference.md` documents every config field (the schema in §4) so the skill can answer "how do I add a state?" without bloating SKILL.md.

---

## 4. Config schema — `screenshots.config.jsonc`

JSONC (comments + trailing commas). Parsed by a ~20-line comment-stripper inside `capture.mjs` — no extra dependency. The template ships with explanatory comments on every field; the skill fills values during Setup.

```jsonc
{
  "version": 1,
  "project": "my-app",              // used to namespace gallery localStorage key

  // Global capture defaults (per-route overridable where noted)
  "viewports": [
    { "name": "desktop", "width": 1440, "height": 900 },
    { "name": "mobile",  "width": 390,  "height": 844 }
  ],
  "fullPage": true,
  "settle": {                        // see §5.6 for semantics
    "networkIdleMs": 500,            // quiet-network window
    "timeoutMs": 15000,              // hard cap on settling
    "extraDelayMs": 250,             // fixed tail after all signals
    "disableAnimations": true        // inject reduced-motion + animation-freeze CSS
  },

  "parts": [
    {
      "name": "admin",
      "dir": "apps/admin",           // relative to repo root
      "server": {
        "url": "http://localhost:3002",
        "command": "pnpm dev",       // run in `dir` if port not already up
        "cwd": null,                 // override command cwd (default: dir)
        "readyTimeoutMs": 60000,
        "readyPattern": null         // optional stdout regex; default: poll url
      },
      "companions": [                // started (if not up) BEFORE the part server
        {
          "name": "convex",
          "command": "npx convex dev",
          "cwd": "packages/backend",
          "readyPattern": "ready",
          "url": null                // poll url OR match readyPattern
        }
      ],

      "auth": {
        "strategy": "credentials",   // "none" | "credentials" | "manual-session" | "header"
        // strategy: "credentials" — scripted form login
        "loginPath": "/login",
        "fields": {
          "username": "input[name=email]",   // selectors auto-detected at setup
          "password": "input[type=password]",
          "submit": "button[type=submit]"
        },
        "env": { "username": "SR_ADMIN_USER", "password": "SR_ADMIN_PASSWORD" },
        "success": { "urlNotMatching": "/login" },  // post-login verification
        // strategy: "manual-session" — storageState from one-time headed login:
        //   no extra fields; state file is .screenshots-auth/<part>.storageState.json
        // strategy: "header" — inject a credential:
        // "inject": { "kind": "header",           // "header" | "cookie" | "query"
        //             "name": "Authorization",
        //             "valueEnv": "SR_API_TOKEN",
        //             "format": "Bearer {value}" }
        "gateSignal": { "urlMatching": "/login" }   // how to DETECT a bounce (→ gated)
      },

      "routes": [
        // Order defines the NN numbering prefix. User edits are sacred.
        { "path": "/", "name": "home" },
        { "path": "/items", "name": "items" },
        {
          "path": "/items/[id]",
          "name": "item-detail",
          "params": { "id": "abc123" },   // sample values from setup Q&A
          "auth": true,                    // requires the part's auth strategy
          "settle": { "waitFor": "[data-loaded]" },  // per-route override/addition
          "states": [                      // Level-2 named interaction states
            {
              "name": "modal-open",
              "actions": [
                { "click": "text=Edit" },
                { "waitFor": "[role=dialog]" }
              ]
            }
          ]
        }
      ]
    }
  ]
}
```

**State action vocabulary** (deliberately tiny, v1): `click`, `fill` (`{ "fill": ["selector", "value"] }`), `hover`, `press` (keyboard key), `waitFor` (selector), `wait` (ms), `scrollTo` (selector). Anything richer is a v2 concern.

**Secrets:** `.screenshots-auth/secrets.env` holds `KEY=value` lines for the env names referenced in config. `capture.mjs` loads it if present; real environment variables override it. The skill writes this file during auth setup (and the `.gitignore` guarding it) so `node capture.mjs` works without exporting vars each time.

---

## 5. `capture.mjs` architecture

**[architect's call]** One file (~600–700 lines), clearly sectioned with banner comments — no module splitting. Rationale: the folder must be trivially copy-portable and readable top-to-bottom; two files (`capture.mjs`, `generate.mjs`) is the whole tool. The headed login is a subcommand of capture, not a third file.

### 5.1 CLI

```
node capture.mjs                          # everything in config
node capture.mjs --part admin             # one part (repeatable)
node capture.mjs --route "/items/**"      # glob filter on route paths (repeatable)
node capture.mjs --viewport mobile        # one viewport
node capture.mjs --state modal-open       # only states matching (default: base + all states)
node capture.mjs --login admin            # headed one-time login for a part → storageState
node capture.mjs --keep-servers           # don't stop servers we started
node capture.mjs --dry-run                # print the capture matrix, no browser
```

The skill's Capture mode translates conversational targets into these flags.

### 5.2 Config + secrets load
Strip JSONC comments → `JSON.parse` → structural validation with friendly errors ("parts[0].routes[3]: `states[0].actions` must be an array"). Load `.screenshots-auth/secrets.env` into `process.env` (non-overriding).

### 5.3 Server lifecycle
Per part, companions first, then the part server:
1. **Probe:** HTTP GET `url` (3 retries, 1s apart). Up → reuse, mark *not ours*.
2. **Start:** `spawn(command, { cwd, detached: false, shell: true })`, pipe stdout/stderr to `.logs/<name>.log`. Ready = `readyPattern` match on stdout if set, else poll `url` until 200/3xx or `readyTimeoutMs`.
3. **Teardown (finally + SIGINT handler):** kill only PIDs we spawned — process-group kill (`process.kill(-pid)` via `detached: true` + own group) so `pnpm dev` children die too; SIGTERM, 5s grace, SIGKILL. Skipped with `--keep-servers`.

### 5.4 Auth resolution → browser context
One Chromium instance per run; one `browser.newContext()` per part × viewport.
- `none` → plain context.
- `manual-session` → `storageState: .screenshots-auth/<part>.storageState.json`. Missing file → do NOT fail the run: mark all `auth: true` routes of that part **gated** with remedy "run `node capture.mjs --login <part>`", capture the rest.
- `credentials` → once per part per run: fresh page → `loginPath` → fill fields from env → submit → verify `success` condition → `context.storageState()` held in memory and reused for that part's other viewport contexts. Env vars missing → same gated-not-failed behavior.
- `header` → `kind: header` → `extraHTTPHeaders`; `cookie` → `context.addCookies`; `query` → appended to every navigated URL.

### 5.5 `--login <part>` (headed one-time login)
Launch headed Chromium → navigate to `server.url + loginPath` (server lifecycle applies) → print: *"Complete the login in the browser window. Press Enter here when you're on a logged-in page."* → on Enter, verify `success`/`gateSignal` if configured (warn but save anyway if unverifiable) → write `.screenshots-auth/<part>.storageState.json` → close. Also usable to *refresh* an expired session.

### 5.6 Settle heuristic **[architect's call]**
All of the following, in order, bounded overall by `settle.timeoutMs`:
1. `page.goto(url, { waitUntil: "load" })`
2. Network quiet: no in-flight requests for `networkIdleMs` (own tracker via request/response events — Playwright's `networkidle` waits a fixed 500ms but is deprecated-discouraged and un-tunable; ours degrades gracefully: on timeout, proceed with a console warning, never fail the shot).
3. `document.fonts.ready`
4. Two `requestAnimationFrame`s (layout flushed).
5. Per-route `settle.waitFor` selector, if set.
6. `extraDelayMs` fixed tail.
7. If `fullPage` and page is long: programmatic scroll to bottom and back (triggers lazy loaders / IntersectionObservers), then repeat step 2 once.

`disableAnimations: true` injects `page.emulateMedia({ reducedMotion: "reduce" })` + a stylesheet forcing `animation: none; transition: none` — deterministic shots, no mid-fade captures.

### 5.7 Capture loop
```
for part → for viewport → (context w/ auth) → for route:
    expand params into concrete URL
    navigate + settle → gate check (§5.8)
    screenshot fullPage → <part>/NN-name.viewport.png
    for each state (fresh navigation per state — states are independent, not cumulative):
        run actions → settle → <part>/NN-name.state.viewport.png
```
NN = 2-digit index of the route in config order (per part). Renaming/reordering routes in config renames files on next capture; stale PNGs from removed routes are reported at the end and deleted only if the user confirms (skill-mediated) or `--prune` is passed.

### 5.8 Gate detection + manifest
After every navigation: if final URL matches `gateSignal.urlMatching`, or the login `fields.username` selector is present, the route is recorded **gated** (no PNG). Every run rewrites `capture-manifest.json`:

```jsonc
{ "generatedAt": "…", "runs": [ { "part": "admin", "route": "/items/[id]", "name": "item-detail",
    "status": "ok" | "gated" | "error",  "files": ["admin/03-item-detail.desktop.png", …],
    "reason": "redirected to /login — auth not configured", "remedy": "node capture.mjs --login admin" } ] }
```
Partial runs (`--part`/`--route` filters) merge into the existing manifest rather than replacing it, so the gallery always reflects the union of the latest capture of each route.

### 5.9 Exit report
Table to stdout: captured / gated / errored counts per part, wall time, then "Run `node generate.mjs` (or it just ran) → open `gallery.html`". `capture.mjs` invokes `generate.mjs` automatically at the end (skippable with `--no-gallery`).

---

## 6. Detection algorithms

### 6.1 Project shape (SKILL.md body, brief; detail in references)
1. Root `package.json` has `workspaces`, or `pnpm-workspace.yaml` / `turbo.json` / `lerna.json` exists → **monorepo**: expand workspace globs; a package is a **candidate part** iff its `package.json` has a `dev` or `start` script AND a web-framework dependency (`next`, `@remix-run/*` / `react-router`, `@sveltejs/kit`, `astro`, or `vite` + an `index.html`).
2. Single `package.json` with dev script + framework dep → **single app** (one part; still offer route-subtree filter).
3. `.storybook/` present → note out-of-scope v1, proceed with app routes.
4. Zero candidates → tell the user what was looked for; ask them to point at the app dir.

>1 candidate → ONE question: "which part(s)?" (multi-select). Port/URL detection: parse the dev script for `-p`/`--port`/`PORT=`; framework defaults (next 3000, vite 5173, astro 4321, remix 3000, sveltekit 5173); conflict across parts → ask.

### 6.2 Route crawl per framework (`references/route-discovery.md`)
| Framework (detect) | Route source | Rules |
|---|---|---|
| Next App Router (`app/` + `next` dep) | `app/**/page.*` | strip `(group)` segments; `[param]`/`[...param]`/`[[...param]]` → dynamic; ignore `@slot`, `(.)…` interceptors, `route.*`, `layout.*`, `api/` |
| Next Pages Router (`pages/`) | `pages/**/*.{js,jsx,ts,tsx}` | exclude `_app`, `_document`, `_error`, `api/`; `[param]` dynamic |
| Remix / React Router v7 fs-routes (`app/routes/`) | flat-file convention | dots → `/`; `$param` dynamic; `_layout.` prefixes pathless; `_index` → parent path |
| SvelteKit (`src/routes/`) | `**/+page.svelte` | strip `(group)`; `[param]` dynamic; ignore `+server.*` |
| Astro (`src/pages/`) | `**/*.{astro,md,mdx,html}` | `[param]` dynamic (sample values still asked — no `getStaticPaths` evaluation) |
| Vite SPA (no fs-router) | grep for `createBrowserRouter`/`<Route path=`/TanStack Router file conventions/`vite-plugin-pages` | best-effort extraction; if inconclusive → ask the user for the route list (fully supported manual path) |

**Non-rendering exclusion** (decision 3's "does it paint content?" gate) — two-stage:
1. Path heuristics: `api/`, `*callback*`, `*oauth*`, `logout`, `sitemap*`, `robots*`, `manifest*`, `opengraph-image*`, `icon*`, `*.xml`.
2. Content sniff of the route file: an immediate unconditional `redirect(...)` / `throw redirect(...)` at component top level → propose exclusion.
Everything is *proposed*, never silently dropped — exclusions appear (pre-checked) in the route-confirmation step.

**Dynamic routes:** collect ALL of them across all chosen parts, then ONE batched question listing each with a suggested sample (siblings inferred: `[id]/edit` exists → suggest same `id` for `[id]/share`). User supplies/edits values → stored as `params` in config.

### 6.3 Auth probe (setup time)
Per part, after server is up: headless-fetch `/` and one deep route → any redirect to a login-looking URL, or a rendered password field, or auth deps in `package.json` (`next-auth`, `@clerk/*`, `@auth0/*`, `lucia`, `firebase/auth`, `supabase` auth usage) → auth wall likely. Then the auth Q&A (`references/auth-setup.md`): which strategy → sign-in URL → for credentials: navigate the login page headlessly and auto-detect field selectors (username/email input, password input, submit) → ask test creds → write `secrets.env` → verify by logging in and checking we land on real content → set `gateSignal` from the observed login URL.

---

## 7. Auth reference (`references/auth-setup.md`) — content outline
- Decision tree: form with test creds → `credentials`; OAuth/magic-link/SSO → `manual-session`; API-key/basic/bearer → `header`.
- Per strategy: exact config block, what goes in `secrets.env`, verification step, failure modes (expired storageState → gallery shows gated rows with the `--login` remedy; wrong creds → login verification fails at setup, re-ask).
- The invariant list: secrets never in config; `.screenshots-auth/` must stay gitignored (skill verifies the `.gitignore` line exists on every Capture run).

---

## 8. Setup vs Capture flow + drift

```
skill invoked
└─ glob **/screenshots.config.jsonc (depth ≤3)
   ├─ none → SETUP: detect → ask parts → crawl → batch-Q (samples+exclusions)
   │         → auth probe+setup → propose output dir → scaffold + npm install
   │         → [--login if manual-session] → CONFIRM → capture → gallery → report
   └─ found → CAPTURE: parse config → drift check → resolve target → capture.mjs → gallery
```

**Drift check (Capture mode, skill-side, before every run):** re-crawl routes for the parts in config, diff by `path`:
- **Added** routes → propose appending (next NN, auto-name from path; dynamic ones get the sample-value question).
- **Removed** routes → flag; propose removal; never auto-delete.
- User-owned fields (`name`, `params`, `states`, `settle`, `auth`, order) are never touched by drift — diff is on route *existence* only.
- User declines → proceed with config as-is; note skipped drift in the report. Config file edits happen only through user-approved changes.

---

## 9. `generate.mjs` generalization (from the proven 265-line original)

Keep: single-file `gallery.html` output, sticky header + progress count, collapsible `<details>` per part, localStorage autosave, Cmd/Ctrl+Enter jump-to-next, Import JSON / Clear / Export → `COMMENTS.md` + `comments.json`, dark theme, lazy-loading thumbnails.

Change:
1. **Input = config + manifest**, not directory scan: rows in config route order, grouped part → route; each route row shows **all viewports side by side under ONE textarea** (comment keyed by `part/route`, not per-file). State shots render as extra thumbnails inside the same row, labeled with the state name.
2. **Neutral copy:** placeholder "Comment on this screen…"; header hint "focus a field → type or dictate → Cmd+Enter for next". No dictation framing.
3. **localStorage key:** `sr:<config.project>:v1`.
4. **Gated rows [architect's call]:** routes with manifest `status: "gated"` render as a full-width row with an amber left border, a 🔒 badge, the route path, the reason, and the remedy command in a copyable `<code>` block — **with a comment field** (reviewer can still note "must see this before ship"). They count separately in the header: "42 screens · 3 gated". `status: "error"` rows same treatment in red with the error message.
5. **Style:** keep the dark theme; swap the Preventieschool coral accent for a neutral indigo; add a stale-gallery hint if >50% of images fail to load (fresh clone case).
6. Export unchanged in shape; `COMMENTS.md` sections become `## part / route-name` with the route path in the heading.

---

## 10. Eval plan (skill-creator method)

Fixtures (in `workspace/`, throwaway, NOT preventieschool):
1. **`next-fixture`** — `create-next-app` (App Router) + added: one dynamic route (`/posts/[id]`), one route group, a fake `/login` page + middleware cookie-gate on `/dashboard`, an `api/` route and an auth callback (exclusion bait).
2. **`vite-fixture`** — Vite + react-router (code-defined routes) — exercises the no-fs-router fallback. (Astro starter as a stretch third.)

Scenarios (each: with-skill vs no-skill baseline, per skill-creator):
| # | Scenario | Pass criteria (scripted graders) |
|---|---|---|
| E1 | Fresh setup on next-fixture, decline auth | `screenshots/` scaffold complete; config validates; correct routes found (dynamic asked, api/callback excluded); N PNGs at both viewports; `gallery.html` parses; gated `/dashboard` flagged in manifest+gallery, not dropped |
| E2 | Setup with credentials auth | login succeeds; `/dashboard` PNG exists; `secrets.env` gitignored; no secret string in config |
| E3 | Capture re-run after adding a route to the fixture | drift *offered*; on accept, route appended with correct NN; user-edited route names untouched |
| E4 | Conversational partial: "re-shoot just /posts" | only matching PNGs' mtimes change; manifest merged, gallery still shows all routes |
| E5 | vite-fixture setup | route extraction or graceful ask-the-user fallback; capture completes |

Graders are node scripts: file-tree assertions, config-schema validation, PNG existence + dimension checks (1440-wide / 390-wide), manifest status checks, git-check that no PNG/secret is tracked.

---

## 11. Packaging & install

1. Build loop per skill-creator: draft → run evals → iterate → description-optimization loop (finalize the frontmatter description here, per handoff open item).
2. `package_skill.py skill/` → `screenshot-review-web.skill`.
3. Install: unpack to `~/.claude/skills/screenshot-review-web/`; smoke-test trigger phrases ("screenshot my app", "make a review gallery of all screens") + non-trigger phrases (mobile app screenshots → should NOT fire; the `-web` suffix and description wording guard this).

---

## 12. Build order (when Jan says go)

1. Scaffold `skill/` skeleton + this repo layout.
2. `assets/capture.mjs` + `assets/generate.mjs` against next-fixture by hand (no skill logic yet) — the scripts are the risk center; prove them first.
3. Config template + reference docs.
4. SKILL.md (modes, detection, Q&A choreography).
5. Eval harness E1–E5; iterate.
6. Description optimization → package → install.

## 13. Deliberately out of scope (v1)
Storybook capture; Level-3 autonomous exploration; visual diffing between runs; CI usage; non-Chromium browsers; multi-user comment merge (Import JSON covers the hand-off case); localization of gallery UI.
