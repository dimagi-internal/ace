//
// Refuse to publish a solicitation whose applicant-facing prose carries
// ACE/PDD-internal vocabulary.
//
// On solicitation 19201 (`bednet-check-2-visit/20260907-1126`, labs program
// 231) the Q6 `framing` shipped live, above the prompt, reading:
//
//     "This is the archetype-specific question and it separates responders
//      who have read the design from those who have not."
//
// `archetype` is ACE's own taxonomy word. It means nothing to an LLO reading a
// public listing, and `framing` is respondent-facing — labs's public-detail
// template renders it directly above the prompt (`solicitation-create/SKILL.md`
// line 480). The eval rubric already calls this class "a real applicant
// blocker, not a style nit" (`solicitation-create-eval/SKILL.md` lines 104-106),
// but an eval only sees it AFTER publication, one run at a time, and only if a
// judge happens to look.
//
// ── Why a scan and not a template fix ──────────────────────────────────────
//
// The phrase is not templated — it is composed per-run by `solicitation-create`
// out of the PDD and work order, documents saturated with this vocabulary. So
// there is no single string to correct; the leak can recur in any run with
// different wording. Only a check over the composed output catches the class.
//
// ── Why this is NOT the ace#1238 guard class ───────────────────────────────
//
// ace#1238 is the standing cautionary tale for author-time blockers: a guard in
// `app-hq-settings` PREDICTED that CommCare's `make_build` would reject any
// form containing a `<case>` block, cited no reproducer, fired on essentially
// every ACE app, and deadlocked Phase 3 on every run.
//
// This check is a different shape on all three counts, which is why it ships:
//
//   1. It predicts NO external system's behaviour. It is a scan over ACE's own
//      composed output for ACE's own vocabulary — entirely intra-record. There
//      is no foreign system whose rejection is being guessed at, so there is
//      nothing to be wrong about.
//   2. It cites a live reproducer: the verbatim Q6 framing of 19201, carried
//      in the test as the positive control.
//   3. Its failure mode is the inverse. ace#1238's guard fired on everything
//      because `<case>` is universal; these tokens should appear in applicant
//      prose approximately never, so a hit is signal by construction.
//
// ── Why word-boundary, case-sensitive matching ─────────────────────────────
//
// This is where a naive denylist would earn its own issue. A substring match on
// `ACE` hits "workplACE", "spACE", "surfACE", "interfACE"; on `PDD` nothing, but
// on `fixture` it hits the ordinary English noun, and a solicitation may
// legitimately discuss "light fixtures" or a "fixture list". So:
//
//   - Acronyms (`ACE`, `PDD`, `OQ-3`, `R7`, `M4`) match case-SENSITIVELY at word
//     boundaries. "workplace" cannot hit `ACE`; a bare "ACE" can.
//   - Multi-word and slug tokens (`run_state`, `atomic-visit`, `decisions.yaml`)
//     match case-insensitively — they have no innocent English reading.
//   - `fixture` is deliberately NOT on the list. Its false-positive rate against
//     ordinary procurement prose is too high for the signal it adds, and the
//     real leak it was meant to catch (`smoke opportunity`) is listed directly.
//
// The negative controls in the test are the other seven framings from the SAME
// record — prose composed by the same skill in the same run. It matters that
// they pass: that is what proves the check discriminates rather than flagging
// every solicitation ACE writes.
//
// ace#2264.
//

/** One internal-vocabulary hit in a composed, applicant-facing string. */
export interface JargonHit {
  /** Dotted path of the offending field, e.g. `questions[5].framing`. */
  field: string;
  /** The denylisted token, as configured. */
  token: string;
  /** The matched text exactly as it appears in the prose. */
  match: string;
  /** A window of surrounding prose, for the operator to read. */
  context: string;
}

export interface JargonScanResult {
  clean: boolean;
  hits: JargonHit[];
  /** Fields actually scanned, so a caller can prove coverage. */
  fieldsScanned: string[];
}

/**
 * Tokens matched case-SENSITIVELY at word boundaries.
 *
 * Everything here has an innocent lowercase English reading somewhere
 * ("ace" a card, "space" containing ACE), so only the capitalised, standalone
 * form is a leak.
 */
export const CASE_SENSITIVE_TOKENS: readonly string[] = [
  'ACE',
  'PDD',
  'FLW_ID',
  'Layer A',
  'Layer B',
  'Layer C',
];

/**
 * Tokens matched case-INSENSITIVELY at word boundaries. None of these has an
 * innocent reading in a procurement listing.
 */
export const CASE_INSENSITIVE_TOKENS: readonly string[] = [
  'archetype',
  'atomic-visit',
  'longitudinal-visits',
  'focus-group',
  'multi-stage',
  'run_state',
  'decisions.yaml',
  'opp.yaml',
  'smoke opportunity',
  // Snake_case identifier forms ONLY. The spaced forms ("payment unit",
  // "deliver unit") are legitimate applicant-facing prose — see the
  // false-positive note below.
  'deliver_unit',
  'payment_unit',
  'entity_id',
  '/ace:',
];

//
// ── Tokens deliberately NOT on the list, and why ───────────────────────────
//
// The first draft of this list carried `payment unit`, `deliver unit`,
// `commcare hq` and `nova`. It passed every hand-written fixture and then
// produced THREE false positives on the first real record it was pointed at
// (solicitation 19201) — which is the whole lesson of "validate against the
// producers, not your own outputs". All three were prose a respondent must see:
//
//   - "Connect opportunity, verification rules and payment unit setup"
//       — a row in the Roles & responsibilities table saying what Dimagi owns.
//   - "data is transmitted over TLS and stored encrypted at rest in CommCare HQ"
//       — a security disclosure.
//   - "Storage location: United States (CommCare HQ US cluster)"
//       — a data-residency disclosure, load-bearing for a partner assessing
//         local requirements.
//
// `CommCare HQ`, `Connect`, `payment unit` and `deliver unit` are PRODUCT
// vocabulary: a respondent has to learn them to do the work, and a listing that
// avoided them would be worse, not cleaner. Only ACE's own build-time
// vocabulary is a leak.
//
// `nova` is off the list for a different reason — it IS internal, but "Nova" is
// a plausible organisation or place name ("Nova Health", "Novara"), and this
// check blocks publication. The cost of a wrong block on a real partner's name
// outweighs the value of catching a term that has never actually leaked.
//

/**
 * Patterned tokens: bare rule and metric and open-question ids as they appear
 * in a PDD (`R7`, `M4`, `OQ-3`). Case-sensitive, word-bounded — a lowercase
 * "m4" in a model number should not trip this.
 */
const PATTERN_TOKENS: readonly { token: string; re: RegExp }[] = [
  { token: 'R<n> (bare PDD rule id)', re: /\bR[1-9]\d?\b/g },
  { token: 'M<n> (bare PDD metric id)', re: /\bM[1-9]\d?\b/g },
  { token: 'OQ-<n> (open-question id)', re: /\bOQ-\d+\b/g },
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `\b` does not work at a non-word edge, so tokens that begin or end with a
 * non-word character (`/ace:`, `decisions.yaml`) need their boundary dropped on
 * that side or they can never match.
 */
function boundedPattern(token: string, flags: string): RegExp {
  const escaped = escapeRegExp(token);
  const left = /^\w/.test(token) ? '\\b' : '';
  const right = /\w$/.test(token) ? '\\b' : '';
  return new RegExp(`${left}${escaped}${right}`, flags);
}

function contextWindow(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 60);
  const end = Math.min(text.length, index + length + 60);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return `${prefix}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${suffix}`;
}

/** Scan one composed string. Exported so a caller can check a single field. */
export function scanText(field: string, text: string): JargonHit[] {
  if (!text) return [];
  const hits: JargonHit[] = [];

  const push = (token: string, re: RegExp) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      hits.push({
        field,
        token,
        match: m[0],
        context: contextWindow(text, m.index, m[0].length),
      });
      if (m[0].length === 0) re.lastIndex += 1;
    }
  };

  for (const token of CASE_SENSITIVE_TOKENS) push(token, boundedPattern(token, 'g'));
  for (const token of CASE_INSENSITIVE_TOKENS) push(token, boundedPattern(token, 'gi'));
  for (const { token, re } of PATTERN_TOKENS) push(token, new RegExp(re.source, re.flags));

  return hits;
}

/**
 * The five applicant-facing surfaces `solicitation-create` composes. Anything
 * added here must actually render to a respondent — a review-only field would
 * make the check noisy for no gain.
 */
export interface SolicitationProse {
  description?: string;
  scope_of_work?: string;
  questions?: { id?: string; text?: string; framing?: string }[];
  evaluation_criteria?: { id?: string; description?: string; scoring_guide?: string }[];
}

/**
 * Scan a composed solicitation payload before `is_public: true`.
 *
 * Pure — takes the payload, returns the verdict. The caller decides whether a
 * hit is a `[BLOCKER]` or a residual.
 */
export function scanSolicitationProse(payload: SolicitationProse): JargonScanResult {
  const hits: JargonHit[] = [];
  const fieldsScanned: string[] = [];

  const scan = (field: string, text: string | undefined) => {
    if (typeof text !== 'string') return;
    fieldsScanned.push(field);
    hits.push(...scanText(field, text));
  };

  scan('description', payload.description);
  scan('scope_of_work', payload.scope_of_work);

  (payload.questions ?? []).forEach((q, i) => {
    const label = q.id ? `questions[${i}] (${q.id})` : `questions[${i}]`;
    scan(`${label}.text`, q.text);
    scan(`${label}.framing`, q.framing);
  });

  (payload.evaluation_criteria ?? []).forEach((c, i) => {
    const label = c.id ? `evaluation_criteria[${i}] (${c.id})` : `evaluation_criteria[${i}]`;
    scan(`${label}.description`, c.description);
    scan(`${label}.scoring_guide`, c.scoring_guide);
  });

  return { clean: hits.length === 0, hits, fieldsScanned };
}

/** Operator-facing rendering. Empty string when clean, so a caller can `if`. */
export function formatJargonScan(result: JargonScanResult): string {
  if (result.clean) return '';
  const lines = [
    `[BLOCKER] ACE-internal vocabulary in applicant-facing prose — ${result.hits.length} hit(s) across ${result.fieldsScanned.length} scanned field(s).`,
    '',
    'These render to a respondent who has no ACE context. Rewrite in the',
    "reader's language before publishing; do not suppress the check.",
    '',
  ];
  for (const h of result.hits) {
    lines.push(`  ${h.field}`);
    lines.push(`    token:   ${h.token}  (matched "${h.match}")`);
    lines.push(`    context: ${h.context}`);
    lines.push('');
  }
  return lines.join('\n');
}
