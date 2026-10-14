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
  get: { method: 'GET', path: '/api/capabilities/leases/{lease_id}' },
  release: { method: 'DELETE', path: '/api/capabilities/leases/{lease_id}' },
  exec: { method: 'POST', path: '/api/capabilities/leases/{lease_id}/exec' },
  execStatus: { method: 'GET', path: '/api/capabilities/leases/{lease_id}/exec/{exec_id}' },
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
   * NOT returned by canopy-web today: the lease's `s3://…/leases/<id>/out/`.
   * Read if a later broker adds it; otherwise lease.ts derives it from an
   * upload's `s3_uri` (`…/in/<name>` → `…/out/`).
   */
  out_prefix?: string | null;
  bucket?: string | null;
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
}

// Pinned against infra/capabilities/android-emulator/image/cli/ace_mobile.py
// `build_parser()`. Only run-recipe, register-test-user and ui-dump take
// `--out`; argparse rejects an undeclared flag as a usage error, so a flag
// here that the CLI lacks fails every call (lease-contract.test.ts).
export const CLI = {
  diagnose: { sub: ['diagnose'], flags: {}, timeoutS: 120 },
  runRecipe: {
    sub: ['run-recipe'],
    flags: { recipe: '--recipe', palette: '--palette', env: '--env', out: '--out', timeoutS: '--timeout-s' },
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
