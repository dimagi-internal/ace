/**
 * dimagi-internal/ace#1643 — `app-release` released the CCHQ draft without ever
 * asking whether the draft still matched the Nova blueprint.
 *
 * `classifyAppDrift` is the pure decision behind the new `app-release § Step
 * 3a`. It lives in lib/ so the rule is executable rather than prose: the
 * failure being prevented is a release that reports success while shipping
 * content the operator already fixed.
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
      novaFieldCount: 50,
      hqDraftFieldCount: 48,
    });
    expect(d.drift).toBe(true);
    expect(d.action).toBe('reupload-reapply-settings-then-build');
    expect(d.conclusive).toBe(true);
    expect(d.reasons.join(' ')).toMatch(/edited the Nova app after app-deploy/);
  });

  it('a field-count mismatch alone is enough', () => {
    const d = classifyAppDrift({
      app: 'deliver',
      novaFieldCount: 50,
      hqDraftFieldCount: 48,
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
      novaFieldCount: 50,
      hqDraftFieldCount: 48,
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
      novaFieldCount: 31,
      hqDraftFieldCount: 31,
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
      novaFieldCount: 31,
      hqDraftFieldCount: 31,
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
      novaFieldCount: 50,
      hqDraftFieldCount: 50,
    });
    expect(d.drift).toBe(true);
    expect(d.conclusive).toBe(false);
    expect(d.action).toBe('reupload-reapply-settings-then-build');
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
    const d = classifyAppDrift({ app: 'learn', novaFieldCount: 31, hqDraftFieldCount: 31 });
    expect(d.conclusive).toBe(false);
    expect(d.drift).toBe(true);
  });
});

describe('the decision is auditable', () => {
  it('reasons is never empty on any branch', () => {
    for (const inputs of [
      { app: 'a' },
      { app: 'b', novaEditedSinceDeploy: false, deployedAt: DEPLOYED },
      { app: 'c', novaFieldCount: 1, hqDraftFieldCount: 2 },
    ]) {
      expect(classifyAppDrift(inputs).reasons.length).toBeGreaterThan(0);
    }
  });

  it('records every comparison it was able to make', () => {
    const d = classifyAppDrift({
      app: 'deliver',
      novaFieldCount: 50,
      hqDraftFieldCount: 48,
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
