---
description: Answer a caller (anyone not ACE's owner or an admin) inside a confined session — started by canopy, not by hand
---

# /ace:ask

Read `skills/answer-caller/SKILL.md` and follow it. canopy starts this for a caller's email turn
once ACE's declared interface on canopy-web offers `ask` to them (edit it on ACE's
Overview page, or `canopy agent interface get|set --slug ace`); the session is confined to the `ask`
capability by canopy's `profile_guard` hook.

## Arguments

**$ARGUMENTS**
- `--thread <id>` → the caller's email thread (the only one readable here).
- `--caller <path>` → canopy's caller envelope for this turn.
