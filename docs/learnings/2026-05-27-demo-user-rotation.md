# Demo-user rotation: `+74260000100` → `+74260000101` (2026-05-27)

## What happened

Phase 6 (`qa-and-training`) on `bednet-spot-check/20260526-2310` halted at `app-screenshot-capture` because the `J1` recipe couldn't find the run's opp tile in `rvJobList`. Initial hypothesis was server-side sync delivery latency. Investigation traced the actual class.

## Root cause

The demo test user `+74260000100` had accumulated `OpportunityAccess` rows for ~10 prior runs (Turmeric x2, Malaria ITN FGD x2, Malaria ITN Exploration, Malaria ITN Multi-Stage, LEEP x2, Bednet x2, etc.). The mobile-facing list endpoint (`commcare_connect/opportunity/mobile.py:38-43` `OpportunityViewSet`) queries by:

```python
return Opportunity.objects.filter(opportunityaccess__user=self.request.user)
```

— **no `active=True` filter**. So every opp the user has ever started keeps showing on every sync, forever. The Connect-side fix (`commcare_connect/opportunity/deletion.py::delete_opportunity()`) cascade-deletes `OpportunityAccess` but exists only as a Celery task with no REST endpoint, no Django view, and no ACE atom.

Recipe-side, `mcp/mobile/recipes/static/connect-claim-opp.yaml` does `scrollUntilVisible(timeout: 20000)` against `${OPP_NAME}`. With 10+ accumulated tiles, 20 s of scrolling isn't enough budget to reach a buried target, and the recipe halts with no usable diagnostic ("tile not found" looks identical to "invite never delivered").

## Two failure classes, two fixes

**Class 1 — accumulation:** `OpportunityAccess` rows persist for the lifetime of the demo user. The only escape with today's atoms is rotating to a fresh phone.

**Class 2 — scroll budget (not yet fixed):** `connect-claim-opp.yaml`'s 20 s `scrollUntilVisible` is fragile under any rotation cadence longer than ~5 runs. Tracked separately.

## The fix (Class 1)

Rotated 1Password `AI-Agents/connect-test-user/phone` from `+74260000100` → `+74260000101` (+ matching `phone-local`). Phone fields are 1P-source-of-truth, propagated to every machine via `op inject` (preserving local-only secrets via `bin/ace-setup`).

Same PR centralized test fixture references behind `test/fixtures/test-phone.ts` so future rotations are one-line edits in 1P + one-line edits in the fixture file, not 45-file rewrites. Production code that previously hardcoded `+74260000100` (one site: `scripts/probe-flw-invite.ts`) now reads `process.env.ACE_E2E_PHONE`.

## Operator notes

- The new user `+74260000101` is a brand-new identity on Connect — first dispatch will register it from scratch. Steady-state cost ~20 s per `mobile_register_test_user` (per `docs/learnings/2026-05-14-demo-user-no-otp.md`).
- The old `+74260000100` user's accumulated `OpportunityAccess` rows are still on the server (we soft-deactivated the opps but didn't touch the user rows). Reuse of `+74260000100` for ad-hoc probes still works; the demo user just has 10+ stale tiles on any device it logs into.
- **When to rotate again:** the moment `connect-claim-opp.yaml` scroll budget becomes unreliable for the active user. Cleaner heuristic: rotate after every N runs (TBD, probably 5-10) until the durable fix lands.

## Durable fix (out of scope here)

- Expose `delete_opportunity()` via Connect REST (upstream PR) → add `connect_delete_opportunity` atom → make `/ace:sweep connect` actually clear device tiles.
- OR: switch `connect-claim-opp.yaml` to query the opp's job-card URL directly (bypassing list scrolling) once Connect's deep-link surface stabilizes.

## Pointers

- Connect mobile endpoint: `commcare_connect/opportunity/mobile.py::OpportunityViewSet`
- Connect hard-delete: `commcare_connect/opportunity/deletion.py::delete_opportunity`
- ACE sweep procedure: `agents/sweep.md` (the `connect` system stops at soft-deactivate)
- Centralized test phone: `test/fixtures/test-phone.ts`
- Demo-prefix mechanism: `docs/learnings/2026-05-14-demo-user-no-otp.md`
