---
description: Add a Dimagi teammate to a Connect workspace (organization) by email so they can see what ACE runs there. Defaults to adding you (your git email) to the configured PM org. @dimagi.com only.
argument-hint: "[email] [--org <slug>] [--role member|admin|viewer]"
allowed-tools: [Bash, AskUserQuestion, Skill, mcp__plugin_ace_ace-connect__connect_add_org_member]
---

# /ace:add-org-member — Add a teammate to a Connect workspace

Invite a Dimagi teammate (or yourself) to a Connect **workspace** (organization)
so they can see the programs/opportunities ACE runs there. ACE performs the add
as its own org-admin identity (`ace@dimagi-ai.com`).

## Arguments

- **`[email]`** (optional) — the Dimagi email to add. **Omitted → adds you**
  (resolved from `git config user.email`).
- **`--org <slug>`** (optional) — target workspace. Default: **the configured
  PM org** (`connect_orgs.pm_org` — resolve with `bash bin/ace-doctor --preflight --no-live`;
  set per instance via `ACE_CONNECT_PM_ORG`, see
  `playbook/integrations/connect-api.md § Which Connect orgs ACE acts in`).
- **`--role member|admin|viewer`** (optional) — default **`member`**.

## Process

Invoke the `add-org-member` skill, passing the parsed arguments:

```
Skill(ace:add-org-member) with:
  email            = <arg email> or `git config user.email`
  organization_slug = <--org> or connect_orgs.pm_org
  role             = <--role> or "member"
```

Follow the skill exactly. Key rules it enforces:

- **@dimagi.com only** — non-Dimagi emails are refused (use the Connect UI for
  external collaborators).
- **ACE must be an admin** of the target workspace, or the add 403s — ask a
  current admin to add `ace@dimagi-ai.com` as admin first.
- **No Connect account is needed first** — Connect records a pending invite
  and the invitee signs up from its link.

On success (`status: invited-pending`) the person gets an accept-invite email
and shows under *Pending Invites* until they accept; `already-invited` /
`already-member` are also successes. Only a validation error (email in neither
the member nor the pending table after the POST) means nothing was recorded.

## Examples

- `/ace:add-org-member` — add yourself to the configured PM org as a member.
- `/ace:add-org-member jdoe@dimagi.com` — add a teammate to the configured PM org.
- `/ace:add-org-member jdoe@dimagi.com --role admin` — add as admin.
- `/ace:add-org-member jdoe@dimagi.com --org some-other-workspace` — different workspace.
