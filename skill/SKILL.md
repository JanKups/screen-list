---
name: screenshot-review-web
description: 'Screenshot every route of a web app (Next.js, Remix, SvelteKit, Astro, Vite) into a comment-review gallery. Detects monorepo parts, dev servers, auth walls, and dynamic routes; captures desktop+mobile full-page shots; generates an HTML review sheet exporting COMMENTS.md. Use when the user wants screenshots of their web app, a visual review pass, a screenshot gallery, or to review all screens.'
---

# screenshot-review-web

Detect a web project's shape, screenshot its rendering routes (auth included, two
viewports, optional interaction states), and generate a self-contained
comment-review gallery.

## Mode selection (do this first)

Glob for `**/screenshots.config.jsonc` (depth ≤ 3, skip `node_modules`).

- **Found** → the project is already set up → **Capture mode**.
- **Not found** → **Setup mode**.

## Setup mode

Discover, propose, and confirm at each step — never assume. Ask questions in one
batch where noted.

1. **Detect project shape.** Monorepo if the root `package.json` has
   `workspaces`, or `pnpm-workspace.yaml` / `turbo.json` / `lerna.json` exists →
   expand workspace globs. A package is a **candidate part** iff its
   `package.json` has a `dev` or `start` script AND a web-framework dep (`next`,
   `@remix-run/*` / `react-router`, `@sveltejs/kit`, `astro`, or `vite` + an
   `index.html`). A single app is one part. Detect each part's port from its dev
   script (`-p` / `--port` / `PORT=`) else the framework default (next 3000, vite
   5173, astro 4321, remix 3000, sveltekit 5173); conflicts across parts → ask.
   Zero candidates → say what you looked for and ask for the app dir.
2. **Ask which part(s)** if more than one candidate (multi-select).
3. **Crawl routes** for each chosen part per
   [references/route-discovery.md](references/route-discovery.md).
4. **ONE batched question**: list every dynamic route with a suggested sample
   value, plus the proposed non-rendering exclusions (`api/`, `*callback*`,
   redirect-only routes, etc.) **pre-checked**. User supplies/edits sample values
   and unchecks any exclusion to keep.
5. **Auth probe + setup** per [references/auth-setup.md](references/auth-setup.md):
   probe each part for an auth wall, then run the strategy Q&A (`none` /
   `credentials` / `manual-session` / `header`). Write secrets to
   `.screenshots-auth/secrets.env`, never into the config.
6. **Propose the output location** (default `screenshots/` at repo root) and
   confirm before creating it.
7. **Scaffold the folder** by copying everything from `assets/` into it —
   `capture.mjs`, `generate.mjs`, `package.json`, `README.md`,
   `screenshots.config.jsonc`, and `gitignore` **renamed to `.gitignore`** on
   copy.
8. **Fill the config** from what you discovered (parts, servers, routes, params,
   auth). Field reference: [references/config-reference.md](references/config-reference.md).
9. **`npm install`** inside the output folder (Playwright installs local to it;
   the host lockfile is never touched).
10. **`node capture.mjs --login <part>`** for any `manual-session` part (headed
    one-time login → saved storageState).
11. **CONFIRM with the user before the first capture.** This is mandatory.
12. **Capture**: `node capture.mjs` (it runs `generate.mjs` automatically).
13. **Report** the gallery path and how to open it (`open screenshots/gallery.html`).

## Capture mode

1. **Read the config.**
2. **Drift check** (before every run): re-crawl routes for the parts in config and
   diff **by route `path` only**.
    - **Added** routes → propose appending each with the next `NN` and an
      auto-generated name (dynamic ones get the sample-value question).
    - **Removed** routes → flag and propose removal; **never auto-delete**.
    - User-owned fields (`name`, `params`, `states`, `settle`, `auth`, order) are
      **never** touched — the diff is on route existence only.
    - User declines → proceed with the config as-is and note the skipped drift in
      the report.
3. **Resolve the conversational target** to `capture.mjs` flags:
    - "re-shoot admin" → `--part admin`
    - "just the /dashboard subtree" → `--route "/dashboard/**"`
    - "only mobile" → `--viewport mobile`; "only the modal-open state" →
      `--state modal-open`
    - refresh an expired login → `--login <part>`
   No target → run `node capture.mjs` (everything). Partial runs merge into the
   existing manifest, so the gallery keeps every route.
4. **Run** `node capture.mjs [flags]` (regenerates the gallery unless
   `--no-gallery`).
5. **Report** captured / gated / errored counts and the gallery path.

## Hard rules

- **Discover, then confirm** — never assume.
- **Never clobber user edits to the config**; drift updates are *offered*, applied
  only on approval.
- **Secrets never go in the config file** — only env-var *names*. Secrets live in
  `.screenshots-auth/` (gitignored).
- **Stop only servers this run started.**
- **Unconfigured auth gate** → capture the public routes, flag the gated ones in
  the gallery; never silently drop them.
- **Storybook detected** → say it's out of scope for v1 and continue with the app
  routes.
