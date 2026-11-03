---
description: Run an ACE turn — preflight, drain the canopy-web board (iff configured), triage the ace@ inbox one thread at a time, close out
---

# /ace:turn

Process ACE's inbound surfaces: email to `ace@dimagi-ai.com` and, when configured, the canopy-web
task board. The counterpart-facing sibling of `/ace:run` — replies, approvals, and requests flow back
into runs without a human relaying them.

## Process

Read `skills/turn/SKILL.md` and follow it in order (this runs at level 0, inline — it may dispatch
phase skills for act-tier instructions). A turn's posture is canopy-web's per-turn decision, the
caller envelope's `turn_mode.mode` (`auto` | `manual`): in `manual` the draft or plan is presented
for the human's yes before anything goes out; in `auto` ACE acts within the sender's tier without
waiting for a person. No envelope (or `who_is_asking` fails) means `manual`. Both modes keep the
same rails: unknown senders are read-only; sends flow only through `bin/ace-email` (deny rail);
nothing outside the sender's tier. See `skills/turn` § Turn mode.

## Arguments

Optional scope (from the runner / scheduler / a human): **$ARGUMENTS**
- `--thread <id>` → a specific email thread triggered this turn; make it the focus of inbound
  processing (still close out both surfaces).
- `--caller <path>` → canopy's caller envelope for this turn (who asked, whether THIS message is
  verified, the workspace's profile of them). Resolve the sender's tier from it with
  `canopy caller tier --caller <path> --repo .` — see `skills/inbox-triage` § Counterpart tiers.
- `--slack <ref>` → a specific Slack message is the trigger; focus there.
- (none) → reconcile both surfaces (board + `ace@` inbox), the default.

A missing surface (board not configured, gog auth down) is reported in the close-out, never a hard
abort.
