/**
 * dimagi-internal/ace#1289 — per-run demo test user.
 *
 * Two jobs here:
 *   1. Prove the derivation is correct AND collision-free (the whole point of a
 *      per-run phone is that two runs never share a user; a colliding pair
 *      re-creates the accumulated-invite class it exists to dissolve).
 *   2. Prove the switch is OFF for everything except an explicit affirmative —
 *      the inertness argument the shipped-but-disabled path rests on.
 */
import { describe, it, expect } from 'vitest';

import {
  ACE_PER_RUN_TEST_USER_FLAG,
  PER_RUN_ANCHOR_UTC_MS,
  PER_RUN_DAY_SPAN,
  PER_RUN_SUFFIX_DIGITS,
  PER_RUN_TEST_USER_FLIP_PRECONDITION,
  TEST_NUMBER_PREFIX,
  assertDemoE164,
  classifyPerRunPostRegistrationGate,
  classifyPerRunPreRegistrationGate,
  derivePerRunTestUser,
  perRunSuffix,
  perRunTestUserEnabled,
} from '../../lib/per-run-test-user.js';

/** `YYYYMMDD-HHMM` for a UTC ms instant. */
function runIdAt(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `-${p(d.getUTCHours())}${p(d.getUTCMinutes())}`
  );
}

describe('perRunTestUserEnabled — the switch is OFF by default', () => {
  it('is false when the var is unset', () => {
    expect(perRunTestUserEnabled({})).toBe(false);
  });

  it.each(['', ' ', 'false', 'FALSE', '0', 'off', 'no', 'maybe', 'ture', 'True '])(
    'is false for %p unless it is an explicit affirmative',
    (value) => {
      const expected = ['true', '1', 'yes', 'on'].includes(value.trim().toLowerCase());
      expect(perRunTestUserEnabled({ [ACE_PER_RUN_TEST_USER_FLAG]: value })).toBe(expected);
    },
  );

  it.each(['true', 'TRUE', ' true ', '1', 'yes', 'on'])('is true for the affirmative %p', (value) => {
    expect(perRunTestUserEnabled({ [ACE_PER_RUN_TEST_USER_FLAG]: value })).toBe(true);
  });

  it('fails CLOSED on a typo — a mistyped value must not route runs through the uncalibrated camera surface', () => {
    expect(perRunTestUserEnabled({ [ACE_PER_RUN_TEST_USER_FLAG]: 'ture' })).toBe(false);
    expect(perRunTestUserEnabled({ [ACE_PER_RUN_TEST_USER_FLAG]: 'enabled' })).toBe(false);
  });
});

describe('derivePerRunTestUser', () => {
  it('always keeps the +7426 demo prefix', () => {
    for (let i = 0; i < 500; i++) {
      const runId = runIdAt(PER_RUN_ANCHOR_UTC_MS + i * 7 * 3_600_000 + i * 60_000);
      expect(derivePerRunTestUser(runId).phone.startsWith(TEST_NUMBER_PREFIX)).toBe(true);
    }
  });

  it('produces valid E.164 with the same 11-digit shape as the fixed ACE_E2E_PHONE', () => {
    const { phone, phoneLocal, countryCode } = derivePerRunTestUser('20260823-1412');
    expect(phone).toMatch(/^\+\d{11}$/);
    expect(countryCode).toBe('+7');
    expect(phoneLocal).toHaveLength(10);
    expect(`${countryCode}${phoneLocal}`).toBe(phone);
    // Same shape as the fixed demo user this replaces (+74260000101).
    expect(phone).toHaveLength('+74260000101'.length);
  });

  it('appends exactly PER_RUN_SUFFIX_DIGITS digits after the prefix', () => {
    const { phone } = derivePerRunTestUser('20260101-0000');
    expect(phone.slice(TEST_NUMBER_PREFIX.length)).toHaveLength(PER_RUN_SUFFIX_DIGITS);
  });

  it('is deterministic — a resumed run registers the SAME user, never an orphan', () => {
    expect(derivePerRunTestUser('20260702-1456')).toEqual(derivePerRunTestUser('20260702-1456'));
  });

  it('rejects an empty run id rather than minting a shared fallback number', () => {
    expect(() => derivePerRunTestUser('')).toThrow(/runId is required/);
    expect(() => derivePerRunTestUser('   ')).toThrow(/runId is required/);
  });

  it('names the run in the display name so a Connect workers table is readable', () => {
    expect(derivePerRunTestUser('20260702-1456').name).toContain('20260702-1456');
    expect(derivePerRunTestUser('20260702-1456', { name: 'Custom' }).name).toBe('Custom');
  });
});

describe('perRunSuffix — collision freedom is structural, not probabilistic', () => {
  it('never collides across every minute of a full year of run ids', () => {
    const seen = new Map<string, string>();
    // Every 13th minute across 365 days ≈ 40k distinct run ids — far past the
    // ~4k pigeonhole point where a 7-digit DIGEST would already have collided.
    for (let day = 0; day < 365; day++) {
      for (let minute = 0; minute < 1440; minute += 13) {
        const runId = runIdAt(PER_RUN_ANCHOR_UTC_MS + day * 86_400_000 + minute * 60_000);
        const suffix = perRunSuffix(runId);
        const prior = seen.get(suffix);
        expect(prior, `collision: ${runId} and ${prior} both map to ${suffix}`).toBeUndefined();
        seen.set(suffix, runId);
      }
    }
    expect(seen.size).toBeGreaterThan(35_000);
  });

  it('never collides across distinct days at a fixed time of day', () => {
    const seen = new Set<string>();
    for (let day = 0; day < PER_RUN_DAY_SPAN; day++) {
      const runId = runIdAt(PER_RUN_ANCHOR_UTC_MS + day * 86_400_000 + 9 * 3_600_000);
      const suffix = perRunSuffix(runId);
      expect(seen.has(suffix), `collision on day ${day} (${runId} -> ${suffix})`).toBe(false);
      seen.add(suffix);
    }
    expect(seen.size).toBe(PER_RUN_DAY_SPAN);
  });

  it('has its collision period EXACTLY at PER_RUN_DAY_SPAN days — the documented bound', () => {
    const base = PER_RUN_ANCHOR_UTC_MS + 5 * 3_600_000;
    const a = runIdAt(base);
    const wrapped = runIdAt(base + PER_RUN_DAY_SPAN * 86_400_000);
    const justBefore = runIdAt(base + (PER_RUN_DAY_SPAN - 1) * 86_400_000);
    expect(perRunSuffix(wrapped)).toBe(perRunSuffix(a));
    expect(perRunSuffix(justBefore)).not.toBe(perRunSuffix(a));
    // ~19 years of headroom, which is what makes the wrap acceptable.
    expect(PER_RUN_DAY_SPAN / 365).toBeGreaterThan(18);
  });

  it('stays inside 7 digits at the top of the cycle (the encoding must not overflow)', () => {
    const last = runIdAt(PER_RUN_ANCHOR_UTC_MS + (PER_RUN_DAY_SPAN - 1) * 86_400_000 + 23 * 3_600_000 + 59 * 60_000);
    expect(Number(perRunSuffix(last))).toBeLessThanOrEqual(10 ** PER_RUN_SUFFIX_DIGITS - 1);
    expect(perRunSuffix(last)).toHaveLength(PER_RUN_SUFFIX_DIGITS);
  });

  it('handles run ids BEFORE the anchor without a negative suffix', () => {
    const pre = runIdAt(PER_RUN_ANCHOR_UTC_MS - 30 * 86_400_000 + 3 * 3_600_000);
    expect(perRunSuffix(pre)).toMatch(/^\d{7}$/);
    expect(derivePerRunTestUser(pre).phone).toMatch(/^\+7426\d{7}$/);
  });

  it('falls back to a correctly-shaped deterministic hash for a non-canonical run id', () => {
    expect(perRunSuffix('fork-of-20260702-1456')).toMatch(/^\d{7}$/);
    expect(perRunSuffix('fork-of-20260702-1456')).toBe(perRunSuffix('fork-of-20260702-1456'));
    expect(perRunSuffix('fork-a')).not.toBe(perRunSuffix('fork-b'));
  });
});

describe('assertDemoE164', () => {
  it('rejects a number that lost the demo prefix', () => {
    expect(() => assertDemoE164('+12025550123')).toThrow(/demo prefix/);
  });

  it('rejects a malformed E.164 number', () => {
    expect(() => assertDemoE164('+7426')).toThrow(/valid E\.164/);
    expect(() => assertDemoE164('+7426abcdefg')).toThrow(/valid E\.164/);
  });

  it('accepts the shape derivePerRunTestUser produces', () => {
    expect(() => assertDemoE164(derivePerRunTestUser('20260823-0900').phone)).not.toThrow();
  });
});

describe('the gate that inverts (pre- vs post-registration)', () => {
  it('pre-registration: a MISSING row is expected, not a blocker', () => {
    const v = classifyPerRunPreRegistrationGate(null);
    expect(v.halt).toBe(false);
    expect(v.ok).toBe(true);
    expect(v.reason).toMatch(/EXPECTED/);
  });

  it('pre-registration: an UNLINKED row is expected, not the ace#824 signature', () => {
    const v = classifyPerRunPreRegistrationGate({ connect_user_id: null, status: 'pending' });
    expect(v.halt).toBe(false);
    expect(v.reason).toMatch(/EXPECTED/);
  });

  it('post-registration: a MISSING row HALTS before the AVD boots', () => {
    const v = classifyPerRunPostRegistrationGate(null);
    expect(v).toMatchObject({ ok: false, halt: true });
    expect(v.reason).toMatch(/do NOT boot the AVD/);
  });

  it('post-registration: an UNLINKED row HALTS — the opp is invisible on device forever', () => {
    const v = classifyPerRunPostRegistrationGate({ connect_user_id: null, status: 'pending' });
    expect(v).toMatchObject({ ok: false, halt: true });
    expect(v.reason).toMatch(/opportunityaccess__user/);
  });

  it('post-registration: a LINKED row passes, pending or not (claimed is never the gate)', () => {
    for (const status of ['pending', 'accepted', 'unknown']) {
      const v = classifyPerRunPostRegistrationGate({ connect_user_id: 'cid-123', status });
      expect(v, status).toMatchObject({ ok: true, halt: false });
    }
  });
});

describe('the flip precondition is a single greppable string', () => {
  it('names the camera-id calibration AND the fresh-signup registration on 2.63.2', () => {
    expect(PER_RUN_TEST_USER_FLIP_PRECONDITION).toContain('connect-register-from-otp.yaml');
    expect(PER_RUN_TEST_USER_FLIP_PRECONDITION).toContain('mobile_capture_ui_dump');
    expect(PER_RUN_TEST_USER_FLIP_PRECONDITION).toContain('fresh-signup registration');
    expect(PER_RUN_TEST_USER_FLIP_PRECONDITION).toContain('2.63.2');
  });
});
