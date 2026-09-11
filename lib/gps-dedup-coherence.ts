/**
 * Is a GPS de-duplication radius coherent with the GPS accuracy the build accepts?
 *
 * ## Why this exists
 *
 * ace#984 found a PDD that de-duplicated households at `< 15m` while the built
 * form accepted readings with accuracy up to 50 m. A 15 m discriminator over
 * 50 m readings carries no signal: honest neighbours flag as duplicates and real
 * duplicates read far apart. The fix (`_app-component-library.md §
 * threshold-coherence-flag` + `pdd-to-deliver-app-eval § threshold_coherence`)
 * compared the two numbers as a PAIR OF SCALARS and declared any radius at or
 * below the worst accepted accuracy incoherent.
 *
 * ace#2373: the PDD author resolved the same problem a third way, and the pair
 * of scalars cannot express it. Targeting PDD v1.1 §6 [FIXED]:
 *
 *   > Duplicates: same household identifiers, or same GPS point (< 15m) where
 *   > both readings have accuracy better than 15m. Where either reading is less
 *   > accurate than the radius, duplicate detection relies on identifiers alone.
 *
 * That rule is coherent BY CONSTRUCTION: the GPS test only runs on readings
 * precise enough to resolve the radius, whatever the form's overall tolerance.
 * The scalar comparison still said 15 <= 50 → incoherent, so the brief told the
 * builder its author's [FIXED] decision was a conflict, and the gate would have
 * penalised a correct design — or, worse, licensed a builder to "fix" it toward
 * #984's "raise the radius or tie them", which the author explicitly declined.
 *
 * Only an UNCONDITIONED radius at or below the worst accepted accuracy is the
 * incoherent case — the v1.0 wording, `same GPS point (< 15m)` against a 50 m
 * tolerance.
 *
 * ## The three inputs, and why a bare scalar is "unclear", not "incoherent"
 *
 * The rule reaches a reader in one of three shapes:
 *
 *  1. **Structured** — `program_parameters.duplicate_gps_rule`, the canonical
 *     key (`templates/pdd-template.md § Program Parameters`), as a YAML object
 *     `{radius_m, applies_when, fallback}` or as the PDD body table's one-line
 *     string `radius_m=15; applies_when=both_accuracies_below_radius;
 *     fallback=identifiers`.
 *  2. **Bare scalar** — `program_parameters.duplicate_gps_radius_m: 15`, the
 *     shape `poverty-graduation/20260908-0510` emitted before the canonical key
 *     existed. A scalar CANNOT say whether the radius was conditioned, so it is
 *     not the whole rule: `readGpsDedupRule` reports `condition: 'unknown'` and
 *     the classifier answers `unclear`, which sends the reader to the PDD's own
 *     sentence. Classifying the scalar as unconditioned is exactly how the
 *     condition got dropped on the way from the PDD to every downstream reader.
 *  3. **Wording** — the PDD sentence itself, via `parseGpsDedupWording`.
 *
 * ## What this module deliberately does NOT do
 *
 * It never proposes a value. When the verdict is `incoherent` the answer is a
 * build-memo entry naming the pair; picking the radius or the tolerance is the
 * PM's or the PDD author's decision, and a `[FIXED]` value is never moved by a
 * builder to satisfy this check. Noticing is ACE's job; choosing is not.
 *
 * `parseGpsDedupWording` is conservative in BOTH directions. It reports
 * `conditioned` only for an explicit both-readings accuracy clause, and
 * `unconditioned` only when the sentence never mentions accuracy at all.
 * Anything in between is `unknown` — a phrasing it does not recognise is not
 * evidence the condition is absent.
 */

/** The only condition that makes a radius coherent by construction. */
export const BOTH_ACCURACIES_BELOW_RADIUS = 'both_accuracies_below_radius' as const;

/** What the GPS test requires before it runs. */
export type GpsTestCondition =
  /** The GPS test runs regardless of reading accuracy. */
  | { kind: 'unconditioned' }
  /** The GPS test runs only when BOTH readings report accuracy better than `accuracy_below_m`. */
  | { kind: 'both-readings-accuracy-below'; accuracy_below_m: number }
  /** The source cannot say (a bare scalar, or wording this module does not recognise). */
  | { kind: 'unknown'; why: string };

export interface GpsDedupRule {
  radius_m: number;
  condition: GpsTestCondition;
  /** What decides duplicates when the GPS test does not run (e.g. `identifiers`), if stated. */
  fallback: string | null;
  source: 'structured' | 'bare-scalar' | 'wording';
}

export type GpsDedupVerdict = 'coherent' | 'incoherent' | 'unclear';

export type GpsDedupBasis =
  /** The GPS test only runs on readings precise enough to resolve the radius. */
  | 'accuracy-conditioned'
  /** Unconditioned, but the radius exceeds the worst accepted accuracy. */
  | 'radius-exceeds-tolerance'
  /** Unconditioned radius at or below the worst accepted accuracy — ace#984. */
  | 'radius-within-tolerance'
  /** Conditioned, but on an accuracy looser than the radius — the test still runs on readings too coarse to resolve it. */
  | 'condition-looser-than-radius'
  /** Whether the radius is conditioned cannot be read from this source. */
  | 'condition-unknown';

export interface GpsDedupClassification {
  verdict: GpsDedupVerdict;
  basis: GpsDedupBasis;
  detail: string;
  /** Non-verdict observations worth a build-memo line (e.g. no stated fallback). */
  notes: string[];
}

const UNIT = String.raw`\s*(?:m|metres|meters)\b`;
const NUM = String.raw`(\d+(?:\.\d+)?)`;

function toNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^\s*\d+(?:\.\d+)?\s*(?:m)?\s*$/i.test(v)) return parseFloat(v);
  return null;
}

function conditionFromAppliesWhen(appliesWhen: unknown, radius: number): GpsTestCondition {
  if (appliesWhen == null || appliesWhen === '' || appliesWhen === 'always') return { kind: 'unconditioned' };
  if (appliesWhen === BOTH_ACCURACIES_BELOW_RADIUS) {
    return { kind: 'both-readings-accuracy-below', accuracy_below_m: radius };
  }
  throw new Error(
    `duplicate_gps_rule.applies_when: unrecognised value ${JSON.stringify(appliesWhen)} — ` +
      `expected "${BOTH_ACCURACIES_BELOW_RADIUS}" or absent (unconditioned)`,
  );
}

/** Parse the PDD body table's one-line form: `radius_m=15; applies_when=...; fallback=identifiers`. */
function parseRuleString(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of s.split(/[;,]/)) {
    const m = part.match(/^\s*([a-z_]+)\s*[=:]\s*(.+?)\s*$/i);
    if (m) out[m[1].toLowerCase()] = m[2];
  }
  return out;
}

/**
 * Read the dedup rule from a `program_parameters` block (run_state YAML) or the
 * PDD body table (string values). Returns `null` when neither key is present.
 *
 * Throws on a malformed canonical rule — a `duplicate_gps_rule` with no numeric
 * `radius_m` or an unrecognised `applies_when` is an authoring error to fix
 * upstream, not something to guess past.
 */
export function readGpsDedupRule(params: Record<string, unknown>): GpsDedupRule | null {
  const structured = params.duplicate_gps_rule;
  if (structured != null) {
    const obj: Record<string, unknown> =
      typeof structured === 'string' ? parseRuleString(structured) : (structured as Record<string, unknown>);
    const radius = toNumber(obj.radius_m);
    if (radius === null) {
      throw new Error(`duplicate_gps_rule.radius_m: expected a number of metres, got ${JSON.stringify(obj.radius_m)}`);
    }
    const fallback = obj.fallback == null || obj.fallback === '' ? null : String(obj.fallback);
    return { radius_m: radius, condition: conditionFromAppliesWhen(obj.applies_when, radius), fallback, source: 'structured' };
  }
  const bare = toNumber(params.duplicate_gps_radius_m);
  if (bare !== null) {
    return {
      radius_m: bare,
      condition: {
        kind: 'unknown',
        why:
          'a bare `duplicate_gps_radius_m` scalar cannot say whether the radius is accuracy-conditioned — ' +
          "read the PDD's own duplicate-rule sentence (parseGpsDedupWording) before classifying",
      },
      fallback: null,
      source: 'bare-scalar',
    };
  }
  return null;
}

/**
 * Read the dedup rule from the PDD's own sentence(s). Returns `null` when no
 * GPS radius can be found at all.
 */
export function parseGpsDedupWording(text: string): GpsDedupRule | null {
  const t = text.replace(/\s+/g, ' ').replace(/≤/g, '<=');

  const radiusMatch =
    t.match(new RegExp(String.raw`\bGPS\b[^.;]*?(?:<=?|within|under|less than)\s*${NUM}${UNIT}`, 'i')) ??
    t.match(new RegExp(String.raw`\b(?:radius|point)\b[^.;]*?(?:<=?|within|under|of)\s*${NUM}${UNIT}`, 'i'));
  if (!radiusMatch) return null;
  const radius = parseFloat(radiusMatch[1]);

  // An explicit both-readings accuracy clause: "where both readings have accuracy
  // better than 15m", "each reading's accuracy is within the radius".
  const clause = t.match(
    new RegExp(
      String.raw`\b(?:both|each)\b[^.]*?\breadings?\b[^.]*?\baccura(?:cy|te)\b[^.]*?` +
        String.raw`(?:better than|below|under|less than|within|at most|<=?)\s*` +
        String.raw`(?:${NUM}${UNIT}|the (?:(?:dedup(?:lication)?|duplicate|GPS) )?radius)`,
      'i',
    ),
  );

  let condition: GpsTestCondition;
  if (clause) {
    const threshold = clause[1] !== undefined ? parseFloat(clause[1]) : radius;
    condition = { kind: 'both-readings-accuracy-below', accuracy_below_m: threshold };
  } else if (!/\baccura(?:cy|te)\b/i.test(t)) {
    condition = { kind: 'unconditioned' };
  } else {
    condition = {
      kind: 'unknown',
      why:
        'the sentence mentions accuracy but not as a both-readings condition this parser recognises — ' +
        'read it: a condition on only ONE reading does not make the radius coherent',
    };
  }

  const fallback =
    /\bidentifiers?\b[^.]*\balone\b|\brel(?:y|ies) on (?:\w+ )?identifiers?\b|\bidentifiers? only\b|\bfalls? back (?:on|to) (?:\w+ )?identifiers?\b/i.test(
      t,
    )
      ? 'identifiers'
      : null;

  return { radius_m: radius, condition, fallback, source: 'wording' };
}

/**
 * Classify the rule against the worst GPS accuracy the build accepts (read from
 * the geopoint hint + the `gps_accuracy_m` advisory branches, never from a
 * geopoint `constraint` — ace#1006).
 */
export function classifyGpsDedupCoherence(
  rule: GpsDedupRule,
  worstAcceptedAccuracyM: number,
): GpsDedupClassification {
  const r = rule.radius_m;
  const w = worstAcceptedAccuracyM;
  const notes: string[] = [];
  const c = rule.condition;

  if (c.kind === 'unknown') {
    return {
      verdict: 'unclear',
      basis: 'condition-unknown',
      detail: `radius ${r} m vs worst accepted accuracy ${w} m: ${c.why}`,
      notes,
    };
  }

  if (c.kind === 'both-readings-accuracy-below' && c.accuracy_below_m <= r) {
    if (rule.fallback === null) {
      notes.push(
        'the rule does not say what decides duplicates when either reading is too coarse for the GPS test — ' +
          'record that in the build memo (it is not an incoherence)',
      );
    }
    return {
      verdict: 'coherent',
      basis: 'accuracy-conditioned',
      detail:
        `the ${r} m GPS test runs only when both readings report accuracy better than ${c.accuracy_below_m} m, ` +
        `so the ${w} m tolerance never feeds it — coherent by construction`,
      notes,
    };
  }

  if (r > w) {
    return {
      verdict: 'coherent',
      basis: 'radius-exceeds-tolerance',
      detail: `radius ${r} m exceeds the worst accepted accuracy ${w} m`,
      notes,
    };
  }

  if (c.kind === 'both-readings-accuracy-below') {
    return {
      verdict: 'incoherent',
      basis: 'condition-looser-than-radius',
      detail:
        `the ${r} m GPS test runs on readings with accuracy up to ${c.accuracy_below_m} m, ` +
        `too coarse to resolve the radius`,
      notes,
    };
  }

  return {
    verdict: 'incoherent',
    basis: 'radius-within-tolerance',
    detail:
      `an unconditioned ${r} m radius against readings accepted up to ${w} m carries no signal ` +
      `(ace#984) — surface it in the build memo; do not move either value`,
    notes,
  };
}
