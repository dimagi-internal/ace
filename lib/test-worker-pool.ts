/**
 * The Connect test-worker pool: slot → credentials (ace#2955).
 *
 * Every ACE device session signs in as ONE Connect test worker, and each
 * sign-in is a PersonalID recovery, so two overlapping sessions on the same
 * worker break each other ("Account in use on another device", ace#2934).
 * The owner's answer (Jon, 2026-10-15): a small, NAMED pool of workers, each
 * checked out by one device session at a time, plus a deliberate step to add
 * one — never a fresh worker per run (`lib/per-run-test-user.ts` stays off).
 *
 * Where a worker's credentials live (owner directive, 2026-10-15): in
 * canopy-web, as per-slot data on ACE's `test-worker` pool capability — "fully
 * proper security", and "per login even if the same". Every slot carries ALL
 * of its own data, public and secret:
 *
 *   public  phone, phoneLocal, countryCode, name
 *   secret  pin, backupCode
 *
 * A ready lease hands its holder that slot's data (`slot_data`), so the lock
 * and the credentials arrive together (`lib/test-worker-lease.ts`). There is
 * NO fallback to the shared `ACE_E2E_PIN` / `ACE_E2E_BACKUP_CODE` for a pool
 * slot: a missing key fails TEST_WORKER_NO_CREDENTIALS naming the slot, the
 * keys, and the command that stores them (`scripts/test-worker-set.ts`). The
 * old `ACE_E2E_WORKERS` env / 1Password `connect-test-workers` path is gone.
 *
 * The legacy `ACE_E2E_*` worker survives for ONE purpose: the rollout
 * fallback, when the pool capability is not live and a single session runs
 * UNLOCKED as worker-1 (`legacyTestWorker`). The same env is still read
 * elsewhere in ACE (the `${ACE_E2E_PHONE}` invite check, Phase 4).
 *
 * Secrets: no function here puts a pin or backup code into an error message.
 * `maskWorker` / `maskSlotData` / `redactSecrets` are what every report,
 * log line and tool result goes through.
 */
import { MobileError } from '../mcp/mobile/errors.js';
import { TEST_NUMBER_PREFIX, assertDemoE164 } from './per-run-test-user.js';

/** The slot the legacy single-worker `ACE_E2E_*` vars describe (rollout fallback only). */
export const LEGACY_SLOT = 'worker-1';
export const SLOT_RE = /^worker-(\d+)$/;
export const DEMO_COUNTRY_CODE = '+7';

/** Slot-data keys canopy-web returns to anyone who can read the slot list. */
export const PUBLIC_KEYS = ['phone', 'phoneLocal', 'countryCode', 'name'] as const;
/** Slot-data keys canopy-web returns only to the lease holder; never logged, never echoed. */
export const SECRET_KEYS = ['pin', 'backupCode'] as const;
export const MASK = '***';

export interface TestWorker {
  slot: string;
  phone: string;
  phoneLocal: string;
  countryCode: string;
  pin: string;
  backupCode: string;
  name: string;
}

/** A slot's data as canopy-web serves it: `{public: {...}, secret: {...}}`. */
export interface SlotData {
  public?: Record<string, unknown> | null;
  secret?: Record<string, unknown> | null;
}

/** A MobileError, so the mobile MCP's tool-error guard surfaces its remediation. */
export class TestWorkerPoolError extends MobileError {
  readonly slot: string | null;
  constructor(code: string, slot: string | null, message: string, remediation: string, details?: Record<string, unknown>) {
    super(code, message, remediation, slot ? { slot, ...details } : details);
    this.name = 'TestWorkerPoolError';
    this.slot = slot;
  }
}

/** The command that stores a slot's data on canopy-web (secrets via env vars, never argv). */
export function setSlotCommand(slot: string): string {
  return (
    `PIN=… BACKUP_CODE=… npx tsx scripts/test-worker-set.ts --slot ${slot} --phone +7426… --phone-local 426… ` +
    '--country-code +7 --name "ACE Test N" --pin-env PIN --backup-code-env BACKUP_CODE'
  );
}

const fixFor = (slot: string) =>
  `Store the slot's data on canopy-web: ${setSlotCommand(slot)} ` +
  '(skills/test-worker-pool/SKILL.md § Add a worker). `npx tsx scripts/test-worker-set.ts --list` shows what each slot has.';

/** Natural sort: worker-2 before worker-10. */
export function compareSlots(a: string, b: string): number {
  const na = SLOT_RE.exec(a);
  const nb = SLOT_RE.exec(b);
  if (na && nb) return Number(na[1]) - Number(nb[1]);
  return a.localeCompare(b);
}

function str(o: Record<string, unknown> | null | undefined, key: string): string {
  const v = o?.[key];
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (typeof v === 'number') return String(v);
  return '';
}

/**
 * The public identity checks every slot must pass — the phone is a `+7426`
 * demo number (anything else gets no OTP skip and no Play Integrity bypass
 * upstream, so registering it hangs on a real OTP), and countryCode +
 * phoneLocal spell it (the registration recipe types phoneLocal). Returns
 * the problems, empty when sound. Never looks at secrets.
 */
export function publicIdentityProblems(p: { phone: string; phoneLocal: string; countryCode: string }): string[] {
  const out: string[] = [];
  try {
    assertDemoE164(p.phone);
  } catch (e) {
    out.push((e as Error).message.replace(/^per-run test user: /, ''));
    return out;
  }
  if (p.phoneLocal && p.countryCode && `${p.countryCode}${p.phoneLocal}` !== p.phone) {
    out.push(
      `countryCode + phoneLocal (${p.countryCode} + ${p.phoneLocal}) does not equal phone ${p.phone} — ` +
        'the registration recipe types phoneLocal, so a mismatch registers a different number',
    );
  }
  return out;
}

/** Validate one complete worker; throws TEST_WORKER_INVALID naming the slot (never a secret). */
export function validateWorker(w: TestWorker): TestWorker {
  const problems = publicIdentityProblems(w);
  if (problems.length) {
    throw new TestWorkerPoolError('TEST_WORKER_INVALID', w.slot, `test worker ${w.slot}: ${problems.join('; ')}`, fixFor(w.slot));
  }
  return w;
}

/** Which required keys a slot lacks, by name. Pure; reads key presence only. */
export function missingSlotKeys(publicKeys: Iterable<string>, secretKeys: Iterable<string>): string[] {
  const pub = new Set(publicKeys);
  const sec = new Set(secretKeys);
  return [...PUBLIC_KEYS.filter((k) => !pub.has(k)).map((k) => `public.${k}`), ...SECRET_KEYS.filter((k) => !sec.has(k)).map((k) => `secret.${k}`)];
}

function presentKeys(o: Record<string, unknown> | null | undefined): string[] {
  return Object.keys(o ?? {}).filter((k) => str(o, k) !== '');
}

/**
 * The worker a lease's `slot_data` describes. Missing `slot_data`, or any
 * required key absent/blank → TEST_WORKER_NO_CREDENTIALS naming the slot,
 * the missing KEYS (never a value) and the command that stores them. No key
 * falls back to `ACE_E2E_*`: every slot carries its own.
 */
export function workerFromSlotData(slot: string, data: SlotData | null | undefined): TestWorker {
  if (!data || typeof data !== 'object') {
    throw new TestWorkerPoolError(
      'TEST_WORKER_NO_CREDENTIALS',
      slot,
      `canopy-web handed out test worker ${slot}, but the slot has no data (slot_data is empty)`,
      fixFor(slot),
      { missing: missingSlotKeys([], []) },
    );
  }
  const pub = (data.public && typeof data.public === 'object' ? data.public : {}) as Record<string, unknown>;
  const sec = (data.secret && typeof data.secret === 'object' ? data.secret : {}) as Record<string, unknown>;
  const missing = missingSlotKeys(presentKeys(pub), presentKeys(sec));
  if (missing.length) {
    throw new TestWorkerPoolError(
      'TEST_WORKER_NO_CREDENTIALS',
      slot,
      `test worker ${slot}'s data on canopy-web lacks ${missing.join(', ')}`,
      fixFor(slot),
      { missing },
    );
  }
  return validateWorker({
    slot,
    phone: str(pub, 'phone'),
    phoneLocal: str(pub, 'phoneLocal'),
    countryCode: str(pub, 'countryCode'),
    name: str(pub, 'name'),
    pin: str(sec, 'pin'),
    backupCode: str(sec, 'backupCode'),
  });
}

/**
 * The legacy single worker from `ACE_E2E_*` — used ONLY by the rollout
 * fallback (pool capability not live), never for a pool slot. Null when this
 * machine has no such worker (unset, or an unresolved `op://` ref).
 */
export function legacyTestWorker(env: NodeJS.ProcessEnv = process.env): TestWorker | null {
  const phone = (env.ACE_E2E_PHONE ?? '').trim();
  if (!phone || phone.startsWith('op://')) return null;
  const w: TestWorker = {
    slot: LEGACY_SLOT,
    phone,
    phoneLocal: (env.ACE_E2E_PHONE_LOCAL ?? '').trim(),
    countryCode: (env.ACE_E2E_COUNTRY_CODE ?? '').trim() || DEMO_COUNTRY_CODE,
    pin: (env.ACE_E2E_PIN ?? '').trim(),
    backupCode: (env.ACE_E2E_BACKUP_CODE ?? '').trim(),
    name: (env.ACE_E2E_NAME ?? '').trim() || 'ACE Test',
  };
  const bad = (what: string) =>
    new TestWorkerPoolError(
      'TEST_WORKER_INVALID',
      LEGACY_SLOT,
      `legacy test worker (ACE_E2E_*): ${what}`,
      'Fix the connect-test-user item in the ACE instance vault, then /ace:setup --force-env and restart Claude Code.',
    );
  if (!w.phoneLocal) throw bad('ACE_E2E_PHONE_LOCAL is missing');
  const problems = publicIdentityProblems(w);
  if (problems.length) throw bad(problems.join('; '));
  if (!w.pin) throw bad('ACE_E2E_PIN is missing');
  if (!w.backupCode) throw bad('ACE_E2E_BACKUP_CODE is missing');
  return w;
}

// ── masking ─────────────────────────────────────────────────────────

/** A worker safe to report: secrets replaced by `***`. */
export function maskWorker<T extends Partial<Pick<TestWorker, 'pin' | 'backupCode'>>>(w: T): T {
  return { ...w, ...(w.pin !== undefined ? { pin: MASK } : {}), ...(w.backupCode !== undefined ? { backupCode: MASK } : {}) };
}

/** Slot data safe to report: every secret VALUE replaced by `***` (keys kept). */
export function maskSlotData(data: SlotData | null | undefined): SlotData | null {
  if (!data || typeof data !== 'object') return null;
  const secret = data.secret && typeof data.secret === 'object' ? data.secret : {};
  return {
    public: data.public ?? {},
    secret: Object.fromEntries(Object.keys(secret).map((k) => [k, (secret as Record<string, unknown>)[k] == null ? null : MASK])),
  };
}

/**
 * Deep copy of any JSON value with every secret masked: values under a
 * `secret` key, and keys named like a secret (`pin`, `backupCode`,
 * `backup_code`). For echoing broker responses that might carry slot data.
 */
export function maskSecretsDeep(v: unknown, underSecret = false): unknown {
  if (Array.isArray(v)) return v.map((x) => maskSecretsDeep(x, underSecret));
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => {
        if (underSecret || /^(pin|backup_?code)$/i.test(k)) {
          return [k, x == null ? x : x && typeof x === 'object' ? maskSecretsDeep(x, true) : MASK];
        }
        return [k, maskSecretsDeep(x, k === 'secret')];
      }),
    );
  }
  return underSecret && v != null ? MASK : v;
}

/** `text` with every occurrence of each non-trivial secret value replaced by `***`. */
export function redactSecrets(text: string, secrets: Iterable<string | null | undefined>): string {
  let out = text;
  for (const s of secrets) {
    if (typeof s !== 'string' || s.length < 3) continue;
    out = out.split(s).join(MASK);
  }
  return out;
}

/** The Maestro recipe env (`${PHONE}`, `${PIN}`, …) for a worker — the keys static recipes use. */
export function workerRecipeEnv(w: Omit<TestWorker, 'slot'>): Record<string, string> {
  return {
    PHONE: w.phone,
    PHONE_LOCAL: w.phoneLocal,
    COUNTRY_CODE: w.countryCode,
    PIN: w.pin,
    BACKUP_CODE: w.backupCode,
    NAME: w.name,
  };
}

// ── add-worker arithmetic (scripts/test-worker-add.ts) ──────────────

/** Digits after `+7426` in a pool number (the same width per-run numbers use). */
export const POOL_SUFFIX_DIGITS = 7;

/**
 * The next unused `+7426` number: one past the highest pool number of the
 * standard width, else `+74260000001`. Deterministic, so two people asked to
 * add a worker compute the same number and notice the clash in review rather
 * than on a device. Skips any number in `avoid` (e.g. retired workers, whose
 * Connect accounts still exist).
 */
export function nextWorkerPhone(existing: Iterable<string>, avoid: Iterable<string> = []): string {
  const taken = new Set([...existing, ...avoid]);
  let max = 0;
  for (const p of taken) {
    if (!p.startsWith(TEST_NUMBER_PREFIX)) continue;
    const suffix = p.slice(TEST_NUMBER_PREFIX.length);
    if (suffix.length !== POOL_SUFFIX_DIGITS || !/^\d+$/.test(suffix)) continue;
    max = Math.max(max, Number(suffix));
  }
  let n = max + 1;
  for (;;) {
    if (n >= 10 ** POOL_SUFFIX_DIGITS) {
      throw new Error(`no ${TEST_NUMBER_PREFIX} number left above ${max}`);
    }
    const phone = `${TEST_NUMBER_PREFIX}${String(n).padStart(POOL_SUFFIX_DIGITS, '0')}`;
    if (!taken.has(phone)) {
      assertDemoE164(phone);
      return phone;
    }
    n++;
  }
}

/** The next slot name: one past the highest of the pool's and the manifest's slots. */
export function nextSlotName(...slotLists: Iterable<string>[]): string {
  let max = 0;
  for (const list of slotLists) {
    for (const s of list) {
      const m = SLOT_RE.exec(s);
      if (m) max = Math.max(max, Number(m[1]));
    }
  }
  return `worker-${max + 1}`;
}

/** What `scripts/test-worker-add.ts` prints: the next worker's identity. */
export interface TestWorkerAddPlan {
  slot: string;
  phone: string;
  phoneLocal: string;
  countryCode: string;
  name: string;
}

/**
 * The next worker to add: the first manifest slot with no credentials behind
 * it, else one past every known slot; number one past
 * every known pool number (and past anything in `avoid` — retired workers,
 * whose Connect accounts still exist and must never be reissued).
 */
export function planTestWorkerAdd(args: {
  pool: Iterable<Pick<TestWorker, 'slot' | 'phone'>>;
  manifestSlots?: Iterable<string>;
  avoid?: Iterable<string>;
}): TestWorkerAddPlan {
  const pool = [...args.pool];
  const have = new Set(pool.map((w) => w.slot));
  // A slot the manifest already declares but no credentials back fills first —
  // the initial bootstrap of worker-2..4, or a retired worker's replacement.
  const unbacked = [...(args.manifestSlots ?? [])].filter((s) => SLOT_RE.test(s) && !have.has(s)).sort(compareSlots);
  const slot = unbacked[0] ?? nextSlotName(pool.map((w) => w.slot), args.manifestSlots ?? []);
  const phone = nextWorkerPhone(pool.map((w) => w.phone), args.avoid ?? []);
  const n = SLOT_RE.exec(slot)![1];
  return {
    slot,
    phone,
    phoneLocal: phone.slice(DEMO_COUNTRY_CODE.length),
    countryCode: DEMO_COUNTRY_CODE,
    name: `ACE Test ${n}`,
  };
}
