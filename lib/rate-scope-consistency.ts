//
// A solicitation must tell a respondent what their proposed rate has to cover,
// and must ask for the rate's composition.
//
// ── The policy (Jonathan, 2026-09-08) ──────────────────────────────────────
//
//   "The LLO should propose an all-in rate per verified service delivery, and
//    explicitly how much is paid to the worker vs. commodity."
//
// Two obligations, and both are load-bearing:
//
//   1. **All-in.** The per-unit rate is the whole commercial relationship.
//      There is no separately-funded line for supervision, transport, devices,
//      connectivity or reporting time. A listing must not invite one.
//   2. **Decomposed.** The respondent states how the all-in rate splits
//      between what reaches the WORKER and what covers COMMODITY — the
//      non-labour cost of delivering. An undifferentiated total hides whether
//      the worker is actually paid a defensible wage, which is the number the
//      programme most needs to see.
//
// ── What went wrong without it ─────────────────────────────────────────────
//
// Solicitation 19201 published Q8 asking respondents to state
//
//     "...which of these your proposed per-worker-day rate is intended to
//      cover and which you would expect to be FUNDED SEPARATELY"
//
// while that same question's `framing` said "the costs a partner absorbs" and
// the linked evaluation criterion said "worker pay from partner overhead". Two
// of three surfaces asserted all-in; the question text invited a separate line
// that does not exist. A respondent reads all three on one screen and cannot
// price the engagement — and these listings carry no `contact_email` to ask
// through, so the ambiguity is terminal for them.
//
// On that record the published envelope was USD 510-3,264 for a 3-8 worker
// cohort over six weeks. Under the real policy that figure absorbs supervision,
// transport, devices, data AND reporting. Under the reading Q8's text invited,
// it is worker pay alone. Those are different engagements.
//
// ── Why a check and not just a prose rule ──────────────────────────────────
//
// `solicitation-create` composes these strings per-run from the PDD and work
// order, so there is no template to correct — the same contradiction can
// recompose in any run with different wording. This is the intra-record
// consistency class: it predicts nothing about any external system, it only
// asserts that a listing does not contradict itself or omit a required ask.
//
// ace#2265.
//

export type RateScopeIssueKind = 'separately-funded-invitation' | 'missing-composition-ask';

export interface RateScopeIssue {
  kind: RateScopeIssueKind;
  /** Dotted path of the offending field, or the payload when nothing matched. */
  field: string;
  /** The matched text, when the issue is a positive match. */
  match?: string;
  /** What the author has to change. */
  remedy: string;
}

export interface RateScopeResult {
  clean: boolean;
  issues: RateScopeIssue[];
}

export interface RateScopeProse {
  scope_of_work?: string;
  questions?: { id?: string; text?: string; framing?: string }[];
  evaluation_criteria?: { id?: string; description?: string; scoring_guide?: string }[];
}

/**
 * Phrases that invite a separately-funded line. Deliberately narrow: each one
 * asserts that some cost sits OUTSIDE the proposed rate.
 *
 * Note what is NOT here. "which your rate is intended to cover" is legitimate
 * and stays — asking what the rate covers is exactly the composition ask. Only
 * the *separate funding* framing is wrong.
 */
const SEPARATE_FUNDING_PATTERNS: readonly { re: RegExp; label: string }[] = [
  { re: /funded\s+separately/gi, label: '"funded separately"' },
  { re: /separately\s+funded/gi, label: '"separately funded"' },
  { re: /funded\s+outside\s+(?:the\s+)?rate/gi, label: '"funded outside the rate"' },
  { re: /reimbursed\s+separately/gi, label: '"reimbursed separately"' },
  { re: /billed\s+separately/gi, label: '"billed separately"' },
  { re: /a\s+separate\s+budget\s+line/gi, label: '"a separate budget line"' },
];

/**
 * Evidence that some question asks for the worker-vs-commodity split.
 *
 * Matching is generous on purpose. The author writes this prose fresh each run,
 * and the check exists to catch an OMISSION, not to police wording — a false
 * "you didn't ask" on a listing that did ask would be the noisy failure that
 * gets the whole check suppressed.
 */
const COMPOSITION_ASK_PATTERNS: readonly RegExp[] = [
  /\bworker\b[^.?!]{0,80}\bvs\.?\b[^.?!]{0,80}\bcommodit/i,
  /\bcommodit[^.?!]{0,80}\bvs\.?\b[^.?!]{0,80}\bworker\b/i,
  /how\s+much[^.?!]{0,120}\b(?:paid|goes?)\s+to\s+the\s+worker/i,
  /\b(?:portion|share|split|breakdown|decompos\w*)\b[^.?!]{0,120}\bworker\b/i,
  /\bworker\b[^.?!]{0,120}\b(?:portion|share|split)\b/i,
];

function findSeparateFunding(field: string, text: string | undefined): RateScopeIssue[] {
  if (typeof text !== 'string' || !text) return [];
  const issues: RateScopeIssue[] = [];
  for (const { re, label } of SEPARATE_FUNDING_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      issues.push({
        kind: 'separately-funded-invitation',
        field,
        match: m[0],
        remedy:
          `Remove ${label} — the per-unit rate is ALL-IN and there is no ` +
          `separately-funded line. Ask instead how the all-in rate splits ` +
          `between the worker and commodity.`,
      });
    }
  }
  return issues;
}

/** Every applicant-facing string that could carry the composition ask. */
function proseFields(payload: RateScopeProse): { field: string; text: string }[] {
  const out: { field: string; text: string }[] = [];
  const add = (field: string, text: string | undefined) => {
    if (typeof text === 'string' && text) out.push({ field, text });
  };
  add('scope_of_work', payload.scope_of_work);
  (payload.questions ?? []).forEach((q, i) => {
    const label = q.id ? `questions[${i}] (${q.id})` : `questions[${i}]`;
    add(`${label}.text`, q.text);
    add(`${label}.framing`, q.framing);
  });
  (payload.evaluation_criteria ?? []).forEach((c, i) => {
    const label = c.id ? `evaluation_criteria[${i}] (${c.id})` : `evaluation_criteria[${i}]`;
    add(`${label}.description`, c.description);
    add(`${label}.scoring_guide`, c.scoring_guide);
  });
  return out;
}

/** True when any field asks for the worker-vs-commodity decomposition. */
export function hasCompositionAsk(payload: RateScopeProse): boolean {
  return proseFields(payload).some(({ text }) =>
    COMPOSITION_ASK_PATTERNS.some((re) => re.test(text)),
  );
}

/**
 * Check a composed solicitation against the all-in rate policy.
 *
 * Pure. The caller decides whether an issue is a `[BLOCKER]` or a residual.
 */
export function scanRateScope(payload: RateScopeProse): RateScopeResult {
  const issues: RateScopeIssue[] = [];

  for (const { field, text } of proseFields(payload)) {
    issues.push(...findSeparateFunding(field, text));
  }

  if (!hasCompositionAsk(payload)) {
    issues.push({
      kind: 'missing-composition-ask',
      field: 'questions',
      remedy:
        'No question asks how the proposed all-in rate splits between what ' +
        'reaches the WORKER and what covers COMMODITY. Add that ask — an ' +
        'undifferentiated total hides whether the worker is paid a defensible ' +
        'wage, which is the number the programme most needs to see.',
    });
  }

  return { clean: issues.length === 0, issues };
}

/** Operator-facing rendering. Empty string when clean. */
export function formatRateScope(result: RateScopeResult): string {
  if (result.clean) return '';
  const lines = [
    `[BLOCKER] Rate-scope contradiction — ${result.issues.length} issue(s).`,
    '',
    'Policy: the LLO proposes an ALL-IN rate per verified service delivery,',
    'and states explicitly how much is paid to the worker vs. commodity.',
    '',
  ];
  for (const issue of result.issues) {
    lines.push(`  ${issue.field}  [${issue.kind}]`);
    if (issue.match) lines.push(`    matched: "${issue.match}"`);
    lines.push(`    ${issue.remedy}`);
    lines.push('');
  }
  return lines.join('\n');
}
