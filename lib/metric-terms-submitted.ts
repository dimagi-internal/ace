//
// Pure check: is every PDD § Success Metrics term the indicator layer needs
// actually SUBMITTED on the paid (Connect-received) Deliver form?
//
// Why this exists: dimagi-internal/ace#2590. Connect receives the paid form as
// visits and nothing else, so an indicator is computable from visit data only
// if every numerator / denominator term rides on that form. A value that lives
// on the CASE (or on an unpaid form, such as enrolment) has to be mirrored into
// the paid form as a hidden `calculate` for Connect to see it.
//
// Live on spark-facilitator/20261001-2208: PDD §8.2 S1 is "Households
// represented ÷ enrolled number_of_households". The released Community Meeting
// Record READ `#community/number_of_households` — inside the validate of
// `hh_represented_at_the_meeting` (`. >= 0 and . <= #community/number_of_households`)
// — and never submitted it: none of the nine hidden case-write mirrors carried
// it. Phase 7's semantic-registry-author then had to list S1 under "Not
// computable from visit data", so a partner-owned indicator silently vanished
// from every report while every Phase 3 gate passed. The 20260926-1800 build
// only had S1 because it happened to submit `form.enrolled_households`.
//
// Mapping a PDD's prose term ("enrolled households") to a field id or case
// property is a JUDGEMENT the caller makes once, explicitly, per term. What this
// module makes mechanical is the part that kept being skipped: given that
// mapping, does the paid form carry the value, and if it only READS it, where?
//

import { type CheckOutcome, checked, unable, formatUnable } from './check-outcome.js';

/** One field as read from Nova `get_form` (the subset this check needs). */
export interface PaidFormField {
  id: string;
  kind: string;
  calculate?: string;
  children?: PaidFormField[];
  /** Any other attribute (`relevant`, `validate`, `default_value`, …) is scanned for reads. */
  [key: string]: unknown;
}

/** Where the caller resolved a metric term's value to. */
export type MetricTermSource =
  /** A field captured (or calculated) on the paid form itself. */
  | { kind: 'field'; fieldId: string }
  /** A case property — must be mirrored into the paid form to be submitted. */
  | { kind: 'case'; property: string; caseType?: string }
  /**
   * Data visits do not carry at all (payment ledger, external survey, a
   * supervisor log). Declared not computable; `reason` is REQUIRED and goes
   * into the summary verbatim.
   */
  | { kind: 'external'; reason: string };

export interface MetricTerm {
  /** The PDD's metric id (`S1`, `P2`, …). */
  metric: string;
  role: 'numerator' | 'denominator' | 'value';
  /** The PDD's own words for the term, quoted. */
  term: string;
  source: MetricTermSource;
}

export type MetricTermFindingReason =
  /** `field` source whose id is not on the paid form. */
  | 'field-absent'
  /** `field` source that exists but is a container / display node, which submits no value. */
  | 'field-not-a-value'
  /** `case` source with no hidden calculate mirroring it — the ace#2590 shape. */
  | 'case-not-mirrored';

export interface MetricTermFinding {
  metric: string;
  role: MetricTerm['role'];
  term: string;
  reason: MetricTermFindingReason;
  /** The field id or `#<case_type>/<property>` the term resolved to. */
  ref: string;
  /**
   * For `case-not-mirrored`: every place the paid form READS the property
   * without submitting it (`<field id>.<attribute>`). A non-empty list is the
   * strongest form of the finding — the value is on the device at submit time
   * and simply never written into the record.
   */
  readsAt?: string[];
}

export interface MetricTermsExtra {
  /** Terms the caller declared `external` — must be named in the summary as not computable. */
  notComputable: { metric: string; role: MetricTerm['role']; term: string; reason: string }[];
  /** Terms the paid form submits, and the field that carries each. */
  submitted: { metric: string; role: MetricTerm['role']; term: string; fieldId: string }[];
}

export type MetricTermsReport = CheckOutcome<MetricTermFinding, MetricTermsExtra>;

/** Node kinds that hold children or display text and submit no value of their own. */
const NON_VALUE_KINDS = new Set(['group', 'repeat', 'label', 'trigger']);

function flatten(fields: PaidFormField[] | undefined): PaidFormField[] {
  const out: PaidFormField[] = [];
  for (const f of fields ?? []) {
    out.push(f);
    if (f.children?.length) out.push(...flatten(f.children));
  }
  return out;
}

/** Every `#<prefix>/<name>` reference in an expression, `#form/` included. */
const REF = /#([A-Za-z_][\w-]*)\/([A-Za-z_][\w-]*(?:\/[A-Za-z_][\w-]*)*)/g;

function refs(expr: string): { prefix: string; name: string }[] {
  return [...expr.matchAll(REF)].map((m) => ({ prefix: m[1], name: m[2] }));
}

/** Does this `#<prefix>/<name>` reference the case property in `source`? */
function isCaseRef(
  r: { prefix: string; name: string },
  source: { property: string; caseType?: string },
): boolean {
  if (r.prefix === 'form' || r.prefix === 'user') return false;
  if (r.name !== source.property) return false;
  return r.prefix === 'case' || !source.caseType || r.prefix === source.caseType;
}

/**
 * A field MIRRORS a case property when its `calculate` reads that property and
 * nothing else — `#community/x`, or a blank-guarded
 * `if(#community/x = '', 0, #community/x)`. A calculate that combines the
 * property with any other reference is a DIFFERENT quantity, not the term.
 */
function mirrors(field: PaidFormField, source: { property: string; caseType?: string }): boolean {
  if (typeof field.calculate !== 'string' || NON_VALUE_KINDS.has(field.kind)) return false;
  const rs = refs(field.calculate);
  return rs.length > 0 && rs.every((r) => isCaseRef(r, source));
}

/** Every string-valued attribute of a field (recursively, children excluded), with its path. */
function stringAttrs(value: unknown, path: string, out: { path: string; text: string }[]): void {
  if (typeof value === 'string') out.push({ path, text: value });
  else if (Array.isArray(value)) value.forEach((v, i) => stringAttrs(v, `${path}[${i}]`, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) stringAttrs(v, path ? `${path}.${k}` : k, out);
  }
}

function readsOf(field: PaidFormField, source: { property: string; caseType?: string }): string[] {
  const out: { path: string; text: string }[] = [];
  for (const [k, v] of Object.entries(field)) {
    if (k === 'children' || k === 'id' || k === 'kind' || k === 'uuid') continue;
    stringAttrs(v, k, out);
  }
  return out
    .filter((a) => refs(a.text).some((r) => isCaseRef(r, source)))
    .map((a) => `${field.id}.${a.path}`);
}

export function checkMetricTermsSubmitted(
  terms: MetricTerm[] | undefined | null,
  paidFormFields: PaidFormField[] | undefined | null,
): MetricTermsReport {
  if (!terms?.length) {
    return unable(
      'no PDD § Success Metrics terms were supplied, so nothing was checked. A PDD with a ' +
        'ratio metric always has at least two terms; an empty list means the enumeration ' +
        'step was skipped, not that every term is submitted',
    );
  }
  const all = flatten(paidFormFields ?? []);
  if (all.length === 0) {
    return unable(
      'the paid form has no fields (the get_form read is missing or empty), so no term ' +
        'can be shown to be submitted',
    );
  }

  const findings: MetricTermFinding[] = [];
  const notComputable: MetricTermsExtra['notComputable'] = [];
  const submitted: MetricTermsExtra['submitted'] = [];

  for (const t of terms) {
    const base = { metric: t.metric, role: t.role, term: t.term };
    const s = t.source;
    if (s.kind === 'external') {
      if (!s.reason?.trim()) {
        throw new Error(
          `metric ${t.metric} term "${t.term}" is declared external with no reason — a ` +
            'not-computable term must say why (ace#2590)',
        );
      }
      notComputable.push({ ...base, reason: s.reason });
      continue;
    }
    if (s.kind === 'field') {
      const f = all.find((x) => x.id === s.fieldId);
      if (!f) findings.push({ ...base, reason: 'field-absent', ref: s.fieldId });
      else if (NON_VALUE_KINDS.has(f.kind)) {
        findings.push({ ...base, reason: 'field-not-a-value', ref: s.fieldId });
      } else submitted.push({ ...base, fieldId: f.id });
      continue;
    }
    const mirror = all.find((f) => mirrors(f, s));
    if (mirror) {
      submitted.push({ ...base, fieldId: mirror.id });
      continue;
    }
    findings.push({
      ...base,
      reason: 'case-not-mirrored',
      ref: `#${s.caseType ?? 'case'}/${s.property}`,
      readsAt: all.flatMap((f) => readsOf(f, s)),
    });
  }

  return { ...checked(findings.length === 0, findings), notComputable, submitted };
}

export function formatMetricTermsReport(report: MetricTermsReport): string {
  if (report.status === 'unable') return formatUnable('metric-terms-submitted', report.reason);
  const lines: string[] = [];
  lines.push(
    report.ok
      ? `metric-terms-submitted: every resolvable metric term is submitted on the paid form (${report.submitted.length})`
      : `metric-terms-submitted: ${report.findings.length} metric term(s) the indicator layer needs are NOT submitted on the paid form:`,
  );
  for (const f of report.findings) {
    const head = `  ${f.metric} ${f.role} "${f.term}" (${f.ref})`;
    if (f.reason === 'field-absent') lines.push(`${head} — no such field on the paid form`);
    else if (f.reason === 'field-not-a-value') {
      lines.push(`${head} — a container/display node, which submits no value`);
    } else {
      lines.push(
        `${head} — a case property with no hidden calculate mirroring it` +
          (f.readsAt?.length ? `; the form READS it at ${f.readsAt.join(', ')} but never submits it` : ''),
      );
    }
  }
  for (const n of report.notComputable) {
    lines.push(`  NOT COMPUTABLE: ${n.metric} ${n.role} "${n.term}" — ${n.reason}`);
  }
  if (!report.ok) {
    lines.push(
      '',
      'Connect receives only the paid form. Mirror each case-held term into it as a hidden',
      'calculate (e.g. enrolled_households = #community/number_of_households), or name the',
      'metric in the summary as not computable with the reason (dimagi-internal/ace#2590).',
    );
  }
  return lines.join('\n');
}
