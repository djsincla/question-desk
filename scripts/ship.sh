#!/bin/sh
# Ship Question Desk: run the tests, push to Apps Script, cut a version, and
# point the live deployment at it. The /exec URL (and every printed QR) stays
# the same. Refuses to ship uncommitted work so every version maps to a commit.
#
#   scripts/ship.sh "what changed"
#
# If the change adds an OAuth scope, run setUp() in the editor after the push
# and before anyone uses the new version, or the web app stops authorizing.
set -eu
cd "$(dirname "$0")/.."

DESC="${1:?usage: scripts/ship.sh \"what changed\"}"

# Install-specific values live in .deploy.env (untracked). See .deploy.env.example.
[ -f .deploy.env ] && . ./.deploy.env
DEPLOYMENT_ID="${QD_DEPLOYMENT_ID:?Set QD_DEPLOYMENT_ID in .deploy.env (copy .deploy.env.example)}"
USER_ARGS=""
[ -n "${QD_CLASP_USER:-}" ] && USER_ARGS="--user $QD_CLASP_USER"

if [ ! -f .clasp.json ]; then
  echo "No .clasp.json. Copy .clasp.json.example and set your scriptId (or run clasp clone)." >&2
  exit 1
fi

if [ -n "$(git status --porcelain)" ] && [ "${QD_ALLOW_DIRTY:-}" != "1" ]; then
  echo "Uncommitted changes. Commit first (or QD_ALLOW_DIRTY=1 to ship anyway)." >&2
  exit 1
fi

APP_VERSION=$(sed -n "s/^  version: '\([0-9][0-9.]*\)',$/\1/p" Code.js)
[ -n "$APP_VERSION" ] || { echo "Could not read APP.version from Code.js." >&2; exit 1; }
if git rev-parse -q --verify "refs/tags/v$APP_VERSION" >/dev/null; then
  echo "v$APP_VERSION is already released. Bump APP.version in Code.js and add a CHANGELOG.md entry." >&2
  exit 1
fi
# GitHub Pages serves the guest page and the PowerPoint add-in from main: they must match.
if git remote get-url origin >/dev/null 2>&1 && [ "${QD_ALLOW_UNPUSHED:-}" != "1" ]; then
  git fetch -q origin main || { echo "Could not reach GitHub to check main is pushed." >&2; exit 1; }
  if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
    echo "This commit isn't on GitHub's main yet. Push first, so the guest page and add-in match this release." >&2
    exit 1
  fi
fi
NOTES=$(awk -v v="$APP_VERSION" '$0 ~ "^## \\[" v "\\]" {on=1; next} /^## \[/ {on=0} on' CHANGELOG.md)
[ -n "$NOTES" ] || { echo "CHANGELOG.md has no section for $APP_VERSION." >&2; exit 1; }
echo "Shipping Question Desk $APP_VERSION"

echo "==> Secret scan"
node scripts/check-secrets.js

echo "==> Tests"
node --test tests/*.test.js > "${TMPDIR:-/tmp}/qd-test-$$.log" 2>&1 || { cat "${TMPDIR:-/tmp}/qd-test-$$.log"; rm -f "${TMPDIR:-/tmp}/qd-test-$$.log"; echo "Tests failed; nothing shipped." >&2; exit 1; }
grep -E "^ℹ (tests|pass|fail)" "${TMPDIR:-/tmp}/qd-test-$$.log"; rm -f "${TMPDIR:-/tmp}/qd-test-$$.log"

echo "==> Browser tests (WebKit and Chromium)"
if [ ! -d node_modules/playwright ]; then
  echo "Browser tests need Playwright: npm install && npx playwright install webkit chromium" >&2
  exit 1
fi
npm run -s test:browsers > "${TMPDIR:-/tmp}/qd-browser-$$.log" 2>&1 || { grep -E "^✖|Assertion|Error" "${TMPDIR:-/tmp}/qd-browser-$$.log" | head -20; rm -f "${TMPDIR:-/tmp}/qd-browser-$$.log"; echo "Browser tests failed; nothing shipped." >&2; exit 1; }
grep -E "^ℹ (tests|pass|fail)" "${TMPDIR:-/tmp}/qd-browser-$$.log"; rm -f "${TMPDIR:-/tmp}/qd-browser-$$.log"

PREVIOUS=$(clasp list-deployments $USER_ARGS 2>/dev/null | sed -n "s/^- $DEPLOYMENT_ID @\([0-9][0-9]*\).*/\1/p")

echo "==> Push"
clasp push --force $USER_ARGS

echo "==> Version"
CREATED=$(clasp create-version "$APP_VERSION: $DESC" $USER_ARGS 2>&1) || true
VERSION=$(printf '%s\n' "$CREATED" | sed -n 's/^Created version \([0-9][0-9]*\).*/\1/p')
[ -n "$VERSION" ] || { printf '%s\n' "$CREATED" >&2; echo "Could not create an Apps Script version (clasp output above)." >&2; exit 1; }
echo "Created version $VERSION"

echo "==> Deploy"
clasp update-deployment "$DEPLOYMENT_ID" -V "$VERSION" -d "Question Desk" $USER_ARGS

echo "==> Live check"
if ! QD_DEPLOYMENT_ID="$DEPLOYMENT_ID" QD_DOMAIN="${QD_DOMAIN:-}" QD_GUEST_PAGE="${QD_GUEST_PAGE:-}" node scripts/smoke-live.js; then
  echo "The live app did not answer correctly after deploying version $VERSION." >&2
  [ -n "$PREVIOUS" ] && echo "Roll back with: clasp update-deployment $DEPLOYMENT_ID -V $PREVIOUS -d \"Question Desk\" $USER_ARGS" >&2
  exit 1
fi

git tag -a "v$APP_VERSION" -m "Question Desk $APP_VERSION (Apps Script version $VERSION): $DESC"
echo "Tagged v$APP_VERSION"

if git remote get-url origin >/dev/null 2>&1; then
  if ! git push origin "v$APP_VERSION"; then
    # Otherwise a re-run refuses ("already released") and the GitHub release never gets made.
    git tag -d "v$APP_VERSION" >/dev/null
    echo "The app is live, but pushing the tag failed; removed the local tag. Re-run to tag and release." >&2
    exit 1
  fi
  if command -v gh >/dev/null 2>&1; then
    if gh release view "v$APP_VERSION" >/dev/null 2>&1; then
      echo "GitHub release v$APP_VERSION already exists."
    else
      printf '%s\n' "$NOTES" | gh release create "v$APP_VERSION" --title "Question Desk $APP_VERSION" --notes-file -
    fi
  fi
fi
