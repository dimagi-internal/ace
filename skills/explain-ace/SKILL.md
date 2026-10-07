---
name: explain-ace
description: Explain how to work with ACE and what keeps it safe — the interaction and security model — answered from the live system, never from a stored doc. Use when someone is new to ACE, or asks how to reach it, who reviews its replies, who sees what, what data it can reach, whether it can do several things at once, or how it differs from using Claude Code directly.
---

# Explain ACE — answered from the live system

People only use ACE comfortably once they understand how they interact with it and what keeps
it safe (Jon, 2026-10-07). Those answers change week to week — routing, interfaces, turn modes,
Slack behaviour are all live configuration and fast-moving code — so **never answer from a
stored write-up, this file, or memory.** Read the current sources below, then answer.

## 1. Always share Canopy's own explainer

Canopy is the system ACE runs on, and it maintains its own explainer pages. Put both in the
reply, first time and whenever the question is about how the system works:

- **What Canopy is** (public, no login): https://labs.connect.dimagi.com/canopy/about
- **Canopy guide** (what every page in Canopy is for): https://labs.connect.dimagi.com/canopy/guide

Do not write or link an ACE-specific explainer doc as the answer. A dated snapshot is fine as
*reference* for one analysis (filed under an ACE project on canopy-web), never as the source.

## 2. Read the current state before answering

Read only what the question needs, and say in the answer what you read and when.

| Question | Read |
|---|---|
| Who may make ACE do what; what outsiders can do | `get_interface` (slug `ace`) and canopy-web `docs/architecture/access.md` (the decision table, agent roles) |
| Does a person have to approve replies; who can | `get_agent` (`turn_mode`, `owner`, `workspace`) + access.md rows on turn mode |
| Whose runner / which mode a person's or channel's work goes to | `list_agent_actor_routes`, `list_agent_runner_rules` (slug `ace`) |
| How Slack works (threads, DMs, `--history`, Stop, status lines) | canopy-web `apps/slack/services.py`, `views.py`, `window.py`, `status.py` |
| What Labs data a viewer or ACE sees | connect-labs `CLAUDE.md § Permission Model`, `connect_labs/labs/models.py` (`UserConnectToken`) |
| ACE's own rails (send path, deny rails, tenancy guard and its current warn/enforce mode) | this repo's `CLAUDE.md § Agent operating model`, `config/gating.json`, `config/tenancy-targets.json` |

Read canopy-web and connect-labs at **current `origin/main`** — a local checkout may be days
stale (`git fetch` first), or use `gh api repos/dimagi-internal/<repo>/contents/<path>`.

## 3. What a good answer covers

**Interaction model:** the channels (email to `ace@dimagi-ai.com`, Slack `@canopy ace` in a
thread or a DM, canopy chat, the Connect Labs agent panel); that Slack and canopy chat show the
whole session live while email returns only the output (Jon, 2026-10-07 — some people prefer
one, some the other); one thread per task, and separate threads run in parallel; approvals and
who gives them; that routing a person or channel to another runner moves who oversees it.

**Security model:** who counts as whom and that a From: line proves nothing; that outsiders get
a confined session; manual mode; the rails enforced in code; and data. On data, the owner's
statement (2026-10-07) is the frame: **ACE is not given access to real program data, so it is
fine for people to watch what it does** — Labs reports read Connect as each viewer, and the
Labs agent panel acts as the visitor. Do not present Slack as risky for data exposure (that
answer was wrong and Jon corrected it); the real risk worth naming is Canopy itself making a
mistake.

**Honest limits:** say what is early, unverified, or not live, as the sources show it today.

## 4. Who changes things

Turn mode, admins, routing and the interface are set by ACE's owner or an admin on canopy-web,
never by ACE. Say so, and route the request to the owner rather than promising it.
