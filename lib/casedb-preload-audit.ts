//
// Fail a build whose per-encounter form ASKS a question and then answers it
// from the case before the worker arrives.
//
// On `spark-facilitator/20260828-0703`'s released Deliver CCZ, **35 of the
// form's 36 visible inputs** carried a Nova-emitted
//
//     <setvalue ref="/data/<group>/<field>"
//               value="instance('casedb')/casedb/case[@case_id=…]/<field>"
//               event="xforms-ready"/>
//
// The one exception was the photo, an `<upload>`. So a CBF returning to a
// community met the previous meeting's ENTIRE record already filled in —
// including `date_of_meeting`, `meeting_conducted` and `meeting_type`, the two
// fields Connect's payability predicate reads — and could file a byte-identical
// duplicate by tapping Next through every screen and taking one new photo.
// Every value is internally consistent, so no constraint fires and nothing
// warns.
//
// That single mechanism produced FOUR separate BLOCKERs in the deep app-UX
// verdict, none of which named it:
//
//   - "the community case's durable state does not advance on a real meeting"
//     (the date preloaded, so `last_meeting_date`, calculated from it, never moved)
//   - "the meeting geopoint preloads from the previous visit and self-certifies"
//   - "attendance and participation preload … with zero taps"
//   - and a meeting that did NOT happen advancing the case
//
// Three of those were investigated as separate product defects, and the first
// was investigated three times as a case-write bug that never existed.
//
// ── Why a static CCZ check and not a device run ─────────────────────────────
//
// The ground truth here is the compiled form XML, which states what ALWAYS
// happens; a device run shows what happened once. This is the ace#1236 case
// exactly — deterministic structure, so a unit test on the artifact is the
// better authority, and it runs at Phase 3 instead of burning Phase 6.
//
// ── Why the rule is "visible input" and not a curated field list ────────────
//
// A per-encounter form asks a question BECAUSE the answer is specific to this
// encounter. If the answer were carryable, the form would not ask. So a visible
// input that preloads from the case is a contradiction in the design regardless
// of which field it is, and a per-field allowlist would just be a place for the
// next one to hide. Genuinely carried context (a household denominator, a step
// pointer) belongs in a hidden field or the case list — not in a question.
//
// Legitimate exceptions exist and are handled by DECLARATION, not by guessing:
// pass `allow` for a field the brief consciously wants carried, and the reason
// is then visible in the diff.
//

/** A casedb-backed preload found in a compiled form. */
export interface CasedbPreload {
  /** The `ref` the setvalue targets, e.g. `/data/attendance/male_attendance`. */
  ref: string;
  /** The case property being read. */
  property: string;
  /** True when the same ref is also a visible question in the form body. */
  visible: boolean;
}

export interface PreloadAuditResult {
  /** Every casedb preload found, visible or not. */
  preloads: CasedbPreload[];
  /** Visible questions answered from the case — the defect class. */
  violations: CasedbPreload[];
  /** Visible inputs in the form body. */
  visibleInputCount: number;
  /** Declared exceptions that were honoured. */
  allowed: string[];
}

const SETVALUE_RE =
  /<setvalue\s+ref="([^"]+)"\s+value="([^"]*)"\s+event="[^"]*"\s*\/?>/g;

/**
 * Answerable questions in the body.
 *
 * `<trigger>` is deliberately EXCLUDED: it is a display-only node (a consent
 * script to read aloud, a GPS-accuracy message) with no answer to preload, so
 * counting it inflates the denominator and understates the ratio. The
 * spark-facilitator meeting form has four of them; including them turned a true
 * "35 of 36" into a misleading "35 of 40".
 */
const VISIBLE_RE = /<(?:input|select1|select|upload|range)\b[^>]*\bref="([^"]+)"/g;

const CASEDB_VALUE_RE = /instance\('casedb'\)/;
/** …/case[@case_id=…]/<property> — the property is the last path step. */
const PROPERTY_RE = /\/([A-Za-z0-9_.-]+)\s*$/;

/** Visible question refs in a compiled form's body. */
export function visibleInputRefs(formXml: string): Set<string> {
  const out = new Set<string>();
  for (const m of formXml.matchAll(VISIBLE_RE)) out.add(m[1]);
  return out;
}

/** Every `xforms-ready` setvalue that reads from casedb. */
export function casedbPreloads(formXml: string): { ref: string; property: string }[] {
  const out: { ref: string; property: string }[] = [];
  for (const m of formXml.matchAll(SETVALUE_RE)) {
    const [, ref, value] = m;
    if (!CASEDB_VALUE_RE.test(value)) continue;
    const p = PROPERTY_RE.exec(value);
    out.push({ ref, property: p ? p[1] : '<unparsed>' });
  }
  return out;
}

/**
 * Audit one compiled form. A visible question answered from the case is a
 * violation unless its ref appears in `allow`.
 *
 * @param formXml  the form's compiled XML, as read from the CCZ
 * @param allow    refs the brief consciously carries forward
 */
export function auditCasedbPreloads(
  formXml: string,
  allow: readonly string[] = [],
): PreloadAuditResult {
  const visible = visibleInputRefs(formXml);
  const allowSet = new Set(allow);

  const preloads: CasedbPreload[] = casedbPreloads(formXml).map((p) => ({
    ...p,
    visible: visible.has(p.ref),
  }));

  const allowed: string[] = [];
  const violations: CasedbPreload[] = [];
  for (const p of preloads) {
    if (!p.visible) continue;
    if (allowSet.has(p.ref)) {
      allowed.push(p.ref);
      continue;
    }
    violations.push(p);
  }

  return { preloads, violations, visibleInputCount: visible.size, allowed };
}

/**
 * Human-readable gate output. Leads with the ratio, because "35 of 36" is the
 * number that makes the severity obvious where a list of refs does not.
 */
export function formatPreloadAudit(result: PreloadAuditResult, formPath: string): string {
  const { violations, visibleInputCount, allowed } = result;

  if (violations.length === 0) {
    const tail = allowed.length ? ` (${allowed.length} declared exception(s))` : '';
    return `[PASS] ${formPath}: no visible question is answered from the case${tail}.`;
  }

  const lines = [
    `[BLOCKER] ${formPath}: ${violations.length} of ${visibleInputCount} visible ` +
      `question(s) are answered from the case before the worker arrives.`,
    '',
    'A per-encounter form asks a question because the answer is specific to this',
    'encounter. Preloading it means a worker who taps through re-files the',
    'previous encounter verbatim, with every value internally consistent, so no',
    'constraint fires and nothing warns.',
    '',
  ];
  for (const v of violations) {
    lines.push(`  - ${v.ref}  <- casedb/${v.property}`);
  }
  lines.push(
    '',
    'Fix in the app brief: drop the case binding from these questions, or move',
    'genuinely carried context into a hidden field / the case list. If a field',
    'must carry forward, declare it as an allowed exception so the reason is',
    'visible in the diff.',
  );
  return lines.join('\n');
}
