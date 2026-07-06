# screenshots/

Self-contained screenshot-review tooling for this project. It starts your dev
server(s), screenshots every route listed in `screenshots.config.jsonc` at each
viewport, and builds a single-file `gallery.html` you can leave comments in and
export as `COMMENTS.md`.

This folder is standalone: it runs without the skill that generated it.

## Re-run it

```sh
cd screenshots
npm install          # installs Playwright locally into this folder (first run only)
npx playwright install chromium   # one-time: download the Chromium browser
node capture.mjs     # capture everything, then regenerate gallery.html
```

Then open `gallery.html` in a browser. Useful variations:

```sh
node capture.mjs --part web           # only one part
node capture.mjs --route "/items/**"  # only matching routes
node capture.mjs --viewport mobile    # only one viewport
node capture.mjs --login web          # one-time headed login, saved as a session
node capture.mjs --dry-run            # print the capture matrix, launch nothing
node capture.mjs --help               # all flags
```

## Isolated install (pnpm / npm / yarn monorepos)

This folder installs Playwright with its own `package.json` and
`node_modules/`. Keep it out of your workspace: don't add `screenshots/` to
`pnpm-workspace.yaml` or the root `workspaces` array. Run `npm install` from
inside this folder so the install stays local. Your repo's root `package.json`
and lockfile are never touched.

## Auth and secrets

Login credentials are never stored in `screenshots.config.jsonc`; the config
holds only the env-var names. The actual values live in
`.screenshots-auth/secrets.env` (`KEY=value` lines), which is gitignored. Real
environment variables, if set, override that file. The `auth` block in
`screenshots.config.jsonc` documents each strategy inline, and
`node capture.mjs --login <part>` handles OAuth, magic-link, and SSO logins
with a one-time headed browser session.

## What's committed vs generated

Committed: `screenshots.config.jsonc`, `capture.mjs`, `generate.mjs`,
`package.json`, this README, `gallery.html`, and `capture-manifest.json`.

Gitignored (regenerated locally): the `**/*.png` screenshots, `node_modules/`,
`.screenshots-auth/` (secrets), and `.logs/`.

One caveat: because the PNGs are gitignored but `gallery.html` is committed, a
fresh clone shows the gallery layout with broken thumbnails until you run
`node capture.mjs` to regenerate the images locally. The gallery shows a hint
banner when more than half its images fail to load. This is expected. The
committed gallery preserves the review comments and structure, and you
regenerate the images locally.
