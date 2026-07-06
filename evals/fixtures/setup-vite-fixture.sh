#!/usr/bin/env bash
#
# setup-vite-fixture.sh — regenerate the `vite-fixture` eval fixture (PLAN.md §10).
#
# WHY THIS EXISTS
#   `workspace/` is gitignored (PLAN.md §1), so the fixture app itself is never
#   committed. This script + the committed overlay under
#   `evals/fixtures/vite-fixture-overlay/` are the reproducible source: running
#   this from a clean checkout regenerates `workspace/vite-fixture/` identically.
#
# WHAT IT BUILDS
#   A Vite + react-router SPA whose routes are defined IN CODE
#   (`createBrowserRouter`, src/router.tsx) — no filesystem router. This is the
#   PLAN.md §6.2 "Vite SPA, no fs-router" case: route discovery must either
#   best-effort grep the `path:` strings out of the source, or fall back to
#   asking the user (the fully supported manual path). Routes:
#     /               — home with nav links
#     /about          — static route
#     /products       — list route, links into the dynamic detail
#     /products/:id   — dynamic route (visibly different content per :id)
#     /settings       — static route
#   No auth gate.
#
# USAGE
#   evals/fixtures/setup-vite-fixture.sh
#   cd workspace/vite-fixture && npm run dev -- --port 5273   # serves the SPA
#
set -euo pipefail

# create-vite is pinned so regeneration is deterministic across machines.
CREATE_VITE_VERSION="9.1.1"
# react-router is not part of the create-vite template; pin it explicitly.
REACT_ROUTER_VERSION="7.18.1"

# Resolve repo root from this script's location (script lives at evals/fixtures/).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OVERLAY_DIR="$SCRIPT_DIR/vite-fixture-overlay"
FIXTURE_DIR="$REPO_ROOT/workspace/vite-fixture"

command -v node >/dev/null 2>&1 || { echo "error: node is required" >&2; exit 1; }
command -v npx  >/dev/null 2>&1 || { echo "error: npx is required" >&2; exit 1; }
[ -d "$OVERLAY_DIR" ] || { echo "error: overlay not found at $OVERLAY_DIR" >&2; exit 1; }

echo "==> Regenerating fixture at $FIXTURE_DIR"
rm -rf "$FIXTURE_DIR"
mkdir -p "$REPO_ROOT/workspace"

# Scaffold the base Vite app (react-ts template, pinned) so the base is
# identical on any machine. create-vite resolves its target relative to the cwd,
# so run it from workspace/ with a plain project name. It does NOT install deps —
# we do that below.
( cd "$REPO_ROOT/workspace" \
  && npx --yes "create-vite@${CREATE_VITE_VERSION}" vite-fixture --template react-ts </dev/null )

# Overlay the code-defined router + route components on top of the scaffold.
echo "==> Applying fixture overlay"
cp -R "$OVERLAY_DIR/." "$FIXTURE_DIR/"

# The default template's App.tsx/App.css are no longer imported (main.tsx now
# mounts the router). Drop them so the fixture has a single, obvious entry path.
rm -f "$FIXTURE_DIR/src/App.tsx" "$FIXTURE_DIR/src/App.css"

# Add react-router as a pinned dependency, then install. `npm pkg set` edits
# package.json deterministically (no fragile in-place JSON munging).
echo "==> Installing dependencies (this pulls Vite, React, react-router)"
( cd "$FIXTURE_DIR" \
  && npm pkg set "dependencies.react-router-dom=${REACT_ROUTER_VERSION}" \
  && npm install )

cat <<EOF

==> Done. Fixture ready at:
      $FIXTURE_DIR

    Start it (default eval port 5273):
      cd "$FIXTURE_DIR" && npm run dev -- --port 5273

    Routes are defined in code at src/router.tsx (no filesystem router) — this is
    the PLAN.md §6.2 no-fs-router discovery case.
EOF
