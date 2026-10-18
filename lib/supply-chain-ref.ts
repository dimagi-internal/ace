/**
 * The evidence block every labs supply-chain write carries, built one way.
 *
 * Every `supply_chain_*` write takes `source: {ref, sender?, sent_on?, excerpt?}`.
 * Labs records the same evidence once: repeating a write with the same `ref`
 * and the same payload REPLAYS the first result instead of writing a second
 * row (the atom descriptions, 2026-10-18). So a deterministic ref is what
 * makes a re-run or a resume of an ACE supply-chain skill idempotent with no
 * read-first — and a random or time-stamped ref is what would silently double
 * every tender, receipt and payment on a resume. None of those records can be
 * deleted (spec 2026-10-18 § F6), so a duplicate is permanent.
 *
 *   ref = ace:<scope>:<skill>:<step>:<key>
 *
 *   - `scope` is the run id inside `/ace:run`, or `program-<id>` outside one.
 *   - `skill` / `step` name the write's place in its skill's procedure.
 *   - `key` is the stable natural key of the record (a commodity slug, a
 *     supplier name, `week-2:flw-007`), never a timestamp.
 *
 * `sent_on` is the SIMULATED date of the evidence (spec § G): labs shows it
 * beside the day the write was recorded, and every as-of read keys on it.
 *
 * Money helpers live here too because the same atoms refuse JSON numbers for
 * every amount (`"12.50"`, never `12.5`): a float loses precision a string
 * does not, and the refusal is the atom's, so building the string in one
 * place keeps each skill from rediscovering it.
 */

const SEGMENT = /^[a-z0-9][a-z0-9._-]*$/;
const REF_MAX = 512; // the atoms' `source.ref` maxLength
const EXCERPT_MAX = 2000; // the atoms' `source.excerpt` maxLength
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class SupplyChainRefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SupplyChainRefError';
  }
}

/**
 * Normalise a free-text natural key into a ref segment: lower-case, every run
 * of characters outside `[a-z0-9._-]` (including `:`, which is the ref's own
 * separator) becomes one `-`. Deterministic, so the same key always yields
 * the same ref.
 */
export function refKey(key: string): string {
  const k = key
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!k) throw new SupplyChainRefError(`ref key ${JSON.stringify(key)} normalises to nothing`);
  return k;
}

export interface RefParts {
  /** The run id inside `/ace:run`; outside a run, `program-<program_id>`. */
  scope: string;
  /** The writing skill, e.g. `supply-chain-setup`. */
  skill: string;
  /** The procedure step, e.g. `commodity`, `supplier`, `team`. */
  step: string;
  /** The record's stable natural key; free text is normalised by {@link refKey}. */
  key: string;
}

/** `ace:<scope>:<skill>:<step>:<key>`. Refuses a segment that is empty or would break the shape. */
export function buildSourceRef(parts: RefParts): string {
  const scope = parts.scope.trim();
  if (!scope || scope.includes(':')) {
    throw new SupplyChainRefError(`ref scope ${JSON.stringify(parts.scope)} must be a non-empty run id or program-<id>, with no ':'`);
  }
  for (const [name, value] of [
    ['skill', parts.skill],
    ['step', parts.step],
  ] as const) {
    if (!SEGMENT.test(value)) {
      throw new SupplyChainRefError(`ref ${name} ${JSON.stringify(value)} must match ${SEGMENT}`);
    }
  }
  const ref = `ace:${scope}:${parts.skill}:${parts.step}:${refKey(parts.key)}`;
  if (ref.length > REF_MAX) {
    throw new SupplyChainRefError(`ref is ${ref.length} chars; labs caps source.ref at ${REF_MAX}`);
  }
  return ref;
}

/** The ref scope outside a run: `program-<id>`. */
export function programScope(programId: number | string): string {
  const id = String(programId).trim();
  if (!/^\d+$/.test(id)) throw new SupplyChainRefError(`program id ${JSON.stringify(programId)} is not an integer`);
  return `program-${id}`;
}

export interface SourceBlock {
  ref: string;
  sender?: string;
  sent_on?: string;
  excerpt?: string;
}

export interface BuildSourceInput extends RefParts {
  /** Who the evidence came from, as labs' timeline will name it. */
  sender?: string;
  /** The (simulated) day the evidence is dated, YYYY-MM-DD. */
  sentOn?: string;
  excerpt?: string;
  /**
   * True on the simulated track. The excerpt must then say "simulated", so a
   * reader of labs' timeline can never mistake an ACE-invented quote or
   * receipt for a real one (spec § F6: the records cannot be deleted, so the
   * label is the only isolation they carry).
   */
  simulated?: boolean;
  /**
   * The real "today", for the in-the-past guard. A simulated date must not be
   * in the future: the § G calendar is backdated so every as-of read means
   * something, and a future-dated record breaks that.
   */
  today?: string;
}

/** The full `source` block for one write. */
export function buildSource(input: BuildSourceInput): SourceBlock {
  const block: SourceBlock = { ref: buildSourceRef(input) };
  if (input.sender !== undefined) {
    const s = input.sender.trim();
    if (!s || s.length > 255) throw new SupplyChainRefError('source.sender must be 1-255 chars');
    block.sender = s;
  }
  if (input.sentOn !== undefined) {
    assertIsoDate(input.sentOn, 'source.sent_on');
    if (input.today !== undefined) {
      assertIsoDate(input.today, 'today');
      if (input.sentOn > input.today) {
        throw new SupplyChainRefError(`source.sent_on ${input.sentOn} is after today (${input.today}); simulated dates are backdated`);
      }
    }
    block.sent_on = input.sentOn;
  }
  let excerpt = input.excerpt?.trim();
  if (input.simulated) {
    if (!excerpt) excerpt = 'Simulated by ACE.';
    else if (!/simulated/i.test(excerpt)) excerpt = `Simulated by ACE. ${excerpt}`;
  }
  if (excerpt) {
    if (excerpt.length > EXCERPT_MAX) throw new SupplyChainRefError(`source.excerpt exceeds ${EXCERPT_MAX} chars`);
    block.excerpt = excerpt;
  }
  return block;
}

/**
 * A date `dayOffset` days after a Monday-aligned week start, YYYY-MM-DD.
 * This is how a skill dates a simulated event inside a week of the § G
 * calendar (`lib/sim-calendar.ts`, PR10, computes the week starts).
 */
export function simulatedDate(weekStart: string, dayOffset: number): string {
  assertIsoDate(weekStart, 'weekStart');
  if (!Number.isInteger(dayOffset) || dayOffset < 0 || dayOffset > 6) {
    throw new SupplyChainRefError(`dayOffset ${dayOffset} must be an integer 0-6 (inside the week)`);
  }
  const d = new Date(`${weekStart}T00:00:00Z`);
  if (d.getUTCDay() !== 1) throw new SupplyChainRefError(`weekStart ${weekStart} is not a Monday`);
  d.setUTCDate(d.getUTCDate() + dayOffset);
  return d.toISOString().slice(0, 10);
}

/**
 * A money amount as the decimal string labs requires. Accepts a decimal
 * string, or an integer number of minor units via {@link moneyFromMinor}.
 * A JSON number is refused here, before labs refuses it.
 */
export function money(amount: string): string {
  if (typeof amount !== 'string') {
    throw new SupplyChainRefError(`money must be a decimal string, got ${typeof amount}; labs refuses JSON numbers`);
  }
  const a = amount.trim();
  if (!/^\d*\.?\d+$/.test(a)) throw new SupplyChainRefError(`money ${JSON.stringify(amount)} is not a non-negative decimal string`);
  return a;
}

/** `1250` minor units at 2 decimals → `"12.50"`. Integer arithmetic only. */
export function moneyFromMinor(minorUnits: number, decimals = 2): string {
  if (!Number.isSafeInteger(minorUnits) || minorUnits < 0) {
    throw new SupplyChainRefError(`minor units ${minorUnits} must be a non-negative safe integer`);
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 6) {
    throw new SupplyChainRefError(`decimals ${decimals} must be 0-6`);
  }
  if (decimals === 0) return String(minorUnits);
  const s = String(minorUnits).padStart(decimals + 1, '0');
  return `${s.slice(0, -decimals)}.${s.slice(-decimals)}`;
}

/** The marker every ACE-invented name carries (spec § D/§ F2: no real names). */
export const SYNTHETIC_SUFFIX = '[Synthetic]';

/** `"Kampala Handsets Ltd"` → `"Kampala Handsets Ltd [Synthetic]"`; idempotent. */
export function syntheticName(name: string): string {
  const n = name.trim();
  if (!n) throw new SupplyChainRefError('a synthetic name cannot be empty');
  return n.endsWith(SYNTHETIC_SUFFIX) ? n : `${n} ${SYNTHETIC_SUFFIX}`;
}

function assertIsoDate(value: string, label: string): void {
  if (!ISO_DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new SupplyChainRefError(`${label} ${JSON.stringify(value)} is not a YYYY-MM-DD date`);
  }
}
