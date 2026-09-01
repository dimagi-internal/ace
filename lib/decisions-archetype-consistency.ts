/**
 * Cross-row archetype consistency for a run's `decisions.yaml` (ace#1859).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * On `bednet-check-2-visit/20260828-0629` the public run-summary page showed
 * TWO DIFFERENT ARCHETYPES for the same run. Phase 1's `archetype-selection`
 * row said `longitudinal-visits`; Phase 3's `test-archetype-coverage` row said
 * `atomic-visit`, with `evidence_basis: stated` and a `source:` pointing at
 * `2-scenarios/pdd-to-app-journeys.md` — a document whose line 7 reads
 * `Archetype: longitudinal-visits`. `grep -n "atomic-visit" run_state.yaml`
 * returned nothing: the run's own record never contained the string at all.
 *
 * Both rows render on the anonymous Decisions tab, so an external reader was
 * shown a self-contradicting record of what kind of programme this is.
 * `classify_phase_writeback`, `verify_phase_artifacts` and
 * `verify_phase_products` were all green on Phase 3.
 *
 * Only the archetype NAME was wrong — the row's coverage conclusion and both
 * smoke bindings were correct, and no build, recipe or app was affected. That
 * is exactly why it survived to publication: nothing downstream broke, so
 * nothing downstream complained. "Archetypes are first-class" (CLAUDE.md
 * § Conventions) — every archetype-aware skill branches on the value, so a row
 * that misnames it is a first-class contradiction, not a typo.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT IS COMPARED, AND WHAT IS DELIBERATELY NOT
 *
 * The declared archetype is the effective value of the run's OWN
 * `archetype-selection` row (`override ?? ai-default`). The contradiction is
 * therefore visible entirely WITHIN decisions.yaml — no `run_state.yaml` read,
 * no Drive call, no second source of truth to drift from.
 *
 * Two fields are compared, and only two:
 *
 *   - the row's EFFECTIVE VALUE (`override ?? ai-default`)
 *   - `params.archetype`
 *
 * `options` and `reasoning` are NOT compared, and getting that wrong would
 * make this rule fire on correct rows. Measured against the real log:
 *
 *   - `archetype-selection`'s own `options` legitimately list ALL FOUR
 *     archetypes — that IS the vocabulary (`lib/decision-vocabularies.ts`).
 *   - the CORRECTED `test-archetype-coverage` row legitimately offers
 *     `"multi-stage covered by both smokes"` as a REJECTED alternative.
 *   - `params.superseded_reading: multi-stage (prior run)` records a prior
 *     run's reading on purpose.
 *   - `reasoning` on three separate rows legitimately names other archetypes
 *     while rejecting them ("multi-stage's defining structural implication…",
 *     "not focus-group, so a real Learn app…").
 *
 * Naming an alternative in order to reject it is what a good decision row is
 * FOR. Only the value the run acts on has to agree.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE ESCAPE HATCH
 *
 * A row that legitimately resolves disagreeing source signals declares
 * `evidence_basis: conflicting` (+ `conflict_signals`, enforced by
 * `DecisionRowStrictSchema`). Such a row is exempt: it has already said, in
 * the schema's own vocabulary, that it is reconciling a contradiction rather
 * than asserting one. The defective row was `evidence_basis: stated`, which
 * is the claim this rule holds it to.
 *
 * Pure, synchronous, no I/O — `test/lib/decisions-archetype-consistency.test.ts`
 * covers it, using the real ace#1859 row as the negative fixture.
 */

import { DECISION_VOCABULARIES } from './decision-vocabularies.js';

/** The decision row that DECLARES the run's archetype. */
export const ARCHETYPE_DECISION_ID = 'archetype-selection';

/**
 * The four-value archetype enum, sourced from the declared vocabulary rather
 * than restated — one list, so adding an archetype cannot leave this rule
 * behind (CLAUDE.md § Archetypes are first-class: adding one is purely
 * additive).
 */
export const ARCHETYPES: readonly string[] =
  DECISION_VOCABULARIES[ARCHETYPE_DECISION_ID].options;

/** A decision row reduced to the fields this rule reads. */
export interface ArchetypeCheckRow {
  id: string;
  /** Effective value — `override ?? ai-default`. Never the raw `ai-default` when an override exists. */
  value: string;
  /** `params.archetype`, when the row carries one. */
  paramsArchetype?: string | null;
  /** `stated` | `inferred` | `conflicting`. `conflicting` is exempt. */
  evidenceBasis?: string | null;
}

export interface ArchetypeContradiction {
  /** id of the offending row. */
  id: string;
  /** Which field named the wrong archetype. */
  field: 'value' | 'params.archetype';
  /** The archetype token the row named. */
  named: string;
  /** The archetype the run declared. */
  declared: string;
  /** Reviewer-facing explanation. */
  detail: string;
}

export interface ArchetypeConsistencyResult {
  /** The run's declared archetype, or null when it could not be determined. */
  declared: string | null;
  findings: ArchetypeContradiction[];
}

/**
 * Archetype tokens named in `text`.
 *
 * Boundary-aware so a token is matched as a whole word — with an optional
 * trailing `s`, because a row may pluralise ("atomic-visits covered by…").
 * The four tokens share no prefix, so there is no ambiguity between them.
 */
export function namedArchetypes(text: string): string[] {
  if (!text) return [];
  const hits: string[] = [];
  for (const a of ARCHETYPES) {
    const rx = new RegExp(`(?<![A-Za-z0-9-])${a}s?(?![A-Za-z0-9-])`);
    if (rx.test(text)) hits.push(a);
  }
  return hits;
}

/**
 * The archetype a declaring row asserts, or null when it cannot be read
 * unambiguously.
 *
 * Returning null (rather than guessing) is deliberate: with no trustworthy
 * ground truth the rule must stay inert rather than invent one and flag every
 * other row against it.
 */
export function declaredArchetype(rows: readonly ArchetypeCheckRow[]): string | null {
  const row = rows.find((r) => r.id === ARCHETYPE_DECISION_ID);
  if (!row) return null;
  const named = namedArchetypes(row.value);
  return named.length === 1 ? named[0] : null;
}

/**
 * Flag every row whose acted-on value names an archetype the run is not.
 *
 * Inert — `{declared: null, findings: []}` — when the run has no
 * `archetype-selection` row, or when that row's value does not resolve to
 * exactly one archetype.
 */
export function checkArchetypeConsistency(
  rows: readonly ArchetypeCheckRow[],
): ArchetypeConsistencyResult {
  const declared = declaredArchetype(rows);
  if (!declared) return { declared: null, findings: [] };

  const findings: ArchetypeContradiction[] = [];

  for (const row of rows) {
    // The declaring row is NOT skipped. Its own value cannot contradict —
    // `declared` was read from it — but its `params.archetype` can, and that
    // is a contradiction worth catching rather than exempting. (A `continue`
    // here was dead code: mutation-testing it changed no result, which is the
    // vacuous-guard class `test/skills/negative-control-ratchet.test.ts`
    // exists to catch.)
    //
    // A row that has DECLARED it is reconciling disagreeing sources has already
    // said so in the schema's own vocabulary. Holding it to a single archetype
    // would punish the honest encoding.
    if (row.evidenceBasis === 'conflicting') continue;

    const explain = (field: string, named: string) =>
      `decision row \`${row.id}\` names archetype \`${named}\` in \`${field}\`, but this run ` +
      `declared \`${declared}\` in its \`${ARCHETYPE_DECISION_ID}\` row. Archetypes are ` +
      `first-class — every archetype-aware skill branches on the value — so two names for one ` +
      `run is a self-contradicting record, and it renders on the anonymous Decisions tab where ` +
      `an external reviewer reads it (ace#1859).`;

    const p = row.paramsArchetype;
    if (p && p !== declared && ARCHETYPES.includes(p)) {
      findings.push({
        id: row.id,
        field: 'params.archetype',
        named: p,
        declared,
        detail: explain('params.archetype', p),
      });
    }

    for (const named of namedArchetypes(row.value)) {
      if (named === declared) continue;
      findings.push({
        id: row.id,
        field: 'value',
        named,
        declared,
        detail: explain('its effective value', named),
      });
    }
  }

  return { declared, findings };
}
