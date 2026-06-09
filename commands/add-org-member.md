---
description: Add a Dimagi teammate to a Connect workspace (organization) by email so they can see what ACE runs there. Defaults to adding you (your git email) to ai-demo-space. @dimagi.com only.
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
- **`--org <slug>`** (optional) — target workspace. Default **`ai-demo-space`**.
- **`--role member|admin|viewer`** (optional) — default **`member`**.

## Process

Invoke the `add-org-member` skill, passing the parsed arguments:

```
Skill(ace:add-org-member) with:
  email            = <arg email> or `git config user.email`
  organization_slug = <--org> or "ai-demo-space"
  role             = <--role> or "member"
```

Follow the skill exactly. Key rules it enforces:

- **@dimagi.com only** — non-Dimagi emails are refused (use the Connect UI for
  external collaborators).
- **The invitee must already have a Connect account** (signed in once at
  https://connect.dimagi.com/ ) — Connect won't provision one from an invite.
- **ACE must be an admin** of the target workspace, or the add 403s — ask a
  current admin to add `ace@dimagi-ai.com` as admin first.

On success the person gets an accept-invite email and shows as *pending* in the
workspace member list until they accept.

## Examples

- `/ace:add-org-member` — add yourself to `ai-demo-space` as a member.
- `/ace:add-org-member jdoe@dimagi.com` — add a teammate to `ai-demo-space`.
- `/ace:add-org-member jdoe@dimagi.com --role admin` — add as admin.
- `/ace:add-org-member jdoe@dimagi.com --org some-other-workspace` — different workspace.
