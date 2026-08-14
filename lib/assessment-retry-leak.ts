//
// Pure XForm analysis: does a score-gated assessment's RETRY guidance hand the
// worker the correct answer?
//
// Why this exists: dimagi-internal/ace#1041. `_app-component-library.md
// § assessment-gate` clause (e) said only "give a failing FLW retry guidance".
// Nothing forbade that guidance from STATING the answer, so the natural
// authoring of "retry guidance" re-teaches by restating the right option and
// then invites another attempt. With no attempt limit, a worker who fails once
// is shown the answer and passes on attempt 2 — the `user_score >= 80` wiring
// stays intact and completely inert, so the Connect Deliver-unlock gate is
// decorative.
//
// Live on bednet-spot-check/20260729-0002 (Nova app 8c758d89): the built
// `fail_msg` restated the correct option verbatim and told the worker to answer
// again. Not a one-off — the golden run it forked from (20260706-0649) carries
// the identical leak, so the class shipped through at least two runs, one of
// them promoted to golden.
//
// Distinct from ace#1014 (items answerable COLD, before any study): this one
// bites even when the item bank discriminates perfectly, because the retry path
// leaks the key. Same "gate is decorative" outcome, different vector, separate
// fix.
//
// Mechanical on purpose. The correct answer is not a CommCare primitive — there
// is no "mark this option correct" — but ACE's scoring calculates compare the
// question against the correct answer's literal value, so the answer IS
// recoverable from the binds. That makes this a parser, not a rubric criterion:
// `pdd-to-learn-app-eval` did catch the live instance, but only after a full
// deploy→build→release cycle, and only because a judge happened to read the
// label text.
//

import { DOMParser } from '@xmldom/xmldom';

export interface RetryLeak {
  /** Nodeset of the fail-branch label that leaked, e.g. `/data/fail_msg`. */
  label: string;
  /** The correct-answer literal found inside it. */
  leaked: string;
  /** The label's full text, for the report. */
  text: string;
}

export interface RetryLeakReport {
  /**
   * False when the form carries no score-gated result labels — nothing to
   * leak into, so the check did not apply. Distinguished from `ok` so a
   * caller can tell "clean" from "not applicable" (a silent pass on an
   * inapplicable form is how a check quietly stops covering anything).
   */
  checked: boolean;
  ok: boolean;
  /** Correct-answer literals recovered from the scoring binds. */
  correctAnswers: string[];
  leaks: RetryLeak[];
}

/** Normalize for comparison: case-insensitive, whitespace-collapsed. */
function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

function textOf(node: Element | null | undefined): string {
  if (!node) return '';
  return (node.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Correct-answer literals: string literals compared with `=` against a data
 * node inside a `calculate`. ACE scores by comparing the question to the
 * correct answer's literal value (`if(/data/q1 = 'the right answer', 100, 0)`),
 * so those literals ARE the answer key — the only place it exists, since
 * CommCare has no correct-option primitive.
 */
function extractCorrectAnswers(doc: Document): string[] {
  const out = new Set<string>();
  const binds = Array.from(doc.getElementsByTagName('bind'));
  for (const bind of binds) {
    const calc = bind.getAttribute('calculate');
    if (!calc) continue;
    for (const m of calc.matchAll(/\/data\/[\w./-]+\s*(?:=|eq)\s*'([^']+)'/g)) {
      if (m[1].trim()) out.add(m[1].trim());
    }
    for (const m of calc.matchAll(/\/data\/[\w./-]+\s*(?:=|eq)\s*"([^"]+)"/g)) {
      if (m[1].trim()) out.add(m[1].trim());
    }
  }
  return [...out];
}

/**
 * Nodesets whose `relevant` marks them as the FAIL branch of a score gate —
 * a comparison of a score node against a threshold using `<` / `<=`.
 *
 * The PASS branch is deliberately NOT checked: a pass message may legitimately
 * restate what the worker got right. Only the retry path can be used to guess
 * the next attempt.
 */
function failBranchNodesets(doc: Document): string[] {
  const out: string[] = [];
  for (const bind of Array.from(doc.getElementsByTagName('bind'))) {
    const rel = bind.getAttribute('relevant');
    const nodeset = bind.getAttribute('nodeset');
    if (!rel || !nodeset) continue;
    if (!/score/i.test(rel)) continue;
    // `&lt;` is already decoded to `<` by the parser.
    if (/<\s*=?\s*[\d.]/.test(rel)) out.push(nodeset);
  }
  return out;
}

/** Visible text of the body control bound to `nodeset` (its `<label>`). */
function labelTextFor(doc: Document, nodeset: string): string {
  for (const tag of ['trigger', 'input', 'select1', 'select', 'upload']) {
    for (const el of Array.from(doc.getElementsByTagName(tag))) {
      if (el.getAttribute('ref') !== nodeset) continue;
      const labels = Array.from(el.getElementsByTagName('label'));
      if (labels.length) return textOf(labels[0]);
    }
  }
  return '';
}

/**
 * Flag any fail-branch result label whose text contains a correct-answer
 * literal. Comparison is normalized (case-insensitive, whitespace-collapsed)
 * so a reworded restatement still trips it — the leak is the CONTENT, not the
 * exact spelling.
 */
export function checkAssessmentRetryLeak(xml: string): RetryLeakReport {
  // `as unknown as Document` mirrors lib/constraint-locality.ts: xmldom's
  // Document is structurally narrower than the DOM lib's.
  const doc = new DOMParser().parseFromString(xml, 'text/xml') as unknown as Document;
  const correctAnswers = extractCorrectAnswers(doc);
  const failNodesets = failBranchNodesets(doc);
  const checked = correctAnswers.length > 0 && failNodesets.length > 0;
  if (!checked) return { checked: false, ok: true, correctAnswers, leaks: [] };

  const leaks: RetryLeak[] = [];
  for (const nodeset of failNodesets) {
    const text = labelTextFor(doc, nodeset);
    if (!text) continue;
    const haystack = norm(text);
    for (const answer of correctAnswers) {
      if (haystack.includes(norm(answer))) {
        leaks.push({ label: nodeset, leaked: answer, text });
        break;
      }
    }
  }
  return { checked: true, ok: leaks.length === 0, correctAnswers, leaks };
}

export function formatRetryLeakReport(report: RetryLeakReport): string {
  if (!report.checked) return 'assessment-retry-leak: not applicable (no score-gated result labels)';
  if (report.ok) return 'assessment-retry-leak: clean — no fail-branch label restates a correct answer';
  return [
    `assessment-retry-leak: ${report.leaks.length} fail-branch label(s) restate the correct answer —`,
    'a worker who fails once is shown the answer and passes on the next attempt,',
    'which makes the Connect Deliver-unlock gate decorative (dimagi-internal/ace#1041).',
    ...report.leaks.map(
      (l) => `  ${l.label}: leaks "${l.leaked}"\n    text: ${l.text}`,
    ),
    'Fix: point the failing worker back at the MODULE CONTENT — the point of a fail',
    'message is to send them to the teaching, not to substitute for it.',
  ].join('\n');
}
