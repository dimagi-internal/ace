/**
 * Does an `app-screenshot-capture` verdict still describe the capture manifest
 * it was written against?
 *
 * Two contracts already existed as prose, and both were unenforced:
 *
 *   - `skills/app-screenshot-capture/SKILL.md` (the Step 5 HARD RULE, ace#756):
 *     *"The shallow verdict MUST NOT be `pass` if any required journey's recipe
 *     failed."*
 *   - The recovery direction nobody wrote down until ace#1830: a leg that FAILED
 *     in-run and was later recovered rewrites the manifest, but the verdict that
 *     graded the empty capture set is left behind asserting the failure as
 *     current.
 *
 * On `hh-poverty-targeting/20260828-0702` the second one shipped. The manifest
 * (modified 15:08Z) recorded `journeys[].status: pass` on BOTH legs and 144
 * captures; `app-screenshot-capture_verdict-shallow.yaml` (last written 14:10Z)
 * still carried `overall_score: 3.0`, `verdict: fail`, and a `[BLOCKER]` reading
 * *"no Deliver screenshots exist for this run"* — false as of 15:02Z. `opp-eval`
 * aggregates verdict files by directory discovery and Phase 9's `llo-launch`
 * reads them, so the run actively misreported itself to every downstream
 * consumer for five hours, in the direction that keeps a healthy run gated.
 *
 * The structural verdict got a hand-written `# STALE AS OF` banner and a
 * `correction:` block; the shallow one got neither. That is the tell: the
 * contract was being honoured BY HAND on one file and not the other, which is
 * the shape of every convention in this codebase that fails under load.
 *
 * So this is the missing test, not a missing decision — CLAUDE.md § Gotchas:
 * *a gotcha with an enforcing test gets one line naming the enforcement; the
 * test is the invariant.*
 *
 * It keys on data that ALREADY EXISTS on both sides — the manifest's
 * `journeys[].status` against the verdict's `per_item[].verdict` — rather than
 * on a new staleness stamp. A timestamp field would need every writer to
 * remember to set it, which is the same by-hand honouring that failed here; two
 * independently-produced facts that must agree cannot be forgotten into
 * agreement.
 *
 * REPORT, never throw. The caller decides what a disagreement means — the
 * ace#1238 lesson is that a guard which predicts and pre-empts an outcome ships
 * the guess, not the fact.
 */

/** One entry of the capture manifest's `journeys[]` block. */
export interface ManifestJourneyLike {
  /** e.g. `journey-deliver-submit` (the `app-test-cases.yaml` slug). */
  journey_id?: string;
  /** e.g. `deliver` — the key the verdict's `per_item[].ref` uses. */
  app?: string;
  /** e.g. `journey-deliver`. */
  recipe_base?: string;
  /** The leg's disposition. `pass` means captures for this leg exist. */
  status?: string;
  /** Fallback when a manifest predates the `status` key. */
  recipe_status?: string;
  [k: string]: unknown;
}

export interface JourneyManifestLike {
  journeys?: ManifestJourneyLike[];
  [k: string]: unknown;
}

/** One entry of a verdict's `per_item[]` (`lib/verdict-schema.ts` PerItemSchema). */
export interface VerdictPerItemLike {
  ref?: string;
  /**
   * `PerItemVerdictSchema` is `pass | warn | fail`, but the ace#1830 file
   * carried `incomplete` here — off-schema and still the thing a reader
   * believes. Typed as a plain string so the check reads what is actually
   * written rather than what the schema wishes were written.
   */
  verdict?: string;
  score?: number;
  [k: string]: unknown;
}

export interface VerdictLike {
  /** Top-level disposition. Not compared — this check is per-leg. */
  verdict?: string;
  per_item?: VerdictPerItemLike[];
  [k: string]: unknown;
}

export type DisagreementKind =
  /**
   * Manifest says the leg PASSED; the verdict records it failed or
   * ungradeable. The verdict is stale — it describes a capture set that no
   * longer exists. ace#1830.
   */
  | 'stale-verdict'
  /**
   * Manifest says the leg did NOT pass; the verdict records it `pass`. The
   * verdict is unsupported — it grades screenshots that, per the Step 5 hard
   * rule, do not exist. ace#756.
   */
  | 'unsupported-pass'
  /**
   * The verdict reports per-leg dispositions but says nothing about this leg.
   * Only reported when `per_item[]` is non-empty: a verdict carrying no
   * `per_item` at all (the documented incomplete-mode shape, blocked before
   * grading) makes no per-leg claim, so there is nothing to disagree with.
   */
  | 'unreported-leg';

export interface LegComparison {
  /** The leg's reporting key — `app` when present, else `journey_id`. */
  leg: string;
  journeyId?: string;
  manifestStatus?: string;
  /** The `per_item[].ref` that matched, if any. */
  verdictRef?: string;
  verdictDisposition?: string;
  agrees: boolean;
}

export interface LegDisagreement extends LegComparison {
  kind: DisagreementKind;
  /** The issue whose class this instance belongs to. */
  citation: string;
  message: string;
}

export interface VerdictManifestAgreement {
  /** True iff `disagreements` is empty. */
  ok: boolean;
  disagreements: LegDisagreement[];
  /** Every leg the manifest declared, agreeing or not. Audit trail. */
  compared: LegComparison[];
  /**
   * `per_item[].ref` values that matched no manifest journey. Advisory only —
   * a verdict may legitimately carry refs that are not capture legs.
   */
  unmatchedRefs: string[];
}

function norm(v: unknown): string {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

function journeys(manifest: JourneyManifestLike | undefined | null): ManifestJourneyLike[] {
  const list = manifest?.journeys;
  return Array.isArray(list) ? list.filter((j): j is ManifestJourneyLike => !!j && typeof j === 'object') : [];
}

function perItems(verdict: VerdictLike | undefined | null): VerdictPerItemLike[] {
  const list = verdict?.per_item;
  return Array.isArray(list)
    ? list.filter((p): p is VerdictPerItemLike => !!p && typeof p === 'object')
    : [];
}

/** The leg's disposition, preferring `status` and falling back to `recipe_status`. */
export function manifestLegStatus(journey: ManifestJourneyLike): string | undefined {
  const s = typeof journey.status === 'string' ? journey.status : undefined;
  if (s !== undefined) return s;
  return typeof journey.recipe_status === 'string' ? journey.recipe_status : undefined;
}

/** The label this leg is reported under. `app` first — that is what `ref` uses. */
export function legLabel(journey: ManifestJourneyLike): string {
  const app = typeof journey.app === 'string' ? journey.app.trim() : '';
  if (app) return app;
  const id = typeof journey.journey_id === 'string' ? journey.journey_id.trim() : '';
  if (id) return id;
  const base = typeof journey.recipe_base === 'string' ? journey.recipe_base.trim() : '';
  return base || '(unnamed leg)';
}

/**
 * Candidate keys a `per_item[].ref` may use for this leg. Observed live:
 * manifest `app: deliver` ↔ verdict `ref: deliver`, with `journey_id`
 * (`journey-deliver-submit`) and `recipe_base` (`journey-deliver`) as the
 * older spellings the change log records.
 */
function refKeys(journey: ManifestJourneyLike): string[] {
  const keys = new Set<string>();
  for (const raw of [journey.app, journey.journey_id, journey.recipe_base]) {
    const n = norm(raw);
    if (!n) continue;
    keys.add(n);
    if (n.startsWith('journey-')) keys.add(n.slice('journey-'.length));
  }
  return [...keys];
}

/**
 * Compare a capture manifest's per-leg statuses against a verdict's per-leg
 * dispositions and name every disagreement.
 *
 * Neither side is treated as authoritative: the point is that two files which
 * must describe the same run currently do not, and a human (or the skill's own
 * Step 9) decides which one is behind.
 */
export function checkVerdictManifestAgreement(
  manifest: JourneyManifestLike | undefined | null,
  verdict: VerdictLike | undefined | null,
): VerdictManifestAgreement {
  const legs = journeys(manifest);
  const items = perItems(verdict);
  const verdictReportsLegs = items.length > 0;

  const compared: LegComparison[] = [];
  const disagreements: LegDisagreement[] = [];
  const matchedRefs = new Set<string>();

  for (const journey of legs) {
    const leg = legLabel(journey);
    const journeyId = typeof journey.journey_id === 'string' ? journey.journey_id : undefined;
    const manifestStatus = manifestLegStatus(journey);
    const keys = refKeys(journey);

    let match = items.find((p) => keys.includes(norm(p.ref)));
    if (!match) {
      // Last resort for a manifest with no `app` key: a ref that is a distinct
      // substring of exactly one journey id. Ambiguity is not a match.
      const candidates = items.filter((p) => {
        const r = norm(p.ref);
        return !!r && keys.some((k) => k.includes(r) || r.includes(k));
      });
      if (candidates.length === 1) match = candidates[0];
    }
    if (match?.ref) matchedRefs.add(String(match.ref));

    const verdictDisposition = typeof match?.verdict === 'string' ? match.verdict : undefined;
    const manifestPassed = norm(manifestStatus) === 'pass';
    const verdictPassed = norm(verdictDisposition) === 'pass';

    const base: LegComparison = {
      leg,
      journeyId,
      manifestStatus,
      verdictRef: typeof match?.ref === 'string' ? match.ref : undefined,
      verdictDisposition,
      agrees: true,
    };

    if (!match) {
      if (verdictReportsLegs) {
        const d: LegDisagreement = {
          ...base,
          agrees: false,
          kind: 'unreported-leg',
          citation: 'dimagi-internal/ace#1830',
          message:
            `Leg '${leg}' is recorded in the manifest as status '${manifestStatus ?? '(unset)'}' ` +
            `but the verdict's per_item[] does not mention it, so the verdict is silent on a leg ` +
            `that ran. Add a per_item entry whose ref matches one of: ${keys.join(', ')}.`,
        };
        disagreements.push(d);
        compared.push(d);
      } else {
        compared.push(base);
      }
      continue;
    }

    if (manifestPassed && !verdictPassed) {
      const d: LegDisagreement = {
        ...base,
        agrees: false,
        kind: 'stale-verdict',
        citation: 'dimagi-internal/ace#1830',
        message:
          `Leg '${leg}' passed in the manifest (status: ${manifestStatus}) but the verdict grades ` +
          `it '${verdictDisposition ?? '(unset)'}'. If this leg was recovered after the verdict was ` +
          `written, the verdict is stale and must be re-scored against the recovered captures — ` +
          `not left asserting a failure that has been repaired.`,
      };
      disagreements.push(d);
      compared.push(d);
      continue;
    }

    if (!manifestPassed && verdictPassed) {
      const d: LegDisagreement = {
        ...base,
        agrees: false,
        kind: 'unsupported-pass',
        citation: 'jjackson/ace#756',
        message:
          `Leg '${leg}' did NOT pass in the manifest (status: ${manifestStatus ?? '(unset)'}) but the ` +
          `verdict grades it 'pass'. Per the Step 5 hard rule, a leg whose recipe did not return ` +
          `status:pass has NO screenshots in this run, so there is nothing a pass could have been ` +
          `graded over.`,
      };
      disagreements.push(d);
      compared.push(d);
      continue;
    }

    compared.push(base);
  }

  const unmatchedRefs = items
    .map((p) => (typeof p.ref === 'string' ? p.ref : ''))
    .filter((r) => r && !matchedRefs.has(r));

  return { ok: disagreements.length === 0, disagreements, compared, unmatchedRefs };
}

/** One-line-per-disagreement rendering for a verdict's `auto_surfaced` or a log. */
export function formatAgreementFindings(result: VerdictManifestAgreement): string[] {
  return result.disagreements.map((d) => `[${d.kind}] (${d.citation}) ${d.message}`);
}
