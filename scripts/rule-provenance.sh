#!/usr/bin/env bash
# Determine whether a rule was introduced by a HUMAN or by an AI iteration.
#
#   scripts/rule-provenance.sh "<distinctive phrase from the rule>" [path...]
#
# Why this exists: roughly half of ACE's commits are AI-authored, and every
# commit carries the operator's git identity — so `git log --author` cannot
# tell the two apart. The `Co-Authored-By: Claude` trailer can.
#
# A human ruling is honored diligently; an AI-iteration rule is revisable when
# it causes harm. See `skills/idea-to-pdd/SKILL.md § Rule provenance`.
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "usage: $0 \"<phrase>\" [path...]" >&2
  exit 2
fi

phrase="$1"; shift
paths=("$@")

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

# `git log -S` is newest-first; the LAST entry is the commit that introduced it.
if [ ${#paths[@]} -gt 0 ]; then
  commits="$(git log --no-merges --format=%H -S "$phrase" -- "${paths[@]}" || true)"
else
  commits="$(git log --no-merges --format=%H -S "$phrase" || true)"
fi

if [ -z "$commits" ]; then
  echo "provenance: UNKNOWN"
  echo "  no commit introduces that phrase — check the wording, or the rule may be uncommitted"
  exit 1
fi

introduced="$(printf '%s\n' "$commits" | tail -1)"
latest="$(printf '%s\n' "$commits" | head -1)"
n="$(printf '%s\n' "$commits" | wc -l | tr -d ' ')"

body="$(git log -1 --format=%B "$introduced")"
subject="$(git log -1 --format=%s "$introduced")"
date="$(git log -1 --format=%ad --date=short "$introduced")"
author="$(git log -1 --format=%an "$introduced")"

# Human-ruling citation pattern, as this repo actually records them:
#   "Operator ruling (Jon, 2026-08-13)", "(Jon, 2026-07-01)", "standing operator directive"
HUMAN_RE='operator ruling|standing (operator )?directive|per (jon|jonathan)\b|\((jon|jonathan|sophie|neal|amie)[,)]|decided by (jon|jonathan)'

# Order matters. A commit trailer tells you who TYPED the rule, not whose
# DECISION it was — an AI transcribing an operator ruling carries the Claude
# trailer while the rule is genuinely human. So the strongest signal is an
# explicit human citation in the RULE TEXT itself; fall back to the trailer,
# which is a reliable POSITIVE signal for AI authorship only. Its ABSENCE
# proves nothing (measured 2026-08-14: 45 of the last 300 non-merge commits
# carry no trailer, and sampled ones are plainly AI-written), so a missing
# trailer yields `unmarked`, never `human`.
cited_human=""
if [ ${#paths[@]} -gt 0 ]; then
  for f in "${paths[@]}"; do
    [ -f "$f" ] || continue
    if grep -n -F -- "$phrase" "$f" >/dev/null 2>&1; then
      ln="$(grep -n -F -- "$phrase" "$f" | head -1 | cut -d: -f1)"
      lo=$(( ln > 6 ? ln - 6 : 1 ))
      if sed -n "${lo},$(( ln + 3 ))p" "$f" | grep -qiE "$HUMAN_RE"; then
        cited_human="$f:$ln"
      fi
    fi
  done
fi

if [ -n "$cited_human" ]; then
  verdict="human"
  tag="[human: cited in text, $date]"
  guidance="Honor diligently. Do not reinterpret, narrow, or drop it to make a build pass. If it conflicts with something else, surface the conflict rather than picking a side. (Human ruling cited at $cited_human — this outranks the commit trailer, which only records who typed it.)"
elif printf '%s' "$body" | grep -qi '^co-authored-by:.*claude'; then
  verdict="ai-iteration"
  tag="[ai-iteration: $date]"
  guidance="Revisable. Presumed useful, not sacred — if it is causing harm or was written for a problem that has since changed shape, change it in the open and cite the evidence. A source-stated program decision outranks it."
else
  verdict="unmarked"
  tag="[ai-iteration: $date]   # provisional — no positive human evidence"
  guidance="Provenance NOT established. Treat as ai-iteration (the standing default) — do NOT treat it as a human ruling. Absence of a Claude trailer is not evidence of human authorship: many AI commits carry no trailer. If you believe this is a human ruling, confirm with the operator and tag it [human: ...] so the next reader does not have to ask again."
fi

echo "provenance: $verdict"
echo "  introduced: $introduced  $date  ($author)"
echo "  subject:    $subject"
echo "  suggested tag: $tag"
if [ "$n" -gt 1 ]; then
  echo "  note: phrase touched by $n commits; most recent is $latest"
fi
echo "  guidance:   $guidance"
