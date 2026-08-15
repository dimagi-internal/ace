/**
 * Can a PDD's mandated assessment item count reach the coverage band
 * `pdd-to-learn-app-eval § assessment_rule_coverage` requires?
 *
 * Why this exists (dimagi-internal/ace#1250): `idea-to-pdd` can mandate an
 * item count that makes it ARITHMETICALLY IMPOSSIBLE for the resulting Learn
 * app to pass, and nothing checked the two against each other. Phase 1 then
 * ships a PDD that pre-commits Phase 3 to a `fail`, and the builder is graded
 * down for obeying its brief.
 *
 * Live: bednet-check-2-visit/20260813-2333. The PDD mandated "exactly 2
 * questions" and forbade adding, dropping or reordering items. The rubric
 * enumerated 3 counter-intuitive rules and 7 high-consequence Deliver
 * operations, weighted counter-intuitive double, and produced weighted
 * coverage **4/13 = 0.31** → the `<0.50` band → dimension 3.0 → `[BLOCKER]` →
 * overall 7.52 → `fail`.
 *
 * That is the rubric working as designed: it is the out-of-chain fitness axis,
 * deliberately not anchored inside the AI authoring chain, and PDD thinness is
 * a finding rather than an exemption. The defect is that Phase 1 had no way to
 * know, and the auto-fix loop cannot converge — it is capped at one round
 * against an immovable number.
 *
 * The blast radius outlives the run: it PERMANENTLY PINS `/ace:iterate` at 0%
 * on the opp, because the loop's clean gate requires
 * `pdd-to-learn-app-eval == pass` and no build of that PDD can produce one.
 * Same shape as ace#1031, reached by a different route.
 *
 * ## The arithmetic
 *
 * Coverage is the fraction of (counter-intuitive rules ∪ high-consequence
 * operations) carrying ≥1 qualifying item, with **counter-intuitive weighted
 * double**. The best an N-item bank can do is spend items on the
 * double-weighted rules first, then spill onto the operations — one rule per
 * item, since an item that "covers" two rules covers neither well enough to
 * qualify.
 *
 * ## The declared-deviation channel
 *
 * A PDD may legitimately scope a gate narrowly (bednet's D-1 certifies two
 * payment-model facts and says so). Today it has no way to tell the eval, so
 * an honest, argued deviation reads identically to an oversight. A declared
 * deviation is honoured — but only when it (a) states a ceiling the mandate
 * can actually reach, and (b) gives a reason. A deviation that claims MORE
 * coverage than the item count permits, or gives no reason, is an escape
 * hatch, not a decision.
 */

export interface RuleEnumeration {
  /** Taught rules where ordinary common sense produces the WRONG answer. */
  counterIntuitiveRules: number;
  /** Instrument fields or steps whose mishandling costs a payment or a form. */
  highConsequenceOps: number;
}

export interface CoverageDeviation {
  /** The coverage ratio the PDD accepts as its ceiling. */
  acceptedMaxRatio: number;
  /** Why the narrow scope is correct. An unexplained exemption is not one. */
  reason: string;
}

export interface FeasibilityInput extends RuleEnumeration {
  /** The exact count the PDD mandates. Undefined = the PDD mandates none. */
  itemCount?: number;
  declaredDeviation?: CoverageDeviation;
  /** Band the eval must reach to avoid the ≤3 hard-gate. */
  band?: number;
}

/** Total weight of the denominator: counter-intuitive rules count double. */
function totalWeight(e: RuleEnumeration): number {
  return 2 * e.counterIntuitiveRules + e.highConsequenceOps;
}

/**
 * The best weighted coverage an `itemCount`-item bank can possibly reach.
 *
 * ## One rule per item was wrong (ace#1433)
 *
 * This used to assume an item covers exactly one entry, justified as "an item
 * that covers two rules covers neither well enough to qualify". That is
 * empirically false, and it under-estimated the ceiling badly enough to write a
 * wrong number into a shipped PDD: for `{itemCount: 6, CI: 4, ops: 7}` it
 * declared 0.667 as the ceiling and the built bank measured 0.867 (13/15) on
 * bednet-check-2-visit/20260814-2019. The PDD then stated that "reaching the
 * next band (0.7) would require 7 items, which the source forbids" — and the
 * build reached 0.867 with six.
 *
 * The rubric's qualifying test is *does answering REQUIRE the rule*, and a
 * single item can require two. That PDD's own blueprint mandates it: item q6
 * keys on R6 + R7 with a distractor that is only excluded by R7 and two only
 * excluded by R6, so the key is unreachable knowing either alone. q5 covers
 * both observation operations (key = the union, distractors = proper subsets).
 *
 * The error direction was safe — it declares a feasible mandate infeasible, so
 * it never let a bad PDD through — but it is not free: a judge grading against
 * the declared ceiling under-scores a build that beat it, and it pushes
 * `idea-to-pdd` toward inflating the item count or declaring an
 * `assessment_coverage_deviation` that is not needed, which is exactly the
 * escape hatch ace#1250 built the channel to keep honest.
 *
 * `maxEntriesPerItem` defaults to 1, so every existing caller keeps its
 * current answer and only a caller whose blueprint actually pairs rules opts
 * in. Pairing is capped at the double-weighted entries first, because that is
 * where a single question can genuinely require two rules; spilling onto the
 * operations still costs one item each.
 */
export function maxAchievableCoverage(
  input: {
    itemCount: number;
    maxEntriesPerItem?: number;
    pairedItems?: number;
  } & RuleEnumeration,
): number {
  const total = totalWeight(input);
  if (total === 0) return 1;

  const perItem = Math.max(1, Math.floor(input.maxEntriesPerItem ?? 1));
  // How many items the blueprint actually pairs. Defaulting to ALL of them
  // would swing the error to the dangerous side — a ceiling nothing can reach
  // declares an infeasible mandate feasible. On the repro run only 3 of 6
  // items were paired, and assuming all six returns 1.000 against a measured
  // 0.867.
  const paired = Math.min(
    input.itemCount,
    Math.max(0, Math.floor(input.pairedItems ?? (perItem > 1 ? input.itemCount : 0))),
  );

  // Entry capacity of the bank: paired items carry up to `perItem` entries
  // each, the rest carry one.
  const capacity = paired * perItem + (input.itemCount - paired);

  // Counter-intuitive rules are worth double, so capacity is spent there first.
  const ci = Math.min(capacity, input.counterIntuitiveRules);
  const ops = Math.min(capacity - ci, input.highConsequenceOps);
  return Math.min(1, (2 * ci + ops) / total);
}

/** The rubric's score ceiling for a coverage ratio. */
export function coverageBandCeiling(ratio: number): number {
  if (ratio >= 0.9) return 10;
  if (ratio >= 0.7) return 8;
  if (ratio >= 0.5) return 6;
  return 3;
}

/**
 * Fewest items that can reach `band`.
 *
 * Walks the same model as `maxAchievableCoverage` and so had the same
 * one-entry-per-item error (ace#1433) — it is the number a PDD quotes when it
 * says "reaching 0.7 would require N items", so an inflated N reads as a
 * source constraint the design does not actually have.
 */
export function minimumItemsForBand(
  e: RuleEnumeration,
  band: number,
  opts: { maxEntriesPerItem?: number; pairedItems?: number } = {},
): number {
  const total = totalWeight(e);
  if (total === 0) return 0;
  const need = band * total;
  const cap = e.counterIntuitiveRules + e.highConsequenceOps;
  for (let n = 1; n <= cap; n++) {
    // `pairedItems` cannot exceed the bank being tried.
    const paired =
      opts.pairedItems === undefined ? undefined : Math.min(opts.pairedItems, n);
    if (
      maxAchievableCoverage({
        ...e,
        itemCount: n,
        maxEntriesPerItem: opts.maxEntriesPerItem,
        pairedItems: paired,
      }) *
        total >=
      need
    ) {
      return n;
    }
  }
  return cap;
}

export interface FeasibilityVerdict {
  feasible: boolean;
  /** Best reachable coverage under the mandate; null when none is mandated. */
  maxRatio: number | null;
  /** Score ceiling that ratio implies. */
  ceilingScore: number | null;
  /** Items needed to clear the band. */
  minimumItems: number | null;
  honouredDeviation: boolean;
  detail: string;
}

export function checkCoverageFeasibility(input: FeasibilityInput): FeasibilityVerdict {
  const band = input.band ?? 0.5;
  if (input.itemCount === undefined) {
    return {
      feasible: true,
      maxRatio: null,
      ceilingScore: null,
      minimumItems: null,
      honouredDeviation: false,
      detail: 'the PDD mandates no exact item count, so the builder is free to size the bank to the rules',
    };
  }

  const maxRatio = maxAchievableCoverage({ ...input, itemCount: input.itemCount });
  const ceilingScore = coverageBandCeiling(maxRatio);
  const minimumItems = minimumItemsForBand(input, band);
  const reachable = maxRatio >= band;

  if (reachable) {
    return {
      feasible: true,
      maxRatio,
      ceilingScore,
      minimumItems,
      honouredDeviation: false,
      detail: `a ${input.itemCount}-item bank can reach ${(maxRatio * 100).toFixed(0)}% coverage, clearing the ${band} band`,
    };
  }

  const dev = input.declaredDeviation;
  if (dev) {
    if (!dev.reason?.trim()) {
      return {
        feasible: false,
        maxRatio,
        ceilingScore,
        minimumItems,
        honouredDeviation: false,
        detail:
          'the PDD declares a coverage deviation with no stated reason — an unexplained exemption is an ' +
          'escape hatch, not a decision. State why the narrow scope is correct, as the PDD does for every ' +
          'other deviation',
      };
    }
    if (dev.acceptedMaxRatio > maxRatio + 1e-9) {
      return {
        feasible: false,
        maxRatio,
        ceilingScore,
        minimumItems,
        honouredDeviation: false,
        detail:
          `the PDD declares a ceiling of ${(dev.acceptedMaxRatio * 100).toFixed(0)}% but a ` +
          `${input.itemCount}-item bank cannot exceed ${(maxRatio * 100).toFixed(0)}%. A deviation must ` +
          'accept what the mandate actually permits',
      };
    }
    return {
      feasible: true,
      maxRatio,
      ceilingScore,
      minimumItems,
      honouredDeviation: true,
      detail:
        `coverage is capped at ${(maxRatio * 100).toFixed(0)}% by the ${input.itemCount}-item mandate, and ` +
        `the PDD accepts it explicitly: "${dev.reason}". Grade assessment_rule_coverage against the ` +
        'declared ceiling and surface a [WARN] rather than a [BLOCKER]',
    };
  }

  return {
    feasible: false,
    maxRatio,
    ceilingScore,
    minimumItems,
    honouredDeviation: false,
    detail:
      `mandating exactly ${input.itemCount} item(s) against ${input.counterIntuitiveRules} counter-intuitive ` +
      `rule(s) + ${input.highConsequenceOps} high-consequence operation(s) caps weighted coverage at ` +
      `${(maxRatio * 100).toFixed(0)}% — below the ${band} band, so assessment_rule_coverage cannot score ` +
      `above ${ceilingScore} and the phase pre-commits to a [BLOCKER]. Either mandate at least ` +
      `${minimumItems} items, or state the shortfall as an explicit deviation with acceptedMaxRatio ` +
      `<= ${maxRatio.toFixed(2)} and a reason, which the eval will honour`,
  };
}
