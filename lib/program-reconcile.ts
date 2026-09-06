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
 *     currency/country/delivery_type are not even accepted by
 *     `connect_update_program`. `name` is a different case, and the reason
 *     recorded here until 2026-09-06 was WRONG — see below.
 *
 *   REFRESHABLE (per-run content — re-derived from the current run's PDD):
 *     description, budget, start_date, end_date. Exactly the optional
 *     fields `connect_update_program` accepts.
 *
 * ## Why `name` is durable, and why the old reason was false (ace#1966)
 *
 * This module used to say `name` stays durable "because it is the cross-run
 * reuse-lookup key". It is not. `skills/connect-program-setup` § Step 2
 * mandates the opposite and has since ace#1252: call
 * `connect_list_programs` with **no `name` filter**, match candidates on
 * **delivery type + archetype** — "use the name only for ranking/display" —
 * precisely because a name scan is structurally blind. So a rename would not
 * have broken any lookup, and the stated reason was protecting a mechanism
 * that had already been deliberately removed.
 *
 * The real reason is narrower, and it does not make the name authoritative:
 * `connect_update_program` DOES accept `name`, so ACE can rename a program at
 * any time; it declines to do so autonomously because the name is a live,
 * LLO-facing surface (program listings, solicitation pages) and renaming one
 * mid-programme has consequences outside ACE's own bookkeeping. That is an
 * operator's call, not a reconciler's.
 *
 * ## The name asserts an archetype forever, so the name is made NON-AUTHORITATIVE
 *
 * `bednet-check-2-visit/20260902-1555`: the durable program is named
 * `Bednet Check Multi-Stage Study — 2026` while the description ACE refreshed
 * on it in the same step reads "Archetype: longitudinal-visits, and
 * deliberately NOT multi-stage." Because `name` is durable, `reconcile` could
 * refresh six parameters and structurally could not surface the one field a
 * reader sees first.
 *
 * The fix is NOT to keep the name correct — that is a rename, and a rename is
 * the operator's call. It is to stop the name being read as a claim:
 *
 *   - Nothing in ACE derives an archetype from a program name. Step 2 matches
 *     on structured fields; the name ranks and displays.
 *   - When the name's archetype token CONTRADICTS this run's PDD archetype,
 *     `reconcileProgramWithPdd` emits a `[WARN]` into `warnings[]` — in code,
 *     not in prose an agent may or may not run — so the divergence reaches the
 *     run summary whether or not anyone remembers to look.
 *   - `name` never enters `updateArgs`. The reconciler reports; it does not
 *     rename.
 *   - The check returns a `CheckOutcome` (`lib/check-outcome.ts`), so "the name
 *     is fine" and "nobody passed the name" are different states. A nullable
 *     finding would have collapsed them, which is the exact shape of the four
 *     blind-gate issues that module exists to prevent.
 *
 * Detection is deliberately PRECISION-FIRST (see `ARCHETYPE_NAME_TOKENS`): a
 * missed token costs nothing beyond the status quo, and the worst a false
 * positive can do is add one advisory line, because no value is derived from
 * the answer.
 *
 * Budget nuance: the live program budget is a CEILING that
 * connect-program-setup § Step 4a deliberately raises above the PDD's
 * per-opp budget to fund the by-design accumulation of per-run opps
 * (jjackson/ace#588). `live.budget > pdd.budget` is therefore expected and
 * NOT a divergence; only `live.budget < pdd.budget` diverges (the ceiling
 * cannot fund the current PDD's intent). `updateArgs` never lowers budget.
 */

import { checked, unable, formatUnable, type CheckOutcome } from './check-outcome';

const norm = (s: string): string => s.trim().replace(/\s+/g, ' ');

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

/** The archetypes a PDD can declare (CLAUDE.md § Conventions). */
export type Archetype = 'atomic-visit' | 'focus-group' | 'multi-stage' | 'longitudinal-visits';

/**
 * Phrases in a HUMAN-AUTHORED program name that assert an archetype, keyed by
 * the archetype they assert.
 *
 * Every entry is a phrase `skills/connect-program-setup` § Archetypes tells
 * this skill to write, or the unambiguous form of one. The bar is PRECISION,
 * not recall — the issue's own open question was "is an archetype token ever
 * detected robustly enough to act on", and the answer here is: only act on
 * tokens that cannot mean anything else, and never derive a value from the
 * result.
 *
 * `atomic-visit` deliberately has NO tokens. Its recommended names are
 * "<Domain> Survey" and "<Domain> Field Deployment", and "Survey" is a word
 * longitudinal and multi-stage programmes use freely (the live
 * `Household Poverty Targeting Survey` is a component of neither). A generic
 * word matched as an assertion would fire on names that assert nothing, which
 * is how a detector on human prose stops being believed. An archetype-neutral
 * name is the RECOMMENDED outcome, so having no token for it is correct: a
 * neutral name should produce silence, not a guess.
 */
export const ARCHETYPE_NAME_TOKENS: { archetype: Archetype; tokens: string[] }[] = [
  { archetype: 'multi-stage', tokens: ['multi-stage', 'multi stage', 'multistage'] },
  { archetype: 'focus-group', tokens: ['fgd', 'focus group', 'focus-group'] },
  {
    archetype: 'longitudinal-visits',
    tokens: ['longitudinal', 'follow-up study', 'follow up study', 'two-visit', 'two visit'],
  },
];

/**
 * Which archetypes a program name ASSERTS. Usually zero (a neutral name) or
 * one; more than one means the name contradicts itself and asserts nothing
 * coherent, which is reported rather than resolved.
 *
 * Matching is whitespace-normalized, case-insensitive, and substring-based on
 * the normalized name. `-` and a space are interchangeable in the tokens above
 * because human-authored names use both.
 */
export function detectArchetypesInName(name: string): Archetype[] {
  const haystack = norm(name).toLowerCase();
  const hits: Archetype[] = [];
  for (const { archetype, tokens } of ARCHETYPE_NAME_TOKENS) {
    if (tokens.some((t) => haystack.includes(t))) hits.push(archetype);
  }
  return hits;
}

/** A program name asserting an archetype this run's PDD does not declare. */
export interface NameArchetypeFinding {
  /** The live program name, verbatim. */
  name: string;
  /** What this run's PDD declares — the source of truth. */
  declared: Archetype;
  /** What the NAME asserts. Two entries means the name contradicts itself. */
  asserted: Archetype[];
}

/**
 * What the check saw, on the `checked` branch: the archetypes the name
 * asserts, whether or not they contradict. Present even on a pass, so a caller
 * can tell "the name agrees" from "the name says nothing".
 */
export interface NameArchetypeExtra {
  asserted: Archetype[];
}

export type NameArchetypeOutcome = CheckOutcome<NameArchetypeFinding, NameArchetypeExtra>;

/**
 * Compare the archetype a program NAME asserts against the one this run's PDD
 * declares (ace#1966). Pure: it produces a report, never a rename.
 *
 * Returns a `CheckOutcome`, not a nullable finding, because the three states
 * are genuinely different and collapsing two of them is the defect class this
 * repo has paid for four times (`lib/check-outcome.ts`):
 *
 *   - `unable`  — the caller passed no name, or no declared archetype. NOTHING
 *                 was verified. This is the case that used to be silent, and
 *                 silence here is indistinguishable from "the name is fine".
 *   - `checked` + `ok: true`  — the name is neutral, or it agrees.
 *   - `checked` + `ok: false` — the name asserts something this run's PDD does
 *                 not declare. One finding; never a rename.
 */
export function checkNameArchetype(
  name: string | undefined,
  declared: Archetype | string | undefined,
): NameArchetypeOutcome {
  if (!name || !name.trim()) {
    return unable(
      'the live program name was not supplied — pass `live.name` from ' +
      'connect_get_program so a stale archetype token can be seen at all',
    );
  }
  if (!declared || !declared.trim()) {
    return unable(
      "this run's declared archetype was not supplied — pass `pdd.archetype` " +
      "from the PDD's `Archetype:` line, the source of truth a name is checked against",
    );
  }
  const asserted = detectArchetypesInName(name);
  const contradicts = asserted.length > 0 && !(asserted.length === 1 && asserted[0] === declared);
  const findings: NameArchetypeFinding[] = contradicts
    ? [{ name, declared: declared as Archetype, asserted }]
    : [];
  return { ...checked(!contradicts, findings), asserted };
}

/** The live program's refreshable fields, as read via `connect_get_program`. */
export interface LiveProgramFields {
  description: string;
  budget: number;
  start_date: string;   // YYYY-MM-DD
  end_date: string;     // YYYY-MM-DD
  /**
   * The live program NAME. Durable — it is never refreshed and never enters
   * `updateArgs`. Supplied only so an archetype token baked into it can be
   * checked against this run's PDD and REPORTED (ace#1966). Optional, so a
   * caller that does not pass it gets exactly the pre-ace#1966 behaviour.
   */
  name?: string;
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
  /**
   * This run's declared archetype, from the PDD's `Archetype:` line. The PDD
   * is the source of truth for the archetype; a program name is not. Used only
   * for the name check — never written anywhere.
   */
  archetype?: Archetype | string;
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
  /**
   * Set when the reused program's NAME asserts an archetype this run's PDD
   * does not declare (ace#1966). Reported, never repaired: `name` is durable
   * and renaming a live LLO-facing program is an operator's call.
   *
   * INDEPENDENT of `inSync`, and that is the trap this field exists to make
   * visible. `inSync` is about the four REFRESHABLE fields, so a program whose
   * content this run has just brought fully up to date reports `inSync: true`
   * while its name still advertises a superseded archetype. A caller that
   * emits `warnings` only on the diverging branch drops exactly this case —
   * emit `warnings` unconditionally.
   *
   * `status: 'unable'` means the caller passed no name or no archetype, so
   * nothing was checked. That is NOT a pass, and it produces its own warning
   * line rather than silence.
   */
  nameArchetype: NameArchetypeOutcome;
}

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

  const nameArchetype = checkNameArchetype(live.name, pdd.archetype);

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

  if (nameArchetype.status === 'unable') {
    warnings.push(
      `[WARN] ${formatUnable('reused Connect program name-vs-archetype', nameArchetype.reason)}`,
    );
  } else {
    for (const f of nameArchetype.findings) {
      warnings.push(
        `[WARN] reused Connect program NAME asserts archetype ` +
        `${f.asserted.join(' + ')} but this run's PDD declares ` +
        `${f.declared} — live name: "${f.name}". The PDD is the ` +
        `source of truth for the archetype; nothing derives one from a program name ` +
        `(the reuse scan in connect-program-setup § Step 2 matches on delivery type + ` +
        `archetype, never the name). This is a stale LLO-facing label, not a wrong ` +
        `input. Renaming is an operator's call — connect_update_program accepts ` +
        `name — and this helper never does it (ace#1966).`,
      );
    }
  }

  return { inSync: diffs.length === 0, diffs, updateArgs, warnings, nameArchetype };
}
