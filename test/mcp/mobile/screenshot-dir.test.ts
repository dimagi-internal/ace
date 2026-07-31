import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resetScreenshotDir, isPreservedArtifact } from '../../../mcp/mobile/screenshot-dir.js';

// Per-execution screenshot-dir freshness (jjackson/ace#756): the dir a
// `mobile_run_recipe` dispatch reports must contain ONLY artifacts from
// that execution. `resetScreenshotDir` is the wipe-and-recreate choke
// point `MobileClient.runRecipe` calls before dispatching to either
// backend. The wipe is SELECTIVE (jjackson/ace#1034): `00-*` ground-truth
// dumps and `*-FAILURE.*` forensics from a prior attempt survive it.
describe('resetScreenshotDir', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-shots-'));
  });
  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('removes every pre-existing file (PNGs, sidecars, XMLs, nested dirs) and leaves an empty dir', () => {
    const dir = path.join(tmpDir, 'journey-deliver');
    fs.mkdirSync(path.join(dir, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'journey-deliver-final.png'), 'STALE');
    fs.writeFileSync(path.join(dir, 'journey-deliver-final.png.meta.json'), '{}');
    fs.writeFileSync(path.join(dir, 'dump.xml'), '<hierarchy/>');
    fs.writeFileSync(path.join(dir, 'nested', 'deep.png'), 'STALE');

    resetScreenshotDir(dir);

    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('creates the dir (recursively) when it does not exist', () => {
    const dir = path.join(tmpDir, 'a', 'b', 'shots');
    expect(fs.existsSync(dir)).toBe(false);

    resetScreenshotDir(dir);

    expect(fs.statSync(dir).isDirectory()).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  // jjackson/ace#1034: attempt N's failure forensics and the pre-recipe
  // `00-postlearn-landing.xml` ground-truth dump (#618) must survive the
  // wipe at attempt N+1 start; ordinary capture outputs must not.
  it('preserves *-FAILURE.* forensics and 00-* ground truth while removing ordinary captures', () => {
    const dir = path.join(tmpDir, 'journey-deliver');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'journey-deliver-FAILURE.xml'), '<hierarchy/>');
    fs.writeFileSync(path.join(dir, 'journey-deliver-FAILURE.png'), 'FORENSIC');
    fs.writeFileSync(path.join(dir, '00-postlearn-landing.xml'), '<hierarchy/>');
    fs.writeFileSync(path.join(dir, '01-foo.png'), 'STALE');
    fs.writeFileSync(path.join(dir, 'journey-deliver-final.png'), 'STALE');
    fs.writeFileSync(path.join(dir, 'journey-deliver.mp4'), 'STALE');

    resetScreenshotDir(dir);

    expect(fs.readdirSync(dir).sort()).toEqual([
      '00-postlearn-landing.xml',
      'journey-deliver-FAILURE.png',
      'journey-deliver-FAILURE.xml',
    ]);
  });

  it('isPreservedArtifact matches only 00-* and *-FAILURE.* basenames', () => {
    expect(isPreservedArtifact('00-postlearn-landing.xml')).toBe(true);
    expect(isPreservedArtifact('journey-deliver-FAILURE.xml')).toBe(true);
    expect(isPreservedArtifact('connect-resume-opp-FAILURE.png')).toBe(true);
    expect(isPreservedArtifact('01-foo.png')).toBe(false);
    expect(isPreservedArtifact('journey-deliver-final.png')).toBe(false);
    expect(isPreservedArtifact('dump.xml')).toBe(false);
  });

  it('is idempotent on an already-empty dir', () => {
    const dir = path.join(tmpDir, 'shots');
    resetScreenshotDir(dir);
    resetScreenshotDir(dir);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it.each(['/', '/tmp', os.homedir(), process.cwd()])(
    'refuses to wipe protected/shallow path %s',
    (dangerous) => {
      expect(() => resetScreenshotDir(dangerous)).toThrow(/refusing to wipe/);
    },
  );
});
