---
description: Run an ACE turn — preflight, drain the canopy-web board (iff configured), triage the ace@ inbox one thread at a time, close out
---

# /ace:turn

Process ACE's inbound surfaces: email to `ace@dimagi-ai.com` and, when configured, the canopy-web
task board. The counterpart-facing sibling of `/ace:run` — replies, approvals, and requests flow back
into runs without a human relaying them.

## Process

Read `skills/turn/SKILL.md` and follow it in order (this runs at level 0, inline — it may dispatch
phase skills for act-tier instructions). Turns run in review posture: every outbound reply is
presented for the human's yes before sending (procedural, not a hook prompt); unknown senders are
read-only; sends flow only through `bin/ace-email` (deny rail).

## Arguments

None. The turn always reconciles both surfaces; a missing surface (board not configured, gog auth
down) is reported in the close-out, never a hard abort.
