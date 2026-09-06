import { describe, it, expect } from 'vitest';
import {
  classifyBootClaim,
  surveyBootClaims,
  applyBootClaims,
  planExhaustedBootClaim,
  type BootClaim,
  type BootClaimEnv,
} from '../../lib/avd-boot-claim.js';
import { resolveAvdPoolFreedom, type AvdCandidate } from '../../lib/mobile-contention.js';
import { selectAvd, AvdPoolExhaustedError, type AvdPoolEntry } from '../../mcp/mobile/avd-allocator.js';

/**
 * ace#1821, third mechanism — the boot was never serialised.
 *
 * The controls are the point of this file. A test that passes against BOTH the
 * old and the new logic proves nothing, so the PRE-FIX selection pipeline is
 * reproduced verbatim as `legacySelection` (no claims anywhere) and asserted to
 * put TWO sessions on the SAME AVD. If a future change makes the fixture stop
 * discriminating, the positive control fails and says so.
 */

const A = 'ACE_Pixel_API_34';
const B = 'ACE_Pixel_API_34_b';

const ALIVE = 40001;
const DEAD = 999_999; // above macOS PID_MAX; never a live process
const SELF = 55_555;

const STALE_AFTER_MS = 75_000;

function env(over: Partial<BootClaimEnv> = {}): BootClaimEnv {
  return {
    now: 1_000_000,
    selfPid: SELF,
    isPidAlive: (pid) => pid === ALIVE || pid === SELF,
    staleAfterMs: STALE_AFTER_MS,
    ...over,
  };
}

function claim(avd: string, pid: number, ageMs: number): BootClaim {
  return { avd_name: avd, mcp_pid: pid, claimed_at_ms: 1_000_000 - ageMs };
}

// ───────────────────────────────────────────────────────────────────────────
// The pool fixture. Two provisioned, proven AVDs; nobody's emulator is in the
// process table yet, which is EXACTLY the blind window: both sessions have
// decided to boot and neither has spawned.
// ───────────────────────────────────────────────────────────────────────────

function baseCandidates(names: string[]): AvdCandidate[] {
  return names.map((name) => ({ name, usable: true, held: false }));
}

/** The production pool build, minus the filesystem probes. */
function buildPool(names: string[], claimed: ReadonlySet<string>): AvdPoolEntry[] {
  const freedom = new Map(
    resolveAvdPoolFreedom(applyBootClaims(baseCandidates(names), claimed)).map((e) => [e.name, e]),
  );
  return names.map((name) => {
    const f = freedom.get(name)!;
    return f.free
      ? { name, free: true, proven: true }
      : { name, free: false, reason: 'held' };
  });
}

/**
 * PRE-FIX selection, reproduced verbatim: `held` comes only from `ps`, so an
 * in-flight peer boot is invisible and `claimed` is always empty.
 */
function legacySelection(names: string[], requested: string, selfPid: number) {
  return selectAvd(requested, buildPool(names, new Set()), { selfPid });
}

// ───────────────────────────────────────────────────────────────────────────

describe('classifyBootClaim — staleness has TWO tests, not one', () => {
  it('never blocks us on our own claim, even though our pid is alive', () => {
    expect(classifyBootClaim(claim(A, SELF, 5_000), env()).verdict).toBe('self');
  });

  it('takes over a claim whose owner is gone (the withAllocatorMutex rule)', () => {
    const c = classifyBootClaim(claim(A, DEAD, 5_000), env());
    expect(c.verdict).toBe('stale-dead-owner');
    expect(c.detail).toContain(String(DEAD));
  });

  it('takes over a claim held by a LIVE pid past the boot budget', () => {
    // The case pid-liveness alone cannot see: a wedged spawn, a suspended MCP.
    // Without this, one live-but-leaked claim wedges every peer on that AVD.
    const c = classifyBootClaim(claim(A, ALIVE, STALE_AFTER_MS + 1), env());
    expect(c.verdict).toBe('stale-expired');
    expect(c.detail).toMatch(/LIVE pid/);
  });

  it('is binding while a live peer is genuinely mid-boot', () => {
    const c = classifyBootClaim(claim(A, ALIVE, 20_000), env());
    expect(c.verdict).toBe('live');
    expect(c.detail).toContain('cold-booted right now');
  });

  it('holds the claim for the whole budget, not half of it', () => {
    // Guards against reaching for ALLOCATOR_MUTEX_TIMEOUT_MS (30s) here: a
    // real boot is 25-90s, so a 30s bound would pre-empt healthy boots and
    // recreate the collision this closes.
    expect(classifyBootClaim(claim(A, ALIVE, 30_000), env()).verdict).toBe('live');
    expect(classifyBootClaim(claim(A, ALIVE, STALE_AFTER_MS - 1), env()).verdict).toBe('live');
    expect(classifyBootClaim(claim(A, ALIVE, STALE_AFTER_MS), env()).verdict).toBe('stale-expired');
  });
});

describe('surveyBootClaims — one pass, so a claim is never both blocking and reapable', () => {
  it('partitions live claims from takeable ones', () => {
    const s = surveyBootClaims(
      [claim(A, ALIVE, 10_000), claim(B, DEAD, 10_000)],
      env(),
    );
    expect([...s.claimed]).toEqual([A]);
    expect(s.takeover.map((c) => c.avd_name)).toEqual([B]);
  });

  it('never reaps and never blocks on our own claim', () => {
    const s = surveyBootClaims([claim(A, SELF, 10_000)], env());
    expect(s.claimed.size).toBe(0);
    expect(s.takeover).toEqual([]);
  });

  it('treats a claim with no usable timestamp as expired, not as binding', () => {
    // `readBootClaims` coerces an unparseable claimed_at_ms to 0, which is
    // ancient — so a corrupt-but-parseable claim self-heals instead of wedging.
    const s = surveyBootClaims([{ avd_name: A, mcp_pid: ALIVE, claimed_at_ms: 0 }], env());
    expect(s.claimed.size).toBe(0);
    expect(s.takeover).toHaveLength(1);
  });
});

describe('applyBootClaims — a claim is a HOLDER, never an unusable entry', () => {
  it('sets held and leaves usable alone', () => {
    const out = applyBootClaims(baseCandidates([A, B]), new Set([A]));
    expect(out).toEqual([
      { name: A, usable: true, held: true },
      { name: B, usable: true, held: false },
    ]);
  });

  it('never clears an existing ps-derived held', () => {
    const withPsHolder: AvdCandidate[] = [{ name: A, usable: true, held: true }];
    expect(applyBootClaims(withPsHolder, new Set()).at(0)!.held).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// THE CONTROLS
// ───────────────────────────────────────────────────────────────────────────

describe('positive control — the pre-fix path lets two sessions boot ONE AVD', () => {
  it('both sessions request A and both are told to take A', () => {
    const s1 = legacySelection([A, B], A, 1001);
    const s2 = legacySelection([A, B], A, 1002);

    expect(s1.name).toBe(A);
    expect(s1.switched).toBe(false);
    expect(s2.name).toBe(A);
    expect(s2.switched).toBe(false);
    // Both cold-boot the same AVD with -wipe-data. That is ace#1821's third
    // mechanism, in two lines.
    expect(s1.name).toBe(s2.name);
  });

  it('the fixture discriminates — the fix changes this exact answer', () => {
    // Non-inertness. If this ever stops differing, the test above has become a
    // tautology and the control is dead.
    const before = legacySelection([A, B], A, 1002);
    const after = selectAvd(A, buildPool([A, B], new Set([A])), { selfPid: 1002 });
    expect(before.name).not.toBe(after.name);
  });
});

describe('tier 1 — FALL THROUGH: the second session takes another pooled AVD', () => {
  it('switches to B when a peer holds the claim on A', () => {
    const sel = selectAvd(A, buildPool([A, B], new Set([A])), { selfPid: 1002 });
    expect(sel.name).toBe(B);
    expect(sel.switched).toBe(true);
    expect(sel.from).toBe(A);
  });

  it('waits zero milliseconds to do it — no wait is planned when a pool member is free', () => {
    const pool = buildPool([A, B], new Set([A]));
    expect(pool.some((e) => e.free && e.proven && e.name !== A)).toBe(true);
  });
});

describe('tier 2/3 — one-AVD host: shared, warned, never refused', () => {
  it('the requested AVD stays free when it is the only one and a peer claims it', () => {
    // resolveAvdPoolFreedom's contract: when EVERY usable candidate is held,
    // they are all free again (shared). So a pool of one never throws.
    const sel = selectAvd(A, buildPool([A], new Set([A])), { selfPid: 1002 });
    expect(sel.name).toBe(A);
    expect(sel.switched).toBe(false);
  });

  it('planExhaustedBootClaim can only wait-then-proceed', () => {
    const t = planExhaustedBootClaim({ requested: A, refused: [A], poolSize: 1, waitMs: 75_000 });
    expect(t.action).toBe('wait-then-proceed');
    expect(t.avd).toBe(A);
    expect(t.waitMs).toBe(75_000);
    expect(t.reason).toContain('boots anyway rather than failing Phase 6');
    expect(t.reason).toContain('/ace:mobile-bootstrap --pool 2');
  });

  it('names every AVD it tried, so the operator can see the fall-through happened', () => {
    const t = planExhaustedBootClaim({ requested: A, refused: [A, B], poolSize: 2, waitMs: 75_000 });
    expect(t.reason).toContain(`'${A}'`);
    expect(t.reason).toContain(`'${B}'`);
    expect(t.reason).toContain('of 2 in the pool');
  });
});

describe('composition — boot claims cannot make AvdPoolExhaustedError reachable', () => {
  const subsets = (names: string[]): string[][] =>
    names.reduce<string[][]>((acc, n) => acc.concat(acc.map((s) => [...s, n])), [[]]);

  for (const names of [[A], [A, B], [A, B, 'ACE_Pixel_API_34_c']]) {
    it(`never throws for any claim subset of a ${names.length}-AVD usable pool`, () => {
      for (const claimed of subsets(names)) {
        expect(() =>
          selectAvd(A, buildPool(names, new Set(claimed)), { selfPid: 1002 }),
        ).not.toThrow();
      }
    });
  }

  it('still throws when the pool is genuinely exhausted for the OLD reasons', () => {
    // De-provisioned / read-WRITE-contended entries are `usable: false`, which
    // no claim ever produces. This is the only remaining route, unchanged.
    const dead: AvdPoolEntry[] = [
      { name: A, free: false, reason: 'de-provisioned (no disk images)' },
      { name: B, free: false, reason: 'held by live pid 123' },
    ];
    expect(() => selectAvd(A, dead, { selfPid: 1002 })).toThrow(AvdPoolExhaustedError);
  });

  it('an unproven fallback is still not taken — the marker rule is untouched', () => {
    const pool: AvdPoolEntry[] = [
      { name: A, free: false, reason: 'being cold-booted right now by a peer session' },
      { name: B, free: true, proven: false },
    ];
    expect(() => selectAvd(A, pool, { selfPid: 1002 })).toThrow(AvdPoolExhaustedError);
  });
});
