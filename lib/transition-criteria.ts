//
// Pure static check: does a journey whose pass criterion NAMES a state
// transition actually assert that the state MOVED?
//
// Why this exists: dimagi-internal/ace#1885. On
// `spark-facilitator/20260828-0703` the journey
// `journey-deliver-followup-preload` declared the structural criterion
// `case_state_updated_after_submit`, and the generated recipe asserted it as:
//
//   - assertVisible:
//       text: "Chilanga.*"
//       childOf: { id: "${SELECTOR:case-list-container}" }
//
// That proves the ROW EXISTS. It says nothing about whether the date on it
// advanced — which is the entire criterion. Behind it sat a real `blocks-e2e`
// defect: three submitted-and-synced community meetings dated 01 Sep did not
// advance Chilanga's `last_meeting_date` (stale at 08:40, 08:49 and 09:00),
// while the control case Nsanje Central updated correctly in the same frame,
// and Connect reported `delivered: 4`. **The harness went green.** Only the
// screenshot judge caught it, after the fact.
//
// The class: a criterion whose NAME asserts a state transition, verified by an
// assertion that would pass identically before and after that transition. The
// test cannot fail for the reason it exists.
//
// Same family as `lib/date-default-validate.ts` (ace#1081) and the
// Learn-module completeness rule (jjackson/ace#897): the defect is 100%
// mechanically detectable from the composed catalog + recipe, so it is a
// parser run BEFORE the recipe ships, not a rubric line an author must
// remember. Prose invariants fail under load; this one is a gate.
//
// What counts as PROOF of a delta — one of:
//
//   1. A captured-pair comparison. A capture step (`copyTextFrom`, or an
//      `evalScript` that writes `output.*`) EARLIER in the recipe, and a later
//      `assertTrue`/`assertFalse` whose expression references that capture.
//      This is the only shape that observes both sides of the transition.
//   2. A declared expected NEW value. The catalog entry states the criterion
//      as `{ name, expected_value }`, and the recipe asserts that literal —
//      and the literal is NOT also a navigation target earlier in the recipe
//      (a string the recipe TAPPED to get here is, by construction, present
//      before the transition, so asserting it proves nothing).
//
// Anything else is presence-only and is reported as a violation. As with
// ace#1081, "cannot statically verify" is never a pass: the caller must
// surface it, because a false pass here recreates exactly the silent green
// this module exists to prevent.
//

/**
 * Words that, appearing in a criterion's id or name, claim a STATE
 * TRANSITION — the value is expected to be different after the step than
 * before it. Matched on token boundaries (snake_case, kebab-case, camelCase
 * and spaces all split), so `case_state_updated_after_submit` matches on
 * `updated` while `update_form` does not match `updated`.
 */
export const TRANSITION_WORDS: readonly string[] = [
  'updated',
  'changed',
  'advanced',
  'incremented',
  'decremented',
  'refreshed',
  'moved',
  'cleared',
  'reset',
  'increased',
  'decreased',
];

/** A criterion as it appears in `app-test-cases.yaml`'s `structural_pass_criteria`. */
export type TransitionCriterionInput =
  | string
  | {
      name: string;
      /**
       * The specific NEW value the transition is expected to produce (e.g. the
       * post-submit date `01 Sep 2026`). Supplying it is what lets a
       * single-observation assertion count as proof — see shape 2 above.
       */
      expected_value?: string;
    };

/**
 * One flattened step of the composed Maestro recipe, in file order.
 * `command` is the Maestro command name (`tapOn`, `assertVisible`,
 * `copyTextFrom`, `assertTrue`, `inputText`, …); `text` is the step's matcher
 * text or expression, whichever the command carries.
 */
export interface RecipeStep {
  command: string;
  text?: string;
  id?: string;
}

export interface TransitionJourneyInput {
  /** Journey id from the catalog, e.g. `journey-deliver-followup-preload`. */
  id: string;
  /** The journey's `structural_pass_criteria`. */
  criteria: TransitionCriterionInput[];
  /** The composed recipe's steps, in order. */
  steps: RecipeStep[];
}

export type TransitionViolationReason =
  /** The recipe asserts nothing at all. */
  | 'no-assertions'
  /**
   * Every assertion would hold identically before and after the transition —
   * the ace#1885 shape (`assertVisible "Chilanga.*"` for
   * `case_state_updated_after_submit`).
   */
  | 'presence-only'
  /**
   * `expected_value` is a string the recipe already TAPS/TYPES earlier, so it
   * is on screen before the transition too — asserting it proves nothing.
   */
  | 'expected-value-is-a-navigation-target'
  /** `expected_value` was declared but no assertion in the recipe asserts it. */
  | 'expected-value-not-asserted';

export interface TransitionCriterionViolation {
  journeyId: string;
  /** The criterion name that claims the transition. */
  criterion: string;
  /** The transition word that triggered the check. */
  transitionWord: string;
  reason: TransitionViolationReason;
  /** What the recipe does assert, so the author can see the gap. */
  detail: string;
}

export interface TransitionCriteriaReport {
  journeysChecked: number;
  /** Criteria whose name claimed a transition (the ones this module judges). */
  transitionCriteriaChecked: number;
  violations: TransitionCriterionViolation[];
}

const CAPTURE_COMMANDS = new Set(['copyTextFrom', 'evalScript']);
const COMPARISON_COMMANDS = new Set(['assertTrue', 'assertFalse']);
const ASSERTION_COMMANDS = new Set([
  'assertVisible',
  'assertNotVisible',
  'assertTrue',
  'assertFalse',
  'assertNoDefectsWithAI',
  'assertWithAI',
]);
/** Commands that put a string on screen / act on one — never evidence of a delta. */
const NAVIGATION_COMMANDS = new Set([
  'tapOn',
  'doubleTapOn',
  'longPressOn',
  'inputText',
  'inputRandomText',
  'copyTextFrom',
  'scrollUntilVisible',
  'swipe',
]);

/** Split an id/name into lowercase word tokens across snake, kebab, camel and spaces. */
function tokenize(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

/** The transition word a criterion name claims, or null when it claims none. */
export function transitionWordIn(name: string): string | null {
  const tokens = new Set(tokenize(name));
  for (const w of TRANSITION_WORDS) {
    if (tokens.has(w)) return w;
  }
  return null;
}

function normalizeCriterion(c: TransitionCriterionInput): {
  name: string;
  expectedValue?: string;
} {
  if (typeof c === 'string') return { name: c };
  return {
    name: c.name,
    ...(c.expected_value !== undefined ? { expectedValue: c.expected_value } : {}),
  };
}

function isCapture(step: RecipeStep): boolean {
  if (step.command === 'copyTextFrom') return true;
  // An evalScript only captures when it writes into the shared output map.
  return step.command === 'evalScript' && /\boutput\s*\.\s*\w/.test(step.text ?? '');
}

function referencesACapture(step: RecipeStep): boolean {
  const expr = step.text ?? '';
  return /\boutput\s*\.\s*\w/.test(expr) || /\bmaestro\s*\.\s*copiedText\b/.test(expr);
}

/**
 * True when the recipe observes BOTH sides of the transition: a capture step
 * followed later by a comparison assertion that reads a captured value.
 */
function hasCapturedPairComparison(steps: RecipeStep[]): boolean {
  const firstCaptureIdx = steps.findIndex(isCapture);
  if (firstCaptureIdx === -1) return false;
  return steps
    .slice(firstCaptureIdx + 1)
    .some((s) => COMPARISON_COMMANDS.has(s.command) && referencesACapture(s));
}

function assertionsIn(steps: RecipeStep[]): RecipeStep[] {
  return steps.filter((s) => ASSERTION_COMMANDS.has(s.command));
}

function describeAssertions(steps: RecipeStep[]): string {
  const assertions = assertionsIn(steps);
  if (assertions.length === 0) return 'no assertion steps in the recipe';
  return assertions
    .map((a) => (a.text ? `${a.command} ${JSON.stringify(a.text)}` : a.command))
    .join('; ');
}

/**
 * Check every journey's transition-named criteria against what its recipe
 * actually asserts. Criteria whose names claim no transition are ignored —
 * `app_boots` and `no_crash` are presence criteria by design and are correct
 * as presence assertions.
 */
export function checkTransitionCriteria(
  journeys: TransitionJourneyInput[],
): TransitionCriteriaReport {
  const violations: TransitionCriterionViolation[] = [];
  let transitionCriteriaChecked = 0;

  for (const journey of journeys) {
    const steps = journey.steps ?? [];
    const pairProven = hasCapturedPairComparison(steps);
    const assertions = assertionsIn(steps);

    for (const raw of journey.criteria ?? []) {
      const { name, expectedValue } = normalizeCriterion(raw);
      const word = transitionWordIn(name);
      if (!word) continue;
      transitionCriteriaChecked++;

      if (pairProven) continue; // shape 1: both sides observed

      const base = { journeyId: journey.id, criterion: name, transitionWord: word };

      if (expectedValue !== undefined && expectedValue !== '') {
        const navIdx = steps.findIndex(
          (s) => NAVIGATION_COMMANDS.has(s.command) && (s.text ?? '').includes(expectedValue),
        );
        if (navIdx !== -1) {
          violations.push({
            ...base,
            reason: 'expected-value-is-a-navigation-target',
            detail:
              `expected_value ${JSON.stringify(expectedValue)} is also used by ` +
              `\`${steps[navIdx].command}\` at step ${navIdx + 1}, so it is on screen ` +
              'before the transition too — asserting it cannot prove the value moved',
          });
          continue;
        }
        const asserted = assertions.some((a) => (a.text ?? '').includes(expectedValue));
        if (asserted) continue; // shape 2: the specific new value is asserted
        violations.push({
          ...base,
          reason: 'expected-value-not-asserted',
          detail:
            `expected_value ${JSON.stringify(expectedValue)} is declared but no ` +
            `assertion in the recipe asserts it (${describeAssertions(steps)})`,
        });
        continue;
      }

      violations.push({
        ...base,
        reason: assertions.length === 0 ? 'no-assertions' : 'presence-only',
        detail:
          assertions.length === 0
            ? 'the recipe contains no assertion steps at all'
            : `every assertion is presence-only and would hold identically before and ` +
              `after the transition — ${describeAssertions(steps)}`,
      });
    }
  }

  return { journeysChecked: journeys.length, transitionCriteriaChecked, violations };
}

/** One-line-per-violation human summary for the Step 5 structural gate. */
export function formatTransitionCriteriaReport(report: TransitionCriteriaReport): string {
  if (report.violations.length === 0) {
    return (
      `transition-criteria: PASS (${report.transitionCriteriaChecked} transition-named ` +
      `criterion/criteria across ${report.journeysChecked} journey(s); each is proven by a ` +
      'before/after comparison or a declared expected new value)'
    );
  }
  const lines = report.violations.map(
    (v) =>
      `  [BLOCKER] ${v.journeyId} / ${v.criterion}: names a transition ` +
      `("${v.transitionWord}") but ${v.detail} [${v.reason}]`,
  );
  return [
    `transition-criteria: FAIL (${report.violations.length} of ` +
      `${report.transitionCriteriaChecked} transition-named criteria cannot fail for the ` +
      'reason they exist — ace#1885)',
    ...lines,
  ].join('\n');
}
