// LeaseBackend — drives ACE's `android-emulator` capability: an ephemeral EC2
// machine canopy-web leases to this MCP process, launches from ACE's own image,
// and terminates on release. Same public surface as the local backends, so
// MobileClient routes to it without any skill-level change. It replaced
// ace-web's retired cloud emulator (2026-10-14).
//
// The shape of the contract (canopy-web spec 2026-10-14-cloud-capabilities §4):
//
//   ensureAvdRunning(state)  POST /api/capabilities/leases → poll GET until ready
//   every other op           upload inputs → exec `ace-mobile <sub> … --out s3://…`
//                            → poll the exec → parse the CLI's one JSON line →
//                            download `--out` artifacts into the caller's dir
//   stopAvd                  DELETE the lease (the instance is terminated)
//
// Every route and every CLI subcommand/flag lives in `lease-contract.ts`.
// Download, retry and artifact-name containment live in `remote-io.ts`.
//
// Auth is ACE's own canopy-web PAT (`CANOPY_WEB_PAT` in ACE's .env —
// lib/ace-canopy-pat.ts), with `turn_id` from `CANOPY_TURN_ID` when the cloud
// runner exports it, so the broker releases the lease when the turn ends.
//
// Lease lifetime, and why there is no background heartbeat: the broker idles a
// lease out after `idle_release_s` (900 s) without a call. Every op heartbeats
// (any lease call does, and the exec poll re-checks the lease every
// `heartbeatMs`), so an op in flight never idles out. A session that goes
// quiet for longer than the window between ops loses its machine, and the next
// call fails LEASE_LOST naming the restore: `mobile_ensure_avd_running`, then
// the prerequisite recipes — login, claim and Learn state do not survive onto
// a new machine. A background timer would keep an abandoned session's machine
// alive up to `max_lease_s`: orphan protection IS the idle release, so the
// bridge for a long deliberate gap is an explicit cheap call
// (`mobile_diagnose`), never an always-on heartbeat.
//
// Exec POSTs are never retried: a gateway 5xx after SendCommand succeeded
// would run the command twice, and a Learn walk is one-way per (user, opp). An
// ambiguous POST fails LEASE_EXEC_AMBIGUOUS, telling the caller to look at the
// device before repeating anything.

import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { canopyApiBase, canopyToken } from '../../../lib/ace-canopy-pat.js';
import { LEASE_RESTORE_HINT, brokerRequest, curlDeleteSync } from './broker-http.js';
// Re-exported: callers and tests import these from the lease backend.
export { LEASE_RESTORE_HINT, leaseHttpError } from './broker-http.js';
import { classifyMaestroFailure } from '../../../lib/maestro-failure-class.js';
import { countRecipeSteps, resolveChunkTimeout } from '../../../lib/maestro-chunk-timeout.js';
import { ENVIRONMENT_BASELINE_FINGERPRINT } from '../environment-baseline.js';
import { AvdBootError, MobileError, RecipeValidationError } from '../errors.js';
import { logInfo } from '../logging.js';
import { splitRecipeAtScreenshots } from '../recipe-splitter.js';
import { emitProgress, type RecipeProgressListener } from '../recipe-progress.js';
import type {
  ApkInfo,
  AvdInfo,
  LeaseFacts,
  RecipeRunResult,
  RemoteOpTiming,
  ScreenshotEntry,
  SnapshotResult,
  StepResult,
  TestUserRegistrationResult,
  UiDumpResult,
  VideoArtifact,
} from '../types.js';
import {
  CLI,
  LEASE_AGENT,
  LEASE_CAPABILITY,
  cliArgv,
  execIsTerminal,
  normalizeArtifacts,
  normalizeCapabilities,
  normalizeUploads,
  parseCliJson,
  readyBaseline,
  readyBaselineComplete,
  readyBaselineFailed,
  readyBootPath,
  readyMarker,
  readyTimings,
  routePath,
  type ArtifactRow,
  type CliOp,
  type CliOpName,
  type CliResult,
  type CliValues,
  type DeclaredCapability,
  type ExecOut,
  type ExecStatusOut,
  type LeaseOut,
  type ReadyMarker,
  type UploadSlot,
} from './lease-contract.js';
import { finalizeRecipeResult, subflowResolverFor } from './maestro.js';
import {
  contentTypeFor,
  downloadToFile,
  fetchWithRetry,
  formatDiagnostics,
  materializeArtifacts,
  normalizeRemoteStep,
  parseUiHierarchy,
  resolveRetry,
  type RemoteArtifact,
  type RetryConfig,
  type RetryOpts,
} from './remote-io.js';

/** In-VM diagnostics from `ace-mobile diagnose`, plus the lease it ran on. */
export type LeaseDiagnostics = Record<string, unknown> & {
  lease: {
    lease_id: string;
    status: string;
    instance_id: string | null;
    expires_at: string | null;
    idle_release_s?: number | null;
  } | null;
};


export interface LeaseBackendOpts {
  baseUrl?: string;
  token?: string;
  fetchImpl?: typeof fetch;
  /**
   * The selector-map version the client resolves recipes against
   * (`getConfiguredApkVersion`). A non-`cc-*` AVD name maps to
   * `cc-<this>`, so the leased device runs the CommCare the recipes were
   * written for. Unset/empty = the manifest's default state.
   */
  apkVersion?: () => string;
  /** Ceiling of the lease + exec poll backoff (ms): 1 s for 10 s, 2 s to 30 s, then this. Default 5 s; tests pass 0. */
  pollIntervalMs?: number;
  /** Long-poll seconds sent as `?wait_s` (the broker caps it at 20). 0 = never send it. Default 20. */
  longPollS?: number;
  /** A 404 on an exec this soon after it was sent is SSM lag, read as pending. Default 30 s. */
  execNotFoundGraceMs?: number;
  /** Parallel artifact downloads. Default 6. */
  downloadConcurrency?: number;
  /**
   * How long a poll may keep failing on transport errors / gateway 5xx
   * before giving up. The command keeps running on the machine meanwhile, so
   * a few seconds of network loss must not cost a walk its result. Default 120 s.
   */
  pollOutageMs?: number;
  /** Bound on time spent `queued` before giving up and releasing the queue slot. Default 20 min. */
  queueWaitMs?: number;
  /** Readiness bound when the manifest's `ready_timeout_s` can't be read. Default 900 s. */
  fallbackReadyTimeoutS?: number;
  /** Re-check the lease this often while an exec is in flight. Default 60 s. */
  heartbeatMs?: number;
  /** Per-request timeout (ms). Default 60 s — above the 20 s long-poll. */
  requestTimeoutMs?: number;
  retry?: RetryOpts;
  /** Release the lease (synchronously, best-effort) when this process exits. Default true. */
  releaseOnExit?: boolean;
  /** Test seam for the exit-time release. */
  syncReleaseImpl?: (url: string, token: string) => void;
  /** Test seam for the clock. */
  now?: () => number;
  /** Test seam for sleep between polls. */
  sleepImpl?: (ms: number) => Promise<void>;
}

interface HeldLease {
  id: string;
  /** The `state` param it was acquired with ('' = manifest default). */
  state: string;
  instanceId: string | null;
  outPrefix: string | null;
  info: AvdInfo;
  expiresAt: string | null;
  idleReleaseS: number | null;
  readyInfo: Partial<ReadyMarker> | null;
  /** Inputs already on this lease's `in/`, by content key → s3 URI (palette, APK). */
  uploaded: Map<string, string>;
  /** APK content hash → what installing it reported. */
  installed: Map<string, ApkInfo>;
  /** Set when an op proved the machine sick (emulator gone); ensure replaces it. */
  sick: boolean;
  /**
   * True once an ensure has HANDED this machine to a caller. A machine a
   * prewarm acquired is fresh until then: the first blocking ensure reports
   * `reused: false`, so the heal skips the `pm clear` a fresh machine never
   * needs.
   */
  delivered: boolean;
  /** The fingerprint `apply-baseline` reported on this machine (null = not re-applied by the client). */
  baselineApplied: string | null;
  /** The baked CLI answered `usage` to `record start`: no recording on this machine. */
  recordUnsupported: boolean;
}

/** Recording options for one `runRecipe` (the lease twin of `screen-recorder.ts`). */
export interface LeaseRecordOpts {
  recipeId: string;
  dispatchId: string;
  /** `ACE_MOBILE_RECORD_BITRATE` (default 1M). */
  bitRate?: string;
  /** `ACE_MOBILE_RECORD_SIZE` (default 540x1140). */
  size?: string;
}

/** What `applyBaseline` did on the leased machine. */
export interface LeaseBaselineResult {
  /** False when the baked CLI has no `apply-baseline` (it answered `usage`). */
  supported: boolean;
  ok: boolean;
  fingerprint: string | null;
  failed: string[];
  clockSynced: boolean | null;
}

/** A file to stage on the lease. `key` (a content hash) makes it reusable for the lease's life. */
interface UploadFile {
  name: string;
  bytes: Buffer;
  key?: string;
}

interface CliCall {
  json: CliResult;
  exec: ExecStatusOut;
  outRel: string;
  timing: RemoteOpTiming;
}

interface CliCallOpts {
  /** Override the op's SSM timeout (seconds). */
  timeoutS?: number;
  /** Relative `--out` dir under the lease's out prefix (default `<sub>-<slug>/`). */
  outRel?: string;
}

const READY_SLACK_S = 60;
/** Exec timeout over the CLI's own `--timeout-s`: S3 fetch of inputs + upload of artifacts. */
const EXEC_OVERHEAD_S = 180;
/** Long-poll evidence: a non-terminal GET that took at least this long was held by the broker. */
const LONG_POLL_HELD_MS = 3_000;
const SSM_PENDING = new Set(['pending', 'delayed']);
/** Recipe chunk run-names are `<tag>--chunk-NN.yaml`. */
const UPLOAD_BATCH = 50;

/**
 * The boot hook's own failure codes (ready.json `reason`, written by the
 * image's `ace-capability-boot`), each with what it means and the one fix.
 * Anything else (free text, a future code) is LEASE_READINESS_FAILED.
 */
const RETRY_FRESH = 'Re-run mobile_ensure_avd_running for a fresh machine; if it repeats, ';
export const READINESS_REASONS: Record<string, { what: string; fix: string }> = {
  'bad-user-data': {
    what: 'the machine could not read the user-data canopy-web launched it with',
    fix: 'This is a broker/launch-template defect, not a device one: check the dimagi-canopy stack version and the lease params on canopy-web.',
  },
  'unknown-state': {
    what: 'the requested state is not baked into this image',
    fix: 'The published manifest and the baked image disagree: rebake (infra/capabilities/android-emulator/bake.sh) and redeploy (deploy.sh), or lease a state the image has (mobile_list_avds).',
  },
  'no-states': {
    what: 'the image lists no baked states — the image is broken',
    fix: 'Rebake the image (infra/capabilities/android-emulator/bake.sh) and redeploy. Until then use the local AVD (/ace:mobile-backend local).',
  },
  'no-kvm': {
    what: '/dev/kvm is absent, so the emulator cannot run accelerated',
    fix: 'The launch template must enable nested virtualization (or use a metal/KVM-capable instance type) — a stack fix in infra/capabilities/android-emulator/, not a retry.',
  },
  'halt-not-armed': {
    what: 'the machine could not arm its own max-lifetime power-off, so it refused to serve',
    fix: RETRY_FRESH + 'the image\'s systemd-run/halt timer is broken — see the boot log and rebake.',
  },
  'runner-start-failed': {
    what: 'the emulator runner service did not start',
    fix: RETRY_FRESH + 'the image is the defect — read the boot log (diagnose → runner_log_tail) and rebake.',
  },
  'emulator-boot-failed': {
    what: 'the emulator exited during boot',
    fix: RETRY_FRESH + 'check accel (tcg means no KVM) and the emulator log; the baked AVD/snapshot may be corrupt — rebake.',
  },
  'emulator-ready-timeout': {
    what: 'the emulator did not reach ready within the boot hook\'s bound',
    fix: RETRY_FRESH + 'the instance type may be too slow or running without KVM (accel=tcg) — check the timings and rebake/resize.',
  },
  'hook-crashed': {
    what: 'the boot hook itself crashed (a bug in ace_mobile.py)',
    fix: RETRY_FRESH + 'it is an image bug: the detail carries the traceback — fix infra/capabilities/android-emulator/image/cli/ace_mobile.py and rebake.',
  },
};

/** sha256 hex of some bytes — the upload cache key. */
export function contentKey(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export class LeaseBackend {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly apkVersion: () => string;
  private readonly pollIntervalMs: number;
  private readonly longPollS: number;
  private readonly execNotFoundGraceMs: number;
  private readonly downloadConcurrency: number;
  private readonly pollOutageMs: number;
  private readonly queueWaitMs: number;
  private readonly fallbackReadyTimeoutS: number;
  private readonly heartbeatMs: number;
  private readonly requestTimeoutMs: number;
  private readonly retryConfig: RetryConfig;
  private readonly releaseOnExit: boolean;
  private readonly syncReleaseImpl: (url: string, token: string) => void;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  private held: HeldLease | null = null;
  private acquiring: Promise<AvdInfo> | null = null;
  private exitHookInstalled = false;
  private capabilityCache: DeclaredCapability | null | undefined = undefined;
  /** When this process last made a lease call — what the broker's idle clock counts from. */
  private lastCallAt: number | null = null;
  /** Long-poll support, as observed: null until a GET proves it either way. */
  private longPollObserved: boolean | null = null;
  private fastAnswers = 0;

  constructor(opts: LeaseBackendOpts = {}) {
    const token = opts.token ?? canopyToken() ?? '';
    if (!token) {
      throw new MobileError(
        'LEASE_NOT_CONFIGURED',
        "the lease mobile backend needs ACE's canopy-web PAT (CANOPY_WEB_PAT in ACE's .env)",
        'Run /ace:setup --force-env (CANOPY_WEB_PAT comes from the canopy-pat item in the ACE instance\'s 1Password vault), ' +
          'or use the local AVD with /ace:mobile-backend local.',
      );
    }
    this.token = token;
    this.baseUrl = (opts.baseUrl ?? canopyApiBase()).replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.apkVersion = opts.apkVersion ?? (() => process.env.ACE_CONNECT_APK_VERSION ?? '');
    this.pollIntervalMs = opts.pollIntervalMs ?? 5_000;
    this.longPollS = Math.max(0, Math.min(20, opts.longPollS ?? 20));
    this.execNotFoundGraceMs = opts.execNotFoundGraceMs ?? 30_000;
    this.downloadConcurrency = Math.max(1, opts.downloadConcurrency ?? 6);
    this.pollOutageMs = opts.pollOutageMs ?? 120_000;
    this.queueWaitMs = opts.queueWaitMs ?? 20 * 60_000;
    this.fallbackReadyTimeoutS = opts.fallbackReadyTimeoutS ?? 900;
    this.heartbeatMs = opts.heartbeatMs ?? 60_000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 60_000;
    this.retryConfig = resolveRetry(opts.retry);
    this.releaseOnExit = opts.releaseOnExit ?? true;
    this.syncReleaseImpl = opts.syncReleaseImpl ?? curlDeleteSync;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** The lease this process holds, if any (read-only view for diagnostics/tests). */
  get leaseId(): string | null {
    return this.held?.id ?? null;
  }

  /** Long-poll support as observed so far. */
  get longPoll(): LeaseFacts['long_poll'] {
    return this.longPollObserved === null ? 'unknown' : this.longPollObserved ? 'yes' : 'no';
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  /**
   * Acquire (or reuse) this process's lease and wait until it is `ready`.
   *
   * The state is the selector-map version's (`cc-<apkVersion>`) unless the
   * caller names a `cc-*` state — and it must be one the published manifest
   * bakes (LEASE_STATE_UNAVAILABLE otherwise), and the one the machine says
   * it booted (LEASE_STATE_MISMATCH otherwise).
   *
   * Reuse: a lease this process already holds is kept when it is still
   * `ready`, for the same state, and not proven sick. Anything else is
   * released and replaced. A `ready` lease never goes back to provisioning
   * (spec §4): a sick machine is released and a new one acquired, never
   * nursed.
   */
  async ensureAvdRunning(name: string): Promise<AvdInfo> {
    const info = await this.ensureShared(name);
    const held = this.held;
    if (!held) return info;
    // A machine is "reused" only once an ensure has handed it out before —
    // not when a prewarm acquired it moments ago (that one is fresh).
    const reused = held.delivered;
    held.delivered = true;
    held.info = { ...held.info, lease: this.facts(held, reused) };
    return held.info;
  }

  /**
   * Start acquiring (or confirm) this process's lease WITHOUT waiting for it
   * to be ready, so the machine boots while the caller does other prep. The
   * next `ensureAvdRunning` joins the in-flight acquire instead of starting
   * a second one. State/selector-map refusals are thrown here, at once;
   * anything that fails later is logged and the blocking ensure re-acquires.
   *
   * Mind the idle window: a machine that becomes ready and then sees no
   * lease call for `idle_release_s` (900 s) is released, so the blocking
   * ensure must follow within that — it recovers either way (a lost machine
   * is replaced), at the cost of a second boot.
   */
  async prewarm(name: string): Promise<{ prewarm: 'started' | 'joined' | 'held'; state: string; lease_id: string | null }> {
    const state = this.resolveState(name);
    await this.assertStateBaked(state);
    if (this.acquiring) return { prewarm: 'joined', state, lease_id: this.held?.id ?? null };
    if (this.held && this.held.state === state && !this.held.sick && this.held.info.status === 'booted') {
      return { prewarm: 'held', state, lease_id: this.held.id };
    }
    this.ensureShared(name).catch((e: unknown) => {
      logInfo(`lease: prewarm for ${state || 'default'} failed (the next ensure re-acquires): ${(e as Error)?.message ?? e}`);
    });
    // Let the acquire POST go out before reporting, so the id is known.
    await Promise.resolve();
    return { prewarm: 'started', state, lease_id: this.held?.id ?? null };
  }

  private ensureShared(name: string): Promise<AvdInfo> {
    if (this.acquiring) return this.acquiring;
    this.acquiring = this.ensureInner(name).finally(() => {
      this.acquiring = null;
    });
    return this.acquiring;
  }

  private async ensureInner(name: string): Promise<AvdInfo> {
    const state = this.resolveState(name);
    await this.assertStateBaked(state);
    if (this.held) {
      const held = this.held;
      if (held.state === state && !held.sick) {
        try {
          const lease = await this.getLease(held.id);
          if (lease.status === 'ready') {
            this.absorb(held, lease);
            logInfo(`lease: reusing ${held.id} (${held.instanceId ?? 'instance ?'}) for state=${state || 'default'}`);
            return held.info;
          }
          logInfo(`lease: held ${held.id} is ${lease.status}, not ready — replacing it`);
        } catch (e) {
          logInfo(`lease: held ${held.id} unreadable (${(e as Error).message}) — replacing it`);
        }
      } else {
        logInfo(
          held.sick
            ? `lease: held ${held.id} proved sick — replacing it`
            : `lease: held ${held.id} is state=${held.state || 'default'}, want ${state || 'default'} — replacing it`,
        );
      }
      await this.release().catch(() => {});
    }
    return this.acquire(state);
  }

  /**
   * The state to lease for `avdName`: a `cc-*` name as given, else the
   * selector map's (`cc-<apkVersion>`). ACE's AVD name (`ACE_Pixel_API_34`)
   * is a LOCAL device name; leasing the manifest default for it put a 2.63.0
   * device under 2.64.0 selectors.
   */
  resolveState(avdName: string): string {
    if (avdName?.startsWith('cc-')) return avdName;
    const v = this.apkVersion().trim();
    return v ? `cc-${v}` : '';
  }

  /** The configured selector-map version, or null when none is configured. */
  private selectorMapVersion(): string | null {
    const v = this.apkVersion().trim();
    return v || null;
  }

  /**
   * Refuse a state the client cannot drive correctly, before a machine is
   * paid for: one the manifest does not bake, or one whose CommCare version
   * differs from the selector map the recipes resolve against. An
   * unreadable manifest is not a refusal — the acquire itself answers 422
   * for an unknown state.
   */
  private async assertStateBaked(state: string): Promise<void> {
    const mapVersion = this.selectorMapVersion();
    if (state && mapVersion && state !== `cc-${mapVersion}`) {
      throw new MobileError(
        'LEASE_STATE_SELECTOR_MISMATCH',
        `asked to lease ${state}, but recipes resolve selectors for CommCare ${mapVersion} ` +
          `(ACE_CONNECT_APK_VERSION) — a ${state} device walked with the ${mapVersion} map fails on selector drift`,
        `Lease cc-${mapVersion} (pass the default avdName, or "cc-${mapVersion}"), or set ACE_CONNECT_APK_VERSION ` +
          `to ${state.slice(3)} (its selector map must exist under mcp/mobile/selectors/) and restart Claude Code.`,
      );
    }
    if (!state) return;
    let cap: DeclaredCapability | null;
    try {
      cap = await this.capability();
    } catch {
      return;
    }
    if (!cap || cap.states.length === 0 || cap.states.includes(state)) return;
    throw new MobileError(
      'LEASE_STATE_UNAVAILABLE',
      `${LEASE_AGENT}/${LEASE_CAPABILITY} does not bake ${state} (baked: ${cap.states.join(', ')})` +
        (mapVersion ? ` — the selector map in force is ${mapVersion} (ACE_CONNECT_APK_VERSION)` : ''),
      `Bake it: add "${state.slice(3)}" to commcare_versions in ` +
        'infra/capabilities/android-emulator/image/variables.pkr.hcl and to params.state in capability.yaml, ' +
        'run infra/capabilities/android-emulator/bake.sh, then deploy.sh (publishes the manifest). ' +
        'Until then use the local AVD (/ace:mobile-backend local). Do not lease another state: ' +
        'its CommCare does not match the selector map.',
    );
  }

  private async acquire(state: string): Promise<AvdInfo> {
    const body: Record<string, unknown> = { agent: LEASE_AGENT, capability: LEASE_CAPABILITY };
    if (state) body.params = { state };
    const turnId = process.env.CANOPY_TURN_ID;
    if (turnId) body.turn_id = turnId;

    const startedAt = this.now();
    const created = await this.request<LeaseOut>('POST', routePath('acquire'), body, { retry: false });
    if (!created?.lease_id) {
      throw new MobileError('LEASE_BAD_RESPONSE', `acquire returned no lease_id: ${JSON.stringify(created)}`);
    }
    const id = created.lease_id;
    this.installExitHook();
    // Hold it immediately so a failure below can still release it.
    const held: HeldLease = {
      id,
      state,
      instanceId: created.instance_id ?? null,
      outPrefix: outPrefixOf(created),
      info: { name: state || 'lease', serial: `lease:${id}`, status: 'booting' },
      expiresAt: created.expires_at ?? null,
      idleReleaseS: created.idle_release_s ?? null,
      readyInfo: null,
      uploaded: new Map(),
      installed: new Map(),
      sick: false,
      delivered: false,
      baselineApplied: null,
      recordUnsupported: false,
    };
    this.held = held;
    logInfo(
      `lease: acquired ${id} (${created.status}${created.position != null ? `, queue position ${created.position}` : ''}) ` +
        `for ${LEASE_AGENT}/${LEASE_CAPABILITY} state=${state || 'default'}${turnId ? ` turn=${turnId}` : ''}`,
    );

    try {
      const lease = await this.waitReady(id, created, startedAt);
      this.assertBootedState(held, lease);
      return held.info;
    } catch (e) {
      // Never leave a machine (or a queue slot) behind a failed acquire.
      await this.release().catch(() => {});
      throw e;
    }
  }

  /** ready.json names the state it booted; a machine on the wrong CommCare is released, never used. */
  private assertBootedState(held: HeldLease, lease: LeaseOut): void {
    const booted = readyMarker(lease)?.state;
    if (!held.state || typeof booted !== 'string' || !booted || booted === held.state) return;
    throw new MobileError(
      'LEASE_STATE_MISMATCH',
      `lease ${held.id} was acquired for ${held.state} but its machine booted ${booted}`,
      'The machine is released. This is a broker/image defect (params.state did not reach the boot hook): ' +
        'check the lease params and infra/capabilities/android-emulator/image/cli/ace_mobile.py plan_boot.',
    );
  }

  /** Copy the broker's view of a lease into what this process holds. */
  private absorb(held: HeldLease, lease: LeaseOut): void {
    if (lease.instance_id) held.instanceId = lease.instance_id;
    if (lease.expires_at) held.expiresAt = lease.expires_at;
    if (typeof lease.idle_release_s === 'number') held.idleReleaseS = lease.idle_release_s;
    const prefix = outPrefixOf(lease);
    if (prefix) held.outPrefix = prefix;
    const marker = lease.ready_info;
    if (marker && typeof marker === 'object' && Object.keys(marker).length) held.readyInfo = marker;
  }

  private facts(held: HeldLease, reused: boolean): LeaseFacts {
    const image = readyBaseline(held.readyInfo);
    const complete = readyBaselineComplete(held.readyInfo);
    const parity: LeaseFacts['baseline_parity'] =
      image === null
        ? 'unreported'
        : image !== ENVIRONMENT_BASELINE_FINGERPRINT
          ? 'mismatch'
          : complete === false
            ? 'incomplete'
            : 'match';
    return {
      lease_id: held.id,
      instance_id: held.instanceId,
      expires_at: held.expiresAt,
      idle_release_s: held.idleReleaseS,
      state: held.state || String(held.readyInfo?.state ?? ''),
      selector_map_version: this.selectorMapVersion(),
      reused,
      cli_version: typeof held.readyInfo?.cli_version === 'string' ? held.readyInfo.cli_version : null,
      image_baseline_fingerprint: image,
      expected_baseline_fingerprint: ENVIRONMENT_BASELINE_FINGERPRINT,
      baseline_parity: parity,
      baseline_failed: readyBaselineFailed(held.readyInfo),
      boot_path: readyBootPath(held.readyInfo),
      long_poll: this.longPoll,
    };
  }

  private async waitReady(id: string, first: LeaseOut, startedAt: number): Promise<LeaseOut> {
    let lease = first;
    let lastStatus = '';
    let lastPosition: number | null | undefined;
    let provisioningSince: number | null = null;
    let queuedS = 0;
    let readyTimeoutS: number | null = null;

    for (;;) {
      const held = this.held;
      if (!held || held.id !== id) {
        throw new MobileError('LEASE_LOST', `lease ${id} was released while waiting for it to become ready`, LEASE_RESTORE_HINT);
      }
      const status = String(lease.status);
      if (status !== lastStatus || lease.position !== lastPosition) {
        const elapsed = Math.round((this.now() - startedAt) / 1000);
        logInfo(
          `lease: ${id} ${status}${status === 'queued' && lease.position != null ? ` (position ${lease.position})` : ''}` +
            `${lease.instance_id ? ` instance=${lease.instance_id}` : ''} t+${elapsed}s`,
        );
        lastStatus = status;
        lastPosition = lease.position;
      }
      this.absorb(held, lease);

      const marker = readyMarker(lease);
      if (status === 'ready') {
        if (marker && marker.ok === false) {
          throw this.readinessFailed(id, lease, marker.reason);
        }
        const totalS = Math.round((this.now() - startedAt) / 1000);
        const timings: Record<string, number> = {
          lease_queue_s: queuedS,
          lease_provision_s: provisioningSince === null ? 0 : Math.round((this.now() - provisioningSince) / 1000),
          lease_total_s: totalS,
          ...readyTimings(marker),
        };
        held.info = {
          name: held.state || String(marker?.state ?? 'lease'),
          serial: `lease:${lease.instance_id ?? id}`,
          status: 'booted',
          bootTimeMs: totalS * 1000,
          timings,
          ...(marker?.accel ? { accel: marker.accel } : {}),
        };
        logInfo(`lease: ${id} ready in ${totalS}s (queued ${queuedS}s)${marker?.cli_version ? ` cli=${marker.cli_version}` : ''}`);
        return lease;
      }
      // The broker ends a lease `failed` when ready.json says ok:false (reason
      // "the machine reported it is not ready: …"), when the instance dies, or
      // past ready_timeout_s — ready_info.reason is the machine's own words.
      if (status === 'failed') throw this.readinessFailed(id, lease, marker?.reason);
      if (status === 'released' || status === 'expired') {
        throw new MobileError(
          'LEASE_LOST',
          `lease ${id} went ${status} before it was ready${lease.reason ? `: ${lease.reason}` : ''}`,
          LEASE_RESTORE_HINT,
        );
      }
      if (status === 'queued') {
        queuedS = Math.round((this.now() - startedAt) / 1000);
        if (this.now() - startedAt > this.queueWaitMs) {
          throw new MobileError(
            'LEASE_QUEUE_TIMEOUT',
            `lease ${id} was still queued at position ${lease.position ?? '?'} after ` +
              `${Math.round(this.queueWaitMs / 60_000)} min — every ${LEASE_CAPABILITY} slot this agent may hold is in use`,
            'Wait for another run to release its emulator, ask a workspace admin to raise the grant\'s ' +
              'max_concurrent, or use the local AVD (/ace:mobile-backend local).',
          );
        }
      } else {
        // provisioning (or a future intermediate status): the readiness clock.
        if (provisioningSince === null) {
          provisioningSince = this.now();
          readyTimeoutS = (await this.readyTimeoutS()) + READY_SLACK_S;
        }
        if (this.now() - provisioningSince > (readyTimeoutS ?? this.fallbackReadyTimeoutS) * 1000) {
          throw new AvdBootError(
            'lease',
            `lease ${id} did not become ready within ${readyTimeoutS}s of provisioning ` +
              `(instance ${lease.instance_id ?? 'not yet launched'}); released it`,
          );
        }
      }
      lease = await this.pollLease(id, lease, startedAt);
    }
  }

  /** One wait-then-read of a lease while it is not ready: long-poll when the broker holds, else back off. */
  private async pollLease(id: string, prev: LeaseOut, since: number): Promise<LeaseOut> {
    const t = this.now();
    const lease = await this.riding(() => this.getLease(id, true), `lease ${id}`);
    this.notePollLatency(this.now() - t, String(lease.status) === String(prev.status));
    if (String(lease.status) === String(prev.status)) await this.backoff(this.now() - t, this.now() - since);
    return lease;
  }

  private readinessFailed(id: string, lease: LeaseOut, reason?: string): MobileError {
    const marker = lease.ready_info && typeof lease.ready_info === 'object' ? (lease.ready_info as Record<string, unknown>) : {};
    const why = reason || lease.reason || 'no reason given';
    const known = READINESS_REASONS[why];
    const detail = typeof marker.detail === 'string' && marker.detail ? marker.detail : null;
    return new MobileError(
      known ? `LEASE_READINESS_${why.toUpperCase().replace(/-/g, '_')}` : 'LEASE_READINESS_FAILED',
      `lease ${id} failed readiness on instance ${lease.instance_id ?? '?'}: ${why}` +
        (known ? ` — ${known.what}` : '') +
        (detail ? `\n${detail.slice(-1500)}` : ''),
      `The machine is released. ${known?.fix ?? 'Re-run mobile_ensure_avd_running for a fresh one; if it fails the same way, the image is the defect — see infra/capabilities/android-emulator/README.md (bake.sh).'}`,
      { readiness_reason: why, ...(detail ? { detail } : {}), ...(lease.instance_id ? { instance_id: lease.instance_id } : {}) },
    );
  }

  /** Release the held lease (DELETE → instance terminated). No-op when none is held. */
  async stopAvd(_name?: string, _opts: { force?: boolean } = {}): Promise<void> {
    await this.release();
  }

  private async release(): Promise<void> {
    const held = this.held;
    if (!held) return;
    this.held = null;
    try {
      await this.request('DELETE', routePath('release', { lease_id: held.id }));
      logInfo(`lease: released ${held.id}`);
    } catch (e) {
      // A lease the broker no longer has is already released.
      if (e instanceof MobileError && (e.code === 'LEASE_NOT_FOUND' || e.code === 'LEASE_LOST')) return;
      throw e;
    }
  }

  private installExitHook(): void {
    if (!this.releaseOnExit || this.exitHookInstalled) return;
    this.exitHookInstalled = true;
    // 'exit' listeners must be synchronous; mobile-server's SIGINT/SIGTERM/
    // SIGHUP handlers end in process.exit(), so they reach this too. The
    // broker's turn binding, idle release and sweep cover a hard kill.
    process.once('exit', () => {
      const held = this.held;
      if (!held) return;
      try {
        this.syncReleaseImpl(`${this.baseUrl}${routePath('release', { lease_id: held.id })}`, this.token);
      } catch {
        /* best-effort */
      }
    });
  }

  /** Read-only: `params.state.enum` from the published manifest. Never acquires. */
  async listAvds(): Promise<string[]> {
    const cap = await this.capability();
    return cap?.states ?? [];
  }

  /**
   * The declared capability, its grant and live leases — the read the doctor
   * probe makes too. Cached per process (the manifest changes on deploy).
   */
  async capability(): Promise<DeclaredCapability | null> {
    if (this.capabilityCache !== undefined) return this.capabilityCache;
    const body = await this.request<unknown>('GET', routePath('agentCapabilities', { slug: LEASE_AGENT }));
    this.capabilityCache = normalizeCapabilities(body).find((c) => c.name === LEASE_CAPABILITY) ?? null;
    return this.capabilityCache;
  }

  private async readyTimeoutS(): Promise<number> {
    try {
      return (await this.capability())?.readyTimeoutS ?? this.fallbackReadyTimeoutS;
    } catch {
      return this.fallbackReadyTimeoutS;
    }
  }

  /**
   * Read-only in-VM snapshot (`ace-mobile diagnose`). With no lease held it
   * reports that and returns — it never acquires a machine to look at. Being
   * a lease call, it also resets the broker's idle clock: the cheap way to
   * bridge a long gap between device ops.
   */
  async diagnose(): Promise<LeaseDiagnostics> {
    if (!this.held) {
      return { lease: null, note: 'no lease held by this MCP process — mobile_ensure_avd_running acquires one' };
    }
    const held = this.held;
    const lease = await this.getLease(held.id);
    this.absorb(held, lease);
    const leaseView = {
      lease_id: held.id,
      status: String(lease.status),
      instance_id: lease.instance_id ?? held.instanceId,
      expires_at: lease.expires_at ?? null,
      idle_release_s: lease.idle_release_s ?? held.idleReleaseS,
    };
    if (lease.status !== 'ready') return { lease: leaseView };
    const { json } = await this.runCli('diagnose', {});
    this.noteCrash(held, json);
    return { ...json, lease: leaseView };
  }

  /**
   * diagnose still runs on a machine whose emulator died after ready, and
   * reports it as data (`crashed: true` / `error: emulator-crashed`, with
   * `ok: true` because the probe itself ran). Mark the machine sick so the
   * next ensure replaces it rather than handing it out again.
   */
  private noteCrash(held: HeldLease, json: CliResult): void {
    if (json.crashed === true || json.error === 'emulator-crashed') {
      if (!held.sick) logInfo(`lease: ${held.id} reports its emulator crashed — the next ensure replaces the machine`);
      held.sick = true;
    }
  }

  // ── Environment baseline ────────────────────────────────────────

  /**
   * Re-apply the environment baseline on the leased machine
   * (`ace-mobile apply-baseline`): the same keys the local funnel applies,
   * computed by the same fingerprint function. Used when ready.json's
   * fingerprint does not match this ACE's, or reports a failed step.
   *
   * A CLI that predates the subcommand answers `usage`; that is reported as
   * `supported: false` (the caller falls back to the one item it can apply
   * another way, the GPS fix), never thrown. Any other failure throws.
   */
  async applyBaseline(): Promise<LeaseBaselineResult> {
    const held = this.requireLease('apply-baseline');
    let json: CliResult;
    try {
      ({ json } = await this.runCli('applyBaseline', {}));
    } catch (e) {
      if (e instanceof MobileError && e.code === 'LEASE_CLI_USAGE') {
        logInfo(`lease: the CLI on ${held.id} has no apply-baseline (${e.message.split('\n')[0]})`);
        return { supported: false, ok: false, fingerprint: null, failed: [], clockSynced: null };
      }
      throw e;
    }
    const fingerprint =
      typeof json.fingerprint === 'string' && json.fingerprint
        ? json.fingerprint
        : typeof json.baseline_fingerprint === 'string' && json.baseline_fingerprint
          ? json.baseline_fingerprint
          : null;
    const failed = Array.isArray(json.failed) ? json.failed.map(String) : [];
    const ok = json.ok !== false && failed.length === 0;
    if (fingerprint) held.baselineApplied = fingerprint;
    return {
      supported: true,
      ok,
      fingerprint,
      failed,
      clockSynced: typeof json.clock_synced === 'boolean' ? json.clock_synced : null,
    };
  }

  /** The fingerprint the client already re-applied on the held machine, if any. */
  get baselineAppliedFingerprint(): string | null {
    return this.held?.baselineApplied ?? null;
  }

  // ── APK ─────────────────────────────────────────────────────────

  /**
   * Install an APK: a local path is uploaded first; an https:// or s3:// URI
   * is passed through. Cached per lease by content hash: the same bytes are
   * uploaded once and installed once on a machine (the lease has no
   * uninstall, so an installed APK stays installed for its life).
   */
  async installApk(_avdName: string, apk: string): Promise<ApkInfo> {
    const held = this.requireLease('install-apk');
    let uri = apk;
    let key = `uri:${apk}`;
    if (!/^(https?|s3):\/\//.test(apk)) {
      let bytes: Buffer;
      try {
        bytes = await fs.readFile(apk);
      } catch (e) {
        throw new MobileError('LEASE_APK_UNREADABLE', `cannot read APK ${apk}: ${(e as Error).message}`);
      }
      key = contentKey(bytes);
      const cached = held.installed.get(key);
      if (cached) {
        logInfo(`lease: ${path.basename(apk)} already installed on ${held.id} (sha256 ${key.slice(0, 12)}) — no-op`);
        return { ...cached, path: apk };
      }
      [uri] = await this.upload([{ name: `apk-${key.slice(0, 16)}.apk`, bytes, key }]);
    } else {
      const cached = held.installed.get(key);
      if (cached) return { ...cached, path: apk };
    }
    const { json } = await this.runCli('installApk', { apk: uri });
    const info: ApkInfo = {
      packageId: String(json.package_name ?? json.package ?? ''),
      versionName: String(json.version ?? json.version_name ?? ''),
      versionCode: Number(json.version_code ?? 0),
      path: apk,
    };
    held.installed.set(key, info);
    return info;
  }

  async uninstallApk(_avdName: string, _pkg: string): Promise<{ uninstalled: boolean }> {
    throw new MobileError(
      'LEASE_UNSUPPORTED',
      'uninstallApk is not a subcommand of the in-VM ace-mobile CLI',
      'Release and re-acquire for a clean device (mobile_stop_avd, then mobile_ensure_avd_running).',
    );
  }

  // ── Bootstrap helpers ───────────────────────────────────────────

  async clearAppData(packageName: string = 'org.commcare.dalvik'): Promise<boolean> {
    const { json } = await this.runCli('clearAppData', { package: packageName });
    return Boolean(json.cleared);
  }

  async repairDriver(): Promise<string[]> {
    const { json } = await this.runCli('repairDriver', {});
    return Array.isArray(json.uninstalled_packages) ? json.uninstalled_packages.map(String) : [];
  }

  async installDriver(): Promise<string[]> {
    const { json } = await this.runCli('installDriver', {});
    return Array.isArray(json.actions) ? json.actions.map(String) : [];
  }

  async registerTestUser(args: {
    phone: string;
    phoneLocal: string;
    countryCode: string;
    pin: string;
    backupCode: string;
    name: string;
    paletteTarB64: string;
    /** Content hash of the palette (sorted paths + bytes): reuses the upload across calls on one lease. */
    paletteKey?: string;
    toOtpRecipe: string;
    fromOtpRecipe: string;
  }): Promise<TestUserRegistrationResult> {
    // Credentials go up as a `--creds` JSON object, not argv: SSM keeps the
    // command line in its invocation history.
    const tag = slug('register');
    const creds = {
      phone: args.phone,
      phone_local: args.phoneLocal,
      country_code: args.countryCode,
      pin: args.pin,
      backup_code: args.backupCode,
      name: args.name,
    };
    const paletteBytes = Buffer.from(args.paletteTarB64, 'base64');
    const [palette, credsUri] = await this.upload([
      { name: `palette-${(args.paletteKey ?? contentKey(paletteBytes)).slice(0, 16)}.tar.gz`, bytes: paletteBytes, key: args.paletteKey ?? contentKey(paletteBytes) },
      { name: `${tag}--creds.json`, bytes: Buffer.from(JSON.stringify(creds), 'utf8') },
    ]);
    const { json } = await this.runCli('registerTestUser', {
      palette,
      toOtpRecipe: args.toOtpRecipe,
      fromOtpRecipe: args.fromOtpRecipe,
      creds: credsUri,
    });
    if (typeof json.upload_error === 'string' && json.upload_error) {
      logInfo(`lease: register-test-user could not upload its debug output (${json.upload_error}) — registration itself is unaffected`);
    }
    const alreadyRegistered = Boolean(json.already_registered);
    // The CLI used to echo the backup code; it now redacts it to
    // `backup_code_set`. Report what local reports: the code it set.
    const backup =
      typeof json.backup_code === 'string' && json.backup_code
        ? json.backup_code
        : json.backup_code_set === true && !alreadyRegistered
          ? args.backupCode
          : undefined;
    return {
      alreadyRegistered,
      phone: String(json.phone ?? args.phone),
      ...(backup ? { backupCode: backup } : {}),
    };
  }

  // ── Snapshots (machine-scoped: they die with the lease) ─────────

  async saveSnapshot(_avdName: string, snapshotName: string): Promise<SnapshotResult> {
    const { json } = await this.runCli('snapshotSave', { name: snapshotName });
    return {
      avdName: 'lease',
      snapshotName: String(json.name ?? snapshotName),
      saved: json.ok !== false,
      output: String(json.output ?? (json.saved_at ? `saved at ${json.saved_at}` : '')),
    };
  }

  async loadSnapshot(_avdName: string, snapshotName: string): Promise<SnapshotResult> {
    const { json } = await this.runCli('snapshotLoad', { name: snapshotName });
    return {
      avdName: 'lease',
      snapshotName: String(json.name ?? snapshotName),
      saved: json.ok !== false,
      output: String(json.output ?? (json.loaded_at ? `loaded at ${json.loaded_at}` : '')),
    };
  }

  // ── UI dump / screenshot ────────────────────────────────────────

  async captureUiDump(_avdName: string): Promise<UiDumpResult> {
    return (await this.uiDumpTimed()).dump;
  }

  private async uiDumpTimed(): Promise<{ dump: UiDumpResult; timing: RemoteOpTiming }> {
    // The dump comes back in the CLI's JSON line. The broker inlines only the
    // last 4,000 chars of stdout, so a real screen's line is read from the
    // full stream (stdout_url) — runCli does that.
    const { json, timing } = await this.runCli('uiDump', {});
    const xml = typeof json.xml === 'string' ? json.xml : '';
    const elements = Array.isArray(json.elements)
      ? (json.elements as UiDumpResult['elements'])
      : parseUiHierarchy(xml);
    return { dump: { xml, elements, ...(json.failed === true || !xml ? { failed: true } : {}) }, timing };
  }

  /**
   * screencap into `<destDir>/<name>` via `ace-mobile screenshot`, written
   * under its own `--out` prefix (`<outRel>`): one PNG, no Maestro logs, so
   * it can never clobber a failed run's artifacts. Returns the local path.
   */
  async screenshot(destDir: string, name: string, outRel = `forensics/${slug('shot')}/`): Promise<string> {
    const { json } = await this.runCli('screenshot', { name }, { outRel });
    const rows = await this.listArtifacts(outRel);
    const row = rows.find((r) => r.relPath === name) ?? rows.find((r) => r.relPath.endsWith('.png'));
    if (!row) {
      throw new MobileError('LEASE_DOWNLOAD_FAILED', `screenshot ${String(json.name ?? name)} wrote nothing under ${outRel}`);
    }
    await fs.mkdir(destDir, { recursive: true });
    const dest = path.join(destDir, name);
    await downloadToFile(this.fetchImpl, row.url, dest, this.retryConfig, 'LEASE_DOWNLOAD_FAILED');
    return dest;
  }

  /**
   * The evidence a failed recipe leaves: in-VM diagnostics, the screen's
   * element tree and a screenshot — independent reads, run concurrently
   * (three execs in parallel cost one exec of wall time). Each is
   * best-effort; a failure is reported as its absence, never thrown.
   */
  async failureEvidence(args: { destDir: string; screenshotName: string }): Promise<{
    diagnostics?: Record<string, unknown>;
    dump?: UiDumpResult;
    screenshotPath?: string;
  }> {
    if (!this.held) return {};
    const [diag, dump, shot] = await Promise.allSettled([
      this.runCli('diagnose', {}).then((c) => {
        if (this.held) this.noteCrash(this.held, c.json);
        return c.json as Record<string, unknown>;
      }),
      this.captureUiDump('lease'),
      this.screenshot(args.destDir, args.screenshotName),
    ]);
    for (const [what, r] of [['diagnose', diag], ['ui-dump', dump], ['screenshot', shot]] as const) {
      if (r.status === 'rejected') logInfo(`lease: failure evidence ${what} failed: ${String((r.reason as Error)?.message ?? r.reason)}`);
    }
    return {
      ...(diag.status === 'fulfilled' ? { diagnostics: diag.value } : {}),
      ...(dump.status === 'fulfilled' ? { dump: dump.value } : {}),
      ...(shot.status === 'fulfilled' ? { screenshotPath: shot.value } : {}),
    };
  }

  // ── Location (possible here: the CLI runs beside the emulator) ──

  async setLocation(
    avdName: string,
    longitude: number,
    latitude: number,
    altitude: number = 480,
    satellites: number = 12,
  ): Promise<{
    avdName: string;
    longitude: number;
    latitude: number;
    altitude: number;
    satellites: number;
    applied: boolean;
    output: string;
  }> {
    const { json } = await this.runCli('setLocation', { longitude, latitude, altitude, satellites });
    return {
      avdName,
      longitude,
      latitude,
      altitude,
      satellites,
      applied: json.applied === true,
      output: String(json.output ?? ''),
    };
  }

  // ── Recipe execution ────────────────────────────────────────────

  /**
   * Run a Maestro recipe on the leased emulator, chunked exactly as
   * MaestroBackend chunks it locally: split at screenshot boundaries
   * (`recipe-splitter.ts`, subflow-aware), each chunk its OWN exec with a
   * `--timeout-s` and exec timeout sized from its step count
   * (`lib/maestro-chunk-timeout.ts`), and a UI dump in the quiet window after
   * every chunk that ends on a screenshot (`<name>.xml` beside `<name>.png`).
   * A single exec with the CLI's 1800 s default killed long Learn walks
   * mid-flight — and Learn completion is one-way per (user, opp).
   *
   * The palette uploads once per lease (cached by content hash); chunk YAMLs
   * are presigned in one batch. Each chunk's artifacts download (6 at a
   * time) while the next window's dump runs. Images land in `screenshotDir`
   * by basename; a multi-chunk run files each chunk's logs under
   * `chunks/NN/` so chunk 3's maestro log cannot overwrite chunk 2's, and an
   * image's `debug/` captures stay out of `screenshots[]`.
   *
   * `opts.state` is accepted for surface parity and ignored: the state is
   * fixed when the lease is acquired.
   */
  async runRecipe(
    recipePath: string,
    env: Record<string, string>,
    screenshotDir: string,
    opts: {
      state?: string;
      screenshotPrefix?: string;
      paletteTarB64?: string;
      paletteKey?: string;
      captureAllBoundaries?: boolean;
      onProgress?: RecipeProgressListener;
      /**
       * Record the walk (`ace-mobile record start|stop`), as the local backend
       * does around every attempt. Absent = no recording (the client omits it
       * when `ACE_MOBILE_RECORD=off`). Best-effort: a recording failure never
       * changes the verdict.
       */
      record?: LeaseRecordOpts;
      /** Where a recorded video is pushed — on success AND when the walk throws. */
      videoSink?: VideoArtifact[];
    } = {},
  ): Promise<RecipeRunResult> {
    let body: string;
    try {
      body = await fs.readFile(recipePath, 'utf8');
    } catch (e: unknown) {
      throw new RecipeValidationError(recipePath, `failed to read recipe: ${(e as Error).message}`);
    }
    this.requireLease('run-recipe');
    const chunks = splitRecipeAtScreenshots(body, {
      captureAllBoundaries: opts.captureAllBoundaries === true,
      resolveSubflow: subflowResolverFor(path.resolve(recipePath)),
    });
    const multi = chunks.length > 1;
    logInfo(
      `lease: ${path.basename(recipePath)} → ${chunks.length} chunk(s), ` +
        `${chunks.filter((c) => c.screenshotName).length} dump window(s), ${countRecipeSteps(body)} top-level step(s)`,
    );

    // Stage every input in one presign: the palette (cached for the lease's
    // life), then each chunk's YAML (a single-chunk run ships the recipe itself).
    const tag = slug(opts.screenshotPrefix ?? path.basename(recipePath, path.extname(recipePath)));
    const files: UploadFile[] = [];
    if (opts.paletteTarB64) {
      const bytes = Buffer.from(opts.paletteTarB64, 'base64');
      const key = opts.paletteKey ?? contentKey(bytes);
      files.push({ name: `palette-${key.slice(0, 16)}.tar.gz`, bytes, key });
    }
    chunks.forEach((c, i) => {
      files.push({
        name: multi ? `${tag}--chunk-${pad(i + 1)}.yaml` : `${tag}--${path.basename(recipePath)}`,
        bytes: Buffer.from(multi ? c.yaml : body, 'utf8'),
      });
    });
    const tUp = this.now();
    const uris = await this.upload(files);
    const uploadMs = this.now() - tUp;
    const palette = opts.paletteTarB64 ? uris[0] : undefined;
    const chunkUris = opts.paletteTarB64 ? uris.slice(1) : uris;

    const timings: RemoteOpTiming[] = [];
    // Recording starts after the inputs are staged (upload time is not walk
    // time) and stops in `finally`, so a stalled or thrown walk — the case a
    // video is worth most — still yields its footage.
    const recording = opts.record ? await this.startRecording(opts.record, timings) : null;
    try {
      const screenshots: ScreenshotEntry[] = [];
      const steps: StepResult[] = [];
      const warnings: string[] = [];
      const stdoutParts: string[] = [];
      const stderrParts: string[] = [];
      let failingStdout = '';
      let failingStderr = '';
      let lastExit = 0;
      let completed = 0;
      let lastCompletedScreenshot: string | null = null;
      let pendingDownload: Promise<void> | null = null;
      const envArgs = Object.entries(env ?? {}).map(([k, v]) => `${k}=${v}`);

      for (const [i, chunk] of chunks.entries()) {
        const budget = resolveChunkTimeout({ stepCount: countRecipeSteps(chunk.yaml) });
        const cliTimeoutS = Math.ceil(budget.timeoutMs / 1000);
        emitProgress(opts.onProgress, {
          kind: 'chunk-start',
          chunkIndex: i + 1,
          chunksTotal: chunks.length,
          screenshotName: chunk.screenshotName ?? null,
        });
        const call = await this.runCli(
          'runRecipe',
          { recipe: chunkUris[i], palette, env: envArgs, timeoutS: cliTimeoutS },
          { timeoutS: cliTimeoutS + EXEC_OVERHEAD_S },
        );
        const { json, exec } = call;
        if (i === 0) call.timing.upload_ms = uploadMs;
        timings.push(call.timing);

        const exitCode = typeof json.exit_code === 'number' ? json.exit_code : (exec.exit_code ?? 1);
        const label = multi ? `# --- chunk ${chunk.index} (screenshot=${chunk.screenshotName ?? 'none'}) ---\n` : '';
        const stdout = typeof json.stdout === 'string' ? json.stdout : (exec.stdout_tail ?? '');
        const stderr = typeof json.stderr === 'string' ? json.stderr : '';
        stdoutParts.push(label + stdout);
        stderrParts.push(label + stderr);
        if (typeof json.upload_error === 'string' && json.upload_error) {
          warnings.push(`chunk ${i + 1}/${chunks.length}: the machine could not upload every artifact (${json.upload_error}) — some files may be missing`);
        }
        if (Array.isArray(json.steps)) {
          for (const st of json.steps as Parameters<typeof normalizeRemoteStep>[0][]) {
            steps.push({ ...normalizeRemoteStep(st), index: steps.length });
          }
        }
        emitProgress(opts.onProgress, {
          kind: 'chunk-done',
          chunkIndex: i + 1,
          chunksTotal: chunks.length,
          screenshotName: chunk.screenshotName ?? null,
          exitCode,
        });

        // This chunk's artifacts download while the dump window (if any) runs.
        if (pendingDownload) await pendingDownload;
        const download = this.downloadChunk(call.outRel, screenshotDir, multi ? `chunks/${pad(i + 1)}` : undefined, call.timing)
          .then((shots) => {
            screenshots.push(...shots);
          });

        if (json.error === 'recipe-timeout') {
          await download.catch(() => {});
          throw new MobileError(
            'MAESTRO_STALL',
            `maestro wedged on the lease (no exit within ${cliTimeoutS}s, budget basis ${budget.basis}` +
              `${budget.stepCount === null ? '' : ` over ${budget.stepCount} step(s)`}) on chunk ${i + 1}/${chunks.length} ` +
              `of ${path.basename(recipePath)}` +
              (lastCompletedScreenshot
                ? ` — last completed step ended at screenshot "${lastCompletedScreenshot}"`
                : ' — no chunk had completed yet'),
            'Do NOT assume the walk failed: on-device progress up to the stall is real (verify server-side, ' +
              'e.g. connect_get_learn_progress) — a stalled dispatch after the productive work has completed is ' +
              `the ace#1164 signature. The chunk's own artifacts were downloaded into ${screenshotDir}.`,
            {
              recipe: recipePath,
              chunks_completed: completed,
              chunks_total: chunks.length,
              last_completed_screenshot: lastCompletedScreenshot,
              timeout_ms: cliTimeoutS * 1000,
              timeout_basis: budget.basis,
              step_count: budget.stepCount,
              screenshot_dir: screenshotDir,
            },
          );
        }

        lastExit = exitCode;
        if (exitCode !== 0) {
          failingStdout = label + stdout;
          failingStderr = label + stderr;
          pendingDownload = download;
          break;
        }
        completed++;
        if (chunk.screenshotName) {
          lastCompletedScreenshot = chunk.screenshotName;
          // The quiet window between Maestro processes — the only time
          // uiautomator is free (docs/learnings/2026-05-14-atlas-side-channel-capture.md).
          const name = chunk.screenshotName;
          const dumpP = this.uiDumpTimed()
            .then(async ({ dump, timing }) => {
              timings.push(timing);
              if (dump.xml) await fs.writeFile(path.join(screenshotDir, `${name}.xml`), dump.xml, 'utf8');
            })
            .catch((e) => logInfo(`lease: ui-dump after chunk ${i + 1} (${name}) failed: ${(e as Error).message}`));
          pendingDownload = Promise.all([download, dumpP]).then(() => {});
        } else {
          pendingDownload = download;
        }
        // Don't start the next chunk until the dump window has closed.
        if (chunk.screenshotName && pendingDownload) await pendingDownload.catch(() => {});
      }
      if (pendingDownload) await pendingDownload;

      const aggStdout = stdoutParts.join('\n');
      const aggStderr = stderrParts.join('\n');
      const result = finalizeRecipeResult({
        exitCode: lastExit,
        stdout: aggStdout,
        stderr: aggStderr,
        screenshotsDir: screenshotDir,
        screenshots: screenshots.sort((a, b) => a.path.localeCompare(b.path)),
        classifyStdout: lastExit === 0 ? aggStdout : failingStdout,
        classifyStderr: lastExit === 0 ? aggStderr : failingStderr,
        walkCompleted: completed >= chunks.length,
      });
      if (warnings.length) result.warnings = [...(result.warnings ?? []), ...warnings];
      if (steps.length) result.steps = steps;
      result.remoteTimings = timings;
      if (!result.failure) result.failure = classifyMaestroFailure({ stderr: aggStderr, stdout: aggStdout, exitCode: lastExit });
      return result;
    } finally {
      if (recording) {
        const video = await this.stopRecording(recording, screenshotDir, timings);
        if (video) opts.videoSink?.push(video);
      }
    }
  }

  /** List one exec's `--out` and download it: images to the root by basename, the rest under `subdir`. */
  private async downloadChunk(
    outRel: string,
    screenshotDir: string,
    subdir: string | undefined,
    timing: RemoteOpTiming,
  ): Promise<ScreenshotEntry[]> {
    const t = this.now();
    const rows = await this.listArtifacts(outRel);
    const shots = await materializeArtifacts(
      rows.map((r) => artifactPlacement(r, subdir)),
      screenshotDir,
      (url, dest) => downloadToFile(this.fetchImpl, url, dest, this.retryConfig, 'LEASE_DOWNLOAD_FAILED'),
      'lease',
      this.downloadConcurrency,
    );
    timing.download_ms = this.now() - t;
    timing.total_ms += timing.download_ms;
    return shots;
  }

  // ── Recording (the lease twin of screen-recorder.ts) ────────────

  /**
   * `ace-mobile record start`. Best-effort: any failure is logged and the
   * walk runs unrecorded. A CLI without the subcommand (`usage`) turns
   * recording off for the rest of this machine's life — asking once is
   * enough. Same file name as local: `<recipeId>.mp4`.
   */
  private async startRecording(
    rec: LeaseRecordOpts,
    timings: RemoteOpTiming[],
    retried = false,
  ): Promise<{ rec: LeaseRecordOpts; name: string } | null> {
    const held = this.held;
    if (!held || held.recordUnsupported) return null;
    const name = `${rec.recipeId}.mp4`;
    try {
      const { json, timing } = await this.runCli('recordStart', {
        name,
        ...(rec.bitRate ? { bitRate: rec.bitRate } : {}),
        ...(rec.size ? { size: rec.size } : {}),
      });
      timings.push(timing);
      if (json.ok === false && json.error === 'record-busy' && !retried) {
        // A recording a previous walk never stopped (its stop was lost with a
        // dropped exec). One at a time on the machine: stop and discard it,
        // then start ours.
        const stale = json.recording && typeof json.recording === 'object' ? (json.recording as Record<string, unknown>) : {};
        logInfo(`lease: a stale recording (${String(stale.name ?? '?')}) is still running on ${held.id} — stopping and discarding it`);
        await this.runCli('recordStop', typeof stale.name === 'string' ? { name: stale.name } : {}, {
          outRel: `forensics/${slug('stale-recording')}/`,
        }).catch(() => {});
        return this.startRecording(rec, timings, true);
      }
      if (json.ok === false) {
        logInfo(`lease: record start for ${rec.recipeId} declined (${String(json.error)}: ${String(json.message ?? '')}) — walking unrecorded`);
        return null;
      }
      return { rec, name: typeof json.name === 'string' && json.name ? json.name : name };
    } catch (e) {
      if (e instanceof MobileError && e.code === 'LEASE_CLI_USAGE') {
        held.recordUnsupported = true;
        logInfo(`lease: the CLI on ${held.id} cannot record (no \`record\` subcommand) — walks on this machine are unrecorded`);
      } else {
        logInfo(`lease: record start for ${rec.recipeId} failed: ${(e as Error).message.split('\n')[0]} — walking unrecorded`);
      }
      return null;
    }
  }

  /**
   * `ace-mobile record stop --out …`, then download the mp4 into
   * `screenshotDir` as `<recipeId>.mp4` — the path, name and VideoArtifact
   * shape the local recorder produces. Never throws; an empty or missing
   * file is no video.
   */
  private async stopRecording(
    started: { rec: LeaseRecordOpts; name: string },
    screenshotDir: string,
    timings: RemoteOpTiming[],
  ): Promise<VideoArtifact | undefined> {
    if (!this.held) return undefined;
    const { rec, name } = started;
    const outRel = `record-${slug(rec.recipeId)}/`;
    try {
      const { json, timing } = await this.runCli('recordStop', { name }, { outRel });
      timings.push(timing);
      if (json.ok === false) {
        logInfo(`lease: record stop for ${rec.recipeId}: ${String(json.error)} — no video`);
        return undefined;
      }
      if (typeof json.upload_error === 'string' && json.upload_error) {
        logInfo(`lease: record stop for ${rec.recipeId} could not upload the video (${json.upload_error})`);
      }
      const rows = await this.listArtifacts(outRel);
      const wanted = typeof json.name === 'string' && json.name ? json.name : name;
      const row =
        rows.find((r) => r.relPath === wanted) ??
        rows.find((r) => r.relPath.split('/').pop() === wanted) ??
        rows.find((r) => r.relPath.endsWith('.mp4'));
      if (!row) {
        logInfo(`lease: record stop for ${rec.recipeId} uploaded no mp4 under ${outRel}`);
        return undefined;
      }
      await fs.mkdir(screenshotDir, { recursive: true });
      const dest = path.join(screenshotDir, `${rec.recipeId}.mp4`);
      const t = this.now();
      await downloadToFile(this.fetchImpl, row.url, dest, this.retryConfig, 'LEASE_DOWNLOAD_FAILED');
      timing.download_ms = this.now() - t;
      timing.total_ms += timing.download_ms;
      const bytes = (await fs.stat(dest)).size;
      if (bytes === 0) {
        await fs.rm(dest, { force: true });
        logInfo(`lease: the recording of ${rec.recipeId} is empty — discarded`);
        return undefined;
      }
      return { path: dest, bytes, recipeId: rec.recipeId, dispatchId: rec.dispatchId, attempt: 1 };
    } catch (e) {
      logInfo(`lease: record stop for ${rec.recipeId} failed: ${(e as Error).message.split('\n')[0]} — no video`);
      return undefined;
    }
  }

  // ── CLI exec plumbing ───────────────────────────────────────────

  private requireLease(op: string): HeldLease {
    if (!this.held) {
      throw new MobileError(
        'LEASE_NOT_ACQUIRED',
        `${op}: this MCP process holds no android-emulator lease`,
        'Call mobile_ensure_avd_running first — it acquires the machine and waits until it is ready ' +
          '(then run the prerequisite recipes: a new machine has no login or claim).',
      );
    }
    return this.held;
  }

  /**
   * One CLI call: exec with `--out` under the lease's out prefix, poll to
   * terminal (long-polling where the broker holds the GET, re-checking the
   * lease every `heartbeatMs`), parse the CLI's JSON line.
   *
   * run-recipe reports a Maestro failure as data (`exit_code` in its JSON),
   * not as a CLI error, so a JSON line carrying a `dataErrors` code is
   * returned even when the command itself exited non-zero.
   */
  private async runCli<N extends CliOpName>(op: N, values: CliValues<N>, callOpts: CliCallOpts = {}): Promise<CliCall> {
    const held = this.requireLease(op);
    const spec: CliOp = CLI[op];
    const cmd = spec.sub.join(' ');
    const t0 = this.now();
    let outRel = '';
    let argvValues: Record<string, unknown> = { ...values };
    if (spec.sendsOut) {
      // Only ops that read artifacts back get `--out` (argparse refuses it on most).
      outRel = callOpts.outRel ?? `${slug(spec.sub.join('-'))}/`;
      argvValues = { ...argvValues, out: `${await this.outPrefix(held)}${outRel}` };
    }
    const argv = cliArgv(op, argvValues as CliValues<N>);
    const timeoutS = callOpts.timeoutS ?? spec.timeoutS;

    const tPost = this.now();
    const execId = await this.postExec(held, cmd, argv, timeoutS);
    const timing: RemoteOpTiming = { op: cmd, exec_id: execId, post_ms: this.now() - tPost, polls: 0, poll_ms: 0, total_ms: 0 };
    const exec = await this.pollExec(held, cmd, execId, timeoutS, timing);

    const tRes = this.now();
    let json = parseCliJson(exec.stdout_tail);
    // The broker inlines only the last 4,000 chars of stdout, so a long result
    // line arrives with its head cut off: read the full stdout, then
    // (run-recipe) its result.json.
    if (!json && exec.stdout_url) json = parseCliJson(await this.fetchText(exec.stdout_url).catch(() => ''));
    // The CLI sheds detail from its inline line to fit SSM's limit and says
    // what it cut (`inline_truncated`: steps, artifacts, stdout, stderr);
    // result.json under --out keeps everything. A truncated line is a
    // complete answer for every field it did not name, so it stays the
    // fallback if result.json cannot be read.
    const truncated = json && Array.isArray(json.inline_truncated) && json.inline_truncated.length > 0;
    if ((!json || truncated) && outRel) {
      const hit = (await this.listArtifacts(outRel).catch(() => [])).find((r) => r.relPath === 'result.json');
      const full = hit ? parseCliJson((await this.fetchText(hit.url).catch(() => '')).replace(/\n/g, ' ')) : null;
      if (full) json = full;
      else if (truncated) logInfo(`lease: ${cmd} inline result was truncated (${(json!.inline_truncated as unknown[]).join(', ')}) and result.json is unreadable — using the inline copy`);
    }
    timing.result_ms = this.now() - tRes;
    timing.total_ms = this.now() - t0;
    if (!json) {
      const stderr =
        exec.stderr_tail || (exec.stderr_url ? await this.fetchText(exec.stderr_url).catch(() => '') : '');
      throw new MobileError(
        'LEASE_EXEC_FAILED',
        `ace-mobile ${cmd} printed no JSON result (SSM ${exec.status}, exit ${exec.exit_code ?? '?'})` +
          (stderr ? `\n--- stderr tail ---\n${stderr.slice(-1500)}` : ''),
        'Check the CLI version baked into the image (ready.json cli_version) against lease-contract.ts.',
      );
    }
    logInfo(
      `lease: ${cmd} exec ${execId} ${json.ok === false ? `error=${String(json.error ?? '?')}` : 'ok'} — ` +
        `post ${timing.post_ms}ms, queue ${timing.queue_ms ?? '?'}ms, run ${timing.run_ms ?? '?'}ms, ` +
        `${timing.polls} poll(s) ${timing.poll_ms}ms, result ${timing.result_ms}ms, total ${timing.total_ms}ms`,
    );
    if (json.ok === false && !(spec.dataErrors ?? []).includes(String(json.error))) {
      throw this.cliError(held, cmd, json);
    }
    return { json, exec, outRel, timing };
  }

  private cliError(held: HeldLease, cmd: string, json: CliResult): MobileError | AvdBootError {
    const code = String(json.error ?? 'internal');
    const base = String(json.message ?? `ace-mobile ${cmd} failed`);
    const diagnostics =
      json.diagnostics && typeof json.diagnostics === 'object' ? (json.diagnostics as Record<string, unknown>) : undefined;
    const message = diagnostics ? `${base}\n\nIn-VM diagnostics:\n${formatDiagnostics(diagnostics)}` : base;
    if (code === 'boot-timeout') return new AvdBootError('lease', message);
    if (code === 'emulator-crashed' || code === 'no-device') {
      // The emulator on this machine is gone. A lease is never nursed: the
      // next ensure replaces it.
      held.sick = true;
      return new MobileError(
        'LEASE_EMULATOR_CRASHED',
        `ace-mobile ${cmd}: the emulator on lease ${held.id} is gone (${code}): ${message}`,
        `Release it (mobile_stop_avd) — or just call mobile_ensure_avd_running, which replaces a sick machine. ${LEASE_RESTORE_HINT}`,
        diagnostics,
      );
    }
    return new MobileError(
      `LEASE_CLI_${code.toUpperCase().replace(/-/g, '_')}`,
      `ace-mobile ${cmd}: ${message}`,
      code === 'usage'
        ? `The CLI baked into the image${json.cli_version ? ` (${json.cli_version})` : ''} rejected argv ` +
            'that mcp/mobile/backends/lease-contract.ts produced — the contract has drifted; rebake or update it.'
        : code === 's3-download-failed'
          ? 'The machine could not read an input the client uploaded (presign expired, or the instance role lost read on ' +
            'the lease prefix). Repeat the step; if it persists, check the stack\'s LeaseObjectScope / instance role.'
          : code === 's3-upload-failed'
            ? 'The machine ran the step but could not upload its output (instance role lost write on the lease out prefix). ' +
              'Check the device state before repeating a one-way step.'
            : code === 'internal'
              ? 'A bug in the image\'s ace-mobile CLI (the JSON contract held). The message names the exception; fix ' +
                'infra/capabilities/android-emulator/image/cli/ace_mobile.py and rebake.'
              : undefined,
      diagnostics,
    );
  }

  /**
   * POST the exec, exactly once. A retry after a gateway 5xx could run the
   * command a SECOND time (SendCommand may already have succeeded), so an
   * answer this client cannot read is LEASE_EXEC_AMBIGUOUS, never a retry.
   */
  private async postExec(held: HeldLease, cmd: string, argv: string[], timeoutS: number): Promise<string> {
    const out = await this.request<ExecOut>(
      'POST',
      routePath('exec', { lease_id: held.id }),
      { argv, timeout_s: timeoutS },
      { retry: false, ambiguous: cmd },
    );
    if (!out?.exec_id) throw new MobileError('LEASE_BAD_RESPONSE', `exec ${cmd} returned no exec_id`);
    return out.exec_id;
  }

  private async pollExec(
    held: HeldLease,
    cmd: string,
    execId: string,
    timeoutS: number,
    timing: RemoteOpTiming,
  ): Promise<ExecStatusOut> {
    const sentAt = this.now();
    const deadline = sentAt + (timeoutS + 120) * 1000;
    let lastBeat = sentAt;
    let lastStatus = '';
    let runningSince: number | null = null;
    for (;;) {
      const t = this.now();
      let exec: ExecStatusOut;
      try {
        exec = await this.riding(
          () =>
            this.request<ExecStatusOut>(
              'GET',
              routePath('execStatus', { lease_id: held.id, exec_id: execId }, this.waitQuery()),
            ),
          `${cmd} (exec ${execId})`,
        );
      } catch (e) {
        timing.poll_ms = (timing.poll_ms ?? 0) + (this.now() - t);
        timing.polls = (timing.polls ?? 0) + 1;
        if (e instanceof MobileError && e.code === 'LEASE_NOT_FOUND') {
          // SSM's GetCommandInvocation lags SendCommand by seconds; the broker
          // reads that lag as pending, but defend against an older broker (and
          // a slow region) here too: early 404s are pending.
          if (this.now() - sentAt < this.execNotFoundGraceMs) {
            await this.backoff(this.now() - t, this.now() - sentAt);
            continue;
          }
          throw await this.explainExecNotFound(held, cmd, execId, e);
        }
        throw e;
      }
      const took = this.now() - t;
      timing.poll_ms = (timing.poll_ms ?? 0) + took;
      timing.polls = (timing.polls ?? 0) + 1;
      const status = String(exec.status).toLowerCase();
      if (timing.queue_ms === undefined && !SSM_PENDING.has(status)) timing.queue_ms = this.now() - sentAt;
      if (runningSince === null && status === 'inprogress') runningSince = this.now();
      if (execIsTerminal(exec)) {
        timing.run_ms = runningSince === null ? null : this.now() - runningSince;
        if (timing.queue_ms === undefined) timing.queue_ms = null;
        return exec;
      }
      this.notePollLatency(took, status === lastStatus);
      lastStatus = status;
      if (this.now() > deadline) {
        throw new MobileError(
          'LEASE_EXEC_TIMEOUT',
          `${cmd} (exec ${execId}) still ${exec.status} after ${timeoutS + 120}s`,
          'The machine may be wedged: mobile_stop_avd, then mobile_ensure_avd_running for a fresh one ' +
            '(and the prerequisite recipes on it).',
        );
      }
      if (this.now() - lastBeat >= this.heartbeatMs) {
        lastBeat = this.now();
        await this.heartbeat(held.id);
      }
      await this.backoff(took, this.now() - sentAt);
    }
  }

  /**
   * Run one idempotent poll read, riding out a network outage: transport
   * failures and gateway 5xx are retried with backoff for up to
   * `pollOutageMs`. Anything else (a 404, a 409, an auth failure) is an
   * answer and is thrown at once.
   */
  private async riding<T>(read: () => Promise<T>, what: string): Promise<T> {
    const started = this.now();
    let delay = 1_000;
    for (;;) {
      try {
        return await read();
      } catch (e) {
        const transient =
          e instanceof MobileError && (e.code === 'LEASE_FETCH_FAILED' || /^LEASE_HTTP_50[234]$/.test(e.code));
        if (!transient || this.now() - started >= this.pollOutageMs) throw e;
        logInfo(`lease: ${what}: ${(e as Error).message.split('\n')[0]} — retrying (network outage tolerance)`);
        await this.sleep(Math.min(delay, this.pollIntervalMs || delay));
        delay = Math.min(delay * 2, 10_000);
      }
    }
  }

  /** A 404 past the grace: the exec is unknown, or the lease itself is gone — say which. */
  private async explainExecNotFound(held: HeldLease, cmd: string, execId: string, e: MobileError): Promise<MobileError> {
    try {
      const lease = await this.getLease(held.id);
      if (lease.status !== 'ready') return this.lostError(held.id, String(lease.status), lease.reason);
    } catch (le) {
      if (le instanceof MobileError) return le;
    }
    return new MobileError(
      'LEASE_EXEC_LOST',
      `${cmd} (exec ${execId}) is unknown to the broker ${Math.round(this.execNotFoundGraceMs / 1000)}s after it was sent: ${e.message}`,
      'The command may or may not have run. Check the device (mobile_capture_ui_dump, and for a walk ' +
        'connect_get_learn_progress) before repeating a one-way step.',
    );
  }

  /** `?wait_s` while long-poll is not known to be ignored. */
  private waitQuery(): Record<string, string | undefined> {
    return this.longPollS > 0 && this.longPollObserved !== false ? { wait_s: String(this.longPollS) } : {};
  }

  /**
   * Learn from how long a non-terminal GET took: held for seconds → the
   * broker long-polls; answered at once twice with nothing changed → it
   * ignored `wait_s` (an older broker), so stop sending it.
   */
  private notePollLatency(tookMs: number, unchanged: boolean): void {
    if (this.longPollS === 0 || this.longPollObserved !== null) return;
    if (tookMs >= LONG_POLL_HELD_MS) {
      this.longPollObserved = true;
      logInfo('lease: broker long-polls (?wait_s held the GET) — polling without client sleeps');
    } else if (unchanged && tookMs < 1_000 && ++this.fastAnswers >= 2) {
      this.longPollObserved = false;
      logInfo('lease: broker ignores ?wait_s (answered at once) — short polling with backoff');
    }
  }

  /**
   * Sleep before the next poll: 1 s for the first 10 s, 2 s to 30 s, then
   * `pollIntervalMs` — minus however long the last GET itself took, so a GET
   * the broker held (long-poll) is followed by no sleep at all.
   */
  private async backoff(tookMs: number, elapsedMs: number): Promise<void> {
    const cap = this.pollIntervalMs;
    const step = elapsedMs < 10_000 ? Math.min(1_000, cap) : elapsedMs < 30_000 ? Math.min(2_000, cap) : cap;
    const wait = step - tookMs;
    if (wait > 0) await this.sleep(wait);
  }

  private lostError(id: string, status: string, reason?: string | null): MobileError {
    const idle = this.lastCallAt !== null ? Math.round((this.now() - this.lastCallAt) / 1000) : null;
    const held = this.held?.id === id ? this.held : null;
    const window = held?.idleReleaseS ?? null;
    const idleNote =
      reason && /idle/i.test(reason)
        ? ` — the broker's idle release${window ? ` (${window}s)` : ''} took it`
        : '';
    return new MobileError(
      'LEASE_LOST',
      `lease ${id} is ${status}${reason ? `: ${reason}` : ''}${idleNote}` +
        (idle !== null && window && idle > window ? ` (this session's previous call was ${idle}s ago)` : ''),
      LEASE_RESTORE_HINT,
    );
  }

  private async heartbeat(id: string): Promise<void> {
    const lease = await this.riding(() => this.getLease(id), `lease ${id} heartbeat`);
    if (lease.status !== 'ready') throw this.lostError(id, String(lease.status), lease.reason);
  }

  private async getLease(id: string, longPoll = false): Promise<LeaseOut> {
    try {
      return await this.request<LeaseOut>('GET', routePath('get', { lease_id: id }, longPoll ? this.waitQuery() : {}));
    } catch (e) {
      // The broker forgot the lease (swept): from the caller's side that is a loss.
      if (e instanceof MobileError && e.code === 'LEASE_NOT_FOUND') throw this.lostError(id, 'gone (404)', 'released and swept');
      throw e;
    }
  }

  /** The `--out` prefix: the broker's `out_prefix`, never one built here. */
  private async outPrefix(held: HeldLease): Promise<string> {
    if (held.outPrefix) return held.outPrefix;
    const lease = await this.getLease(held.id);
    this.absorb(held, lease);
    if (!held.outPrefix) {
      throw new MobileError(
        'LEASE_BAD_RESPONSE',
        `lease ${held.id} carries no out_prefix — this client writes only where the broker says ` +
          '(per-instance S3 prefixes); a broker that omits it predates the capability contract',
        'Deploy a canopy-web whose CapabilityLeaseOut returns out_prefix.',
      );
    }
    return held.outPrefix;
  }

  private async presign(names: string[]): Promise<UploadSlot[]> {
    const held = this.requireLease('upload');
    const slots: UploadSlot[] = [];
    for (let i = 0; i < names.length; i += UPLOAD_BATCH) {
      const body = await this.request<unknown>('POST', routePath('uploads', { lease_id: held.id }), {
        names: names.slice(i, i + UPLOAD_BATCH),
      });
      slots.push(...normalizeUploads(body));
    }
    return slots;
  }

  /**
   * PUT each file to its presigned URL; returns the s3:// URIs the broker
   * named, in order. A file with a `key` already uploaded to this lease is
   * not sent again (the palette: once per lease, not once per recipe).
   */
  private async upload(files: UploadFile[]): Promise<string[]> {
    const held = this.requireLease('upload');
    const uris: Array<string | undefined> = files.map((f) => (f.key ? held.uploaded.get(f.key) : undefined));
    const todo = files.filter((_, i) => uris[i] === undefined);
    if (todo.length) {
      const slots = await this.presign(todo.map((f) => f.name));
      await Promise.all(
        todo.map(async (f) => {
          const slot = slots.find((s) => s.name === f.name);
          if (!slot) throw new MobileError('LEASE_BAD_RESPONSE', `uploads returned no slot for ${f.name}`);
          const { response, lastError, attempts } = await fetchWithRetry(
            this.fetchImpl,
            slot.putUrl,
            { method: 'PUT', body: new Uint8Array(f.bytes), headers: slot.headers },
            this.retryConfig,
          );
          if (!response || !response.ok) {
            throw new MobileError(
              'LEASE_UPLOAD_FAILED',
              `PUT ${f.name} failed after ${attempts} attempt(s): ` +
                (response ? `HTTP ${response.status}` : ((lastError as Error)?.message ?? 'unknown')),
            );
          }
          uris[files.indexOf(f)] = slot.uri;
          if (f.key) held.uploaded.set(f.key, slot.uri);
        }),
      );
    }
    return uris as string[];
  }

  private async listArtifacts(outRel: string): Promise<ArtifactRow[]> {
    const held = this.requireLease('artifacts');
    const body = await this.request<unknown>(
      'GET',
      routePath('artifacts', { lease_id: held.id }, { prefix: outRel }),
    );
    return normalizeArtifacts(body, outRel);
  }

  private async fetchText(url: string): Promise<string> {
    const { response } = await fetchWithRetry(this.fetchImpl, url, undefined, this.retryConfig);
    if (!response || !response.ok) throw new Error(`GET ${url} → ${response?.status ?? 'network error'}`);
    return response.text();
  }

  // ── HTTP ────────────────────────────────────────────────────────

  private async request<T>(
    method: string,
    routePathStr: string,
    body?: unknown,
    opts: { retry?: boolean; ambiguous?: string } = {},
  ): Promise<T> {
    return brokerRequest<T>(
      {
        baseUrl: this.baseUrl,
        token: this.token,
        fetchImpl: this.fetchImpl,
        requestTimeoutMs: this.requestTimeoutMs,
        retry: this.retryConfig,
        onAnswered: () => {
          this.lastCallAt = this.now();
        },
      },
      method,
      routePathStr,
      body,
      opts,
    );
  }
}

/** The broker's `out_prefix`, with a trailing slash; null when it states none. */
function outPrefixOf(lease: LeaseOut): string | null {
  if (!lease.out_prefix) return null;
  return lease.out_prefix.endsWith('/') ? lease.out_prefix : `${lease.out_prefix}/`;
}

/**
 * Where one artifact lands under the caller's dir. Images go to the root by
 * basename — the layout callers (and the retired ace-web backend) read — and
 * an image's own `debug/` captures stay out of `screenshots[]`. Non-images go
 * to the root for a single-chunk run, or under `chunkDir` for a chunked one,
 * so each chunk's logs and result.json survive the next chunk's.
 */
function artifactPlacement(row: ArtifactRow, chunkDir: string | undefined): RemoteArtifact {
  const segs = row.relPath.split('/').filter(Boolean);
  const name = segs[segs.length - 1] ?? row.relPath;
  const contentType = row.contentType ?? contentTypeFor(name);
  const isDebug = segs.length > 1 && segs[0] === 'debug';
  const isImage = contentType.startsWith('image/');
  const parts: string[] = [];
  if (chunkDir && (!isImage || isDebug)) parts.push(chunkDir);
  if (isDebug) parts.push('debug');
  return {
    name,
    url: row.url,
    contentType,
    ...(parts.length ? { subdir: parts.join('/') } : {}),
    ...(isDebug ? { screenshot: false } : {}),
  };
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** A short unique, path-safe tag: `<base>-<time36><rand>`. */
function slug(base: string): string {
  const clean = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'op';
  return `${clean}-${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
}
