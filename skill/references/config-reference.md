# Config reference — `screenshots.config.jsonc`

Every field the tooling reads, its type, default, and where it can be overridden.
This is the authoritative schema; `screenshots.config.jsonc` ships with the same
fields annotated inline. The file is JSONC (`//` and `/* */` comments and
trailing commas allowed) — `capture.mjs` strips comments with a tiny inline
parser before `JSON.parse`, then structurally validates the result and prints a
path-precise error (e.g. `parts[0].routes[3]: states[0].actions must be an
array`) if anything is off.

## Top level

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `version` | number | yes | — | Must be exactly `1`. |
| `project` | string | no | — | Namespaces the gallery's localStorage key (`sr:<project>:v1`). |
| `viewports` | array | no | desktop 1440×900 + mobile 390×844 | See below. An empty array also falls back to the default pair. |
| `fullPage` | boolean | no | `true` | Capture the whole scrollable page. Only `false` disables it. |
| `settle` | object | no | see [Settle](#settle) | Global settle defaults. |
| `parts` | array | yes | — | At least one part required. |

### Viewports

Each entry is `{ "name": string, "width": number, "height": number }` — all
three required. One screenshot is taken per route per viewport; the `name`
becomes part of the filename (`web/01-home.desktop.png`). Filter to one at
capture time with `--viewport <name>`.

## Parts

`parts` is an array; one entry per app/server to screenshot. A single app is
just one part.

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | Output subfolder + file prefix. Target of `--part <name>`. |
| `dir` | string | no | App path relative to the repo root (the folder **above** `screenshots/`). Used as the default `cwd` for `server`/`companions`. |
| `server` | object | no | Dev server for this part. Omit if it's always already running. |
| `companions` | array | no | Extra servers started **before** the part server. |
| `auth` | object | no | Login strategy — see [auth-setup.md](./auth-setup.md). |
| `routes` | array | yes | The routes to screenshot. |

### `server`

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `url` | string | yes (if `server` present) | — | Base URL, probed and prefixed onto every route path. |
| `command` | string | no | — | Started (in `dir`) only if `url` isn't already up. Required if the server isn't already running. |
| `cwd` | string | no | `dir` | Override the command's working directory. |
| `readyTimeoutMs` | number | no | `60000` | How long to wait for readiness before failing. |
| `readyPattern` | string (regex) | no | — | Ready when stdout matches this regex. If unset, readiness is polled from `url` (HTTP < 500). |

A server already up at `url` is reused and **never** stopped by the tool; only
servers this run started are torn down (SIGTERM, 5s grace, SIGKILL). Use
`--keep-servers` to leave started servers running.

### `companions`

Array of extra servers (databases, API/backend processes, etc.) started before
the part server. Same shape as `server` plus a `name`, and **exactly one of
`url` / `readyPattern` is required** for readiness detection.

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | no | Log file name (`.logs/<name>.log`). |
| `command` | string | yes | The process to start. |
| `cwd` | string | no | Defaults to the part's `dir`. |
| `url` | string | one of url/readyPattern | Poll this URL for readiness. |
| `readyPattern` | string (regex) | one of url/readyPattern | Match stdout for readiness. |
| `readyTimeoutMs` | number | no | Default `60000`. |

### `routes`

Array; **order defines the two-digit `NN` filename prefix** (`01`, `02`, …) per
part. Reordering or renaming routes renames files on the next capture; stale
PNGs from removed routes are reported (deleted only with `--prune`).

| Field | Type | Required | Notes |
|---|---|---|---|
| `path` | string | yes | URL path. Dynamic segments use `[param]`, `[...rest]`, `[[...opt]]`. |
| `name` | string | yes | Slug used in the filename. |
| `params` | object | no | Sample values for dynamic segments (`{ "id": "abc123" }`). A dynamic path with no matching param is skipped as an error. |
| `auth` | boolean | no | `true` → this route needs the part's auth; if the credential is missing it's recorded **gated** (not failed), everything else still captures. |
| `settle` | object | no | Per-route settle override, merged over the global `settle`. Commonly `{ "waitFor": "<selector>" }`. |
| `states` | array | no | Named interaction states → extra shots. See below. |

### States

Each state is `{ "name": string, "actions": array }` — both required. A state
produces one extra screenshot per viewport
(`web/03-item-detail.modal-open.desktop.png`). States are **independent**: each
starts from a fresh navigation of the route, not cumulatively. Filter with
`--state <name>` (the base shot is always kept).

**Action vocabulary** (one key per action object):

| Action | Form | Effect |
|---|---|---|
| `click` | `{ "click": "<selector>" }` | Click the element. |
| `fill` | `{ "fill": ["<selector>", "<value>"] }` | Type a value into an input. |
| `hover` | `{ "hover": "<selector>" }` | Hover the element. |
| `press` | `{ "press": "<key>" }` | Press a keyboard key (e.g. `"Enter"`, `"Escape"`). |
| `waitFor` | `{ "waitFor": "<selector>" }` | Wait until the selector appears. |
| `wait` | `{ "wait": <ms> }` | Fixed pause in milliseconds. |
| `scrollTo` | `{ "scrollTo": "<selector>" }` | Scroll the element into view. |

Selectors are Playwright selectors (`text=Edit`, `[role=dialog]`,
`input[name=email]`, …).

## Settle

`settle` controls how long a page is allowed to stop moving before the shot. All
steps run in order, bounded overall by `timeoutMs`; on any timeout the tool
**warns and shoots anyway** — a settle hiccup never fails a shot.

| Field | Type | Default | Notes |
|---|---|---|---|
| `networkIdleMs` | number | `500` | Require this many ms with zero in-flight requests (own tracker, not Playwright's deprecated `networkidle`). |
| `timeoutMs` | number | `15000` | Hard cap on the whole settle sequence. |
| `extraDelayMs` | number | `250` | Fixed tail pause after all other signals. |
| `disableAnimations` | boolean | `true` | Emulate `prefers-reduced-motion: reduce` and inject CSS zeroing animation/transition durations, so shots aren't caught mid-transition. |
| `waitFor` | string (selector) | — | Not a global default; set it **per route** to block on a selector before shooting. |

Full settle order (per navigation): `goto(load)` → network quiet
(`networkIdleMs`) → `document.fonts.ready` → two `requestAnimationFrame`s →
per-route `waitFor` (if set) → `extraDelayMs` tail → for long full pages, a
scroll to bottom and back (to trigger lazy loaders) then one more network-quiet
wait.

## Secrets

Secrets are **never** stored in this config — only env-var *names* (in
`auth.env` and `auth.inject.valueEnv`). Values live in
`.screenshots-auth/secrets.env` as `KEY=value` lines, which `capture.mjs` loads
into `process.env` **without** overriding variables already set in the real
environment. That folder is gitignored. See [auth-setup.md](./auth-setup.md).

## CLI flags (capture.mjs)

The skill translates conversational targets ("re-shoot admin") into these; run
`node capture.mjs --help` for the list.

| Flag | Effect |
|---|---|
| `--part <name>` | Only this part (repeatable). |
| `--route "<glob>"` | Filter routes by path glob, `**`/`*` (repeatable). |
| `--viewport <name>` | Only this viewport. |
| `--state <name>` | Only states matching (base shot always kept). |
| `--login <part>` | Headed one-time login → saved storageState. |
| `--keep-servers` | Don't stop servers we started. |
| `--dry-run` | Print the capture matrix; launch no browser or servers. |
| `--no-gallery` | Skip the `generate.mjs` gallery step. |
| `--prune` | Delete stale PNGs from removed/renamed routes. |
| `--config <path>` | Config file (default `screenshots.config.jsonc`). |
| `--help` | Show usage. |

Partial runs (`--part` / `--route` / `--viewport` / `--state`) merge into the
existing `capture-manifest.json` rather than replacing it, so the gallery always
reflects the union of the latest capture of each route.
