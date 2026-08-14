/**
 * Does a Learn app's `result_pass` label claim more than the bank certifies?
 *
 * Why this exists (dimagi-internal/ace#1368, split out of #1250). On
 * bednet-check-2-visit/20260813-2333 the built label reads
 *
 * > **"You can now begin delivery work"**
 *
 * after examining TWO payment-model facts — directly contradicting the PDD's
 * own **D-1 residual**, which states the gate *"is not a competence
 * certification and must not be described as one"*. The PDD wrote the residual
 * honestly; the builder then wrote a label that violates it, and no gate
 * compared the two.
 *
 * The pass label is what the **worker reads**. A gate certifying two
 * payment-model facts, telling a worker they are ready to begin delivery work,
 * is a claim the programme explicitly disclaimed — and it is exactly the shape
 * a worker will reasonably rely on.
 *
 * Worth recording what that gate never tests: the follow-up **consent
 * re-affirmation**, the sole server-side payment predicate (`form_field_rules`
 * keys on `consent_confirmed`, per the same PDD's D-6). A worker can clear the
 * gate and still fail the only check that decides whether they get paid — so
 * when the caller knows that predicate, the finding names it.
 *
 * ## Two triggers, and the second is the strong one
 *
 * - **`readiness-overclaim`** — a broad readiness/competence claim over a
 *   SMALL bank. Relative, not absolute: the same sentence over a 14-rule
 *   curriculum is a reasonable summary, and flagging it would make this the
 *   always-fires class.
 * - **`contradicts-declared-scope`** — the PDD explicitly said the gate is not
 *   a competence certification and the label makes one anyway. That holds at
 *   ANY bank size, because the programme already decided.
 */

export interface PassLabelContext {
  /** The rules the bank actually tests, one entry per rule. */
  certifiedRules: string[];
  /** The PDD states the gate is NOT a competence certification. */
  declaredNotCompetence?: boolean;
  /**
   * A payment predicate the gate does not test at all, if the caller knows
   * one — named in the finding because clearing the gate then still does not
   * mean getting paid.
   */
  untestedPaymentPredicate?: string;
}

export type PassLabelFindingKind = 'readiness-overclaim' | 'contradicts-declared-scope';

export interface PassLabelFinding {
  kind: PassLabelFindingKind;
  detail: string;
}

export interface PassLabelReport {
  ok: boolean;
  findings: PassLabelFinding[];
  detail: string;
}

/**
 * Claims of general readiness to do the JOB — as opposed to having answered
 * the questions. Deliberately narrow: "Passed", "Well done", "You answered
 * both rules correctly" are all fine and must stay fine.
 */
const READINESS_CLAIM =
  /\b(?:can now (?:begin|start|do|carry out)|are now (?:qualified|certified|ready|approved)|you are ready to|cleared to (?:begin|start|work)|now (?:qualified|certified) to)\b/i;

/**
 * Below this, a broad readiness claim is out of proportion to what was tested.
 * Chosen so the live 2-item bank trips it and an ordinary curriculum does not.
 */
export const SMALL_BANK_CEILING = 5;

export function checkPassLabelScope(label: string, ctx: PassLabelContext): PassLabelReport {
  const text = (label ?? '').trim();
  if (!text) {
    return { ok: true, findings: [], detail: 'pass-label-scope: no label to judge' };
  }

  const findings: PassLabelFinding[] = [];
  const claims = READINESS_CLAIM.test(text);
  const bankSize = ctx.certifiedRules?.length ?? 0;

  if (claims && ctx.declaredNotCompetence) {
    findings.push({
      kind: 'contradicts-declared-scope',
      detail:
        'the PDD states this gate is NOT a competence certification and must not be described as ' +
        'one, and the pass label describes it as one anyway. The label is what the worker reads',
    });
  }
  // Independent, not an else: the live case is BOTH — a 2-item bank and an
  // explicit disclaimer — and naming both is what makes the finding
  // actionable rather than merely correct.
  if (claims && bankSize > 0 && bankSize <= SMALL_BANK_CEILING) {
    findings.push({
      kind: 'readiness-overclaim',
      detail:
        `the label claims general readiness to do the work, but the bank tests ${bankSize} rule(s) ` +
        `(${ctx.certifiedRules.join('; ')}). Scope the claim to what was actually examined`,
    });
  }

  if (findings.length === 0) {
    return {
      ok: true,
      findings,
      detail: `pass-label-scope: clean — the label claims no more than the ${bankSize} tested rule(s)`,
    };
  }

  const lines = [
    'pass-label-scope: the result_pass label overclaims —',
    ...findings.map((f) => `  [${f.kind}] ${f.detail}`),
  ];
  if (ctx.untestedPaymentPredicate) {
    lines.push(
      `  Note: the gate does not test ${ctx.untestedPaymentPredicate}, which is the payment ` +
        'predicate — a worker can clear this gate and still fail the only check that decides ' +
        'whether they get paid.',
    );
  }
  lines.push('  (dimagi-internal/ace#1368)');
  return { ok: false, findings, detail: lines.join('\n') };
}
