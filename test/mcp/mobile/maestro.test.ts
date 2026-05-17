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

describe('MaestroBackend.runRecipe — split-and-dump path (when `serial` is provided)', () => {
  // Helper: a shell mock that records every call and routes by command-prefix
  // pattern rather than exact-string match (chunk paths contain random
  // mkdtemp suffixes that are unknown at test-author time).
  function makeRoutingShell(routes: Array<{ match: (cmd: string, args: string[]) => boolean; reply: { stdout?: string; stderr?: string; code?: number } }>) {
    const calls: { cmd: string; args: string[] }[] = [];
    const shell = vi.fn(async (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      for (const r of routes) {
        if (r.match(cmd, args)) {
          return { stdout: r.reply.stdout ?? '', stderr: r.reply.stderr ?? '', exitCode: r.reply.code ?? 0 };
        }
      }
      throw new Error(`Unscripted shell call: ${cmd} ${args.join(' ')}`);
    });
    return { shell, calls };
  }

  it('runs N+1 sub-recipes for N takeScreenshot steps, capturing UI dumps between them', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mob-split-'));
    const recipePath = path.join(tmp, 'flow.yaml');
    fs.writeFileSync(
      recipePath,
      'appId: org.commcare.dalvik\n---\n- tapOn: A\n- takeScreenshot: "screen-a"\n- tapOn: B\n- takeScreenshot: "screen-b"\n- tapOn: C\n',
    );

    const { shell, calls } = makeRoutingShell([
      {
        // Any `maestro test ...` invocation — the chunk path is opaque.
        match: (cmd, args) => cmd === 'maestro' && args.includes('test'),
        reply: { stdout: 'OK\n', code: 0 },
      },
      {
        // `adb -s emulator-5554 shell uiautomator dump <devicePath>` — write
        // a fake XML into the host-side dump path so the post-chunk pull is
        // representative of a real success.
        match: (cmd, args) => cmd === 'adb' && args.includes('uiautomator') && args.includes('dump'),
        reply: { stdout: '', code: 0 },
      },
      {
        // `adb -s emulator-5554 pull <devicePath> <hostPath>` — emulate
        // the pull producing the file on disk so collectScreenshots
        // discovers the .xml sibling.
        match: (cmd, args) => cmd === 'adb' && args.includes('pull'),
        reply: { stdout: '', code: 0 },
      },
    ]);

    // Side-effect: when the pull "succeeds" in our mock, the real pull
    // would have written a file. Simulate that so collectScreenshots
    // sees a sibling .xml.
    const originalShellFn = shell;
    const wrappedShell = vi.fn(async (cmd: string, args: string[]) => {
      const result = await originalShellFn(cmd, args);
      if (cmd === 'adb' && args.includes('pull')) {
        const hostPath = args[args.length - 1];
        fs.writeFileSync(hostPath, '<hierarchy/>\n');
      }
      // Maestro takeScreenshot would normally produce a PNG; simulate
      // that whenever Maestro test runs against a chunk that contains a
      // takeScreenshot step.
      if (cmd === 'maestro' && args.includes('test')) {
        const chunkPath = args[args.length - 1];
        if (fs.existsSync(chunkPath)) {
          const body = fs.readFileSync(chunkPath, 'utf8');
          const match = body.match(/takeScreenshot:\s*"([^"]+)"/);
          if (match) {
            fs.writeFileSync(path.join(tmp, `${match[1]}.png`), 'fake-png');
          }
        }
      }
      return result;
    });

    const backend = new MaestroBackend({ shell: wrappedShell });
    const r = await backend.runRecipe(recipePath, {}, tmp, { serial: 'emulator-5554' });

    expect(r.status).toBe('pass');
    // 3 chunks → 3 maestro test calls; 2 ended in screenshot → 2 dumps × 2 adb calls (dump + pull) = 4 adb calls.
    const maestroCalls = calls.filter((c) => c.cmd === 'maestro' && c.args.includes('test'));
    expect(maestroCalls).toHaveLength(3);
    const adbDumpCalls = calls.filter((c) => c.cmd === 'adb' && c.args.includes('uiautomator'));
    expect(adbDumpCalls).toHaveLength(2);
    const adbPullCalls = calls.filter((c) => c.cmd === 'adb' && c.args.includes('pull'));
    expect(adbPullCalls).toHaveLength(2);
    // ScreenshotEntry's `uiDumpPath` is populated for both captured surfaces.
    const screensWithDumps = r.screenshots.filter((s) => s.uiDumpPath !== undefined);
    expect(screensWithDumps.map((s) => s.stepName).sort()).toEqual(['screen-a', 'screen-b']);
  });

  it('stops after first failing sub-recipe and skips remaining dumps', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mob-split-fail-'));
    const recipePath = path.join(tmp, 'flow.yaml');
    fs.writeFileSync(
      recipePath,
      'appId: x\n---\n- tapOn: A\n- takeScreenshot: "screen-a"\n- tapOn: B\n- takeScreenshot: "screen-b"\n',
    );

    let maestroCallNum = 0;
    const calls: { cmd: string; args: string[] }[] = [];
    const shell = vi.fn(async (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      if (cmd === 'maestro' && args.includes('test')) {
        maestroCallNum++;
        // First chunk: fail. Should NOT proceed to dump or to chunk 2.
        return { stdout: '', stderr: 'maestro halt', exitCode: 1 };
      }
      throw new Error(`Unexpected call: ${cmd} ${args.join(' ')}`);
    });
    const backend = new MaestroBackend({ shell });
    const r = await backend.runRecipe(recipePath, {}, tmp, { serial: 'emulator-5554' });

    expect(r.status).toBe('fail');
    expect(r.exitCode).toBe(1);
    expect(maestroCallNum).toBe(1);
    // No adb calls at all — first chunk failed before the dump window.
    expect(calls.filter((c) => c.cmd === 'adb')).toHaveLength(0);
  });

  it('copies sibling palette YAMLs into the chunk dir so runFlow.file refs resolve', async () => {
    // Reproducer for the Phase 6 "Flow file does not exist:
    // .../ace-recipe-chunks-XXX/connect-login.yaml" failure: the splitter
    // writes chunk-N.yaml into a fresh tmp dir, but Maestro resolves
    // `runFlow.file: connect-login.yaml` relative to the chunk's parent
    // dir — the palette must live next to the chunk.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mob-split-palette-'));
    const recipePath = path.join(tmp, 'flow.yaml');
    fs.writeFileSync(
      recipePath,
      'appId: org.commcare.dalvik\n---\n- runFlow:\n    file: connect-login.yaml\n- takeScreenshot: "after-login"\n- tapOn: B\n',
    );
    // Sibling palette that the chunked flow references.
    const palettePath = path.join(tmp, 'connect-login.yaml');
    fs.writeFileSync(palettePath, 'appId: org.commcare.dalvik\n---\n- tapOn: SignIn\n');

    const observedChunkDirs = new Set<string>();
    const shell = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === 'maestro' && args.includes('test')) {
        const chunkPath = args[args.length - 1];
        const dir = path.dirname(chunkPath);
        observedChunkDirs.add(dir);
        // Synthesize the screenshot Maestro would have taken so collect succeeds.
        const body = fs.readFileSync(chunkPath, 'utf8');
        const m = body.match(/takeScreenshot:\s*"([^"]+)"/);
        if (m) fs.writeFileSync(path.join(tmp, `${m[1]}.png`), 'fake');
      }
      if (cmd === 'adb' && args.includes('pull')) {
        fs.writeFileSync(args[args.length - 1], '<hierarchy/>\n');
      }
      return { stdout: 'OK\n', stderr: '', exitCode: 0 };
    });

    const backend = new MaestroBackend({ shell });
    const r = await backend.runRecipe(recipePath, {}, tmp, { serial: 'emulator-5554' });
    expect(r.status).toBe('pass');

    // The chunk dir(s) the splitter created must contain the palette
    // YAML so Maestro's relative `runFlow.file` resolves successfully.
    expect(observedChunkDirs.size).toBeGreaterThan(0);
    for (const dir of observedChunkDirs) {
      // Chunk dir is left behind only on failure; on success it's cleaned up.
      // Either way, the palette must have been present at the moment of
      // the maestro call — so we re-create the assertion via a probe of
      // the parent tmpdir pattern: the chunk dir basename must start with
      // 'ace-recipe-chunks-' (sanity), and during the maestro call the
      // palette was readable. We assert the latter by checking that the
      // splitter behavior preserved the palette path resolution: copy the
      // sibling, run again with a no-op shell that asserts palette presence.
      expect(path.basename(dir)).toMatch(/^ace-recipe-chunks-/);
    }

    // Stronger assertion: invoke a second run where the shell ASSERTS
    // the palette is co-located with the chunk file at maestro-call time.
    let paletteSeenNextToChunk = false;
    const assertingShell = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === 'maestro' && args.includes('test')) {
        const chunkPath = args[args.length - 1];
        const dir = path.dirname(chunkPath);
        if (fs.existsSync(path.join(dir, 'connect-login.yaml'))) {
          paletteSeenNextToChunk = true;
        }
        const body = fs.readFileSync(chunkPath, 'utf8');
        const m = body.match(/takeScreenshot:\s*"([^"]+)"/);
        if (m) fs.writeFileSync(path.join(tmp, `${m[1]}.png`), 'fake');
      }
      if (cmd === 'adb' && args.includes('pull')) {
        fs.writeFileSync(args[args.length - 1], '<hierarchy/>\n');
      }
      return { stdout: 'OK\n', stderr: '', exitCode: 0 };
    });
    const backend2 = new MaestroBackend({ shell: assertingShell });
    const r2 = await backend2.runRecipe(recipePath, {}, tmp, { serial: 'emulator-5554' });
    expect(r2.status).toBe('pass');
    expect(paletteSeenNextToChunk).toBe(true);
  });

  it('falls back to single-invocation when the recipe has no takeScreenshot steps', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mob-split-empty-'));
    const recipePath = path.join(tmp, 'flow.yaml');
    fs.writeFileSync(recipePath, 'appId: x\n---\n- tapOn: A\n- tapOn: B\n');

    const calls: { cmd: string; args: string[] }[] = [];
    const shell = vi.fn(async (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return { stdout: 'OK\n', stderr: '', exitCode: 0 };
    });
    const backend = new MaestroBackend({ shell });
    const r = await backend.runRecipe(recipePath, {}, tmp, { serial: 'emulator-5554' });

    expect(r.status).toBe('pass');
    // Exactly ONE maestro test call (no chunking).
    const maestroCalls = calls.filter((c) => c.cmd === 'maestro' && c.args.includes('test'));
    expect(maestroCalls).toHaveLength(1);
    // Single-invocation pointed at the ORIGINAL recipePath, not a chunk file.
    expect(maestroCalls[0].args[maestroCalls[0].args.length - 1]).toBe(recipePath);
    // No dump calls — nothing to capture.
    expect(calls.filter((c) => c.cmd === 'adb')).toHaveLength(0);
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

describe('MaestroBackend.ensureDriverInstalled', () => {
  it('short-circuits when both driver packages are already present', async () => {
    const calls: string[] = [];
    const shell = vi.fn(async (cmd: string, args: string[]) => {
      calls.push(`${cmd} ${args.join(' ')}`);
      // First call: `pm list packages dev.mobile.maestro` — both halves listed.
      return {
        stdout: 'package:dev.mobile.maestro\npackage:dev.mobile.maestro.test\n',
        stderr: '',
        exitCode: 0,
      };
    });
    const backend = new MaestroBackend({ shell });
    const actions = await backend.ensureDriverInstalled('emulator-5554');
    expect(actions).toEqual(['already-installed']);
    // Cheap probe only — no extraction, no `adb install`.
    expect(calls).toEqual([
      'adb -s emulator-5554 shell pm list packages dev.mobile.maestro',
    ]);
  });

  it('returns MAESTRO_DRIVER_APK_MISSING when neither package is present and the jar is absent', async () => {
    // Force HOME to a guaranteed-empty tempdir so ~/.maestro/lib/maestro-client.jar
    // resolves to a missing path regardless of the developer's local install.
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-no-maestro-'));
    const origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    try {
      const shell = vi.fn(async (cmd: string, args: string[]) => {
        // First probe: neither package installed.
        if (args.join(' ').endsWith('pm list packages dev.mobile.maestro')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        // `cmd package list packages` succeeds (pm ready) so we get past
        // waitForPackageManager and hit the jar-resolution failure.
        if (args.join(' ').endsWith('cmd package list packages')) {
          return { stdout: 'package:android\n', stderr: '', exitCode: 0 };
        }
        throw new Error(`Unscripted shell call: ${cmd} ${args.join(' ')}`);
      });
      const backend = new MaestroBackend({ shell });
      await expect(backend.ensureDriverInstalled('emulator-5554')).rejects.toMatchObject({
        code: 'MAESTRO_DRIVER_APK_MISSING',
      });
    } finally {
      if (origHome === undefined) delete process.env.HOME;
      else process.env.HOME = origHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
