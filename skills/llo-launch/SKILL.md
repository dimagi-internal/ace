---
name: llo-launch
description: >
  Activate the opportunity for live use. Verify UAT sign-offs, activate the
  opportunity in Connect, confirm apps are published, and notify LLOs of go-live.
---

# LLO Launch (Go-Live)

Activate the opportunity and notify LLOs that they are live.

## Process

1. **Read inputs from GDrive:**
   - UAT results: `ACE/<opp-name>/uat/uat-results.md`
   - Deployment summary: `ACE/<opp-name>/deployment-summary.md`
   - Opportunity config: `ACE/<opp-name>/connect-setup/opportunity.md`
   - LLO contacts: `ACE/<opp-name>/connect-setup/invites.md`

2. **Verify UAT passed:**
   - Check that all LLOs have signed off (or UAT window has closed without blocking issues)
   - If blocking issues remain, halt and notify admin group

3. **Activate the opportunity in Connect:**
   - Change opportunity status from draft/test to active
   - Confirm deliveries will now count toward payment

4. **Confirm apps are published and available:**
   - Verify Learn and Deliver apps are built and published on CCHQ
   - Confirm mobile download is available

5. **Send launch notification to each LLO:**
   - From: ace@dimagi-ai.com
   - CC: CRISPR Admin Dimagi Google Group
   - Subject: "[Opportunity Name] — You Are Live!"
   - Body:
     - Confirmation that the opportunity is active
     - FLWs can now use the apps and deliveries count
     - Reminder of key contacts and support channels
     - Link to training materials for reference

6. **Write launch record** to `ACE/<opp-name>/launch/launch-record.md`:
   - Activation timestamp
   - LLO notifications sent
   - App URLs and versions
   - Any outstanding non-blocking issues

7. **Write the gate brief** to `ACE/<opp-name>/gate-briefs/llo-launch.md`
   using the shape defined in `agents/ace-orchestrator.md § Gate Brief Contract`.
   The brief is written *before* activation so the admin approves based on
   readiness, not on a record of something that already happened. See
   `## Gate Brief` below.

## Gate Brief

The gate brief at `ACE/<opp-name>/gate-briefs/llo-launch.md` is the final
approval point before the opportunity flips from test/draft to active in
Connect — after this, deliveries count toward real payment and FLWs are
live. This is the single highest-stakes gate in the pipeline.

- **Artifact Under Review:** draft launch record and pending activation;
  summary is `Opportunity <opp-name> ready for activation — <N> LLOs
  signed off via UAT`
- **What to Check** (emit these 5 items verbatim):
  - UAT results show zero blocking issues across all LLOs who participated
  - All apps (Learn + Deliver) are built, published, and downloadable
  - Connect opportunity is in a state that can transition to active
    (not draft-incomplete, not paused)
  - The launch notification email body references the correct opportunity
    name, dates, and support channel (ace@dimagi-ai.com)
  - Training materials and the OCS widget link are accessible to LLOs
- **Auto-Surfaced Concerns:** one line per signal:
  - `[BLOCKER]` for any LLO with UAT sign-off status ≠ `signed-off` and a
    blocking issue recorded
  - `[BLOCKER]` if any app has a build status that is not `success`
  - `[WARN]` for each LLO with `signed-off` status but >0 non-blocking
    issues noted — worth the admin's attention before go-live
  - `[WARN]` if UAT window is still open and activating now would cut it
    short
  - `[INFO]` if any notification is queued for sending via the Current
    Workaround (manual send) instead of automated email
  - "None — all auto-checks passed." if the opp is clean to launch
- **Recommended Disposition:** `Approve` only if zero `[BLOCKER]`; `Reject`
  if any `[BLOCKER]` (activation would go live with known-broken state);
  `Iterate` if UAT needs more time or apps need a rebuild

## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file`
- Connect: opportunity activation API — **NOT YET BUILT**

## Current Workaround
1. Verify UAT results from GDrive
2. Ask the user to activate the opportunity in the Connect UI
3. Ask the user to confirm apps are published and available for download
4. Generate launch notification emails as drafts
5. Write to `ACE/<opp-name>/comms-log/launch-notification-drafts/`
6. Ask the user to send them from ace@dimagi-ai.com
7. Record the launch details

## Mode Behavior
- **Auto:** Activate opportunity, send launch notifications, proceed to monitoring phase
- **Review:** Present launch readiness summary for approval before activating (this is a **gate step**)

## Dry-Run Behavior
When `--dry-run` is active:
- Write the intended activation action (opportunity ID, status change) to `comms-log/dry-run-llo-launch.md`
- Write the launch notification emails (recipients, subject, body) to the same file
- Do not activate the opportunity or send emails
- State tracks as `dry-run-success`

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-03 | Initial version | ACE team |
| 2026-04-17 | Emit gate brief at `ACE/<opp-name>/gate-briefs/llo-launch.md` *before* activation so the highest-stakes gate is approved on readiness, not retrospectively on a launch record | ACE team (PM scout, internal-admin lens) |
