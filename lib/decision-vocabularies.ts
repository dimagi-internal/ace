/**
 * Declared option vocabularies for the decisions that recur across runs.
 *
 * ## The measurement this exists for
 *
 * An override binds by exact string match against a row's `options`. Across
 * 22 runs of `spark-facilitator` + `hh-poverty-targeting`, the option set was
 * REGENERATED almost every run: `budget-plausibility` had 11 distinct option
 * sets in 12 runs, `candidate-llo-roster` 11 in 12, `payment-rate` 10 in 12.
 * Distinct option sets and distinct answers tracked each other almost
 * exactly — where the vocabulary churned, so did the answer.
 *
 * The counter-example is the proof: `archetype-selection` has **2 option sets
 * across 12 runs**, because its options come from ACE's own domain model
 * rather than being re-invented. It is the only decision on either opp with a
 * stable answer — `atomic-visit` ten times running.
 *
 * ## Anchoring does not freeze a decision
 *
 * `archetype-selection` on spark DID change — `atomic-visit` for ten runs,
 * then `longitudinal-visits` from `20260817-1610` onward. Because the
 * vocabulary was fixed, that reads as a decision changing rather than as
 * noise. A fixed vocabulary is what makes improvement DETECTABLE; free-text
 * options make every re-derivation look like a change and every real change
 * look like a re-derivation.
 *
 * ## What is deliberately NOT here
 *
 * Decisions whose real value is a number, a band, or a named entity —
 * `flw-count`, `payment-rate`, `wo-total-not-to-exceed-usd` — are not
 * enumerable and are not listed. Those are `value_set_by: external`: ACE
 * still picks a value and the run still proceeds, but the value is a
 * projection of something a solicitation response or a contract will fix.
 * Forcing them into an enum would be a lie about their nature.
 */

export interface Vocabulary {
  /** The closed option set. `ai-default` must be an exact member. */
  options: readonly string[];
  /** Why this set — kept next to the values so a later edit knows the intent. */
  note: string;
}

/**
 * Keyed by decision id. A catalogued id MUST draw its `options` from here;
 * an id absent from this map is unconstrained (the bar criterion lets a skill
 * raise a row nobody anticipated, and that must stay possible).
 */
export const DECISION_VOCABULARIES: Readonly<Record<string, Vocabulary>> = {
  'archetype-selection': {
    options: ['atomic-visit', 'longitudinal-visits', 'focus-group', 'multi-stage'],
    note:
      'ACE\'s delivery-archetype model. The one decision that was already anchored, and the only ' +
      'one with a stable answer across 22 runs — this map generalises that.',
  },
  'solicitation-type': {
    options: ['EOI', 'RFP', 'custom'],
    note: 'Connect solicitation kinds. Observed churn was pure casing: "EOI", "eoi", "EOI (default)".',
  },
  'solicitation-deadline': {
    options: ['7-days', '14-days', '21-days', '30-days'],
    note:
      'Answer was 14 days in all 22 runs, spelled four ways ("14 days", "14-days", "default-14-days", ' +
      '"14 days (default)"). A settled decision the log could not report as settled.',
  },
  'primary-metric-vs-goal': {
    options: ['direct-goal', 'upstream-proxy'],
    note:
      'Two real values under 19 spellings. Anchoring makes the genuine flips visible — hh-poverty ' +
      'flipped to direct twice and back, which is worth seeing.',
  },
  'verification-layers': {
    options: ['A', 'A+B', 'A+B+C'],
    note:
      'The evidence-model layer set. 19 spellings of 3 values. Put "Layer C partner-led" and similar ' +
      'qualifiers in `params.caveat`, not in the value.',
  },
  'wo-data-storage-region': {
    options: ['united-states', 'european-union', 'in-country'],
    note:
      'Answer was United States in all 22 runs; two spellings carried a real qualifier ("provisional", ' +
      '"pending Nigerian data-protection confirmation") which belongs in `params.caveat`.',
  },
  'wo-ethics-scope': {
    options: [
      'operational-no-personal-data',
      'operational-with-personal-data',
      'patient-level-clinical',
    ],
    note:
      'Substantively identical in all 22 runs — "operational, household PII, non-clinical" — phrased ' +
      '17 different ways. The clearest case of a settled decision the encoding could not express.',
  },
  'candidate-llo-roster': {
    options: ['public-only', 'named-plus-public', 'named-only'],
    note:
      'WHICH orgs are named goes in `params.named` — an enum alone would destroy that, which is why ' +
      'the fix is value+params rather than value alone.',
  },
  'duplicate-detection-key': {
    options: [
      'identifier-only',
      'identifier-plus-gps-radius',
      'identifier-plus-ranked-proximity',
      'gps-only',
    ],
    note:
      'This one genuinely IMPROVED across runs (fixed 15m radius -> ranked accuracy-weighted queue). ' +
      'Anchoring keeps that legible as an improvement instead of losing it in rewording. The exact ' +
      'field list belongs in `params.key_fields`.',
  },
};

export interface VocabularyCheck {
  ok: boolean;
  issues: string[];
}

/**
 * Check a row's options against the declared vocabulary for its id.
 *
 * Permissive by design in one direction: a row may offer a SUBSET (not every
 * archetype applies to every opp). It may not invent members — that is the
 * churn this closes.
 */
export function checkVocabulary(row: {
  id: string;
  options: readonly string[];
  'ai-default': string;
}): VocabularyCheck {
  const vocab = DECISION_VOCABULARIES[row.id];
  if (!vocab) return { ok: true, issues: [] };
  const issues: string[] = [];
  const allowed = new Set(vocab.options);
  const strays = row.options.filter((o) => !allowed.has(o));
  if (strays.length) {
    issues.push(
      `\`${row.id}\` is a catalogued decision: its \`options\` must be drawn from the declared ` +
        `vocabulary [${vocab.options.join(', ')}]. Not in it: [${strays.join(', ')}]. ` +
        `Put wording, qualifiers and specifics in \`reasoning\` or \`params\` — an option set that ` +
        `changes between runs cannot be matched by a saved reviewer override, which is why the ` +
        `override file had never bound a decision.`,
    );
  }
  if (row.options.length === 0) {
    issues.push(`\`${row.id}\` must offer at least one option from its vocabulary`);
  }
  return issues.length ? { ok: false, issues } : { ok: true, issues: [] };
}
