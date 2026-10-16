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
import { type CheckOutcome, checked, unable, formatUnable } from './check-outcome.js';

export interface RetryLeak {
  /** Nodeset of the fail-branch label that leaked, e.g. `/data/fail_msg`. */
  label: string;
  /**
   * `blocker` — a real restatement on a form that gates (or may gate) the
   * Deliver unlock. `info` — a hit the check cannot stand behind as a leak:
   * a short answer token (≤ 4 letters, e.g. `No.` / Tumbuka `Yayi.`, which is
   * also an ordinary clause-final negator) or any hit on a form Connect
   * provably does not score (learn markers, no `<assessment>`). ace#2208.
   */
  severity: 'blocker' | 'info';
  /** Why a hit was downgraded to `info`; absent on a blocker. */
  downgraded?: string;
  /** The correct-answer literal found inside it. */
  leaked: string;
  /** The label's full text, for the report. */
  text: string;
}

/**
 * `status: 'unable'` when the form carries no score-gated result labels —
 * nothing to leak into, so the check did not apply. That is NOT a pass and is
 * no longer expressible as one (`lib/check-outcome.ts`); this helper returned
 * `checked: false, ok: true` on that path, and #1332 is the run where a
 * matcher bug made EVERY released CCZ take it.
 *
 * `ok` on the `checked` branch is true only when the check RAN FULLY and found
 * nothing: no leaks AND nothing it could not resolve. `blind` is not a
 * footnote — a blind check that reports clean is the same class one level down.
 *
 * `findings` holds the leaks (renamed from `leaks` when this moved onto the
 * shared `CheckOutcome` shape, so `opp-eval`-style consumers can read any
 * check's findings without per-helper knowledge).
 */
export type RetryLeakReport = CheckOutcome<
  RetryLeak,
  {
    /** Correct-answer literals recovered from the scoring binds. */
    correctAnswers: string[];
    /** What each literal is actually matched against — its resolved option prose. */
    answerNeedles: Record<string, string[]>;
    /** Reasons the check could not fully run, one line each. */
    blind: string[];
    /**
     * Hits recorded but NOT counted as leaks (`severity: 'info'`). They never
     * affect `ok`; `findings` holds blockers only, so a consumer that treats
     * every finding as a BLOCKER stays correct (ace#2208).
     */
    info: RetryLeak[];
    /**
     * `assessment` — the form carries Connect's `<assessment>` block, so it is
     * the Deliver-unlock gate. `non-gating` — it carries Connect learn markers
     * but no `<assessment>` (a baseline/pre-test, ace#1131): Connect never
     * scores it, so a hit is INFO. `unknown` — no learn markers at all (an
     * authoring-time blueprint); treated as gating, the conservative side.
     */
    gating: 'assessment' | 'non-gating' | 'unknown';
  }
>;

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
function extractAnswerKey(doc: Document): Map<string, Set<string>> {
  // question nodeset → its correct-answer literal(s). Kept PER ITEM so a fail
  // label is compared only against the items its own score depends on, not
  // the union of every correct label in the form (ace#2208 recommendation 3).
  const out = new Map<string, Set<string>>();
  const add = (q: string, lit: string) => {
    const v = lit.trim();
    if (!v) return;
    out.set(q, (out.get(q) ?? new Set<string>()).add(v));
  };
  for (const bind of Array.from(doc.getElementsByTagName('bind'))) {
    const calc = bind.getAttribute('calculate');
    if (!calc) continue;
    for (const m of calc.matchAll(/(\/data\/[\w./-]+)\s*(?:=|eq)\s*'([^']+)'/g)) add(m[1], m[2]);
    for (const m of calc.matchAll(/(\/data\/[\w./-]+)\s*(?:=|eq)\s*"([^"]+)"/g)) add(m[1], m[2]);
  }
  return out;
}

const DATA_REF = /\/data\/[\w./-]+/g;

/**
 * The question nodesets a fail label's `relevant` depends on, found by
 * walking calculate binds from the score it tests down to the items that
 * score. Empty when nothing resolves — the caller then falls back to every
 * item, the conservative side.
 */
function itemsBehind(doc: Document, relevant: string, items: Set<string>): Set<string> {
  const calcOf = new Map<string, string>();
  for (const b of Array.from(doc.getElementsByTagName('bind'))) {
    const n = b.getAttribute('nodeset');
    const c = b.getAttribute('calculate');
    if (n && c) calcOf.set(n, c);
  }
  const found = new Set<string>();
  const seen = new Set<string>();
  const stack = [...relevant.matchAll(DATA_REF)].map((m) => m[0]);
  while (stack.length) {
    const ref = stack.pop()!;
    if (seen.has(ref)) continue;
    seen.add(ref);
    if (items.has(ref)) found.add(ref);
    const calc = calcOf.get(ref);
    if (calc) for (const m of calc.matchAll(DATA_REF)) stack.push(m[0]);
  }
  return found;
}

const CONNECT_LEARN_NS = 'http://commcareconnect.com/data/v1/learn';

function gatingOf(doc: Document): 'assessment' | 'non-gating' | 'unknown' {
  if (doc.getElementsByTagNameNS(CONNECT_LEARN_NS, 'assessment').length > 0) return 'assessment';
  if (doc.getElementsByTagNameNS(CONNECT_LEARN_NS, '*').length > 0) return 'non-gating';
  return 'unknown';
}

/**
 * Score thresholds a PASS branch compares against — the `100` in
 * `relevant="/data/user_score >= 100"`.
 *
 * Needed because `!= N` names the fail branch only when N is the PASSING
 * threshold: `user_score != 100` is "did not pass" under a 100% gate, while
 * `user_score != 0` is "scored something" and is not a fail branch at all.
 * The threshold is not a parameter anywhere on this path — the check reads a
 * form XML and nothing else — so it is recovered from the same document,
 * which is also where every other fact this checker uses comes from.
 *
 * `>` / `>=` / bare `=` are the pass-side operators; `!=`, `<=` and `>=`'s own
 * `=` are excluded by the lookbehind so only a genuine equality contributes.
 * A `not(...)` relevant is skipped outright: that is the fail branch.
 */
function passThresholds(doc: Document): Set<number> {
  const out = new Set<number>();
  for (const bind of Array.from(doc.getElementsByTagName('bind'))) {
    const rel = bind.getAttribute('relevant');
    if (!rel || !/score/i.test(rel)) continue;
    if (/\bnot\s*\(/.test(rel)) continue;
    for (const m of rel.matchAll(/(?:>\s*=?|(?<![<>!=])=(?!=))\s*([\d.]+)/g)) {
      const n = Number(m[1]);
      if (Number.isFinite(n)) out.add(n);
    }
  }
  return out;
}

/**
 * Nodesets whose `relevant` marks them as the FAIL branch of a score gate —
 * a comparison of a score node against a threshold using `<` / `<=`, the
 * negated `not(... >= N)`, or the inequality `!= N` / `not(... = N)`.
 *
 * The PASS branch is deliberately NOT checked: a pass message may legitimately
 * restate what the worker got right. Only the retry path can be used to guess
 * the next attempt.
 */
function failBranchNodesets(doc: Document): Array<{ nodeset: string; relevant: string }> {
  const out: Array<{ nodeset: string; relevant: string }> = [];
  const thresholds = passThresholds(doc);
  for (const bind of Array.from(doc.getElementsByTagName('bind'))) {
    const rel = bind.getAttribute('relevant');
    const nodeset = bind.getAttribute('nodeset');
    if (!rel || !nodeset) continue;
    if (!/score/i.test(rel)) continue;
    // `&lt;` / `&gt;` are already decoded by the parser.
    // Direct less-than, e.g. `/data/user_score < 80`.
    if (/<\s*=?\s*[\d.]/.test(rel)) {
      out.push({ nodeset, relevant: rel });
      continue;
    }
    // Negated greater-than — semantically the same branch, and the shape
    // CommCare's own builder emits: `not(/data/user_score >= 100)` (#1332).
    if (/not\s*\([^)]*>\s*=?\s*[\d.][^)]*\)/.test(rel)) {
      out.push({ nodeset, relevant: rel });
      continue;
    }
    // Inequality against the passing threshold: `!= 100`, or its `not(... = 100)`
    // spelling. NOT an exotic shape — it is the natural one whenever the passing
    // score is 100, because a 0–100 score has no headroom above the threshold, so
    // "not passed" IS "not exactly 100" and `< 100` is the LESS obvious spelling.
    // Every 100%-gated assessment was therefore unchecked until #1576.
    //
    // Gated on the literal actually being the passing threshold, so a `!= 0`
    // ("scored something") is not mistaken for a retry branch.
    const neq =
      /!=\s*([\d.]+)/.exec(rel) ??
      /not\s*\([^)]*?(?<![<>!=])=(?!=)\s*([\d.]+)[^)]*\)/.exec(rel);
    if (neq && thresholds.has(Number(neq[1]))) out.push({ nodeset, relevant: rel });
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

/** A needle's core: normalized, with edge punctuation stripped (`Yayi.` → `yayi`). */
function needleCore(needle: string): string {
  return norm(needle).replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

/**
 * Unicode word-boundary match, for a phrase and a single word alike, so a
 * needle never matches inside a longer word — Chichewa `ayi` inside Tumbuka
 * `yayi`, `yes` inside `eyes`. `\p{L}` rather than `[a-z]`: Tumbuka writes
 * `ŵ` (U+0175), and an ASCII class reads it as a boundary (ace#2208).
 */
function containsNeedle(haystack: string, needle: string): boolean {
  const n = needleCore(needle);
  if (!n) return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(n)}([^\\p{L}\\p{N}]|$)`, 'u').test(haystack);
}

/**
 * Longest answer token counted as a leak on its own. At or below it an option
 * label is a yes/no particle (`No.`, Chichewa `Ayi.`, Tumbuka `Yayi.`), and in
 * Bantu-language layers those are also productive clause-final negators — the
 * label flagged on spark-facilitator/20260907-1120 ended "…yekha yayi." as
 * plain grammar. A hit on one is recorded as INFO, never a BLOCKER (ace#2208).
 */
const SHORT_TOKEN_MAX = 4;

function isShortToken(needle: string): boolean {
  const n = needleCore(needle);
  return !/\s/.test(n) && [...n].length <= SHORT_TOKEN_MAX;
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
  const answerKey = extractAnswerKey(doc);
  const correctAnswers = [...new Set([...answerKey.values()].flatMap((v) => [...v]))];
  const failNodesets = failBranchNodesets(doc);
  const gating = gatingOf(doc);
  const ran = correctAnswers.length > 0 && failNodesets.length > 0;

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
    if (ran && needles.length === 0) {
      blind.push(
        `answer literal '${answer}' is a ${answer.length}-char option code with no resolvable ` +
          `option label — nothing to match a leak against`,
      );
    }
  }

  if (!ran) {
    return unable(
      `no score-gated result label to inspect: recovered ${correctAnswers.length} correct-answer ` +
        `literal(s) from the scoring binds and ${failNodesets.length} fail-branch nodeset(s); both ` +
        'must be non-empty. If this form DOES gate a retry message on the score, the recovery ' +
        'matchers are the bug — that was #1332 on every released CCZ',
    );
  }

  // Per item: an item's needles come from ITS OWN select's option prose, so
  // option value 'c' of q1 is not matched with the prose of q2's 'c'.
  const needlesFor = (item: string, answer: string): string[] => {
    const control = controlFor(doc, item);
    if (!control) return answerNeedles[answer] ?? [];
    const own = optionProse(control as unknown as Document, itext).get(answer) ?? [];
    return answer.length >= MIN_LITERAL_LEN ? [...own, answer] : own;
  };

  const leaks: RetryLeak[] = [];
  const info: RetryLeak[] = [];
  const items = new Set(answerKey.keys());
  for (const { nodeset, relevant } of failNodesets) {
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
    // Only the items this label's score depends on; every item when the
    // dependency walk resolves none (the conservative side).
    const scoped = itemsBehind(doc, relevant, items);
    const pairs = [...(scoped.size ? scoped : items)].flatMap((q) =>
      [...(answerKey.get(q) ?? [])].map((answer) => ({ q, answer })),
    );
    const haystack = norm(text);
    let blocker: RetryLeak | undefined;
    let soft: RetryLeak | undefined;
    for (const { q, answer } of pairs) {
      for (const needle of needlesFor(q, answer)) {
        if (!containsNeedle(haystack, needle)) continue;
        const why = isShortToken(needle)
          ? `answer token "${needleCore(needle)}" is ≤ ${SHORT_TOKEN_MAX} letters — a yes/no ` +
            'particle that ordinary prose (and clause-final negation) also contains'
          : gating === 'non-gating'
            ? 'the form carries Connect learn markers but no <assessment> block, so Connect never scores it'
            : undefined;
        if (!why) {
          blocker = { label: nodeset, leaked: needle, text, severity: 'blocker' };
          break;
        }
        soft ??= { label: nodeset, leaked: needle, text, severity: 'info', downgraded: why };
      }
      if (blocker) break;
    }
    if (blocker) leaks.push(blocker);
    else if (soft) info.push(soft);
  }
  return {
    ...checked(leaks.length === 0 && blind.length === 0, leaks),
    correctAnswers,
    answerNeedles,
    blind,
    info,
    gating,
  };
}

export function formatRetryLeakReport(report: RetryLeakReport): string {
  if (report.status === 'unable') return formatUnable('assessment-retry-leak', report.reason);
  const infoBlock = report.info.map(
    (l) => `  [INFO] ${l.label}: matched "${l.leaked}" — not counted as a leak: ${l.downgraded}`,
  );
  if (report.ok) {
    return ['assessment-retry-leak: clean — no fail-branch label restates a correct answer', ...infoBlock].join(
      '\n',
    );
  }
  const blindBlock = report.blind.length
    ? [
        `assessment-retry-leak: BLIND on ${report.blind.length} item(s) — the check could not run to`,
        'completion, which is NOT a pass. Reported rather than skipped because a silent skip is what',
        'made this decorative on every released CCZ (dimagi-internal/ace#1332).',
        ...report.blind.map((b) => `  ${b}`),
      ]
    : [];
  if (report.findings.length === 0) return [...blindBlock, ...infoBlock].join('\n');
  return [
    ...blindBlock,
    ...infoBlock,
    `assessment-retry-leak: ${report.findings.length} fail-branch label(s) restate the correct answer —`,
    'a worker who fails once is shown the answer and passes on the next attempt,',
    'which makes the Connect Deliver-unlock gate decorative (dimagi-internal/ace#1041).',
    ...report.findings.map(
      (l) => `  ${l.label}: leaks "${l.leaked}"\n    text: ${l.text}`,
    ),
    'Fix: point the failing worker back at the MODULE CONTENT — the point of a fail',
    'message is to send them to the teaching, not to substitute for it.',
  ].join('\n');
}
