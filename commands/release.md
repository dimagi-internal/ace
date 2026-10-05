---
description: Release a run to outside reviewers — execute the release plan /ace:validate-release-readiness wrote (HQ, Connect, Drive and ace-web grants, then one email per reviewer) and nothing else. Approval-gated; refuses unless the latest validation is READY for exactly these reviewers and flags and nothing changed since.
argument-hint: "<workspace>/<opp>/<run-id> (--reviewers <email[:role]>,... | --from-thread <gmail-thread-id>) [--cc <staff@dimagi.com>,...] [--waive <blocker-id>=<reason>]... [--forward-source [--allow-cross-workspace-forward]] [--allow-shared connect] | --revoke-shared"
allowed-tools: [Bash, Read, AskUserQuestion, mcp__plugin_ace_ace-gdrive__resolve_opp_path, mcp__plugin_ace_ace-gdrive__drive_read_file, mcp__plugin_ace_ace-gdrive__update_yaml_file, mcp__plugin_ace_ace-gdrive__drive_set_anyone_with_link, mcp__plugin_ace_ace-connect__commcare_invite_web_user, mcp__plugin_ace_ace-connect__commcare_list_users, mcp__plugin_ace_ace-connect__connect_add_org_member, mcp__plugin_ace_ace-connect__connect_remove_org_member]
---

# /ace:release — share, and only share

Run `/ace:validate-release-readiness` first, with the same reviewers and
flags. This command executes the release plan that validation wrote into the
run's `release-readiness_verdict.yaml` and nothing else: no audit, no polish,
no content changes. Every share is shown for approval before any is made.

## Arguments

- **`<workspace>/<opp>/<run-id>`** (required).
- **`--reviewers`** / **`--from-thread <id>`** — exactly the reviewers the
  validation was run for; any difference is a refusal.
- **`--cc`** — exactly the Dimagi staff the validation copied (ace#2706); any
  difference is a refusal.
- **`--waive <blocker-id>=<reason>`** — exactly the waivers the validation
  applied (ace#2707), id and reason verbatim; any difference is a refusal.
- **`--forward-source`**, **`--allow-cross-workspace-forward`**,
  **`--allow-shared connect`** — exactly the flags the validation was run with.
- **`--revoke-shared`** — instead of releasing: remove every grant recorded in
  the run's `released.shared_grants`.

## Process

Read `skills/release-run/SKILL.md` (it is operator-only — not dispatchable as a
Skill) and follow it exactly with the parsed arguments.
