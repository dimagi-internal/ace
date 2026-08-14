import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {


  resetScreenshotDir,
  isPreservedArtifact,
  dispatchOutputDir,
  recipeNamespace,
} from '../../../mcp/mobile/screenshot-dir.js';



// Per-execution screenshot-dir freshness (jjackson/ace#756): the dir a
// `mobile_run_recipe` dispatch reports must contain ONLY artifacts from
// that execution. `resetScreenshotDir` is the wipe-and-recreate choke
// point `MobileClient.runRecipe` calls before dispatching to either
// backend. The wipe is SELECTIVE (jjackson/ace#1034): `00-*` ground-truth
// dumps and `*-FAILURE.*` forensics from a prior attempt survive it.
describe('resetScreenshotDir', () => {
  // ace#1111 contains screenshot dirs under an allow-listed root. This suite
  // works in `mkdtemp` dirs under the OS temp dir, so it points the override
  // there — the DEFAULT roots are exercised by the `dispatchOutputDir` suite
  // below and by screenshot-dir-containment.test.ts.
  const savedRoot = process.env.ACE_SCREENSHOT_ROOT;
  beforeEach(() => { process.env.ACE_SCREENSHOT_ROOT = os.tmpdir(); });
  afterEach(() => {
    if (savedRoot === undefined) delete process.env.ACE_SCREENSHOT_ROOT;
    else process.env.ACE_SCREENSHOT_ROOT = savedRoot;
  });
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
    // The `.txt` sidecar (the Maestro stderr excerpt `captureFailureForensics`
    // writes alongside the .xml/.png) must survive the wipe too — it's what
    // lets the atlas drift classifier (`lib/atlas-drift.ts`
    // `classifyScreenCoverage`) tell `matcher-miss` (the recipe's wanted
    // element IS on screen — fix the recipe) from `unmapped-surface` (nothing
    // wanted is on screen — a real coverage gap) apart. It survives today only
    // because the predicate is extension-agnostic (`/-FAILURE\./`, not an
    // explicit .png/.xml allowlist); a well-meaning tightening of that regex
    // would silently wipe it and make `matcher-miss` unreachable again with
    // no test failing — this assertion is the guard against that.
    expect(isPreservedArtifact('connect-claim-opp-FAILURE.txt')).toBe(true);
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
      // ace#1111 moved the first line of defence to CONTAINMENT, so these now
      // trip "refusing to touch … must be under" before the shallow-path
      // check. Either refusal satisfies the property under test: none of them
      // is ever wiped.
      expect(() => resetScreenshotDir(dangerous)).toThrow(/refusing to (wipe|touch)/);
    },
  );
});

// dimagi-internal/ace#1130 — the wipe's blast radius must EQUAL the
// dispatch. Two journeys handed one root must not be able to land in one
// directory, because the second one's legitimate #756 wipe then destroys
// the first one's finished evidence (and a Learn leg's evidence costs a
// whole fresh /ace:run to regenerate — Learn completion is one-way per
// (test user, opportunity), #568/#570).
describe('dispatchOutputDir', () => {
  it('gives two different recipes different dirs under one shared root', () => {
    const root = '/tmp/ace-screenshots/run-42';
    const learn = dispatchOutputDir(root, 'journey-learn');
    const deliver = dispatchOutputDir(root, 'journey-deliver');

    expect(learn).toBe(path.join(root, 'journey-learn'));
    expect(deliver).toBe(path.join(root, 'journey-deliver'));
    expect(learn).not.toBe(deliver);
    // Neither is an ancestor of the other — a wipe of one cannot reach
    // into the other.
    expect(deliver.startsWith(learn + path.sep)).toBe(false);
    expect(learn.startsWith(deliver + path.sep)).toBe(false);
  });

  it('is stable for the same recipe, so a re-dispatch still supersedes its own prior output (#756)', () => {
    const root = '/tmp/ace-screenshots/run-42';
    expect(dispatchOutputDir(root, 'journey-deliver')).toBe(
      dispatchOutputDir(root, 'journey-deliver'),
    );
  });

  it('applies the protected/shallow guard to the caller-supplied ROOT', () => {
    // Namespacing adds a segment, so without this the old guard would
    // have let `/tmp` through as `/tmp/<recipe>` (ace#1111 hygiene).
    for (const dangerous of ['/', '/tmp', os.homedir(), process.cwd()]) {
      expect(() => dispatchOutputDir(dangerous, 'journey-learn')).toThrow(
        /refusing to (wipe|touch)/,
      );
    }
  });

  it('cannot escape the root via a traversing or separator-bearing recipe id', () => {
    const root = '/tmp/ace-screenshots/run-42';
    for (const evil of ['../../etc', 'a/../../b', '/etc/passwd']) {
      const out = dispatchOutputDir(root, evil);
      expect(out.startsWith(path.resolve(root) + path.sep)).toBe(true);
      expect(out.split(path.sep)).not.toContain('..');
    }
  });

  it('recipeNamespace reduces a recipe id to one safe segment, and rejects an empty one', () => {
    expect(recipeNamespace('journey-learn')).toBe('journey-learn');
    expect(recipeNamespace('connect_resume opp')).toBe('connect_resume-opp');
    expect(recipeNamespace('../evil')).toBe('evil');
    expect(() => recipeNamespace('..')).toThrow(/cannot derive an output namespace/);
    expect(() => recipeNamespace('')).toThrow(/cannot derive an output namespace/);
  });
});
