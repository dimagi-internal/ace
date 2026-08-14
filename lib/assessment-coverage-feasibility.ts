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

/** The best weighted coverage an `itemCount`-item bank can possibly reach. */
export function maxAchievableCoverage(input: { itemCount: number } & RuleEnumeration): number {
  const total = totalWeight(input);
  if (total === 0) return 1;
  const ci = Math.min(input.itemCount, input.counterIntuitiveRules);
  const ops = Math.min(Math.max(0, input.itemCount - input.counterIntuitiveRules), input.highConsequenceOps);
  return Math.min(1, (2 * ci + ops) / total);
}

/** The rubric's score ceiling for a coverage ratio. */
export function coverageBandCeiling(ratio: number): number {
  if (ratio >= 0.9) return 10;
  if (ratio >= 0.7) return 8;
  if (ratio >= 0.5) return 6;
  return 3;
}

/** Fewest items that can reach `band`. */
export function minimumItemsForBand(e: RuleEnumeration, band: number): number {
  const total = totalWeight(e);
  if (total === 0) return 0;
  const need = band * total;
  let weight = 0;
  for (let n = 1; n <= e.counterIntuitiveRules + e.highConsequenceOps; n++) {
    weight += n <= e.counterIntuitiveRules ? 2 : 1;
    if (weight >= need) return n;
  }
  return e.counterIntuitiveRules + e.highConsequenceOps;
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
