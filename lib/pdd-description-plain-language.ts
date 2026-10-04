//
// `run_state.yaml` → `phases.idea-to-design.products.pdd.description` must read
// as plain language. It is the FIRST thing an outside partner reads: ace-web
// renders it as the opening paragraph of the public run-summary page
// (ace-web `apps/opps/summary.py` `_read_opp`).
//
// ── The reproducer ─────────────────────────────────────────────────────────
//
// On spark-facilitator/20261001-2208 the description read:
//
//     "…Connect pays per meeting verified as meeting_conducted = yes AND
//      meeting_type = community_meeting, capped at 3 paid meetings…"
//
// Form field names, code values and a boolean expression, in the sentence that
// introduces the programme to a partner. The page's outsider-readability review
// (run-surface-audit-eval) scored 5.6 against a band of 7, and this paragraph
// was one of its two ACE-side causes. `idea-to-pdd` step 7.5 lifts the
// description from the PDD's Overview, and a PDD is saturated with exactly this
// vocabulary — so the leak recurs with different words on any run, and only a
// scan over the composed string catches the class.
//
// ── What this predicts ─────────────────────────────────────────────────────
//
// Nothing about any external system. It scans ACE's own output for ACE's own
// identifier shapes — intra-record, so there is no foreign rejection to be
// wrong about (the ace#1238 guard class does not apply). Sibling of
// `lib/applicant-facing-jargon.ts`, which does the same for solicitation prose.
//
// ── Why these shapes and not a denylist ────────────────────────────────────
//
// Each shape has no innocent reading in a one-paragraph plain-English overview:
//
//   - snake_case tokens (`meeting_conducted`, `community_meeting`) — identifiers;
//   - `=` / `==` / `!=` / `>=` / `<=` — an expression, not a sentence;
//   - upper-case `AND` / `OR` / `NOT` — boolean operators (lower-case "and" is
//     English and is never matched);
//   - run ids (`20261001-2208`) — internal bookkeeping;
//   - backtick code spans and `{{template}}` markers — markup that leaked.
//
// Hyphenated words ("door-to-door") and acronyms (CHW, LLO) are deliberately
// NOT flagged: they are ordinary in programme prose and the false-positive rate
// would bury the signal.

export type PlainLanguageIssueKind =
  | 'snake_case_identifier'
  | 'expression_operator'
  | 'boolean_operator'
  | 'run_id'
  | 'code_markup';

export interface PlainLanguageIssue {
  kind: PlainLanguageIssueKind;
  /** The offending text, verbatim. */
  token: string;
}

const RULES: Array<{ kind: PlainLanguageIssueKind; re: RegExp }> = [
  { kind: 'snake_case_identifier', re: /\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b/g },
  { kind: 'expression_operator', re: /[!<>=]?={1,2}/g },
  { kind: 'boolean_operator', re: /\b(?:AND|OR|NOT)\b/g },
  { kind: 'run_id', re: /\b\d{8}-\d{4}\b/g },
  { kind: 'code_markup', re: /`[^`]*`|\{\{[^}]*\}\}/g },
];

/**
 * Every engineer-facing token in a PDD description, in rule order. An empty
 * array means the description reads as plain language by these rules.
 */
export function auditPddDescription(description: string): PlainLanguageIssue[] {
  const out: PlainLanguageIssue[] = [];
  for (const { kind, re } of RULES) {
    for (const m of description.matchAll(re)) out.push({ kind, token: m[0] });
  }
  return out;
}

const KIND_LABEL: Record<PlainLanguageIssueKind, string> = {
  snake_case_identifier: 'field/code identifier',
  expression_operator: 'expression operator',
  boolean_operator: 'boolean operator',
  run_id: 'run id',
  code_markup: 'code markup',
};

/** One-line human summary of the issues, for a QA failure detail. */
export function describePlainLanguageIssues(issues: PlainLanguageIssue[]): string {
  return issues.map((i) => `${KIND_LABEL[i.kind]} "${i.token}"`).join(', ');
}
