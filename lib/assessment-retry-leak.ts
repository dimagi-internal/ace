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
  /**
   * True only when the check RAN FULLY and found nothing: no leaks AND
   * nothing it could not resolve. A blind check that reports clean is how
   * this whole class stayed invisible (#1332) — `blind` is not a footnote.
   */
  ok: boolean;
  /** Correct-answer literals recovered from the scoring binds. */
  correctAnswers: string[];
  /** What each literal is actually matched against — its resolved option prose. */
  answerNeedles: Record<string, string[]>;
  leaks: RetryLeak[];
  /** Reasons the check could not fully run, one line each. */
  blind: string[];
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
    // `&lt;` / `&gt;` are already decoded by the parser.
    // Direct less-than, e.g. `/data/user_score < 80`.
    if (/<\s*=?\s*[\d.]/.test(rel)) {
      out.push(nodeset);
      continue;
    }
    // Negated greater-than — semantically the same branch, and the shape
    // CommCare's own builder emits: `not(/data/user_score >= 100)` (#1332).
    if (/not\s*\([^)]*>\s*=?\s*[\d.][^)]*\)/.test(rel)) out.push(nodeset);
  }
  return out;
}

/** Shortest literal matched on its own. Below this an answer VALUE is a code
 *  (`'c'`, `'ab'`), not prose — see `answerNeedles`. */
const MIN_LITERAL_LEN = 3;

const ITEXT_REF = /jr:itext\(\s*['"]([^'"]+)['"]\s*\)/;

/** Media forms carry no readable prose. `long`/`short` do. */
function isProseValue(v: Element): boolean {
  const form = v.getAttribute('form');
  return !form || form === 'long' || form === 'short';
}

/**
 * `<text id>` → its prose in EVERY locale, kept as one entry per locale.
 *
 * Locale-blind on purpose: ACE ships trilingual Learn apps, and a leak in the
 * French label is a leak. Kept SEPARATE rather than pooled because each
 * locale's option prose has to be its own needle — a pooled
 * "Over the sleeping area Au-dessus du couchage" matches neither label.
 */
function buildItextIndex(doc: Document): Map<string, string[]> {
  const idx = new Map<string, string[]>();
  for (const t of Array.from(doc.getElementsByTagName('text'))) {
    const id = t.getAttribute('id');
    if (!id) continue;
    const parts = Array.from(t.getElementsByTagName('value'))
      .filter(isProseValue)
      .map((v) => textOf(v))
      .filter(Boolean);
    if (!parts.length) continue;
    idx.set(id, [...(idx.get(id) ?? []), parts.join(' ')]);
  }
  return idx;
}

function directChildren(el: Element, tag: string): Element[] {
  return Array.from(el.childNodes ?? [])
    .filter((n): n is Element => (n as Element).nodeType === 1 && (n as Element).nodeName === tag);
}

/**
 * A control's own label text — inline when authored inline, resolved through
 * `<itext>` when compiled.
 *
 * A RELEASED CCZ is always the compiled shape: CommCare's XForm compiler moves
 * ALL label text into `<itext>` and leaves `<label ref="jr:itext('id')"/>`,
 * whose `textContent` is the empty string. Reading only inline text described
 * an authoring-time blueprint, not the artifact `app-release-qa` actually
 * holds (#1332).
 *
 * `null` distinguishes "there is a label and its text is unreachable" from
 * "there is no label" — the caller must not treat either as clean.
 */
function labelTextOf(el: Element, itext: Map<string, string[]>): string | null {
  const [label] = directChildren(el, 'label');
  if (!label) return null;
  const inline = textOf(label);
  if (inline) return inline;
  const m = ITEXT_REF.exec(label.getAttribute('ref') ?? '');
  if (!m) return null;
  // Every locale joined: the haystack only has to CONTAIN the needle, so
  // pooling here widens coverage without costing precision.
  return itext.get(m[1])?.join(' ') ?? null;
}

function controlFor(doc: Document, nodeset: string): Element | null {
  for (const tag of ['trigger', 'input', 'select1', 'select', 'upload']) {
    for (const el of Array.from(doc.getElementsByTagName(tag))) {
      if (el.getAttribute('ref') === nodeset) return el;
    }
  }
  return null;
}

/** Option VALUE → its label prose, resolved through itext. */
function optionProse(doc: Document, itext: Map<string, string[]>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const item of Array.from(doc.getElementsByTagName('item'))) {
    const [valueEl] = directChildren(item, 'value');
    const value = textOf(valueEl);
    if (!value) continue;
    const [label] = directChildren(item, 'label');
    if (!label) continue;
    const inline = textOf(label);
    const m = ITEXT_REF.exec(label.getAttribute('ref') ?? '');
    // One needle PER LOCALE — see buildItextIndex.
    const variants = inline ? [inline] : m ? (itext.get(m[1]) ?? []) : [];
    if (!variants.length) continue;
    out.set(value, [...(out.get(value) ?? []), ...variants]);
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Substring for a phrase; word-boundary for a single word, so a 3-letter
 * needle does not match inside a longer word ("yes" in "eyes").
 */
function containsNeedle(haystack: string, needle: string): boolean {
  const n = norm(needle);
  if (!n) return false;
  if (/\s/.test(n)) return haystack.includes(n);
  return new RegExp(`(^|[^a-z0-9])${escapeRe(n)}([^a-z0-9]|$)`).test(haystack);
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
  const itext = buildItextIndex(doc);
  const correctAnswers = extractCorrectAnswers(doc);
  const failNodesets = failBranchNodesets(doc);
  const checked = correctAnswers.length > 0 && failNodesets.length > 0;

  // What a worker actually reads is the option's PROSE, not the value the
  // form stores. In a compiled select1 the answer key recovered from the
  // scoring calculate is the value (`'c'`), so matching the literal directly
  // would fire on any sentence containing the letter c (#1332 defect 3).
  const prose = optionProse(doc, itext);
  const answerNeedles: Record<string, string[]> = {};
  const blind: string[] = [];
  for (const answer of correctAnswers) {
    const needles = [...(prose.get(answer) ?? [])];
    if (answer.length >= MIN_LITERAL_LEN) needles.push(answer);
    answerNeedles[answer] = needles;
    if (checked && needles.length === 0) {
      blind.push(
        `answer literal '${answer}' is a ${answer.length}-char option code with no resolvable ` +
          `option label — nothing to match a leak against`,
      );
    }
  }

  if (!checked) {
    return { checked: false, ok: true, correctAnswers, answerNeedles, leaks: [], blind: [] };
  }

  const leaks: RetryLeak[] = [];
  for (const nodeset of failNodesets) {
    const control = controlFor(doc, nodeset);
    const text = control ? labelTextOf(control, itext) : null;
    if (text === null || text === '') {
      // A silent `continue` here is precisely what made this check read as
      // clean on every released CCZ. Blind is a reported state, not a skip.
      blind.push(
        control
          ? `${nodeset}: label text is unresolvable (itext ref points at no <text> id)`
          : `${nodeset}: no body control is bound to this fail-branch nodeset`,
      );
      continue;
    }
    const haystack = norm(text);
    let leaked = false;
    for (const answer of correctAnswers) {
      for (const needle of answerNeedles[answer]) {
        if (containsNeedle(haystack, needle)) {
          leaks.push({ label: nodeset, leaked: needle, text });
          leaked = true;
          break;
        }
      }
      if (leaked) break;
    }
  }
  return {
    checked: true,
    ok: leaks.length === 0 && blind.length === 0,
    correctAnswers,
    answerNeedles,
    leaks,
    blind,
  };
}

export function formatRetryLeakReport(report: RetryLeakReport): string {
  if (!report.checked) return 'assessment-retry-leak: not applicable (no score-gated result labels)';
  if (report.ok) return 'assessment-retry-leak: clean — no fail-branch label restates a correct answer';
  const blindBlock = report.blind.length
    ? [
        `assessment-retry-leak: BLIND on ${report.blind.length} item(s) — the check could not run to`,
        'completion, which is NOT a pass. Reported rather than skipped because a silent skip is what',
        'made this decorative on every released CCZ (dimagi-internal/ace#1332).',
        ...report.blind.map((b) => `  ${b}`),
      ]
    : [];
  if (report.leaks.length === 0) return blindBlock.join('\n');
  return [
    ...blindBlock,
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
