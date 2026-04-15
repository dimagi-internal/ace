# CRISPR-Test-003-Turmeric — Complete E2E Test Fixture

Synthetic opportunity seeded from `docs/examples/pdd-turmeric-market-survey.md`.
Unlike CRISPR-Test-001 / CRISPR-Test-002 (which stop at Phase 3 inputs),
this fixture ships **every required artifact for all 6 phases** as
structurally-valid stubs. The goal is to exercise the full lifecycle in
the artifact-manifest test and catch manifest drift across the whole
pipeline — not just Phases 1–3.

## Purpose

- **Full-lifecycle manifest validation.** `artifact-manifest.test.ts`
  validates this fixture `upToPhase: 'closeout'` with zero missing
  required files and zero unexpected files.
- **Complete-case regression testing.** When any SKILL.md changes its
  input/output contract, trace against this fixture to see whether the
  whole downstream pipeline still has what it needs.
- **Dry-run lifecycle simulation.** `/ace:run CRISPR-Test-003-Turmeric
  --mode review --dry-run` exercises the orchestrator's phase-by-phase
  dispatch logic.

## Archetype

`atomic-visit` — one FLW visit = one vendor photo + GPS + form. This is
the clean case that maps directly onto the standard Connect delivery
model. Focus-group / qualitative archetypes are covered by
CRISPR-Test-002 instead.

## Contents

All files are synthetic stubs. Real values would be populated by running
the upstream skill against live services (CCHQ, Connect, OCS, Jira).

- `idea.md`, `pdd.md`, `test-prompts.md`, `state.yaml` — Phase 1
- `apps/`, `app-summaries/`, `deployment-summary.md`, `test-results/`,
  `training-materials/` — Phase 2
- `connect-setup/{program,opportunity,invites}.md` — Phase 3
- `ocs-agent-config.md`, `ocs-setup/widget-handoff.md` — Phase 4
- `comms-log/onboarding-emails.md`, `uat/uat-results.md`,
  `launch/launch-record.md` — Phase 5
- `closeout/{invoices,llo-feedback,learnings,cycle-grade}.md` — Phase 6

## Do Not

- Run any non-`--dry-run` skill against this fixture — it contains fake
  email addresses, fake Jira refs, fake app IDs. Real execution would
  send real messages / tickets.
- Treat the stub contents as reference examples of what good output
  should look like. They're structurally valid but minimally detailed.
