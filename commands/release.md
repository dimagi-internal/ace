---
description: Release a run to outside reviewers — audit its public summary, forward an already-shared link to it, then invite each reviewer to the run's own HQ space, Connect org and ace-web workspace (last). Approval-gated. Run after /ace:clone-to-new-workspace.
argument-hint: "<workspace>/<opp>/<run-id> --reviewers <email[:role]>,... [--forward-source]"
allowed-tools: [Bash, Read, AskUserQuestion, Skill, mcp__plugin_ace_ace-gdrive__resolve_opp_path, mcp__plugin_ace_ace-gdrive__drive_read_file, mcp__plugin_ace_ace-gdrive__update_yaml_file, mcp__plugin_ace_ace-connect__commcare_invite_web_user, mcp__plugin_ace_ace-connect__commcare_list_users, mcp__plugin_ace_ace-connect__connect_add_org_member, mcp__plugin_ace_ace-connect__connect_list_invites]
---

# /ace:release — let outside reviewers in, last

Make a run ready for outside reviewers and then invite them: audit → polish →
forward an already-shared link → invites (HQ, Connect, then the ace-web
workspace last) → record. Outside reviewers are only ever granted systems whose
assets the clone rebuilt into the run's own area; OCS is always the public chat
link, never an account.

## Arguments

- **`<workspace>/<opp>/<run-id>`** (required) — the run, normally a clone.
- **`--reviewers`** (required) — comma-separated emails, each optionally
  `:viewer` / `:editor` (default viewer).
- **`--forward-source`** (optional) — the source run's summary link was already
  sent; make it land on this run.

## Process

Read `skills/release-run/SKILL.md` (it is operator-only — not dispatchable as a
Skill) and follow it exactly with the parsed arguments. Every invite is shown
for approval before any is sent.
