/**
 * The test-worker pool's per-slot data on canopy-web (ace#2955): read the
 * MASKED slot list, store one slot's data, delete it — and classify which
 * declared slots lack data or required keys.
 *
 * Owner directive (Jon, 2026-10-15): every worker's phone, phoneLocal,
 * countryCode, name, PIN and backup code live in canopy-web as per-slot data
 * on ACE's `test-worker` pool capability, each slot carrying its own PIN and
 * backup code. The lease hands the holder its slot's data
 * (lib/test-worker-lease.ts); this module is everything else:
 *
 *   list    GET    /api/agents/ace/capabilities/test-worker/slots
 *           → per slot: public values, secret KEY names, updated_at/by, held.
 *             Never a secret value — which is why /ace:doctor and
 *             mobile_diagnose use it and never the lease.
 *   put     PUT    …/slots/{slot}  {public: {k: v|null}, secret: {k: v|null}}
 *           per-key upsert (null deletes); ACE's own PAT or a workspace admin.
 *   delete  DELETE …/slots/{slot}  (retire); falls back to a PUT nulling every
 *           known key if canopy-web answers 404/405 to the DELETE.
 *
 * Same broker HTTP client as the leases (mcp/mobile/backends/broker-http.ts).
 * Every error that could carry a value we sent is passed through
 * `redactSecrets` first — a validation error that echoes its input must not
 * put a PIN in a log or a tool result.
 */
import { canopyApiBase, canopyToken } from './ace-canopy-pat.js';
import {
  PUBLIC_KEYS,
  SECRET_KEYS,
  compareSlots,
  maskSecretsDeep,
  missingSlotKeys,
  publicIdentityProblems,
  redactSecrets,
} from './test-worker-pool.js';
import { MobileError } from '../mcp/mobile/errors.js';
import { brokerRequest, type BrokerHttpConfig } from '../mcp/mobile/backends/broker-http.js';
import { LEASE_AGENT, TEST_WORKER_CAPABILITY, routePath } from '../mcp/mobile/backends/lease-contract.js';
import { resolveRetry, type RetryOpts } from '../mcp/mobile/backends/remote-io.js';

/** One row of the masked slot list. */
export interface SlotRow {
  slot: string;
  public: Record<string, unknown>;
  /** Names of the secret keys the slot has; never their values. */
  secretKeys: string[];
  updatedAt: string | null;
  updatedBy: string | null;
  /** Whether a live lease holds the slot now; null when canopy-web does not say. */
  held: boolean | null;
}

export interface SlotHttpOpts {
  baseUrl?: string;
  /** omitted → ACE's .env CANOPY_WEB_PAT; null/'' → none. */
  token?: string | null;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  retry?: RetryOpts;
}

/** The broker config for slot calls, or null when there is no PAT. */
export function slotHttpConfig(opts: SlotHttpOpts = {}): BrokerHttpConfig | null {
  const token = opts.token === undefined ? canopyToken() : opts.token;
  if (!token) return null;
  return {
    baseUrl: (opts.baseUrl ?? canopyApiBase()).replace(/\/+$/, ''),
    token,
    fetchImpl: opts.fetchImpl ?? fetch,
    requestTimeoutMs: opts.requestTimeoutMs ?? 20_000,
    retry: resolveRetry(opts.retry),
    capability: TEST_WORKER_CAPABILITY,
  };
}

const slotRoute = (name: 'slotList' | 'slotPut' | 'slotDelete', slot?: string) =>
  routePath(name, { slug: LEASE_AGENT, name: TEST_WORKER_CAPABILITY, ...(slot ? { slot } : {}) });

function strOrNull(v: unknown): string | null {
  if (typeof v === 'string' && v) return v;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const n = o.email ?? o.name ?? o.slug ?? o.username;
    if (typeof n === 'string' && n) return n;
  }
  return null;
}

/**
 * Normalise the slot list. Accepts `{slots: [...]}`, `{items: [...]}`, a bare
 * list, or an object keyed by slot. Secret VALUES are dropped even if a
 * misbehaving server sent them: only key names survive.
 */
export function normalizeSlotList(body: unknown): SlotRow[] {
  let rows: Array<[string | null, unknown]>;
  if (Array.isArray(body)) rows = body.map((r) => [null, r]);
  else if (body && typeof body === 'object') {
    const o = body as Record<string, unknown>;
    const list = o.slots ?? o.items;
    if (Array.isArray(list)) rows = list.map((r) => [null, r]);
    else if (list && typeof list === 'object') rows = Object.entries(list as Record<string, unknown>);
    else rows = [];
  } else rows = [];
  const out: SlotRow[] = [];
  for (const [key, r] of rows) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const slot = String(o.slot ?? o.name ?? key ?? '');
    if (!slot) continue;
    const pub = o.public && typeof o.public === 'object' ? (o.public as Record<string, unknown>) : {};
    const secretKeys = Array.isArray(o.secret_keys)
      ? o.secret_keys.map(String)
      : o.secret && typeof o.secret === 'object'
        ? Object.keys(o.secret as object)
        : [];
    const heldRaw = o.held ?? o.is_held ?? o.leased;
    out.push({
      slot,
      public: pub,
      secretKeys,
      updatedAt: strOrNull(o.updated_at),
      updatedBy: strOrNull(o.updated_by),
      held: typeof heldRaw === 'boolean' ? heldRaw : null,
    });
  }
  return out.sort((a, b) => compareSlots(a.slot, b.slot));
}

// ── classification (doctor + mobile_diagnose) ───────────────────────

export interface SlotDataStatus {
  slot: string;
  /** Required keys absent, as `public.<k>` / `secret.<k>`. */
  missing: string[];
  /** Public identity problems (non-demo phone, countryCode+phoneLocal ≠ phone, a phone shared with another slot). */
  problems: string[];
  held: boolean | null;
  updated_at: string | null;
}

export interface SlotDataReport {
  ok: boolean;
  /** The slots checked (the declared ones; the listed ones when no declaration is given). */
  declared: string[];
  slots: SlotDataStatus[];
  /** One line: what is wrong, or that every slot is backed. */
  summary: string;
  /** Set when the list could not be read; `ok` is false. */
  error?: string;
}

function present(o: Record<string, unknown>): string[] {
  return Object.keys(o).filter((k) => {
    const v = o[k];
    return (typeof v === 'string' && v.trim() !== '') || typeof v === 'number';
  });
}

/** Pure: which declared slots lack data, a required key, or a sound identity. Never sees a secret value. */
export function classifySlotData(declared: string[] | null, rows: SlotRow[]): SlotDataReport {
  const bySlot = new Map(rows.map((r) => [r.slot, r]));
  const slots = [...(declared ?? rows.map((r) => r.slot))].sort(compareSlots);
  const phones = new Map<string, string>();
  const statuses: SlotDataStatus[] = slots.map((slot) => {
    const row = bySlot.get(slot);
    if (!row) return { slot, missing: missingSlotKeys([], []), problems: [], held: null, updated_at: null };
    const missing = missingSlotKeys(present(row.public), row.secretKeys);
    const s = (k: string) => (typeof row.public[k] === 'string' ? (row.public[k] as string).trim() : '');
    const problems = s('phone') ? publicIdentityProblems({ phone: s('phone'), phoneLocal: s('phoneLocal'), countryCode: s('countryCode') }) : [];
    if (s('phone')) {
      const other = phones.get(s('phone'));
      if (other) problems.push(`shares phone ${s('phone')} with ${other} — two slots on one worker defeat the lock`);
      else phones.set(s('phone'), slot);
    }
    return { slot, missing, problems, held: row.held, updated_at: row.updatedAt };
  });
  const bad = statuses.filter((s) => s.missing.length || s.problems.length);
  const summary = bad.length
    ? bad
        .map((s) =>
          !bySlot.has(s.slot) || s.missing.length === PUBLIC_KEYS.length + SECRET_KEYS.length
            ? `${s.slot}: no data`
            : `${s.slot}: ${[...(s.missing.length ? [`lacks ${s.missing.join(', ')}`] : []), ...s.problems].join('; ')}`,
        )
        .join(' | ')
    : `all ${statuses.length} slot(s) carry phone, phoneLocal, countryCode, name, pin and backupCode`;
  return { ok: bad.length === 0, declared: slots, slots: statuses, summary };
}

// ── HTTP ────────────────────────────────────────────────────────────

function requireCfg(cfg: BrokerHttpConfig | null): BrokerHttpConfig {
  if (!cfg) {
    throw new MobileError(
      'LEASE_NOT_CONFIGURED',
      "no canopy-web PAT (CANOPY_WEB_PAT in ACE's .env)",
      'Run /ace:setup --force-env (CANOPY_WEB_PAT comes from the canopy-pat item in the ACE instance vault).',
    );
  }
  return cfg;
}

/** The masked slot list. */
export async function listSlots(cfg: BrokerHttpConfig | null): Promise<SlotRow[]> {
  try {
    return normalizeSlotList(await brokerRequest<unknown>(requireCfg(cfg), 'GET', slotRoute('slotList')));
  } catch (e) {
    throw notServed(e);
  }
}

/** A 404/405 on a slot route means this canopy-web predates per-slot data — say that, not "agent hidden". */
function notServed(e: unknown): unknown {
  if (e instanceof MobileError && (e.code === 'LEASE_AGENT_NOT_VISIBLE' || e.code === 'LEASE_HTTP_405')) {
    return new MobileError(
      'TEST_WORKER_SLOTS_NOT_SERVED',
      `canopy-web does not serve test-worker slot data yet (${e.message})`,
      'Per-slot data on pool capabilities is a canopy-web feature (ace#2955); wait for its deploy. ' +
        'If it is deployed, /ace:doctor capability_lease checks that this PAT can see agent "ace".',
    );
  }
  return e;
}

/** A MobileError whose message and remediation have every given secret value redacted. */
function redacted(e: unknown, secrets: string[]): unknown {
  if (!(e instanceof Error)) return e;
  const msg = redactSecrets(e.message, secrets);
  if (e instanceof MobileError) {
    return new MobileError(e.code, msg, e.remediation ? redactSecrets(e.remediation, secrets) : undefined);
  }
  return new Error(msg);
}

/** Every string value under `secret`, for redaction. */
function secretValues(body: { secret?: Record<string, unknown> | null }): string[] {
  return Object.values(body.secret ?? {}).filter((v): v is string => typeof v === 'string');
}

/**
 * Upsert one slot's keys (null deletes a key). Returns canopy-web's answer
 * with every secret masked — the server masks it already; this is the belt.
 */
export async function putSlotData(
  cfg: BrokerHttpConfig | null,
  slot: string,
  body: { public?: Record<string, unknown | null>; secret?: Record<string, unknown | null> },
): Promise<unknown> {
  const secrets = secretValues(body as { secret?: Record<string, unknown> });
  try {
    const res = await brokerRequest<unknown>(requireCfg(cfg), 'PUT', slotRoute('slotPut', slot), body);
    return maskSecretsDeep(res);
  } catch (e) {
    throw redacted(notServed(e), secrets);
  }
}

/**
 * Remove a slot's data (retire). DELETE first; a canopy-web that does not
 * serve DELETE on the slot (404/405) gets a PUT nulling every key the masked
 * list shows, which the per-key upsert contract treats as deletion.
 */
export async function deleteSlotData(cfg: BrokerHttpConfig | null, slot: string): Promise<{ via: 'delete' | 'put-null' }> {
  const c = requireCfg(cfg);
  try {
    await brokerRequest<unknown>(c, 'DELETE', slotRoute('slotDelete', slot));
    return { via: 'delete' };
  } catch (e) {
    const code = e instanceof MobileError ? e.code : '';
    if (code !== 'LEASE_AGENT_NOT_VISIBLE' && code !== 'LEASE_HTTP_405') throw e;
  }
  const row = (await listSlots(c)).find((r) => r.slot === slot);
  const pub = Object.fromEntries([...new Set([...PUBLIC_KEYS, ...Object.keys(row?.public ?? {})])].map((k) => [k, null]));
  const sec = Object.fromEntries([...new Set([...SECRET_KEYS, ...(row?.secretKeys ?? [])])].map((k) => [k, null]));
  await putSlotData(c, slot, { public: pub, secret: sec });
  return { via: 'put-null' };
}

/**
 * The report `/ace:doctor` and `mobile_diagnose` show. Never throws: an
 * unreadable list comes back `ok: false` with `error`.
 */
export async function fetchSlotDataReport(cfg: BrokerHttpConfig | null, declared: string[] | null = null): Promise<SlotDataReport> {
  if (!cfg) {
    return { ok: false, declared: declared ?? [], slots: [], summary: 'no canopy-web PAT, so slot data cannot be read', error: 'no PAT' };
  }
  try {
    return classifySlotData(declared, await listSlots(cfg));
  } catch (e) {
    const msg = (e as Error).message;
    const unserved = e instanceof MobileError && e.code === 'TEST_WORKER_SLOTS_NOT_SERVED';
    return {
      ok: false,
      declared: declared ?? [],
      slots: [],
      summary: unserved
        ? `${msg} — every checkout would fail TEST_WORKER_NO_CREDENTIALS`
        : `cannot read test-worker slot data (${msg})`,
      error: msg,
    };
  }
}
