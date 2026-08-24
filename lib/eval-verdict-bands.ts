/**
 * Terminal verdict bands for `-eval` rubrics — totality + mutual exclusivity.
 *
 * An `-eval` rubric ends by mapping a vector of dimension scores onto exactly
 * one terminal verdict (`pass` | `warn` | `fail`). The mapping lives in prose
 * in the rubric's SKILL.md and is applied by an LLM judge at grade time, so a
 * band set that does not partition the score space never throws — the judge
 * silently legislates, and two runs with identical scores can disagree.
 *
 * That is exactly what ace#1568 caught in `pdd-to-deliver-app-eval`: three
 * INDEPENDENT band tests (`any dim <=3 -> fail`, `2+ dims in 4-6 -> warn`,
 * `all dims >=7 AND overall >=7.5 -> pass`) left two reachable classes
 * matching nothing —
 *
 *   1. exactly ONE dimension in 4-6 and none <=3 (the reported case: live on
 *      `spark-facilitator/20260820-0817`, `language_conformance` 5.0 with
 *      every other dimension >=8), and
 *   2. every dimension >=7 but overall < 7.5 (not reported, found by the
 *      enumeration below; reachable at, e.g., all dimensions exactly 7.0)
 *
 * — while 41 further classes matched TWO rules at once (`fail` + `warn`
 * whenever some dimension is <=3 and two others sit in 4-6).
 *
 * `pdd-to-learn-app-eval` had the same defect, strictly larger (ace#1578): its
 * § 5 stated ONLY the `fail` trigger — no `pass` band and no `warn` band at all
 * — so the entire non-fail half of the space was homeless. It mirrors the
 * Deliver cascade exactly (operator decision, Jon).
 *
 * The repair is an ORDERED cascade, first match wins, with a catch-all tail.
 * This module encodes it as data and ships the enumerator that proves the
 * property, so the next rubric revision does not have to re-derive the
 * arithmetic by hand.
 *
 * `incomplete` and `partial` (see `lib/verdict-schema.ts`) are gradability
 * states resolved BEFORE the cascade — a missing artifact, a HITL stub, a
 * live probe that failed at grading time — not bands within it. They are
 * deliberately out of scope here.
 */

/** The graded terminal tiers, most severe first. */
export const TERMINAL_VERDICTS = ['fail', 'warn', 'pass'] as const;
export type TerminalVerdict = (typeof TERMINAL_VERDICTS)[number];

/** Severity rank — higher is more severe. Used to check cascade ordering. */
export function severityRank(v: TerminalVerdict): number {
  return TERMINAL_VERDICTS.length - 1 - TERMINAL_VERDICTS.indexOf(v);
}

/**
 * What a band rule may read. `scores` excludes `null` dimensions (the rubric's
 * N/A rule redistributes their weight before the mean is taken), `overall` is
 * the post-cap weighted mean the verdict YAML reports, and `blocker` is a
 * § 5b standing-instruction hard-gate.
 */
export interface BandContext {
  scores: number[];
  overall: number;
  blocker: boolean;
}

export interface BandRule {
  verdict: TerminalVerdict;
  /** Human-readable restatement of the SKILL.md prose, for failure messages. */
  label: string;
  test: (ctx: BandContext) => boolean;
}

/**
 * The canonical three-rule ordered cascade. ONE definition, instantiated per
 * rubric — `pdd-to-deliver-app-eval` shipped it for ace#1568 and
 * `pdd-to-learn-app-eval` adopted it verbatim for ace#1578 (operator decision,
 * Jon: mirror the sibling bands exactly). A second rubric hand-rolling the
 * arithmetic is precisely what this module exists to prevent, so add rubrics by
 * calling this, not by copying the array.
 *
 * Each rubric gets its OWN array instance (rules are data, and a future rubric
 * may legitimately diverge) while the arithmetic stays in one place.
 */
export function standardOrderedCascade(): BandRule[] {
  return [
    {
      verdict: 'fail',
      label: 'any scored dimension <= 3, or any § 5b hard-gate [BLOCKER]',
      test: ({ scores, blocker }) => blocker || scores.some((s) => s <= 3),
    },
    {
      verdict: 'warn',
      // `< 7`, NOT "in the 4-6 range". Scores are fractional (every rubric
      // anchor is stated at the half-point), so a range trigger strands
      // 3 < s < 4 and 6 < s < 7 — the ace#1568 trap, re-flagged on ace#1578.
      label: 'any scored dimension < 7, or overall < 7.5',
      test: ({ scores, overall }) => scores.some((s) => s < 7) || overall < 7.5,
    },
    {
      verdict: 'pass',
      // Stated as a real predicate, not `() => true`. A catch-all tail makes
      // totality trivially true and hides exactly the class these rubrics had.
      label: 'every scored dimension >= 7 and overall >= 7.5',
      test: ({ scores, overall }) => scores.every((s) => s >= 7) && overall >= 7.5,
    },
  ];
}

/**
 * `skills/pdd-to-deliver-app-eval/SKILL.md § 5 Deduction rules` — the ordered
 * cascade, as shipped for ace#1568. Keep this list and the prose in lockstep;
 * `test/lib/eval-verdict-bands.test.ts` asserts they agree.
 */
export const DELIVER_APP_BANDS: BandRule[] = standardOrderedCascade();

/**
 * `skills/pdd-to-learn-app-eval/SKILL.md § 5 Deduction rules` — the same
 * ordered cascade, adopted for ace#1578. That rubric previously stated ONLY
 * the `fail` trigger, so the whole non-fail half of the space was homeless and
 * the judge picked `pass` vs `warn` at grade time.
 *
 * The Learn rubric's own `fail` triggers are UNCHANGED and all still fire
 * through rule 1: the `language_conformance` hard-fail anchors, the
 * `assessment_gating` / `instructional_depth` hard-gates (each drives its
 * dimension to <= 3), and the § 5b `naming_convention` / `form_navigation` /
 * `single_gating_assessment` `[BLOCKER]`s (the `blocker` flag). The cascade
 * sits underneath them.
 */
export const LEARN_APP_BANDS: BandRule[] = standardOrderedCascade();

/** The band set as it read BEFORE ace#1568 — three independent tests, no
 *  catch-all. Kept so the enumerator has a known-defective input to prove it
 *  can still detect the class it was written for. */
export const DELIVER_APP_BANDS_PRE_1568: BandRule[] = [
  {
    verdict: 'fail',
    label: 'any single dimension <= 3 (or a § 5b [BLOCKER])',
    test: ({ scores, blocker }) => blocker || scores.some((s) => s <= 3),
  },
  {
    verdict: 'warn',
    label: '2+ dimensions in 4-6 range',
    test: ({ scores }) => scores.filter((s) => s >= 4 && s <= 6).length >= 2,
  },
  {
    verdict: 'pass',
    label: 'all scored dimensions >= 7 AND overall >= 7.5',
    test: ({ scores, overall }) => scores.every((s) => s >= 7) && overall >= 7.5,
  },
];

/** The Learn band set as it read BEFORE ace#1578: the `fail` trigger and
 *  nothing else. § 5 stated no `pass` band and no `warn` band at all, so every
 *  vector that is not failing matched ZERO rules — a strictly larger gap than
 *  ace#1568's two homeless classes. Kept as a live regression witness so the
 *  auditor cannot pass vacuously. */
export const LEARN_APP_BANDS_PRE_1578: BandRule[] = [
  {
    verdict: 'fail',
    label: 'any single dimension <= 3 (or a § 5b [BLOCKER]) — the ONLY stated band',
    test: ({ scores, blocker }) => blocker || scores.some((s) => s <= 3),
  },
];

/** Apply the cascade: first rule whose test fires wins. */
export function classifyTerminalVerdict(
  rules: BandRule[],
  ctx: BandContext,
): { verdict: TerminalVerdict; ruleIndex: number } | null {
  for (let i = 0; i < rules.length; i++) {
    if (rules[i].test(ctx)) return { verdict: rules[i].verdict, ruleIndex: i };
  }
  return null;
}

/** Weighted mean with the rubric's N/A redistribution: `null` dimensions drop
 *  out and the remaining weights are renormalized. */
export function weightedOverall(scores: (number | null)[], weights: number[]): number {
  let num = 0;
  let den = 0;
  for (let i = 0; i < scores.length; i++) {
    const s = scores[i];
    if (s === null) continue;
    num += s * weights[i];
    den += weights[i];
  }
  return den === 0 ? 0 : num / den;
}

export interface BandGap {
  /** Which class of vector: the score vector itself. */
  scores: number[];
  overall: number;
  blocker: boolean;
  /** Verdicts of every rule that fired. Empty = uncovered. */
  matched: TerminalVerdict[];
}

export interface BandAudit {
  vectorsChecked: number;
  /** Vectors matching ZERO rules — the totality failure. */
  uncovered: BandGap[];
  /** Vectors where a rule BELOW the one the cascade picked is strictly more
   *  severe, i.e. the cascade order launders a defect into a softer verdict. */
  misordered: BandGap[];
  /** Vectors matching more than one rule. Benign under cascade semantics as
   *  long as they are not `misordered`; reported for visibility. */
  overlapping: BandGap[];
}

/**
 * Walk a score space and audit a band set for totality and ordering.
 *
 * `vectors` is the enumeration to check. Callers supply it so the same
 * auditor serves an exhaustive small-rubric sweep and a class-partition sweep
 * of a 10-dimension rubric (where a full 0.5-granularity walk is 21^10).
 */
export function auditBands(
  rules: BandRule[],
  vectors: Iterable<{ scores: number[]; overall: number; blocker: boolean }>,
): BandAudit {
  const audit: BandAudit = { vectorsChecked: 0, uncovered: [], misordered: [], overlapping: [] };
  for (const v of vectors) {
    audit.vectorsChecked++;
    const matched = rules.filter((r) => r.test(v)).map((r) => r.verdict);
    const gap: BandGap = { scores: v.scores, overall: v.overall, blocker: v.blocker, matched };
    if (matched.length === 0) {
      audit.uncovered.push(gap);
      continue;
    }
    if (matched.length > 1) audit.overlapping.push(gap);
    const chosen = classifyTerminalVerdict(rules, v)!;
    const maxSeverity = Math.max(...matched.map(severityRank));
    if (severityRank(chosen.verdict) < maxSeverity) audit.misordered.push(gap);
  }
  return audit;
}

/**
 * Exhaustive cartesian walk of `dims` dimensions over `levels`.
 * Only feasible for small `dims` — 21^4 is 194,481, 21^10 is not.
 */
export function* exhaustiveVectors(
  dims: number,
  levels: number[],
  weights: number[],
  blockerStates: boolean[] = [false, true],
): Generator<{ scores: number[]; overall: number; blocker: boolean }> {
  const idx = new Array(dims).fill(0);
  for (;;) {
    const scores = idx.map((i) => levels[i]);
    const overall = weightedOverall(scores, weights);
    for (const blocker of blockerStates) yield { scores, overall, blocker };
    let k = dims - 1;
    while (k >= 0 && ++idx[k] === levels.length) idx[k--] = 0;
    if (k < 0) return;
  }
}

/**
 * Class-partition walk for a rubric too wide to brute-force. The band rules
 * read only three predicates of the vector — how many dimensions sit at or
 * below 3, how many in 4-6, and whether the weighted mean clears 7.5 — so
 * enumerating every (nLow, nMid, nHigh) partition realized at each band edge,
 * with the low scores placed on the heaviest and the lightest dimensions in
 * turn, covers every reachable equivalence class.
 */
export function* partitionVectors(
  weights: number[],
  opts: {
    low?: number[];
    mid?: number[];
    high?: number[];
    nullable?: number[];
    blockerStates?: boolean[];
  } = {},
): Generator<{ scores: number[]; overall: number; blocker: boolean }> {
  const dims = weights.length;
  const low = opts.low ?? [0, 1.5, 3];
  // 3.5 and 6.5 are deliberate: they sit OUTSIDE both the `<= 3` and the
  // `4-6` triggers, which is the second half of the ace#1568 gap.
  const mid = opts.mid ?? [3.5, 4, 5, 6, 6.5];
  const high = opts.high ?? [7, 7.5, 8, 9, 10];
  const nullable = opts.nullable ?? [];
  const blockerStates = opts.blockerStates ?? [false, true];
  const orders = [
    Array.from({ length: dims }, (_, i) => i),
    Array.from({ length: dims }, (_, i) => dims - 1 - i),
  ];
  // Also exercise the rubric's N/A rule: each nullable dimension dropped.
  const nullSets: number[][] = [[], ...nullable.map((d) => [d]), nullable];
  for (const nulls of nullSets) {
    const live = Array.from({ length: dims }, (_, i) => i).filter((i) => !nulls.includes(i));
    for (let nLow = 0; nLow <= live.length; nLow++) {
      for (let nMid = 0; nLow + nMid <= live.length; nMid++) {
        for (const lo of low) {
          for (const md of mid) {
            for (const hi of high) {
              for (const order of orders) {
                const ranked = order.filter((i) => live.includes(i));
                const full: (number | null)[] = new Array(dims).fill(null);
                ranked.forEach((slot, rank) => {
                  full[slot] = rank < nLow ? lo : rank < nLow + nMid ? md : hi;
                });
                const overall = weightedOverall(full, weights);
                const scores = full.filter((s): s is number => s !== null);
                if (scores.length === 0) continue;
                for (const blocker of blockerStates) yield { scores, overall, blocker };
              }
            }
          }
        }
      }
    }
  }
}
