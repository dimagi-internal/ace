/**
 * dimagi-internal/ace#1047 fix #3 — pre-flight the AVD lock instead of
 * spawning a doomed emulator and waiting out the adb-register budget.
 *
 * Port allocation is per-session (#1030) but the AVD NAME is not, so a second
 * local session targets the same `ACE_Pixel_API_34` and loses the race. The
 * failure surfaces 60s later as:
 *
 *   AVD emulator-5558 stalled in phase=adb-register
 *   (elapsed_ms=60954 budget_ms=60000 last_adb_state=absent)
 *
 * which reads as a boot-timeout or driver problem. The emulator never booted.
 *
 * Reproduced on this host 2026-08-14 while validating the mobile batch: TWO
 * orphaned qemu processes (parent pid 1) held `ACE_Pixel_API_34` read-only on
 * port 5554, and every read-write boot of that AVD died shortly after — with
 * NO crash signature in the emulator log (no OOM, no panic; the log simply
 * stops after `Boot completed`, 85% host memory free). Moving to a dedicated
 * AVD made the instability vanish entirely.
 *
 * The lock is readable ground truth. Verified against a LIVE emulator:
 * `<avd>.avd/hardware-qemu.ini.lock` is a plain FILE whose contents are the
 * holding pid — `39908`, matching the running process — and
 * `multiinstance.lock` is an empty marker file beside it.
 *
 * So contention is decidable BEFORE the spawn, in one stat + one read.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { checkAvdContention, clearStaleAvdLock } from '../../../mcp/mobile/avd-contention.js';

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'avd-lock-')); });
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

function makeAvd(name: string, lockPid?: string) {
  const dir = path.join(home, `${name}.avd`);
  fs.mkdirSync(dir, { recursive: true });
  if (lockPid !== undefined) fs.writeFileSync(path.join(dir, 'hardware-qemu.ini.lock'), lockPid);
  return dir;
}

describe('checkAvdContention (#1047)', () => {
  it('reports CONTENDED when the lock names a live pid — the live 2026-08-14 case', () => {
    makeAvd('ACE_Pixel_API_34', '39908\n');
    const r = checkAvdContention(home, 'ACE_Pixel_API_34', { isPidAlive: () => true });
    expect(r.contended).toBe(true);
    expect(r.holderPid).toBe(39908);
    expect(r.stale).toBe(false);
    expect(r.detail).toMatch(/39908/);
    expect(r.detail, 'must not read as a boot timeout').toMatch(/another emulator/i);
  });

  it('reports STALE — not contended — when the holder is gone', () => {
    makeAvd('ACE_Pixel_API_34', '99999');
    const r = checkAvdContention(home, 'ACE_Pixel_API_34', { isPidAlive: () => false });
    expect(r.contended).toBe(false);
    expect(r.stale).toBe(true);
    expect(r.holderPid).toBe(99999);
  });

  it('is clear when there is no lock at all', () => {
    makeAvd('ACE_Pixel_API_34');
    const r = checkAvdContention(home, 'ACE_Pixel_API_34', { isPidAlive: () => true });
    expect(r.contended).toBe(false);
    expect(r.stale).toBe(false);
    expect(r.holderPid).toBeUndefined();
  });

  it('treats an unreadable pid as STALE rather than blocking a boot on garbage', () => {
    makeAvd('ACE_Pixel_API_34', 'not-a-pid');
    const r = checkAvdContention(home, 'ACE_Pixel_API_34', { isPidAlive: () => true });
    expect(r.contended).toBe(false);
    expect(r.stale).toBe(true);
  });

  it('is clear when the AVD directory does not exist — a different failure', () => {
    const r = checkAvdContention(home, 'never-made', { isPidAlive: () => true });
    expect(r.contended).toBe(false);
  });

  it('does not report contention against OUR OWN pid', () => {
    makeAvd('ACE_Pixel_API_34', String(process.pid));
    const r = checkAvdContention(home, 'ACE_Pixel_API_34', { isPidAlive: () => true, selfPid: process.pid });
    expect(r.contended).toBe(false);
  });
});

describe('clearStaleAvdLock (#1047)', () => {
  it('removes a stale lock so the next boot is not blocked forever', () => {
    const dir = makeAvd('ACE_Pixel_API_34', '99999');
    fs.writeFileSync(path.join(dir, 'multiinstance.lock'), '');
    expect(clearStaleAvdLock(home, 'ACE_Pixel_API_34', { isPidAlive: () => false })).toBe(true);
    expect(fs.existsSync(path.join(dir, 'hardware-qemu.ini.lock'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'multiinstance.lock'))).toBe(false);
  });

  it('REFUSES to clear a lock whose holder is alive', () => {
    const dir = makeAvd('ACE_Pixel_API_34', '39908');
    expect(clearStaleAvdLock(home, 'ACE_Pixel_API_34', { isPidAlive: () => true })).toBe(false);
    expect(fs.existsSync(path.join(dir, 'hardware-qemu.ini.lock'))).toBe(true);
  });
});
