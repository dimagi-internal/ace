---
name: llo-launch
description: >
  Activate the opportunity for live use. Verifies UAT sign-offs and
  deep-QA verdicts, activates in Connect, notifies LLOs of go-live.
disable-model-invocation: true
---

# LLO Launch (Go-Live)

Activate the opportunity and notify LLOs that they are live.

## Process

1. **Read inputs from GDrive:**
   - UAT results: `ACE/<opp-name>/runs/<run-id>/7-execution-manager/llo-uat_results.md` (includes archetype)
   - Deployment summary: `ACE/<opp-name>/runs/<run-id>/2-commcare/app-deploy_summary.md` (atomic-visit)
   - Opportunity config: `ACE/<opp-name>/runs/<run-id>/3-connect/connect-opp-setup.md`
   - Awarded LLO: `opp.yaml.selected_llo` (populated by Phase 7 `solicitation-review`)
   - PDD: `ACE/<opp-name>/runs/<run-id>/1-design/idea-to-pdd.md` (fallback archetype source)

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

4. **Verify deep-QA verdicts before activation.** This is the
   highest-stakes gate in the pipeline; activation flips the opp from
   draft to live and deliveries start counting toward payment. Read
   both deep verdicts from `ACE/<opp-name>/runs/<run-id>/`:
   - `4-ocs/ocs-chatbot-eval_verdict-deep.yaml`
   - `5-qa-and-training/app-ux-eval_verdict-deep.yaml`

   For each verdict, require:

   1. **File exists.** If missing, the operator skipped `/ace:qa-deep`
      for that side.
   2. **`verdict: pass`** at the top level. (Canonical schema is
      `verdict:`, not `status:`. Per-item entries use the same key.)
   3. **Verdict is newer than the artifact it grades:**
      - **OCS verdict freshness:** call `ocs_get_chatbot` with the
        verdict's `target` (an `experiment_id` UUID) and confirm the
        chatbot's current `version_number` matches the verdict's
        `artifact_refs.version_number`. If the chatbot has been
        re-published since the verdict was written, the deep eval is
        stale.
      - **App verdict freshness:** read `learn_build_id` and
        `deliver_build_id` from
        `5-qa-and-training/app-ux-eval_verdict-deep.yaml`'s
        `artifact_refs:` block, then read
        `2-commcare/app-deploy_summary.md`'s `releases:` block. The
        verdict's build IDs must match the latest released build IDs.
        If either app has been re-released since the verdict was
        written, the screenshots that grounded the eval are out of
        date.

   If ANY check fails, halt with `[BLOCKER]` and emit:

   > `[BLOCKER]` Deep QA verdicts missing or stale.
   > Run `/ace:qa-deep <opp>` before activation.
   > Missing or stale: <list of failing checks>

   List one entry per failing check (e.g.
   `4-ocs/ocs-chatbot-eval_verdict-deep.yaml missing`,
   `5-qa-and-training/app-ux-eval_verdict-deep.yaml verdict=fail`, `OCS
   chatbot re-published since verdict written (verdict v3, current v4)`,
   `learn app re-released since verdict written (verdict build abc...,
   current build xyz...)`).

5. **Override (operator-only, audited).** If this skill was invoked
   with `--override-deep-qa-gate=<reason>`, skip the gate above and
   proceed to activation. Constraints:
   - The flag must include a non-empty `<reason>` (e.g.
     `--override-deep-qa-gate="emergency-patch-cve-2026-001"`). An
     empty or missing reason is a hard error — do not activate.
   - **`/ace:run` cannot pass this flag.** It is reachable only via
     `/ace:step llo-launch <opp> --override-deep-qa-gate=<reason>`.
     If `--override-deep-qa-gate` arrives through `/ace:run` (e.g.
     embedded in run-mode args), refuse and instruct the operator to
     re-invoke via `/ace:step`.
   - Append an audit entry to
     `ACE/<opp-name>/comms-log/observations.md`:

     ```
     YYYY-MM-DD HH:MM TZ — Deep-QA gate overridden during activation.
     Reason: <reason>. Operator: <ace user from $(git config user.email)
     or env, fallback "unknown">. Verdicts at time of override:
     <ocs-status> / <app-status>.
     ```

     `<ocs-status>` and `<app-status>` are short tags like `missing`,
     `verdict=fail`, `stale (chatbot v3→v4)`, or `pass`. Both must
     appear in the audit line so a reader can reconstruct *what was
     overridden*, not just *that an override happened*.

6. **Activate the opportunity in Connect** via
   `connect_activate_opportunity` (ace-connect MCP, 0.10.47+):
   - **Idempotency check first.** Call `connect_get_opportunity` and
     read `active`. If `active=true` already (and `opportunity_id`
     matches what we expect), skip the activate call entirely and log
     an `[INFO]` line to `comms-log/observations.md`:
     `<ISO> llo-launch: opp <id> already active; skipping activate
     call (idempotent path).`
     Connect's managed-opp create flow auto-activates as a side effect
     when `total_budget`/dates are populated up front, so a clean run
     of `connect-opp-setup` lands the opp already-active.
     `connect_activate_opportunity` itself **rejects already-active
     opps** as a validation error — without this pre-check, a clean
     Phase 3 cascades into a Phase 8 failure for no real reason.
     Tracking: jjackson/ace#106 finding 9.
   - **Otherwise activate.** Pass `organization_slug` and
     `opportunity_id` from `connect-setup/opportunity.md`. The atom
     hits `POST /api/opportunities/<id>/activate/`, which validates
     that: (a) the opp isn't already active, (b) the opp hasn't
     ended, and (c) at least one PaymentUnit exists. Returns
     `{ id, opportunity_id, name, active: true }` on success.
   - Verify by calling `connect_get_opportunity` and confirming
     `active=true` (whether we activated this run or skipped because
     it was already active).
   - **If ACE deferred the test-user pre-invite** during
     `connect-opp-setup` (because the opp was inactive at that point),
     fire `connect_send_flw_invite` here with `${ACE_E2E_PHONE}` —
     `connect-state.yaml` will have
     `ace_test_user_invite_pending_until_active: true` set.
   - Payment/tracking semantics are archetype-specific — see § Archetypes

7. **Confirm delivery surface readiness (archetype-specific):** see
   `## Archetypes`. For atomic-visit this is app-build verification;
   for focus-group this is Session 1 logistics confirmation; for
   multi-stage this is Stage-1-specific.

8. **Send launch notification to each LLO (archetype-aware body):**
   - From: ace@dimagi-ai.com
   - CC: CRISPR Admin Dimagi Google Group
   - Subject: archetype-specific — see `## Archetypes`
   - Body: archetype-specific content; all three variants include
     activation confirmation, key contacts, support channels, training
     material links

9. **Write launch record** to `ACE/<opp-name>/runs/<run-id>/7-execution-manager/llo-launch_record.md`:
   - Archetype (recorded explicitly so `timeline-monitor` applies the
     right cadence and milestones)
   - Activation timestamp
   - LLO notifications sent
   - Archetype-specific details (app URLs + versions for atomic-visit;
     session schedule + audio-upload path for focus-group; stage
     number + next-stage kickoff window for multi-stage)
   - Any outstanding non-blocking issues

<!-- 0.13.116: gate-brief write step + ## Gate Brief section removed.
The Phase 8 "Before llo-launch" Pause Point is unconditional in all
modes (always pauses — the highest-stakes activation in the pipeline).
At pause time, the orchestrator composes the pause-time summary from:
- this skill's eval verdict (`llo-launch-eval`)
- the deep-QA verdicts (`ocs-chatbot-eval_verdict-deep.yaml`,
  `app-ux-eval_verdict-deep.yaml`) including freshness checks vs
  current build IDs
- the UAT results (`llo-uat_results.md`)
- archetype-specific readiness signals from this skill's pre-activation
  checks (per § Archetypes below)
The producer no longer authors a separate gate-brief artifact. -->


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
multi-stage opp's lifetime — once per stage transition. Each
invocation re-emits a stage-specific gate brief + launch record. The
gate brief path is the same
(`runs/<run-id>/7-execution-manager/llo-launch_gate-brief.md`) —
subsequent runs overwrite the prior file; prior launch records stay
in `runs/<run-id>/7-execution-manager/llo-launch_record-stage-N.md` so
history is preserved. (The
`runs/<run-id>/7-execution-manager/llo-launch_record.md` entry tracks
the latest/current stage.)

## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file`
- Connect (`ace-connect` MCP, 0.10.47+):
  - `connect_activate_opportunity` — REST `POST /api/opportunities/<id>/activate/`
  - `connect_get_opportunity` — verify post-activation (HTML-driven read)
  - `connect_send_flw_invite` — REST `POST /api/opportunities/<id>/invite_users/`
    (only if `ace_test_user_invite_pending_until_active: true` in
    `connect-state.yaml`)
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

## Decisions Log

This skill writes load-bearing defaults to the per-run
`ACE/<opp-name>/runs/<run-id>/decisions.yaml`. The bar criterion and
schema live in `skills/idea-to-pdd/SKILL.md § Decisions Log Convention`
(canonical authority). The four rows below map 1:1 to `llo-launch-eval`'s
viability axis (PR #145) — when they're present in the log, the rubric
has structured input for those dimensions instead of grading on prose.
The list is a working template; the bar criterion is the sole filter.

### Common load-bearing decisions for Phase 8

| ID | Question | Map to surface |
|---|---|---|
| `llo-capacity-actual` | Did the LLO actually recruit the team they promised? | `llo-launch-eval` `llo_capacity_actual` (eval input, PR #145) |
| `day-one-readiness` | Are FLWs actually ready Day 1 (training complete, devices provisioned, accounts activated)? | `llo-launch-eval` `day_one_readiness` (eval input, PR #145) |
| `downstream-handoff-alignment` | Is the named downstream consumer ready to receive data on the agreed cadence? | `llo-launch-eval` `downstream_handoff_alignment` (eval input, PR #145) |
| `stop-loss-planning` | Is there a documented halt condition (data-quality floor, recruitment failure, etc.)? | `llo-launch-eval` `stop_loss_planning` (eval input, PR #145) |

The orchestrator's Phase Write-Back Verifier (`agents/ace-orchestrator.md`
§ Phase Write-Back Contract § Decisions log clause) enforces the
contract; the renderer (`skills/decisions-render`) regenerates the gdoc
at end of every phase.

Each row this skill writes uses `phase: 8-execution-management` and
`skill: llo-launch`.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-03 | Initial version | ACE team |
| 2026-04-17 | Emit gate brief at `ACE/<opp-name>/runs/<run-id>/7-execution-manager/llo-launch_gate-brief.md` *before* activation so the highest-stakes gate is approved on readiness, not retrospectively on a launch record | ACE team (PM scout, internal-admin lens) |
| 2026-04-20 | Added `## Archetypes` with per-archetype readiness checks, Connect activation semantics, launch email subject + body, and launch-record details. `focus-group` replaces "apps published" with "Session 1 venue + recording + participant recruitment confirmed" and subject flips to "Session 1 is on the calendar" (not "You Are Live" which is FLW-coded). `multi-stage` pins activation to Stage 1 only; each stage gets its own launch run, records preserved per-stage in `launch-record-stage-N.md`. Gate-brief checklist item 3 swaps in archetype-specific bullet | ACE team |
| 2026-04-28 | Replace HITL workaround with `connect_activate_opportunity` + `connect_get_opportunity` (ace-connect 0.8.1) | ACE team |
| 2026-04-30 | Switch `connect_activate_opportunity` to `POST /api/opportunities/<id>/activate/` (commcare-connect PR #1135). Server-side guards now reject activation if no PaymentUnits exist or the opp has ended; clearer errors than the silent edit-form fallback. Step 4 also gains a deferred FLW pre-invite path for ACE-driven dogfood runs whose `connect-opp-setup` deferred the invite until activation. (0.10.47) | ACE team |
| 2026-05-04 | Add the deep-QA verdict freshness gate (new Step 4) before activation: refuse to activate unless `verdicts/ocs-chatbot-eval-deep.yaml` and `verdicts/app-ux-eval-deep.yaml` exist, both pass, and both are newer than the artifacts they grade (OCS chatbot `version_number`; learn/deliver `build_id` from `deployment-summary.md`). Add `--override-deep-qa-gate=<reason>` operator escape hatch with a required reason and an audit trail to `comms-log/observations.md`; reachable only via `/ace:step llo-launch`, never `/ace:run`. Gate-brief auto-surfaced concerns gain two `[BLOCKER]` rows mirroring the gate. Part of the shallow/deep QA split refactor (spec: `docs/superpowers/specs/2026-05-04-shallow-deep-qa-split-design.md`). | ACE team |
| 2026-05-05 | **Path-scheme migration on the deep-QA gate.** Step 4 verdict reads, error messages, and gate-brief BLOCKER rows now reference `4-ocs/ocs-chatbot-eval_verdict-deep.yaml` and `5-qa-and-training/app-ux-eval_verdict-deep.yaml` (per the manifest); freshness check pulls build IDs from `2-commcare/app-deploy_summary.md`. Wiring fix — the prior `verdicts/...` paths no longer exist on disk, so the gate would always fail with "verdict missing" against current main. No behavior change beyond paths. | ACE team |
| 2026-05-08 | Add `## Decisions Log` section: 4 anchor rows mapped 1:1 to `llo-launch-eval`'s viability axis (llo-capacity-actual, day-one-readiness, downstream-handoff-alignment, stop-loss-planning) + bar-criterion reference. Pairs with decisions-log PR #4 (Phase 2-9 writes). | ACE team (decisions-log PR #4) |
