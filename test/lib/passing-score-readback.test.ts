/**
 * dimagi-internal/ace#1350 — `connect_create_opportunity` silently discards
 * `passing_score` when the `CommCareApp` row already exists, and the score is
 * shared by every opportunity in the org wired to that HQ app.
 *
 * `commcare_connect/opportunity/forms.py:556-587`
 * (`dimagi/commcare-connect@5f69bb3d`):
 *
 *     app, created = CommCareApp.objects.get_or_create(
 *         cc_app_id=..., cc_domain=..., organization=..., hq_server=...,
 *         defaults=defaults,          # <- includes passing_score
 *     )
 *     if not created and update_existing:   # update_existing=False on CREATE
 *
 * The row is keyed on `(cc_app_id, cc_domain, organization, hq_server)` — NOT
 * by opportunity. Two silent consequences:
 *
 *  1. The score is SHARED. Every opp in the org wired to the same HQ Learn app
 *     reads one `CommCareApp.passing_score`; changing it for one changes the
 *     gate for all. Same shape as the documented `DeliverUnit` sharing gotcha.
 *  2. On CREATE against an existing row the posted value is DROPPED —
 *     `get_or_create` ignores `defaults` when the row exists, and the create
 *     path passes `update_existing=False`.
 *
 * ACE has not been bitten only by an unstated invariant: every /ace:run builds
 * a fresh Nova Learn app, so every create posts a new `cc_app_id` and always
 * takes `created=True`. That breaks the moment anything reuses an HQ Learn app
 * — a forked run, a hand-wired opp, a Phase 4 re-mint against the same
 * release, or an opp created against a prior run's app to save a build.
 *
 * The read-back `[BLOCKER]` added 2026-08-14 DOES fire — but it reads as
 * server drift, so the operator debugs the wrong thing. This classifier names
 * the cause and routes to the repair atom that now exists
 * (`connect_set_learn_passing_score`, ace#1341 / PR #1348).
 */
import { describe, it, expect } from 'vitest';
import { classifyPassingScoreReadback } from '../../lib/passing-score-readback.js';

describe('classifyPassingScoreReadback (#1350)', () => {
  it('is silent when the score round-trips', () => {
    const r = classifyPassingScoreReadback({ posted: 100, readBack: 100, pddDecided: true });
    expect(r.severity).toBe('ok');
    expect(r.repair).toBeUndefined();
  });

  it('names ROW REUSE as the cause when the PDD decided and the value came back different', () => {
    const r = classifyPassingScoreReadback({ posted: 100, readBack: 80, pddDecided: true });
    expect(r.severity).toBe('blocker');
    expect(r.message).toMatch(/CommCareApp row/i);
    expect(r.message).toMatch(/already existed/i);
    expect(r.message, 'must not read as generic server drift').toMatch(/discard|ignored/i);
  });

  it('routes to the repair atom rather than halting on an unexplained symptom', () => {
    const r = classifyPassingScoreReadback({ posted: 100, readBack: 80, pddDecided: true });
    expect(r.repair?.atom).toBe('connect_set_learn_passing_score');
    expect(r.repair?.passing_score).toBe(100);
  });

  it('warns that the repair moves the gate for every opp sharing the app', () => {
    const r = classifyPassingScoreReadback({ posted: 100, readBack: 80, pddDecided: true });
    expect(r.repair?.caution).toMatch(/every opportunity/i);
  });

  it('stays INFO when ACE defaulted and the server returned its own', () => {
    const r = classifyPassingScoreReadback({ posted: 80, readBack: 70, pddDecided: false });
    expect(r.severity).toBe('info');
    expect(r.repair).toBeUndefined();
  });

  it('treats an unreadable read-back as a blocker, not a pass', () => {
    const r = classifyPassingScoreReadback({ posted: 100, readBack: undefined, pddDecided: true });
    expect(r.severity).toBe('blocker');
    expect(r.message).toMatch(/could not be read/i);
  });
});
