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

  it('prepends --host/--port when adbPort is given (bypasses adb-server)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mob-'));
    const recipePath = path.join(tmp, 'flow.yaml');
    fs.writeFileSync(recipePath, 'appId: x\n');

    const shell = fakeShell({
      [`maestro --host=localhost --port=5559 test --no-ansi --output ${tmp} ${recipePath}`]: {
        stdout: 'OK\n', code: 0,
      },
    });
    const backend = new MaestroBackend({ shell });
    const r = await backend.runRecipe(recipePath, {}, tmp, { adbPort: 5559 });
    expect(r.status).toBe('pass');
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

describe('MaestroBackend.probeDriver', () => {
  it('returns healthy when maestro hierarchy exits 0', async () => {
    const shell = fakeShell({
      'maestro --host=localhost --port=5555 hierarchy': { stdout: '<hierarchy/>\n', code: 0 },
    });
    const backend = new MaestroBackend({ shell });
    const r = await backend.probeDriver(5555);
    expect(r.healthy).toBe(true);
    expect(r.reason).toBeUndefined();
  });

  it('returns unhealthy with reason when maestro hierarchy fails', async () => {
    const shell = fakeShell({
      'maestro --host=localhost --port=5555 hierarchy': {
        stdout: '', stderr: 'io.grpc.StatusRuntimeException: UNAVAILABLE: io exception\n', code: 1,
      },
    });
    const backend = new MaestroBackend({ shell });
    const r = await backend.probeDriver(5555);
    expect(r.healthy).toBe(false);
    expect(r.reason).toMatch(/UNAVAILABLE|exit 1/);
  });

  it('returns unhealthy when shell throws (timeout, missing binary, etc.)', async () => {
    const shell = vi.fn(async () => {
      throw new Error('maestro: command not found');
    });
    const backend = new MaestroBackend({ shell });
    const r = await backend.probeDriver(5555);
    expect(r.healthy).toBe(false);
    expect(r.reason).toMatch(/command not found/);
  });
});

describe('MaestroBackend.repairDriver', () => {
  it('issues force-stop, adb uninstall, AND pm uninstall -k --user 0 for both halves', async () => {
    const calls: string[] = [];
    const shell = vi.fn(async (cmd: string, args: string[]) => {
      calls.push(`${cmd} ${args.join(' ')}`);
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const backend = new MaestroBackend({ shell });
    const actions = await backend.repairDriver('emulator-5554');
    expect(actions).toEqual(['force-stop', 'uninstall', 'pm-uninstall-user-0']);
    expect(calls).toEqual([
      'adb -s emulator-5554 shell am force-stop dev.mobile.maestro',
      'adb -s emulator-5554 shell am force-stop dev.mobile.maestro.test',
      'adb -s emulator-5554 uninstall dev.mobile.maestro',
      'adb -s emulator-5554 uninstall dev.mobile.maestro.test',
      'adb -s emulator-5554 shell pm uninstall -k --user 0 dev.mobile.maestro',
      'adb -s emulator-5554 shell pm uninstall -k --user 0 dev.mobile.maestro.test',
    ]);
  });

  it('swallows errors so a missing-package uninstall does not abort recovery', async () => {
    // adb uninstall fails noisily when the package is not installed; that's
    // not a recovery failure — the next probe call reinstalls it.
    const shell = vi.fn(async () => {
      throw new Error('Unknown package: dev.mobile.maestro');
    });
    const backend = new MaestroBackend({ shell });
    await expect(backend.repairDriver('emulator-5554')).resolves.toEqual([
      'force-stop',
      'uninstall',
      'pm-uninstall-user-0',
    ]);
  });
});
