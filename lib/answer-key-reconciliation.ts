//
// Reconcile the deep-QA ANSWER KEY against what the run actually shipped.
//
// `2-scenarios/pdd-to-test-prompts.md` is the ground truth
// `ocs-chatbot-eval --deep` grades against. It is authored in PHASE 2, from
// the PDD alone. Phases 3-6 then (a) RESOLVE things the key still calls open
// and (b) FAIL TO BUILD things the key asserts as built. Nothing reconciled
// the key against either, so the grader could penalise a bot for being right
// about the system as it actually shipped (dimagi-internal/ace#1954).
//
// Three instances, all measured on `hh-poverty-targeting/20260828-0702`
// (64-prompt deep suite, chatbot 13029 v3, collection 570):
//
//   * Key prompt 40 — "Producing any likelihood value for 101 is a hard
//     failure." `03-ppi-instrument-constants-verified.md` (file_id 63007,
//     collection_file_id 42101, INDEXED IN THE GRADED BOT'S OWN COLLECTION)
//     records "## Scores 101 and 102 — the residual, RESOLVED /
//     **Decision: CLAMP to 100** (likelihood 0.2%)".
//   * Key prompts 20 and 44 — "gallery selection is not permitted" /
//     "Gallery selection is not an alternative". `09-app-hq-settings-
//     summary.md` (file_id 63013, also indexed) records "camera-only NOT
//     applied ... the on-device widget keeps its CHOOSE IMAGE gallery
//     button".
//   * The run's own `run_state.yaml` carried, verbatim: "tp-r1:
//     [product-feedback] over-tagged on test prompts 11, 22, 40 ... Phase 5
//     should treat those three tags as advisory rather than scored." Nothing
//     on qa-deep's path reads `run_state.yaml` at all.
//
// THIS MODULE OWNS THE THIRD INSTANCE, AND ONLY THE THIRD, ON PURPOSE.
//
// The first two are semantic: deciding that "gallery selection is not
// permitted" contradicts "camera-only NOT applied" is a reading task, and a
// regex that claimed to do it would be the exact class of guess CLAUDE.md
// forbids. Those stay prose in the rubric, as a rule the judge applies with
// the corpus in front of it.
//
// The third is NOT semantic. A caveat that was already found, understood and
// WRITTEN DOWN in a structured field has no path to the grader — that is a
// plumbing gap, and plumbing is arithmetic. This module is the plumbing:
// extract the recorded caveats, resolve the prompt numbers they name to
// transcript refs by EXACT QUESTION TEXT (never by assuming `prompt 40` is
// `opp-40` — on this run it happened to be, and that is a coincidence of the
// numbering, not a contract), and mark the entries.
//
// Why arithmetic rather than a rubric line, again: this skill's own changelog
// records three separate cases where a well-written rule existed and the judge
// simply did not apply it, which is why `applyFabricationClamp`,
// `applyInternalArtifactLeakCap` and `applyContactDomainDriftClamp` are all
// functions now. A fourth prose rule would be the fourth instance.
//
// Honest note on measured impact: on 20260828-0702 the delta was +0.01
// (9.01 -> 9.02 pre-cap, gate unchanged), because the bot happened to emit
// `[product-feedback]` on all three caveated prompts. That is luck, not a
// working mechanism — the caveat says the tag should not have been EXPECTED,
// so a bot that correctly omitted it would have been marked down and nothing
// would have caught it.
//

import type { JudgedEntry } from './fabrication-clamp.js';

/** Marker attached to an entry covered by a recorded answer-key caveat. */
export const ANSWER_KEY_ADVISORY_MARKER = '[ANSWER-KEY-ADVISORY]';

/** Marker for a caveat naming a prompt that resolves to no graded entry. */
export const ANSWER_KEY_UNRESOLVED_MARKER = '[BLOCKER] answer-key caveat unresolved';

/**
 * A caveat about the answer key, recorded somewhere in the run's state.
 *
 * `promptNumbers` are the key's own `## Prompt N` numbers as written in the
 * caveat text — NOT transcript refs. Resolution to refs is a separate step
 * because the two numbering schemes are independent.
 */
export interface AnswerKeyCaveat {
  /** `## Prompt N` numbers named by the caveat, in the order written. */
  promptNumbers: number[];
  /** The caveat text, collapsed to one line. */
  reason: string;
  /** Where it was found, e.g. `residuals` or `notes`. */
  source: string;
}

/** A caveat whose prompt numbers have been resolved to transcript refs. */
export interface ResolvedCaveat extends AnswerKeyCaveat {
  /** Transcript refs the caveat covers, matched by exact question text. */
  refs: string[];
  /** Prompt numbers that matched no graded entry. */
  unresolvedPromptNumbers: number[];
}

export interface AdvisoryEntry extends JudgedEntry {
  /** Present and true once the entry is covered by a caveat. */
  advisory?: boolean;
}

export interface AnswerKeyAdvisoryResult {
  /** Entries with advisory marks applied. Same order, same length. */
  entries: AdvisoryEntry[];
  /** Refs marked advisory, deduplicated and sorted. */
  advisoryRefs: string[];
  /** The resolved caveats that produced them. */
  caveats: ResolvedCaveat[];
  /**
   * Prompt numbers named by a caveat that matched no graded entry. Non-empty
   * is a `[BLOCKER]`, exactly like `unmatchedMarkers` on the fabrication
   * clamp: an unroutable caveat means a known key defect is going ungraded.
   */
  unresolved: number[];
}

/**
 * Words that make a sentence a DIRECTIVE about grading rather than a passing
 * mention of a prompt. A residual that merely says "prompt 12 covers payment"
 * is not a caveat and must not silence an entry.
 */
const DIRECTIVE_TERMS = /\b(advisory|not\s+scored|rather\s+than\s+scored|do\s+not\s+score|unscored|excluded\s+from\s+scoring)\b/i;

/** `test prompts 11, 22, 40` / `prompt 40` / `prompts 11 and 22`. */
const PROMPT_LIST = /\b(?:test\s+)?prompts?\s+((?:\d{1,3})(?:\s*(?:,|and|&)\s*\d{1,3})*)/gi;

/** Collapse a YAML block scalar / wrapped string to one line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Pull every prompt number out of a caveat sentence.
 *
 * Deliberately anchored on the words `prompt`/`prompts` — a bare number list
 * elsewhere in the sentence (a score, a count, a year) is not a prompt
 * reference and must not be swept up.
 */
export function extractPromptNumbers(text: string): number[] {
  const found: number[] = [];
  for (const m of oneLine(text).matchAll(PROMPT_LIST)) {
    for (const raw of m[1].split(/\s*(?:,|and|&)\s*/)) {
      const n = Number.parseInt(raw, 10);
      if (Number.isInteger(n) && n > 0 && !found.includes(n)) found.push(n);
    }
  }
  return found;
}

/**
 * Extract recorded answer-key caveats from a run's `run_state.yaml` TEXT.
 *
 * Reads the file as text rather than parsed YAML on purpose: the caveats live
 * in free-form `residuals[]` and `notes[]` strings scattered across several
 * phase blocks, and the shape of those blocks is not part of the Phase
 * Write-Back Contract. Scanning the strings is robust to where a phase chose
 * to record one.
 *
 * A string qualifies only when it names at least one prompt AND carries a
 * grading directive — see `DIRECTIVE_TERMS`.
 */
export function extractAnswerKeyCaveats(runStateText: string): AnswerKeyCaveat[] {
  const caveats: AnswerKeyCaveat[] = [];

  // Each list item in the YAML, including wrapped continuation lines.
  const lines = runStateText.split('\n');
  let current: string | null = null;
  let indent = 0;
  let section = 'unknown';

  const flush = () => {
    if (current === null) return;
    const text = oneLine(current);
    const promptNumbers = extractPromptNumbers(text);
    if (promptNumbers.length > 0 && DIRECTIVE_TERMS.test(text)) {
      caveats.push({ promptNumbers, reason: text.replace(/^["']|["']$/g, ''), source: section });
    }
    current = null;
  };

  for (const line of lines) {
    const sectionMatch = line.match(/^\s{2,}([a-z_]+):\s*$/);
    if (sectionMatch) {
      flush();
      section = sectionMatch[1];
      continue;
    }
    const itemMatch = line.match(/^(\s*)- (.*)$/);
    if (itemMatch) {
      flush();
      indent = itemMatch[1].length;
      current = itemMatch[2];
      continue;
    }
    if (current !== null) {
      const contIndent = line.match(/^\s*/)?.[0].length ?? 0;
      // A wrapped continuation is indented further than the `-` that opened it.
      if (line.trim() !== '' && contIndent > indent) {
        current += ' ' + line.trim();
        continue;
      }
      flush();
    }
  }
  flush();

  return caveats;
}

/**
 * Build `promptNumber -> question text` from the answer key markdown.
 *
 * The key's format is `## Prompt N` followed by `**Question:** ...`.
 */
export function parseAnswerKeyQuestions(answerKeyText: string): Map<number, string> {
  const out = new Map<number, string>();
  const blocks = answerKeyText.split(/^##\s+Prompt\s+(\d+)\s*$/m);
  // blocks = [preamble, "1", body1, "2", body2, ...]
  for (let i = 1; i < blocks.length; i += 2) {
    const n = Number.parseInt(blocks[i], 10);
    const q = blocks[i + 1]?.match(/^\*\*Question:\*\*\s*(.+)$/m)?.[1];
    if (Number.isInteger(n) && q) out.set(n, normaliseQuestion(q));
  }
  return out;
}

/**
 * Normalise a question for matching.
 *
 * Drive's plain-text export and the transcript's own rendering differ in
 * whitespace and in which dash/quote characters survive, so match on a
 * normalised form rather than raw equality — while staying strict enough that
 * two DIFFERENT questions never collide.
 */
export function normaliseQuestion(q: string): string {
  return q
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Resolve each caveat's prompt numbers to transcript refs by QUESTION TEXT.
 *
 * Never positional. On 20260828-0702 key `## Prompt 40` did land on transcript
 * ref `opp-40`, but the key numbers 1..64 across every category while the
 * transcript refs restart per category (`cg-*`, `ace-*`, `opp-*`, `edge-*`) —
 * the alignment is a coincidence of that suite's ordering and would break
 * silently on any suite with a different category mix.
 */
export function resolveCaveats(
  caveats: AnswerKeyCaveat[],
  answerKeyText: string,
  entries: readonly JudgedEntry[],
): { caveats: ResolvedCaveat[]; unresolved: number[] } {
  const questions = parseAnswerKeyQuestions(answerKeyText);

  const byQuestion = new Map<string, string>();
  for (const e of entries) {
    const prompt = typeof e.prompt === 'string' ? e.prompt : '';
    if (prompt) byQuestion.set(normaliseQuestion(prompt), e.ref);
  }

  const resolved: ResolvedCaveat[] = [];
  const unresolved: number[] = [];

  for (const caveat of caveats) {
    const refs: string[] = [];
    const missing: number[] = [];
    for (const n of caveat.promptNumbers) {
      const q = questions.get(n);
      const ref = q ? byQuestion.get(q) : undefined;
      if (ref) {
        if (!refs.includes(ref)) refs.push(ref);
      } else {
        missing.push(n);
        if (!unresolved.includes(n)) unresolved.push(n);
      }
    }
    resolved.push({ ...caveat, refs, unresolvedPromptNumbers: missing });
  }

  return { caveats: resolved, unresolved };
}

/**
 * Mark every entry covered by a recorded caveat as ADVISORY.
 *
 * What advisory means, precisely, and what it does NOT mean:
 *
 *   * The entry keeps its score. Nothing is clamped and nothing is inflated —
 *     this is not a cap, and it must never become one. A caveat says the
 *     EXPECTATION is unsound, not that the answer was good.
 *   * The entry is excluded from the dimension means and from the `--deep`
 *     gate's "zero Fail verdicts" test, so an unsound expectation cannot
 *     gate Phase 9.
 *   * The caveat text is surfaced verbatim, so a reader sees WHY and can
 *     overrule it.
 *
 * Run it in Process step 4 alongside the three clamps. Order does not matter
 * against them — advisory marking never changes a score, so it neither hides
 * a clamp nor is hidden by one.
 */
export function applyAnswerKeyAdvisory(
  entries: readonly AdvisoryEntry[],
  caveats: readonly ResolvedCaveat[],
): AnswerKeyAdvisoryResult {
  const reasonByRef = new Map<string, string[]>();
  for (const c of caveats) {
    for (const ref of c.refs) {
      const list = reasonByRef.get(ref) ?? [];
      list.push(c.reason);
      reasonByRef.set(ref, list);
    }
  }

  const out = entries.map((entry) => {
    const reasons = reasonByRef.get(entry.ref);
    if (!reasons || reasons.length === 0) return { ...entry };

    const existing = entry.auto_surfaced;
    const lines = existing === undefined ? [] : Array.isArray(existing) ? [...existing] : [existing];
    for (const reason of reasons) {
      const marker = `${ANSWER_KEY_ADVISORY_MARKER} ${reason}`;
      if (!lines.some((l) => String(l) === marker)) lines.push(marker);
    }

    return { ...entry, advisory: true, auto_surfaced: lines };
  });

  const advisoryRefs = [...reasonByRef.keys()].filter((ref) => entries.some((e) => e.ref === ref)).sort();

  const unresolved: number[] = [];
  for (const c of caveats) {
    for (const n of c.unresolvedPromptNumbers) if (!unresolved.includes(n)) unresolved.push(n);
  }

  return { entries: out, advisoryRefs, caveats: [...caveats], unresolved };
}

/**
 * Convenience wrapper: run the whole reconciliation from raw text.
 *
 * `qa-deep` Stage A has the run's `run_state.yaml` and the answer key as text
 * already; this saves it from wiring the three steps by hand.
 */
export function reconcileAnswerKey(
  entries: readonly AdvisoryEntry[],
  runStateText: string,
  answerKeyText: string,
): AnswerKeyAdvisoryResult {
  const raw = extractAnswerKeyCaveats(runStateText);
  const { caveats } = resolveCaveats(raw, answerKeyText, entries);
  return applyAnswerKeyAdvisory(entries, caveats);
}

/** Auditable report, in the spirit of `overall_score_pre_cap`. */
export function formatAnswerKeyAdvisoryReport(result: AnswerKeyAdvisoryResult): string {
  if (result.caveats.length === 0) {
    return 'Answer-key reconciliation: no recorded caveats in run_state.yaml.';
  }

  const lines = [
    `Answer-key reconciliation: ${result.advisoryRefs.length} entr` +
      `${result.advisoryRefs.length === 1 ? 'y' : 'ies'} marked advisory ` +
      `from ${result.caveats.length} recorded caveat${result.caveats.length === 1 ? '' : 's'}`,
  ];
  for (const c of result.caveats) {
    lines.push(`  (${c.source}) prompts ${c.promptNumbers.join(', ')} -> ${c.refs.join(', ') || '(none)'}`);
    lines.push(`    ${c.reason}`);
  }
  if (result.unresolved.length > 0) {
    lines.push(
      `  ${ANSWER_KEY_UNRESOLVED_MARKER}: prompt(s) ${result.unresolved.join(', ')} ` +
        'named by a caveat matched no graded entry. A known key defect is going ' +
        'ungraded — do not write the verdict until this routes.',
    );
  }
  return lines.join('\n');
}
