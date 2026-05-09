#!/usr/bin/env bash
# SessionStart hook for Claude Code on the web.
# Installs npm dependencies so vitest + `npx tsc --noEmit` (the CI linter) work.
#
# Skipped on local sessions — local dev uses /ace:setup + the existing
# hooks/hooks.json plugin update-check hook.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(pwd)}"

# `npm install` (not `npm ci`) so repeated runs on a cached container reuse
# node_modules. CI runs `npm ci` separately to enforce lockfile parity.
npm install --no-audit --no-fund --loglevel=error 1>&2
