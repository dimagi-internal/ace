---
description: Release a run to outside reviewers — audit its public summary, forward an already-shared link to it, then invite each reviewer to the run's own HQ space, Connect org and ace-web workspace (last). Approval-gated. Run after /ace:clone-to-new-workspace.
argument-hint: "<workspace>/<opp>/<run-id> (--reviewers <email[:role]>,... | --from-thread <gmail-thread-id>) [--forward-source] [--allow-shared connect] | --revoke-shared"
allowed-tools: [Bash, Read, AskUserQuestion, Skill, mcp__plugin_ace_ace-gdrive__resolve_opp_path, mcp__plugin_ace_ace-gdrive__drive_read_file, mcp__plugin_ace_ace-gdrive__update_yaml_file, mcp__plugin_ace_ace-connect__commcare_get_subscription, mcp__plugin_ace_ace-connect__commcare_invite_web_user, mcp__plugin_ace_ace-connect__commcare_list_users, mcp__plugin_ace_ace-connect__connect_add_org_member, mcp__plugin_ace_ace-connect__connect_remove_org_member, mcp__plugin_ace_ace-connect__connect_list_invites]
---

# /ace:release — let outside reviewers in, last

Make a run ready for outside reviewers and then invite them: audit → polish →
forward an already-shared link → invites (HQ, Connect, then the ace-web
workspace last) → record. Outside reviewers are only ever granted systems whose
assets the clone rebuilt into the run's own area; OCS is always the public chat
link, never an account.

## Arguments

- **`<workspace>/<opp>/<run-id>`** (required) — the run, normally a clone.
- **`--reviewers`** — comma-separated emails, each optionally
  `:viewer` / `:editor` (default viewer). Or **`--from-thread <id>`**: take the
  reviewers from the ace@ thread that asked for the review (its non-Dimagi
  participants). One of the two is required.
- **`--forward-source`** (optional) — the source run's summary link was already
  sent; make it land on this run.
- **`--allow-shared connect`** (optional, interim) — invite outside reviewers
  into the shared Connect PM + NM orgs until per-partner orgs exist; each
  grant is recorded for later revocation.
- **`--revoke-shared`** — instead of releasing: remove every grant recorded in
  the run's `released.shared_grants` (once per-partner Connect orgs exist).

## Process

Nothing is invited unless the run's latest `/ace:release-check` is READY and newer than every write to the run (Step 0.5 of the skill).

Read `skills/release-run/SKILL.md` (it is operator-only — not dispatchable as a
Skill) and follow it exactly with the parsed arguments. Every invite is shown
for approval before any is sent.
