/**
 * `scripts/probe-parallel-sessions.ts --cleanup-only` must not reap
 * every session lock on the machine without an explicit operator yes.
 *
 * ## Why (ace#1704)
 *
 * `--cleanup-only` calls `reapStaleSessions({ all: true })`, which
 * deletes EVERY lock under the shared session dir — including locks
 * held by other live ACE sessions. Those locks are the parallel-session
 * mechanism: `mcp/mobile/port-allocator.ts` picks a free adb/emulator
 * port by excluding ports "reserved by live locks", so deleting a live
 * lock frees its ports for reallocation to a concurrent run.
 *
 * That is legitimate when an operator asks for it (`ace-mobile-reap
 * --all` is exactly that, and stays ungated by design). The hazard here
 * is the NAME: `--cleanup-only` reads as "just tidy up after this
 * probe", not "nuke every session on the host". This pins the gate.
 *
 * Both cases run against a tempdir via ACE_SESSION_LOCK_DIR, so the
 * test can never touch the real `~/.ace/sessions` — the very property
 * ace#1704 was about.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(__dirname, '..', '..');
const PROBE = join(REPO_ROOT, 'scripts', 'probe-parallel-sessions.ts');
const TSX = join(REPO_ROOT, 'node_modules', '.bin', 'tsx');

let lockDir: string;
let lockFile: string;

/** Run the probe with the lock dir pointed at our tempdir. */
async function runProbe(args: string[]) {
  try {
    const { stdout } = await execFileAsync(TSX, [PROBE, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, ACE_SESSION_LOCK_DIR: lockDir },
    });
    return { code: 0, stdout };
  } catch (e: any) {
    return { code: e.code ?? 1, stdout: e.stdout ?? '' };
  }
}

beforeEach(() => {
  lockDir = fs.mkdtempSync(join(tmpdir(), 'ace-probe-gate-'));
  lockFile = join(lockDir, '4242.lock.json');
  fs.writeFileSync(
    lockFile,
    JSON.stringify({
      mcp_pid: 4242,
      started_at: '2026-08-27T00:00:00Z',
      adb_port: 5038,
      emulator_port: 5556,
    }),
    'utf8'
  );
});

afterEach(() => {
  fs.rmSync(lockDir, { recursive: true, force: true });
});

describe('probe-parallel-sessions --cleanup-only gate', () => {
  it('refuses without --yes, names what it would destroy, and reaps nothing', async () => {
    const { code, stdout } = await runProbe(['--cleanup-only']);
    expect(code).toBe(2);
    expect(stdout).toContain('cleanup-only-refused');
    expect(stdout).toContain('4242.lock.json');
    // The whole point: the lock is still there.
    expect(fs.existsSync(lockFile)).toBe(true);
  }, 30_000);

  it('proceeds with --yes', async () => {
    const { code, stdout } = await runProbe(['--cleanup-only', '--yes']);
    expect(code).toBe(0);
    expect(stdout).toContain('cleanup-only-reap');
    expect(fs.existsSync(lockFile)).toBe(false);
  }, 30_000);
});
