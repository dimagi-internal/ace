/**
 * Serialise the AVD *boot*, per AVD (ace#1821, third mechanism).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT WAS STILL MISSING
 *
 * ace#1821 has three mechanisms. Two shipped:
 *
 *   1. pool-of-one — `/ace:mobile-bootstrap --pool N` (#1989), the
 *      `avd_pool` doctor probe (#1990), the selector-map drift guard (#2020);
 *   2. unscoped orphan-kill — `lib/avd-orphan-scope.ts` (#2000) spares any
 *      qemu whose owning session lock is alive.
 *
 * Scoping the kill stopped mutual destruction. It did not add mutual
 * exclusion. Two sessions can still choose the same AVD and cold-boot it
 * concurrently, and `mobile_ensure_avd_running` is *"always full cold-boot per
 * dispatch"* with `-wipe-data`.
 *
 * The reason is a TOCTOU with a wide window, and it is worth stating exactly,
 * because the machinery that *should* have prevented it is all present and all
 * correct:
 *
 *   `ensureAvdRunning` reads the process table once (`readPsRows`), asks
 *   `checkAvdContention` who holds each AVD, feeds `held` into
 *   `resolveAvdPoolFreedom`, and lets `selectAvd` prefer an unheld AVD.
 *   Every step is right. But "held" is computed from `ps`, and a peer that
 *   has *decided* to boot an AVD but has not yet spawned its qemu — or has
 *   spawned it microseconds ago — is in no process table. So two sessions
 *   probing within the same window both read `held: false` for the same AVD,
 *   both are told it is free, and both cold-boot it.
 *
 * Measured against `origin/main` @ 0.13.1223, the whole path from that `ps`
 * read (`mcp/mobile/backends/avd.ts:783`) to `spawn('emulator', …)`
 * (`avd.ts:943`) contains no mutual exclusion of any kind:
 *
 *     $ git grep -n "withAllocatorMutex(" origin/main -- mcp lib bin
 *     origin/main:mcp/mobile/backends/avd.ts:456
 *
 * — the one call site, inside `getAllocatedPorts()`, wrapping PORT allocation
 * only. The boot is unserialised.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT A WAITER DOES: FALL THROUGH FIRST, WAIT ONLY WHEN THERE IS NOWHERE
 * TO FALL, AND NEVER REFUSE
 *
 * The brief asked for this to be argued rather than bolted on. Three tiers,
 * in order:
 *
 *   1. **Fall through.** A live boot claim on AVD X is folded into
 *      `AvdCandidate.held` — the SAME input `ps` holders already feed. The
 *      existing `resolveAvdPoolFreedom` → `selectAvd` pipeline then does what
 *      it already does: prefer an unheld AVD. On a 2-AVD host the second
 *      session waits zero milliseconds and takes `_b`. No new preference
 *      logic, no second contention detector — the claim is one more holder.
 *
 *   2. **Wait.** When every usable AVD is held or claimed (the one-AVD host,
 *      which is still the common case), `resolveAvdPoolFreedom` marks them all
 *      `free` + `shared` and today the funnel warns and cold-boots over the
 *      peer. Here — and only here — waiting is strictly better than
 *      proceeding, because the thing we would collide with is a *boot in
 *      progress*, which ends within the boot budget. So we wait for the claim,
 *      bounded.
 *
 *   3. **Proceed.** On timeout we take the claim over and boot anyway, with
 *      the warning that is already there. We never throw.
 *
 * Why never throw: @jjackson on this issue, 2026-09-01 — *"do not ship a
 * refusing lock"*. With one AVD and nine sessions a hard lock converts eight
 * sessions from "limps to a partial walk" into "dies immediately", while Phase
 * 6's one-way Learn precondition is consumed either way. The single-member
 * union on `BootClaimTerminal.action` encodes that: promoting this to a throw
 * fails typecheck, the same way #1992's test asserts its warning says it is
 * not a block.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * HOW IT COMPOSES WITH `AvdPoolExhaustedError` — IT DOES NOT MAKE IT REACHABLE
 *
 * This is the composition question the brief asked to work out rather than
 * bolt over, and the answer is a testable invariant.
 *
 * `selectAvd` throws `AvdPoolExhaustedError` iff the REQUESTED entry is not
 * `free` and no other `free && proven` entry exists. A claim only ever sets
 * `held`, never `usable: false`. And `resolveAvdPoolFreedom`'s contract is
 * that when *every* usable candidate is held, they all become `free` again
 * (`shared: true`). So:
 *
 *   - claims on some AVDs → an unheld one exists → requested may lose `free`,
 *     but a free+proven fallback exists by construction → switch, no throw;
 *   - claims on ALL AVDs → every usable entry is `free` again → the requested
 *     entry is free → no throw at all.
 *
 * There is no configuration of claims that turns a non-throwing pool into a
 * throwing one. `AvdPoolExhaustedError` stays exactly as reachable as it was:
 * only via de-provisioning or a read-WRITE holder, neither of which this
 * module touches. Pinned by test.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * SCOPE OF THE CLAIM: THE BOOT, NOT THE SESSION
 *
 * The claim is taken just before the AVD is mutated (the `config.ini` camera
 * patch, the `emu kill` of a prior instance, the `-wipe-data` spawn) and
 * released the moment the emulator registers with adb — at which point it IS
 * in the process table, so the `ps`-based `held` signal takes over and the
 * claim has nothing left to add.
 *
 * A SESSION-scoped claim would be a different and much worse thing: a Phase 6
 * walk holds a device for tens of minutes, so waiting on one is unbounded, and
 * refusing on one is the refusing lock ruled out above. Boot-scoped makes the
 * wait bounded by the adb-register budget, which is the only reason tier 2 is
 * safe to offer at all.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * STALENESS: TWO TESTS, NOT ONE
 *
 * `withAllocatorMutex` (`mcp/mobile/session-lock.ts:913`) takes a mutex over
 * dead holders via pid-liveness. That is necessary here and NOT sufficient.
 * Its critical section is a few milliseconds of TCP probing; ours brackets a
 * 25-90s boot, so a claim can outlive its usefulness while its owner is still
 * very much alive — a wedged emulator spawn, a suspended process, an MCP
 * blocked on a hung `adb`. A liveness-only test would let one live-but-leaked
 * claim wedge every peer on that AVD for the life of the session, which is
 * precisely the "stale lock must never wedge the fleet" failure the brief
 * forbids. So a claim is takeable when its owner is dead OR when it is older
 * than the maximum time a boot can legitimately hold it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS CANNOT DO: CROSS-ACCOUNT
 *
 * Claims live in `sessionLockDir()` = `~/.ace/sessions`, a per-`$HOME` path.
 * The affected host ran sessions under TWO macOS accounts, and the other
 * account's claims are unreadable, not merely unread — the same structural
 * limit `lib/mobile-contention.ts`'s header sets out for the lock registry.
 * Cross-account contention remains covered only by the `ps` surface, which
 * sees a foreign account's RUNNING emulator but not its mid-boot window. This
 * module narrows that window from "the whole boot" to "nothing, within an
 * account"; it does not close it across accounts. Stated here so nobody reads
 * a green test as a claim it does not make.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * CLASSIFICATION: unit-testable logic, not device-truth.
 *
 * Per CLAUDE.md — *"does this change alter what is SENT TO, or MATCHED
 * AGAINST, the device?"* Nothing here is sent to a device and nothing is
 * matched against a device response: the inputs are lock files this repo
 * writes, `Date.now()`, and a pid-liveness predicate. The emulator argv is
 * byte-identical before and after (no flag is added, removed or reordered),
 * and the only ORDERING change is *when* an unchanged sequence starts. Same
 * class as ace#1235 and as `lib/avd-orphan-scope.ts`. The `-read-only` /
 * `-wipe-data` interaction this serialisation guards IS device-truth, and it
 * is deliberately not asserted anywhere in this module — see the PR's residual.
 *
 * Pure and synchronous. The filesystem plumbing lives in
 * `mcp/mobile/session-lock.ts` beside `withAllocatorMutex`, so it reuses that
 * module's `sessionLockDir()` resolution, its `ACE_SESSION_LOCK_DIR` test
 * seam, and its `isPidAlive`.
 */

import type { AvdCandidate } from './mobile-contention.js';

/** One per-AVD boot claim, as written to `~/.ace/sessions/.avd-boot-<avd>.json`. */
export interface BootClaim {
  avd_name: string;
  /** The MCP subprocess that is mid-boot on this AVD. */
  mcp_pid: number;
  /** `Date.now()` at acquisition. Drives the age-based takeover. */
  claimed_at_ms: number;
  /** ISO timestamp, for operator-readable output only. */
  claimed_at?: string;
}

export type BootClaimVerdict =
  /** Ours. Re-entrant: never blocks us, never reaped by us. */
  | 'self'
  /** Owner pid is gone — same takeover rule as `withAllocatorMutex`. */
  | 'stale-dead-owner'
  /** Older than any boot can legitimately hold it; owner alive but wedged. */
  | 'stale-expired'
  /** A peer is genuinely mid-boot on this AVD. Binding. */
  | 'live';

export interface BootClaimEnv {
  /** `Date.now()` at the decision point. Injected so the logic is pure. */
  now: number;
  /** This MCP subprocess's pid. */
  selfPid: number;
  /** Liveness predicate — `mcp/mobile/session-lock.ts#isPidAlive` in production. */
  isPidAlive: (pid: number) => boolean;
  /**
   * Maximum time a boot may legitimately hold its claim. Derived in the
   * backend from the adb-register budget, so the two cannot drift.
   */
  staleAfterMs: number;
}

export interface BootClaimClassification {
  verdict: BootClaimVerdict;
  /** Operator-facing one-liner. Always names the pid and the age. */
  detail: string;
}

/**
 * Is one existing claim binding on us?
 *
 * Order matters: `self` is checked before liveness, because our own pid is by
 * definition alive and a re-entrant call must not be told to wait for itself;
 * and dead-owner is checked before expiry so the detail names the real reason.
 */
export function classifyBootClaim(
  claim: BootClaim,
  env: BootClaimEnv,
): BootClaimClassification {
  const ageMs = Math.max(0, env.now - claim.claimed_at_ms);
  const age = `${Math.round(ageMs / 1000)}s`;

  if (claim.mcp_pid === env.selfPid) {
    return {
      verdict: 'self',
      detail: `boot claim on '${claim.avd_name}' is our own (pid ${claim.mcp_pid}, ${age} old)`,
    };
  }
  if (!env.isPidAlive(claim.mcp_pid)) {
    return {
      verdict: 'stale-dead-owner',
      detail:
        `boot claim on '${claim.avd_name}' held by pid ${claim.mcp_pid}, which is gone ` +
        `(${age} old) — taking it over`,
    };
  }
  if (ageMs >= env.staleAfterMs) {
    return {
      verdict: 'stale-expired',
      detail:
        `boot claim on '${claim.avd_name}' held by LIVE pid ${claim.mcp_pid} for ${age}, ` +
        `past the ${Math.round(env.staleAfterMs / 1000)}s boot budget — treating as leaked ` +
        `and taking it over`,
    };
  }
  return {
    verdict: 'live',
    detail:
      `AVD '${claim.avd_name}' is being cold-booted right now by pid ${claim.mcp_pid} ` +
      `(claimed ${age} ago)`,
  };
}

export interface BootClaimSurvey {
  /**
   * AVD names a live peer is mid-boot on. Fold into `AvdCandidate.held` —
   * see `applyBootClaims`.
   */
  claimed: Set<string>;
  /** Claims the caller should unlink before acquiring. Never includes our own. */
  takeover: BootClaim[];
  /** Per-claim verdicts, in input order, for logging. */
  classifications: Array<BootClaim & BootClaimClassification>;
}

/**
 * Partition every claim on disk into "blocks us" and "safe to reap".
 *
 * One call rather than two so a claim can never be counted as both, which is
 * exactly the shape that would let a reaper delete a claim it is also waiting
 * on.
 */
export function surveyBootClaims(
  claims: readonly BootClaim[],
  env: BootClaimEnv,
): BootClaimSurvey {
  const claimed = new Set<string>();
  const takeover: BootClaim[] = [];
  const classifications: Array<BootClaim & BootClaimClassification> = [];

  for (const claim of claims) {
    const c = classifyBootClaim(claim, env);
    classifications.push({ ...claim, ...c });
    if (c.verdict === 'live') claimed.add(claim.avd_name);
    else if (c.verdict !== 'self') takeover.push(claim);
  }

  return { claimed, takeover, classifications };
}

/**
 * Fold live boot claims into the candidate facts as one more HOLDER.
 *
 * `held`, not `usable: false` — that distinction is the whole composition
 * argument in this file's header. A claim says "someone is mid-boot here",
 * which is the same kind of fact as "someone's emulator is running here", and
 * `resolveAvdPoolFreedom` already knows what to do with it.
 */
export function applyBootClaims(
  candidates: readonly AvdCandidate[],
  claimed: ReadonlySet<string>,
): AvdCandidate[] {
  return candidates.map((c) => ({
    ...c,
    held: c.held || claimed.has(c.name),
  }));
}

/**
 * What to do when every AVD we are willing to take is already claimed.
 *
 * `action` is a single-member union on purpose: this path must never become a
 * refusal, and a future edit that tries fails typecheck rather than shipping.
 */
export interface BootClaimTerminal {
  action: 'wait-then-proceed';
  avd: string;
  waitMs: number;
  /** Operator-facing; names what was tried and what happens on timeout. */
  reason: string;
}

export function planExhaustedBootClaim(args: {
  requested: string;
  /** AVDs whose claim we tried to acquire and lost, in attempt order. */
  refused: readonly string[];
  /** How many AVDs the host has in its pool at all. */
  poolSize: number;
  waitMs: number;
}): BootClaimTerminal {
  const tried = args.refused.length
    ? args.refused.map((n) => `'${n}'`).join(', ')
    : `'${args.requested}'`;
  return {
    action: 'wait-then-proceed',
    avd: args.requested,
    waitMs: args.waitMs,
    reason:
      `every AVD this session may take is already being cold-booted by a peer ` +
      `(tried ${tried} of ${args.poolSize} in the pool). Waiting up to ` +
      `${Math.round(args.waitMs / 1000)}s for '${args.requested}' to come free; ` +
      `on timeout this dispatch boots anyway rather than failing Phase 6 ` +
      `(ace#1821 — a refusing lock on a one-AVD host is pure loss). ` +
      `Provision more AVDs with \`/ace:mobile-bootstrap --pool 2\`.`,
  };
}
