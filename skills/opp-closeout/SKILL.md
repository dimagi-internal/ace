---
name: opp-closeout
description: >
  Pull invoices from the completed opportunity and create a Jira ticket
  to issue payment to the LLO.
disable-model-invocation: true
---

# Opportunity Closeout

Process the financial closeout of a completed opportunity.

## Process

1. **Read opportunity details** from GDrive:
   - Opportunity config: `ACE/<opp-name>/runs/<run-id>/4-connect/connect-opp-setup.md`
   - Delivery/payment unit config

2. **Pull invoices** from Connect for this opportunity via
   `connect_list_invoices` (and `connect_get_invoice` for any that need
   detail hydration). Invoice atoms are conservative in 0.8.1 — they
   return empty/stub records for opps that haven't been billed yet.
   - Get auto-generated invoices based on verified deliveries
   - Calculate total payment amount
   - **If the invoice list is empty AND the opportunity has completed
     deliveries**, the invoice page shape may have evolved since
     0.8.1's probe — re-run `scripts/probe-connect-invoice.ts` to
     update the parser, or fall back to manual UI export until then.

3. **Create Jira ticket** for payment processing:
   - Project: appropriate Jira project for Connect payments
   - Summary: "Payment: [Opportunity Name] — [LLO Name]"
   - Description: invoice details, amount, LLO banking info reference
   - Attach invoice documents

4. **Write closeout record** to `ACE/<opp-name>/runs/<run-id>/8-closeout/opp-closeout_invoices.md`:
   - Invoice details
   - Total amount
   - Jira ticket link

## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file`
- Connect (`ace-connect` MCP, 0.8.1+):
  - `connect_list_invoices` — pull invoices for the opportunity
  - `connect_get_invoice` — hydrate invoice detail
- Jira (Atlassian MCP): `createJiraIssue`

## Mode Behavior
- **Auto:** Pull invoices, create Jira ticket, proceed
- **Review:** Present invoice details for verification before creating ticket

## Dry-Run Behavior
When `--dry-run` is active:
- Write the Jira ticket specification (project, summary, description, attachments) and invoice details to `comms-log/dry-run-opp-closeout.md`
- Do not create the Jira ticket or pull invoices from Connect
- State tracks as `dry-run-success`

## Decisions Log

This skill writes load-bearing defaults to the per-run
`ACE/<opp-name>/runs/<run-id>/decisions.yaml`. The bar criterion and
schema live in `skills/idea-to-pdd/SKILL.md § Decisions Log Convention`
(canonical authority). The list below catalogs decisions that commonly
qualify under the bar for this phase — a working template, not a
required set. The skill applies the bar criterion and emits whatever
rows meet it; the catalog is a teaching device that improves over time.

### Common load-bearing decisions for Phase 10

| ID | Question | Map to surface |
|---|---|---|
| `closeout-depth` | Standard summary vs. deep retrospective with cycle-grade re-anchor? | `cycle-grade-eval` rubric input |
| `learnings-summary-scope` | Per-opp only, or cross-opp pattern aggregation? | `learnings-summary` skill output; ACE-wide pattern catalogue |

The orchestrator's Phase Write-Back Verifier (`agents/ace-orchestrator.md`
§ Phase Write-Back Contract § Decisions log clause) enforces the
contract; the renderer (`skills/decisions-render`) regenerates the gdoc
at end of every phase.

Each row this skill writes uses `phase: 10-closeout` and
`skill: opp-closeout`.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-03 | Initial version | ACE team |
| 2026-04-28 | Replace HITL workaround with `connect_list_invoices` + `connect_get_invoice` (ace-connect 0.8.1). Note: invoice page shape was not yet probed at 0.8.1 ship; atoms return conservative defaults until the page has been observed live | ACE team |
| 2026-05-08 | Add `## Decisions Log` section: 2 anchor rows (closeout-depth, learnings-summary-scope) + bar-criterion reference. Pairs with decisions-log PR #4 (Phase 3-10 writes). | ACE team (decisions-log PR #4) |
