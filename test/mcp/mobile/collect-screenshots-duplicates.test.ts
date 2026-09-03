/**
 * The harness, not the manifest author, decides which of a byte-identical set
 * of frames is canonical.
 *
 * ace#866 taught the producer to mark `duplicate_of`; ace#1304 taught the
 * consumer to honour it. Both halves existed and the bug still shipped, because
 * the ASSIGNMENT was prose in a skill — "keep the FIRST step in recipe order" —
 * re-applied by hand every run. On turmeric-market-study/20260828-1108 that
 * prose was followed correctly and still produced the wrong answer, because it
 * omits an exception: Maestro names an unnamed chunk boundary
 * `step-<index>-<command>-<args>`, one such frame was byte-identical to
 * `deliver-launch-download-gate` and led it by 0.28s, and downstream prose
 * cites the canonical step's NAME. A training deck was one step from captioning
 * a slide `step-010-assertCondition-org.commcare.dalvikid_vi`.
 *
 * So the annotation moved into `collectScreenshotsFromDir`, which every capture
 * path funnels through. A manifest author now COPIES a decision instead of
 * making one.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { collectScreenshotsFromDir, markDuplicateFrames } from '../../../mcp/mobile/backends/maestro.js';

let dir: string;

/** Distinct PNG bytes per `seed`; identical bytes for an identical `seed`. */
function writeFrame(name: string, seed: string, mtimeMs: number): void {
  const p = path.join(dir, `${name}.png`);
  fs.writeFileSync(p, Buffer.from(`PNG-BYTES-${seed}`));
  fs.utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-dupe-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('collectScreenshotsFromDir — duplicate annotation', () => {
  it('stamps an md5 on every frame', () => {
    writeFrame('a', 'one', Date.parse('2026-09-01T09:00:01Z'));
    writeFrame('b', 'two', Date.parse('2026-09-01T09:00:02Z'));

    const out = collectScreenshotsFromDir(dir);
    expect(out).toHaveLength(2);
    expect(out.every((e) => typeof e.md5 === 'string' && e.md5.length === 32)).toBe(true);
    // Different bytes must not collide.
    expect(out[0].md5).not.toBe(out[1].md5);
  });

  it('leaves genuinely distinct frames unmarked', () => {
    writeFrame('a', 'one', Date.parse('2026-09-01T09:00:01Z'));
    writeFrame('b', 'two', Date.parse('2026-09-01T09:00:02Z'));

    const out = collectScreenshotsFromDir(dir);
    expect(out.every((e) => e.duplicateOf === undefined)).toBe(true);
  });

  it('marks the later of two identical frames against the earlier', () => {
    writeFrame('journey-deliver-submitted-confirmation', 'same', Date.parse('2026-09-01T09:55:38Z'));
    writeFrame('deliver-sync-pre', 'same', Date.parse('2026-09-01T09:55:56Z'));

    const byStep = Object.fromEntries(
      collectScreenshotsFromDir(dir).map((e) => [e.stepName, e.duplicateOf]),
    );
    expect(byStep['journey-deliver-submitted-confirmation']).toBeUndefined();
    expect(byStep['deliver-sync-pre']).toBe('journey-deliver-submitted-confirmation');
  });

  it('THE REGRESSION: an auto-named frame yields even when it was taken first', () => {
    writeFrame(
      'step-010-assertCondition-org.commcare.dalvikid_vi',
      'gate',
      Date.parse('2026-09-01T09:48:57Z'),
    );
    writeFrame('deliver-launch-download-gate', 'gate', Date.parse('2026-09-01T09:48:58Z'));

    const byStep = Object.fromEntries(
      collectScreenshotsFromDir(dir).map((e) => [e.stepName, e.duplicateOf]),
    );
    expect(byStep['deliver-launch-download-gate']).toBeUndefined();
    expect(byStep['step-010-assertCondition-org.commcare.dalvikid_vi']).toBe(
      'deliver-launch-download-gate',
    );
  });

  it('does not throw when a frame cannot be read, and leaves it unannotated', () => {
    // A path that no longer exists by the time hashing runs is the realistic
    // failure (a concurrent wipe). A capture run must not die for one frame.
    const entries = [
      { stepName: 'gone', path: path.join(dir, 'does-not-exist.png'), takenAt: '2026-09-01T09:00:00Z', bytes: 0 },
    ];
    const out = markDuplicateFrames(entries);
    expect(out).toHaveLength(1);
    expect(out[0].md5).toBeUndefined();
    expect(out[0].duplicateOf).toBeUndefined();
  });

  it('preserves the fields callers already depend on', () => {
    writeFrame('a', 'one', Date.parse('2026-09-01T09:00:01Z'));
    const [e] = collectScreenshotsFromDir(dir);
    expect(e.stepName).toBe('a');
    expect(e.path.endsWith('a.png')).toBe(true);
    expect(typeof e.takenAt).toBe('string');
    expect(e.bytes).toBeGreaterThan(0);
  });
});
