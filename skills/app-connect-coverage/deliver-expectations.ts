/**
 * The Deliver half of `app-connect-coverage` Step 2, as a pure decision.
 *
 * Why it is code (dimagi-internal/ace#1327): the rule used to key off the
 * form's Nova TYPE — `registration` → expect `deliver_unit`, label-only
 * `survey` → `task`, otherwise LLM judgment defaulting to `deliver_unit`.
 * The Learn half of the same step already states the correct rule in these
 * words: "a `user_score` + selects shape does NOT by itself mean the form is
 * the gate — a baseline pre-test has exactly the same shape … **Decide by
 * role, not by shape**."
 *
 * An unpaid registration form is to `deliver_unit` exactly as a pre-test is
 * to `assessment`: same shape as the paid thing, must not be marked. On
 * bednet-check-2-visit the PDD's operating rule R2 is "only the follow-up
 * visit is paid; registration is not" — a requirement, taught in the Learn
 * app and tested by an item in the gating assessment. Type-keyed, that form
 * classified `missing` and Step 4 would have FIXED it: a deliver_unit on a
 * form the programme says is never payable, which Phase 4 can then wire a
 * payment unit to. And the repair runs through `configure_connect`, which is
 * REPLACE-ALL — so a wrong expectation rewrites the whole participant set.
 *
 * The mirror failure is quieter: the paid form on that app is `type: close`,
 * which no row covered, so it reached the right answer by DEFAULTING rather
 * than by knowing — and the same default produces the first failure in
 * reverse when the roles are swapped.
 *
 * `pddRole` is resolved by the skill from the PDD's § Deliver App
 * Specification (also carried as the typed handoff
 * `products.pdd.program_parameters.payable_stage`). Mapping prose to forms is
 * the model's job; deciding what the mapping IMPLIES is this module's, so the
 * implication is unit-testable and cannot drift.
 */

export type DeliverExpectation = 'deliver_unit' | 'task' | 'none';

/** How the expectation was reached — the report must say which. */
export type DecisionBasis = 'pdd-role' | 'type-heuristic' | 'llm-judgment';

export interface DeliverFormInput {
  uuid: string;
  name: string;
  /** Nova form type: registration | followup | close | survey | … */
  type: string;
  /** Does the form ask anything, or is it label-only? */
  hasInputs: boolean;
  /**
   * What the PDD says about paying for this form. Undefined = the PDD is
   * silent, which is the ONLY case where shape gets a vote.
   */
  pddRole?: 'payable' | 'not-payable';
}

export interface DeliverDecision {
  uuid: string;
  name: string;
  expected: DeliverExpectation;
  basis: DecisionBasis;
  /** True when the PDD said nothing and shape had to decide. */
  fellBack: boolean;
  why: string;
}

export function decideDeliverExpectations(forms: DeliverFormInput[]): DeliverDecision[] {
  return forms.map((f) => {
    if (f.pddRole === 'not-payable') {
      return {
        uuid: f.uuid,
        name: f.name,
        expected: 'none',
        basis: 'pdd-role',
        fellBack: false,
        why: `the PDD declares this stage NOT payable, so it must carry no deliver_unit whatever its Nova type (${f.type})`,
      };
    }
    if (f.pddRole === 'payable') {
      return {
        uuid: f.uuid,
        name: f.name,
        expected: 'deliver_unit',
        basis: 'pdd-role',
        fellBack: false,
        why: `the PDD declares this stage payable, so it expects a deliver_unit whatever its Nova type (${f.type})`,
      };
    }
    if (f.type === 'survey' && !f.hasInputs) {
      return {
        uuid: f.uuid,
        name: f.name,
        expected: 'task',
        basis: 'type-heuristic',
        fellBack: true,
        why: 'PDD silent on payability; a label-only survey asks nothing, so it is a task rather than a delivery',
      };
    }
    if (f.type === 'registration') {
      return {
        uuid: f.uuid,
        name: f.name,
        expected: 'deliver_unit',
        basis: 'type-heuristic',
        fellBack: true,
        why:
          'PDD silent on payability; falling back to the type heuristic (registration → deliver_unit). ' +
          'Record the fallback — this is the shape that misfired in ace#1327',
      };
    }
    return {
      uuid: f.uuid,
      name: f.name,
      expected: 'deliver_unit',
      basis: 'llm-judgment',
      fellBack: true,
      why:
        `PDD silent on payability and no type rule covers '${f.type}'; judge from the form's purpose and ` +
        'fields, defaulting to deliver_unit. Record the fallback',
    };
  });
}

export type DeliverObservationVerdict = 'match' | 'missing' | 'extra' | 'wrong';

/**
 * Compare expectation to what the app actually carries.
 *
 * `extra` is the verdict ace#1327 was missing: a `deliver_unit` on a form the
 * PDD says is unpaid is a defect to REMOVE, not coverage to preserve — the
 * same shape as the Learn side's "a pre-test carrying `assessment` is a
 * defect to remove, not coverage to preserve" (ace#1131).
 */
export function classifyDeliverObservation(
  expected: DeliverExpectation,
  observed: DeliverExpectation,
): DeliverObservationVerdict {
  if (expected === observed) return 'match';
  if (expected === 'none') return 'extra';
  if (observed === 'none') return 'missing';
  return 'wrong';
}
