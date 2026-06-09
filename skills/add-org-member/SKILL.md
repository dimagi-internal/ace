---
name: add-org-member
description: >
  Add a Dimagi teammate to a Connect workspace (organization) by email, so
  they can see the programs/opportunities ACE runs there. Thin wrapper over
  the `connect_add_org_member` atom: enforces a @dimagi.com guard, defaults
  the workspace to `ai-demo-space` and the email to the session's own git
  identity ("add me"), invites via Connect's membership form, and verifies
  by member-table read-back. Anyone running ACE can invoke it; ACE performs
  the add as its own org-admin identity.
disable-model-invocation: false
---

# Add Org Member

Invite a human to a Connect **workspace** (Connect's term: *organization*) by
email. This is the "let me / let a teammate into the ai-demo-space workspace
so they can see what ACE is building" flow.

## What it does

1. Resolves inputs (see **Arguments**): `email`, `organization_slug`, `role`.
2. **Enforces the @dimagi.com guard** — refuses any email not ending in
   `@dimagi.com`. This is an internal-team tool; adding external addresses to
   a Dimagi workspace is out of scope. If the operator genuinely needs to add
   an external collaborator, that's a deliberate manual action in the Connect
   UI by an org admin, not this skill.
3. Calls `connect_add_org_member({ organization_slug, email, role })`.
4. Reports the result — including the two Connect-side preconditions if the
   add was rejected (see **Failure modes**).

## Arguments

| Input | Required | Default |
|---|---|---|
| `email` | no | the session's `git config user.email` (i.e. "add me") |
| `organization_slug` (`--org`) | no | `ai-demo-space` (the ACE demo workspace) |
| `role` (`--role`) | no | `member` (one of `admin` \| `member` \| `viewer`) |

Resolve `email` when omitted by running `git config user.email`. If that is
empty or not a `@dimagi.com` address, ask the operator for the email rather
than guessing.

## Preconditions (both enforced by Connect — you cannot bypass them)

- **ACE must be an admin of the target workspace.** ACE acts as its own
  Connect identity (`ace@dimagi-ai.com`). Connect's `add_members` view is
  `@org_admin_required`; if ACE is not an admin of `organization_slug` the
  POST 403s. The atom surfaces this as an HTTP 403 error — if you see it, ask
  a current workspace admin to add `ace@dimagi-ai.com` as an admin first (or
  to add the user directly).
- **The invitee must already have a Connect account.** Connect's
  `MembershipForm.clean_email` only accepts an email that already belongs to
  a Connect user (it does not provision accounts from an invite). If the
  person has never signed in to Connect, the add is rejected. Tell them to
  sign in once at https://connect.dimagi.com/ , then re-run.

## Process

1. **Resolve + guard.** Resolve `email` (arg or `git config user.email`),
   `organization_slug` (arg or `ai-demo-space`), `role` (arg or `member`).
   If `email` does not end in `@dimagi.com`, STOP and tell the operator this
   skill only adds Dimagi accounts; point them at the Connect UI for external
   collaborators.

2. **Add.** Call `connect_add_org_member({ organization_slug, email, role })`.
   The atom GETs the workspace home for a CSRF token, POSTs the membership
   form, then verifies by reading back the member table (Connect's view
   redirects identically on success and failure, so read-back is the only
   reliable signal — the atom handles this).

3. **Report.** On success: confirm the email, role, and workspace, and note
   that the user receives an accept-invite email and shows as *pending* in the
   member list until they click it. On a `ConnectValidationError`, relay the
   two likely causes (no Connect account yet / already a member). On HTTP 403,
   relay the admin-rights precondition.

## Failure modes

- **`ConnectValidationError` ("user does not exist or is already a member")** —
  Connect rejected the add. Either the invitee has no Connect account yet (most
  common — have them sign in once) or they're already in the workspace (no
  action needed; confirm via the member list).
- **HTTP 403** — ACE (`ace@dimagi-ai.com`) is not an admin of this workspace.
  A current admin must grant ACE admin, or add the user directly.
- **Non-@dimagi.com email** — refused by this skill before any Connect call.

## MCP tools used

- `connect_add_org_member` (ace-connect) — the only mutating call.

## Notes

- The atom is general (any workspace, any role); the @dimagi.com guard lives
  here in the skill, so the underlying capability stays reusable for future
  internal flows.
- This is not part of `/ace:run` — it's a standalone operator convenience,
  invoked via `/ace:add-org-member`.
