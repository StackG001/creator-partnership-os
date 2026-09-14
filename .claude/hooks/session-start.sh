#!/bin/bash
# SessionStart hook — make a fresh Claude Code on the web container able to run
# `npm run doctor`, the module CLIs and the tests without any manual setup.
#
# A cloud session gets a clean clone: no node_modules, no generated Prisma
# client, no SQLite file, and Playwright's own Chromium is absent (the image
# ships its own build under /opt/pw-browsers). Each step below fixes one of
# those. Everything is idempotent and non-interactive.
set -euo pipefail

# Local machines already have a real setup; don't touch them.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}"

echo "[session-start] installing dependencies"
npm install --no-audit --no-fund

# The doctor and every module require DATABASE_URL. A cloud session has no .env,
# so default it to the same local SQLite file the README uses. An explicit value
# from the environment settings always wins.
if [ -z "${DATABASE_URL:-}" ]; then
  export DATABASE_URL="file:./dev.db"
  if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
    echo 'export DATABASE_URL="file:./dev.db"' >> "$CLAUDE_ENV_FILE"
  fi
  echo "[session-start] DATABASE_URL defaulted to file:./dev.db"
fi

echo "[session-start] generating Prisma client and applying schema"
npx prisma generate >/dev/null
# db push is idempotent: it no-ops when the SQLite file already matches.
npx prisma db push --skip-generate --accept-data-loss >/dev/null

# Playwright's pinned Chromium build is not in the image, but a working
# Chromium is. Point the PDF renderer at it instead of downloading ~150MB.
for candidate in \
  "${PLAYWRIGHT_CHROMIUM_PATH:-}" \
  /opt/pw-browsers/chromium \
  /usr/bin/chromium \
  /usr/bin/chromium-browser \
  /usr/bin/google-chrome; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    export PLAYWRIGHT_CHROMIUM_PATH="$candidate"
    if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
      echo "export PLAYWRIGHT_CHROMIUM_PATH=\"$candidate\"" >> "$CLAUDE_ENV_FILE"
    fi
    echo "[session-start] Chromium: $candidate"
    break
  fi
done

# Prove the session can actually run the checks, rather than only claiming to.
echo "[session-start] verifying the toolchain"
npm run typecheck
npm test

echo "[session-start] ready — run \`npm run doctor\` for the full report"
