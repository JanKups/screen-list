# Route discovery — per-framework crawl rules

How Setup finds the routes to screenshot. Detect the framework from its route
directory + dependency, crawl the route source, then **propose** the route list
for confirmation — nothing is ever added or dropped silently.

## Framework crawl table

| Framework (how to detect) | Route source | Rules |
|---|---|---|
| **Next App Router** (`app/` dir + `next` dep) | `app/**/page.*` | Strip `(group)` segments from the path; `[param]` / `[...param]` / `[[...param]]` are dynamic. Ignore `@slot` parallel routes, `(.)`…`(...)` intercepting routes, `route.*`, `layout.*`, and anything under `api/`. |
| **Next Pages Router** (`pages/` dir) | `pages/**/*.{js,jsx,ts,tsx}` | Exclude `_app`, `_document`, `_error`, and `api/`; `[param]` is dynamic. |
| **Remix / React Router v7 fs-routes** (`app/routes/`) | flat-file route convention | Dots in filenames → `/` separators; `$param` is dynamic; `_layout.`-prefixed segments are pathless; `_index` maps to its parent path. |
| **SvelteKit** (`src/routes/`) | `**/+page.svelte` | Strip `(group)` segments; `[param]` is dynamic; ignore `+server.*` endpoint files. |
| **Astro** (`src/pages/`) | `**/*.{astro,md,mdx,html}` | `[param]` is dynamic (sample values are still asked — `getStaticPaths` is **not** evaluated). |
| **Vite SPA, no fs-router** | grep the source | Best-effort: look for `createBrowserRouter`, `<Route path=`, TanStack Router file conventions, or `vite-plugin-pages`. If extraction is inconclusive, **ask the user for the route list** — this manual path is fully supported, not a failure. |

Detection tips: a package is a candidate part only if its `package.json` has a
`dev` or `start` script **and** a web-framework dependency. For the dev-server
port, parse the dev script for `-p` / `--port` / `PORT=`; otherwise use the
framework default (Next 3000, Vite 5173, Astro 4321, Remix 3000, SvelteKit
5173). If two parts collide on a port, ask.

## Non-rendering exclusion (two stages)

Decision-3 gate: "does this route paint content?" Routes that don't (endpoints,
redirects, asset generators) are **proposed** for exclusion — pre-checked in the
route-confirmation step, never silently removed. The user can un-exclude any of
them.

**Stage 1 — path heuristics.** Propose excluding paths matching:
`api/`, `*callback*`, `*oauth*`, `logout`, `sitemap*`, `robots*`, `manifest*`,
`opengraph-image*`, `icon*`, `*.xml`.

**Stage 2 — content sniff.** Read the route file: an immediate, unconditional
`redirect(...)` / `throw redirect(...)` at the top level of the component (a
top-level redirect, not one behind a condition) → propose exclusion. It renders
nothing worth shooting.

Everything from both stages is *proposed*, appearing pre-checked in the
confirmation step. The user has final say.

## Dynamic routes → one batched question

Dynamic routes (`[id]`, `$slug`, `[...rest]`, …) need a concrete sample value to
screenshot. Do **not** ask per route as you find them. Instead:

1. Collect **all** dynamic routes across every chosen part first.
2. Infer a suggested sample per route from siblings — if `[id]/edit` already has
   a value, suggest the same `id` for `[id]/share`.
3. Ask **one** batched question listing each dynamic route with its suggested
   sample. The user supplies or edits the values.
4. Store the answers as each route's `params` object in the config
   (`{ "id": "abc123" }`).

A dynamic route left without a param is skipped at capture time as an error (its
URL still contains an unexpanded `[param]`), so every dynamic route needs a
value before the first real run.
