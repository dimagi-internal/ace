# End-to-End Walk-Through Validation (2026-04-16)

Desk-trace of `/ace:run ACE-Test-001 --dry-run` against the current
(post-0.3.1) plugin: 6-phase orchestrator, 22 skills, PDD terminology.
Updates and supersedes the 2026-04-08 validation (which predated the
0.2.0 phase restructure and 0.3.0 PDD rename).

**This is not an actual `/ace:run`.** That still requires a separate
Claude Code session with the `ace-gdrive` and `ace-ocs` MCP servers
active and a Drive folder for the opportunity. This walk-through is the
next-best check: it confirms the orchestrator's phase ordering, each
SKILL.md's input/output contract, and the artifact-manifest handoffs
are internally consistent with the current fixture contents.

Companion fixture (`test/fixtures/ACE-Test-003-Turmeric/`) ships the
same day as a **complete** end-to-end stub with phase-4–6 artifacts
populated, so CI can catch manifest drift all the way through closeout.
`ACE-Test-001` remains a partial (Phase-1–3) fixture used for
scenario-style input testing into Phase 5 (`ocs-agent-setup`).

## State schema refresh

`ACE-Test-001/state.yaml` was rewritten to match the 6-phase
orchestrator. Before: a flat map of 19 skills in the pre-0.2.0 order.
After: phases → skills nested map covering all 22 skills + the three
`ocs-chatbot-qa` modes (`quick`, `deep`, `monitor`). Gate list updated
to the five actual review-mode gates (was missing `ocs-chatbot-qa-deep`,
wasn't tracking `llo-launch`).

## Per-phase trace against ACE-Test-001

Phase signature is `input → skill → output`, cross-checked against
`lib/artifact-manifest.ts`. "OK" = inputs exist in the fixture,
skill contract is readable, expected outputs line up with the manifest.
"Gap" = missing input or contract mismatch.

### Phase 1 — Design Review

| Skill | Input state | Output contract | Verdict |
|---|---|---|---|
| `idea-to-pdd` | `idea.md` ✓ | `pdd.md` ✓ (already in fixture) | OK |
| `pdd-to-test-prompts` | `pdd.md` ✓ | `test-prompts.md` | Gap — fixture missing `test-prompts.md`. Intentional: this is a Phase-1 output, so running the skill against the fixture *produces* it. Noted in `artifact-manifest.test.ts` expectedMissing list. ACE-Test-003-Turmeric ships it populated. |

**Gate:** operator approves `pdd.md` before Phase 3.

### Phase 3 — CommCare Setup

| Skill | Input state | Output contract | Verdict |
|---|---|---|---|
| `pdd-to-learn-app` | `pdd.md` ✓ | `apps/learn-app.json`, `app-summaries/learn-app-summary.md` | Learn app JSON would be produced; summary already in fixture |
| `pdd-to-deliver-app` | `pdd.md` ✓ | `apps/deliver-app.json`, `app-summaries/deliver-app-summary.md` | Same — summary present, JSON absent |
| `app-deploy` | `apps/*.json` (absent) | `deployment-summary.md` ✓ | Fixture ships a stub `deployment-summary.md` from the 2026-04-08 walk-through so downstream skills (`app-test`, `connect-opp-setup`) can consume it without running upstream first |
| `app-test` | `deployment-summary.md` ✓, `app-summaries/*` ✓ | `test-results/{test-plan,test-results,bugs}.md` | Gap — `test-results/` absent. ACE-Test-003 ships these populated |
| `training-materials` | `app-summaries/*` ✓, `pdd.md` ✓ | `training-materials/{llo-manager-guide,flw-training-guide,quick-reference,faq}.md` ✓ | OK — already in fixture |

**Gate:** operator approves `deployment-summary.md` before Phase 4.

### Phase 4 — Connect Setup

| Skill | Input state | Output contract | Verdict |
|---|---|---|---|
| `connect-program-setup` | `pdd.md` ✓ | `connect-setup/program.md` ✓ | OK |
| `connect-opp-setup` | `program.md` ✓, `pdd.md` ✓, `deployment-summary.md` ✓ | `connect-setup/opportunity.md` ✓ | OK |
| `llo-invite` | `opportunity.md` ✓, `pdd.md` ✓ | `connect-setup/invites.md` ✓ | OK |

**Gate:** operator approves `invites.md` (invites are *prepared* here, *sent* in Phase 6 after the OCS widget URL is known).

### Phase 5 — OCS Setup

| Skill | Input state | Output contract | Verdict |
|---|---|---|---|
| `ocs-agent-setup` | `pdd.md` ✓, `training-materials/*` ✓, `app-summaries/*` ✓, `opportunity.md` ✓ | `ocs-agent-config.md` | Inputs OK; output absent in ACE-Test-001 (this is the skill the fixture is designed to feed) |
| `ocs-chatbot-qa --quick` | `experiment_id` from above | stdout report | Smoke gate, no file artifact |
| `ocs-chatbot-qa --deep` | `experiment_id`, `test-prompts.md` | `qa-reports/YYYY-MM-DD-ocs-qa.md` | Gap — requires `test-prompts.md` from Phase 1. This is exactly the silent-failure mode that P2's prereq check catches |
| (manual step) | `ocs-agent-config.md` | `ocs-setup/widget-handoff.md` | Operator pastes creds into Connect until `update_opportunity` API lands |

**Gate:** operator approves the deep QA report.

### Phase 6 — LLO Management

| Skill | Input state | Output contract | Verdict |
|---|---|---|---|
| `llo-onboarding` | `invites.md` ✓, `training-materials/*` ✓, `ocs-agent-config.md` | `comms-log/onboarding-emails.md` | Input OK modulo ocs-agent-config which is a Phase 5 output |
| `llo-uat` | `deployment-summary.md` ✓, `training-materials/*` ✓, `opportunity.md` ✓ | `uat/uat-results.md` | Inputs OK |
| `llo-launch` | `uat-results.md` | `launch/launch-record.md` | Depends on UAT |
| `timeline-monitor` (recurring) | `pdd.md` ✓ + `state.yaml` | `monitoring/YYYY-MM-DD-timeline-check.md` | Recurring output is dated, optional |
| `flw-data-review` (recurring) | FLW submission data | `data-reviews/YYYY-MM-DD-review.md` | Requires runtime data not in any fixture |
| `ocs-chatbot-qa --monitor` (recurring) | live bot | `qa-reports/trend.md` + dated entries | Requires live bot |

**Gate:** operator approves `launch-record.md` before opportunity activates.

### Phase 7 — Closeout

| Skill | Input state | Output contract | Verdict |
|---|---|---|---|
| `opp-closeout` | `opportunity.md` ✓ | `closeout/invoices.md` | — |
| `llo-feedback` | `invites.md` ✓ | `closeout/llo-feedback.md` | — |
| `learnings-summary` | all upstream artifacts | `closeout/learnings.md`, optional `closeout/new-pdd.md` | — |
| `cycle-grade` | all artifacts + feedback + learnings | `closeout/cycle-grade.md` | — |

ACE-Test-001 doesn't exercise Phase 7. ACE-Test-003-Turmeric ships
populated closeout stubs so the artifact-manifest test can span the full
lifecycle.

## Gaps surfaced by this trace

1. **Silent prereq failure.** `/ace:step ocs-chatbot-qa ACE-Test-001 --deep` today runs without noticing that `test-prompts.md` is absent. Fixed by P2 (prereq check in `/ace:step` via `artifactsConsumedBy`).
2. **Fixture coverage stops at Phase 4.** `artifact-manifest.test.ts` validates ACE-Test-001 only `upToPhase: 'connect'`. Phases 4–6 are silently uncovered. Fixed by P3 (new ACE-Test-003-Turmeric + test span extended to `'closeout'`).
3. **`state.yaml` was stale.** The flat 19-skill list predated 0.2.0; two skills were missing entirely (`pdd-to-test-prompts`, `ocs-chatbot-qa` in any form). Fixed in this cycle (refreshed to 6-phase nested schema).

## What this walk-through does NOT cover

- **Actual MCP round-trips.** Dispatching skills with live `ace-gdrive` and `ace-ocs` sessions is a separate qualification (OCS side has E2E integration tests gated by `OCS_INTEGRATION=1`).
- **Recurring-skill cadence.** Phase 6 recurring skills have no "completion" in a dry-run trace; they'd need a simulated schedule.
- **LLM-as-Judge self-eval behavior.** Skills with `has_judge: true` run a self-evaluation that we're not simulating here.

## Caveats

Skills are non-deterministic (LLM output varies). The validation here is
structural ("the output should have these sections with these inputs"),
not literal. The fixture artifacts are target shapes, not golden outputs.
