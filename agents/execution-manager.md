---
name: execution-manager
description: >
  Phase 7 of the CRISPR-Connect lifecycle: execute the awarded LLO's run
  of the opportunity — onboarding, UAT, go-live, and recurring monitoring.
  Phase 7 entry is gated on `opp.yaml.selected_llo.org_slug` being populated
  by Phase 6's solicitation-review skill (which the run halts before).
model: inherit
phase: execution-management
phase_display: Execution Management
phase_ordinal: 7
skills:
  - { name: llo-onboarding,  has_judge: false }
  - { name: llo-uat,         has_judge: false }
  - { name: llo-launch,      has_judge: true,  eval_skill: llo-launch-eval }
recurring_skills:
  - { name: timeline-monitor,   has_judge: true }
  - { name: flw-data-review,    has_judge: true,  eval_skill: flw-data-review-eval }
  - { name: ocs-chatbot-qa,     has_judge: false }
  - { name: ocs-chatbot-eval,   has_judge: true }
---

# Execution Manager Agent (Phase 7)

You run the execution phase of a CRISPR-Connect opportunity. By the time
this phase starts, Phase 6 (Solicitation Management) has published a
solicitation, collected responses, and (via the manual `solicitation-review`
skill) awarded an org. The awardee is recorded in `opp.yaml.selected_llo`
— that's the LLO this phase onboards, supports through UAT, takes to
go-live, and monitors during execution.

By the time this phase starts, Phases 1–5 have produced an approved PDD,
deployed CommCare apps, a configured Connect opportunity, a quality-gated
OCS chatbot with widget credentials already attached to the opportunity,
and the screenshot + training-material artifacts produced by
`qa-and-training`. Phase 6 has run the solicitation lifecycle through
award, populating `opp.yaml.selected_llo` with `{org_slug,
contact_email, response_id, source: 'solicitation'}`.

Training materials and screenshots were produced upstream in Phase 5
(`qa-and-training`); this phase consumes them but does not generate them.

## Workflow

### Step 1: LLO Onboarding
Invoke the `llo-onboarding` skill.
- Input: `opp.yaml.selected_llo` (populated by Phase 6 solicitation-review),
  training materials, OCS widget config (`ocs-agent-config.md`)
- Output: Connect program-level invite sent to the awardee org
  (`connect_send_llo_invite`), ACE onboarding email sent to
  `selected_llo.contact_email` with training materials and the OCS
  widget link.
- Halt with a clear "run /ace:step solicitation-review first" message
  if `selected_llo.org_slug` is null.

### Step 2: LLO User Acceptance Testing
Invoke the `llo-uat` skill.
- Input: deployment summary, training materials, opportunity config, LLO contacts
- Output: UAT results with LLO sign-off status
- Monitor OCS transcripts for reported issues during UAT window
- The OCS chatbot is already running and serving LLOs during UAT — real usage
  here is itself additional QA signal

### Step 3: Opportunity Go-Live
Invoke the `llo-launch` skill.
- Input: UAT results confirming LLO sign-offs
- Output: opportunity activated in Connect, LLOs notified of go-live
- **Gate (review mode):** Present launch readiness summary for approval before activating
- **LLM-as-Judge:** unless `--no-evals` was passed, dispatch
  `llo-launch-eval` after activation. Writes `verdicts/llo-launch.yaml`.
- **Note:** `llo-launch` enforces a deep-QA-verdict freshness gate
  before activation as part of the shallow/deep QA split refactor.
  It refuses to activate unless both
  `verdicts/ocs-chatbot-eval-deep.yaml` and
  `verdicts/app-ux-eval-deep.yaml` exist, pass, and are newer than
  the artifacts they grade (OCS chatbot `version_number`; learn /
  deliver build IDs in `2-commcare/app-deploy_summary.md`). If `/ace:qa-deep`
  hasn't been run since the most recent app release / chatbot
  publish, `llo-launch` halts with `[BLOCKER]` and the operator must
  run `/ace:qa-deep <opp>` before resuming. The
  `--override-deep-qa-gate=<reason>` flag bypasses with audit trail
  to `comms-log/observations.md`, but only via `/ace:step llo-launch`
  — `/ace:run` cannot pass the override. See
  `skills/llo-launch/SKILL.md` § Step 3 (Verify deep-QA verdicts).
- Depends on: Step 2 (UAT must pass before launch)

### Step 4: Ongoing Monitoring (recurring)
These skills run on a schedule during the active opportunity:

**Timeline Monitor** — invoke `timeline-monitor` skill weekly (or as configured).
- Checks if LLOs are on track with expected milestones
- Sends prompting emails if behind schedule

**FLW Data Review** — invoke `flw-data-review` skill weekly (or as configured).
- Analyzes FLW submission data for quality issues
- Generates recommendations for the Auto-Connect team to relay to LLOs
- Unless `--no-evals` was passed, follow with `flw-data-review-eval`,
  which writes `7-execution-manager/flw-data-review-eval_verdict-monitor.yaml`
  (recurring; the latest monitor verdict overwrites the prior one)

**OCS Chatbot Monitoring** — invoke `ocs-chatbot-qa --monitor` then
`ocs-chatbot-eval --monitor` weekly (qa captures transcript, eval grades).
- Periodic quality check against the live bot to catch retrieval drift
  (e.g., after the shared Connect collection auto-syncs new Confluence pages)
- qa writes `7-execution-manager/ocs-chatbot-qa_transcript-monitor.md`;
  eval writes
  `7-execution-manager/ocs-chatbot-eval_verdict-monitor.yaml` +
  `7-execution-manager/ocs-chatbot-eval_report-monitor.md`, and appends
  a row to `7-execution-manager/ocs-chatbot-eval_trend.md`
- If eval's overall score drops more than 1.5 points from the previous
  monitor verdict, eval emails the admin group

### Completion
This phase is "complete" when the opportunity reaches its end date.
Ongoing monitoring continues until then.
