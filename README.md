# screen-list

A Claude Code skill that screenshots every page of your web app and turns them into a gallery you can comment on, then hands your comments back to the agent as a to-do list.

Built by [Jan Kuppens](https://kups.nl) · [Kups](https://kups.nl), an AI-first product studio.

**ELI5:** Your AI builds your website, but it can't *see* what it made. This tool takes a picture of every page, even the ones behind a login, and puts them all in one photo album. You flip through, write "this button is too small" under a photo, and hand your notes back to the AI to fix. Much better than clicking through the whole site yourself after every change.

## The problem

Agents are great at writing UI code and terrible at noticing it looks off. You only catch visual problems by actually looking at the app: every route, both breakpoints, logged in and logged out. So you click through screens, screenshot the broken ones, drop them in a chat, and describe what's wrong. Then you do it all again after the next round of changes.

That reviewing is tedious enough that it gets skipped, and small visual regressions pile up quietly behind green tests.

## What this skill does

You say:

> screenshot my app so I can review all the pages

The skill:

1. Detects your project's shape, whether that's a single app or a monorepo full of them. It finds the dev servers, the framework, and the routes (Next.js App and Pages Router, Remix / React Router, SvelteKit, Astro, Vite).
2. Proposes a route list and asks before assuming anything. Dynamic routes like `/posts/[id]` get sample values from you, in one batched question. Routes that don't render anything (API handlers, auth callbacks) are left out.
3. Handles auth. Scripted form login, a one-time headed login for OAuth or magic links (saved as a Playwright session), or header/cookie/query injection. Secrets stay in a gitignored folder and never end up in the config. Routes it can't reach are flagged in the gallery instead of quietly skipped.
4. Captures full-page screenshots of every route at desktop (1440) and mobile (390) widths, plus any named interaction states you script per route ("modal open", "form filled").
5. Generates `gallery.html`, a single self-contained review sheet: every screen next to a comment box, autosaving locally as you type. `Cmd+Enter` jumps to the next screen.
6. Exports `COMMENTS.md`: your feedback, keyed by route, ready to paste into your next agent session.

The export is the point. You look at the app once, write down what's wrong, and the agent gets the whole punch list in one go.

## Quickstart

```bash
git clone https://github.com/JanKups/screen-list.git
cp -r screen-list/skill ~/.claude/skills/screen-list
```

Then in Claude Code, in any web project:

> screenshot my app

The first run is Setup: detect the project, confirm the routes, configure auth, capture, build the gallery. It scaffolds a self-contained `screenshots/` folder in your repo.

Every run after that is Capture. The skill re-checks your routes against the config (it offers updates when routes were added or removed, and applies nothing without your OK) and re-shoots whatever you ask:

> re-shoot the admin part
> just the /dashboard subtree, mobile only

## What lands in your repo

```
screenshots/
├── screenshots.config.jsonc   # parts, servers, routes, auth setup; yours to edit
├── capture.mjs                # a plain Playwright script
├── generate.mjs               # builds gallery.html from the captures
├── gallery.html               # the review sheet
├── .screenshots-auth/         # sessions + secrets (gitignored)
└── admin/                     # PNGs per part (gitignored)
    ├── 01-home.desktop.png
    └── 01-home.mobile.png
```

The folder is standalone: `cd screenshots && npm install && node capture.mjs` works without the skill installed. It's plain Node and Playwright, installed locally to that folder, so your host `package.json` is never touched. The config is committed, which means teammates get the same capture setup for free.

## Design principles

- Discover, then confirm. Detection does the tedious work; you keep control through a config file you own.
- Auth is a first-class feature. Most of an app lives behind a login, and a screenshot tool that stops at the login wall doesn't tell you much.
- Nothing gets dropped silently. A route that couldn't be captured shows up in the gallery, flagged, with the exact command that fixes it.
- Plain scripts over infrastructure. Two readable `.mjs` files you can open, edit, and run yourself.

## What it doesn't do (v1)

Single-URL grabs, component and Storybook shots, native app captures (iOS/Android/Expo), visual-diff regression testing, CI. It's a review tool for a human looking at their own app.

## How it's tested

The skill ships with its own eval harness: five scenarios against real fixture apps (Next.js App Router and Vite + React Router), graded by scripts. 122 assertions cover scaffolding, auth-gated capture, config drift, partial re-shoots, and route discovery. `node evals/run.mjs` runs them all.

---

## About

I'm [Jan Kuppens](https://kups.nl). I run [Kups](https://kups.nl), an AI-first studio for digital product design and development: prototypes, MVPs, web apps, and AI tools, from first idea to launch. This skill came out of my own review loop. I dictate comments into the gallery and feed the export straight into the next agent session.

Questions or ideas: [kups.nl](https://kups.nl).

Licensed under [MIT](LICENSE).
