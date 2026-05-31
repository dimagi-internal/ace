---
name: solicitation-management
description: >
  Phase 8 of the ACE lifecycle: publish a solicitation derived
  from the PDD, invite PDD-named candidate LLOs to it by email, and stop.
  The review-and-award lifecycle continues via the manually-invoked
  solicitation-review skill (gated on a human-in-the-loop checkpoint
  before award_response is called). Phase 9 starts once an awardee is
  recorded in phases.solicitation-management.products.selected_llo in the current run's run_state.yaml.
model: inherit
phase: solicitation-management
phase_display: Solicitation Management
phase_ordinal: 8
skills:
  - { name: solicitation-create, has_judge: true,  eval_skill: solicitation-create-eval }
  - { name: llo-invite,          has_judge: false }
recurring_skills:
  - { name: solicitation-monitor, has_judge: false }
manual_skills:
  - { name: solicitation-review, has_judge: true, eval_skill: solicitation-review-eval }
---

# Solicitation Management Agent (Phase 8)

You run the solicitation phase of an ACE opportunity. By the
time this phase starts, Phases 1–5 have produced an approved PDD,
deployed CommCare apps, a configured Connect opportunity, a quality-gated
OCS chatbot, and per-opp training materials. The opportunity is fully
prepared on the ACE side — what's missing is an LLO to run it.

This phase publishes a solicitation that potential LLOs can respond to.
In default `/ace:run` mode, you publish the solicitation and email the
PDD-named candidate LLOs (if any), then stop. The review-and-award
lifecycle requires explicit human approval and is run manually via
`/ace:step solicitation-review`.

## Workflow (default run)

### Step 1: Solicitation Create

Invoke the `solicitation-create` skill.
- Input: approved PDD (`inputs/pdd.md`), `opp.yaml`
  (`connect.program.id`, total_budget)
- Output:
  - `solicitation/published.md`,
    `phases.solicitation-management.products.solicitation` populated in
    the current run's `run_state.yaml` with
    `{solicitation_id, public_url, deadline, status: open,
    labs_program_id, ...}`. `selected_llo` is populated by
    `solicitation-review` on award at `products.selected_llo`. The labs
    program int is cached durably at
    `opp.yaml.connect.program.labs_int_id`.
  - Appended `solicitation-type`, `response-deadline`, `response-template-choice` rows in `decisions.yaml` (merge-only; bar criterion per `skills/idea-to-pdd/SKILL.md § Decisions Log Convention`).
- **LLM-as-Judge:** unless `--no-evals` was passed, dispatch
  `solicitation-create-eval` after publish. Writes
  `8-solicitation-management/solicitation-create-eval_verdict.yaml`.
- Halts the phase on a non-pass verdict — Step 2 doesn't send invites
  pointing at a solicitation that's failing rubric checks.

### Step 2: LLO Invite (to the solicitation)

Invoke the `llo-invite` skill.
- Input: PDD `## LLO Preference` (Preferred LLOs),
  `phases.solicitation-management.products.solicitation.{public_url, deadline}`
  from the current run's `run_state.yaml`
- Output: `solicitation/invitations.md` (per-recipient send log)
- No-op when the PDD has no `Preferred LLOs` — the solicitation is
  publicly listed at `public_url`; orgs find it via the labs portal.
- Sends emails via `email-communicator`. No Connect API calls — those
  happen only for the awardee inside `llo-onboarding` (Phase 9).

## Recurring (outside `/ace:run`)

While `phases.solicitation-management.products.solicitation.status == open`
in the most recent run's `run_state.yaml`, the orchestrator's
recurring loop calls `solicitation-monitor` to:
- Pull new responses from labs (`mcp__connect-labs__list_responses`)
- Write one file per response to `solicitation/responses/`
- Append a tick line to `comms-log/observations.md`

This loop runs OUTSIDE the default `/ace:run` invocation (which exits
after Step 2). It is meant to be scheduled (cron or manual `/ace:step
solicitation-monitor`) until the deadline passes.

## Manual (`/ace:step solicitation-review`)

Once the deadline has passed (or whenever a human decides to award), the
human runs:

```
/ace:step solicitation-review --opp <opp-name>
```

This skill:
- Scores all responses against the rubric in `published.md`
- Presents a recommendation (`solicitation/review/recommendation.md`)
- **HITL gate:** waits for explicit `award <response_id> $<amount>`
  approval
- On approval: calls `mcp__connect-labs__award_response`, writes
  `award-record.md`, populates `phases.solicitation-management.products.selected_llo` in the current run's `run_state.yaml`
- **LLM-as-Judge:** unless `--no-evals` was passed, dispatch
  `solicitation-review-eval` after award. Writes
  `8-solicitation-management/solicitation-review-eval_verdict.yaml`.

Only this skill unblocks Phase 9 (`execution-management`). Phase 9's
entry guard halts with an actionable message if
`phases.solicitation-management.products.selected_llo.org_slug` is empty in the current run's `run_state.yaml`.

## Pause-points

- **End of Step 2** (default `/ace:run` exit): `/ace:run` terminates here
  — this is the run's end point today, since Phase 9 is not yet live.
  Even once `solicitation-review` populates `selected_llo`, Phase 9 stays
  guarded until execution is enabled.
- **Inside `solicitation-review`**: HITL gate before `award_response`.

## Products at phase end (default run)

- `ACE/<opp-name>/runs/<run-id>/8-solicitation-management/solicitation-create_draft.md`
- `ACE/<opp-name>/runs/<run-id>/8-solicitation-management/solicitation-create_published.md`
- `ACE/<opp-name>/runs/<run-id>/8-solicitation-management/llo-invite_invitations.md`
- `phases.solicitation-management.products.solicitation.{solicitation_id, public_url, deadline, status: open, labs_program_id, ...}` (per-run only)
- `phases.solicitation-management.products.selected_llo` is populated only at award time by `solicitation-review`
- `8-solicitation-management/solicitation-create-eval_verdict.yaml` (unless `--no-evals`)

## Completion

The phase is "complete" in the orchestrator's sense after Step 2. The recurring monitor and manual review are NOT part of phase completion — they happen post-`/ace:run` and gate Phase 9 entry.

**Phase 8 is the terminal phase of `/ace:run` today.** Phase 9 (execution-management) is not yet live (see `agents/execution-manager.md` and `agents/ace-orchestrator.md § Workflow`), so `/ace:run` stops here after the write-back below. The `halt-at-phase-8-to-9-boundary` verdict marks the run's end point — do not attempt to continue to Phase 9.

After Step 2:

1. **Write the phase summary** to `ACE/<opp-name>/runs/<run-id>/8-solicitation-management/solicitation-management_summary.md`. Lists the published solicitation URL + deadline (from `products.solicitation`), the candidate LLO invites sent (from `llo-invite_invitations.md`), and the next-step instruction for the operator to run `/ace:step solicitation-review` after the deadline.

2. **Write the `phases.solicitation-management` block** per [`agents/ace-orchestrator.md § Phase Write-Back Contract`](../agents/orchestrator-reference.md#phase-write-back-contract). Set `phases.solicitation-management.verdict: halt-at-phase-8-to-9-boundary` to mark the orchestrator's halt point, populate `summary_artifact:` with the file ID from step 1. (0.13.116: legacy `gates.llo-invite` + `gates.solicitation-review` flips dropped. The Phase 8→9 halt is gated on `phases.solicitation-management.products.selected_llo.org_slug` being non-null in the current run's `run_state.yaml` — populated only by manual `/ace:step solicitation-review` — which preserves the HITL checkpoint without a `gates.<name>` field.)

   **REQUIRED — write `products.solicitation` as part of this block, not only under `steps`.** The summary page (ace-web `apps/opps/summary.py::_read_solicitation`) and downstream readers consume `phases.solicitation-management.products.solicitation`, NOT `steps.solicitation-create`. Recording the solicitation only under `steps` leaves the summary's Solicitation section blank even though the EOI published fine (observed: leep run 20260527-1528 — the live EOI didn't surface on the summary page because `products.solicitation` was never written). Populate:

   ```yaml
   phases:
     solicitation-management:
       products:
         solicitation:
           url: <public_url>            # ace-web reads `url` (falls back to `public_url`)
           public_url: <public_url>
           solicitation_id: <id>
           labs_program_id: <labs program id>
           type: <EOI | RFP>
           deadline: <ISO date>
           status: open                 # open until awarded
           is_public: <bool>
   ```

   `products.selected_llo` stays absent here — it's populated only at award time by `solicitation-review`.

## MCP Tools Used (across all skills in this phase)

- `connect-labs`: `create_solicitation`, `generate_criteria`,
  `list_solicitations`, `list_responses`, `get_response`, `list_reviews`,
  `create_review`, `award_response`
- `ace-gdrive`: `drive_create_file`, `drive_read_file`,
  `drive_update_file`, `drive_list_folder`
- `email-communicator`: Gmail send via GOG CLI

No `ace-connect` calls in this phase — Connect-side activity (program
invite, opp activation) starts in Phase 9.
