import { describe, it, expect } from 'vitest';
import {
  checkVerdictManifestAgreement,
  formatAgreementFindings,
  legLabel,
  manifestLegStatus,
  type JourneyManifestLike,
  type VerdictLike,
} from '../../lib/verdict-manifest-agreement.js';

/**
 * The controls are the two REAL states of
 * `hh-poverty-targeting/20260828-0702`, an hour apart, read off Drive:
 * fileIds `1XTMxn0tc26vBH_bAGt3DbeR7TgRpql8B` (manifest) and
 * `1FN-CVQQGZq6pEvRiDRh8hleNgaSyPFHb` (shallow verdict). Field names and
 * values are transcribed from those files, not invented — a guard calibrated
 * against a shape nobody writes is a guard that never fires.
 *
 * A rubric/guard has to be validated against BOTH anchors before it ships: the
 * positive control proves it would have caught ace#1830, and the negative
 * control proves it is not an always-fires blocker (the ace#1026 class, which
 * is strictly worse than no guard).
 */

/** The manifest as written at 15:08Z — both legs recovered and passing. */
function recoveredManifest(): JourneyManifestLike {
  return {
    skill: 'app-screenshot-capture',
    target: 'hh-poverty-targeting',
    run_id: '20260828-0702',
    summary: {
      total_captures: 144,
      canonical_captures: 129,
      duplicate_captures: 15,
      legs_passed: 2,
      legs_attempted: 2,
    },
    journeys: [
      {
        journey_id: 'journey-learn-pass',
        app: 'learn',
        recipe_base: 'journey-learn',
        status: 'pass',
        recipe_status: 'pass',
        connect_verified: true,
        connect_learn_complete: true,
      },
      {
        journey_id: 'journey-deliver-submit',
        app: 'deliver',
        recipe_base: 'journey-deliver',
        status: 'pass',
        recipe_status: 'pass',
        connect_verified: true,
        visit_registered: true,
        recovered_in: '2026-08-29T15:02Z',
      },
    ],
  };
}

/** The shallow verdict as written at 14:10Z — the stale one ace#1830 is about. */
function staleShallowVerdict(): VerdictLike {
  return {
    skill: 'app-screenshot-capture',
    mode: 'shallow',
    overall_score: 3.0,
    verdict: 'fail',
    dimensions: { ux_smoke: { score: 1.5, weight: 1.0 } },
    per_item: [
      { ref: 'learn', score: 3, verdict: 'pass', note: 'Judged over the canonical Learn frames.' },
      {
        ref: 'deliver',
        score: 0,
        // NOTE: `incomplete` is off PerItemVerdictSchema (pass|warn|fail) and
        // was written anyway. The check reads what is on disk.
        verdict: 'incomplete',
        note: 'Not gradeable - the Deliver leg never reached status:pass, so no Deliver screenshots exist for this run.',
      },
    ],
    auto_surfaced: [
      {
        severity: 'BLOCKER',
        message: 'Deliver UX is ungraded for this run. Phase 9 activation must not proceed on the strength of the Learn leg alone.',
      },
    ],
  };
}

/** The shallow verdict after the 19:30Z hand re-grade — 2.5 / pass. */
function correctedShallowVerdict(): VerdictLike {
  return {
    skill: 'app-screenshot-capture',
    mode: 'shallow',
    overall_score: 2.5,
    verdict: 'pass',
    dimensions: { ux_smoke: { score: 2.5, weight: 1.0 } },
    per_item: [
      { ref: 'learn', score: 3, verdict: 'pass', note: 'Unchanged by this re-grade.' },
      { ref: 'deliver', score: 2, verdict: 'pass', note: 'RE-GRADED on the recovered artifact.' },
    ],
  };
}

describe('checkVerdictManifestAgreement — calibration controls', () => {
  it('POSITIVE CONTROL: catches ace#1830 — manifest both legs pass, verdict says Deliver ungradeable', () => {
    const result = checkVerdictManifestAgreement(recoveredManifest(), staleShallowVerdict());

    expect(result.ok).toBe(false);
    expect(result.disagreements).toHaveLength(1);

    const [d] = result.disagreements;
    expect(d.kind).toBe('stale-verdict');
    expect(d.leg).toBe('deliver');
    expect(d.journeyId).toBe('journey-deliver-submit');
    expect(d.manifestStatus).toBe('pass');
    expect(d.verdictDisposition).toBe('incomplete');
    expect(d.citation).toBe('dimagi-internal/ace#1830');

    // The passing leg must NOT be dragged in.
    const learn = result.compared.find((c) => c.leg === 'learn');
    expect(learn?.agrees).toBe(true);

    expect(formatAgreementFindings(result)[0]).toContain('[stale-verdict]');
  });

  it('NEGATIVE CONTROL: the corrected 2.5/pass verdict against the same manifest reports clean', () => {
    const result = checkVerdictManifestAgreement(recoveredManifest(), correctedShallowVerdict());

    expect(result.disagreements).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.compared).toHaveLength(2);
    expect(result.compared.every((c) => c.agrees)).toBe(true);
    expect(result.unmatchedRefs).toEqual([]);
  });

  it('ace#756 direction: a leg that did not pass cannot be graded `pass`', () => {
    const manifest = recoveredManifest();
    manifest.journeys![1].status = 'fail';
    manifest.journeys![1].recipe_status = 'fail';
    delete manifest.journeys![1].recovered_in;

    const result = checkVerdictManifestAgreement(manifest, correctedShallowVerdict());

    expect(result.ok).toBe(false);
    expect(result.disagreements).toHaveLength(1);
    expect(result.disagreements[0].kind).toBe('unsupported-pass');
    expect(result.disagreements[0].leg).toBe('deliver');
    expect(result.disagreements[0].citation).toBe('jjackson/ace#756');
  });

  it('a failed leg honestly graded as failed is agreement, not a finding', () => {
    const manifest = recoveredManifest();
    manifest.journeys![1].status = 'fail';

    const verdict = staleShallowVerdict();
    verdict.per_item![1].verdict = 'fail';

    expect(checkVerdictManifestAgreement(manifest, verdict).ok).toBe(true);
  });
});

describe('checkVerdictManifestAgreement — leg matching', () => {
  it('matches a ref spelled as the journey_id', () => {
    const verdict: VerdictLike = {
      per_item: [
        { ref: 'journey-learn-pass', score: 3, verdict: 'pass' },
        { ref: 'journey-deliver-submit', score: 2, verdict: 'pass' },
      ],
    };
    expect(checkVerdictManifestAgreement(recoveredManifest(), verdict).ok).toBe(true);
  });

  it('matches a ref spelled as the recipe_base (the pre-2026-05-27 convention)', () => {
    const verdict: VerdictLike = {
      per_item: [
        { ref: 'journey-learn', score: 3, verdict: 'pass' },
        { ref: 'journey-deliver', score: 2, verdict: 'pass' },
      ],
    };
    expect(checkVerdictManifestAgreement(recoveredManifest(), verdict).ok).toBe(true);
  });

  it('matches by substring when the manifest carries no `app` key', () => {
    const manifest: JourneyManifestLike = {
      journeys: [
        { journey_id: 'journey-deliver-submit', status: 'pass' },
      ],
    };
    const verdict: VerdictLike = { per_item: [{ ref: 'deliver', score: 2, verdict: 'incomplete' }] };
    const result = checkVerdictManifestAgreement(manifest, verdict);
    expect(result.ok).toBe(false);
    expect(result.disagreements[0].kind).toBe('stale-verdict');
    expect(result.disagreements[0].verdictRef).toBe('deliver');
  });

  it('falls back to recipe_status when `status` is absent', () => {
    const manifest: JourneyManifestLike = {
      journeys: [{ journey_id: 'journey-deliver-submit', app: 'deliver', recipe_status: 'pass' }],
    };
    expect(manifestLegStatus(manifest.journeys![0])).toBe('pass');
    const verdict: VerdictLike = { per_item: [{ ref: 'deliver', score: 0, verdict: 'fail' }] };
    expect(checkVerdictManifestAgreement(manifest, verdict).disagreements[0].kind).toBe('stale-verdict');
  });

  it('reports a leg the verdict never mentions, but only when the verdict grades other legs', () => {
    const learnOnly: VerdictLike = { per_item: [{ ref: 'learn', score: 3, verdict: 'pass' }] };
    const result = checkVerdictManifestAgreement(recoveredManifest(), learnOnly);
    expect(result.disagreements).toHaveLength(1);
    expect(result.disagreements[0].kind).toBe('unreported-leg');
    expect(result.disagreements[0].leg).toBe('deliver');
  });

  it('an incomplete-mode verdict (no per_item at all) makes no per-leg claim, so nothing fires', () => {
    // The documented blocked-before-grading shape: verdict: incomplete, no
    // per_item. Firing here would make the guard an always-fires blocker on
    // every legitimately-halted run.
    const incomplete: VerdictLike = {
      overall_score: 0,
      verdict: 'incomplete',
      live_state_verified: false,
    };
    const result = checkVerdictManifestAgreement(recoveredManifest(), incomplete);
    expect(result.ok).toBe(true);
    expect(result.compared).toHaveLength(2);
    expect(result.compared.every((c) => c.agrees)).toBe(true);
  });

  it('surfaces per_item refs that match no manifest leg, without calling them disagreements', () => {
    const verdict = correctedShallowVerdict();
    verdict.per_item!.push({ ref: 'videos', score: 3, verdict: 'pass' });
    const result = checkVerdictManifestAgreement(recoveredManifest(), verdict);
    expect(result.ok).toBe(true);
    expect(result.unmatchedRefs).toEqual(['videos']);
  });
});

describe('checkVerdictManifestAgreement — degenerate inputs', () => {
  it('reports clean on a manifest with no journeys', () => {
    expect(checkVerdictManifestAgreement({}, correctedShallowVerdict()).ok).toBe(true);
    expect(checkVerdictManifestAgreement(undefined, undefined).ok).toBe(true);
    expect(checkVerdictManifestAgreement(null, null).compared).toEqual([]);
  });

  it('ignores malformed journeys[] and per_item[] entries rather than throwing', () => {
    const manifest = { journeys: [null, 'nope', { app: 'deliver', status: 'pass' }] } as unknown as JourneyManifestLike;
    const verdict = { per_item: [null, { ref: 'deliver', verdict: 'fail' }] } as unknown as VerdictLike;
    const result = checkVerdictManifestAgreement(manifest, verdict);
    expect(result.disagreements).toHaveLength(1);
    expect(result.disagreements[0].kind).toBe('stale-verdict');
  });

  it('is case- and whitespace-insensitive on both sides', () => {
    const manifest: JourneyManifestLike = { journeys: [{ app: 'Deliver', status: ' PASS ' }] };
    const verdict: VerdictLike = { per_item: [{ ref: ' deliver ', verdict: 'Pass' }] };
    expect(checkVerdictManifestAgreement(manifest, verdict).ok).toBe(true);
  });

  it('legLabel prefers app, then journey_id, then recipe_base', () => {
    expect(legLabel({ app: 'deliver', journey_id: 'journey-deliver-submit' })).toBe('deliver');
    expect(legLabel({ journey_id: 'journey-deliver-submit' })).toBe('journey-deliver-submit');
    expect(legLabel({ recipe_base: 'journey-deliver' })).toBe('journey-deliver');
    expect(legLabel({})).toBe('(unnamed leg)');
  });
});
