import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  readBootClaims,
  tryAcquireBootClaim,
  releaseBootClaim,
  surveyAndReapBootClaims,
  reapStaleSessions,
  acquireSessionLock,
} from '../../../mcp/mobile/session-lock.js';

/**
 * ace#1821 — filesystem plumbing for the per-AVD boot claim.
 *
 * The decision logic is pure and lives in `lib/avd-boot-claim.ts`
 * (`test/lib/avd-boot-claim.test.ts`). What is verified HERE is the one thing
 * that cannot be pure: that `O_EXCL` really is the interlock, that a claim is
 * owner-guarded on release, and that boot claims and session locks do not reap
 * each other.
 *
 * `ACE_SESSION_LOCK_DIR` is the isolation seam (ace#1704) — without it these
 * would operate on the real `~/.ace/sessions` and reap live sessions.
 */

const A = 'ACE_Pixel_API_34';
const DEAD = 999_999; // above macOS PID_MAX; never a live process
const STALE_AFTER_MS = 75_000;

let dir: string;
let prev: string | undefined;

beforeEach(() => {
  prev = process.env.ACE_SESSION_LOCK_DIR;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-boot-claim-'));
  process.env.ACE_SESSION_LOCK_DIR = dir;
});

afterEach(() => {
  if (prev === undefined) delete process.env.ACE_SESSION_LOCK_DIR;
  else process.env.ACE_SESSION_LOCK_DIR = prev;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('boot claim — O_EXCL is the interlock', () => {
  it('the second acquire of the same AVD loses, even from the same process', () => {
    // The whole fix in one assertion: two callers that both computed "this AVD
    // is free" from the same `ps` snapshot cannot both proceed.
    expect(tryAcquireBootClaim(A)).not.toBeNull();
    expect(tryAcquireBootClaim(A)).toBeNull();
  });

  it('a different AVD is unaffected — serialisation is PER AVD, not global', () => {
    expect(tryAcquireBootClaim(A)).not.toBeNull();
    expect(tryAcquireBootClaim('ACE_Pixel_API_34_b')).not.toBeNull();
  });

  it('releasing frees the AVD for the next caller', () => {
    tryAcquireBootClaim(A);
    expect(releaseBootClaim(A)).toBe(true);
    expect(tryAcquireBootClaim(A)).not.toBeNull();
  });

  it('release is idempotent — safe on every exit path, including twice', () => {
    tryAcquireBootClaim(A);
    expect(releaseBootClaim(A)).toBe(true);
    expect(releaseBootClaim(A)).toBe(false);
  });
});

describe('boot claim — a release can never delete a peer’s claim', () => {
  it('refuses to unlink a claim owned by another pid', () => {
    fs.writeFileSync(
      path.join(dir, `.avd-boot-${A}.json`),
      JSON.stringify({ avd_name: A, mcp_pid: 4242, claimed_at_ms: Date.now() }),
    );
    expect(releaseBootClaim(A)).toBe(false);
    expect(readBootClaims()).toHaveLength(1);
  });

  it('unlinks regardless of owner ONLY when explicitly forced', () => {
    // The deliberate takeover after waiting out a wedged claim.
    fs.writeFileSync(
      path.join(dir, `.avd-boot-${A}.json`),
      JSON.stringify({ avd_name: A, mcp_pid: 4242, claimed_at_ms: Date.now() }),
    );
    expect(releaseBootClaim(A, null)).toBe(true);
    expect(readBootClaims()).toEqual([]);
  });
});

describe('boot claim — reading and reaping', () => {
  it('skips corrupt files instead of throwing', () => {
    tryAcquireBootClaim(A);
    fs.writeFileSync(path.join(dir, '.avd-boot-broken.json'), '{not json');
    expect(readBootClaims().map((c) => c.avd_name)).toEqual([A]);
  });

  it('reaps a dead owner’s claim and leaves our own alone', () => {
    fs.writeFileSync(
      path.join(dir, '.avd-boot-ACE_Pixel_API_34_b.json'),
      JSON.stringify({ avd_name: 'ACE_Pixel_API_34_b', mcp_pid: DEAD, claimed_at_ms: Date.now() }),
    );
    tryAcquireBootClaim(A);

    const out = surveyAndReapBootClaims(STALE_AFTER_MS);
    expect(out.reaped.map((c) => c.avd_name)).toEqual(['ACE_Pixel_API_34_b']);
    expect([...out.claimed]).toEqual([]);
    expect(readBootClaims().map((c) => c.avd_name)).toEqual([A]);
  });

  it('reports a live peer’s claim as blocking without reaping it', () => {
    fs.writeFileSync(
      path.join(dir, `.avd-boot-${A}.json`),
      JSON.stringify({ avd_name: A, mcp_pid: process.ppid, claimed_at_ms: Date.now() }),
    );
    const out = surveyAndReapBootClaims(STALE_AFTER_MS);
    expect([...out.claimed]).toEqual([A]);
    expect(out.reaped).toEqual([]);
  });

  it('sanitises the AVD name so a claim can never escape the lock dir', () => {
    tryAcquireBootClaim('../../evil');
    expect(fs.readdirSync(dir)).toEqual(['.avd-boot-.._.._evil.json']);
  });
});

describe('boot claims and session locks do not reap each other', () => {
  it('reapStaleSessions ignores boot claims entirely', () => {
    // A boot claim is NOT a session lock: reaping one by pid alone would kill
    // the adb/qemu daemons of whatever happened to be on those ports.
    tryAcquireBootClaim(A);
    acquireSessionLock({
      mcp_pid: DEAD,
      started_at: new Date().toISOString(),
      adb_port: 50037,
      emulator_port: 55554,
    });

    reapStaleSessions();

    expect(readBootClaims().map((c) => c.avd_name)).toEqual([A]);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.lock.json'))).toEqual([]);
  });

  it('a boot claim is not picked up by the session-lock glob', () => {
    tryAcquireBootClaim(A);
    expect(fs.readdirSync(dir).some((f) => f.endsWith('.lock.json'))).toBe(false);
  });
});
