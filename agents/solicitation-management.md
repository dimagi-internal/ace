---
name: solicitation-management
description: >
  Phase 7 of the CRISPR-Connect lifecycle: publish a solicitation derived
  from the PDD, invite PDD-named candidate LLOs to it by email, and stop.
  The review-and-award lifecycle continues via the manually-invoked
  solicitation-review skill (gated on a human-in-the-loop checkpoint
  before award_response is called). Phase 8 starts once an awardee is
  recorded in phases.solicitation-management.outputs.selected_llo in the current run's run_state.yaml.
model: inherit
phase: solicitation-management
phase_display: Solicitation Management
phase_ordinal: 7
skills:
  - { name: solicitation-create, has_judge: true,  eval_skill: solicitation-create-eval }
  - { name: llo-invite,          has_judge: false }
recurring_skills:
  - { name: solicitation-monitor, has_judge: false }
manual_skills:
  - { name: solicitation-review, has_judge: true, eval_skill: solicitation-review-eval }
---

# Solicitation Management Agent (Phase 7)

You run the solicitation phase of a CRISPR-Connect opportunity. By the
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
- Output: `solicitation/published.md`,
  `phases.solicitation-management.outputs.solicitation` populated in
  the current run's `run_state.yaml` with
  `{solicitation_id, public_url, deadline, status: open,
  labs_program_id, ...}`. `selected_llo` is populated by
  `solicitation-review` on award at `outputs.selected_llo`. The labs
  program int is cached durably at
  `opp.yaml.connect.program.labs_int_id`.
- **LLM-as-Judge:** unless `--no-evals` was passed, dispatch
  `solicitation-create-eval` after publish. Writes
  `verdicts/solicitation-create.yaml`.
- Halts the phase on a non-pass verdict — Step 2 doesn't send invites
  pointing at a solicitation that's failing rubric checks.

### Step 2: LLO Invite (to the solicitation)

Invoke the `llo-invite` skill.
- Input: PDD `## LLO Preference` (Preferred LLOs),
  `phases.solicitation-management.outputs.solicitation.{public_url, deadline}`
  from the current run's `run_state.yaml`
- Output: `solicitation/invitations.md` (per-recipient send log)
- No-op when the PDD has no `Preferred LLOs` — the solicitation is
  publicly listed at `public_url`; orgs find it via the labs portal.
- Sends emails via `email-communicator`. No Connect API calls — those
  happen only for the awardee inside `llo-onboarding` (Phase 8).

## Recurring (outside `/ace:run`)

While `phases.solicitation-management.outputs.solicitation.status == open`
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
  `award-record.md`, populates `phases.solicitation-management.outputs.selected_llo` in the current run's `run_state.yaml`
- **LLM-as-Judge:** unless `--no-evals` was passed, dispatch
  `solicitation-review-eval` after award. Writes
  `verdicts/solicitation-review.yaml`.

Only this skill unblocks Phase 8 (`execution-management`). Phase 8's
entry guard halts with an actionable message if
`phases.solicitation-management.outputs.selected_llo.org_slug` is empty in the current run's `run_state.yaml`.

## Pause-points

- **End of Step 2** (default `/ace:run` exit): `/ace:run` halts here.
  Phase 8 cannot start until `solicitation-review` populates
  `selected_llo`.
- **Inside `solicitation-review`**: HITL gate before `award_response`.

## Outputs at phase end (default run)

- `ACE/<opp-name>/runs/<run-id>/6-solicitation-management/solicitation-create_draft.md`
- `ACE/<opp-name>/runs/<run-id>/6-solicitation-management/solicitation-create_published.md`
- `ACE/<opp-name>/runs/<run-id>/6-solicitation-management/llo-invite_invitations.md`
- `phases.solicitation-management.outputs.solicitation.{solicitation_id, public_url, deadline, status: open, labs_program_id, ...}` (per-run only)
- `phases.solicitation-management.outputs.selected_llo` is populated only at award time by `solicitation-review`
- `verdicts/solicitation-create.yaml` (unless `--no-evals`)

## Completion

The phase is "complete" in the orchestrator's sense after Step 2. The
recurring monitor and manual review are NOT part of phase completion —
they happen post-`/ace:run` and gate Phase 8 entry.

After Step 2, write the `phases.solicitation-management` block per
`agents/ace-orchestrator.md § Phase Write-Back Contract`. Set
`phases.solicitation-management.verdict: halt-at-phase-7-to-8-boundary`
to mark the orchestrator's halt point. (0.13.116: legacy `gates.llo-invite`
+ `gates.solicitation-review` flips dropped. The Phase 7→8 halt is gated
on `phases.solicitation-management.outputs.selected_llo.org_slug` being
non-null in the current run's `run_state.yaml` — populated only by
manual `/ace:step solicitation-review` — which preserves the HITL
checkpoint without a `gates.<name>` field.)

## MCP Tools Used (across all skills in this phase)

- `connect-labs`: `create_solicitation`, `generate_criteria`,
  `list_solicitations`, `list_responses`, `get_response`, `list_reviews`,
  `create_review`, `award_response`
- `ace-gdrive`: `drive_create_file`, `drive_read_file`,
  `drive_update_file`, `drive_list_folder`
- `email-communicator`: Gmail send via GOG CLI

No `ace-connect` calls in this phase — Connect-side activity (program
invite, opp activation) starts in Phase 8.
