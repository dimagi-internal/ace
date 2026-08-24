#!/bin/bash
# Bounded merge wait for PR #1596 (ace#1560). Backgrounded per skills/shipping.
for i in $(seq 1 40); do
  s=$(gh pr view 1596 --json state --jq .state 2>/dev/null)
  case "$s" in MERGED|CLOSED) break;; esac
  sleep 15
done
gh pr view 1596 --json number,state,mergedAt,mergeStateStatus \
  --jq '"PR #\(.number) state=\(.state) mergedAt=\(.mergedAt // "null") mergeState=\(.mergeStateStatus)"'
gh pr checks 1596 2>&1 | tail -5
