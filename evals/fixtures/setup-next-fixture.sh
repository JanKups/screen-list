#!/usr/bin/env bash
#
# setup-next-fixture.sh — regenerate the `next-fixture` eval fixture (PLAN.md §10).
#
# WHY THIS EXISTS
#   `workspace/` is gitignored (PLAN.md §1), so the fixture app itself is never
#   committed. This script + the committed overlay under
#   `evals/fixtures/next-fixture-overlay/` are the reproducible source: running
#   this from a clean checkout regenerates `workspace/next-fixture/` identically.
#
# WHAT IT BUILDS
#   A Next.js App Router app (create-next-app, pinned) plus fixture routes that
#   bait screenshot-review-web's route discovery (PLAN.md §6.2):
#     /                      — home with nav links
#     /posts/[id]            — dynamic route (visibly different content per id)
#     /about                 — lives in the (marketing) route group; the group
#                              segment is stripped from the URL
#     /login                 — fake login form (server action sets a cookie)
#     /dashboard             — cookie-gated; middleware redirects to /login when
#                              unauthenticated
#     /api/health            — API route handler (exclusion bait: JSON, no page)
#     /auth/callback         — auth-callback route (exclusion bait: immediate
#                              redirect, no page)
#
# FIXTURE CREDENTIALS (invented test data — defined in app/login/page.tsx)
#     email:    reviewer@example.com
#     password: fixture-pass-1
#   Later issues (auth capture, evals E2) reference these.
#
# USAGE
#   evals/fixtures/setup-next-fixture.sh
#   cd workspace/next-fixture && npm run dev      # serves on :3000 (or next free port)
#
set -euo pipefail

# create-next-app is pinned so regeneration is deterministic across machines.
CNA_VERSION="16.2.10"

# Resolve repo root from this script's location (script lives at evals/fixtures/).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OVERLAY_DIR="$SCRIPT_DIR/next-fixture-overlay"
FIXTURE_DIR="$REPO_ROOT/workspace/next-fixture"

command -v node >/dev/null 2>&1 || { echo "error: node is required" >&2; exit 1; }
command -v npx  >/dev/null 2>&1 || { echo "error: npx is required" >&2; exit 1; }
[ -d "$OVERLAY_DIR" ] || { echo "error: overlay not found at $OVERLAY_DIR" >&2; exit 1; }

echo "==> Regenerating fixture at $FIXTURE_DIR"
rm -rf "$FIXTURE_DIR"
mkdir -p "$REPO_ROOT/workspace"

# Scaffold the base app. Every option is passed explicitly (no saved
# preferences, no prompts) so the base is identical on any machine.
npx --yes "create-next-app@${CNA_VERSION}" "$FIXTURE_DIR" \
  --ts --app --eslint --no-tailwind --no-src-dir \
  --no-react-compiler --no-rspack \
  --import-alias "@/*" --use-npm --disable-git --empty </dev/null

# Overlay the fixture routes on top of the scaffold.
echo "==> Applying fixture overlay"
cp -R "$OVERLAY_DIR/." "$FIXTURE_DIR/"

cat <<EOF

==> Done. Fixture ready at:
      $FIXTURE_DIR

    Start it:
      cd "$FIXTURE_DIR" && npm run dev

    Fixture credentials (for /login):
      email:    reviewer@example.com
      password: fixture-pass-1
EOF
