#!/usr/bin/env bash
# Fail if any tracked file carries an unresolved merge-conflict marker.
#
# ## Why this is a shell script and not only a vitest test
#
# `test/lib/no-conflict-markers.test.ts` does the same job, and it is the one
# with the reasoning in it. But it runs INSIDE the suite, and the second of the
# two 2026-08-26 incidents was markers committed into `package.json` — which
# broke vitest itself: the suite exited 1 with no summary line, which reads like
# noise rather than a failure and cost two more commands before it was chased.
#
# A guard that cannot run when the thing it guards against has happened is only
# half a guard. This runs in CI BEFORE `npm ci`, needs nothing but git and grep,
# and prints the offending lines. Both remain: the test is the enforcement
# inside the suite, this is the enforcement that survives the suite.
#
# `npm ci` would separately fail on markers in package.json — but not on markers
# in `vitest.config.ts`, `tsconfig.json`, or any Markdown file, and Markdown is
# where they are most likely: CHANGELOG.md conflicts on essentially every
# concurrent PR in this repo. #1714 merged with markers in it and nothing
# noticed.
#
# Usage: scripts/check-conflict-markers.sh   (exit 0 clean, 1 with offenders)
set -uo pipefail

cd "$(git rev-parse --show-toplevel)" || exit 2

# Canonical git markers, anchored to line start, so prose ABOUT conflict markers
# — this file, the shipping skill, the test's header — is not flagged.
PATTERN='^(<<<<<<< |>>>>>>> |\|\|\|\|\|\|\| )'

# -I skips binary files. -z/-Z pairs NUL-delimited paths through xargs so a
# filename with a space cannot split into two arguments.
COUNT=$(git ls-files | wc -l | tr -d ' ')
if [ "$COUNT" -lt 100 ]; then
  echo "check-conflict-markers: git ls-files returned $COUNT files — scanner is broken, not the repo" >&2
  exit 2
fi

OFFENDERS=$(git ls-files -z | xargs -0 grep -InIE "$PATTERN" 2>/dev/null || true)

if [ -n "$OFFENDERS" ]; then
  echo "Unresolved merge-conflict markers in tracked files:" >&2
  printf '%s\n' "$OFFENDERS" >&2
  echo "" >&2
  echo "A rebase or merge was committed without resolving every conflicted file." >&2
  echo "Check ALL of them, not just the one you hand-edited (skills/shipping § Step 2)." >&2
  exit 1
fi

echo "check-conflict-markers: $COUNT tracked files, no markers."
