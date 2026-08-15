/**
 * ace#1047 fix 2 — "this AVD completed an ACE bootstrap", recorded as evidence.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readProvisionedMarker,
  writeProvisionedMarker,
  markerProvesFor,
  markerPath,
} from '../../../mcp/mobile/avd-provisioned-marker';

let home: string;
const AVD = 'ACE_Pixel_API_34';

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'ace-avdhome-'));
  mkdirSync(path.join(home, `${AVD}.avd`), { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('round-trip', () => {
  it('writes then reads back', () => {
    expect(writeProvisionedMarker(home, AVD, {
      marked_at: '2026-08-14T10:00:00Z', selector_map: 'connect-2.63.2',
    })).toBe(true);
    expect(readProvisionedMarker(home, AVD)).toMatchObject({
      marked_at: '2026-08-14T10:00:00Z', selector_map: 'connect-2.63.2',
    });
  });

  it('lands inside the AVD directory, so it travels with the AVD', () => {
    expect(markerPath(home, AVD)).toBe(path.join(home, `${AVD}.avd`, '.ace-provisioned.json'));
  });
});

describe('absent or unusable reads as NOT proven, never as an error', () => {
  it('returns null when no marker exists', () => {
    expect(readProvisionedMarker(home, AVD)).toBeNull();
  });

  it('returns null for a nonexistent AVD', () => {
    expect(readProvisionedMarker(home, 'ACE_Nope')).toBeNull();
  });

  it('returns null for corrupt JSON rather than throwing', () => {
    writeFileSync(markerPath(home, AVD), '{not json');
    expect(readProvisionedMarker(home, AVD)).toBeNull();
  });

  it('returns null for JSON missing marked_at', () => {
    writeFileSync(markerPath(home, AVD), JSON.stringify({ selector_map: 'x' }));
    expect(readProvisionedMarker(home, AVD)).toBeNull();
  });
});

describe('writing never breaks the bootstrap that just succeeded', () => {
  it('returns false instead of throwing when the directory is unwritable', () => {
    const dir = path.join(home, `${AVD}.avd`);
    chmodSync(dir, 0o500);
    try {
      expect(writeProvisionedMarker(home, AVD, { marked_at: 'now' })).toBe(false);
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it('returns false for an AVD directory that does not exist', () => {
    expect(writeProvisionedMarker(home, 'ACE_Missing', { marked_at: 'now' })).toBe(false);
  });
});

describe('markerProvesFor — a marker from a different selector map is not proof', () => {
  const m = (selector_map?: string) => ({ marked_at: 'now', selector_map });

  it('proves when the maps match', () => {
    expect(markerProvesFor(m('connect-2.63.2'), 'connect-2.63.2')).toBe(true);
  });

  it('does NOT prove across a map change — the #591/#593 drift trap', () => {
    expect(markerProvesFor(m('connect-2.62.0'), 'connect-2.63.2')).toBe(false);
  });

  it('treats an older marker with no recorded map as unproven', () => {
    expect(markerProvesFor(m(undefined), 'connect-2.63.2')).toBe(false);
  });

  it('accepts any marker when the caller pins no map', () => {
    expect(markerProvesFor(m('connect-2.62.0'), undefined)).toBe(true);
  });

  it('never proves from a missing marker', () => {
    expect(markerProvesFor(null, 'connect-2.63.2')).toBe(false);
    expect(markerProvesFor(null, undefined)).toBe(false);
  });
});
