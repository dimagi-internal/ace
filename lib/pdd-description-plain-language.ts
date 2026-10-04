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
  | 'code_markup'
  // ── outsider-text extras (profile 'outsider'; see below) ──
  | 'section_reference'
  | 'issue_reference'
  | 'internal_file'
  | 'form_id'
  | 'app_version'
  | 'xml_markup'
  | 'ace_jargon'
  | 'skill_or_tool_name';

export interface PlainLanguageIssue {
  kind: PlainLanguageIssueKind;
  /** The offending text, verbatim. */
  token: string;
}

type Rule = { kind: PlainLanguageIssueKind; re: RegExp };

/** The shapes a one-paragraph PDD description must not carry. */
const BASE_RULES: Rule[] = [
  { kind: 'snake_case_identifier', re: /\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b/g },
  { kind: 'expression_operator', re: /[!<>=]?={1,2}/g },
  { kind: 'boolean_operator', re: /\b(?:AND|OR|NOT)\b/g },
  { kind: 'run_id', re: /\b\d{8}-\d{4}\b/g },
  { kind: 'code_markup', re: /`[^`]*`|\{\{[^}]*\}\}/g },
];

// ── The 'outsider' profile ─────────────────────────────────────────────────
//
// Generalised for every OTHER string ACE writes for a named outside reader —
// first the opp-level open-questions ledger (`lib/open-questions-plain-language.ts`),
// whose `question:` / `answered_where:` ace-web renders on the PUBLIC
// run-summary page as the item a partner is asked to answer. On
// spark-facilitator (ledger revision 6, 2026-10-03) those fields carried
// `hh_count_tt`, "the v1392 app", form ids `m0f0, m0f3, m0f5, m0f8`, twelve
// lookup-table names, "decisions.yaml ruling or PDD revision", "Nova
// update_translations review", "ace#2590" and "work order §6" — and the page's
// outsider review (run-surface-audit-eval) capped jargon at 4/10.
//
// The extra shapes, each with no innocent reading in a question put to a
// programme partner:
//
//   - `§` section references (`PDD §4`, `work order §6`);
//   - issue references (`ace#2590`, `owner/repo#12`, `PR #12`);
//   - internal file names (`decisions.yaml`, `forms-0.xml`, `.ccz`);
//   - CommCare form ids (`m0f3`) and app version tags (`v1392`);
//   - XML tags (`<bind …/>`, `<update>`);
//   - ACE's own nouns (`PDD`, `CCZ`, `run_state`) and its tool/skill names
//     (`Nova`, `idea-to-pdd`, `*-qa` / `*-eval`).
//
// Hyphenated words, acronyms like CHW / LLO, and lower-case "and" stay legal
// here exactly as in the base profile.
const OUTSIDER_EXTRA_RULES: Rule[] = [
  { kind: 'section_reference', re: /(?:\bPDD\s*)?§\s*[\w.]*/g },
  { kind: 'issue_reference', re: /\b(?:ace|ace-web|[\w-]+\/[\w-]+)#\d+\b|\bPR #\d+\b/g },
  {
    kind: 'internal_file',
    re: /(?:\b[\w-]+(?:\/[\w.-]+)*)?\.(?:ya?ml|xml|ccz|json|md|ts|csv|xlsx|apk)\b/g,
  },
  { kind: 'form_id', re: /\bm\d+f\d+\b/g },
  { kind: 'app_version', re: /\bv\d{3,}\b/g },
  { kind: 'xml_markup', re: /<\/?[A-Za-z][\w:.-]*(?:\s[^<>]*)?\/?>/g },
  { kind: 'ace_jargon', re: /\bPDD\b(?!\s*§)|\bCCZ\b|\brun_state\b/g },
  {
    kind: 'skill_or_tool_name',
    re: /\bNova\b|\b(?:pdd-to-[a-z-]+|connect-(?:opp|program)-setup|idea-to-pdd|app-test-cases|ocs-agent-setup|solicitation-create|[a-z]+(?:-[a-z]+)+-(?:eval|qa))\b/g,
  },
];

/**
 * `description` — the original PDD-description rules, unchanged.
 * `outsider`   — those plus the extra shapes above, for any field a named
 *                outside owner reads (the open-questions ledger first).
 */
export type PlainLanguageProfile = 'description' | 'outsider';

const PROFILE_RULES: Record<PlainLanguageProfile, Rule[]> = {
  description: BASE_RULES,
  outsider: [...BASE_RULES, ...OUTSIDER_EXTRA_RULES],
};

/**
 * Every engineer-facing token in `text`, in rule order, under `profile`.
 * An empty array means the text reads as plain language by those rules.
 * The shared outsider-text checker: `auditPddDescription` is its
 * `'description'` profile.
 */
export function auditOutsiderText(
  text: string,
  profile: PlainLanguageProfile = 'outsider',
): PlainLanguageIssue[] {
  const out: PlainLanguageIssue[] = [];
  for (const { kind, re } of PROFILE_RULES[profile]) {
    for (const m of text.matchAll(re)) out.push({ kind, token: m[0] });
  }
  return out;
}

/**
 * Every engineer-facing token in a PDD description, in rule order. An empty
 * array means the description reads as plain language by these rules.
 */
export function auditPddDescription(description: string): PlainLanguageIssue[] {
  return auditOutsiderText(description, 'description');
}

const KIND_LABEL: Record<PlainLanguageIssueKind, string> = {
  snake_case_identifier: 'field/code identifier',
  expression_operator: 'expression operator',
  boolean_operator: 'boolean operator',
  run_id: 'run id',
  code_markup: 'code markup',
  section_reference: 'section reference',
  issue_reference: 'issue reference',
  internal_file: 'internal file name',
  form_id: 'form id',
  app_version: 'app version tag',
  xml_markup: 'XML markup',
  ace_jargon: 'ACE jargon',
  skill_or_tool_name: 'skill or tool name',
};

export function plainLanguageKindLabel(kind: PlainLanguageIssueKind): string {
  return KIND_LABEL[kind];
}

/** One-line human summary of the issues, for a QA failure detail. */
export function describePlainLanguageIssues(issues: PlainLanguageIssue[]): string {
  return issues.map((i) => `${KIND_LABEL[i.kind]} "${i.token}"`).join(', ');
}
