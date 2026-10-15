// THE contract between ACE's lease backend and the two systems it drives:
//
//   1. canopy-web's capability broker (`apps/capabilities/`) — the routes and
//      the JSON they return. Spec: canopy-web
//      docs/superpowers/specs/2026-10-14-cloud-capabilities-design.md § 4.
//   2. the in-VM `ace-mobile` CLI (infra/capabilities/android-emulator/) —
//      its subcommands, their flags, and the one JSON line each prints.
//
// Every route string and every CLI subcommand/flag `lease.ts` sends lives in
// this file and nowhere else, so a contract change on either side is a
// one-file edit here. `test/mcp/mobile/backends/lease-contract.test.ts` pins
// this file against canopy-web's openapi and against the CLI's own parser.
//
// Response normalisers live here too: where the broker's exact JSON is not
// yet pinned, the tolerance belongs next to the route that returns it, not
// scattered through the backend.

export const LEASE_AGENT = 'ace';
export const LEASE_CAPABILITY = 'android-emulator';
/**
 * The Connect test-worker pool (ace#2955): a `kind: pool` capability whose
 * slots are named workers, not machines. A lease is an exclusive checkout of
 * one worker; `ready_info.slot` (or `params.slot`) names which. Manifest:
 * infra/capabilities/test-worker/capability.yaml.
 */
export const TEST_WORKER_CAPABILITY = 'test-worker';

// ── canopy-web broker routes ─────────────────────────────────────────

export interface LeaseRoute {
  method: 'GET' | 'POST' | 'DELETE' | 'PUT';
  /** OpenAPI-style template; `{name}` placeholders are filled by `routePath`. */
  path: string;
  /** Query parameters this client may send. */
  query?: readonly string[];
}

export const LEASE_ROUTES = {
  acquire: { method: 'POST', path: '/api/capabilities/leases' },
  // Leases in ACE's workspaces, newest first. A read: no heartbeat. Used to
  // name who holds the test-worker slots when the pool is exhausted.
  list: { method: 'GET', path: '/api/capabilities/leases', query: ['agent', 'capability', 'status', 'limit'] },
  // `wait_s` long-polls (the broker holds the GET up to that many seconds,
  // ≤ 20, returning early on a change). A broker that predates it ignores
  // the param and answers at once; lease.ts polls adaptively, so both work.
  get: { method: 'GET', path: '/api/capabilities/leases/{lease_id}', query: ['wait_s'] },
  release: { method: 'DELETE', path: '/api/capabilities/leases/{lease_id}' },
  exec: { method: 'POST', path: '/api/capabilities/leases/{lease_id}/exec' },
  execStatus: { method: 'GET', path: '/api/capabilities/leases/{lease_id}/exec/{exec_id}', query: ['wait_s'] },
  uploads: { method: 'POST', path: '/api/capabilities/leases/{lease_id}/uploads' },
  artifacts: { method: 'GET', path: '/api/capabilities/leases/{lease_id}/artifacts', query: ['prefix'] },
  agentCapabilities: { method: 'GET', path: '/api/agents/{slug}/capabilities' },
} as const satisfies Record<string, LeaseRoute>;

export type LeaseRouteName = keyof typeof LEASE_ROUTES;

/** Fill a route template; every placeholder must be supplied. */
export function routePath(
  name: LeaseRouteName,
  params: Record<string, string> = {},
  query: Record<string, string | undefined> = {},
): string {
  const route: LeaseRoute = LEASE_ROUTES[name];
  const p = route.path.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = params[k];
    if (v === undefined || v === '') throw new Error(`routePath(${name}): missing {${k}}`);
    return encodeURIComponent(v);
  });
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    if (!route.query?.includes(k)) throw new Error(`routePath(${name}): ?${k} is not in the contract`);
    qs.set(k, v);
  }
  const q = qs.toString();
  return q ? `${p}?${q}` : p;
}

// ── broker JSON ──────────────────────────────────────────────────────

/** `queued → provisioning → ready → released`, failure exits `failed` / `expired`. */
export type LeaseStatus = 'queued' | 'provisioning' | 'ready' | 'released' | 'failed' | 'expired';

/** `ready.json` the image writes at `s3://<bucket>/vm/<instance-id>/ready.json`. */
export interface ReadyMarker {
  ok: boolean;
  reason?: string;
  timings?: Record<string, number>;
  cli_version?: string;
  accel?: string;
  /** The state the machine actually booted (`cc-<version>`). Asserted against the request. */
  state?: string;
  instance_id?: string;
  /**
   * Fingerprint of the environment baseline the image applied at boot
   * (`mcp/mobile/environment-baseline.ts` computes the same function), or
   * absent from an image that applies none. Read through `readyBaseline`.
   */
  baseline_fingerprint?: string;
  baseline?: {
    fingerprint?: string;
    keys?: string[];
    /** False when a baseline step failed at boot (`failed` names the keys). */
    complete?: boolean;
    failed?: string[];
    clock_synced?: boolean;
  } | null;
  /** Which boot path ran (`snapshot` | `cold` | `cold-fallback`), as a string or `{path, detail}`. */
  boot_path?: unknown;
}

/** The baseline fingerprint a ready marker reports, whichever shape the image used. */
export function readyBaseline(marker: Partial<ReadyMarker> | null | undefined): string | null {
  if (!marker) return null;
  if (typeof marker.baseline_fingerprint === 'string' && marker.baseline_fingerprint) return marker.baseline_fingerprint;
  const b = marker.baseline;
  if (b && typeof b === 'object' && typeof b.fingerprint === 'string' && b.fingerprint) return b.fingerprint;
  return null;
}

/**
 * Whether the boot-time baseline completed. `false` only when the image says
 * a step failed (`baseline.complete === false`, or a non-empty `failed`);
 * null when it reports no baseline object at all.
 */
export function readyBaselineComplete(marker: Partial<ReadyMarker> | null | undefined): boolean | null {
  const b = marker?.baseline;
  if (!b || typeof b !== 'object') return null;
  if (b.complete === false) return false;
  if (Array.isArray(b.failed) && b.failed.length > 0) return false;
  return true;
}

/** The keys a ready marker says failed at boot (empty when none / unreported). */
export function readyBaselineFailed(marker: Partial<ReadyMarker> | null | undefined): string[] {
  const b = marker?.baseline;
  return b && typeof b === 'object' && Array.isArray(b.failed) ? b.failed.map(String) : [];
}

/**
 * The boot path ready.json names — `snapshot`, `cold`, `cold-fallback` — read
 * tolerantly: a bare string, `{path}`, `{boot_path}`, `{mode}`, or the CLI's
 * `{raw: "path=…"}` for an unparseable file. Null when absent.
 */
export function readyBootPath(marker: Partial<ReadyMarker> | null | undefined): string | null {
  const v = marker?.boot_path;
  if (typeof v === 'string') return v.trim() || null;
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  for (const k of ['path', 'boot_path', 'mode']) {
    if (typeof o[k] === 'string' && o[k]) return o[k] as string;
  }
  if (typeof o.raw === 'string') {
    const m = o.raw.match(/(?:^|\s)(?:path|boot_path)=(\S+)/);
    return m ? m[1] : o.raw.trim().split(/\s+/)[0] || null;
  }
  return null;
}

/**
 * Boot timings from a ready marker: its `timings` object, plus any numeric
 * top-level `*_s` field an image reports outside it. Non-numbers are dropped.
 */
export function readyTimings(marker: Partial<ReadyMarker> | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!marker) return out;
  for (const [k, v] of Object.entries(marker as Record<string, unknown>)) {
    if (/_s$/.test(k) && typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  const t = marker.timings;
  if (t && typeof t === 'object') {
    for (const [k, v] of Object.entries(t)) if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/** canopy-web `CapabilityLeaseOut` (apps/capabilities/schemas.py), the fields this client reads. */
export interface LeaseOut {
  lease_id: string;
  status: LeaseStatus | string;
  /** True iff status == "ready". */
  ready?: boolean | null;
  /** 1-based FIFO position while `queued`, else null. */
  position?: number | null;
  instance_id?: string | null;
  expires_at?: string | null;
  /** Seconds without a heartbeat before the broker releases the lease. */
  idle_release_s?: number | null;
  /** Why it ended, or why its launch is being retried ('' when nothing to say). */
  reason?: string | null;
  /** The machine's ready.json once read: {ok, reason?, timings?, cli_version?}; {} before. */
  ready_info?: Partial<ReadyMarker> | null;
  /**
   * Where the machine writes artifacts (`CANOPY_LEASE_OUT`), as the broker
   * states it. The ONLY source of the `--out` prefix: the broker owns the S3
   * layout (it moved to per-instance prefixes), so a client that builds
   * `leases/<id>/…` paths itself writes where the machine may not.
   */
  out_prefix?: string | null;
  params?: Record<string, unknown> | null;
}

/**
 * The pool slot a test-worker lease holds: `ready_info.slot`, else
 * `params.slot` (the broker writes both once a slot is assigned). Null while
 * queued, or for a non-pool lease.
 */
export function leaseSlot(lease: Pick<LeaseOut, 'ready_info' | 'params'> | null | undefined): string | null {
  const info = lease?.ready_info as Record<string, unknown> | null | undefined;
  if (info && typeof info === 'object' && typeof info.slot === 'string' && info.slot) return info.slot;
  const params = lease?.params;
  if (params && typeof params === 'object' && typeof params.slot === 'string' && params.slot) return params.slot;
  return null;
}

/** One row of `GET /api/capabilities/leases`, the fields a holder report needs. */
export interface LeaseListRow {
  lease_id: string;
  status: string;
  slot: string | null;
  /** Who holds it, as the broker states it (turn, session, runner, creator…); null when it says nothing. */
  holder: string | null;
  created_at: string | null;
}

/** Accepts `{leases:[…]}`, `{items:[…]}` or a bare list. Holder fields are read tolerantly. */
export function normalizeLeaseList(body: unknown): LeaseListRow[] {
  const rows: unknown[] = Array.isArray(body)
    ? body
    : body && typeof body === 'object'
      ? ((body as { leases?: unknown[] }).leases ?? (body as { items?: unknown[] }).items ?? [])
      : [];
  const out: LeaseListRow[] = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const id = String(o.lease_id ?? o.id ?? '');
    if (!id) continue;
    const parts: string[] = [];
    for (const k of ['holder', 'requested_by', 'created_by', 'user', 'turn_id', 'session_id', 'runner']) {
      const v = o[k];
      if (typeof v === 'string' && v) parts.push(`${k}=${v}`);
      else if (v && typeof v === 'object') {
        const n = (v as Record<string, unknown>).email ?? (v as Record<string, unknown>).name ?? (v as Record<string, unknown>).slug;
        if (typeof n === 'string' && n) parts.push(`${k}=${n}`);
      }
    }
    out.push({
      lease_id: id,
      status: String(o.status ?? ''),
      slot: leaseSlot(o as Pick<LeaseOut, 'ready_info' | 'params'>),
      holder: parts.length ? parts.join(' ') : null,
      created_at: typeof o.created_at === 'string' ? o.created_at : null,
    });
  }
  return out;
}

/** The ready marker once the broker has read it, else null. */
export function readyMarker(lease: LeaseOut): ReadyMarker | null {
  const info = lease.ready_info;
  if (info && typeof info === 'object' && typeof info.ok === 'boolean') return info as ReadyMarker;
  return null;
}

export interface ExecOut {
  exec_id: string;
}

/**
 * `GetCommandInvocation`, as the broker relays it. `status` is SSM's
 * vocabulary (Pending | InProgress | Delayed | Success | Cancelled |
 * TimedOut | Failed | Cancelling); compare case-insensitively.
 */
export interface ExecStatusOut {
  status: string;
  // NB: the broker keeps only the LAST 4,000 chars of each stream inline
  // (`STDOUT_TAIL`), so a long JSON line arrives with its head cut off and
  // the full stream must be read from `stdout_url`.
  /** The broker's own terminal flag. */
  done?: boolean | null;
  exit_code?: number | null;
  stdout_tail?: string | null;
  stderr_tail?: string | null;
  /** Presigned GETs of the full streams (1 h), once done. */
  stdout_url?: string | null;
  stderr_url?: string | null;
}

const EXEC_TERMINAL = new Set(['success', 'failed', 'timedout', 'cancelled']);
export function execIsTerminal(exec: Pick<ExecStatusOut, 'status' | 'done'>): boolean {
  if (typeof exec.done === 'boolean') return exec.done;
  return EXEC_TERMINAL.has(String(exec.status).toLowerCase().replace(/[^a-z]/g, ''));
}

export interface UploadSlot {
  name: string;
  /** Presigned PUT URL. */
  putUrl: string;
  /** `s3://…/leases/<id>/in/<name>` — what goes in argv. */
  uri: string;
  /** Headers the presign was signed with, if the broker returns any. */
  headers?: Record<string, string>;
}

/** Accepts `{uploads:[…]}`, a bare list, or a `{name: {...}}` map. */
export function normalizeUploads(body: unknown): UploadSlot[] {
  const rows: unknown[] = Array.isArray(body)
    ? body
    : body && typeof body === 'object'
      ? Array.isArray((body as { uploads?: unknown }).uploads)
        ? ((body as { uploads: unknown[] }).uploads)
        : Object.entries(body as Record<string, unknown>).map(([name, v]) =>
            v && typeof v === 'object' ? { name, ...(v as object) } : { name },
          )
      : [];
  const out: UploadSlot[] = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const name = String(o.name ?? '');
    const putUrl = String(o.put_url ?? o.url ?? o.presigned_url ?? '');
    const uri = String(o.uri ?? o.s3_uri ?? '');
    if (!name || !putUrl || !uri) continue;
    const headers = o.headers && typeof o.headers === 'object' ? (o.headers as Record<string, string>) : undefined;
    out.push({ name, putUrl, uri, ...(headers ? { headers } : {}) });
  }
  return out;
}

export interface ArtifactRow {
  /** Path relative to the requested prefix (may contain `/` for nested files). */
  relPath: string;
  url: string;
  contentType?: string;
}

/** Accepts `{artifacts:[…]}`, `{items:[…]}` or a bare list; strips `prefix`. */
export function normalizeArtifacts(body: unknown, prefix: string): ArtifactRow[] {
  const rows: unknown[] = Array.isArray(body)
    ? body
    : body && typeof body === 'object'
      ? ((body as { artifacts?: unknown[] }).artifacts ?? (body as { items?: unknown[] }).items ?? [])
      : [];
  const out: ArtifactRow[] = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    let rel = String(o.name ?? o.key ?? o.path ?? '');
    const url = String(o.url ?? o.presigned_url ?? '');
    if (!rel || !url) continue;
    // Keys may come back absolute (`leases/<id>/out/<prefix>…`) or relative.
    const at = prefix ? rel.indexOf(prefix) : -1;
    if (at >= 0) rel = rel.slice(at + prefix.length);
    rel = rel.replace(/^\/+/, '');
    if (!rel) continue;
    const ct = o.content_type ?? o.contentType;
    out.push({ relPath: rel, url, ...(typeof ct === 'string' ? { contentType: ct } : {}) });
  }
  return out;
}

/** One declared capability, as `GET /api/agents/{slug}/capabilities` reports it. */
export interface DeclaredCapability {
  name: string;
  granted: boolean;
  liveLeases: number;
  readyTimeoutS?: number;
  maxConcurrent?: number;
  /** `params.state.enum` from the manifest. */
  states: string[];
  /** `kind` from the manifest (`ec2-ephemeral`, `pool`, …). */
  kind?: string;
  /** A `pool` manifest's `slots` (the test-worker names); empty otherwise. */
  slots: string[];
  defaultState?: string;
  /** The grant's own text when not granted (who to ask). */
  grantHint?: string;
  /** The CloudFormation stack the broker read at publish. */
  stack?: string;
  /** ec2-ephemeral Outputs the stack is missing (spec §2), when the broker reports stack_outputs. */
  missingOutputs?: string[];
}

/** The Outputs an `ec2-ephemeral` stack must expose (canopy-web spec §2). */
export const REQUIRED_STACK_OUTPUTS = ['LaunchTemplateId', 'ArtifactsBucketName', 'InstanceRoleArn', 'Capability'] as const;

/**
 * Tolerant reader for the agent-capabilities route: `{capabilities:[…]}` or a
 * bare list; each row carries the manifest (inline or under `manifest`), a
 * grant (`grant` object/null or `granted` bool), and live leases (a list or a
 * count).
 */
export function normalizeCapabilities(body: unknown): DeclaredCapability[] {
  const rows: unknown[] = Array.isArray(body)
    ? body
    : body && typeof body === 'object'
      ? ((body as { capabilities?: unknown[] }).capabilities ?? (body as { items?: unknown[] }).items ?? [])
      : [];
  const out: DeclaredCapability[] = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const manifest = (o.manifest && typeof o.manifest === 'object' ? o.manifest : o) as Record<string, unknown>;
    const name = String(o.name ?? manifest.name ?? '');
    if (!name) continue;
    // Top-level `limits` are the manifest's lowered by the grant (what an
    // acquire gets now); fall back to the manifest's own ceilings.
    const limits = (o.limits && typeof o.limits === 'object' ? o.limits : manifest.limits ?? {}) as Record<string, unknown>;
    const params = (manifest.params ?? {}) as Record<string, Record<string, unknown>>;
    const stateParam = params.state ?? {};
    const grant = o.grant;
    const granted =
      typeof o.granted === 'boolean' ? o.granted : grant !== undefined ? Boolean(grant) : false;
    const live = o.live_leases ?? o.leases ?? o.live_lease_count;
    const liveLeases = Array.isArray(live) ? live.length : typeof live === 'number' ? live : 0;
    out.push({
      name,
      granted,
      liveLeases,
      readyTimeoutS: typeof limits.ready_timeout_s === 'number' ? limits.ready_timeout_s : undefined,
      maxConcurrent: typeof limits.max_concurrent === 'number' ? limits.max_concurrent : undefined,
      states: Array.isArray(stateParam.enum) ? stateParam.enum.map(String) : [],
      kind: typeof manifest.kind === 'string' ? manifest.kind : undefined,
      slots: Array.isArray(manifest.slots) ? manifest.slots.map(String) : [],
      defaultState: typeof stateParam.default === 'string' ? stateParam.default : undefined,
      grantHint: typeof o.grant_hint === 'string' ? o.grant_hint : undefined,
      stack: typeof o.stack === 'string' ? o.stack : undefined,
      missingOutputs:
        o.stack_outputs && typeof o.stack_outputs === 'object'
          ? REQUIRED_STACK_OUTPUTS.filter((k) => !(k in (o.stack_outputs as object)))
          : undefined,
    });
  }
  return out;
}

// ── the in-VM ace-mobile CLI ─────────────────────────────────────────

/** argv[0]: the one binary on the capability's exec allowlist. */
export const CLI_BIN = 'ace-mobile';

export interface CliOp {
  /** Subcommand words after the binary, e.g. `['snapshot', 'save']`. */
  sub: readonly string[];
  /** Logical flag name → the literal `--flag` the CLI parses. Only flags the CLI declares. */
  flags: Readonly<Record<string, string>>;
  /** SSM execution timeout to request (the CLI's own per-op timeouts sit inside it). */
  timeoutS: number;
  /**
   * Send `--out <lease out prefix>/<op>-<id>/`. Only where artifacts are read
   * back: ui-dump also declares `--out` but inlines its xml, so it gets none.
   */
  sendsOut?: boolean;
  /**
   * `error` codes this op reports as DATA, not as a failure: the call ran and
   * its JSON is the answer (a Maestro exit, a KO from the emulator console, a
   * dump that could not be taken). Everything else with `ok: false` throws.
   */
  dataErrors?: readonly string[];
  /**
   * A subcommand newer than some baked images. The client tolerates its
   * absence — an older CLI answers `error: usage` (argparse: invalid choice),
   * and the caller falls back — and the contract test pins its flags only
   * once the CLI fixture declares it.
   */
  optional?: boolean;
}

// Pinned against infra/capabilities/android-emulator/image/cli/ace_mobile.py
// `build_parser()` (CLI 1.1.0). Only run-recipe, register-test-user, ui-dump,
// screenshot and record take `--out`; argparse rejects an undeclared flag as a
// usage error, so a flag here that the CLI lacks fails every call
// (lease-contract.test.ts).
export const CLI = {
  diagnose: { sub: ['diagnose'], flags: {}, timeoutS: 120 },
  runRecipe: {
    sub: ['run-recipe'],
    flags: { recipe: '--recipe', palette: '--palette', env: '--env', out: '--out', timeoutS: '--timeout-s' },
    // Fallback only: lease.ts sizes BOTH `--timeout-s` and the exec timeout
    // per chunk from lib/maestro-chunk-timeout.ts, as MaestroBackend does.
    timeoutS: 1900,
    sendsOut: true,
    dataErrors: ['recipe-failed', 'recipe-timeout'],
  },
  registerTestUser: {
    sub: ['register-test-user'],
    // Credentials travel in a `--creds` s3:// JSON, never argv: SSM keeps the
    // command line in its history. The per-field flags exist on the CLI but
    // this client does not use them.
    flags: { palette: '--palette', toOtpRecipe: '--to-otp-recipe', fromOtpRecipe: '--from-otp-recipe', creds: '--creds', out: '--out' },
    timeoutS: 3700,
    sendsOut: true,
  },
  uiDump: { sub: ['ui-dump'], flags: { out: '--out', name: '--name' }, timeoutS: 120, dataErrors: ['ui-dump-failed'] },
  // screencap → `--out`. Failure forensics use it instead of a one-step
  // Maestro recipe: one PNG under its own prefix, no Maestro logs to clobber
  // the failed run's.
  screenshot: { sub: ['screenshot'], flags: { out: '--out', name: '--name' }, timeoutS: 90, sendsOut: true },
  installApk: { sub: ['install-apk'], flags: { apk: '--apk' }, timeoutS: 600 },
  clearAppData: { sub: ['clear-app-data'], flags: { package: '--package' }, timeoutS: 120 },
  repairDriver: { sub: ['repair-driver'], flags: {}, timeoutS: 300 },
  installDriver: { sub: ['install-driver'], flags: {}, timeoutS: 300 },
  snapshotSave: { sub: ['snapshot', 'save'], flags: { name: '--name' }, timeoutS: 300, dataErrors: ['snapshot-save-failed'] },
  snapshotLoad: { sub: ['snapshot', 'load'], flags: { name: '--name' }, timeoutS: 300, dataErrors: ['snapshot-load-failed'] },
  setLocation: {
    sub: ['set-location'],
    flags: { longitude: '--lon', latitude: '--lat', altitude: '--alt', satellites: '--sats' },
    timeoutS: 60,
    dataErrors: ['geo-fix-failed'],
  },
  // The environment baseline the local funnel applies every dispatch
  // (`mcp/mobile/environment-baseline.ts`): the image applies it at boot and
  // reports its fingerprint in ready.json; the client re-applies it over this
  // when the fingerprint does not match. Prints `{ok, fingerprint, keys,
  // complete, failed[], clock_synced, steps[]}`; a step that failed is data
  // (`baseline-failed`), not a throw.
  applyBaseline: {
    sub: ['apply-baseline'],
    flags: {},
    timeoutS: 180,
    dataErrors: ['baseline-failed'],
    optional: true,
  },
  // On-device screen recording around a recipe — the lease twin of
  // `mcp/mobile/screen-recorder.ts` (`screenrecord --time-limit 0`, stopped
  // with SIGINT so the moov atom is written). `record start` returns at once
  // with the recorder running detached on the machine; `record stop` stops it,
  // waits for the file to settle, and uploads `<name>` under `--out`.
  // CLI 1.1.0 (infra/capabilities/android-emulator/README.md § CLI contract):
  //   record start [--name N] [--bit-rate 1M] [--size 540x1140]
  //     → {ok, name, device_path, started_at, bit_rate, size}
  //     errors: record-busy (+recording{name,…}: one at a time), record-start-failed
  //   record stop --out s3://… [--name N]   (--name only CHECKS the one in flight)
  //     → {ok, name, key (N.mp4), uri, content_type, bytes, duration_s, upload_error?}
  //     errors: no-recording, record-pull-failed, s3-upload-failed
  // The image has no ffmpeg: the client remuxes the download (`-c copy +faststart`).
  // `record` is ONE argparse subcommand (positional action start|stop), so
  // both ops share its flag set; each sends only its own.
  recordStart: {
    sub: ['record', 'start'],
    flags: { name: '--name', bitRate: '--bit-rate', size: '--size' },
    timeoutS: 60,
    dataErrors: ['record-busy', 'record-start-failed'],
    optional: true,
  },
  recordStop: {
    sub: ['record', 'stop'],
    flags: { out: '--out', name: '--name' },
    // Stop + settle + upload of up to ~80 MB from the machine to S3.
    timeoutS: 600,
    sendsOut: true,
    dataErrors: ['no-recording', 'record-pull-failed', 's3-upload-failed'],
    optional: true,
  },
} as const satisfies Record<string, CliOp>;

export type CliOpName = keyof typeof CLI;
export type CliValues<N extends CliOpName> = Partial<
  Record<keyof (typeof CLI)[N]['flags'], string | number | readonly string[]>
>;

/**
 * argv for one CLI call. A list value repeats its flag (`--env A=1 --env
 * B=2`); `undefined` drops it. Unknown keys cannot type-check.
 */
export function cliArgv<N extends CliOpName>(op: N, values: CliValues<N>): string[] {
  const spec: CliOp = CLI[op];
  const argv: string[] = [CLI_BIN, ...spec.sub];
  for (const [key, flag] of Object.entries(spec.flags)) {
    const v = (values as Record<string, string | number | readonly string[] | undefined>)[key];
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const item of v) argv.push(flag, String(item));
    else argv.push(flag, String(v));
  }
  return argv;
}

/**
 * Every subcommand prints EXACTLY ONE JSON object on stdout, as one line.
 * Exit 0 when `ok`, 1 when the operation ran and failed, 2 on a usage error.
 * A failure carries `error` (a stable kebab-case code — `usage`, `internal`,
 * `recipe-failed`, …) and `message` (human-readable). Anything else is
 * per-subcommand payload.
 */
export interface CliResult {
  ok?: boolean;
  error?: string;
  message?: string;
  cli_version?: string;
  [k: string]: unknown;
}

/** The last stdout line that parses as a JSON object, or null. */
export function parseCliJson(stdout: string | null | undefined): CliResult | null {
  if (!stdout) return null;
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l.startsWith('{')) continue;
    try {
      const v = JSON.parse(l);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as CliResult;
    } catch {
      /* keep looking */
    }
  }
  return null;
}
