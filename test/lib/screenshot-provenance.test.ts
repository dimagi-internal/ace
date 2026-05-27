/**
 * Tests for `lib/screenshot-provenance.ts` — captures per-dispatch
 * provenance alongside every screenshot so consumers (UX eval, stale-
 * carryover detection) can deterministically tell whether a PNG came
 * from the current dispatch or is leftover from a prior run.
 *
 * Non-invasive: sidecar JSON next to the PNG, never modifies the PNG
 * bytes. Training slides see PNGs only; ACE sees PNG + sidecar.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildProvenance,
  getAceVersion,
  newDispatchId,
  readProvenanceSidecar,
  sidecarPathFor,
  writeProvenanceSidecar,
  _resetAceVersionCacheForTests,
  type ScreenshotProvenance,
} from '../../lib/screenshot-provenance.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-screenshot-provenance-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('sidecarPathFor', () => {
  it('appends .meta.json to a PNG path', () => {
    expect(sidecarPathFor('/x/y/claim-opp-list.png')).toBe(
      '/x/y/claim-opp-list.png.meta.json',
    );
  });

  it('works with any extension (we just append, no replace)', () => {
    expect(sidecarPathFor('/x/y/dump.xml')).toBe('/x/y/dump.xml.meta.json');
  });
});

describe('newDispatchId', () => {
  it('returns a non-empty string', () => {
    expect(newDispatchId()).toMatch(/^\d{13}-[a-z0-9]{6}$/);
  });

  it('returns distinct values across calls', () => {
    const ids = new Set([newDispatchId(), newDispatchId(), newDispatchId()]);
    expect(ids.size).toBe(3);
  });
});

describe('buildProvenance', () => {
  it('captures recipe_id, dispatch_id, ace_version, git_sha, written_at', () => {
    const p = buildProvenance({
      recipeId: 'claim-opp',
      dispatchId: '1700000000000-abc123',
      aceVersion: '0.13.500',
      gitSha: 'deadbeef',
      writtenAtEpochMs: 1700000000123,
    });
    expect(p).toEqual({
      recipe_id: 'claim-opp',
      dispatch_id: '1700000000000-abc123',
      ace_version: '0.13.500',
      git_sha: 'deadbeef',
      written_at_epoch_ms: 1700000000123,
    });
  });

  it('omits git_sha when not available (e.g. tarball install)', () => {
    const p = buildProvenance({
      recipeId: 'claim-opp',
      dispatchId: '1700000000000-abc123',
      aceVersion: '0.13.500',
      gitSha: undefined,
      writtenAtEpochMs: 1700000000123,
    });
    expect(p.git_sha).toBeUndefined();
    expect(p.recipe_id).toBe('claim-opp');
  });
});

describe('writeProvenanceSidecar + readProvenanceSidecar (roundtrip)', () => {
  it('writes JSON sidecar that round-trips through read', () => {
    const pngPath = path.join(tmpDir, 'foo.png');
    fs.writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // fake PNG header
    const prov: ScreenshotProvenance = {
      recipe_id: 'claim-opp',
      dispatch_id: '1700000000000-abc123',
      ace_version: '0.13.500',
      git_sha: 'deadbeef',
      written_at_epoch_ms: 1700000000123,
    };
    writeProvenanceSidecar(pngPath, prov);
    const sidecar = sidecarPathFor(pngPath);
    expect(fs.existsSync(sidecar)).toBe(true);
    expect(readProvenanceSidecar(pngPath)).toEqual(prov);
  });

  it('does NOT touch the PNG bytes', () => {
    const pngPath = path.join(tmpDir, 'foo.png');
    const original = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    fs.writeFileSync(pngPath, original);
    writeProvenanceSidecar(pngPath, {
      recipe_id: 'r',
      dispatch_id: 'd',
      ace_version: 'v',
      written_at_epoch_ms: 1,
    });
    expect(fs.readFileSync(pngPath).equals(original)).toBe(true);
  });

  it('readProvenanceSidecar returns undefined when sidecar absent', () => {
    const pngPath = path.join(tmpDir, 'foo.png');
    fs.writeFileSync(pngPath, Buffer.from([0x89, 0x50]));
    expect(readProvenanceSidecar(pngPath)).toBeUndefined();
  });

  it('readProvenanceSidecar returns undefined when sidecar is corrupt JSON', () => {
    const pngPath = path.join(tmpDir, 'foo.png');
    fs.writeFileSync(pngPath, Buffer.from([0x89]));
    fs.writeFileSync(sidecarPathFor(pngPath), 'not json {{{');
    expect(readProvenanceSidecar(pngPath)).toBeUndefined();
  });

  it('readProvenanceSidecar returns undefined when sidecar is missing required fields', () => {
    const pngPath = path.join(tmpDir, 'foo.png');
    fs.writeFileSync(pngPath, Buffer.from([0x89]));
    fs.writeFileSync(sidecarPathFor(pngPath), JSON.stringify({ random: 'shape' }));
    expect(readProvenanceSidecar(pngPath)).toBeUndefined();
  });
});

describe('getAceVersion', () => {
  it('reads VERSION file content (matches the repo-root VERSION)', () => {
    _resetAceVersionCacheForTests();
    const v = getAceVersion();
    expect(v).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('caches across calls (returns same value)', () => {
    _resetAceVersionCacheForTests();
    const a = getAceVersion();
    const b = getAceVersion();
    expect(a).toBe(b);
  });
});

describe('staleness detection (the actual consumer use case)', () => {
  it('a screenshot from a prior dispatch is detectable by dispatch_id mismatch', () => {
    const png = path.join(tmpDir, 'stale.png');
    fs.writeFileSync(png, Buffer.from([0x89]));
    writeProvenanceSidecar(png, {
      recipe_id: 'r',
      dispatch_id: 'PRIOR-DISPATCH',
      ace_version: '0.13.500',
      written_at_epoch_ms: 1,
    });
    const currentDispatch = newDispatchId();
    const sidecar = readProvenanceSidecar(png)!;
    expect(sidecar.dispatch_id).not.toBe(currentDispatch);
  });

  it('a screenshot from this dispatch is detectable by dispatch_id match', () => {
    const dispatchId = newDispatchId();
    const png = path.join(tmpDir, 'fresh.png');
    fs.writeFileSync(png, Buffer.from([0x89]));
    writeProvenanceSidecar(png, {
      recipe_id: 'r',
      dispatch_id: dispatchId,
      ace_version: '0.13.500',
      written_at_epoch_ms: Date.now(),
    });
    expect(readProvenanceSidecar(png)?.dispatch_id).toBe(dispatchId);
  });
});
