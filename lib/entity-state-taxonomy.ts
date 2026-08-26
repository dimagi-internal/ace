/**
 * Does the built app use the PARTNER's entity-state vocabulary, or one it made up?
 *
 * Why this exists (dimagi-internal/ace#1564). For a `longitudinal-visits`
 * opportunity the entity's state model — the phase names and which
 * activity/step numbers belong to each phase — lived only as PROSE in the
 * PDD's § Entity Lifecycle. Nothing carried it into the Nova brief and nothing
 * in `pdd-to-deliver-app`'s brief-composition checklist asked for it, so the
 * architect — which needs those option sets to build the phase-filtered step
 * picker the archetype requires — invented them.
 *
 * On `spark-facilitator/20260820-0817` the PDD (sourced from Spark's own
 * published "FCAP Structure, Phases and Activities" guide) declared
 * `1 = Planning, steps 1-14` … `4 = Transition, steps 23-24`. The Deliver app
 * shipped `1 = "Introduction and community entry", steps 1-4` … `4 =
 * "Sustainability and graduation", steps 23-24`, and all 24 step names were
 * invented too. Three consequences, none of which any gate caught:
 *
 *  1. Learn and Deliver contradict each other — a worker trained on the PDD's
 *     mapping selects "Planning", lands in a different phase, and cannot find
 *     the step they were taught.
 *  2. Program Parameters that pin a pilot window to a sub-phase
 *     (`Goal Setting (Planning, Steps 1-7)`) stop mapping onto the built app.
 *  3. `no-inferred-backstory`, on a real partner: invented labels for the
 *     partner's OWN published process reach real field workers and, via the
 *     training deck, the partner.
 *
 * The failure has no downstream symptom, exactly like a wrong scorecard
 * (ace#1527): the app is complete, internally consistent, and passes every
 * structural gate. Only a diff against what the PDD DECLARED can see it.
 *
 * ## What this module deliberately does NOT do
 *
 * It ships **no canonical vocabulary**. There is no default state set, no
 * "enrolled / active / lapsed / graduated" fallback, and no normalisation of a
 * partner's words toward ACE's. Hard-coding a taxonomy would be the mirror
 * image of the reported defect and a worse one, because it would be
 * systematic. The only authority is what the PDD declares; when the PDD
 * declares nothing, `parseStateTaxonomy` returns `declared: false` and the
 * caller HALTS with a finding rather than filling the gap.
 */

/** One state the PDD declares, as the app must ship it. */
export interface DeclaredState {
  /** The option VALUE — what the app stores (e.g. `1`, `planning`). */
  value: string;
  /** The partner's own label for that state, verbatim. */
  label: string;
  /**
   * The activity/step numbers that belong to this state, expanded. Empty when
   * the taxonomy carries no step partition (a legitimate shape — not every
   * entity lifecycle numbers its activities).
   */
  steps: number[];
}

export interface ParsedTaxonomy {
  /**
   * False when the PDD declares no taxonomy at all — an unfilled template
   * placeholder, an empty cell, or an explicit `n/a`. This is the HALT signal:
   * absence is a Phase-1 gap to surface, never a licence to invent.
   */
  declared: boolean;
  states: DeclaredState[];
  /**
   * The source document the PDD names as the authority for this vocabulary,
   * when it names one (`[source: ...]`). The build must READ that file out of
   * the run's frozen `inputs/` rather than enumerate from a summary table.
   */
  source: string | null;
  /** Every way the declaration itself is malformed. Non-empty => do not build. */
  problems: string[];
}

const ABSENT = new Set(['', 'n/a', 'na', 'none', 'tbd', 'unknown', '-', '—']);

/** Template placeholders read as `[...]`; an unfilled row is an absent row. */
function isPlaceholder(raw: string): boolean {
  return /^\[.*\]$/.test(raw.trim());
}

function normaliseLabel(label: string): string {
  return label
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.;,]+$/, '')
    .toLowerCase();
}

function expandSteps(spec: string, problems: string[], where: string): number[] {
  const out: number[] = [];
  for (const part of spec.split(',')) {
    const piece = part.trim();
    if (!piece) continue;
    const range = piece.match(/^(\d+)\s*(?:-|–|—|to)\s*(\d+)$/);
    if (range) {
      const lo = Number(range[1]);
      const hi = Number(range[2]);
      if (hi < lo) {
        problems.push(`${where}: inverted step range "${piece}"`);
        continue;
      }
      for (let n = lo; n <= hi; n++) out.push(n);
      continue;
    }
    if (/^\d+$/.test(piece)) {
      out.push(Number(piece));
      continue;
    }
    problems.push(`${where}: unparseable step spec "${piece}"`);
  }
  return out;
}

/**
 * Parse the PDD's declared entity state taxonomy.
 *
 * Grammar (one line, so it fits the § Program Parameters `| key | value |`
 * table — prose in § Entity Lifecycle is exactly where this got lost):
 *
 *   `<value>=<label> (steps <a>-<b>[, <c>]); <value>=<label> (steps ...) [source: <doc>]`
 *
 * The `(steps ...)` clause is optional per state; the trailing `[source: ...]`
 * clause is optional for the taxonomy.
 */
export function parseStateTaxonomy(raw: string | null | undefined): ParsedTaxonomy {
  const problems: string[] = [];
  const text = (raw ?? '').trim();
  if (ABSENT.has(text.toLowerCase()) || isPlaceholder(text)) {
    return { declared: false, states: [], source: null, problems };
  }

  let body = text;
  let source: string | null = null;
  const src = body.match(/\[source:\s*([^\]]+)\]\s*$/i);
  if (src && src.index !== undefined) {
    source = src[1].trim();
    body = body.slice(0, src.index).trim();
  }

  const states: DeclaredState[] = [];
  for (const entry of body.split(';')) {
    const chunk = entry.trim();
    if (!chunk) continue;
    const m = chunk.match(/^([^=]+)=(.+)$/);
    if (!m) {
      problems.push(`unparseable state entry "${chunk}" (expected "<value>=<label>")`);
      continue;
    }
    const value = m[1].trim();
    let label = m[2].trim();
    let steps: number[] = [];
    const stepsClause = label.match(/\(\s*steps?\s+([^)]+)\)\s*$/i);
    if (stepsClause && stepsClause.index !== undefined) {
      steps = expandSteps(stepsClause[1], problems, `state "${value}"`);
      label = label.slice(0, stepsClause.index).trim();
    }
    if (!value) problems.push(`state entry "${chunk}" has an empty value`);
    if (!label) problems.push(`state "${value}" has an empty label`);
    states.push({ value, label, steps });
  }

  if (states.length === 0) {
    problems.push('taxonomy is non-empty but declares no parseable states');
    return { declared: false, states, source, problems };
  }

  const seenValues = new Set<string>();
  const seenLabels = new Set<string>();
  for (const s of states) {
    if (seenValues.has(s.value)) problems.push(`duplicate state value "${s.value}"`);
    seenValues.add(s.value);
    const key = normaliseLabel(s.label);
    if (key && seenLabels.has(key)) problems.push(`duplicate state label "${s.label}"`);
    seenLabels.add(key);
  }

  // A step belonging to two states makes the picker non-deterministic and is
  // the signature of a re-partition applied on top of the real taxonomy.
  const owner = new Map<number, string>();
  for (const s of states) {
    for (const n of s.steps) {
      const prior = owner.get(n);
      if (prior !== undefined) {
        problems.push(`step ${n} belongs to both state "${prior}" and state "${s.value}"`);
      } else {
        owner.set(n, s.value);
      }
    }
  }

  return { declared: true, states, source, problems };
}

/** One state as the app actually shipped it, read back from the blueprint. */
export interface BuiltState {
  value: string;
  label: string;
  /** Omit (or leave empty) when the built app carries no step partition. */
  steps?: number[];
}

export interface TaxonomyDiff {
  /** True iff every finding list below is empty. */
  ok: boolean;
  /** Built option values the PDD never declared — invented states. */
  extraInBuild: string[];
  /** Declared states the app never shipped. */
  missingInBuild: string[];
  /** Same value, different words: the partner's label was rewritten. */
  relabelled: { value: string; declared: string; built: string }[];
  /** Same value, different member steps: the partition was moved. */
  repartitioned: { value: string; declared: number[]; built: number[] }[];
}

function sameSteps(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const x = [...a].sort((p, q) => p - q);
  const y = [...b].sort((p, q) => p - q);
  return x.every((n, i) => n === y[i]);
}

/**
 * Diff the state option set the app shipped against the taxonomy the PDD
 * declared. Pure set + label + partition comparison — no judgement, and no
 * tolerance band: these are the partner's own words.
 *
 * Learn/Deliver agreement is transitive: both apps are diffed against the same
 * declared taxonomy, so two clean diffs cannot disagree with each other.
 */
export function diffStateTaxonomy(input: {
  declared: DeclaredState[];
  built: BuiltState[];
}): TaxonomyDiff {
  const declaredBy = new Map(input.declared.map((s) => [s.value, s]));
  const builtBy = new Map(input.built.map((s) => [s.value, s]));

  const extraInBuild = input.built.map((s) => s.value).filter((v) => !declaredBy.has(v));
  const missingInBuild = input.declared.map((s) => s.value).filter((v) => !builtBy.has(v));

  const relabelled: TaxonomyDiff['relabelled'] = [];
  const repartitioned: TaxonomyDiff['repartitioned'] = [];
  for (const [value, decl] of declaredBy) {
    const built = builtBy.get(value);
    if (!built) continue;
    if (normaliseLabel(decl.label) !== normaliseLabel(built.label)) {
      relabelled.push({ value, declared: decl.label, built: built.label });
    }
    const builtSteps = built.steps ?? [];
    // Only compare the partition when BOTH sides carry one — an app that does
    // not number its activities is not thereby re-partitioning anything.
    if (decl.steps.length > 0 && builtSteps.length > 0 && !sameSteps(decl.steps, builtSteps)) {
      repartitioned.push({ value, declared: [...decl.steps], built: [...builtSteps] });
    }
  }

  return {
    ok:
      extraInBuild.length === 0 &&
      missingInBuild.length === 0 &&
      relabelled.length === 0 &&
      repartitioned.length === 0,
    extraInBuild,
    missingInBuild,
    relabelled,
    repartitioned,
  };
}

/** Human-readable finding lines for the build memo / verdict. */
export function describeTaxonomyDiff(diff: TaxonomyDiff): string[] {
  const out: string[] = [];
  for (const v of diff.extraInBuild) out.push(`invented state value "${v}" — not in the PDD`);
  for (const v of diff.missingInBuild) out.push(`declared state "${v}" missing from the build`);
  for (const r of diff.relabelled) {
    out.push(`state "${r.value}" relabelled: declared "${r.declared}", built "${r.built}"`);
  }
  for (const r of diff.repartitioned) {
    out.push(
      `state "${r.value}" re-partitioned: declared steps [${r.declared.join(', ')}], ` +
        `built steps [${r.built.join(', ')}]`,
    );
  }
  return out;
}
