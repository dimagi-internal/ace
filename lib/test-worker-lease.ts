/**
 * Exclusive checkout of Connect test workers through canopy-web (ace#2955).
 *
 * The lock is canopy-web's `test-worker` pool capability
 * (infra/capabilities/test-worker/capability.yaml): one lease = one worker,
 * held by one device session for as long as that device is signed in as it.
 * It is the only lock every backend can see — a local AVD, a leased emulator
 * and a phone all take it — which is the gap ace#2934 fell through: two
 * machines signed the same worker in at once, and `list_capability_leases`
 * could not see the local AVD that did it.
 *
 * Same broker, same HTTP client as the android-emulator lease
 * (`mcp/mobile/backends/broker-http.ts`), same routes (`lease-contract.ts`):
 *
 *   acquire   POST /leases {agent, capability: test-worker}
 *             → `ready` with ready_info.slot when a slot is free,
 *               else `queued` with `position` until one frees
 *   heartbeat GET  /leases/{id}   (every call resets the broker's idle clock)
 *   release   DELETE /leases/{id}
 *   holders   GET  /leases?agent&capability&status=live (on exhaustion only)
 *
 * The worker's credentials ride on the lease (owner directive 2026-10-15): a
 * ready lease, read by the user who acquired it, carries `slot_data:
 * {public: {phone, phoneLocal, countryCode, name}, secret: {pin,
 * backupCode}}` for its slot. Missing `slot_data` or any required key fails
 * TEST_WORKER_NO_CREDENTIALS naming the slot, the missing keys and the
 * `scripts/test-worker-set.ts` command, and releases the lease. No pool slot
 * ever falls back to the shared `ACE_E2E_PIN` / `ACE_E2E_BACKUP_CODE`. The
 * slot data holds secrets: nothing here logs, throws or reports it unmasked.
 *
 * Unlike the emulator lease, this one heartbeats in the BACKGROUND: the
 * worker must stay locked for as long as the device is signed in as it, which
 * includes the long LLM-heavy gaps between device ops. The timer is unref'd
 * and dies with the process; the exit hook releases synchronously, and the
 * broker's `idle_release_s` covers a hard kill.
 *
 * Rollout fallback: while the capability is not published or not granted
 * (canopy-web answers 422 / 403), or this machine has no canopy-web PAT, ONE
 * worker proceeds UNLOCKED as the legacy `ACE_E2E_*` worker (worker-1) —
 * exactly the pre-pool behaviour — with a
 * loud warning naming ace#2955 and the publish step. A multi-worker checkout
 * never falls back: sharing a worker is the failure the pool exists to stop.
 * `/ace:doctor` (test_worker_pool) and `mobile_diagnose` keep the fallback
 * from persisting silently.
 *
 * Who holds a lease (ace#3033). canopy-web's lease rows name only the PAT's
 * user and `turn_id`, and every ACE process shares one PAT — so an abandoned
 * lease with no turn could not be traced to the process that took it (~18
 * one-shot leases pinned the pool for 15 min each on 2026-10-16). The holder
 * cannot ride in the acquire body: canopy-web's pool `resolve_params` takes
 * ONLY `slot` and answers anything else 422 (canopy_runtime/schema.py), so a
 * `params.holder` would fail EVERY checkout. Instead each process (a) sends
 * its identity as the `x-ace-lease-holder` header on every broker call, for
 * canopy-web to record once it does, and (b) appends every acquire / hold /
 * release / loss to a local ledger, `~/.ace/test-worker-leases.jsonl`
 * (`ACE_TEST_WORKER_LEDGER` overrides, `off` disables), with host, pid, ppid,
 * Claude session, turn and caller. `grep <lease-id>` that file on each
 * machine names the leaker; an `acquire` with no `release` / `exit-release`
 * line is a process that died hard.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canopyApiBase, canopyToken } from './ace-canopy-pat.js';
import { LEGACY_SLOT, legacyTestWorker, maskSecretsDeep, workerFromSlotData, type TestWorker } from './test-worker-pool.js';
import { fetchSlotDataReport, type SlotDataReport } from './test-worker-slots.js';
import { MobileError } from '../mcp/mobile/errors.js';
import { logInfo } from '../mcp/mobile/logging.js';
import { brokerRequest, curlDeleteSync, type BrokerHttpConfig } from '../mcp/mobile/backends/broker-http.js';
import {
  LEASE_AGENT,
  TEST_WORKER_CAPABILITY,
  leaseSlot,
  normalizeLeaseList,
  routePath,
  type LeaseOut,
} from '../mcp/mobile/backends/lease-contract.js';
import { resolveRetry, type RetryOpts } from '../mcp/mobile/backends/remote-io.js';

export const ISSUE = 'ace#2955';
export const PUBLISH_CMD = `canopy-runtime publish-capabilities --spec runtime.yaml --agent ${LEASE_AGENT}`;

export type WorkerLockMode = 'locked' | 'unlocked-fallback';

export interface HeldWorker {
  slot: string;
  worker: TestWorker;
  /** The broker lease holding it; null in the unlocked fallback. */
  leaseId: string | null;
  mode: WorkerLockMode;
}

export interface TestWorkerStatus {
  capability: string;
  mode: WorkerLockMode | null;
  held: Array<{ slot: string; phone: string; lease_id: string | null }>;
  warning: string | null;
}

export interface TestWorkerCheckoutOpts {
  baseUrl?: string;
  /** ACE's canopy-web PAT; omitted → read from ACE's .env; null/'' → no PAT (fallback). */
  token?: string | null;
  fetchImpl?: typeof fetch;
  /** The legacy ACE_E2E_* worker for the rollout fallback, and CANOPY_TURN_ID (default process.env). */
  env?: NodeJS.ProcessEnv;
  /** Bound on waiting for queued slots. Default 10 min. */
  waitMs?: number;
  /** Poll interval while queued. Default 5 s. */
  pollIntervalMs?: number;
  /** Background heartbeat period. Default 4 min (the broker idles a lease out after 900 s). */
  heartbeatMs?: number;
  requestTimeoutMs?: number;
  retry?: RetryOpts;
  /** Release held workers synchronously when the process exits. Default true. */
  releaseOnExit?: boolean;
  syncReleaseImpl?: (url: string, token: string) => void;
  now?: () => number;
  sleepImpl?: (ms: number) => Promise<void>;
  /** Where the loud fallback warning goes (default console.warn). */
  warn?: (msg: string) => void;
  /** Start the background heartbeat (default true; tests drive `heartbeatNow`). */
  backgroundHeartbeat?: boolean;
  /** The local lease ledger (ace#3033); omitted → `defaultLedgerPath(env)`, null → none. */
  ledgerPath?: string | null;
}

/** Who this process is, for the lease ledger and the holder header (ace#3033). */
export interface LeaseHolder {
  host: string;
  pid: number;
  ppid: number;
  /** CLAUDE_CODE_SESSION_ID — the Claude session whose MCP child holds it. */
  session_id: string | null;
  /** CANOPY_TURN_ID — also sent as the lease's `turn_id`. */
  turn_id: string | null;
  /** The script or server the process runs (argv[1]'s basename), e.g. `mobile-server.ts`. */
  caller: string;
}

export function leaseHolder(env: NodeJS.ProcessEnv = process.env): LeaseHolder {
  return {
    host: os.hostname(),
    pid: process.pid,
    ppid: process.ppid,
    session_id: env.CLAUDE_CODE_SESSION_ID || null,
    turn_id: env.CANOPY_TURN_ID || null,
    caller: process.argv[1] ? path.basename(process.argv[1]) : process.argv0,
  };
}

export const HOLDER_HEADER = 'x-ace-lease-holder';

/** `host=… pid=… ppid=… session=… turn=… caller=…`, header-safe (printable ASCII only). */
export function holderHeader(h: LeaseHolder): string {
  const v =
    `host=${h.host} pid=${h.pid} ppid=${h.ppid} session=${h.session_id ?? '-'} ` +
    `turn=${h.turn_id ?? '-'} caller=${h.caller}`;
  return v.replace(/[^\x20-\x7e]/g, '?').slice(0, 512);
}

/** The local lease ledger's path; `ACE_TEST_WORKER_LEDGER` overrides, `off` disables. */
export function defaultLedgerPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = env.ACE_TEST_WORKER_LEDGER;
  if (v === 'off') return null;
  return v || path.join(os.homedir(), '.ace', 'test-worker-leases.jsonl');
}

const LEDGER_MAX_BYTES = 5 * 1024 * 1024;

/** Codes that mean "the pool capability is not live yet" — the rollout fallback. */
const NOT_LIVE = new Set(['LEASE_UNDECLARED', 'LEASE_NO_GRANT', 'LEASE_AGENT_NOT_VISIBLE']);

export class TestWorkerCheckout {
  private readonly http: BrokerHttpConfig | null;
  private readonly env: NodeJS.ProcessEnv;
  private readonly waitMs: number;
  private readonly pollIntervalMs: number;
  private readonly heartbeatMs: number;
  private readonly releaseOnExit: boolean;
  private readonly syncReleaseImpl: (url: string, token: string) => void;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly warnImpl: (msg: string) => void;
  private readonly backgroundHeartbeat: boolean;
  private readonly holder: LeaseHolder;
  private readonly ledgerPath: string | null;

  private held: HeldWorker[] = [];
  private modeValue: WorkerLockMode | null = null;
  private warning: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private exitHookInstalled = false;
  private pending: Promise<HeldWorker[]> | null = null;

  constructor(opts: TestWorkerCheckoutOpts = {}) {
    const token = opts.token === undefined ? canopyToken() : opts.token;
    this.env = opts.env ?? process.env;
    this.holder = leaseHolder(this.env);
    this.ledgerPath = opts.ledgerPath !== undefined ? opts.ledgerPath : defaultLedgerPath();
    this.http = token
      ? {
          baseUrl: (opts.baseUrl ?? canopyApiBase()).replace(/\/+$/, ''),
          token,
          fetchImpl: opts.fetchImpl ?? fetch,
          requestTimeoutMs: opts.requestTimeoutMs ?? 30_000,
          retry: resolveRetry(opts.retry),
          capability: TEST_WORKER_CAPABILITY,
          headers: { [HOLDER_HEADER]: holderHeader(this.holder) },
        }
      : null;
    this.waitMs = opts.waitMs ?? 10 * 60_000;
    this.pollIntervalMs = opts.pollIntervalMs ?? 5_000;
    this.heartbeatMs = opts.heartbeatMs ?? 4 * 60_000;
    this.releaseOnExit = opts.releaseOnExit ?? true;
    this.syncReleaseImpl = opts.syncReleaseImpl ?? curlDeleteSync;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.warnImpl = opts.warn ?? ((m) => console.warn(m));
    this.backgroundHeartbeat = opts.backgroundHeartbeat ?? true;
  }

  get mode(): WorkerLockMode | null {
    return this.modeValue;
  }

  /** Held workers, in checkout order. */
  heldWorkers(): HeldWorker[] {
    return [...this.held];
  }

  holds(slot: string): boolean {
    return this.held.some((h) => h.slot === slot);
  }

  get(slot: string): HeldWorker | undefined {
    return this.held.find((h) => h.slot === slot);
  }

  status(): TestWorkerStatus {
    return {
      capability: TEST_WORKER_CAPABILITY,
      mode: this.modeValue,
      held: this.held.map((h) => ({ slot: h.slot, phone: h.worker.phone, lease_id: h.leaseId })),
      warning: this.warning,
    };
  }

  /**
   * Which slots lack data or required keys on canopy-web, from the MASKED
   * slot list (never a secret value) — for mobile_diagnose. Null with no PAT
   * (the rollout fallback reads ACE_E2E_* and needs no slot data). Never
   * throws; one quick attempt, so a diagnose is never held up by it.
   */
  async slotDataReport(): Promise<SlotDataReport | null> {
    if (!this.http) return null;
    return fetchSlotDataReport({
      ...this.http,
      requestTimeoutMs: Math.min(this.http.requestTimeoutMs, 10_000),
      retry: { ...this.http.retry, retries: 0 },
    });
  }

  /**
   * Make this process hold at least `count` workers (the ones already held
   * count). Waits up to `waitMs` for queued slots; on timeout releases what
   * this call acquired and throws TEST_WORKER_POOL_EXHAUSTED naming the
   * holders. Concurrent calls are serialised.
   */
  async ensure(count: number): Promise<HeldWorker[]> {
    if (!Number.isInteger(count) || count < 1) {
      throw new MobileError('TEST_WORKER_BAD_COUNT', `count must be a positive integer, got ${count}`);
    }
    while (this.pending) await this.pending.catch(() => {});
    if (this.held.length >= count) return this.heldWorkers();
    this.pending = this.ensureInner(count);
    try {
      return await this.pending;
    } finally {
      this.pending = null;
    }
  }

  private async ensureInner(count: number): Promise<HeldWorker[]> {
    if (this.modeValue === 'unlocked-fallback') return this.fallback(count, this.warning ?? 'the pool lock is not live');
    if (!this.http) {
      return this.fallback(count, "this machine has no canopy-web PAT (CANOPY_WEB_PAT in ACE's .env), so the lock cannot be taken");
    }
    const need = count - this.held.length;
    const acquired: LeaseOut[] = [];
    try {
      for (let i = 0; i < need; i++) {
        try {
          acquired.push(await this.acquireOne());
        } catch (e) {
          if (i === 0 && this.held.length === 0 && e instanceof MobileError && NOT_LIVE.has(e.code)) {
            return this.fallback(
              count,
              `canopy-web has no live "${TEST_WORKER_CAPABILITY}" capability for ${LEASE_AGENT} (${e.code}: ${e.message})`,
            );
          }
          throw e;
        }
      }
      const ready = await this.waitAllReady(acquired);
      const fresh: HeldWorker[] = [];
      for (let lease of ready) {
        const slot = leaseSlot(lease);
        if (!slot) {
          throw new MobileError(
            'TEST_WORKER_BAD_RESPONSE',
            `test-worker lease ${lease.lease_id} is ready but names no slot (ready_info.slot / params.slot)`,
            'canopy-web predates the pool capability kind, or changed its contract — see lib/test-worker-lease.ts.',
          );
        }
        // An acquire answer that predates the slot's assignment may omit the
        // field; the holder's GET carries it.
        if (lease.slot_data === undefined) {
          lease = await this.call<LeaseOut>('GET', routePath('get', { lease_id: lease.lease_id }));
        }
        // Throws TEST_WORKER_NO_CREDENTIALS (slot + missing keys + the set
        // command) — the catch below releases every lease this call took.
        const worker = workerFromSlotData(slot, lease.slot_data);
        fresh.push({ slot, worker, leaseId: lease.lease_id, mode: 'locked' });
      }
      this.held.push(...fresh);
      this.modeValue = 'locked';
      this.startHeartbeat();
      for (const h of fresh) {
        logInfo(`test-worker: checked out ${h.slot} (${h.worker.phone}) lease ${h.leaseId} [${holderHeader(this.holder)}]`);
        this.record('held', h.leaseId, { slot: h.slot });
      }
      return this.heldWorkers();
    } catch (e) {
      // Never leave a slot (or a queue position) behind a failed checkout. A
      // DELETE that fails here pins the slot until idle release (900 s), so it
      // is logged and ledgered, never swallowed silently (ace#3033).
      await Promise.all(
        acquired.map((l) =>
          this.deleteLease(l.lease_id).then(
            () => this.record('release', l.lease_id, { why: `checkout failed: ${(e as Error).message}` }),
            (de) => {
              logInfo(`test-worker: could NOT release lease ${l.lease_id} after a failed checkout: ${(de as Error).message}`);
              this.record('release-failed', l.lease_id, { error: (de as Error).message });
            },
          ),
        ),
      );
      throw e;
    }
  }

  private async acquireOne(): Promise<LeaseOut> {
    // Exactly these keys: canopy-web's pool acquire refuses any param but
    // `slot` (422), so the holder rides in a header + the ledger instead.
    const body: Record<string, unknown> = { agent: LEASE_AGENT, capability: TEST_WORKER_CAPABILITY };
    const turnId = this.env.CANOPY_TURN_ID;
    if (turnId) body.turn_id = turnId;
    const created = await this.call<LeaseOut>('POST', routePath('acquire'), body, { retry: false });
    if (!created?.lease_id) {
      throw new MobileError('TEST_WORKER_BAD_RESPONSE', `acquire returned no lease_id: ${JSON.stringify(maskSecretsDeep(created))}`);
    }
    this.installExitHook();
    this.record('acquire', created.lease_id, { status: String(created.status), slot: leaseSlot(created) });
    logInfo(
      `test-worker: lease ${created.lease_id} ${created.status}` +
        (created.position != null ? ` (queue position ${created.position})` : '') +
        ` [${holderHeader(this.holder)}]`,
    );
    return created;
  }

  private async waitAllReady(leases: LeaseOut[]): Promise<LeaseOut[]> {
    const startedAt = this.now();
    const state = new Map(leases.map((l) => [l.lease_id, l]));
    for (;;) {
      for (const [id, lease] of state) {
        const status = String(lease.status);
        if (status === 'failed' || status === 'released' || status === 'expired') {
          throw new MobileError(
            'TEST_WORKER_LEASE_LOST',
            `test-worker lease ${id} went ${status} before it held a worker${lease.reason ? `: ${lease.reason}` : ''}`,
            'Retry the checkout; if it repeats, inspect the lease on canopy-web (list_capability_leases).',
          );
        }
      }
      const pending = [...state.values()].filter((l) => String(l.status) !== 'ready');
      if (pending.length === 0) return leases.map((l) => state.get(l.lease_id)!);
      if (this.now() - startedAt > this.waitMs) throw await this.exhausted(pending);
      await this.sleep(this.pollIntervalMs);
      for (const l of pending) {
        state.set(l.lease_id, await this.call<LeaseOut>('GET', routePath('get', { lease_id: l.lease_id })));
      }
    }
  }

  /** The typed error for a pool that stayed full, naming who holds each slot. */
  private async exhausted(pending: LeaseOut[]): Promise<MobileError> {
    const mine = new Set(pending.map((l) => l.lease_id));
    let holders: string[] = [];
    try {
      const body = await this.call<unknown>(
        'GET',
        routePath('list', {}, { agent: LEASE_AGENT, capability: TEST_WORKER_CAPABILITY, status: 'live', limit: '100' }),
      );
      holders = normalizeLeaseList(body)
        .filter((r) => !mine.has(r.lease_id) && r.status === 'ready')
        .map((r) => `${r.slot ?? '?'}: lease ${r.lease_id}${r.holder ? ` (${r.holder})` : ''}${r.created_at ? ` since ${r.created_at}` : ''}`);
    } catch (e) {
      holders = [`(could not list holders: ${(e as Error).message})`];
    }
    const positions = pending.map((l) => l.position).filter((p) => p != null);
    return new MobileError(
      'TEST_WORKER_POOL_EXHAUSTED',
      `waited ${Math.round(this.waitMs / 60_000)} min for ${pending.length} more test worker(s) and none freed` +
        (positions.length ? ` (queue position ${positions.join(', ')})` : '') +
        `. Held now: ${holders.length ? holders.join('; ') : 'nobody visible to ACE'}.`,
      'Never share a worker. Wait for a holder to finish (or ask them to call mobile_release_test_workers / ' +
        'mobile_stop_avd), or add a worker: skills/test-worker-pool/SKILL.md § Add a worker.',
      { holders },
    );
  }

  private fallback(count: number, why: string): HeldWorker[] {
    if (count > 1) {
      throw new MobileError(
        'TEST_WORKER_POOL_UNAVAILABLE',
        `a ${count}-worker checkout needs the test-worker pool lock, and it is not live: ${why}`,
        `Multi-worker tests never run unlocked. Publish the capability (${PUBLISH_CMD}), have a workspace admin ` +
          `grant "${TEST_WORKER_CAPABILITY}" to agent "${LEASE_AGENT}" on canopy-web, then retry. /ace:doctor test_worker_pool shows the state (${ISSUE}).`,
      );
    }
    if (this.held.length) return this.heldWorkers();
    const worker = legacyTestWorker(this.env);
    if (!worker) {
      throw new MobileError(
        'TEST_WORKER_NO_CREDENTIALS',
        `the pool lock is not live (${why}) and there is no legacy ACE_E2E_* worker on this machine to fall back to`,
        'Run /ace:setup --force-env, then restart Claude Code.',
        { slot: LEGACY_SLOT },
      );
    }
    this.modeValue = 'unlocked-fallback';
    this.warning =
      `TEST-WORKER LOCK NOT TAKEN (${ISSUE}): ${why}. Proceeding UNLOCKED as ${LEGACY_SLOT} (${worker.phone}) — ` +
      'today\'s behaviour, in which any overlapping device session on any machine signs this one out ' +
      '("Account in use on another device", ace#2934). Close it: publish the capability ' +
      `(${PUBLISH_CMD}) and grant "${TEST_WORKER_CAPABILITY}" to "${LEASE_AGENT}" on canopy-web; ` +
      '/ace:doctor test_worker_pool shows the state.';
    this.warnImpl(`[ace-mobile] WARNING ${this.warning}`);
    logInfo(`test-worker: ${this.warning}`);
    this.held = [{ slot: LEGACY_SLOT, worker, leaseId: null, mode: 'unlocked-fallback' }];
    return this.heldWorkers();
  }

  /**
   * Release `slots` (default: every held worker). Returns the slots released.
   * A lease the broker no longer has is already released.
   */
  async release(slots?: string[]): Promise<string[]> {
    const targets = slots ? this.held.filter((h) => slots.includes(h.slot)) : [...this.held];
    this.held = this.held.filter((h) => !targets.includes(h));
    if (this.held.length === 0) this.stopHeartbeat();
    const errors: string[] = [];
    await Promise.all(
      targets.map(async (h) => {
        if (!h.leaseId) return;
        try {
          await this.deleteLease(h.leaseId);
          logInfo(`test-worker: released ${h.slot} lease ${h.leaseId}`);
          this.record('release', h.leaseId, { slot: h.slot });
        } catch (e) {
          errors.push(`${h.slot}: ${(e as Error).message}`);
          this.record('release-failed', h.leaseId, { slot: h.slot, error: (e as Error).message });
        }
      }),
    );
    if (errors.length) {
      throw new MobileError(
        'TEST_WORKER_RELEASE_FAILED',
        `could not release ${errors.join('; ')}`,
        'The broker releases an idle lease after idle_release_s (900 s); force-release it on canopy-web to free it sooner.',
      );
    }
    return targets.map((h) => h.slot);
  }

  private async deleteLease(id: string): Promise<void> {
    try {
      await this.call('DELETE', routePath('release', { lease_id: id }));
    } catch (e) {
      if (e instanceof MobileError && (e.code === 'LEASE_NOT_FOUND' || e.code === 'LEASE_LOST')) return;
      throw e;
    }
  }

  /**
   * One heartbeat round: GET every held lease. A lease the broker no longer
   * holds (released, expired, 404) is dropped with a loud warning — the
   * device may still be signed in as that worker, and another session may
   * now take it. Returns the slots lost.
   */
  async heartbeatNow(): Promise<string[]> {
    const lost: string[] = [];
    for (const h of [...this.held]) {
      if (!h.leaseId) continue;
      let status: string;
      try {
        status = String((await this.call<LeaseOut>('GET', routePath('get', { lease_id: h.leaseId }))).status);
      } catch (e) {
        if (e instanceof MobileError && (e.code === 'LEASE_NOT_FOUND' || e.code === 'LEASE_LOST')) status = 'gone';
        else continue; // transient: the next beat retries, well inside idle_release_s
      }
      if (status !== 'ready') {
        lost.push(h.slot);
        this.held = this.held.filter((x) => x !== h);
        this.record('lost', h.leaseId, { slot: h.slot, status });
        const msg =
          `test-worker ${h.slot} lease ${h.leaseId} is ${status} — this session no longer holds the worker. ` +
          'Another session may sign it in; re-run mobile_ensure_avd_running to check out a worker again.';
        this.warning = msg;
        this.warnImpl(`[ace-mobile] WARNING ${msg}`);
      }
    }
    if (this.held.length === 0) this.stopHeartbeat();
    return lost;
  }

  private startHeartbeat(): void {
    if (!this.backgroundHeartbeat || this.timer) return;
    this.timer = setInterval(() => {
      void this.heartbeatNow().catch(() => {});
    }, this.heartbeatMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  private stopHeartbeat(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private installExitHook(): void {
    if (!this.releaseOnExit || this.exitHookInstalled || !this.http) return;
    this.exitHookInstalled = true;
    process.once('exit', () => this.releaseHeldSync('exit'));
  }

  /**
   * Release every held lease SYNCHRONOUSLY and forget it. The exit hook runs
   * this; so does mobile-server's SIGINT/SIGTERM/SIGHUP handler, FIRST,
   * before its async daemon cleanup — a parent that follows SIGTERM with
   * SIGKILL during that cleanup otherwise leaves the slot pinned for
   * idle_release_s (ace#3033). Idempotent; never throws.
   */
  releaseHeldSync(why = 'exit'): string[] {
    const http = this.http;
    const targets = this.held.filter((h) => h.leaseId);
    this.held = [];
    this.stopHeartbeat();
    if (!http) return [];
    for (const h of targets) {
      try {
        this.syncReleaseImpl(`${http.baseUrl}${routePath('release', { lease_id: h.leaseId! })}`, http.token);
        this.record('exit-release', h.leaseId, { slot: h.slot, why });
      } catch {
        /* best-effort: idle release covers the rest */
      }
    }
    return targets.map((h) => h.slot);
  }

  /** Append one ledger line (ace#3033). Best-effort: a ledger failure never fails a checkout. */
  private record(event: string, leaseId: string | null, extra: Record<string, unknown> = {}): void {
    if (!this.ledgerPath || !leaseId) return;
    try {
      mkdirSync(path.dirname(this.ledgerPath), { recursive: true });
      try {
        if (statSync(this.ledgerPath).size > LEDGER_MAX_BYTES) renameSync(this.ledgerPath, `${this.ledgerPath}.1`);
      } catch {
        /* no ledger yet */
      }
      const line = { ts: new Date(this.now()).toISOString(), event, lease_id: leaseId, ...extra, holder: this.holder };
      appendFileSync(this.ledgerPath, `${JSON.stringify(line)}\n`);
    } catch {
      /* best-effort */
    }
  }

  private call<T>(method: string, route: string, body?: unknown, opts: { retry?: boolean } = {}): Promise<T> {
    if (!this.http) throw new MobileError('LEASE_NOT_CONFIGURED', 'no canopy-web PAT');
    return brokerRequest<T>(this.http, method, route, body, opts);
  }
}
