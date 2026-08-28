/**
 * dimagi-internal/ace#1643 — `app-release` released the CCHQ draft without ever
 * asking whether the draft still matched the Nova blueprint.
 *
 * `classifyAppDrift` is the pure decision behind the new `app-release § Step
 * 3a`. It lives in lib/ so the rule is executable rather than prose: the
 * failure being prevented is a release that reports success while shipping
 * content the operator already fixed.
 *
 * ## Red/green honesty
 *
 * `classifyAppDrift` is new in this change, so these are the executable SPEC
 * of the new decision rather than assertions that were red against the pre-fix
 * tree (the pre-fix tree had no decision to be red about — it went straight to
 * `commcare_make_build`). Their preventer value is forward-looking: the two
 * deliberate asymmetries below — counts can never earn the skip, unresolved
 * signals default to re-upload — cannot be quietly relaxed without this file
 * going red. The pre-fix reds are in
 * `test/skills/app-release-drift-check.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { classifyAppDrift, formatDriftDecision } from '../../lib/app-release-drift.js';

const DEPLOYED = '2026-08-24T23:12:00Z';

describe('drift → re-upload, re-apply settings, then build', () => {
  it('the live repro: the run edited Nova after app-deploy', () => {
    const d = classifyAppDrift({
      app: 'deliver',
      deployedAt: DEPLOYED,
      novaEditedSinceDeploy: true,
      novaVisibleFieldCount: 50,
      hqDraftVisibleFieldCount: 48,
    });
    expect(d.drift).toBe(true);
    expect(d.action).toBe('reupload-reapply-settings-then-build');
    expect(d.conclusive).toBe(true);
    expect(d.reasons.join(' ')).toMatch(/edited the Nova app after app-deploy/);
  });

  it('a field-count mismatch alone is enough', () => {
    const d = classifyAppDrift({
      app: 'deliver',
      novaVisibleFieldCount: 50,
      hqDraftVisibleFieldCount: 48,
    });
    expect(d.drift).toBe(true);
    expect(d.action).toBe('reupload-reapply-settings-then-build');
    expect(d.reasons.join(' ')).toMatch(/field count differs — Nova 50, HQ draft 48/);
  });

  it('a form-count mismatch alone is enough', () => {
    const d = classifyAppDrift({
      app: 'learn',
      novaFormCount: 7,
      hqDraftFormCount: 6,
      novaEditedSinceDeploy: false,
    });
    // The ordering signal says "clean" and the counts say otherwise. Any
    // positive signal wins — the counts are observing the draft directly.
    expect(d.drift).toBe(true);
    expect(d.reasons.join(' ')).toMatch(/form count differs/);
  });

  it('a Nova edit timestamp after the deploy is enough', () => {
    const d = classifyAppDrift({
      app: 'deliver',
      deployedAt: DEPLOYED,
      novaEditedAt: '2026-08-24T23:40:00Z',
    });
    expect(d.drift).toBe(true);
    expect(d.conclusive).toBe(true);
  });

  it('reports every firing signal, not just the first', () => {
    const d = classifyAppDrift({
      app: 'deliver',
      deployedAt: DEPLOYED,
      novaEditedAt: '2026-08-24T23:40:00Z',
      novaEditedSinceDeploy: true,
      novaFormCount: 3,
      hqDraftFormCount: 2,
      novaVisibleFieldCount: 50,
      hqDraftVisibleFieldCount: 48,
    });
    expect(d.reasons).toHaveLength(4);
  });
});

describe('no drift → build directly', () => {
  it('the Learn app in the live repro: edits landed BEFORE the deploy', () => {
    const d = classifyAppDrift({
      app: 'learn',
      deployedAt: DEPLOYED,
      novaEditedAt: '2026-08-24T22:58:00Z',
      novaFormCount: 6,
      hqDraftFormCount: 6,
      novaVisibleFieldCount: 31,
      hqDraftVisibleFieldCount: 31,
    });
    expect(d.drift).toBe(false);
    expect(d.action).toBe('build-directly');
    expect(d.conclusive).toBe(true);
    expect(d.reasons.join(' ')).toMatch(/no drift/);
  });

  it('an explicit "no Nova edit since deploy" clears it', () => {
    const d = classifyAppDrift({
      app: 'learn',
      deployedAt: DEPLOYED,
      novaEditedSinceDeploy: false,
      novaVisibleFieldCount: 31,
      hqDraftVisibleFieldCount: 31,
    });
    expect(d.drift).toBe(false);
    expect(d.action).toBe('build-directly');
    expect(d.reasons.join(' ')).toMatch(/no Nova edit after app-deploy/);
  });

  it('an edit at exactly the deploy instant is not drift', () => {
    const d = classifyAppDrift({
      app: 'learn',
      deployedAt: DEPLOYED,
      novaEditedAt: DEPLOYED,
    });
    expect(d.drift).toBe(false);
  });
});

describe('matching counts NEVER earn the skip on their own', () => {
  // Two of the three drifting Deliver edits in the repro — the extended
  // consent paragraph and the `area_ref` constraint — moved no count at all.
  // A count-only "all clear" would have shipped them stale on any run whose
  // edits happened to be text-only.
  it('agreeing counts with no ordering signal still re-uploads', () => {
    const d = classifyAppDrift({
      app: 'deliver',
      novaFormCount: 3,
      hqDraftFormCount: 3,
      novaVisibleFieldCount: 50,
      hqDraftVisibleFieldCount: 50,
    });
    expect(d.drift).toBe(true);
    expect(d.conclusive).toBe(false);
    expect(d.action).toBe('reupload-reapply-settings-then-build');
  });
});

describe('a hidden-inflated field count does not defeat an ordering-clear signal (ace#1789)', () => {
  // Live repro: bednet-check-2-visit/20260828-0629. Nova `get_app` counts
  // hidden fields (`user_score`, `qN_score`, `case_name`, `entity_key`, …);
  // the HQ draft walk never emits them. Raw Nova totals were Learn 44 /
  // Deliver 17 against HQ drafts of 32 / 14 — a mismatch on essentially
  // every ACE app — while both apps had `novaEditedSinceDeploy: false`.
  // Before this fix, ANY count mismatch forced `drift: true` before the
  // ordering fact was ever consulted, so the one signal that was supposed to
  // earn `build-directly` was unreachable.
  it('the run explicitly made no Nova edit since deploy: field mismatch is corroboration only', () => {
    const d = classifyAppDrift({
      app: 'learn',
      deployedAt: DEPLOYED,
      novaEditedSinceDeploy: false,
      // Raw, hidden-inflated Nova count vs. the HQ draft walk's count —
      // exactly the ace#1789 repro numbers.
      novaVisibleFieldCount: 44,
      hqDraftVisibleFieldCount: 32,
    });
    expect(d.drift).toBe(false);
    expect(d.action).toBe('build-directly');
    expect(d.conclusive).toBe(true);
    expect(d.reasons.join(' ')).toMatch(/no drift/);
    expect(d.reasons.join(' ')).toMatch(/not treated as drift/);
  });

  it('an ordering timestamp proving the edit was at/before deploy has the same effect', () => {
    const d = classifyAppDrift({
      app: 'deliver',
      deployedAt: DEPLOYED,
      novaEditedAt: '2026-08-24T22:58:00Z',
      novaVisibleFieldCount: 17,
      hqDraftVisibleFieldCount: 14,
    });
    expect(d.drift).toBe(false);
    expect(d.action).toBe('build-directly');
  });

  it('a form-count mismatch is NOT downgraded the same way — forms have no hidden-field confound', () => {
    const d = classifyAppDrift({
      app: 'learn',
      novaEditedSinceDeploy: false,
      novaFormCount: 7,
      hqDraftFormCount: 6,
    });
    expect(d.drift).toBe(true);
    expect(d.reasons.join(' ')).toMatch(/form count differs/);
  });

  it('a genuine field mismatch with NO ordering clearance still yields drift: true — the conservative default is not weakened', () => {
    const d = classifyAppDrift({
      app: 'deliver',
      novaVisibleFieldCount: 50,
      hqDraftVisibleFieldCount: 48,
    });
    expect(d.drift).toBe(true);
    expect(d.action).toBe('reupload-reapply-settings-then-build');
    expect(d.conclusive).toBe(true);
    expect(d.reasons.join(' ')).toMatch(/field count differs — Nova 50, HQ draft 48/);
  });
});

describe('unresolved signals default to re-upload, and say they defaulted', () => {
  it('no signals at all', () => {
    const d = classifyAppDrift({ app: 'deliver' });
    expect(d.drift).toBe(true);
    expect(d.conclusive).toBe(false);
    expect(d.reasons.join(' ')).toMatch(/drift undetermined/);
  });

  it('a deploy timestamp with no Nova counterpart is not an ordering fact', () => {
    const d = classifyAppDrift({ app: 'deliver', deployedAt: DEPLOYED });
    expect(d.drift).toBe(true);
    expect(d.conclusive).toBe(false);
    expect(d.signals.orderingComparable).toBe(false);
  });

  it('unparseable timestamps are treated as absent, not as equal', () => {
    const d = classifyAppDrift({
      app: 'deliver',
      deployedAt: 'not-a-date',
      novaEditedAt: 'also-not-a-date',
    });
    expect(d.drift).toBe(true);
    expect(d.conclusive).toBe(false);
    expect(d.signals.novaEditedAfterDeploy).toBeNull();
  });

  it('one comparable count pair is not an ordering fact either', () => {
    const d = classifyAppDrift({ app: 'learn', novaVisibleFieldCount: 31, hqDraftVisibleFieldCount: 31 });
    expect(d.conclusive).toBe(false);
    expect(d.drift).toBe(true);
  });
});

describe('the decision is auditable', () => {
  it('reasons is never empty on any branch', () => {
    for (const inputs of [
      { app: 'a' },
      { app: 'b', novaEditedSinceDeploy: false, deployedAt: DEPLOYED },
      { app: 'c', novaVisibleFieldCount: 1, hqDraftVisibleFieldCount: 2 },
    ]) {
      expect(classifyAppDrift(inputs).reasons.length).toBeGreaterThan(0);
    }
  });

  it('records every comparison it was able to make', () => {
    const d = classifyAppDrift({
      app: 'deliver',
      novaVisibleFieldCount: 50,
      hqDraftVisibleFieldCount: 48,
      novaFormCount: 3,
    });
    expect(d.signals.fieldCounts).toEqual({ nova: 50, hq: 48, comparable: true, mismatch: true });
    expect(d.signals.formCounts).toEqual({ nova: 3, hq: null, comparable: false, mismatch: false });
  });

  it('formats a one-line summary that names the verdict and the action', () => {
    const drift = formatDriftDecision(
      classifyAppDrift({ app: 'deliver', novaEditedSinceDeploy: true }),
    );
    expect(drift).toMatch(/^deliver: DRIFT → reupload-reapply-settings-then-build\./);

    const defaulted = formatDriftDecision(classifyAppDrift({ app: 'deliver' }));
    expect(defaulted).toMatch(/DRIFT \(undetermined — defaulted\)/);

    const clean = formatDriftDecision(
      classifyAppDrift({ app: 'learn', novaEditedSinceDeploy: false }),
    );
    expect(clean).toMatch(/^learn: NO DRIFT → build-directly\./);
  });
});
