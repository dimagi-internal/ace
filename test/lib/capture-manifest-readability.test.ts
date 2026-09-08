/**
 * dimagi-internal/ace#2236 — the writer half of ace#2224.
 *
 * #2224 widened `collectCaptureEntries` to read `journeys[].{screenshots,
 * steps,duplicates}[]` alongside `captures[]`. It did not teach it a
 * TOP-LEVEL `screenshots[]`, and that is the container
 * `app-screenshot-capture` wrote on the very next run.
 *
 * `spark-facilitator/20260907-1120`,
 * `6-qa-and-training/app-screenshot-capture_manifest.yaml`
 * (fileId `1wtEqtASnagoFcDiHQtPtDYLqONlcT1Cfc-gMF6S4FN0`): 60 real, uploaded,
 * file_id-bearing frames under `screenshots:`, and the reader every consumer
 * goes through saw ZERO. Every downstream guard then returned clean —
 * `framesCitedWithoutShows` had nothing to find a missing `shows` on,
 * `findDuplicateCitations` knew no aliases — because a consumer that finds
 * nothing reports clean, not empty.
 *
 * Two halves are pinned here:
 *   1. the reader reads that shape (the instance), and
 *   2. `assertManifestReadable` names ANY capture-shaped container the reader
 *      does not read (the class) — so the next misspelling fails loudly
 *      instead of laundering an unchecked artifact into a checked-looking one.
 */
import { describe, it, expect } from 'vitest';

import {
  assertManifestReadable,
  collectCaptureEntries,
  canonicalCaptures,
  framesCitedWithoutShows,
} from '../../lib/capture-manifest.js';
import { classifyCaptionBacking, flattenManifestFrames } from '../../lib/caption-backing.js';

/**
 * The live shape, reproduced at its real size. 60 rows under a top-level
 * `screenshots:` key, each carrying the `file_id` that makes it citable.
 */
const SPARK_FACILITATOR_MANIFEST = {
  skill: 'app-screenshot-capture',
  run_id: '20260907-1120',
  opportunity_name: 'spark-facilitator',
  journeys: [
    { journey_id: 'journey-learn-pass', status: 'pass' },
    { journey_id: 'journey-deliver-submit', status: 'pass' },
  ],
  screenshots: Array.from({ length: 60 }, (_, i) => ({
    journey_id: i < 30 ? 'journey-learn-pass' : 'journey-deliver-submit',
    step: `frame-${String(i).padStart(3, '0')}`,
    file_id: `FILE_${i}`,
    shows: 'a real screen someone opened',
  })),
  videos: [{ journey_id: 'journey-learn-pass', recipe_base: 'journey-learn', file_id: 'VID_1' }],
};

describe('a top-level screenshots[] manifest is not invisible (ace#2236)', () => {
  it('THE REPRO: 60 entries under `screenshots:` read as 60, not 0', () => {
    expect(SPARK_FACILITATOR_MANIFEST.screenshots).toHaveLength(60);
    expect(collectCaptureEntries(SPARK_FACILITATOR_MANIFEST as never)).toHaveLength(60);
  });

  it('the guards that reported CLEAN on zero entries now have something to judge', () => {
    expect(canonicalCaptures(SPARK_FACILITATOR_MANIFEST as never)).toHaveLength(60);
    // Every frame carries a `shows`, so this is empty for the RIGHT reason now.
    expect(
      framesCitedWithoutShows(SPARK_FACILITATOR_MANIFEST as never, ['frame-000', 'frame-059']),
    ).toEqual([]);
    // ...and a frame without one is still named.
    const stripped = { screenshots: [{ step: 'undescribed', file_id: 'F' }] };
    expect(framesCitedWithoutShows(stripped as never, ['undescribed'])).toEqual(['undescribed']);
  });

  it('both readers agree on the frame set — the ace#2224 drift check', () => {
    expect(collectCaptureEntries(SPARK_FACILITATOR_MANIFEST as never).map((c) => c.step)).toEqual(
      flattenManifestFrames(SPARK_FACILITATOR_MANIFEST).map((f) => f.step),
    );
  });

  it('NEGATIVE CONTROL: the canonical `captures:` shape still reads its entries', () => {
    const wellFormed = {
      captures: [
        { journey_id: 'journey-learn-pass', step: 'learn-home', file_id: 'A', shows: 'home' },
        {
          journey_id: 'journey-learn-pass',
          step: 'learn-home-again',
          file_id: 'A',
          duplicate_of: 'learn-home',
        },
      ],
    };
    expect(collectCaptureEntries(wellFormed as never).map((c) => c.step)).toEqual([
      'learn-home',
      'learn-home-again',
    ]);
    expect(canonicalCaptures(wellFormed as never).map((c) => c.step)).toEqual(['learn-home']);
  });
});

describe('assertManifestReadable — the class, not the instance (ace#2236)', () => {
  it('names a container nobody has thought of yet, by its own key', () => {
    // The point of the detector: `frames:` is not a name anyone widened the
    // reader for, and it never will be. It still gets caught.
    const invented = {
      frames: [
        { step: 'a', file_id: 'A', shows: 'x' },
        { step: 'b', file_id: 'B', shows: 'y' },
      ],
    };
    const r = assertManifestReadable(invented as never);
    expect(r.ok).toBe(false);
    expect(r.read_entries).toBe(0);
    expect(r.findings).toEqual([
      expect.objectContaining({ reason: 'unread-container', path: 'frames', count: 2 }),
    ]);
    expect(r.findings[0].detail).toContain('captures:');
  });

  it('catches a stranded container NESTED under journeys[]', () => {
    const m = {
      journeys: [{ journey_id: 'j', captured: [{ step: 'a', drive_path: 'p/a.png' }] }],
    };
    const r = assertManifestReadable(m as never);
    expect(r.ok).toBe(false);
    expect(r.findings[0]).toMatchObject({ path: 'journeys[].captured', count: 1 });
  });

  it('NEGATIVE CONTROL: every shape the reader actually reads is clean', () => {
    for (const m of [
      { captures: [{ step: 'a', file_id: 'A' }] },
      { screenshots: [{ step: 'a', file_id: 'A' }] },
      { journeys: [{ screenshots: [{ step: 'a', file_id: 'A' }] }] },
      { journeys: [{ steps: [{ step_name: 'a', file_id: 'A' }] }] },
      { journeys: [{ duplicates: [{ step: 'a', file_id: 'A' }] }] },
    ]) {
      const r = assertManifestReadable(m as never);
      expect(r.findings, JSON.stringify(m)).toEqual([]);
      expect(r.ok, JSON.stringify(m)).toBe(true);
      expect(r.read_entries, JSON.stringify(m)).toBe(1);
    }
  });

  it('does not cry wolf over forensics or bookkeeping blocks', () => {
    const m = {
      captures: [{ step: 'a', file_id: 'A' }],
      // Deliberately unread (ace#1571) — stranding these is correct.
      journeys: [
        {
          steps: [{ step: 'a', file_id: 'A' }],
          superseded_artifacts: [{ step: 'journey-learn-FAILURE', file_id: 'S' }],
        },
      ],
      // Named steps with no frame: not citable, not a finding.
      repairs_applied_by_phase6: [{ step: 're-ran the deliver leg', note: 'attempt 2' }],
      videos: [{ journey_id: 'j', recipe_base: 'journey-learn', file_id: 'V' }],
    };
    expect(assertManifestReadable(m as never)).toMatchObject({ ok: true, findings: [] });
  });

  it('an honestly empty manifest is clean; a miscounted one is not', () => {
    expect(assertManifestReadable({ dry_run: true } as never).ok).toBe(true);
    expect(assertManifestReadable(undefined).ok).toBe(true);
    const short = assertManifestReadable({ captures: [{ step: 'a', file_id: 'A' }] } as never, {
      expectedCount: 60,
    });
    expect(short.ok).toBe(false);
    expect(short.findings[0]).toMatchObject({ reason: 'count-mismatch', count: 1 });
    expect(short.expected_entries).toBe(60);
  });
});

describe('the consuming fence stops reporting an unreadable manifest as clean', () => {
  const link = (id: string) => `See ![frame](https://drive.google.com/file/d/${id}/view)`;

  it('a text-only artifact over a BROKEN manifest is no longer vacuously ok', () => {
    // The exact laundering this issue is about: nothing cited, so every
    // per-citation finding is empty, so the fence said ok — over a manifest
    // whose frames no consumer could see.
    const r = classifyCaptionBacking({
      published: 'All prose, no frames.',
      manifest: { frames: [{ step: 'a', file_id: 'A', shows: 'x' }] },
    });
    expect(r.findings).toEqual([]);
    expect(r.ok).toBe(false);
    expect(r.manifest_frames).toBe(0);
    expect(r.manifest_readability?.findings[0]).toMatchObject({ path: 'frames' });
  });

  it('a citing artifact gets the manifest named, not N bogus unknown-ids', () => {
    const r = classifyCaptionBacking({
      published: link('1wtEqtASnagoFcDiHQtPtDYLqONlcT1Cf'),
      manifest: { frames: [{ step: 'a', file_id: '1wtEqtASnagoFcDiHQtPtDYLqONlcT1Cf', shows: 'the home screen' }] },
    });
    expect(r.ok).toBe(false);
    // The citation is CORRECT; the manifest is the defect. Without
    // manifest_readability this reads as the producer citing a bad id.
    expect(r.findings).toEqual([{ file_id: '1wtEqtASnagoFcDiHQtPtDYLqONlcT1Cf', reason: 'unknown-id' }]);
    expect(r.manifest_frames).toBe(0);
    expect(r.manifest_readability?.ok).toBe(false);
  });

  it('NEGATIVE CONTROL: a well-formed manifest still passes and reports its frames', () => {
    const r = classifyCaptionBacking({
      published: link('1wtEqtASnagoFcDiHQtPtDYLqONlcT1Cf'),
      manifest: { captures: [{ step: 'a', file_id: '1wtEqtASnagoFcDiHQtPtDYLqONlcT1Cf', shows: 'the home screen' }] },
    });
    expect(r.ok).toBe(true);
    expect(r.backed).toBe(1);
    expect(r.manifest_frames).toBe(1);
    expect(r.manifest_readability).toBeUndefined();
  });
});
