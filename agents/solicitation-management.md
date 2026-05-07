---
name: solicitation-management
description: >
  Phase 6 of the CRISPR-Connect lifecycle: publish a solicitation derived
  from the PDD, invite PDD-named candidate LLOs to it by email, and stop.
  The review-and-award lifecycle continues via the manually-invoked
  solicitation-review skill (gated on a human-in-the-loop checkpoint
  before award_response is called). Phase 7 starts once an awardee is
  recorded in opp.yaml.selected_llo.
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

# Solicitation Management Agent (Phase 6)

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
- Input: approved PDD (`inputs/pdd.md`), `opp.yaml` (program_id,
  total_budget)
- Output: `solicitation/published.md`, `opp.yaml.solicitation` populated
  with `{solicitation_id, public_url, deadline, status: open}`,
  `opp.yaml.selected_llo` stubbed
- **LLM-as-Judge:** unless `--no-evals` was passed, dispatch
  `solicitation-create-eval` after publish. Writes
  `verdicts/solicitation-create.yaml`.
- Halts the phase on a non-pass verdict — Step 2 doesn't send invites
  pointing at a solicitation that's failing rubric checks.

### Step 2: LLO Invite (to the solicitation)

Invoke the `llo-invite` skill.
- Input: PDD `## LLO Preference` (Preferred LLOs),
  `opp.yaml.solicitation.public_url`,
  `opp.yaml.solicitation.deadline`
- Output: `solicitation/invitations.md` (per-recipient send log)
- No-op when the PDD has no `Preferred LLOs` — the solicitation is
  publicly listed at `public_url`; orgs find it via the labs portal.
- Sends emails via `email-communicator`. No Connect API calls — those
  happen only for the awardee inside `llo-onboarding` (Phase 7).

## Recurring (outside `/ace:run`)

While `opp.yaml.solicitation.status == open`, the orchestrator's recurring
loop calls `solicitation-monitor` to:
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
  `award-record.md`, populates `opp.yaml.selected_llo`
- **LLM-as-Judge:** unless `--no-evals` was passed, dispatch
  `solicitation-review-eval` after award. Writes
  `verdicts/solicitation-review.yaml`.

Only this skill unblocks Phase 7 (`execution-management`). Phase 7's
entry guard halts with an actionable message if
`opp.yaml.selected_llo.org_slug` is empty.

## Pause-points

- **End of Step 2** (default `/ace:run` exit): `/ace:run` halts here.
  Phase 7 cannot start until `solicitation-review` populates
  `selected_llo`.
- **Inside `solicitation-review`**: HITL gate before `award_response`.

## Outputs at phase end (default run)

- `ACE/<opp-name>/runs/<run-id>/6-solicitation-management/solicitation-create_draft.md`
- `ACE/<opp-name>/runs/<run-id>/6-solicitation-management/solicitation-create_published.md`
- `ACE/<opp-name>/runs/<run-id>/6-solicitation-management/llo-invite_invitations.md`
- `opp.yaml.solicitation.{solicitation_id, public_url, deadline, status: open}`
- `opp.yaml.selected_llo.*` (stubbed, null until award)
- `verdicts/solicitation-create.yaml` (unless `--no-evals`)

## Completion

The phase is "complete" in the orchestrator's sense after Step 2. The
recurring monitor and manual review are NOT part of phase completion —
they happen post-`/ace:run` and gate Phase 7 entry.

After Step 2, write the `phases.solicitation-management` block + flip
`gates.llo-invite` (to `pass` if named LLOs were emailed, or
`no-op-no-named-llos` if the PDD listed none) per
`agents/ace-orchestrator.md § Phase Write-Back Contract`. Set
`phases.solicitation-management.verdict: halt-at-phase-6-to-7-boundary`
to mark the orchestrator's halt point. Do NOT flip
`gates.solicitation-review` — that stays `pending` until manual
`/ace:step solicitation-review` runs after the deadline.

## MCP Tools Used (across all skills in this phase)

- `connect-labs`: `create_solicitation`, `generate_criteria`,
  `list_solicitations`, `list_responses`, `get_response`, `list_reviews`,
  `create_review`, `award_response`
- `ace-gdrive`: `drive_create_file`, `drive_read_file`,
  `drive_update_file`, `drive_list_folder`
- `email-communicator`: Gmail send via GOG CLI

No `ace-connect` calls in this phase — Connect-side activity (program
invite, opp activation) starts in Phase 7.
