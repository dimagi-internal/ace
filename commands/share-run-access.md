---
description: Grant a set of people (e.g. everyone on a project thread) the access they need to review an ACE run — ace-web workbench, labs dashboards, Connect opportunity, HQ apps, OCS. Approval-gated per invite.
argument-hint: "<opp-slug> <run-id> <email1,email2,...> [--surfaces ace-web,connect,hq,ocs] [--workspace dimagi-team]"
allowed-tools: [Bash, Read, AskUserQuestion, Skill, mcp__plugin_ace_ace-gdrive__resolve_opp_path, mcp__plugin_ace_ace-gdrive__drive_read_file, mcp__plugin_ace_ace-connect__connect_add_org_member, mcp__plugin_ace_ace-gdrive__drive_set_anyone_with_link]
---

# /ace:share-run-access — let a thread review a run

Give the people on a project thread the access they need to review an ACE run, across every
surface the run-summary links (ace-web workbench, labs dashboards, the Connect opportunity, the
CommCare HQ apps, the OCS chatbot). The public summary + all ACE-authored deliverable docs are
already anyone-with-link; this grants the platform-gated surfaces. Repeatable, idempotent, and
approval-gated on every outbound invite.

## Arguments

- **`<opp-slug> <run-id>`** (required) — the run to share (resolves org/domain/team identifiers).
- **`<emails>`** (required) — comma-separated. Default source: the full To+Cc of the project thread.
- **`--surfaces`** (optional) — subset to grant; default all gated surfaces the run has products for.
- **`--workspace`** (optional) — ace-web workspace slug; default `dimagi-team`.

## Process

Invoke the `share-run-access` skill with the parsed arguments and follow it exactly. Key rules it
enforces:

- **Public docs first** — confirm every deliverable link is `OK 200` (run `run-summary-qa`) before sharing.
- **Per-person isolation** — one person, one decision; classify internal (@dimagi.com auto-joins
  ace-web on sign-in) vs. external collaborator (explicit invite).
- **Least privilege** — default role `viewer`/`member`.
- **Account precondition** — every gated surface needs the person to have a Connect/CommCare account
  and sign in once; ACE grants membership, never provisions accounts.
- **Approval-gated** — every outbound invite is presented for a human yes before firing.
