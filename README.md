# screenshot-review-web

A Claude Code skill that screenshots **every page of your web app** and turns them into a gallery you can comment on — then hands your comments back to the agent as a to-do list.

Built by [Jan Kuppens](https://kups.nl) · [Kups](https://kups.nl), an AI-first product studio.

## The problem

Agents are great at writing UI code and terrible at noticing it looks off. You only catch visual problems by actually looking at the app — every route, both breakpoints, logged in and logged out. So you click through screens, screenshot the broken ones, drop them in a chat, and describe what's wrong. Every. Single. Round.

That review loop is the bottleneck, so it doesn't happen — and small visual regressions pile up quietly behind green tests.

## What this skill does

You say:

> screenshot my app so I can review all the pages

The skill:

1. **Detects your project's shape** — single app, monorepo of apps, whatever. Finds the dev servers, the framework, the routes (Next.js App & Pages Router, Remix / React Router, SvelteKit, Astro, Vite).
2. **Proposes a route list, then asks — never assumes.** Dynamic routes (`/posts/[id]`) get sample values from you, in one batched question. Non-rendering routes (API handlers, auth callbacks) are excluded.
3. **Handles auth properly.** Scripted form login, one-time headed login for OAuth/magic-link (saved as a Playwright session), or header/cookie/query injection. Secrets stay in a gitignored folder, never in config. Routes it can't reach are *flagged in the gallery*, never silently dropped.
4. **Captures full-page screenshots** of every route at desktop (1440) and mobile (390) widths — plus optional named interaction states ("modal open", "form filled") you script per route.
5. **Generates `gallery.html`** — a single self-contained review sheet. Every screen next to a comment box. Autosaves locally as you type. `Cmd+Enter` jumps to the next screen.
6. **Exports `COMMENTS.md`** — your feedback, keyed by route, ready to paste into your next agent session: *"here's what to fix, screen by screen."*

That last step is the point. The gallery closes the loop between *you seeing the app* and *the agent fixing the app*.

## Quickstart

```bash
git clone https://github.com/JanKups/screenshot-review-web.git
cp -r screenshot-review-web/skill ~/.claude/skills/screenshot-review-web
```

Then in Claude Code, in any web project:

> screenshot my app

First run is **Setup**: detect → confirm routes → configure auth → capture → gallery. It scaffolds a self-contained `screenshots/` folder in your repo.

Every run after that is **Capture**: it re-checks your routes against the config (offering — never auto-applying — updates when routes were added or removed) and re-shoots whatever you ask:

> re-shoot the admin part
> just the /dashboard subtree, mobile only

## What lands in your repo

```
screenshots/
├── screenshots.config.jsonc   # the spine: parts, servers, routes, auth setup — yours to edit
├── capture.mjs                # plain Playwright script, no magic
├── generate.mjs               # builds gallery.html from the captures
├── gallery.html               # the review sheet
├── .screenshots-auth/         # sessions + secrets (gitignored)
└── admin/                     # PNGs per part (gitignored)
    ├── 01-home.desktop.png
    └── 01-home.mobile.png
```

The folder is **standalone**: `cd screenshots && npm install && node capture.mjs` works with no skill, no MCP server, no Claude — just Node and Playwright, installed locally to that folder. Your host `package.json` is never touched. The config is committed; teammates get the same capture setup for free.

## Design principles

- **Discover, then confirm — never assume.** Detection does the tedious work; you keep control through a config file you own.
- **Auth is first-class.** Most of your app lives behind a login. A screenshot tool that stops at the login wall is a demo, not a tool.
- **No silent drops.** A route that couldn't be captured shows up in the gallery, flagged, with the exact command that fixes it.
- **Plain scripts over infrastructure.** Two readable `.mjs` files you can open, edit, and run yourself.

## What it deliberately doesn't do (v1)

Single-URL grabs, component/Storybook shots, native app captures (iOS/Android/Expo), visual-diff regression testing, CI. It's a review tool for humans, not a snapshot test suite.

## Trust, but verify

The skill ships with its own eval harness: five scenarios against real fixture apps (Next.js App Router and Vite + React Router), graded by scripts — 122 assertions covering scaffolding, auth-gated capture, config drift, partial re-shoots, and route discovery. `node evals/run.mjs` runs them all.

---

## About

I'm [Jan Kuppens](https://kups.nl). I run **[Kups](https://kups.nl)**, an AI-first studio for digital product design and development — from first idea to launch: prototypes, MVPs, web apps, and AI tools. This skill came out of my own daily loop reviewing agent-built UIs; I dictate comments into the gallery and feed the export straight back into the next session.

Questions or ideas → [kups.nl](https://kups.nl).
