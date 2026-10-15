/**
 * The Connect test-worker pool: slot name → credentials (ace#2955).
 *
 * Every ACE device session signs in as ONE Connect test worker, and each
 * sign-in is a PersonalID recovery, so two overlapping sessions on the same
 * worker break each other ("Account in use on another device", ace#2934).
 * The owner's answer (Jon, 2026-10-15): a small, NAMED pool of workers, each
 * checked out by one device session at a time, plus a deliberate step to add
 * one — never a fresh worker per run (`lib/per-run-test-user.ts` stays off).
 *
 * This module is only the credential half: which phone/PIN/backup code a slot
 * is. The exclusive checkout is `lib/test-worker-lease.ts` (canopy-web's
 * `test-worker` pool capability); the add-worker procedure is
 * `skills/test-worker-pool/SKILL.md` + `scripts/test-worker-add.ts`.
 *
 * Source:
 *   - `ACE_E2E_WORKERS` — a JSON object keyed by slot, rendered into ACE's
 *     .env from the 1Password item `connect-test-workers` (field `pool-json`):
 *       {"worker-2": {"phone": "+74260000002", "phoneLocal": "4260000002",
 *                     "pin": "…", "backupCode": "…", "name": "ACE Test 2"}, …}
 *     `countryCode` defaults to "+7" (the demo range); `pin`, `backupCode` and
 *     `name` fall back to the legacy `ACE_E2E_*` values, since in the demo
 *     range they are not per-user secrets.
 *   - `worker-1` falls back to the legacy `ACE_E2E_*` vars when the JSON does
 *     not name it, so a single-worker setup behaves exactly as before.
 *
 * Validation fails LOUD naming the slot: a phone outside `+7426` gets no OTP
 * skip and no Play Integrity bypass upstream, so registering it would hang on
 * a real OTP rather than fail.
 */
import { MobileError } from '../mcp/mobile/errors.js';
import { TEST_NUMBER_PREFIX, assertDemoE164 } from './per-run-test-user.js';

export const POOL_ENV = 'ACE_E2E_WORKERS';
/** The slot the legacy single-worker `ACE_E2E_*` vars describe. */
export const LEGACY_SLOT = 'worker-1';
export const SLOT_RE = /^worker-(\d+)$/;
export const DEMO_COUNTRY_CODE = '+7';

export interface TestWorker {
  slot: string;
  phone: string;
  phoneLocal: string;
  countryCode: string;
  pin: string;
  backupCode: string;
  name: string;
}

/** A MobileError, so the mobile MCP's tool-error guard surfaces its remediation. */
export class TestWorkerPoolError extends MobileError {
  readonly slot: string | null;
  constructor(code: string, slot: string | null, message: string, remediation: string) {
    super(code, message, remediation, slot ? { slot } : undefined);
    this.name = 'TestWorkerPoolError';
    this.slot = slot;
  }
}

const FIX =
  'Fix the slot in the 1Password item connect-test-workers (field pool-json) in the ACE instance vault, ' +
  'then /ace:setup --force-env and restart Claude Code. See skills/test-worker-pool/SKILL.md.';

/** Natural sort: worker-2 before worker-10. */
export function compareSlots(a: string, b: string): number {
  const na = SLOT_RE.exec(a);
  const nb = SLOT_RE.exec(b);
  if (na && nb) return Number(na[1]) - Number(nb[1]);
  return a.localeCompare(b);
}

function str(o: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  return '';
}

/** Parse `ACE_E2E_WORKERS`. Unset, empty, or an unresolved `op://` ref → `{}`. */
export function parsePoolJson(raw: string | undefined): Record<string, Record<string, unknown>> {
  const t = (raw ?? '').trim().replace(/^'(.*)'$/s, '$1');
  if (!t || t.startsWith('op://')) return {};
  let v: unknown;
  try {
    v = JSON.parse(t);
  } catch (e) {
    throw new TestWorkerPoolError(
      'TEST_WORKER_POOL_MALFORMED',
      null,
      `${POOL_ENV} is not valid JSON (${(e as Error).message})`,
      FIX,
    );
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    throw new TestWorkerPoolError(
      'TEST_WORKER_POOL_MALFORMED',
      null,
      `${POOL_ENV} must be a JSON object keyed by slot ("worker-1", "worker-2", …)`,
      FIX,
    );
  }
  const out: Record<string, Record<string, unknown>> = {};
  for (const [slot, row] of Object.entries(v as Record<string, unknown>)) {
    if (!SLOT_RE.test(slot)) {
      throw new TestWorkerPoolError('TEST_WORKER_SLOT_NAME', slot, `${POOL_ENV}: slot "${slot}" is not named worker-<n>`, FIX);
    }
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new TestWorkerPoolError('TEST_WORKER_POOL_MALFORMED', slot, `${POOL_ENV}: slot "${slot}" is not an object`, FIX);
    }
    out[slot] = row as Record<string, unknown>;
  }
  return out;
}

/** Validate one worker; throws naming the slot. */
export function validateWorker(w: TestWorker): TestWorker {
  const bad = (what: string) =>
    new TestWorkerPoolError('TEST_WORKER_INVALID', w.slot, `test worker ${w.slot}: ${what}`, FIX);
  try {
    assertDemoE164(w.phone);
  } catch (e) {
    throw bad((e as Error).message.replace(/^per-run test user: /, ''));
  }
  if (!w.phoneLocal) throw bad('phoneLocal is missing');
  if (`${w.countryCode}${w.phoneLocal}` !== w.phone) {
    throw bad(
      `countryCode + phoneLocal (${w.countryCode} + ${w.phoneLocal}) does not equal phone ${w.phone} — ` +
        'the registration recipe types phoneLocal, so a mismatch registers a different number',
    );
  }
  if (!w.pin) throw bad('pin is missing (and no ACE_E2E_PIN fallback)');
  if (!w.backupCode) throw bad('backupCode is missing (and no ACE_E2E_BACKUP_CODE fallback)');
  return w;
}

/**
 * Every worker this machine has credentials for, keyed by slot, validated.
 * An empty map means no worker at all (no `ACE_E2E_*`, no pool JSON).
 */
export function loadTestWorkerPool(env: NodeJS.ProcessEnv = process.env): Map<string, TestWorker> {
  const json = parsePoolJson(env[POOL_ENV]);
  const legacy = {
    phone: (env.ACE_E2E_PHONE ?? '').trim(),
    phoneLocal: (env.ACE_E2E_PHONE_LOCAL ?? '').trim(),
    countryCode: (env.ACE_E2E_COUNTRY_CODE ?? '').trim(),
    pin: (env.ACE_E2E_PIN ?? '').trim(),
    backupCode: (env.ACE_E2E_BACKUP_CODE ?? '').trim(),
    name: (env.ACE_E2E_NAME ?? '').trim(),
  };
  const pool = new Map<string, TestWorker>();
  if (!json[LEGACY_SLOT] && legacy.phone && !legacy.phone.startsWith('op://')) {
    pool.set(
      LEGACY_SLOT,
      validateWorker({
        slot: LEGACY_SLOT,
        phone: legacy.phone,
        phoneLocal: legacy.phoneLocal,
        countryCode: legacy.countryCode || DEMO_COUNTRY_CODE,
        pin: legacy.pin,
        backupCode: legacy.backupCode,
        name: legacy.name || 'ACE Test',
      }),
    );
  }
  for (const [slot, row] of Object.entries(json)) {
    const n = SLOT_RE.exec(slot)?.[1] ?? '';
    pool.set(
      slot,
      validateWorker({
        slot,
        phone: str(row, 'phone'),
        phoneLocal: str(row, 'phoneLocal', 'phone_local', 'phone-local'),
        countryCode: str(row, 'countryCode', 'country_code', 'country-code') || DEMO_COUNTRY_CODE,
        pin: str(row, 'pin') || legacy.pin,
        backupCode: str(row, 'backupCode', 'backup_code', 'backup-code') || legacy.backupCode,
        name: str(row, 'name') || (slot === LEGACY_SLOT ? legacy.name || 'ACE Test' : `ACE Test ${n}`),
      }),
    );
  }
  const phones = new Map<string, string>();
  for (const w of pool.values()) {
    const other = phones.get(w.phone);
    if (other) {
      throw new TestWorkerPoolError(
        'TEST_WORKER_DUPLICATE_PHONE',
        w.slot,
        `test workers ${other} and ${w.slot} share phone ${w.phone} — two slots on one worker defeat the lock`,
        FIX,
      );
    }
    phones.set(w.phone, w.slot);
  }
  return new Map([...pool.entries()].sort(([a], [b]) => compareSlots(a, b)));
}

/** One slot's credentials; throws TEST_WORKER_NO_CREDENTIALS naming it when this machine has none. */
export function resolveTestWorker(slot: string, env: NodeJS.ProcessEnv = process.env): TestWorker {
  const pool = loadTestWorkerPool(env);
  const w = pool.get(slot);
  if (!w) {
    throw new TestWorkerPoolError(
      'TEST_WORKER_NO_CREDENTIALS',
      slot,
      `no credentials on this machine for test worker ${slot} (have: ${[...pool.keys()].join(', ') || 'none'})`,
      `Add ${slot} to the 1Password item connect-test-workers (field pool-json), or if it is there, run ` +
        '/ace:setup --force-env and restart Claude Code (MCP servers read .env at start). ' +
        'skills/test-worker-pool/SKILL.md § Add a worker.',
    );
  }
  return w;
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
