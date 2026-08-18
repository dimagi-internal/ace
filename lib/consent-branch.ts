/**
 * The consent-withdrawal branch: does the build resolve the collision between
 * consent element (c) and an unconditional required-field rule, and does it
 * say so?
 *
 * Why this exists (dimagi-internal/ace#1326). `_app-component-library.md §
 * consent-script-floor` mandates element **(c)** — the participant may stop
 * at any time, INCLUDING after being asked. A PDD that fires that floor
 * normally also states its observation fields as unconditionally required,
 * because that is the natural way to write a data-completeness rule. On the
 * withdrawal branch the two cannot both hold, and BOTH resolutions were
 * silently shippable:
 *
 *  - **Keep `required`, no `relevant`.** The worker who has just read aloud
 *    "you can stop at any time" must then interrogate the household that just
 *    withdrew, or put *something* in the fields to close the form. The fields
 *    cannot be legitimately answered, so what lands is **invented data** — in
 *    exactly the fields the programme's primary metric is computed from.
 *  - **Add `relevant: <consent> = 'yes'`.** Correct, and what this module
 *    treats as the right answer — but it silently changes an observable
 *    program fact, and it puts blank-observation records into a denominator
 *    the PDD defined with no exclusion.
 *
 * Nothing caught either. `pdd-to-deliver-app-eval § conditional_logic_match`
 * deducts for a MISSING or INVERTED relevance; an **added** relevance that
 * neuters a stated requirement was not a class it scored.
 * `field_answerability`'s relevance-reachability check passes both shapes,
 * because the gate is answered in an earlier group either way.
 *
 * So: element (c) wins — collecting data after a withdrawal is never the
 * right resolution — and the deviation must be **disclosed**, with the
 * denominator consequence named. Mechanical, and shared between the build
 * (`pdd-to-deliver-app`) and the grader (`pdd-to-deliver-app-eval`) so the
 * two cannot drift, the same way `lib/screen-shape.ts` is shared.
 */

export interface BuiltField {
  id: string;
  required: boolean;
  /** The `relevant` expression as built, if any. */
  relevant?: string;
}

export interface PddFieldSpec {
  id: string;
  required?: boolean;
  /** A relevance the PDD itself specified, in whatever prose form. */
  relevant?: string;
}

export type ConsentBranchKind =
  /** Required observation downstream of the consent gate, with no gate on it. */
  | 'ungated-required-after-consent'
  /** Correctly gated on consent AND named in the build memo. */
  | 'disclosed-consent-gate'
  /** Correctly gated on consent but the memo is silent. */
  | 'undisclosed-consent-gate'
  /** Required field carries an added relevance unrelated to consent. */
  | 'undisclosed-narrowing';

export interface ConsentBranchFinding {
  field: string;
  kind: ConsentBranchKind;
  detail: string;
}

export interface ConsentBranchReport {
  pass: boolean;
  findings: ConsentBranchFinding[];
}

export interface ConsentBranchOptions {
  /** The consent gate's field id. Absent = no consent gate; the check is inert. */
  consentField?: string;
  /** Field ids the build memo explicitly discloses as consent-gated. */
  disclosedInMemo?: string[];
  /**
   * The field ids this consent gate actually GOVERNS. When non-empty, only
   * these fields are checked.
   *
   * Absent (the default) means the gate governs the whole instrument, which is
   * right for a household-visit form where consent precedes every question.
   * It is WRONG for a form where consent governs one capture — an FCAP meeting
   * record whose photo-consent announcement covers the photograph, on a form
   * whose other fields are attendance counts nobody consents to individually.
   * Run unscoped there, this check flags every unrelated required field as
   * `ungated-required-after-consent` and hard-gates a correct build to `fail`.
   * dimagi-internal/ace#1509. Observed on spark-facilitator/20260817-1610,
   * whose PDD states explicitly
   * that FCAP meetings are open assemblies with no per-beneficiary consent.
   */
  governs?: string[];
}

function referencesConsent(relevant: string, consentField: string): boolean {
  return new RegExp(`(^|[^\\w])${consentField}([^\\w]|$)`).test(relevant);
}

export function checkConsentBranchCompleteness(
  built: BuiltField[],
  pdd: PddFieldSpec[],
  opts: ConsentBranchOptions = {},
): ConsentBranchReport {
  const { consentField, disclosedInMemo = [], governs = [] } = opts;
  if (!consentField) return { pass: true, findings: [] };
  const governed = new Set(governs);

  const spec = new Map(pdd.map((f) => [f.id, f]));
  const disclosed = new Set(disclosedInMemo);
  const findings: ConsentBranchFinding[] = [];

  for (const field of built) {
    if (field.id === consentField) continue;
    if (!field.required) continue;
    // Scoped gate: a consent that governs one capture says nothing about the
    // fields outside its scope. See ConsentBranchOptions.governs.
    if (governed.size > 0 && !governed.has(field.id)) continue;

    const declared = spec.get(field.id);
    // Only fields the PDD states as REQUIRED are in the collision. A field the
    // PDD never required is a different conversation (field_count_match).
    if (!declared?.required) continue;
    // A relevance the PDD itself specified is not a deviation at all.
    if (declared.relevant) continue;

    if (!field.relevant) {
      findings.push({
        field: field.id,
        kind: 'ungated-required-after-consent',
        detail:
          `required with no consent gate, so a household that withdraws cannot close the form without ` +
          `an answer it has no way to give — what lands is invented data, in a field the programme's ` +
          `primary metric is computed from. Gate it on ${consentField} (element (c) wins over a literal ` +
          `completeness rule) and disclose the deviation`,
      });
      continue;
    }

    if (!referencesConsent(field.relevant, consentField)) {
      findings.push({
        field: field.id,
        kind: 'undisclosed-narrowing',
        detail:
          `required in the PDD with no relevance specified, but built with ` +
          `relevant="${field.relevant}", which does not reference ${consentField} — an undisclosed ` +
          `narrowing of a stated requirement`,
      });
      continue;
    }

    findings.push({
      field: field.id,
      kind: disclosed.has(field.id) ? 'disclosed-consent-gate' : 'undisclosed-consent-gate',
      detail:
        `gated on ${consentField} — the correct resolution of the element-(c) collision. ` +
        (disclosed.has(field.id)
          ? `Disclosed in the build memo. Denominator consequence: any metric computed over this field ` +
            `now excludes withdrawn-consent records that the PDD's denominator does not exclude — say so ` +
            `where the metric is defined`
          : `NOT disclosed in the build memo. The build is right and the record is wrong: this silently ` +
            `changes an observable program fact and alters a denominator the PDD defined without an ` +
            `exclusion`),
    });
  }

  const pass = findings.every((f) => f.kind === 'disclosed-consent-gate');
  return { pass, findings };
}
