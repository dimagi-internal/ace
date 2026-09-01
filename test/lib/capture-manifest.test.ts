/**
 * dimagi-internal/ace#1304 — #866's CONSUMER half.
 *
 * #866 fixed the producer: `app-screenshot-capture` hashes every capture and
 * marks byte-identical frames `duplicate_of: <canonical-step>`. That works —
 * the live run marked all 14 duplicates correctly.
 *
 * Nothing consumes it. Two of six training producers went on to caption a
 * `duplicate_of` frame as a distinct state, and it took two independent
 * `-eval` skills to catch — not the manifest. Both producers self-scored their
 * image handling near-perfect (`training-flw-guide` gave itself
 * `image_hygiene: 10.0`) because each verified every fileId RESOLVES, which
 * was true. **Existence and distinctness are different properties, and only
 * existence was being asserted.**
 *
 * `training-deck-generate` handled it correctly, so the contract is
 * followable — it is just advisory prose in a YAML that three skills each have
 * to remember, which is the shape of every convention that has failed under
 * load here. A helper that can only hand back canonical captures removes the
 * remembering.
 */
import { describe, it, expect } from 'vitest';

import {
  canonicalCaptures,
  resolveCanonicalStep,
  findDuplicateCitations,
  isAutoNamedCapture,
  assignCanonicalDuplicates,
} from '../../lib/capture-manifest.js';

/** The live shape from the run in the issue (aliases + their canonicals). */
const MANIFEST = {
  captures: [
    { step: 'journey-learn-module-1', file_id: 'f1' },
    { step: 'journey-learn-assessment-result', file_id: 'f2' },
    { step: 'journey-learn-final', file_id: 'f3', duplicate_of: 'journey-learn-assessment-result' },
    { step: 'deliver-sync-pre', file_id: 'f4', duplicate_of: 'journey-deliver-form-open' },
    { step: 'journey-deliver-form-open', file_id: 'f5' },
  ],
};

describe('capture-manifest consumer helpers (#1304)', () => {
  it('canonicalCaptures drops every alias', () => {
    const steps = canonicalCaptures(MANIFEST).map((c) => c.step);
    expect(steps).toEqual([
      'journey-learn-module-1',
      'journey-learn-assessment-result',
      'journey-deliver-form-open',
    ]);
    expect(steps).not.toContain('journey-learn-final');
  });

  it('resolveCanonicalStep maps an alias back to the moment it actually shows', () => {
    expect(resolveCanonicalStep(MANIFEST, 'journey-learn-final')).toBe(
      'journey-learn-assessment-result',
    );
    // A canonical step resolves to itself, so callers can resolve unconditionally.
    expect(resolveCanonicalStep(MANIFEST, 'journey-learn-module-1')).toBe('journey-learn-module-1');
    // An unknown step is reported as unknown rather than silently echoed —
    // citing a capture that does not exist is its own defect (ace#913).
    expect(resolveCanonicalStep(MANIFEST, 'nope')).toBeUndefined();
  });

  it('findDuplicateCitations flags exactly the two live instances', () => {
    // What training-llo-guide and training-flw-guide actually cited.
    const cited = ['journey-learn-final', 'deliver-sync-pre', 'journey-learn-module-1'];
    const bad = findDuplicateCitations(MANIFEST, cited);
    expect(bad.map((b) => b.step)).toEqual(['journey-learn-final', 'deliver-sync-pre']);
    expect(bad[0].canonical).toBe('journey-learn-assessment-result');
  });

  it('passes an artifact citing only canonical captures', () => {
    expect(
      findDuplicateCitations(MANIFEST, ['journey-learn-module-1', 'journey-deliver-form-open']),
    ).toEqual([]);
  });

  it('tolerates a manifest with no duplicates at all', () => {
    const clean = { captures: [{ step: 'a', file_id: 'x' }] };
    expect(canonicalCaptures(clean)).toHaveLength(1);
    expect(findDuplicateCitations(clean, ['a'])).toEqual([]);
  });

  it('is inert on a malformed/absent manifest rather than throwing mid-phase', () => {
    expect(canonicalCaptures(undefined)).toEqual([]);
    expect(canonicalCaptures({} as never)).toEqual([]);
    expect(findDuplicateCitations(undefined, ['a'])).toEqual([]);
  });
});

describe('assignCanonicalDuplicates — the PRODUCER half', () => {
  it('recognises Maestro auto-named boundary frames', () => {
    expect(isAutoNamedCapture('step-010-assertCondition-org.commcare.dalvikid_vi')).toBe(true);
    expect(isAutoNamedCapture('step-7-tapOn-Start')).toBe(true);
    // Real capture names must never be mistaken for auto-named ones, including
    // ones that merely contain the word or a digit run.
    expect(isAutoNamedCapture('deliver-launch-download-gate')).toBe(false);
    expect(isAutoNamedCapture('journey-learn-posttest-q9')).toBe(false);
    expect(isAutoNamedCapture('learn-tap-module-after-Pre-test')).toBe(false);
    expect(isAutoNamedCapture('step-by-step-intro')).toBe(false);
  });

  it('keeps the FIRST frame in recipe order when both names are meaningful', () => {
    const out = assignCanonicalDuplicates([
      { step: 'journey-deliver-submitted-confirmation', md5: 'aaa', takenAt: '2026-09-01T09:55:38Z' },
      { step: 'deliver-sync-pre', md5: 'aaa', takenAt: '2026-09-01T09:55:56Z' },
    ]);
    const byStep = Object.fromEntries(out.map((f) => [f.step, f.duplicate_of]));
    expect(byStep['journey-deliver-submitted-confirmation']).toBeUndefined();
    expect(byStep['deliver-sync-pre']).toBe('journey-deliver-submitted-confirmation');
  });

  it('an auto-named frame YIELDS to a named twin even when it was taken first', () => {
    // The exact regression from turmeric-market-study/20260828-1108: the
    // auto-named frame led by 0.28s, so recipe order alone made an opaque
    // string canonical and the deck would have captioned a slide with it.
    const out = assignCanonicalDuplicates([
      {
        step: 'step-010-assertCondition-org.commcare.dalvikid_vi',
        md5: 'bbb',
        takenAt: '2026-09-01T09:48:57.990Z',
      },
      { step: 'deliver-launch-download-gate', md5: 'bbb', takenAt: '2026-09-01T09:48:58.271Z' },
    ]);
    const byStep = Object.fromEntries(out.map((f) => [f.step, f.duplicate_of]));
    expect(byStep['deliver-launch-download-gate']).toBeUndefined();
    expect(byStep['step-010-assertCondition-org.commcare.dalvikid_vi']).toBe(
      'deliver-launch-download-gate',
    );
  });

  it('leaves distinct frames alone and never invents a duplicate_of', () => {
    const out = assignCanonicalDuplicates([
      { step: 'a', md5: '1', takenAt: '2026-09-01T00:00:01Z' },
      { step: 'b', md5: '2', takenAt: '2026-09-01T00:00:02Z' },
      { step: 'c', md5: '3', takenAt: '2026-09-01T00:00:03Z' },
    ]);
    expect(out.every((f) => f.duplicate_of === undefined)).toBe(true);
  });

  it('marks every later member of a 3-way tie against ONE canonical', () => {
    const out = assignCanonicalDuplicates([
      { step: 'first', md5: 'z', takenAt: '2026-09-01T00:00:01Z' },
      { step: 'second', md5: 'z', takenAt: '2026-09-01T00:00:02Z' },
      { step: 'third', md5: 'z', takenAt: '2026-09-01T00:00:03Z' },
    ]);
    const byStep = Object.fromEntries(out.map((f) => [f.step, f.duplicate_of]));
    expect(byStep['first']).toBeUndefined();
    // Both point at the canonical directly, so resolveCanonicalStep needs no
    // chain walk for producer-written manifests.
    expect(byStep['second']).toBe('first');
    expect(byStep['third']).toBe('first');
  });

  it('round-trips through the consumer helpers', () => {
    const captures = assignCanonicalDuplicates([
      { step: 'step-003-launchApp-org.commcare', md5: 'q', takenAt: '2026-09-01T00:00:01Z' },
      { step: 'learn-launch-home-tiles', md5: 'q', takenAt: '2026-09-01T00:00:02Z' },
      { step: 'journey-learn-final', md5: 'r', takenAt: '2026-09-01T00:00:03Z' },
    ]);
    const manifest = { captures };
    expect(canonicalCaptures(manifest).map((c) => c.step).sort()).toEqual([
      'journey-learn-final',
      'learn-launch-home-tiles',
    ]);
    expect(resolveCanonicalStep(manifest, 'step-003-launchApp-org.commcare')).toBe(
      'learn-launch-home-tiles',
    );
    expect(
      findDuplicateCitations(manifest, ['step-003-launchApp-org.commcare', 'journey-learn-final']),
    ).toEqual([{ step: 'step-003-launchApp-org.commcare', canonical: 'learn-launch-home-tiles' }]);
  });

  it('does not mutate the caller\'s array', () => {
    const input = [
      { step: 'b', md5: 'x', takenAt: '2026-09-01T00:00:02Z' },
      { step: 'a', md5: 'x', takenAt: '2026-09-01T00:00:01Z' },
    ];
    const snapshot = JSON.stringify(input);
    assignCanonicalDuplicates(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
