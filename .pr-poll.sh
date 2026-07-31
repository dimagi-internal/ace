#!/bin/bash
# Temporary poll helper for PR 1125 (deleted before commit; branch already pushed).
PR=1125
while true; do
  S=$(gh pr view "$PR" --json state -q .state 2>/dev/null || echo ERR)
  M=$(gh pr view "$PR" --json mergeStateStatus -q .mergeStateStatus 2>/dev/null || echo ERR)
  F=$(gh pr view "$PR" --json statusCheckRollup -q '[.statusCheckRollup[]|select(.conclusion=="FAILURE")]|length' 2>/dev/null || echo 0)
  if [ "$S" = "MERGED" ]; then echo "TERMINAL MERGED"; exit 0; fi
  if [ "$M" = "DIRTY" ]; then echo "TERMINAL DIRTY needs-rebase"; exit 0; fi
  if [ -n "$F" ] && [ "$F" != "0" ]; then echo "TERMINAL CHECK_FAILURE count=$F"; exit 0; fi
  sleep 30
done
