/**
 * The emulator temp-partition COLLECTOR — the half that actually unlinks
 * (ace#2092).
 *
 * `test/lib/emulator-temp-sweep.test.ts` covers the decision logic over
 * fixture inputs. This file covers the part that can destroy something: the
 * real `lsof` read, the realpath handling, and the `unlink`.
 *
 * The load-bearing case is the NEGATIVE control, and it uses a REAL live
 * holder — the test process opens a file descriptor and keeps it — rather
 * than a stubbed open-path set. That is the only way to prove the collector's
 * lsof invocation and its path normalisation agree with each other. On macOS
 * `/tmp` is a symlink to `/private/tmp` and `lsof` reports the resolved form,
 * so an unresolved candidate path matches nothing in the open set and every
 * LIVE partition reads as an orphan — a silent, total inversion of the safety
 * property. A test that stubs `openPaths` cannot see it.
 *
 * Hermetic: `ACE_EMULATOR_TEMP_DIR` points the scan at a fixture directory and
 * `ACE_EMULATOR_TEMP_PS_FIXTURE` supplies the process table, so nothing here
 * depends on whether the machine running `npm test` has an emulator up.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sweepEmulatorTempPartitions, emulatorTempDirs } from '../../../mcp/mobile/session-lock.js';

let dir: string;
let realDir: string;
const openFds: number[] = [];
const savedEnv: Record<string, string | undefined> = {};

const HOUR = 60 * 60 * 1000;

/** A `ps -eo user=,pid=,ppid=,lstart=,command=` capture with N emulator rows. */
function psFixture(emulatorRows: number): string {
  const lines = [
    'acedimagi   501     1 Sun Sep  6 09:00:00 2026 /usr/sbin/syslogd',
    'acedimagi   777     1 Sun Sep  6 09:00:00 2026 /bin/zsh -l',
  ];
  for (let i = 0; i < emulatorRows; i++) {
    lines.push(
      `acedimagi  ${9000 + i}     1 Sun Sep  6 09:00:00 2026 ` +
        `/opt/homebrew/share/android-commandlinetools/emulator/qemu/darwin-aarch64/qemu-system-aarch64 ` +
        `-avd ACE_Pixel_API_34 -port ${5554 + i * 2} -read-only`,
    );
  }
  const p = path.join(dir, `ps-${emulatorRows}.txt`);
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

/** Create a partition file with a given age and size. Returns its realpath. */
function partition(name: string, ageMs: number, sizeBytes = 4096): string {
  const p = path.join(realDir, name);
  fs.writeFileSync(p, Buffer.alloc(sizeBytes));
  const t = (Date.now() - ageMs) / 1000;
  fs.utimesSync(p, t, t);
  return p;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-emu-temp-'));
  realDir = fs.realpathSync(dir);
  for (const k of ['ACE_EMULATOR_TEMP_DIR', 'ACE_EMULATOR_TEMP_PS_FIXTURE']) {
    savedEnv[k] = process.env[k];
  }
  process.env.ACE_EMULATOR_TEMP_DIR = dir;
  process.env.ACE_EMULATOR_TEMP_PS_FIXTURE = psFixture(0);
});

afterEach(() => {
  for (const fd of openFds.splice(0)) {
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed */
    }
  }
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('NEGATIVE CONTROL — a partition a live process holds open survives', () => {
  it('does not delete a file this process has open, and does delete its dead sibling', () => {
    const live = partition('emulator-LIVE01.qcow2', 48 * HOUR);
    const dead = partition('emulator-DEAD01.qcow2', 48 * HOUR);

    // A real, live holder — not a stub. lsof must find THIS process.
    openFds.push(fs.openSync(live, 'r'));

    const out = sweepEmulatorTempPartitions();

    expect(out.plan.skipped).toBeNull();
    expect(out.deleted).toEqual([dead]);
    expect(fs.existsSync(live)).toBe(true);
    expect(fs.existsSync(dead)).toBe(false);
    expect(out.plan.retained.map((r) => [path.basename(r.file.path), r.reason])).toEqual([
      ['emulator-LIVE01.qcow2', 'held-open'],
    ]);
  });

  it('a dry run deletes nothing, even with orphans present', () => {
    const dead = partition('emulator-DEAD02.qcow2', 48 * HOUR);
    const out = sweepEmulatorTempPartitions({ dryRun: true });

    expect(out.plan.orphans.map((f) => f.path)).toEqual([dead]);
    expect(out.deleted).toEqual([]);
    expect(out.deleted_bytes).toBe(0);
    expect(fs.existsSync(dead)).toBe(true);
  });

  it('refuses everything when the process table shows a live emulator and nothing is open', () => {
    const dead = partition('emulator-DEAD03.qcow2', 48 * HOUR);
    process.env.ACE_EMULATOR_TEMP_PS_FIXTURE = psFixture(2);

    const out = sweepEmulatorTempPartitions();

    expect(out.plan.skipped).toMatch(/2 live emulator process\(es\)/);
    expect(out.deleted).toEqual([]);
    expect(fs.existsSync(dead)).toBe(true);
  });

  it('does NOT refuse when a live emulator holds one of the files — that is agreement', () => {
    const live = partition('emulator-LIVE04.qcow2', 48 * HOUR);
    const dead = partition('emulator-DEAD04.qcow2', 48 * HOUR);
    openFds.push(fs.openSync(live, 'r'));
    process.env.ACE_EMULATOR_TEMP_PS_FIXTURE = psFixture(1);

    const out = sweepEmulatorTempPartitions();

    expect(out.plan.skipped).toBeNull();
    expect(out.deleted).toEqual([dead]);
    expect(fs.existsSync(live)).toBe(true);
  });

  it('refuses when the ps fixture is unreadable — unknown is not zero', () => {
    const dead = partition('emulator-DEAD05.qcow2', 48 * HOUR);
    process.env.ACE_EMULATOR_TEMP_PS_FIXTURE = path.join(dir, 'no-such-ps.txt');

    const out = sweepEmulatorTempPartitions();

    expect(out.plan.skipped).toMatch(/lsof could not be run|refusing to delete/);
    expect(out.deleted).toEqual([]);
    expect(fs.existsSync(dead)).toBe(true);
    expect(out.errors.join('\n')).toMatch(/ps failed/);
  });
});

describe('what the collector will and will not touch', () => {
  it('leaves everything that is not an `emulator-<token>.qcow2`', () => {
    const config = path.join(realDir, 'emulator-o4Anp8'); // real name shape
    const persistent = path.join(realDir, 'userdata-qemu.qcow2');
    const unrelated = path.join(realDir, 'important.txt');
    for (const p of [config, persistent, unrelated]) {
      fs.writeFileSync(p, 'x');
      const t = (Date.now() - 48 * HOUR) / 1000;
      fs.utimesSync(p, t, t);
    }
    const dead = partition('emulator-DEAD06.qcow2', 48 * HOUR);

    const out = sweepEmulatorTempPartitions();

    expect(out.deleted).toEqual([dead]);
    for (const p of [config, persistent, unrelated]) expect(fs.existsSync(p)).toBe(true);
  });

  it('never even CONSIDERS a directory whose name matches the partition pattern', () => {
    // lstat + isFile(). Asserting only "it still exists" would be a fake
    // control: `unlink` on a directory fails anyway, so a version with the
    // isFile() guard removed would also leave it there — it would just log an
    // error. So assert the sweep produced NO error either, which is only true
    // if the entry was filtered before the unlink was attempted.
    const trap = path.join(realDir, 'emulator-TRAP01.qcow2');
    fs.mkdirSync(trap);
    const t = (Date.now() - 48 * HOUR) / 1000;
    fs.utimesSync(trap, t, t);

    const out = sweepEmulatorTempPartitions();

    expect(out.deleted).toEqual([]);
    expect(out.errors).toEqual([]);
    expect(out.plan.orphans).toEqual([]);
    expect(out.plan.retained).toEqual([]);
    expect(fs.existsSync(trap)).toBe(true);
  });

  it('leaves an OLD symlink that points at a real partition-shaped path', () => {
    // lstat, not stat: we never follow a link into an unlink, and unlinking
    // the link itself is not our business either.
    //
    // `lutimes` ages the LINK, not its target. Without that the link's own
    // mtime is "now" and the grace window retains it for the wrong reason —
    // which is how the first draft of this test passed against a build with
    // the isFile() guard deleted.
    const target = path.join(dir, 'elsewhere.qcow2');
    fs.writeFileSync(target, 'x');
    const link = path.join(realDir, 'emulator-LINK01.qcow2');
    fs.symlinkSync(target, link);
    const t = (Date.now() - 48 * HOUR) / 1000;
    fs.lutimesSync(link, t, t);
    expect(Date.now() - fs.lstatSync(link).mtimeMs).toBeGreaterThan(24 * HOUR);

    const out = sweepEmulatorTempPartitions();

    expect(out.deleted).toEqual([]);
    expect(out.plan.orphans).toEqual([]);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(target)).toBe(true);
  });

  it('reports reclaimed bytes that match the files it removed', () => {
    const a = partition('emulator-D1.qcow2', 48 * HOUR, 8192);
    const b = partition('emulator-D2.qcow2', 48 * HOUR, 4096);
    const out = sweepEmulatorTempPartitions();
    expect(new Set(out.deleted)).toEqual(new Set([a, b]));
    expect(out.deleted_bytes).toBe(12288);
    expect(out.plan.reclaimableBytes).toBe(12288);
  });

  it('is a clean no-op on an empty temp dir', () => {
    const out = sweepEmulatorTempPartitions();
    expect(out.plan.skipped).toBeNull();
    expect(out.deleted).toEqual([]);
    expect(out.errors).toEqual([]);
  });
});

describe('emulatorTempDirs', () => {
  it('resolves symlinks, so lsof paths and candidate paths can match', () => {
    // The whole safety property depends on this. `/tmp` -> `/private/tmp` on
    // macOS; an unresolved path matches nothing in lsof's output and every
    // live partition would read as an orphan.
    process.env.ACE_EMULATOR_TEMP_DIR = dir;
    expect(emulatorTempDirs()).toEqual([realDir]);
  });

  it('drops directories that do not exist rather than erroring', () => {
    process.env.ACE_EMULATOR_TEMP_DIR = path.join(dir, 'nope');
    expect(emulatorTempDirs()).toEqual([]);
  });
});
