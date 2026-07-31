// Regression suite for jjackson/ace#1062 — the static-palette dir override.
//
// The bug this pins: `prepareRecipeForMaestro` resolved EVERY palette file
// (and therefore every `runFlow: file:` ref) from the plugin's own install
// dir, with no override. A caller who staged a fixed palette elsewhere was
// SILENTLY ignored. On 2026-07-29 (#1058) the Maestro trace showed the OLD
// blocks executing, so the run read exactly like a failed fix — a false
// negative, not an error. Three ACE rules were mutually unsatisfiable:
// prove a mobile recipe fix on a live device BEFORE merge; never write into
// `~/.claude/plugins/cache/`; palette resolution is install-bound.
//
// What's pinned here:
//   (a) with `ACE_MOBILE_STATIC_RECIPES_DIR` set, BOTH resolution paths
//       (the resolver's own, and MobileClient's) use it — and the copy
//       Maestro actually receives carries the OVERRIDE's bytes.
//   (b) unset → the install dir, byte-identical to pre-fix behavior.
//   (c) set-but-broken → a typed MobileError, NEVER a silent fallback to
//       the install dir. A typo'd override path must not reproduce the
//       false negative it was added to eliminate.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  resolveStaticRecipesDir,
  isStaticRecipesDirOverride,
  prepareRecipeForMaestro,
  INSTALLED_STATIC_RECIPES_DIR,
  STATIC_RECIPES_DIR_ENV,
} from '../../../mcp/mobile/recipe-resolver.js';
import { MobileClient } from '../../../mcp/mobile/client.js';
import { MobileError } from '../../../mcp/mobile/errors.js';

/** Distinctive marker only the staged palette carries. */
const OVERRIDE_MARKER = 'ACE-1062-OVERRIDE-PALETTE-MARKER';

/**
 * A staged palette dir holding a `connect-login.yaml` that ALSO exists in
 * the install palette — so "the override won" is a real shadowing claim,
 * not an artifact of a filename the install dir happens to lack.
 */
function stageOverridePalette(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-1062-palette-'));
  fs.writeFileSync(
    path.join(dir, 'connect-login.yaml'),
    `# ${OVERRIDE_MARKER}\n- launchApp\n`,
    'utf8',
  );
  return dir;
}

/** A minimal top-level recipe with no selector placeholders. */
function stageTopRecipe(): { dir: string; recipePath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-1062-top-'));
  const recipePath = path.join(dir, 'journey-top.yaml');
  fs.writeFileSync(
    recipePath,
    'appId: org.commcare.dalvik\n---\n- runFlow: connect-login.yaml\n',
    'utf8',
  );
  return { dir, recipePath };
}

function fakeBackends() {
  const avd = {
    ensureAvdRunning: vi.fn(),
    requireRunningAvd: vi.fn(),
    findRunningAvd: vi.fn().mockResolvedValue(null),
    getAllocatedPorts: vi.fn().mockResolvedValue({ adbServerPort: 5039 }),
    getAdbShell: vi.fn(),
  } as any;
  /** Snapshots the sibling palette files present in the temp dir Maestro is handed. */
  const seenSiblings: Record<string, string> = {};
  const maestro = {
    runRecipe: vi.fn().mockImplementation(async (recipePath: string) => {
      for (const f of fs.readdirSync(path.dirname(recipePath))) {
        seenSiblings[f] = fs.readFileSync(path.join(path.dirname(recipePath), f), 'utf8');
      }
      return {
        status: 'pass',
        exitCode: 0,
        screenshots: [],
        stdout: '',
        stderr: '',
        screenshotsDir: '/tmp',
      };
    }),
  } as any;
  // `cloud: null` keeps the constructor off the CloudBackend env probe.
  return { avd, maestro, seenSiblings };
}

let prevEnv: string | undefined;
const tempDirs: string[] = [];

beforeEach(() => {
  prevEnv = process.env[STATIC_RECIPES_DIR_ENV];
  delete process.env[STATIC_RECIPES_DIR_ENV];
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env[STATIC_RECIPES_DIR_ENV];
  else process.env[STATIC_RECIPES_DIR_ENV] = prevEnv;
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe(`${STATIC_RECIPES_DIR_ENV} — override honoured (a)`, () => {
  it('resolveStaticRecipesDir returns the staged dir, not the install dir', () => {
    const staged = stageOverridePalette();
    tempDirs.push(staged);
    process.env[STATIC_RECIPES_DIR_ENV] = staged;

    const resolved = resolveStaticRecipesDir();
    expect(path.resolve(resolved)).toBe(path.resolve(staged));
    expect(path.resolve(resolved)).not.toBe(path.resolve(INSTALLED_STATIC_RECIPES_DIR));
    expect(isStaticRecipesDirOverride(resolved)).toBe(true);
  });

  it('prepareRecipeForMaestro copies the STAGED palette bytes into the temp dir', async () => {
    const staged = stageOverridePalette();
    const { dir: topDir, recipePath } = stageTopRecipe();
    tempDirs.push(staged, topDir);
    process.env[STATIC_RECIPES_DIR_ENV] = staged;

    const prep = await prepareRecipeForMaestro(recipePath, '2.63.2');
    tempDirs.push(prep.tempDir);

    expect(prep.paletteDirSource).toBe('override');
    expect(path.resolve(prep.paletteDir)).toBe(path.resolve(staged));
    // The sibling `runFlow: file:` target Maestro will resolve carries the
    // OVERRIDE's bytes. Pre-fix this was the install palette's content —
    // the exact shape of the #1058 false negative.
    const sibling = fs.readFileSync(path.join(prep.tempDir, 'connect-login.yaml'), 'utf8');
    expect(sibling).toContain(OVERRIDE_MARKER);
  });

  it('MobileClient resolves the same dir and passes it through to runRecipe', async () => {
    const staged = stageOverridePalette();
    const { dir: topDir, recipePath } = stageTopRecipe();
    const shotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-1062-shots-'));
    tempDirs.push(staged, topDir, shotDir);
    process.env[STATIC_RECIPES_DIR_ENV] = staged;

    const { avd, maestro, seenSiblings } = fakeBackends();
    // NO `staticRecipesDir` opt — this is the bare-construction path that
    // `mcp/mobile-server.ts` uses, and the one that ignored the override.
    const client = new MobileClient({ avd, maestro, cloud: null as any, bootstrapConfig: null });
    expect(path.resolve(client.staticRecipesDir)).toBe(path.resolve(staged));

    const result = await client.runRecipe(recipePath, {}, shotDir);

    // The two resolution paths agree, and the result says so out loud.
    expect(result.paletteDirSource).toBe('override');
    expect(path.resolve(result.paletteDir!)).toBe(path.resolve(staged));
    // And Maestro's sibling really is the staged file.
    expect(seenSiblings['connect-login.yaml']).toContain(OVERRIDE_MARKER);
  });

  it('logs the override loudly — silence is what made #1062 a false negative', async () => {
    const staged = stageOverridePalette();
    const { dir: topDir, recipePath } = stageTopRecipe();
    tempDirs.push(staged, topDir);
    process.env[STATIC_RECIPES_DIR_ENV] = staged;

    const writes: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
      writes.push(String(chunk));
      return true;
    });
    const prep = await prepareRecipeForMaestro(recipePath, '2.63.2');
    tempDirs.push(prep.tempDir);
    vi.restoreAllMocks();

    const joined = writes.join('');
    expect(joined).toContain(staged);
    expect(joined).toMatch(/OVERRIDE/);
  });
});

describe(`${STATIC_RECIPES_DIR_ENV} — unset keeps the install default (b)`, () => {
  it('resolveStaticRecipesDir returns the install dir when unset or empty', () => {
    expect(path.resolve(resolveStaticRecipesDir())).toBe(
      path.resolve(INSTALLED_STATIC_RECIPES_DIR),
    );
    expect(isStaticRecipesDirOverride(INSTALLED_STATIC_RECIPES_DIR)).toBe(false);

    // An exported-but-empty value is "unset", not "broken" — an operator
    // clearing the var with `export VAR=` must not brick the MCP.
    process.env[STATIC_RECIPES_DIR_ENV] = '   ';
    expect(path.resolve(resolveStaticRecipesDir())).toBe(
      path.resolve(INSTALLED_STATIC_RECIPES_DIR),
    );
  });

  it('MobileClient + prepareRecipeForMaestro both report source=install', async () => {
    const { dir: topDir, recipePath } = stageTopRecipe();
    const shotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-1062-shots-'));
    tempDirs.push(topDir, shotDir);

    const { avd, maestro } = fakeBackends();
    const client = new MobileClient({ avd, maestro, cloud: null as any, bootstrapConfig: null });
    expect(path.resolve(client.staticRecipesDir)).toBe(
      path.resolve(INSTALLED_STATIC_RECIPES_DIR),
    );

    const result = await client.runRecipe(recipePath, {}, shotDir);
    expect(result.paletteDirSource).toBe('install');
    expect(path.resolve(result.paletteDir!)).toBe(path.resolve(INSTALLED_STATIC_RECIPES_DIR));
  });
});

describe(`${STATIC_RECIPES_DIR_ENV} — broken override fails loud, never falls back (c)`, () => {
  function expectInvalid(value: string, expectedInMessage: RegExp) {
    process.env[STATIC_RECIPES_DIR_ENV] = value;
    let thrown: unknown;
    try {
      resolveStaticRecipesDir();
    } catch (e) {
      thrown = e;
    }
    expect(thrown, `expected a throw for ${JSON.stringify(value)}, got a value`).toBeInstanceOf(
      MobileError,
    );
    expect((thrown as MobileError).code).toBe('STATIC_RECIPES_DIR_INVALID');
    expect((thrown as MobileError).message).toMatch(expectedInMessage);
    // The whole point: the failure is NOT "quietly used the install palette".
    expect((thrown as MobileError).remediation).toContain(STATIC_RECIPES_DIR_ENV);
  }

  it('throws on a path that does not exist (the typo case)', () => {
    const missing = path.join(os.tmpdir(), `ace-1062-nope-${Date.now()}`);
    expectInvalid(missing, /does not exist/);
  });

  it('throws on a directory with no .yaml palette files', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-1062-empty-'));
    tempDirs.push(empty);
    expectInvalid(empty, /no \.yaml/);
  });

  it('throws when pointed at a file instead of a directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-1062-file-'));
    tempDirs.push(dir);
    const f = path.join(dir, 'connect-login.yaml');
    fs.writeFileSync(f, '- launchApp\n', 'utf8');
    expectInvalid(f, /not a directory/);
  });

  it('throws on an unexpanded ${...} reference rather than mkdir-missing', () => {
    // Claude Code does not always expand env references (see
    // lib/plugin-data-dir.ts) — a literal `${REPO}/...` must be rejected,
    // not silently treated as a relative path that happens not to exist.
    expectInvalid('${REPO}/mcp/mobile/recipes/static', /unexpanded variable/);
  });

  it('MobileClient construction throws too — the MCP refuses to start', () => {
    process.env[STATIC_RECIPES_DIR_ENV] = path.join(os.tmpdir(), `ace-1062-nope-${Date.now()}`);
    const { avd, maestro } = fakeBackends();
    expect(
      () => new MobileClient({ avd, maestro, cloud: null as any, bootstrapConfig: null }),
    ).toThrow(/STATIC_RECIPES_DIR|not a usable palette dir/);
  });

  it('an explicit opts.staticRecipesDir still wins (tests keep their escape hatch)', () => {
    process.env[STATIC_RECIPES_DIR_ENV] = path.join(os.tmpdir(), `ace-1062-nope-${Date.now()}`);
    const { avd, maestro } = fakeBackends();
    const client = new MobileClient({
      avd,
      maestro,
      cloud: null as any,
      bootstrapConfig: null,
      staticRecipesDir: INSTALLED_STATIC_RECIPES_DIR,
    });
    expect(path.resolve(client.staticRecipesDir)).toBe(
      path.resolve(INSTALLED_STATIC_RECIPES_DIR),
    );
  });
});

describe('sibling-palette shadowing warning', () => {
  it('names the sibling YAMLs the palette dir shadows', async () => {
    // The #1058 shape: a caller stages a fixed palette NEXT TO the recipe
    // and assumes it wins. It doesn't — the palette dir does.
    const { dir: topDir, recipePath } = stageTopRecipe();
    tempDirs.push(topDir);
    fs.writeFileSync(
      path.join(topDir, 'connect-login.yaml'),
      `# ${OVERRIDE_MARKER}\n- launchApp\n`,
      'utf8',
    );

    const writes: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
      writes.push(String(chunk));
      return true;
    });
    const prep = await prepareRecipeForMaestro(recipePath, '2.63.2');
    tempDirs.push(prep.tempDir);
    vi.restoreAllMocks();

    const joined = writes.join('');
    expect(joined).toMatch(/SHADOWED/);
    expect(joined).toContain('connect-login.yaml');
    // And the shadowing is real: the install palette's copy is what landed.
    expect(fs.readFileSync(path.join(prep.tempDir, 'connect-login.yaml'), 'utf8')).not.toContain(
      OVERRIDE_MARKER,
    );
  });
});
