---
name: opp-closeout
description: >
  Pull invoices from the completed opportunity and create a Jira ticket
  to issue payment to the LLO.
---

# Opportunity Closeout

Process the financial closeout of a completed opportunity.

## Process

1. **Read opportunity details** from GDrive:
   - Opportunity config: `ACE/<opp-name>/connect-setup/opportunity.md`
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

4. **Write closeout record** to `ACE/<opp-name>/closeout/invoices.md`:
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

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-03 | Initial version | ACE team |
| 2026-04-28 | Replace HITL workaround with `connect_list_invoices` + `connect_get_invoice` (ace-connect 0.8.1). Note: invoice page shape was not yet probed at 0.8.1 ship; atoms return conservative defaults until the page has been observed live | ACE team |
