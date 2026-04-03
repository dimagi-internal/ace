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

2. **Pull invoices** from Connect for this opportunity.
   - Get auto-generated invoices based on verified deliveries
   - Calculate total payment amount

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
- Connect: invoice pull API — **NOT YET BUILT**
- Jira (Atlassian MCP): `createJiraIssue`

## Current Workaround
1. Read opportunity details and calculate expected payment
2. Document the invoice expectations
3. Ask the user to pull invoices from Connect UI
4. Ask the user to create the Jira payment ticket (or use Atlassian MCP if available)
5. Record the details

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
