---
description: Answer a caller (anyone not ACE's owner or an admin) inside a confined session — started by canopy, not by hand
argument-hint: --thread <id> --caller <path>
---

# /ace:ask

Read `skills/answer-caller/SKILL.md` and follow it, passing **$ARGUMENTS** through unchanged; the
arguments (`--thread`, `--caller`) are documented there. canopy starts this for a caller's email
turn once ACE's access list on canopy-web gives them read mode; the session is a read-mode session,
confined by canopy's `profile_guard` hook.
