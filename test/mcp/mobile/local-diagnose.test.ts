import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AvdBackend } from '../../../mcp/mobile/backends/avd.js';
import { CAPABILITY_MAP } from '../../../mcp/mobile/capability-map.js';

// dimagi-internal/ace#961 — the local AVD backend boots the emulator against
// its OWN adb server (probe-allocated from 5037 upward, typically 5039 when a
// sibling session already holds 5037). A raw `adb devices` from a session
// shell therefore talks to the DEFAULT 5037, prints an empty device list, and
// reads exactly like a dead emulator. It cost real time on 2026-07-26 while
// validating #957: `mobile_capture_ui_dump` returned a live hierarchy at the
// same moment `adb devices` showed nothing.
//
// `mobile_diagnose` was cloud-only, so the local backend had NO self-describing
// probe and the process table was the only authoritative read. These tests pin
// the preventer: the local diagnose reports the adb server port and serial it
// is actually using.
//
// Ports are pinned via env so `getAllocatedPorts` takes the env branch and no
// real TCP probe fires (see `resolveAdbServerPort` / `resolveEmulatorPair`).

const ADB_PORT = '5039';
const EMU_PORT = '5556';

let savedAdb: string | undefined;
let savedEmu: string | undefined;

beforeEach(() => {
  savedAdb = process.env.ANDROID_ADB_SERVER_PORT;
  savedEmu = process.env.ACE_MOBILE_EMULATOR_PORT;
  process.env.ANDROID_ADB_SERVER_PORT = ADB_PORT;
  process.env.ACE_MOBILE_EMULATOR_PORT = EMU_PORT;
});

afterEach(() => {
  if (savedAdb === undefined) delete process.env.ANDROID_ADB_SERVER_PORT;
  else process.env.ANDROID_ADB_SERVER_PORT = savedAdb;
  if (savedEmu === undefined) delete process.env.ACE_MOBILE_EMULATOR_PORT;
  else process.env.ACE_MOBILE_EMULATOR_PORT = savedEmu;
});

/** A shell mock scripted for the diagnose call sequence. */
function makeShell(opts: { devices?: string; avdName?: string; avds?: string; throwOnDevices?: boolean } = {}) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const shell = vi.fn(async (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    const ok = (stdout: string) => ({ stdout, stderr: '', exitCode: 0, code: 0 });
    if (cmd === 'adb' && args[0] === 'devices') {
      if (opts.throwOnDevices) throw new Error('adb: cannot connect to daemon');
      return ok(opts.devices ?? 'List of devices attached\nemulator-5556\tdevice\n');
    }
    if (cmd === 'adb' && args.includes('name')) return ok(opts.avdName ?? 'ACE_Pixel_API_34\n');
    if (cmd === 'emulator' && args[0] === '-list-avds') {
      return ok(opts.avds ?? 'ACE_Pixel_API_34\nACE_Pixel_API_33\n');
    }
    return ok('');
  });
  return { shell, calls };
}

describe('AvdBackend.diagnose reports the adb port + serial it actually uses (#961)', () => {
  it('names the allocated adb server port, not the default 5037', async () => {
    const { shell } = makeShell();
    const avd = new AvdBackend({ shell: shell as never });
    const d = await avd.diagnose();

    // THE defect: without this, nothing in-session tells you which server
    // the emulator is on, so `adb devices` on 5037 reads as a dead device.
    expect(d.adb_server_port).toBe(Number(ADB_PORT));
    expect(d.adb_server_port).not.toBe(5037);
    // And the copy-pasteable remediation must be present verbatim.
    expect(d.adb_env_hint).toBe(`ANDROID_ADB_SERVER_PORT=${ADB_PORT}`);
    expect(d.backend).toBe('local');
  });

  it('reports the serial + AVD name of the running emulator', async () => {
    const { shell } = makeShell();
    const avd = new AvdBackend({ shell: shell as never });
    const d = await avd.diagnose();

    expect(d.adb_devices).toEqual([{ serial: 'emulator-5556', state: 'device' }]);
    expect(d.adb_visible_count).toBe(1);
    expect(d.avd_serial).toBe('emulator-5556');
    expect(d.avd_name).toBe('ACE_Pixel_API_34');
  });

  it('reports the emulator console + adb-bridge ports and the known AVDs', async () => {
    const { shell } = makeShell();
    const avd = new AvdBackend({ shell: shell as never });
    const d = await avd.diagnose();

    expect(d.emulator_console_port).toBe(Number(EMU_PORT));
    expect(d.emulator_adb_bridge_port).toBe(Number(EMU_PORT) + 1);
    expect(d.ports_auto_allocated).toBe(false); // env-pinned in this test
    expect(d.known_avds).toEqual(['ACE_Pixel_API_34', 'ACE_Pixel_API_33']);
  });

  it('distinguishes "no device on OUR port" from "adb is broken"', async () => {
    // An empty list on the right port is a real answer, not an error — the
    // caller must be able to tell it apart from a failed probe.
    const empty = makeShell({ devices: 'List of devices attached\n\n' });
    const dEmpty = await new AvdBackend({ shell: empty.shell as never }).diagnose();
    expect(dEmpty.adb_visible_count).toBe(0);
    expect(dEmpty.adb_error).toBeNull();
    expect(dEmpty.adb_server_port).toBe(Number(ADB_PORT));

    const broken = makeShell({ throwOnDevices: true });
    const dBroken = await new AvdBackend({ shell: broken.shell as never }).diagnose();
    expect(dBroken.adb_error).toContain('cannot connect to daemon');
    // Still reports the port — that is the field you need most when adb dies.
    expect(dBroken.adb_server_port).toBe(Number(ADB_PORT));
  });

  it('is read-only: never boots, kills, or wipes', async () => {
    const { shell, calls } = makeShell();
    await new AvdBackend({ shell: shell as never }).diagnose();
    const mutating = calls.filter(
      (c) =>
        c.cmd === 'emulator' && c.args.some((a) => /-wipe-data|-no-snapshot-load/.test(a)),
    );
    expect(mutating).toEqual([]);
    for (const c of calls) {
      expect(c.args.join(' ')).not.toMatch(/emu kill|reboot|install|uninstall/);
    }
  });
});

describe('mobile_diagnose is no longer cloud-only (#961)', () => {
  it('the capability map routes diagnose to both backends', () => {
    // Pre-fix: `{ backend: 'CLOUD', ... 'Throws CLOUD_ONLY_OPERATION on local AVD.' }`
    expect(CAPABILITY_MAP.diagnose.backend).not.toBe('CLOUD');
    expect(CAPABILITY_MAP.diagnose.description).not.toMatch(/CLOUD_ONLY_OPERATION/);
    expect(CAPABILITY_MAP.diagnose.description).toMatch(/adb server port/i);
    // Its cloud-only siblings must NOT have been loosened by the same change.
    expect(CAPABILITY_MAP.restart_runner.backend).toBe('CLOUD');
  });

  it('MobileClient.diagnose does not route local callers into requireCloudOnly', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(
        new URL('../../../mcp/mobile/client.ts', import.meta.url).pathname,
        'utf8',
      ),
    );
    // The pre-fix body, verbatim.
    expect(src).not.toMatch(/requireCloudOnly\('mobile_diagnose'\)/);
    // The cloud-only siblings still gate.
    expect(src).toMatch(/requireCloudOnly\('mobile_restart_runner'\)/);
  });

  it('CLAUDE.md names the enforcement instead of "Not enforced"', async () => {
    const md = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../../CLAUDE.md', import.meta.url).pathname, 'utf8'),
    );
    // Anchored on the ENV VAR, not on a port number. The previous version of
    // this guard grepped for `ANDROID_ADB_SERVER_PORT=5039` — i.e. it pinned
    // the very hardcoded constant this gotcha was corrected to remove, so it
    // fired on the fix rather than on a regression.
    const line = md.split('\n').find((l) => l.includes('ANDROID_ADB_SERVER_PORT'));
    expect(line, 'the adb-port gotcha line must still exist').toBeTruthy();
    // The gotcha-maintenance rule: an enforced gotcha names its enforcement.
    expect(line).not.toMatch(/Not enforced/);
    expect(line).toMatch(/mobile_diagnose/);

    // The port is ALLOCATED, not fixed: port-allocator.ts starts at 5037 and
    // walks upward binding a real net.Server so concurrent runs don't collide
    // (a live run was observed on 5038). Writing any single number down as
    // THE port is the defect this line was rewritten to fix — it cost a
    // session two wrong readings, including calling a healthy booted emulator
    // a zombie. A `$var` assignment in the manual sweep is fine; a literal
    // one is not.
    expect(
      line,
      'the gotcha must not hand the reader a fixed port to remember — ask mobile_diagnose',
    ).not.toMatch(/ANDROID_ADB_SERVER_PORT=\d+/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Cross-session AVD contention surfaced through diagnose (ace#1821).
//
// The tests above pin that diagnose reports the port and serial it actually
// uses. That was necessary and NOT sufficient: on
// `bednet-check-2-visit/20260828-0629` every one of those fields was correct
// while nine live ace-mobile MCPs across two macOS accounts cold-booted one
// shared AVD with `-wipe-data`. `adb_visible_count: 0` was true, and read as
// a dead device through four wrong diagnoses.
//
// So the missing field is the only one that describes the HOST rather than
// this session. The classification logic is unit-tested in
// test/lib/mobile-contention.test.ts against a verbatim `ps` capture; these
// tests pin the WIRING — that diagnose asks, that it asks with `ps` and not
// the device, and that it stays read-only.
// ═══════════════════════════════════════════════════════════════════

/** Two chained rows = ONE logical MCP; `ps` prints the whole chain. */
function psTable(rows: Array<{ user: string; pid: number; ppid: number; cmd: string }>): string {
  return rows
    .map((r) => `${r.user} ${r.pid} ${r.ppid} Tue Sep  1 13:26:23 2026 ${r.cmd}`)
    .join('\n');
}

const MOBILE = (v = '0.13.1109') =>
  `npm exec tsx /Users/u/.claude/plugins/cache/ace/ace/${v}/mcp/mobile-server.ts`;

function makeShellWithPs(psOut: string) {
  const { shell, calls } = makeShell();
  const wrapped = vi.fn(async (cmd: string, args: string[]) => {
    if (cmd === 'ps') {
      calls.push({ cmd, args });
      return { stdout: psOut, stderr: '', exitCode: 0, code: 0 };
    }
    return shell(cmd, args);
  });
  return { shell: wrapped, calls };
}

describe('AvdBackend.diagnose surfaces cross-session AVD contention (ace#1821)', () => {
  it('NEGATIVE — names peers sharing the AVD, cross-account included', () => {
    const ps = psTable([
      { user: 'acedimagi', pid: 100, ppid: 1, cmd: MOBILE() },
      { user: 'acedimagi', pid: 101, ppid: 100, cmd: MOBILE() },
      { user: 'jjackson', pid: 200, ppid: 2, cmd: MOBILE('0.13.1053') },
      { user: 'jjackson', pid: 201, ppid: 200, cmd: MOBILE('0.13.1053') },
    ]);
    const { shell } = makeShellWithPs(ps);
    const backend = new AvdBackend({ shell, capabilities: CAPABILITY_MAP } as any);
    return backend.diagnose().then((d: any) => {
      expect(d.contention).not.toBeNull();
      expect(d.contention.verdict).toBe('warn');
      // Two logical MCPs from four ps rows — the 3x-overcount trap.
      expect(d.contention.sessions).toHaveLength(2);
      expect(d.contention.cross_account).toBe(true);
      expect(d.contention.reason).toMatch(/ace#1821/);
      expect(d.contention.known_avd_count).toBe(2); // from `emulator -list-avds`
    });
  });

  it('POSITIVE — a lone session is not reported as contended', async () => {
    const ps = psTable([
      { user: 'acedimagi', pid: process.pid, ppid: 1, cmd: MOBILE() },
    ]);
    const { shell } = makeShellWithPs(ps);
    const backend = new AvdBackend({ shell, capabilities: CAPABILITY_MAP } as any);
    const d: any = await backend.diagnose();
    expect(d.contention.verdict).toBe('pass');
    expect(d.contention.other_mobile_sessions).toBe(0);
  });

  it('SKIPS, never warns, when the ps read fails — diagnose must not die diagnosing', async () => {
    const { shell } = makeShell();
    const wrapped = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === 'ps') throw new Error('ps: command not found');
      return shell(cmd, args);
    });
    const backend = new AvdBackend({ shell: wrapped, capabilities: CAPABILITY_MAP } as any);
    const d: any = await backend.diagnose();
    expect(d.contention.verdict).toBe('skip');
    expect(d.contention.reason).toMatch(/not a claim that none exists/);
    // The rest of the diagnostic still works — the whole point of best-effort.
    expect(d.adb_server_port).toBe(Number(ADB_PORT));
  });

  it('stays READ-ONLY: asks ps, never adb-kill, emu kill, or the emulator binary', async () => {
    const { shell, calls } = makeShellWithPs(psTable([
      { user: 'acedimagi', pid: 100, ppid: 1, cmd: MOBILE() },
    ]));
    const backend = new AvdBackend({ shell, capabilities: CAPABILITY_MAP } as any);
    await backend.diagnose();
    expect(calls.some((c) => c.cmd === 'ps')).toBe(true);
    const flat = calls.map((c) => `${c.cmd} ${c.args.join(' ')}`).join(' | ');
    expect(flat).not.toMatch(/emu kill/);
    expect(flat).not.toMatch(/-wipe-data/);
    expect(flat).not.toMatch(/\bpkill\b|\bkill\b/);
  });
});
