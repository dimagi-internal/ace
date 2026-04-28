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
   - UAT results: `ACE/<opp-name>/uat/uat-results.md` (includes archetype)
   - Deployment summary: `ACE/<opp-name>/deployment-summary.md` (atomic-visit)
   - Opportunity config: `ACE/<opp-name>/connect-setup/opportunity.md`
   - LLO contacts: `ACE/<opp-name>/connect-setup/invites.md`
   - PDD: `ACE/<opp-name>/pdd.md` (fallback archetype source)

2. **Read the `archetype:` field.** Go-live semantics differ per
   archetype — "deliveries count toward payment now" is atomic-visit
   language; an FGD opp's go-live is "Session 1 starts on the scheduled
   date and the first write-up is due 48h after." See `## Archetypes`
   below. Fall back to `atomic-visit` if unspecified.

3. **Verify UAT passed (archetype-aware sign-off criterion):**
   - Check that all LLOs have signed off against their archetype's
     sign-off criterion (apps-work-for-FLWs / could-run-Session-1 /
     Stage-1-readiness) or UAT window has closed without blocking
     issues
   - If blocking issues remain, halt and notify admin group

4. **Activate the opportunity in Connect** via
   `connect_activate_opportunity` (ace-connect MCP, 0.8.1+):
   - Pass `organization_slug` and `opportunity_id` from
     `connect-setup/opportunity.md`. The atom flips the `active`
     checkbox on the opportunity edit form.
   - Verify by calling `connect_get_opportunity` and confirming
     `status=active`.
   - Payment/tracking semantics are archetype-specific — see § Archetypes

5. **Confirm delivery surface readiness (archetype-specific):** see
   `## Archetypes`. For atomic-visit this is app-build verification;
   for focus-group this is Session 1 logistics confirmation; for
   multi-stage this is Stage-1-specific.

6. **Send launch notification to each LLO (archetype-aware body):**
   - From: ace@dimagi-ai.com
   - CC: CRISPR Admin Dimagi Google Group
   - Subject: archetype-specific — see `## Archetypes`
   - Body: archetype-specific content; all three variants include
     activation confirmation, key contacts, support channels, training
     material links

7. **Write launch record** to `ACE/<opp-name>/launch/launch-record.md`:
   - Archetype (recorded explicitly so `timeline-monitor` applies the
     right cadence and milestones)
   - Activation timestamp
   - LLO notifications sent
   - Archetype-specific details (app URLs + versions for atomic-visit;
     session schedule + audio-upload path for focus-group; stage
     number + next-stage kickoff window for multi-stage)
   - Any outstanding non-blocking issues

8. **Write the gate brief** to `ACE/<opp-name>/gate-briefs/llo-launch.md`
   using the shape defined in `agents/ace-orchestrator.md § Gate Brief Contract`.
   The brief is written *before* activation so the admin approves based on
   readiness, not on a record of something that already happened. See
   `## Gate Brief` below. Gate-brief checks also branch on archetype —
   don't check "apps are published" on an FGD opp.

## Gate Brief

The gate brief at `ACE/<opp-name>/gate-briefs/llo-launch.md` is the final
approval point before the opportunity flips from test/draft to active in
Connect — after this, deliveries count toward real payment and FLWs are
live. This is the single highest-stakes gate in the pipeline.

- **Artifact Under Review:** draft launch record and pending activation;
  summary is `Opportunity <opp-name> ready for activation — <N> LLOs
  signed off via UAT`
- **What to Check** (5 items; third item is archetype-specific):
  - UAT results show zero blocking issues across all LLOs who participated
  - Connect opportunity is in a state that can transition to active
    (not draft-incomplete, not paused)
  - **Archetype-specific delivery-surface check** — swap in the matching
    bullet from `## Archetypes`:
    - `atomic-visit`: All apps (Learn + Deliver) are built, published,
      and downloadable
    - `focus-group`: Session 1 venue, recording equipment, participant
      recruitment, and consent logistics confirmed in UAT results
    - `multi-stage`: Stage-1 delivery surface ready per stage's
      protocol (one of the above two, pinned to Stage 1)
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

## Archetypes

Go-live is the highest-stakes gate. "Deliveries count toward payment
now" is atomic-visit-specific; an FGD opp goes live when Session 1 is
on the calendar with logistics locked. Same activation action in
Connect — different readiness criteria, different notification content,
different monitoring cadence downstream.

### `atomic-visit` (default)

**Delivery-surface readiness check:**
- Learn and Deliver apps are built and published on CCHQ (build status
  `success`)
- Mobile download is available (verify at least one FLW can install the
  updated app)

**Connect activation semantics:** flipping to active means deliveries
start counting toward payment immediately. If there's a scheduled start
date, defer activation until that date; don't pre-activate and risk
stray early-delivery payments.

**Launch email:**
- Subject: `"[Opportunity Name] — You Are Live!"`
- Body leads with: "Your opportunity is active. FLWs can now use the
  apps and deliveries count toward payment."
- Include app URLs (Learn + Deliver) and the opportunity dashboard link

**Launch record `archetype_details:`:** `{apps: [{name, url, version,
build_status}], first_delivery_eligibility_date}`

### `focus-group`

**Delivery-surface readiness check (replaces app-build verification):**
- Session 1 venue confirmed + available on the scheduled date/time
- Recording equipment tested successfully during UAT (not just "we have
  a phone")
- Audio-upload path verified with a real file (from UAT dry-run)
- Participant recruitment at target N for Session 1 — **do not launch
  if recruitment is below target for Session 1**; push the schedule
  rather than running a shorthanded first session
- Consent script practiced and approved during UAT

**Connect activation semantics:** if the opp uses Connect for payment
tracking, flipping to active is when session completion starts being
recorded toward the LLO's per-session rate. If the opp is paid
out-of-band (invoice), activation is ceremonial but still run it so
`timeline-monitor` can key off a canonical activation date.

**Launch email:**
- Subject: `"[Opportunity Name] — Session 1 is on the calendar!"` (not
  "You Are Live" — that phrasing is FLW-deployment coded)
- Body leads with: "Session 1 is confirmed for `<date>` at `<venue>`.
  Facilitator: `<LLO contact>`. Audio upload due within 48 hours of
  session end."
- Include: session schedule (all N sessions), audio-upload path, who
  to contact if a participant cancels, the OCS widget link

**Launch record `archetype_details:`:** `{sessions: [{n, date, venue,
participant_target}], audio_upload_path, write_up_due_hours}`

### `multi-stage`

**Delivery-surface readiness check:** pin to **Stage 1's protocol** and
apply the atomic-visit or focus-group check above accordingly. Later
stages are explicitly OUT OF SCOPE for this launch — they get their
own launch runs at their respective stage boundaries.

**Connect activation semantics:** activate only for Stage 1's delivery
surface. If Connect cannot scope activation by stage, note the
constraint in `launch-record.md § caveats`.

**Launch email:**
- Subject: `"[Opportunity Name] — Stage 1 is live"` (explicit stage
  number; avoids "you are live" implying the whole pipeline is running)
- Body leads with: "Stage 1 (`<stage-1-protocol>`) is active as of
  `<date>`. Stage 2 onboarding will follow separately after the Stage 1
  gate (expected: `<stage-transition-date>`)."
- Include Stage 1 specifics + note that Stage 2 details will come in a
  later email

**Launch record `archetype_details:`:** `{current_stage: 1,
stages_total: N, stage_1_protocol, stage_transition_criteria,
next_stage_kickoff_window}`

**Important:** `llo-launch` may be invoked MULTIPLE times across a
multi-stage opp's lifetime — once per stage transition. Each invocation
re-emits a stage-specific gate brief + launch record. The gate brief
path is the same (`gate-briefs/llo-launch.md`) — subsequent runs
overwrite the prior file; prior launch records stay in
`launch/launch-record-stage-N.md` so history is preserved. (The
`launch/launch-record.md` entry tracks the latest/current stage.)

## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file`
- Connect (`ace-connect` MCP, 0.8.1+):
  - `connect_activate_opportunity` — flip the opportunity to active
  - `connect_get_opportunity` — verify post-activation status
- Email: `email-communicator` skill (sends launch notifications)

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
| 2026-04-20 | Added `## Archetypes` with per-archetype readiness checks, Connect activation semantics, launch email subject + body, and launch-record details. `focus-group` replaces "apps published" with "Session 1 venue + recording + participant recruitment confirmed" and subject flips to "Session 1 is on the calendar" (not "You Are Live" which is FLW-coded). `multi-stage` pins activation to Stage 1 only; each stage gets its own launch run, records preserved per-stage in `launch-record-stage-N.md`. Gate-brief checklist item 3 swaps in archetype-specific bullet | ACE team |
| 2026-04-28 | Replace HITL workaround with `connect_activate_opportunity` + `connect_get_opportunity` (ace-connect 0.8.1) | ACE team |
