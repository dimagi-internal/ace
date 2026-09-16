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
 *
 * ## Input contract — hand it the TREE (ace#2415)
 *
 * `built` is the blueprint's field tree as `get_form` / `get_app` returns it:
 * containers keep their `children`, and each node carries only the `relevant`
 * **declared on it**. This module resolves EFFECTIVE relevance itself — a field
 * is gated if it OR any enclosing container carries the condition.
 *
 * It reads that way because the original did not, and the failure was quiet in
 * the worst direction. The helper took a flat list and one per-field `relevant`
 * string; in a Nova blueprint the consent gate almost always sits on the
 * enclosing **group**, so every question inside a correctly gated group came
 * back `ungated-required-after-consent` — which hard-gates
 * `conditional_logic_match` to <= 3 and fails the suite. Run against
 * `poverty-graduation/20260915-1518`'s targeting form exactly as both callers
 * instruct, that was **14 false findings on a correct build**, each with a
 * paragraph of correct-sounding reasoning, on the one check those callers
 * explicitly say to run *instead of* eyeballing. The only field that passed did
 * so by accident: it happened to carry the gate on itself.
 *
 * This is the inverse of ace#1509, which closed the SCOPE gap ("the gate governs
 * too much" — see `ConsentBranchOptions.governs`). That one asked *which fields
 * the gate covers*; this one asks *where the gate is*.
 *
 * The resolution lives here rather than in a preprocessing step at each call
 * site because a caller that must flatten first is a caller that can forget to,
 * and both of them did — neither `_app-component-library.md §
 * consent-script-floor` nor `pdd-to-deliver-app-eval § conditional_logic_match`
 * mentioned flattening at all. Callers that want to SEE the resolution can call
 * `flattenEffectiveRelevance` directly.
 */

/**
 * One field AS THE BLUEPRINT CARRIES IT — a node in Nova's field tree, not a
 * pre-flattened leaf. Feed `get_form` / `get_app` output straight in; the
 * helper resolves effective relevance itself (see § Input contract above).
 */
export interface BuiltField {
  id: string;
  /** Nova's field kind (`group` / `repeat` / `section` / `text` / …). Informational. */
  kind?: string;
  /**
   * Nova writes this as `"true()"` / `"false()"` as readily as a boolean, so
   * both are accepted. An expression that is neither is treated as REQUIRED —
   * the conservative direction, because the alternative is silently skipping a
   * field this check exists to look at.
   */
  required?: boolean | string;
  /**
   * The `relevant` expression AS DECLARED ON THIS NODE. A plain string, or
   * Nova's structured `{parts:[…]}` shape. Leave it off a child whose gate sits
   * on the enclosing group — that is the normal blueprint shape, and the helper
   * walks to it rather than reading the absence as "ungated".
   */
  relevant?: unknown;
  /**
   * The `calculate` expression, when this is a hidden calculate. Read only to
   * resolve one hop of indirection out of a `relevant` — see `referencesConsent`.
   */
  calculate?: unknown;
  /** Children of a `group` / `repeat` / `section`. */
  children?: BuiltField[];
}

/**
 * A leaf as `flattenEffectiveRelevance` resolves it: the same field, with
 * `relevant` rewritten to the EFFECTIVE gate — its own expression conjoined
 * with every ancestor's, outermost first.
 */
export interface EffectiveField extends BuiltField {
  children?: undefined;
  /** The effective (inherited ∧ own) relevance. Undefined = genuinely ungated. */
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

/** `relevant` / `calculate` may be a string or Nova's structured `{parts:[…]}` shape. */
function exprText(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') return v.trim() || undefined;
  if (typeof v === 'object') {
    const parts = (v as { parts?: { text?: string; uuid?: string }[] }).parts;
    if (!Array.isArray(parts)) return undefined;
    return (
      parts
        .map((p) => p.text ?? p.uuid ?? '')
        .join(' ')
        .trim() || undefined
    );
  }
  return String(v).trim() || undefined;
}

/**
 * Nova writes `required` as `"true()"` / `"false()"` as readily as a boolean.
 * Anything else that is present counts as required — see `BuiltField.required`.
 */
function isRequired(v: unknown): boolean {
  if (typeof v !== 'string') return Boolean(v);
  const t = v.trim().toLowerCase();
  return t !== '' && t !== 'false' && t !== 'false()' && t !== '0';
}

function conjoin(chain: string[]): string | undefined {
  if (chain.length === 0) return undefined;
  if (chain.length === 1) return chain[0];
  return chain.map((e) => `(${e})`).join(' and ');
}

/**
 * Resolve every leaf's EFFECTIVE relevance: its own expression conjoined with
 * every enclosing container's, outermost first.
 *
 * Exported so a caller can see what the check saw — the finding details quote
 * the effective expression, and "where did that `and` come from" is the first
 * question a grader asks. A flat list of leaves flattens to itself, so this is
 * a no-op on already-resolved input.
 */
export function flattenEffectiveRelevance(
  fields: BuiltField[] | undefined,
  inherited: string[] = [],
): EffectiveField[] {
  const out: EffectiveField[] = [];
  for (const f of fields ?? []) {
    const own = exprText(f.relevant);
    const chain = own ? [...inherited, own] : inherited;
    if (f.children?.length) {
      out.push(...flattenEffectiveRelevance(f.children, chain));
      continue;
    }
    out.push({ ...f, children: undefined, relevant: conjoin(chain) });
  }
  return out;
}

/** Every field in the tree that carries a `calculate`, by id. */
function calculateIndex(
  fields: BuiltField[] | undefined,
  into = new Map<string, string>(),
): Map<string, string> {
  for (const f of fields ?? []) {
    const calc = exprText(f.calculate);
    if (calc) into.set(f.id, calc);
    if (f.children?.length) calculateIndex(f.children, into);
  }
  return into;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Does `expr` name `id`? Path-tolerant: a Nova reference is written
 * `#form/g_consent/consent` or `/data/consent`, and `/` is a non-word
 * character, so the last segment matches without special-casing the prefix.
 */
function namesField(expr: string, id: string): boolean {
  return new RegExp(`(^|[^\\w])${escapeRe(id)}([^\\w]|$)`).test(expr);
}

/**
 * Does this gate turn on the consent answer — directly, or through ONE hop of
 * hidden-calculate indirection?
 *
 * The hop is not a nicety. A build that routes consent through a named outcome
 * (`enrollment_outcome = if(#form/participation_consent = 'yes', 'enrolled',
 * 'declined')`) and gates its groups on `#form/enrollment_outcome = 'enrolled'`
 * is gated on consent in every sense that matters, but a purely syntactic match
 * never sees the consent field. Measured on `poverty-graduation/20260915-1518`'s
 * delivery form, where that shape produced two more false
 * `ungated-required-after-consent` findings even after ancestor relevance was
 * propagated (ace#2415).
 *
 * ONE hop, deliberately: it covers the observed shape, and a single step cannot
 * cycle. A deeper chain reads as `undisclosed-narrowing`, which still FAILS —
 * nothing here can silently disable the check.
 */
function referencesConsent(
  relevant: string,
  consentField: string,
  calculates: Map<string, string>,
): boolean {
  if (namesField(relevant, consentField)) return true;
  for (const [id, calc] of calculates) {
    if (id === consentField) continue;
    if (namesField(relevant, id) && namesField(calc, consentField)) return true;
  }
  return false;
}

export function checkConsentBranchCompleteness(
  built: BuiltField[],
  pdd: PddFieldSpec[],
  opts: ConsentBranchOptions = {},
): ConsentBranchReport {
  const { consentField, disclosedInMemo = [], governs = [] } = opts;
  if (!consentField) return { pass: true, findings: [] };
  const governed = new Set(governs);

  // Resolve the gate's LOCATION before asking whether it is there. In a Nova
  // blueprint the consent gate almost always sits on the enclosing group, not
  // on each child — reading only the per-field `relevant` reports every field
  // inside a correctly gated group as ungated. ace#2415.
  const leaves = flattenEffectiveRelevance(built);
  const calculates = calculateIndex(built);

  const spec = new Map(pdd.map((f) => [f.id, f]));
  const disclosed = new Set(disclosedInMemo);
  const findings: ConsentBranchFinding[] = [];

  for (const field of leaves) {
    if (field.id === consentField) continue;
    if (!isRequired(field.required)) continue;
    // Scoped gate: a consent that governs one capture says nothing about the
    // fields outside its scope. See ConsentBranchOptions.governs.
    if (governed.size > 0 && !governed.has(field.id)) continue;

    const declared = spec.get(field.id);
    // Only fields the PDD states as REQUIRED are in the collision. A field the
    // PDD never required is a different conversation (field_count_match).
    if (!isRequired(declared?.required)) continue;
    // A relevance the PDD itself specified is not a deviation at all.
    if (declared?.relevant) continue;

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

    if (!referencesConsent(field.relevant, consentField, calculates)) {
      findings.push({
        field: field.id,
        kind: 'undisclosed-narrowing',
        detail:
          `required in the PDD with no relevance specified, but built behind effective ` +
          `relevant="${field.relevant}" (its own plus every enclosing group's), which does not reach ` +
          `${consentField} — an undisclosed narrowing of a stated requirement`,
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
