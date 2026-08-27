// Regression suite for ace#1690 gap 1 — linting at the dispatch boundary.
//
// `mobile_validate_recipe` has run this linter for months, and
// `skills/app-test-cases` has instructed callers to use it since 2026-06.
// That instruction is prose, and prose relies on the caller choosing to
// comply. On `spark-facilitator/20260820-0817`, Phase 3 shipped a
// `journey-deliver.yaml` carrying three violations the linter would have
// named for free. Nothing ran it, so the defects reached a real device and
// cost real dispatches to diagnose.
//
// What's pinned here: `runRecipe` itself lints, so an unlinted recipe
// cannot reach a device at all. The rule moves out of a skill's memory and
// into the boundary every dispatch already crosses.
//
// Also pinned: the rail does NOT fire on the shipped static palette. A
// preventer that rejects good recipes is worse than the defect it replaces,
// so the palette sweep is part of the contract, not a one-off check.

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { MobileClient } from '../../../mcp/mobile/client.js';
import { MobileError } from '../../../mcp/mobile/errors.js';
import { lintRecipeText } from '../../../mcp/mobile/recipe-lint.js';
import { loadSelectorTypes } from '../../../mcp/mobile/recipe-resolver.js';

process.env.ACE_SCREENSHOT_ROOT = os.tmpdir();

const tempDirs: string[] = [];

function fakeBackends() {
  const avd = {
    ensureAvdRunning: vi.fn(),
    requireRunningAvd: vi.fn(),
    findRunningAvd: vi.fn().mockResolvedValue(null),
    getAllocatedPorts: vi.fn().mockResolvedValue({ adbServerPort: 5039 }),
    getAdbShell: vi.fn(),
  } as any;
  const maestro = {
    runRecipe: vi.fn().mockResolvedValue({
      status: 'pass',
      exitCode: 0,
      screenshots: [],
      stdout: '',
      stderr: '',
      screenshotsDir: '/tmp',
    }),
  } as any;
  return { avd, maestro };
}

function stageRecipe(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-1690-'));
  tempDirs.push(dir);
  const p = path.join(dir, 'journey-top.yaml');
  fs.writeFileSync(p, body, 'utf8');
  return p;
}

function shotDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-1690-shots-'));
  tempDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe('runRecipe lints before dispatch (ace#1690 gap 1)', () => {
  it('refuses a recipe with an inline key-position selector', async () => {
    // The exact shape that reached the device: resolves to
    // `- tapOn: text: "RECORD LOCATION"`, which is not parseable YAML.
    const recipePath = stageRecipe(
      'appId: org.commcare.dalvik\n---\n- tapOn: ${SELECTOR:geopoint-record-location}\n',
    );
    const { avd, maestro } = fakeBackends();
    const client = new MobileClient({ avd, maestro, cloud: null as any, bootstrapConfig: null });

    await expect(client.runRecipe(recipePath, {}, shotDir())).rejects.toMatchObject({
      code: 'RECIPE_LINT_FAILED',
    });
    // The point of the rail: Maestro is never invoked.
    expect(maestro.runRecipe).not.toHaveBeenCalled();
  });

  it('names the rule, the line and a remediation — not just "invalid"', async () => {
    const recipePath = stageRecipe(
      'appId: org.commcare.dalvik\n---\n- tapOn: ${SELECTOR:geopoint-record-location}\n',
    );
    const { avd, maestro } = fakeBackends();
    const client = new MobileClient({ avd, maestro, cloud: null as any, bootstrapConfig: null });

    const err = await client.runRecipe(recipePath, {}, shotDir()).catch((e) => e);
    expect(err).toBeInstanceOf(MobileError);
    expect(err.message).toContain('selector-inline-key-position');
    expect(err.message).toContain('journey-top.yaml');
    expect(err.remediation).toBeTruthy();
    expect((err.diagnostics as any).violations.length).toBeGreaterThan(0);
  });

  it('lets a clean recipe through to the backend', async () => {
    const recipePath = stageRecipe(
      'appId: org.commcare.dalvik\n---\n- tapOn:\n    text: "Continue"\n',
    );
    const { avd, maestro } = fakeBackends();
    const client = new MobileClient({ avd, maestro, cloud: null as any, bootstrapConfig: null });

    const result = await client.runRecipe(recipePath, {}, shotDir());
    expect(result.status).toBe('pass');
    expect(maestro.runRecipe).toHaveBeenCalled();
  });

  it('does not reject any recipe in the shipped static palette', () => {
    // The false-positive guard. If a future lint rule starts rejecting a
    // good palette recipe, this fails here rather than mid-run on a device.
    let selectorTypes: Record<string, 'id' | 'text' | 'point'> | undefined;
    try {
      selectorTypes = loadSelectorTypes('2.63.2');
    } catch {
      selectorTypes = undefined;
    }
    const root = path.resolve(__dirname, '../../../mcp/mobile/recipes');
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ya?ml)$/.test(e.name)) files.push(p);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(0);

    const failing = files
      .map((f) => ({ f, res: lintRecipeText(fs.readFileSync(f, 'utf8'), { selectorTypes }) }))
      .filter((x) => !x.res.ok)
      .map((x) => `${path.relative(root, x.f)}: ${x.res.violations.map((v) => v.rule).join(',')}`);

    expect(failing).toEqual([]);
  });
});
