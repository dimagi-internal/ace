/**
 * One Phase 3 build at a time per Nova account (ace#3301).
 *
 * Nova throttles per account, not per build. On 2026-10-15 two Phase 3 builds
 * ran together under one account and took 92 of the 141 HTTP 429s seen in 120
 * days; in the T140 baseline (ace#3132) the two overlapping builds took 103 of
 * 124. A second build therefore WAITS for the first and says why. It never
 * fails: a waiter that gives up has consumed a run for nothing.
 *
 * The lease is keyed by the Nova API key (hashed — the key never reaches disk)
 * and held in a file under `~/.ace/nova-lease/`.
 *
 * Liveness is the HOLDER'S SESSION PROCESS, not a clock. The holder is a
 * procedure spread over many short-lived processes, but they all descend from
 * one long-lived Claude Code process, and that is what `acquire` records
 * (`holder_pid`). While it is alive the lease holds, however long the build
 * runs; once it is gone the lease is free at once. A TTL alone cannot do this:
 * the T140 baseline builds ran 8–20 hours (d5dc62e8: 20h; e20c4273: 8h), and
 * nothing can renew the lease while the orchestrator is blocked inside an
 * architect `Agent` call, so any TTL short enough to reclaim a crash promptly
 * also hands the account to a second build mid-run — the overlap this exists
 * to stop. `NOVA_LEASE_TTL_MS` remains only as a backstop for a lease with no
 * recorded pid, or a pid that was recycled. Re-acquiring by the same holder
 * renews it and records the new session's pid, so a resumed Phase 3 keeps its
 * place.
 *
 * Scope: this serialises builds that share a home directory. Two cloud runners
 * — or two canopy users on one runner, each with its own home — holding the
 * same key do not see each other's file; that needs the canopy-web capability
 * broker (`lib/test-worker-lease.ts`), and is the named residual of this change.
 *
 * Pure decision (`classifyNovaLease`) + a thin fs layer taking an injectable
 * directory, clock and liveness probe.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Backstop only — liveness is `holder_pid` (see the header). Longer than the
 * longest observed Phase 3 build (20h), so it never fires on a live one.
 */
export const NOVA_LEASE_TTL_MS = 24 * 60 * 60 * 1000;

export interface NovaLease {
  holder: string;
  acquired_at_ms: number;
  /** The holder's long-lived session process; absent when it could not be found. */
  holder_pid?: number;
  /** Operator-readable only. */
  acquired_at?: string;
}

export type NovaLeaseVerdict = 'free' | 'self' | 'expired' | 'held';

/**
 * Is this `ps -o comm=` value a Claude Code session? The binary is `claude` on
 * macOS but `claude.exe` on the Linux cloud runners (npm installs
 * `@anthropic-ai/claude-code/bin/claude.exe`; seen on cloud-ec2-2, 2026-10-26),
 * which is where ACE builds run — matching only `claude` would silently fall
 * back to the TTL there.
 */
export function isClaudeComm(comm: string): boolean {
  return /^claude(\.exe)?$/.test(comm.split('/').pop() ?? '');
}

/** Does a process with this pid exist? EPERM means it does, under another user. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function classifyNovaLease(
  lease: NovaLease | null,
  holder: string,
  now: number,
  isAlive: (pid: number) => boolean = pidAlive,
  ttlMs = NOVA_LEASE_TTL_MS,
): { verdict: NovaLeaseVerdict; detail: string } {
  if (!lease) return { verdict: 'free', detail: 'no lease held' };
  const ageS = Math.round(Math.max(0, now - lease.acquired_at_ms) / 1000);
  if (lease.holder === holder) return { verdict: 'self', detail: `lease already ours (${ageS}s old) — renewing` };
  if (lease.holder_pid != null && !isAlive(lease.holder_pid)) {
    return {
      verdict: 'expired',
      detail: `lease held by ${lease.holder}, whose session (pid ${lease.holder_pid}) has exited — taking it over`,
    };
  }
  if (now - lease.acquired_at_ms >= ttlMs) {
    return {
      verdict: 'expired',
      detail: `lease held by ${lease.holder} for ${ageS}s, past the ${Math.round(ttlMs / 3_600_000)}h backstop TTL — treating as crashed and taking it over`,
    };
  }
  return {
    verdict: 'held',
    detail:
      `another Phase 3 build (${lease.holder}, ${ageS}s in) holds this Nova account; ` +
      `Nova rate-limits per account, so concurrent builds trip HTTP 429 (ace#3301) — waiting for it to finish`,
  };
}

export function novaLeaseDir(): string {
  return process.env.ACE_NOVA_LEASE_DIR ?? join(homedir(), '.ace', 'nova-lease');
}

/** Lease file for an API key. Hashed so the key itself never touches disk. */
export function novaLeasePath(apiKey: string, dir = novaLeaseDir()): string {
  return join(dir, `${createHash('sha256').update(apiKey).digest('hex').slice(0, 12)}.json`);
}

function read(path: string): NovaLease | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as NovaLease;
  } catch {
    return null; // missing or torn write — nothing binding
  }
}

export type TryAcquire = { acquired: true; detail: string } | { acquired: false; detail: string };

export interface LeaseOpts {
  /** The holder's long-lived session process (see the header). */
  holderPid?: number;
  isAlive?: (pid: number) => boolean;
}

/** One attempt, no waiting. */
export function tryAcquireNovaLease(path: string, holder: string, now = Date.now(), opts: LeaseOpts = {}): TryAcquire {
  const c = classifyNovaLease(read(path), holder, now, opts.isAlive);
  if (c.verdict === 'held') return { acquired: false, detail: c.detail };
  mkdirSync(join(path, '..'), { recursive: true });
  const lease: NovaLease = { holder, acquired_at_ms: now, acquired_at: new Date(now).toISOString() };
  if (opts.holderPid != null) lease.holder_pid = opts.holderPid;
  const body = JSON.stringify(lease);
  if (c.verdict === 'self') {
    writeFileSync(path, body);
    return { acquired: true, detail: c.detail };
  }
  if (c.verdict === 'expired') unlinkSync(path);
  try {
    writeFileSync(path, body, { flag: 'wx' }); // exclusive: of two racers, one loses
  } catch {
    return { acquired: false, detail: 'lost the race to another build acquiring this Nova account' };
  }
  return { acquired: true, detail: c.detail };
}

/** Release only a lease we hold; a lease taken over after ours lapsed is not ours to delete. */
export function releaseNovaLease(path: string, holder: string): boolean {
  if (read(path)?.holder !== holder) return false;
  unlinkSync(path);
  return true;
}

/**
 * Wait for the lease, calling `onWait` with the reason on the first miss and
 * every ~5 min thereafter. Resolves once held. Never rejects on contention.
 */
export async function acquireNovaLease(
  path: string,
  holder: string,
  opts: LeaseOpts & {
    onWait?: (detail: string) => void;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    pollMs?: number;
  } = {},
): Promise<TryAcquire> {
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const pollMs = opts.pollMs ?? 15_000;
  for (let i = 0; ; i++) {
    const r = tryAcquireNovaLease(path, holder, now(), opts);
    if (r.acquired) return r;
    if (i % Math.max(1, Math.round(300_000 / pollMs)) === 0) opts.onWait?.(r.detail);
    await sleep(pollMs);
  }
}
