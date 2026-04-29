import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MaestroBackend } from '../../../mcp/mobile/backends/maestro.js';

function fakeShell(scripted: Record<string, { stdout: string; stderr?: string; code?: number }>) {
  return vi.fn(async (cmd: string, args: string[]) => {
    const key = `${cmd} ${args.join(' ')}`;
    const r = scripted[key];
    if (!r) throw new Error(`Unscripted shell call: ${key}`);
    return { stdout: r.stdout, stderr: r.stderr ?? '', exitCode: r.code ?? 0 };
  });
}

describe('MaestroBackend.runRecipe', () => {
  it('passes env vars as -e flags and collects screenshots', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mob-'));
    fs.writeFileSync(path.join(tmp, 'step-01-home.png'), 'fake');
    fs.writeFileSync(path.join(tmp, 'step-02-login.png'), 'fake');
    const recipePath = path.join(tmp, 'flow.yaml');
    fs.writeFileSync(recipePath, 'appId: x\n');

    const shell = fakeShell({
      [`maestro test --no-ansi -e PHONE=+74260000001 -e PIN=123456 --output ${tmp} ${recipePath}`]: {
        stdout: 'OK\n', code: 0,
      },
    });
    const backend = new MaestroBackend({ shell });
    const r = await backend.runRecipe(recipePath, { PHONE: '+74260000001', PIN: '123456' }, tmp);
    expect(r.status).toBe('pass');
    expect(r.screenshots.length).toBeGreaterThanOrEqual(2);
    expect(r.screenshots.map((s) => s.stepName)).toEqual(
      expect.arrayContaining(['step-01-home', 'step-02-login']),
    );
  });

  it('returns fail status with non-zero exit code', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mob-'));
    const recipePath = path.join(tmp, 'flow.yaml');
    fs.writeFileSync(recipePath, 'appId: x\n');

    const shell = fakeShell({
      [`maestro test --no-ansi --output ${tmp} ${recipePath}`]: {
        stdout: '', stderr: 'TIMEOUT', code: 1,
      },
    });
    const backend = new MaestroBackend({ shell });
    const r = await backend.runRecipe(recipePath, {}, tmp);
    expect(r.status).toBe('fail');
    expect(r.exitCode).toBe(1);
  });
});

describe('MaestroBackend.validateRecipe', () => {
  it('rejects YAML with unknown step keys', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mob-'));
    const recipePath = path.join(tmp, 'bad.yaml');
    fs.writeFileSync(recipePath, 'appId: x\n---\n- bogusStep: hi\n');
    const backend = new MaestroBackend({ shell: vi.fn() });
    await expect(backend.validateRecipe(recipePath)).rejects.toThrow(/RECIPE_INVALID|unknown/i);
  });

  it('accepts valid Maestro YAML', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mob-'));
    const recipePath = path.join(tmp, 'good.yaml');
    fs.writeFileSync(recipePath, 'appId: x\n---\n- launchApp\n- takeScreenshot: home\n');
    const backend = new MaestroBackend({ shell: vi.fn() });
    await expect(backend.validateRecipe(recipePath)).resolves.toBeUndefined();
  });
});
