/**
 * Program reconciliation — the pure comparison behind
 * `skills/connect-program-setup`'s reuse path (jjackson/ace#1078).
 *
 * Background: `opp.yaml.connect.program` is durable per-opp state — the
 * program UUID is written once and reused by every subsequent run. But the
 * program's *content* (description, budget, dates) was authored from the PDD
 * of the run that created it. Later runs author a fresh PDD and silently
 * reuse the old program, so a live, LLO-facing Connect program can end up
 * advertising rules the current PDD forbids (the spark-facilitator instance:
 * a stale description stating an enforced 500m GPS payment gate that the
 * current PDD deliberately made non-enforcing).
 *
 * The field split this module encodes:
 *
 *   DURABLE  (identity — never touched on reuse):
 *     id (UUID), organization_slug, delivery_type, currency, country, name.
 *     `name` stays durable because it is the cross-run reuse-lookup key;
 *     currency/country/delivery_type are not even accepted by
 *     `connect_update_program`.
 *
 *   REFRESHABLE (per-run content — re-derived from the current run's PDD):
 *     description, budget, start_date, end_date. Exactly the optional
 *     fields `connect_update_program` accepts.
 *
 * Budget nuance: the live program budget is a CEILING that
 * connect-program-setup § Step 4a deliberately raises above the PDD's
 * per-opp budget to fund the by-design accumulation of per-run opps
 * (jjackson/ace#588). `live.budget > pdd.budget` is therefore expected and
 * NOT a divergence; only `live.budget < pdd.budget` diverges (the ceiling
 * cannot fund the current PDD's intent). `updateArgs` never lowers budget.
 */

export const DURABLE_PROGRAM_FIELDS = [
  'id',
  'organization_slug',
  'delivery_type',
  'currency',
  'country',
  'name',
] as const;

export const REFRESHABLE_PROGRAM_FIELDS = [
  'description',
  'budget',
  'start_date',
  'end_date',
] as const;

export type RefreshableProgramField = (typeof REFRESHABLE_PROGRAM_FIELDS)[number];

/** The live program's refreshable fields, as read via `connect_get_program`. */
export interface LiveProgramFields {
  description: string;
  budget: number;
  start_date: string;   // YYYY-MM-DD
  end_date: string;     // YYYY-MM-DD
}

/**
 * The current run's PDD-derived values. Any field left undefined (or an
 * empty string / non-finite number) is treated as "not derived this run"
 * and skipped — absence of a PDD value is never a divergence.
 */
export interface PddProgramFields {
  description?: string;
  budget?: number;
  start_date?: string;
  end_date?: string;
}

export interface ProgramFieldDiff {
  field: RefreshableProgramField;
  live: string | number;
  pdd: string | number;
}

export interface ProgramReconcileResult {
  /** True when every comparable refreshable field matches the PDD. */
  inSync: boolean;
  diffs: ProgramFieldDiff[];
  /**
   * Ready-to-pass patch for `connect_update_program` covering exactly the
   * diverging fields (empty object when inSync). Budget is only ever
   * raised, never lowered (Step 4a headroom, see module header).
   */
  updateArgs: Partial<PddProgramFields>;
  /**
   * One `[WARN]` line per diverging field, for the skill to emit verbatim
   * when updating is unsafe (e.g. a solicitation already published against
   * the current text) so the divergence lands in the run summary instead
   * of nowhere.
   */
  warnings: string[];
}

const norm = (s: string): string => s.trim().replace(/\s+/g, ' ');

/**
 * Compare a live program (from `connect_get_program`) against the current
 * run's PDD-derived values. Pure — no I/O; the skill decides whether the
 * resulting `updateArgs` are applied via `connect_update_program` or the
 * `warnings` are emitted instead.
 */
export function reconcileProgramWithPdd(
  live: LiveProgramFields,
  pdd: PddProgramFields,
): ProgramReconcileResult {
  const diffs: ProgramFieldDiff[] = [];
  const updateArgs: Partial<PddProgramFields> = {};

  if (typeof pdd.description === 'string' && pdd.description.trim() !== '') {
    if (norm(live.description) !== norm(pdd.description)) {
      diffs.push({ field: 'description', live: live.description, pdd: pdd.description });
      updateArgs.description = pdd.description;
    }
  }

  if (typeof pdd.budget === 'number' && Number.isFinite(pdd.budget)) {
    // Ceiling semantics: live >= pdd is healthy headroom (Step 4a), only
    // live < pdd means the program cannot fund the current PDD's intent.
    if (live.budget < pdd.budget) {
      diffs.push({ field: 'budget', live: live.budget, pdd: pdd.budget });
      updateArgs.budget = pdd.budget;
    }
  }

  for (const field of ['start_date', 'end_date'] as const) {
    const pddValue = pdd[field];
    if (typeof pddValue === 'string' && pddValue.trim() !== '') {
      if (norm(live[field]) !== norm(pddValue)) {
        diffs.push({ field, live: live[field], pdd: pddValue });
        updateArgs[field] = pddValue;
      }
    }
  }

  const warnings = diffs.map((d) => {
    const show = (v: string | number) => {
      const s = String(v);
      return s.length > 120 ? `${s.slice(0, 117)}...` : s;
    };
    return (
      `[WARN] reused Connect program ${d.field} diverges from this run's PDD — ` +
      `live: "${show(d.live)}" vs PDD: "${show(d.pdd)}". Program content is per-run ` +
      `(only identity is durable); update via connect_update_program or record why not.`
    );
  });

  return { inSync: diffs.length === 0, diffs, updateArgs, warnings };
}
