/**
 * ace#1821 (visibility half) — the session lock persists the opp, and reading
 * the live set back is what lets one session name another.
 *
 * The CONTROL here is `recordSessionLock persists opp_slug`: on `origin/main`
 * `recordSessionLock` takes only `{adbPort, emulatorPort, avdName}`, so the
 * written file has no `opp_slug` and this case fails. Verified by reverting the
 * three source files — see the PR body.
 *
 * Isolated via `ACE_SESSION_LOCK_DIR`, per the note in `session-lock.test.ts`:
 * `sessionLockDir()` resolves at CALL time, and a suite that skipped this once
 * reaped every live session's lock on the machine (ace#1704). The pid used for
 * "live" rows is `process.pid` — the only pid a test can be certain is alive.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  acquireSessionLock,
  listLiveSessionLocks,
  lockPathForPid,
  updateSessionLockContext,
  type SessionLock,
} from '../../../mcp/mobile/session-lock.js';
import { recordSessionLock } from '../../../mcp/mobile/port-allocator.js';

const DEAD_PID = 9_000_042; // far above any live pid; never signalled

let tmpLockDir: string;
let savedLockDir: string | undefined;
let savedOpp: string | undefined;
let savedRun: string | undefined;

const write = (lock: SessionLock): void => acquireSessionLock(lock);

const base = (pid: number, over: Partial<SessionLock> = {}): SessionLock => ({
  mcp_pid: pid,
  started_at: '2026-09-05T10:00:00.000Z',
  adb_port: 50037,
  emulator_port: 55554,
  ...over,
});

beforeEach(() => {
  savedLockDir = process.env.ACE_SESSION_LOCK_DIR;
  savedOpp = process.env.ACE_OPP_SLUG;
  savedRun = process.env.ACE_RUN_ID;
  delete process.env.ACE_OPP_SLUG;
  delete process.env.ACE_RUN_ID;
  tmpLockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-opp-locks-'));
  process.env.ACE_SESSION_LOCK_DIR = tmpLockDir;
});

afterEach(() => {
  if (savedLockDir === undefined) delete process.env.ACE_SESSION_LOCK_DIR;
  else process.env.ACE_SESSION_LOCK_DIR = savedLockDir;
  if (savedOpp === undefined) delete process.env.ACE_OPP_SLUG;
  else process.env.ACE_OPP_SLUG = savedOpp;
  if (savedRun === undefined) delete process.env.ACE_RUN_ID;
  else process.env.ACE_RUN_ID = savedRun;
  fs.rmSync(tmpLockDir, { recursive: true, force: true });
});

const readLock = (pid: number): SessionLock =>
  JSON.parse(fs.readFileSync(lockPathForPid(pid), 'utf8')) as SessionLock;

describe('CONTROL: recordSessionLock persists the opp context', () => {
  it('writes opp_slug and run_id when given them', () => {
    recordSessionLock({
      adbPort: 50037,
      emulatorPort: 55554,
      oppSlug: 'bednet-check-2-visit',
      runId: '20260905-0912',
    });
    const lock = readLock(process.pid);
    expect(lock.opp_slug).toBe('bednet-check-2-visit');
    expect(lock.run_id).toBe('20260905-0912');
    // the reaper's fields are untouched
    expect(lock.adb_port).toBe(50037);
    expect(lock.emulator_port).toBe(55554);
  });

  it('falls back to the environment', () => {
    process.env.ACE_OPP_SLUG = 'turmeric';
    process.env.ACE_RUN_ID = '20260905-0800';
    recordSessionLock({ adbPort: 50037, emulatorPort: 55554 });
    const lock = readLock(process.pid);
    expect(lock.opp_slug).toBe('turmeric');
    expect(lock.run_id).toBe('20260905-0800');
  });

  it('with neither set, the lock carries NO opp keys — byte-identical to pre-#1821', () => {
    recordSessionLock({ adbPort: 50037, emulatorPort: 55554 });
    const raw = fs.readFileSync(lockPathForPid(process.pid), 'utf8');
    expect(raw).not.toContain('opp_slug');
    expect(raw).not.toContain('run_id');
  });
});

describe('listLiveSessionLocks', () => {
  it('returns live locks and drops dead ones', () => {
    write(base(process.pid, { opp_slug: 'bednet' }));
    write(base(DEAD_PID, { opp_slug: 'bednet' }));
    const live = listLiveSessionLocks();
    expect(live.map((l) => l.mcp_pid)).toEqual([process.pid]);
  });

  it('survives a corrupt lock rather than throwing — the caller is printing a warning', () => {
    write(base(process.pid, { opp_slug: 'bednet' }));
    fs.writeFileSync(path.join(tmpLockDir, '123456.lock.json'), '{not json', 'utf8');
    expect(listLiveSessionLocks().map((l) => l.mcp_pid)).toEqual([process.pid]);
  });

  it('returns [] for a missing lock dir', () => {
    process.env.ACE_SESSION_LOCK_DIR = path.join(tmpLockDir, 'does-not-exist');
    expect(listLiveSessionLocks()).toEqual([]);
  });

  it('ignores non-lock files in the directory', () => {
    write(base(process.pid));
    fs.writeFileSync(path.join(tmpLockDir, 'notes.txt'), 'hello', 'utf8');
    expect(listLiveSessionLocks()).toHaveLength(1);
  });
});

describe('updateSessionLockContext', () => {
  it('merges context into an existing lock WITHOUT touching the ports the reaper matches', () => {
    write(base(process.pid, { adb_port: 50040, emulator_port: 55560 }));
    expect(
      updateSessionLockContext(process.pid, {
        opp_slug: 'bednet',
        run_id: '20260905-0912',
        avd_name: 'ACE_Pixel_API_34_b',
      }),
    ).toBe(true);
    const lock = readLock(process.pid);
    expect(lock).toMatchObject({
      mcp_pid: process.pid,
      adb_port: 50040,
      emulator_port: 55560,
      opp_slug: 'bednet',
      run_id: '20260905-0912',
      avd_name: 'ACE_Pixel_API_34_b',
    });
  });

  it('fills in avd_name, which the only recordSessionLock call site has never written', () => {
    // Reproduces the live shape on this host: a real lock with no avd_name.
    recordSessionLock({ adbPort: 50037, emulatorPort: 55554 });
    expect(readLock(process.pid).avd_name).toBeUndefined();
    updateSessionLockContext(process.pid, { avd_name: 'ACE_Pixel_API_34' });
    expect(readLock(process.pid).avd_name).toBe('ACE_Pixel_API_34');
  });

  it('is a NO-OP when no lock exists — a portless lock would strand real daemons', () => {
    expect(updateSessionLockContext(DEAD_PID, { opp_slug: 'bednet' })).toBe(false);
    expect(fs.existsSync(lockPathForPid(DEAD_PID))).toBe(false);
  });

  it('never throws on an unreadable lock', () => {
    fs.writeFileSync(lockPathForPid(process.pid), 'garbage', 'utf8');
    expect(() => updateSessionLockContext(process.pid, { opp_slug: 'x' })).not.toThrow();
    expect(updateSessionLockContext(process.pid, { opp_slug: 'x' })).toBe(false);
  });

  it('a blank value cannot erase what is already recorded', () => {
    write(base(process.pid, { opp_slug: 'bednet', avd_name: 'ACE_Pixel_API_34' }));
    updateSessionLockContext(process.pid, { opp_slug: '   ' });
    expect(readLock(process.pid).opp_slug).toBe('bednet');
  });
});
