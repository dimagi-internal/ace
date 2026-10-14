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
// lease out after `idle_release_s` without a GET. This backend heartbeats only
// while an operation is in flight. A session that goes quiet for longer loses
// its machine and the next call fails with LEASE_LOST, naming the restore
// (`mobile_ensure_avd_running`). A background timer would keep an abandoned
// session's machine alive up to `max_lease_s` — the cost leak the idle release
// exists to stop.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { canopyApiBase, canopyToken } from '../../../lib/ace-canopy-pat.js';
import { classifyMaestroFailure } from '../../../lib/maestro-failure-class.js';
import { AvdBootError, MobileError, RecipeValidationError } from '../errors.js';
import { logInfo } from '../logging.js';
import type {
  ApkInfo,
  AvdInfo,
  RecipeRunResult,
  SnapshotResult,
  TestUserRegistrationResult,
  UiDumpResult,
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
  readyMarker,
  routePath,
  type CliOp,
  type CliOpName,
  type CliResult,
  type CliValues,
  type DeclaredCapability,
  type ExecOut,
  type ExecStatusOut,
  type LeaseOut,
  type UploadSlot,
} from './lease-contract.js';
import {
  contentTypeFor,
  downloadToFile,
  fetchWithRetry,
  formatDiagnostics,
  materializeArtifacts,
  normalizeRemoteStep,
  parseUiHierarchy,
  resolveRetry,
  type Problem,
  type RetryConfig,
  type RetryOpts,
} from './remote-io.js';

/** In-VM diagnostics from `ace-mobile diagnose`, plus the lease it ran on. */
export type LeaseDiagnostics = Record<string, unknown> & {
  lease: { lease_id: string; status: string; instance_id: string | null; expires_at: string | null } | null;
};

export interface LeaseBackendOpts {
  baseUrl?: string;
  token?: string;
  fetchImpl?: typeof fetch;
  /** Default `state` param when the caller's AVD name is not a `cc-*` state. Empty = manifest default. */
  defaultState?: string;
  /** Lease + exec poll interval (ms). Default 5 s; tests pass 0. */
  pollIntervalMs?: number;
  /** Bound on time spent `queued` before giving up and releasing the queue slot. Default 20 min. */
  queueWaitMs?: number;
  /** Readiness bound when the manifest's `ready_timeout_s` can't be read. Default 900 s. */
  fallbackReadyTimeoutS?: number;
  /** Heartbeat the lease this often while an exec is in flight. Default 60 s. */
  heartbeatMs?: number;
  /** Per-request timeout (ms). Default 60 s — every broker call returns immediately. */
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
}

const READY_SLACK_S = 60;

export class LeaseBackend {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  readonly defaultState: string;
  private readonly pollIntervalMs: number;
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

  constructor(opts: LeaseBackendOpts = {}) {
    const token = opts.token ?? canopyToken() ?? '';
    if (!token) {
      throw new MobileError(
        'LEASE_NOT_CONFIGURED',
        "the lease mobile backend needs ACE's canopy-web PAT (CANOPY_WEB_PAT in ACE's .env)",
        'Run /ace:setup --force-env (CANOPY_WEB_PAT comes from 1Password Agent-Ace/canopy-pat), ' +
          'or use the local AVD with /ace:mobile-backend local.',
      );
    }
    this.token = token;
    this.baseUrl = (opts.baseUrl ?? canopyApiBase()).replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.defaultState = opts.defaultState ?? '';
    this.pollIntervalMs = opts.pollIntervalMs ?? 5_000;
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

  // ── Lifecycle ───────────────────────────────────────────────────

  /**
   * Acquire (or reuse) this process's lease and wait until it is `ready`.
   *
   * Reuse: a lease this process already holds is kept when it is still
   * `ready` and was acquired for the same state. Anything else — a different
   * state, or a lease that is no longer ready — is released and replaced. A
   * `ready` lease never goes back to provisioning (spec §4): a sick machine is
   * released and a new one acquired, never nursed.
   */
  async ensureAvdRunning(name: string): Promise<AvdInfo> {
    if (this.acquiring) return this.acquiring;
    this.acquiring = this.ensureInner(name).finally(() => {
      this.acquiring = null;
    });
    return this.acquiring;
  }

  private async ensureInner(name: string): Promise<AvdInfo> {
    const state = this.resolveState(name);
    if (this.held) {
      if (this.held.state === state) {
        try {
          const lease = await this.getLease(this.held.id);
          if (lease.status === 'ready') {
            logInfo(`lease: reusing ${this.held.id} (${this.held.instanceId ?? 'instance ?'}) for state=${state || 'default'}`);
            return this.held.info;
          }
          logInfo(`lease: held ${this.held.id} is ${lease.status}, not ready — replacing it`);
        } catch (e) {
          logInfo(`lease: held ${this.held.id} unreadable (${(e as Error).message}) — replacing it`);
        }
      } else {
        logInfo(`lease: held ${this.held.id} is state=${this.held.state || 'default'}, want ${state || 'default'} — replacing it`);
      }
      await this.release().catch(() => {});
    }
    return this.acquire(state);
  }

  private async acquire(state: string): Promise<AvdInfo> {
    const body: Record<string, unknown> = { agent: LEASE_AGENT, capability: LEASE_CAPABILITY };
    if (state) body.params = { state };
    const turnId = process.env.CANOPY_TURN_ID;
    if (turnId) body.turn_id = turnId;

    const startedAt = this.now();
    const created = await this.request<LeaseOut>('POST', routePath('acquire'), body);
    if (!created?.lease_id) {
      throw new MobileError('LEASE_BAD_RESPONSE', `acquire returned no lease_id: ${JSON.stringify(created)}`);
    }
    const id = created.lease_id;
    this.installExitHook();
    // Hold it immediately so a failure below can still release it.
    this.held = {
      id,
      state,
      instanceId: created.instance_id ?? null,
      outPrefix: outPrefixOf(created),
      info: { name: state || 'lease', serial: `lease:${id}`, status: 'booting' },
    };
    logInfo(
      `lease: acquired ${id} (${created.status}${created.position != null ? `, queue position ${created.position}` : ''}) ` +
        `for ${LEASE_AGENT}/${LEASE_CAPABILITY} state=${state || 'default'}${turnId ? ` turn=${turnId}` : ''}`,
    );

    try {
      await this.waitReady(id, created, startedAt);
      return this.held.info;
    } catch (e) {
      // Never leave a machine (or a queue slot) behind a failed acquire.
      await this.release().catch(() => {});
      throw e;
    }
  }

  private async waitReady(id: string, first: LeaseOut, startedAt: number): Promise<LeaseOut> {
    let lease = first;
    let lastStatus = '';
    let lastPosition: number | null | undefined;
    let provisioningSince: number | null = null;
    let queuedS = 0;
    let readyTimeoutS: number | null = null;

    for (;;) {
      if (!this.held || this.held.id !== id) {
        throw new MobileError('LEASE_LOST', `lease ${id} was released while waiting for it to become ready`);
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
      if (lease.out_prefix || lease.bucket) this.held!.outPrefix = outPrefixOf(lease) ?? this.held!.outPrefix;
      if (lease.instance_id) this.held!.instanceId = lease.instance_id;

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
          ...(marker?.timings ?? {}),
        };
        this.held!.info = {
          name: this.held!.state || 'lease',
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
          'Re-run mobile_ensure_avd_running to acquire a fresh machine.',
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
      await this.sleep(this.pollIntervalMs);
      lease = await this.getLease(id);
    }
  }

  private readinessFailed(id: string, lease: LeaseOut, reason?: string): MobileError {
    const why = reason || lease.reason || 'no reason given';
    return new MobileError(
      'LEASE_READINESS_FAILED',
      `lease ${id} failed readiness on instance ${lease.instance_id ?? '?'}: ${why}`,
      'The machine is released. Re-run mobile_ensure_avd_running for a fresh one; if it fails the same way, ' +
        'the image is the defect — see infra/capabilities/android-emulator/README.md (bake.sh).',
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
      if (e instanceof MobileError && e.code === 'LEASE_NOT_FOUND') return;
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
   * reports that and returns — it never acquires a machine to look at.
   */
  async diagnose(): Promise<LeaseDiagnostics> {
    if (!this.held) {
      return { lease: null, note: 'no lease held by this MCP process — mobile_ensure_avd_running acquires one' };
    }
    const lease = await this.getLease(this.held.id);
    const leaseView = {
      lease_id: this.held.id,
      status: String(lease.status),
      instance_id: lease.instance_id ?? this.held.instanceId,
      expires_at: lease.expires_at ?? null,
    };
    if (lease.status !== 'ready') return { lease: leaseView };
    const { json } = await this.runCli('diagnose', {});
    return { ...json, lease: leaseView };
  }

  // ── APK ─────────────────────────────────────────────────────────

  /** Install an APK: a local path is uploaded first; an https:// or s3:// URI is passed through. */
  async installApk(_avdName: string, apk: string): Promise<ApkInfo> {
    let uri = apk;
    if (!/^(https?|s3):\/\//.test(apk)) {
      let bytes: Buffer;
      try {
        bytes = await fs.readFile(apk);
      } catch (e) {
        throw new MobileError('LEASE_APK_UNREADABLE', `cannot read APK ${apk}: ${(e as Error).message}`);
      }
      [uri] = await this.upload([{ name: path.basename(apk), bytes }]);
    }
    const { json } = await this.runCli('installApk', { apk: uri });
    return {
      packageId: String(json.package_name ?? json.package ?? ''),
      versionName: String(json.version ?? json.version_name ?? ''),
      versionCode: Number(json.version_code ?? 0),
      path: apk,
    };
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
    const [palette, credsUri] = await this.upload([
      { name: `${tag}--palette.tar.gz`, bytes: Buffer.from(args.paletteTarB64, 'base64') },
      { name: `${tag}--creds.json`, bytes: Buffer.from(JSON.stringify(creds), 'utf8') },
    ]);
    const { json } = await this.runCli('registerTestUser', {
      palette,
      toOtpRecipe: args.toOtpRecipe,
      fromOtpRecipe: args.fromOtpRecipe,
      creds: credsUri,
    });
    const backup = json.backup_code;
    return {
      alreadyRegistered: Boolean(json.already_registered),
      phone: String(json.phone ?? args.phone),
      ...(typeof backup === 'string' && backup ? { backupCode: backup } : {}),
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

  // ── UI dump ─────────────────────────────────────────────────────

  async captureUiDump(_avdName: string): Promise<UiDumpResult> {
    // The dump comes back inline. SSM caps inline stdout at 24,000 chars, so a
    // large screen can truncate it — then the full stdout (stdout_url) is read.
    const { json } = await this.runCli('uiDump', {});
    const xml = typeof json.xml === 'string' ? json.xml : '';
    const elements = Array.isArray(json.elements)
      ? (json.elements as UiDumpResult['elements'])
      : parseUiHierarchy(xml);
    return { xml, elements, ...(json.failed === true || !xml ? { failed: true } : {}) };
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
   * Run a Maestro recipe on the leased emulator. The recipe and the resolved
   * palette are uploaded, the CLI runs them with `--out` under this lease's
   * out prefix, and every artifact it wrote is downloaded into
   * `screenshotDir` — the on-disk shape MaestroBackend produces.
   * `opts.state` is accepted for surface parity and ignored: the state is
   * fixed when the lease is acquired.
   */
  async runRecipe(
    recipePath: string,
    env: Record<string, string>,
    screenshotDir: string,
    opts: { state?: string; screenshotPrefix?: string; paletteTarB64?: string } = {},
  ): Promise<RecipeRunResult> {
    let recipeBytes: Buffer;
    try {
      recipeBytes = await fs.readFile(recipePath);
    } catch (e: unknown) {
      throw new RecipeValidationError(recipePath, `failed to read recipe: ${(e as Error).message}`);
    }
    const tag = slug(opts.screenshotPrefix ?? path.basename(recipePath, path.extname(recipePath)));
    const files = [{ name: `${tag}--${path.basename(recipePath)}`, bytes: recipeBytes }];
    if (opts.paletteTarB64) files.push({ name: `${tag}--palette.tar.gz`, bytes: Buffer.from(opts.paletteTarB64, 'base64') });
    const [recipe, palette] = await this.upload(files);

    const { json, exec, outRel } = await this.runCli('runRecipe', {
      recipe,
      palette,
      env: Object.entries(env ?? {}).map(([k, v]) => `${k}=${v}`),
    });

    const exitCode = typeof json.exit_code === 'number' ? json.exit_code : (exec.exit_code ?? 1);
    const stdout = typeof json.stdout === 'string' ? json.stdout : (exec.stdout_tail ?? '');
    const stderr = typeof json.stderr === 'string' ? json.stderr : '';

    // Saved by BASENAME (`key.rsplit('/', 1)[-1]`), the layout the retired
    // ace-web backend used, so callers find the same files in the same places.
    const rows = await this.listArtifacts(outRel);
    const screenshots = await materializeArtifacts(
      rows.map((r) => {
        const name = r.relPath.split('/').pop() ?? r.relPath;
        return { name, url: r.url, contentType: r.contentType ?? contentTypeFor(name) };
      }),
      screenshotDir,
      (url, dest) => downloadToFile(this.fetchImpl, url, dest, this.retryConfig, 'LEASE_DOWNLOAD_FAILED'),
      'lease',
    );

    const status: RecipeRunResult['status'] = exitCode === 0 ? 'pass' : 'fail';
    let diagnostics: Record<string, unknown> | undefined;
    if (status === 'fail') {
      try {
        diagnostics = (await this.runCli('diagnose', {})).json;
      } catch {
        // A diagnose failure must not mask the recipe result.
      }
    }
    const steps = Array.isArray(json.steps)
      ? (json.steps as Parameters<typeof normalizeRemoteStep>[0][]).map(normalizeRemoteStep)
      : undefined;
    return {
      status,
      exitCode,
      stdout,
      stderr,
      screenshotsDir: screenshotDir,
      screenshots,
      steps,
      diagnostics,
      failure: classifyMaestroFailure({ stderr, stdout, exitCode }),
    };
  }

  // ── CLI exec plumbing ───────────────────────────────────────────

  private requireLease(op: string): HeldLease {
    if (!this.held) {
      throw new MobileError(
        'LEASE_NOT_ACQUIRED',
        `${op}: this MCP process holds no android-emulator lease`,
        'Call mobile_ensure_avd_running first — it acquires the machine and waits until it is ready.',
      );
    }
    return this.held;
  }

  /**
   * One CLI call: exec with `--out` under the lease's out prefix, poll to
   * terminal (heartbeating the lease), parse the CLI's JSON line.
   *
   * `recipeResult`: run-recipe reports a Maestro failure as data (`exit_code`
   * in its JSON), not as a CLI error, so a JSON line carrying `exit_code` is
   * returned even when the command itself exited non-zero.
   */
  private async runCli<N extends CliOpName>(
    op: N,
    values: CliValues<N>,
  ): Promise<{ json: CliResult; exec: ExecStatusOut; outRel: string }> {
    const held = this.requireLease(op);
    const spec: CliOp = CLI[op];
    let outRel = '';
    let argvValues: Record<string, unknown> = { ...values };
    if (spec.sendsOut) {
      // Only ops that read artifacts back get `--out` (argparse refuses it on most).
      outRel = `${slug(spec.sub.join('-'))}/`;
      argvValues = { ...argvValues, out: `${await this.outPrefix(held)}${outRel}` };
    }
    const argv = cliArgv(op, argvValues as CliValues<N>);

    const { exec_id } = await this.request<ExecOut>(
      'POST',
      routePath('exec', { lease_id: held.id }),
      { argv, timeout_s: spec.timeoutS },
    );
    if (!exec_id) throw new MobileError('LEASE_BAD_RESPONSE', `exec ${spec.sub.join(' ')} returned no exec_id`);

    const deadline = this.now() + (spec.timeoutS + 120) * 1000;
    let lastBeat = this.now();
    let exec: ExecStatusOut;
    for (;;) {
      exec = await this.request<ExecStatusOut>(
        'GET',
        routePath('execStatus', { lease_id: held.id, exec_id }),
      );
      if (execIsTerminal(exec)) break;
      if (this.now() > deadline) {
        throw new MobileError(
          'LEASE_EXEC_TIMEOUT',
          `${spec.sub.join(' ')} (exec ${exec_id}) still ${exec.status} after ${spec.timeoutS + 120}s`,
          'The machine may be wedged: mobile_stop_avd, then mobile_ensure_avd_running for a fresh one.',
        );
      }
      if (this.now() - lastBeat >= this.heartbeatMs) {
        lastBeat = this.now();
        await this.heartbeat(held.id);
      }
      await this.sleep(this.pollIntervalMs);
    }

    let json = parseCliJson(exec.stdout_tail);
    // SSM inlines only the first 24,000 chars of stdout, so a long result line
    // can be cut: read the full stdout, then (run-recipe) its result.json.
    if (!json && exec.stdout_url) json = parseCliJson(await this.fetchText(exec.stdout_url).catch(() => ''));
    if (!json && outRel) {
      const hit = (await this.listArtifacts(outRel).catch(() => [])).find((r) => r.relPath === 'result.json');
      if (hit) json = parseCliJson((await this.fetchText(hit.url).catch(() => '')).replace(/\n/g, ' '));
    }
    const cmd = spec.sub.join(' ');
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
    if (json.ok === false && !(spec.dataErrors ?? []).includes(String(json.error))) {
      const code = String(json.error ?? 'internal');
      const base = String(json.message ?? `ace-mobile ${cmd} failed`);
      const diagnostics =
        json.diagnostics && typeof json.diagnostics === 'object'
          ? (json.diagnostics as Record<string, unknown>)
          : undefined;
      const message = diagnostics ? `${base}\n\nIn-VM diagnostics:\n${formatDiagnostics(diagnostics)}` : base;
      if (code === 'boot-timeout') throw new AvdBootError('lease', message);
      throw new MobileError(
        `LEASE_CLI_${code.toUpperCase().replace(/-/g, '_')}`,
        `ace-mobile ${cmd}: ${message}`,
        code === 'usage'
          ? `The CLI baked into the image${json.cli_version ? ` (${json.cli_version})` : ''} rejected argv ` +
              'that mcp/mobile/backends/lease-contract.ts produced — the contract has drifted; rebake or update it.'
          : undefined,
        diagnostics,
      );
    }
    return { json, exec, outRel };
  }

  private async heartbeat(id: string): Promise<void> {
    const lease = await this.getLease(id);
    if (lease.status !== 'ready') {
      throw new MobileError(
        'LEASE_LOST',
        `lease ${id} is ${lease.status} mid-operation${lease.reason ? `: ${lease.reason}` : ''}`,
        'Re-run mobile_ensure_avd_running to acquire a fresh machine, then repeat the step.',
      );
    }
  }

  private async getLease(id: string): Promise<LeaseOut> {
    return this.request<LeaseOut>('GET', routePath('get', { lease_id: id }));
  }

  /**
   * The S3 prefix every `--out` must sit under. The broker states it
   * (`out_prefix`), or names the bucket; failing both, it is derived from an
   * uploads presign (`…/leases/<id>/in/<name>` → `…/leases/<id>/out/`).
   */
  private async outPrefix(held: HeldLease): Promise<string> {
    if (held.outPrefix) return held.outPrefix;
    const lease = await this.getLease(held.id);
    let prefix = outPrefixOf(lease);
    if (!prefix) {
      const [slot] = await this.presign(['.out-prefix-probe']);
      if (slot) prefix = outPrefixFromUpload(slot.uri);
    }
    if (!prefix) {
      throw new MobileError(
        'LEASE_BAD_RESPONSE',
        `cannot resolve the out prefix for lease ${held.id}: the broker returned no out_prefix or bucket`,
      );
    }
    held.outPrefix = prefix;
    return prefix;
  }

  private async presign(names: string[]): Promise<UploadSlot[]> {
    const held = this.requireLease('upload');
    const body = await this.request<unknown>('POST', routePath('uploads', { lease_id: held.id }), { names });
    return normalizeUploads(body);
  }

  /** PUT each file to its presigned URL; returns the s3:// URIs, in order. */
  private async upload(files: Array<{ name: string; bytes: Buffer }>): Promise<string[]> {
    const slots = await this.presign(files.map((f) => f.name));
    if (this.held && !this.held.outPrefix && slots[0]) this.held.outPrefix = outPrefixFromUpload(slots[0].uri);
    const uris: string[] = [];
    for (const f of files) {
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
      uris.push(slot.uri);
    }
    return uris;
  }

  private async listArtifacts(outRel: string) {
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

  private resolveState(avdName: string): string {
    if (avdName?.startsWith('cc-')) return avdName;
    return this.defaultState;
  }

  // ── HTTP ────────────────────────────────────────────────────────

  private async request<T>(method: string, routePathStr: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${routePathStr}`;
    const headers = new Headers({ authorization: `Bearer ${this.token}`, accept: 'application/json' });
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(this.requestTimeoutMs) };
    if (body !== undefined) {
      headers.set('content-type', 'application/json');
      init.body = JSON.stringify(body);
    }
    // POST /leases is idempotent server-side only via ClientToken=lease_id,
    // which the broker mints — so an acquire is NOT retried on a gateway 5xx:
    // a retry could queue a second lease. Everything else is safe to retry.
    const retry = method === 'POST' && routePathStr === routePath('acquire')
      ? { ...this.retryConfig, retries: 0 }
      : this.retryConfig;
    const { response, lastError, attempts } = await fetchWithRetry(this.fetchImpl, url, init, retry);
    if (!response) {
      throw new MobileError(
        'LEASE_FETCH_FAILED',
        `${method} ${url} failed after ${attempts} attempt(s): ${(lastError as Error)?.message ?? 'unknown error'}`,
        'Check network reachability of canopy-web (CANOPY_WEB_API_URL) and run /ace:doctor (capability_lease).',
      );
    }
    const text = await response.text();
    let payload: unknown = undefined;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        throw new MobileError('LEASE_BAD_RESPONSE', `non-JSON response from ${method} ${url} (status ${response.status})`);
      }
    }
    if (!response.ok) throw leaseHttpError(response.status, (payload ?? {}) as Problem, method, routePathStr);
    return payload as T;
  }
}

/** Typed errors for the broker's failure statuses (spec §3/§4). */
export function leaseHttpError(status: number, problem: Problem, method: string, route: string): MobileError {
  // canopy-web's bare HttpError puts the same text in title and detail.
  const said = [...new Set([problem.title, problem.detail].filter(Boolean))].join(' — ');
  const where = `${method} ${route.split('?')[0]}`;
  const path = route.split('?')[0];
  const isLeaseRoute = /^\/api\/capabilities\/leases\/[^/]+/.test(path);
  switch (status) {
    case 401:
      return new MobileError(
        'LEASE_AUTH',
        `canopy-web rejected ACE's PAT on ${where}${said ? `: ${said}` : ''}`,
        "Re-mint ACE's canopy-web PAT (1Password Agent-Ace/canopy-pat) and run /ace:setup --force-env.",
      );
    case 403:
      // canopy-web answers 403 for two different things: no CapabilityGrant
      // ("… has no grant for capability …"), and a caller below the editor
      // role ("leasing ace's capabilities needs the editor role …").
      if (/editor role|own login/i.test(said)) {
        return new MobileError(
          'LEASE_FORBIDDEN',
          `${where}: this PAT may not lease ${LEASE_AGENT}'s capabilities${said ? `: ${said}` : ''}`,
          "Use ACE's own PAT (CANOPY_WEB_PAT in ACE's .env), or a member PAT with the editor role in ACE's workspace.",
        );
      }
      return new MobileError(
        'LEASE_NO_GRANT',
        `no capability grant lets ${LEASE_AGENT} lease ${LEASE_CAPABILITY}${said ? `: ${said}` : ''}`,
        `A workspace admin must grant agent "${LEASE_AGENT}" the "${LEASE_CAPABILITY}" capability in ACE's ` +
          'canopy-web workspace (PUT /api/capabilities/grants). /ace:doctor capability_lease shows the grant state.',
      );
    case 404:
      return isLeaseRoute
        ? new MobileError(
            'LEASE_NOT_FOUND',
            `${where}: not found${said ? ` (${said})` : ''}`,
            'The lease is gone (released, expired or swept). Re-run mobile_ensure_avd_running.',
          )
        : new MobileError(
            'LEASE_AGENT_NOT_VISIBLE',
            `${where}: ${said || 'not found'}`,
            `canopy-web hides agent "${LEASE_AGENT}" from this PAT, or predates the capability broker — ` +
              'run /ace:doctor (capability_lease).',
          );
    case 409:
      return new MobileError(
        'LEASE_LOST',
        `${where}: ${said || 'the lease is not ready'}`,
        'Re-run mobile_ensure_avd_running to acquire a fresh machine, then repeat the step.',
      );
    case 422: {
      const validation = problem.extras && 'errors' in problem.extras;
      if (!validation && /declares no capability|is not brokered/.test(said)) {
        return new MobileError(
          'LEASE_UNDECLARED',
          `${LEASE_AGENT} has not declared ${LEASE_CAPABILITY} on canopy-web${said ? `: ${said}` : ''}`,
          'Publish the manifest: infra/capabilities/android-emulator/deploy.sh (runs canopy-runtime publish-capabilities).',
        );
      }
      return new MobileError(
        'LEASE_INVALID_REQUEST',
        `${where}: ${said || 'request refused'}` +
          (validation ? `: ${JSON.stringify(problem.extras?.errors)}` : ''),
        'A param outside the manifest (e.g. an unknown state — see mobile_list_avds), a stale CANOPY_TURN_ID, ' +
          'or argv/upload names the broker refuses.',
      );
    }
    default:
      return new MobileError(`LEASE_HTTP_${status}`, `${where} returned ${status}${said ? `: ${said}` : ''}`);
  }
}

/** `s3://b/leases/<id>/in/<name>` → `s3://b/leases/<id>/out/` (canopy-web's layout). */
function outPrefixFromUpload(uri: string): string | null {
  const m = uri.match(/^(s3:\/\/.+\/leases\/[^/]+\/)in\//);
  return m ? `${m[1]}out/` : null;
}

function outPrefixOf(lease: LeaseOut): string | null {
  if (lease.out_prefix) return lease.out_prefix.endsWith('/') ? lease.out_prefix : `${lease.out_prefix}/`;
  if (lease.bucket) return `s3://${lease.bucket}/leases/${lease.lease_id}/out/`;
  return null;
}

/** A short unique, path-safe tag: `<base>-<time36><rand>`. */
function slug(base: string): string {
  const clean = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'op';
  return `${clean}-${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
}

/**
 * Exit-time release. `'exit'` listeners must be synchronous, so this blocks
 * on curl for at most a few seconds. The PAT goes on stdin (`-H @-`), never
 * argv, where any local process could read it (ace#1114).
 */
function curlDeleteSync(url: string, token: string): void {
  spawnSync('curl', ['-sS', '-o', '/dev/null', '--max-time', '5', '-X', 'DELETE', '-H', '@-', url], {
    input: `Authorization: Bearer ${token}\n`,
    timeout: 7_000,
    stdio: ['pipe', 'ignore', 'ignore'],
  });
}
