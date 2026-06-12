import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resetScreenshotDir } from '../../../mcp/mobile/screenshot-dir.js';

// Per-execution screenshot-dir freshness (jjackson/ace#756): the dir a
// `mobile_run_recipe` dispatch reports must contain ONLY artifacts from
// that execution. `resetScreenshotDir` is the wipe-and-recreate choke
// point `MobileClient.runRecipe` calls before dispatching to either
// backend.
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
