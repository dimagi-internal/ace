# CRISPR-Test-004-Solicitation

A minimal fixture exercising the **Solicitation Management (Phase 6)**
flow added in 0.12.0. Synthetic — do not run live skills against it.

## What this fixture covers

- A PDD that populates all three optional `## Solicitation` fields:
  `Solicitation type` (EOI), `Response window` (21 days),
  `Response template` (5 questions).
- Two `Preferred LLOs` so `llo-invite` (the new Phase 6 step 2) has
  recipients to email.
- An `opp.yaml` with both `program_id` (Connect UUID) and
  `solicitation.labs_program_id` (labs integer) so `solicitation-create`
  can skip the `labs_context` resolution lookup and call
  `mcp__connect-labs__create_solicitation` directly.
- A pre-populated `solicitation/published.md` and `responses/` so
  downstream tests for `solicitation-monitor` and `solicitation-review`
  have realistic inputs without round-tripping through labs.

## What this fixture does NOT cover

- Phase 6 → 7 handoff (no `selected_llo` populated; that's the
  HITL-gated `solicitation-review` step).
- Phases 1-5 prior artifacts (no Nova app summaries, no Connect
  opportunity, no OCS chatbot config). This fixture is scoped to
  Phase 6 only.
