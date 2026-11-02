# Access request: Atlassian read (and create) for `connect-tech-interrupt`

**Requested by:** Lilianna Bagnoli (member, #connect-kc-ace), 2026-11-02.
**Decision needed from:** Jon (owner). Lilianna prefers the API route; draft-only is acceptable if Jon prefers.

## Why

`skills/connect-tech-interrupt` files Connect Tech Interrupt tickets for any Connect
program. The process and the form change over time, so ACE must read them live
rather than hold a copy. Today it cannot: the Confluence page returns a login
wall (observed 2026-11-02, "This space is locked") and ACE has no Atlassian
credentials (no MCP, no `acli`, no Jira env).

## What ACE needs

| Need | Scope | Why |
|---|---|---|
| Read Confluence page `3086581903` | space `connect`, that page only if possible | the process |
| Read the form definition | Jira project `CI` (browse, read form/field metadata) | the fields and allowed values |
| Create issues | Jira project `CI`, create-issue only | file the ticket (API route only) |

Read access alone is enough for the draft-only route.

## Proposed mechanism (Jon to confirm)

- A dedicated Atlassian service account for ACE (not a person's token), least
  privilege as above.
- Store as `ATLASSIAN_SITE`, `ATLASSIAN_EMAIL`, `ATLASSIAN_API_TOKEN` in ACE's
  Canopy vault, then `/ace:setup --force-env` and restart, per CLAUDE.md.
- Follow-up PR: the submit transport (a vetted helper script, since vault env
  reaches MCP subprocesses and not the shell), then replace the `TODO` in the
  skill. Not included here because the endpoint for the form is unverified.

## Open question

Whether the `CI` form maps onto the plain Jira create-issue API or only exists
as a Jira Forms UI object. Cannot be settled without read access; the follow-up
PR resolves it from the live form.

## If declined

The skill still works in draft-only mode once it can read the two pages, or
with the member pasting them.
