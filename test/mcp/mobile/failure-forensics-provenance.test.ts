/**
 * Regression guard for dimagi-internal/ace#2237.
 *
 * The screenshot-dir wipe deliberately spares `00-*` ground truth and
 * `*-FAILURE.*` forensics (ace#1034), so a leg that fails once and then
 * passes leaves the PRIOR attempt's frames sitting next to the retry's
 * captures. The provenance stamper runs at harvest time over everything in
 * the dir, and it used to overwrite those preserved files with the CURRENT
 * dispatch's id — so the one file class that is guaranteed by design to be a
 * leftover was the one class the stale-carryover comparison always called
 * fresh.
 *
 * Observed on spark-facilitator/20260907-1120: `journey-deliver-FAILURE.png`
 * captured at 05:52Z on plugin 0.13.1356 / emulator-5556 came back from an
 * 11:36Z dispatch carrying that dispatch's id, version and serial. The only
 * surviving signal was `takenAt`, which no consumer is told to check.
 *
 * The assertions below are the invariant, not the mechanism: an artifact this
 * dispatch did not write keeps the id of the dispatch that did, and one it did
 * write is never flagged stale.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { StampableArtifact } from '../../../lib/screenshot-provenance.js';
import {
  UNKNOWN_PRIOR_DISPATCH_ID,
  buildProvenance,
  isCarryover,
  readProvenanceSidecar,
  sidecarPathFor,
  stampArtifactProvenance,
  writeProvenanceSidecar,
} from '../../../lib/screenshot-provenance.js';

const DISPATCH_A = '1788846772000-aaaaaa';
const DISPATCH_B = '1788867373138-puhdyq';
const DISPATCH_C = '1788899999999-cccccc';

/** Provenance as the PRIOR dispatch wrote it — different version, different
 * emulator serial, exactly like the live reproduction. */
function provA(writtenAt: number) {
  return buildProvenance({
    recipeId: 'journey-deliver',
    dispatchId: DISPATCH_A,
    aceVersion: '0.13.1356',
    deviceSerial: 'emulator-5556',
    writtenAtEpochMs: writtenAt,
  });
}

function provB(writtenAt: number) {
  return buildProvenance({
    recipeId: 'journey-deliver',
    dispatchId: DISPATCH_B,
    aceVersion: '0.13.1363',
    deviceSerial: 'emulator-5554',
    writtenAtEpochMs: writtenAt,
  });
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ace-forensics-prov-'));
}

/** Write a file and force its mtime, so "older than this dispatch" is a real
 * filesystem fact rather than a flag the test hands the code under test. */
function writeAt(p: string, epochMs: number): void {
  fs.writeFileSync(p, 'PNGBYTES');
  const secs = epochMs / 1000;
  fs.utimesSync(p, secs, secs);
}

describe('preserved *-FAILURE.* forensics keep the dispatch that produced them', () => {
  it('a FAILURE frame from dispatch A, harvested by dispatch B, keeps A', () => {
    const dir = tmpDir();
    const now = Date.now();
    const dispatchStartedAtEpochMs = now - 60_000;
    const sixHoursAgo = now - 6 * 60 * 60 * 1000;

    const failure = path.join(dir, 'journey-deliver-FAILURE.png');
    writeAt(failure, sixHoursAgo);
    writeProvenanceSidecar(failure, provA(sixHoursAgo));

    const fresh = path.join(dir, 'connect-resume-opp-list-synced.png');
    writeAt(fresh, now);

    const artifacts: StampableArtifact[] = [{ path: failure }, { path: fresh }];
    stampArtifactProvenance({
      artifacts,
      current: provB(now),
      dispatchStartedAtEpochMs,
    });

    const kept = readProvenanceSidecar(failure);
    expect(kept?.dispatch_id).toBe(DISPATCH_A);
    // The forensic context travels with the id — a frame attached to a bug
    // report must not claim a version and a device it never ran on.
    expect(kept?.ace_version).toBe('0.13.1356');
    expect(kept?.device_serial).toBe('emulator-5556');
    expect(kept?.written_at_epoch_ms).toBe(sixHoursAgo);
    // ...and it is detectable as carryover by the current dispatch.
    expect(kept?.carried_over).toBe(true);
    expect(kept?.superseded_by).toBe(DISPATCH_B);
    expect(isCarryover(kept, DISPATCH_B)).toBe(true);
    // The returned entry and the sidecar can never disagree.
    expect(artifacts[0].provenance).toEqual(kept);
  });

  it('NEGATIVE CONTROL: a frame this dispatch captured is not flagged stale', () => {
    const dir = tmpDir();
    const now = Date.now();
    const dispatchStartedAtEpochMs = now - 60_000;

    const fresh = path.join(dir, 'connect-resume-opp-list-synced.png');
    writeAt(fresh, now);

    const artifacts: StampableArtifact[] = [{ path: fresh }];
    stampArtifactProvenance({
      artifacts,
      current: provB(now),
      dispatchStartedAtEpochMs,
    });

    const prov = readProvenanceSidecar(fresh);
    expect(prov?.dispatch_id).toBe(DISPATCH_B);
    expect(prov?.ace_version).toBe('0.13.1363');
    expect(prov?.carried_over).toBeUndefined();
    expect(prov?.superseded_by).toBeUndefined();
    expect(isCarryover(prov, DISPATCH_B)).toBe(false);
  });

  it('NEGATIVE CONTROL: a FAILURE frame THIS dispatch re-captured is ours, stale sidecar notwithstanding', () => {
    // `captureFailureForensics` overwrites `<recipeId>-FAILURE.png` in place,
    // so the prior attempt's sidecar can still be lying next to a frame this
    // dispatch just wrote. mtime, not the sidecar, is the authority.
    const dir = tmpDir();
    const now = Date.now();
    const dispatchStartedAtEpochMs = now - 60_000;

    const failure = path.join(dir, 'journey-deliver-FAILURE.png');
    writeProvenanceSidecar(failure, provA(now - 6 * 60 * 60 * 1000));
    writeAt(failure, now);

    const artifacts: StampableArtifact[] = [{ path: failure }];
    stampArtifactProvenance({
      artifacts,
      current: provB(now),
      dispatchStartedAtEpochMs,
    });

    const prov = readProvenanceSidecar(failure);
    expect(prov?.dispatch_id).toBe(DISPATCH_B);
    expect(prov?.carried_over).toBeUndefined();
    expect(isCarryover(prov, DISPATCH_B)).toBe(false);
  });

  it('a preserved frame with NO sidecar is marked unknown-origin, never the current dispatch', () => {
    const dir = tmpDir();
    const now = Date.now();
    const dispatchStartedAtEpochMs = now - 60_000;
    const sixHoursAgo = now - 6 * 60 * 60 * 1000;

    const failure = path.join(dir, 'journey-deliver-FAILURE.png');
    writeAt(failure, sixHoursAgo);
    expect(fs.existsSync(sidecarPathFor(failure))).toBe(false);

    stampArtifactProvenance({
      artifacts: [{ path: failure }],
      current: provB(now),
      dispatchStartedAtEpochMs,
    });

    const prov = readProvenanceSidecar(failure);
    expect(prov?.dispatch_id).toBe(UNKNOWN_PRIOR_DISPATCH_ID);
    expect(prov?.dispatch_id).not.toBe(DISPATCH_B);
    // No invented context: we do not know the version or the device.
    expect(prov?.ace_version).toBe('unknown');
    expect(prov?.device_serial).toBeUndefined();
    expect(prov?.carried_over).toBe(true);
    expect(prov?.superseded_by).toBe(DISPATCH_B);
    expect(isCarryover(prov, DISPATCH_B)).toBe(true);
  });

  it('a third dispatch re-observing it still keeps A, and names itself as the superseder', () => {
    const dir = tmpDir();
    const now = Date.now();
    const sixHoursAgo = now - 6 * 60 * 60 * 1000;

    const failure = path.join(dir, 'journey-deliver-FAILURE.png');
    writeAt(failure, sixHoursAgo);
    writeProvenanceSidecar(failure, provA(sixHoursAgo));

    stampArtifactProvenance({
      artifacts: [{ path: failure }],
      current: provB(now),
      dispatchStartedAtEpochMs: now - 60_000,
    });
    stampArtifactProvenance({
      artifacts: [{ path: failure }],
      current: buildProvenance({
        recipeId: 'journey-deliver',
        dispatchId: DISPATCH_C,
        aceVersion: '0.13.1400',
        writtenAtEpochMs: now + 1000,
      }),
      dispatchStartedAtEpochMs: now + 500,
    });

    const prov = readProvenanceSidecar(failure);
    expect(prov?.dispatch_id).toBe(DISPATCH_A);
    expect(prov?.superseded_by).toBe(DISPATCH_C);
    expect(isCarryover(prov, DISPATCH_C)).toBe(true);
  });
});
