# Eval harness (E1–E5)

Scripted, reproducible evals for the `screenshot-review-web` skill (PLAN.md §10,
issue #9). Every pass/fail verdict comes from a **node grader** — no human
judgment, no LLM in the pass/fail path.

## Run it

```bash
node evals/run.mjs            # all scenarios
node evals/run.mjs E1 E4      # a subset
```

Each run:

1. **Ensures the fixture** app exists under `workspace/` (regenerating it from the
   committed setup script when missing — `evals/fixtures/setup-*-fixture.sh`).
   `workspace/` is gitignored and throwaway.
2. **Starts the fixture dev server once** and lets every capture reuse it.
3. **Produces real artifacts**: scaffolds a `screenshots/` folder from
   `skill/assets/`, writes the reference config, and runs the real `capture.mjs`
   (real Playwright, real PNGs, real manifest, real gallery).
4. **Grades** with the scripted graders and prints per-check PASS/FAIL. Machine
   output lands in `evals/results/<id>.json` (gitignored).

Prerequisites: `node`, `npm`, `bash`, and the skill's one dependency
(`playwright`) — the harness runs `npm install` in each scaffold, or symlinks a
pre-installed `node_modules` when `SR_EVAL_NODE_MODULES` points at one (a speed
knob for local iteration; a clean run does the install).

## What the graders assert (`lib/graders.mjs`)

- **File-tree** — the scaffold copied every asset (incl. `gitignore` → `.gitignore`).
- **Config-schema validation** — `capture.mjs --dry-run` loads, validates, and
  builds the matrix with no browser; exit 0 means the authored config is valid.
- **Route correctness** — the matrix contains the expected routes, resolves the
  dynamic route's sample value (no `__MISSING_`), and the config excludes the
  non-rendering bait (`/api/`, `*callback*`).
- **PNG existence + dimensions** — files exist and are exactly 1440-wide (desktop)
  / 390-wide (mobile), read straight from the PNG IHDR (`lib/png.mjs`).
- **Manifest status** — the right route is `ok` / `gated`, and partial-run merges
  keep every route.
- **Gallery** — `gallery.html` parses and still lists every route (gated ones are
  flagged, never dropped).
- **Git-check** — `git ls-files` proves no `*.png` and no `secrets.env` /
  `storageState.json` is tracked anywhere, and the shipped `.gitignore` ignores
  them.

## Automated vs. driven-session

The skill's **Setup/Capture choreography is conversational** (the batched
dynamic-sample-value + exclusions question, the auth probe, the drift *offer*,
resolving "re-shoot just /posts" to a CLI flag). An LLM in the grader would make
the harness non-deterministic, so the harness instead:

- **Automates the deterministic OUTPUT** a correct session produces — the authored
  config (committed under `reference-configs/`) + the real capture — and grades
  those artifacts. This is what runs green here.
- **Documents the conversational gap** per scenario (printed as `driven-session:`
  by the runner, and in each scenario file). Those steps are what a real
  with-skill agent session verifies on top of this harness; the no-skill baseline
  observation for each is recorded in the issue-#9 PR description.

`reference-configs/*.jsonc` therefore stand in for "the config a skill-following
agent authors" for each fixture/branch. They exercise the real JSONC stripper
(comments + trailing commas) and the real validator.

## Layout

```
evals/
  run.mjs                 orchestrator (ensures fixtures, servers, grades)
  lib/                    reusable graders + driver + PNG/proc/server helpers
  scenarios/E1..E5.mjs    one file per scenario (arrange + grade)
  reference-configs/      the config each scenario authors (skill-output stand-in)
  fixtures/               committed setup scripts + overlays (fixture source)
  results/                per-run JSON verdicts (gitignored)
```
