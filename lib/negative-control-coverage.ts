/**
 * Negative-control coverage — the pure analysis behind
 * `test/skills/negative-control-ratchet.test.ts`.
 *
 * ## The failure class
 *
 * A check that reports success while being **structurally incapable of
 * reporting failure**. It is worse than no check at all, because it launders
 * confidence: a green gate is read as evidence, and evidence is the one thing
 * it could never produce.
 *
 * Measured over one ACE run (`spark-facilitator/20260820-0817`, 2026-08-26/27):
 * 15 issues filed, **10 of them defects in gates, linters or evals** rather
 * than in the product. Three were `blocks-e2e`, and all three lived in the
 * same place:
 *
 *   | Issue | The check could not fail because…                                  |
 *   |-------|--------------------------------------------------------------------|
 *   | #1693 | `auditDataset` read an AND of gates as INDEPENDENT, so any         |
 *   |       | multi-gated field violated in both directions at once — check 9    |
 *   |       | could never pass on a nested-`relevant` form.                      |
 *   | #1695 | `scrubOffBranchFields` reported a never-asked field as unresolved.  |
 *   | #1701 | Check 7 THREW on every real payload (labs writes                   |
 *   |       | `snapshot.pipelines` as a dict, the check iterated it as an array), |
 *   |       | and its `snapshot-missing-pipelines` branch was unreachable        |
 *   |       | besides — a dict has no `.length`, and `undefined === 0` is false. |
 *   | #1679 | `ocs-chatbot-qa`'s wrong-embed-key negative control was documented  |
 *   |       | as 403 and live returns 401 — and a MISSING key was not rejected    |
 *   |       | at all (201). Written from that prose, it could never fire.        |
 *
 * ## The two tiers, and why the shape of a verdict is the whole problem
 *
 * Whether a test asserts FAILURE is only decidable if you know which field
 * carries the verdict and which way it points. ACE's uniform shapes make that
 * mechanical: `QACheckResult.pass`, `CheckOutcome.ok`, a report's
 * `violations` / `findings` array. A check that invents its own vocabulary —
 * `{ satisfiable: boolean | 'unknown' }`, `{ stale: true }` — does not, and
 * `stale: true` is a FAILURE while `satisfiable: true` is a pass, which no
 * syntactic rule recovers.
 *
 * So there are two ratchets rather than one loose rule:
 *
 *  - **Tier 1 — uniform verdict.** Coverage is asserted directly, because
 *    "does this block assert failure" has an exact answer.
 *  - **Tier 2 — bespoke verdict.** Pinned by name and not allowed to grow. A
 *    new check must adopt a uniform verdict shape, which is independently the
 *    thing that makes its failure state legible to a caller (the argument
 *    `lib/check-outcome.ts` already makes for `CheckOutcome`).
 *
 * A loose one-tier detector was tried first and is what this design replaces:
 * it read `.stale === true` as a pass and `expect(r.satisfiable).toBe(false)`
 * as nothing at all. Precision is the property that matters here — a detector
 * that over-reports coverage recreates the exact failure class it is for.
 *
 * ## Two different defects a ledger entry can name
 *
 * A check can be **invoked but unable to fail** (all four issues above), or
 * **able to fail but never invoked**. Same root cause — the invariant lives in
 * prose rather than in a hook — but different fixes, so the report says which.
 * `lib/choice-label-integrity.ts` is the live example of the second: both its
 * checks are exported, documented in `skills/_app-component-library.md`,
 * thoroughly tested, and called by nothing (ace#1688/#1689).
 *
 * *Enforced:* `test/lib/negative-control-coverage.test.ts` — including
 * negative controls for this module, which would otherwise be a check that
 * cannot fail, in a file about checks that cannot fail.
 */

/** A function whose contract is "gate this artifact and report what's wrong". */
export interface CheckSurface {
  /** Repo-relative path, e.g. `lib/dataset-constraints.ts`. */
  file: string;
  /** Exported function name. */
  fn: string;
  /** Which verdict vocabulary it returns. See `VerdictShape`. */
  shape: VerdictShape;
  /** The declared return type, verbatim — for reporting. */
  returnType: string;
}

/**
 * - `pass`    — returns `QACheckResult`: `{ pass: boolean, detail, auto_fix_hint }`.
 * - `outcome` — returns `CheckOutcome<F>`: `{ status: 'checked', ok } | { status: 'unable' }`.
 * - `findings`— returns a report interface declaring a `violations` or `findings` array.
 * - `bespoke` — anything else. Tier 2: pinned, not asserted.
 */
export type VerdictShape = 'pass' | 'outcome' | 'findings' | 'bespoke';

export interface TestBlock {
  file: string;
  title: string;
  /** Source of the `it(...)` call, literals unmasked. */
  body: string;
  /**
   * Everything that can legitimately be said to set this block up: its own
   * body plus the prologue of every enclosing `describe` (that describe's
   * source with its `it` blocks removed). ACE tests routinely hoist the call
   * — `const r = checkX(BAD)` at describe scope, then several `it`s asserting
   * different facets of `r` — and a detector that only reads the `it` body
   * calls all of those uncovered.
   */
  callContext: string;
}

export interface CoverageRow {
  surface: CheckSurface;
  /** Blocks that exercise the surface and assert it reports a FAILURE. */
  negative: TestBlock[];
  /** Blocks that exercise the surface and assert it reports CLEAN. */
  positive: TestBlock[];
  /** Blocks that exercise the surface at all. */
  exercised: TestBlock[];
}

/**
 * The mechanical rule for "this is a check surface".
 *
 * `check*` and `audit*` are ACE's two naming families for artifact gates
 * (`checkDashboardBindings`, `auditDataset`, `auditConfidentiality`). The
 * prefix is the whole rule — no registry to keep in sync, and a new gate is
 * enrolled by being named like every other gate.
 *
 * Deliberately NOT `classify*`: a classifier's failure mode is "assigns the
 * wrong class", not "cannot report failure", so an ordinary unit test already
 * binds it. Check-shaped exceptions opt in via `EXTRA_SURFACES`.
 */
export const SURFACE_NAME = /^(check|audit)[A-Z]/;

/**
 * Check-shaped functions whose NAME does not match `SURFACE_NAME`.
 *
 * `classifyUtilities` is here because ace#1699 was precisely a false-firing of
 * it: it linted `data-testid="row-count"` as an unresolved Tailwind utility
 * and blocked the upload with `exit 1`. It is a lint returning findings; only
 * its name says otherwise.
 */
export const EXTRA_SURFACES: readonly { file: string; fn: string }[] = [
  { file: 'lib/tailwind-utility-resolution.ts', fn: 'classifyUtilities' },
  // A deterministic structural gate returning findings, in front of an
  // irreversible Connect create. Its first revision failed OPEN on several
  // inputs (a quoted `total_budget: "900"` produced zero issues), which is the
  // exact failure a negative control catches and an ordinary unit test does
  // not: every positive case still passed.
  { file: 'lib/connect-opp-spec.ts', fn: 'validateConnectOppSpec' },
];

// ── Verdict-shape-specific assertion signals ───────────────────────────────
//
// Each pair says, for one verdict vocabulary, what an assertion of FAILURE
// and an assertion of CLEAN look like. Being per-shape is what buys the
// precision: `.toBe(false)` means failure on a `pass` verdict and means
// nothing at all on a report that carries no boolean.

const FINDINGS = '(?:violations|findings|problems|unresolved\\w*|offenders|issues|failures|missing)';

const SIGNALS: Record<Exclude<VerdictShape, 'bespoke'>, { negative: RegExp; positive: RegExp }> = {
  pass: {
    negative: new RegExp(
      `\\.pass\\b[\\s\\S]{0,40}?\\.toBe\\(false\\)|\\bexpectQAFailWithCheck\\b|\\btoThrow\\b|pass:\\s*false`,
    ),
    positive: new RegExp(`\\.pass\\b[\\s\\S]{0,40}?\\.toBe\\(true\\)|\\bexpectQAPass\\b|pass:\\s*true`),
  },
  outcome: {
    negative: new RegExp(
      `\\.ok\\b[\\s\\S]{0,40}?\\.toBe\\(false\\)|\\bassertUnable\\b|\\btoThrow\\b|` +
        `${FINDINGS}[\\s\\S]{0,160}?(?:\\.toContain\\(|\\.toBeDefined\\(|\\.toMatchObject\\(|\\.toHaveLength\\(\\s*[1-9]|\\.toBeGreaterThan\\(\\s*0\\s*\\)|\\.toEqual\\(\\s*\\[\\s*['\"\\u0060])`,
    ),
    positive: new RegExp(
      `\\.ok\\b[\\s\\S]{0,40}?\\.toBe\\(true\\)|` +
        `${FINDINGS}[\\s\\S]{0,160}?(?:\\.toHaveLength\\(\\s*0\\s*\\)|\\.toEqual\\(\\[\\]\\)|\\.not\\.toContain\\()`,
    ),
  },
  findings: {
    // An audit returning `Finding[]` is routinely asserted INLINE —
    // `expect(auditDocFidelity([doc('…')])).toEqual([])` — with no variable
    // named `findings` anywhere in the block. So the array-shaped assertions
    // stand on their own (the block already exercises the surface), while the
    // looser `toContain` / `toBeDefined` forms stay anchored on a
    // findings-ish name, so an assertion about `.detail` cannot mark a block
    // covered. Without the inline form, `auditDocFidelity` — which has two
    // explicit "does NOT fire on a properly converted document" cases — read
    // as having no positive control at all.
    negative: new RegExp(
      `\\.(?:pass|ok)\\b[\\s\\S]{0,40}?\\.toBe\\(false\\)|\\btoThrow\\b|` +
        `\\.toHaveLength\\(\\s*[1-9]|\\.toEqual\\(\\s*\\[\\s*['\"\\u0060]|\\.not\\.toEqual\\(\\[\\]\\)|` +
        `${FINDINGS}[\\s\\S]{0,160}?(?:\\.toContain\\(|\\.toBeDefined\\(|\\.toMatchObject\\(|\\.toBeGreaterThan\\(\\s*0\\s*\\))`,
    ),
    positive: new RegExp(
      `\\.(?:pass|ok)\\b[\\s\\S]{0,40}?\\.toBe\\(true\\)|\\.toEqual\\(\\[\\]\\)|\\.toHaveLength\\(\\s*0\\s*\\)|` +
        `${FINDINGS}[\\s\\S]{0,160}?\\.not\\.toContain\\(`,
    ),
  },
};

export function negativeSignal(shape: VerdictShape): RegExp | null {
  return shape === 'bespoke' ? null : SIGNALS[shape].negative;
}
export function positiveSignal(shape: VerdictShape): RegExp | null {
  return shape === 'bespoke' ? null : SIGNALS[shape].positive;
}

// ── Source parsing ─────────────────────────────────────────────────────────

const MASK_CACHE = new Map<string, string>();

/**
 * Replace the CONTENTS of string/template literals and comments with spaces,
 * preserving length and therefore every other character's offset.
 *
 * Bracket matching over raw TypeScript is wrong the moment a test title
 * contains a brace or paren — and ACE's titles routinely do
 * (`'still demands a multi-gated field when EVERY gate holds (#1693)'`).
 * Masking first makes every later offset exact.
 */
export function maskLiterals(src: string): string {
  const cached = MASK_CACHE.get(src);
  if (cached !== undefined) return cached;
  const result = maskLiteralsUncached(src);
  MASK_CACHE.set(src, result);
  return result;
}

function maskLiteralsUncached(src: string): string {
  const out = src.split('');
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      const end = src.indexOf('\n', i);
      blank(i, end < 0 ? src.length : end);
      i = end < 0 ? src.length : end;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      blank(i, end < 0 ? src.length : end + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (c === '/' && isRegexStart(src, i)) {
      // A regex literal's quotes are not string delimiters, and pretending
      // otherwise desyncs the whole file. `test/lib/scoring-arithmetic.test.ts:47`
      // is the measured case: `/calculate="\(\/data\/q1_score[^"]*"/` carries
      // three `"`, so a quote-only masker paired them across the regex
      // boundary, then opened a phantom template literal at the backtick that
      // follows and swallowed every `describe`/`it` in the file. The scanner
      // reported ZERO test blocks for a 300-line suite, and
      // `checkScoringArithmetic` — thoroughly covered — read as having no
      // test at all. Over-reporting debt is how a ratchet gets deleted.
      let j = i + 1;
      let inClass = false;
      for (; j < src.length; j++) {
        const ch = src[j];
        if (ch === '\\') {
          j++;
          continue;
        }
        if (ch === '\n') break;
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) break;
      }
      if (src[j] === '/') {
        blank(i + 1, j);
        i = j + 1;
        continue;
      }
      // Unterminated on this line — it was a division after all.
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === quote) break;
        // A `'` or `"` string cannot contain a raw newline. Reaching one means
        // this quote never opened a string — it is a quote inside a REGEX
        // literal, and the masker has desynced.
        //
        // Not hypothetical: `lib/entity-id-grain.ts:102` carries
        // `/^'[^']*'$/.test(a)`, whose three quotes leave one dangling. The
        // masker then treated the next 30 lines as one string and blanked
        // `export type GrainReport = CheckOutcome<…>` out of existence — so
        // the check read as having no declared verdict shape and was pinned
        // as bespoke debt it does not owe. Full regex-literal tokenizing needs
        // the whole `/`-is-divide-or-regex disambiguation; this rule costs two
        // lines and closes the same hole.
        if (quote !== '`' && src[j] === '\n') {
          j = i;
          break;
        }
        j++;
      }
      if (j === i) {
        i++;
        continue;
      }
      blank(i + 1, j);
      i = j + 1;
      continue;
    }
    i++;
  }
  return out.join('');
}

/**
 * Is the `/` at `i` the start of a regex literal rather than a division?
 *
 * The standard heuristic: a regex can only appear where an EXPRESSION is
 * expected, so look back at the last non-whitespace character. After a value
 * (`)`, `]`, identifier, number) a `/` divides; after an operator, an opening
 * bracket, a comma, or `return` it opens a regex.
 */
function isRegexStart(src: string, i: number): boolean {
  let k = i - 1;
  while (k >= 0 && /\s/.test(src[k])) k--;
  if (k < 0) return true;
  const prev = src[k];
  if (/[)\]}]/.test(prev)) return false;
  if (/[A-Za-z0-9_$]/.test(prev)) {
    // A keyword can precede a regex (`return /x/`), an identifier cannot.
    const word = /[A-Za-z_$][A-Za-z0-9_$]*$/.exec(src.slice(Math.max(0, k - 12), k + 1))?.[0] ?? '';
    return ['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'do', 'else', 'yield'].includes(word);
  }
  return true;
}

/** Index of the bracket matching the opener at `open`, or -1. */
function matchBracket(masked: string, open: number): number {
  const opener = masked[open];
  const closer = opener === '(' ? ')' : opener === '{' ? '}' : '';
  if (!closer) return -1;
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === opener) depth++;
    else if (masked[i] === closer) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

interface Span {
  start: number;
  end: number;
  title: string;
}

/** Spans of every `it(...)` / `test(...)` or `describe(...)` call. */
function callSpans(masked: string, source: string, keyword: 'it' | 'describe'): Span[] {
  const kw = keyword === 'it' ? '(?:it|test)' : 'describe';
  const re = new RegExp(`\\b${kw}(?:\\.\\w+)?\\s*(?:\\([\\s\\S]{0,400}?\\))?\\s*\\(`, 'g');
  const spans: Span[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked))) {
    const open = masked.lastIndexOf('(', m.index + m[0].length - 1);
    const close = matchBracket(masked, open);
    if (close < 0) continue;
    const raw = source.slice(open, close + 1);
    const title = /^\(\s*(?:\[[\s\S]*?\]\s*,\s*)?(['"`])([\s\S]*?)\1/.exec(raw)?.[2] ?? '';
    spans.push({ start: open, end: close, title });
    re.lastIndex = open + 1;
  }
  return spans;
}

/**
 * Every `it(...)` block with its body and its full call context.
 *
 * The body runs from the callback to the end of the `it(` call, which covers a
 * braced body, a concise arrow body (`it('fails', () => expect(r.pass).toBe(false))`)
 * and `it.each(...)` alike without needing to tell them apart.
 */
export function extractTestBlocks(file: string, source: string): TestBlock[] {
  const masked = maskLiterals(source);
  const its = callSpans(masked, source, 'it');
  const describes = callSpans(masked, source, 'describe');

  return its.map((span) => {
    const body = source.slice(span.start, span.end + 1);
    // Prologue of every enclosing describe: its source minus all `it` blocks
    // inside it. That is the shared setup and nothing else — including the
    // sibling `it`s would let one control cover every check in the file.
    const prologues: string[] = [];
    for (const d of describes) {
      if (d.start > span.start || d.end < span.end) continue;
      let text = '';
      let cursor = d.start;
      for (const inner of its) {
        if (inner.start < d.start || inner.end > d.end) continue;
        text += source.slice(cursor, inner.start);
        cursor = inner.end + 1;
      }
      text += source.slice(cursor, d.end + 1);
      prologues.push(text);
    }
    return { file, title: span.title, body, callContext: body + '\n' + prologues.join('\n') };
  });
}

/**
 * Names of file-local helpers that call `fn`, so a control routed through one
 * still counts.
 *
 * One level only, on purpose. `test/skills/idea-to-pdd-qa-payment-grain.test.ts`
 * writes `const check = (unit, grain) => checkPaymentUnitMatchesEntityGrain(...)`
 * and then asserts through it seven times; without this a thoroughly-covered
 * check reads as uncovered. Deeper chains are rare enough that the honest
 * answer is a ledger entry, not a general-purpose call graph.
 */
export function indirectCallers(source: string, fn: string): string[] {
  const masked = maskLiterals(source);
  const names: string[] = [];
  const call = new RegExp(`\\b${fn}\\s*[(<]`);

  for (const m of masked.matchAll(/\b(?:const|let)\s+([A-Za-z0-9_]+)\s*(?::[^=\n]{0,200})?=\s*(?:async\s*)?\(/g)) {
    const open = masked.indexOf('(', m.index + m[0].length - 1);
    const arrow = masked.indexOf('=>', open);
    if (arrow < 0) continue;
    const bodyStart = arrow + 2;
    const rest = masked.slice(bodyStart);
    let end: number;
    if (rest.trimStart().startsWith('{')) {
      end = matchBracket(masked, masked.indexOf('{', bodyStart));
    } else {
      const semi = masked.indexOf(';', bodyStart);
      end = semi < 0 ? masked.length : semi;
    }
    if (end < 0) end = masked.length;
    if (call.test(masked.slice(bodyStart, end + 1))) names.push(m[1]);
  }

  for (const m of masked.matchAll(/\bfunction\s+([A-Za-z0-9_]+)\s*\(/g)) {
    const brace = masked.indexOf('{', m.index);
    if (brace < 0) continue;
    const end = matchBracket(masked, brace);
    if (end < 0) continue;
    if (call.test(masked.slice(brace, end + 1))) names.push(m[1]);
  }
  return [...new Set(names)].filter((n) => n !== fn);
}

/**
 * Classify the verdict vocabulary a check returns, from its declared return
 * type and (for a local report interface) that interface's fields.
 *
 * An unannotated return type is `bespoke` — deliberately. A check whose
 * verdict shape is not written down is exactly the one whose failure state a
 * caller cannot read, which is the class this whole module is about.
 */
export function verdictShapeOf(source: string, fn: string): { shape: VerdictShape; returnType: string } {
  const masked = maskLiterals(source);
  const sig = new RegExp(`^export (?:async )?function ${fn}\\s*(?:<[^>]*>)?\\s*\\(`, 'm').exec(masked);
  if (!sig) return { shape: 'bespoke', returnType: '' };
  const open = masked.indexOf('(', sig.index + sig[0].length - 1);
  const close = matchBracket(masked, open);
  if (close < 0) return { shape: 'bespoke', returnType: '' };
  const ret = returnAnnotation(masked, close + 1);
  if (!ret) return { shape: 'bespoke', returnType: '' };

  const bare = ret.replace(/^Promise<([\s\S]*)>$/, '$1').trim();
  return { shape: resolveShape(masked, bare, 0), returnType: bare };
}

/**
 * The return-type annotation starting at `from` (just past the parameter
 * list), or `''` when there is none.
 *
 * The naive version — everything up to the first `{` — is wrong for an INLINE
 * object return type, which is exactly what a hand-rolled new check tends to
 * write: `function checkThing(x): { pass: boolean; detail: string } {` reads
 * as unannotated, so a perfectly legible `pass` verdict lands in tier 2 and
 * the author is told to adopt a uniform shape they already have. A `{` is
 * part of the TYPE when the last meaningful character before it is an
 * operator (`:` `|` `&` `,` `<` `(` `=>`); otherwise it opens the body.
 */
function returnAnnotation(masked: string, from: number): string {
  let i = from;
  while (i < masked.length && /\s/.test(masked[i])) i++;
  if (masked[i] !== ':') return '';
  i++;
  const start = i;
  while (i < masked.length) {
    const c = masked[i];
    if (c === '{') {
      const prev = masked.slice(start, i).trimEnd();
      // Empty prev = the brace sits immediately after the `:`, so it IS the
      // type — `(x): { pass: boolean } {`.
      const isTypeBrace = prev === '' || /[:|&,<(]$|=>$/.test(prev.slice(-2));
      if (!isTypeBrace) break;
      const end = matchBracket(masked, i);
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    if (c === ';' || c === '}') break;
    i++;
  }
  return masked.slice(start, i).trim();
}

/**
 * Resolve a return-type name to a verdict shape, following ONE level of local
 * type alias.
 *
 * `type ScoringReport = CheckOutcome<ScoringFinding, …>` is how four lib
 * checks declare themselves, and reading only the literal text calls all four
 * bespoke — which would pin well-covered checks as debt and make the ledger
 * mean less than it should.
 */
function resolveShape(masked: string, bare: string, depth: number): VerdictShape {
  if (depth > 2 || !bare) return 'bespoke';
  if (/^QACheckResult\b/.test(bare)) return 'pass';
  if (/^CheckOutcome\b/.test(bare)) return 'outcome';

  // `Finding[]` — an audit that returns its findings directly. Non-empty IS
  // the failure verdict; there is no wrapper to read. Nine of
  // `lib/run-surface-audit.ts`'s rules are this shape.
  const element = /^([A-Za-z0-9_]+)\[\]$/.exec(bare)?.[1];
  if (element && /(Finding|Violation|Issue|Problem|Gap)s?$/i.test(element)) return 'findings';

  const name = bare.replace(/<[\s\S]*$/, '').replace(/[^A-Za-z0-9_]/g, '');
  if (!name) return 'bespoke';

  const alias = new RegExp(`\\btype\\s+${name}\\s*=\\s*([\\s\\S]{0,400}?);`, 'm').exec(masked)?.[1]?.trim();
  if (alias && alias !== bare) {
    const viaAlias = resolveShape(masked, alias.replace(/<[\s\S]*$/, '').trim() + (/\[\]$/.test(alias) ? '[]' : ''), depth + 1);
    if (viaAlias !== 'bespoke') return viaAlias;
    if (/^CheckOutcome\b/.test(alias)) return 'outcome';
  }

  const declared = new RegExp(`(?:interface|type)\\s+${name}\\b[\\s\\S]{0,1200}?\\n\\}`, 'm').exec(masked)?.[0];
  const shapeText = declared ?? bare;
  if (new RegExp(`\\b${FINDINGS}\\s*[?]?\\s*:\\s*[^;]*\\[\\]`).test(shapeText)) return 'findings';
  if (/\bpass\s*:\s*boolean/.test(shapeText)) return 'pass';
  // `ok: boolean` is ACE's canonical verdict field — the one `CheckOutcome`
  // exists to make unreachable without narrowing. A report that carries it
  // is legible even without the wrapper (`VersionCheckResult`), and pinning
  // it as bespoke debt would be a false entry in a ledger whose whole value
  // is that its entries are real.
  if (/\bok\s*:\s*boolean/.test(shapeText)) return 'outcome';
  return 'bespoke';
}

/** Exported check surfaces declared in one module. */
export function surfacesIn(file: string, source: string, extra: readonly string[] = []): CheckSurface[] {
  const masked = maskLiterals(source);
  const out: CheckSurface[] = [];
  for (const m of masked.matchAll(/^export (?:async )?function ([A-Za-z0-9_]+)/gm)) {
    const fn = m[1];
    if (!SURFACE_NAME.test(fn) && !extra.includes(fn)) continue;
    out.push({ file, fn, ...verdictShapeOf(source, fn) });
  }
  return out;
}

/** Classify each surface against the corpus of test blocks. */
export function classifyCoverage(
  surfaces: readonly CheckSurface[],
  blocks: readonly TestBlock[],
  sources: ReadonlyMap<string, string>,
): CoverageRow[] {
  const maskedContext = new Map<TestBlock, string>();
  for (const b of blocks) maskedContext.set(b, maskLiterals(b.callContext));
  const byFile = new Map<string, TestBlock[]>();
  for (const b of blocks) {
    const list = byFile.get(b.file) ?? [];
    list.push(b);
    byFile.set(b.file, list);
  }

  return surfaces.map((surface) => {
    const exercised: TestBlock[] = [];
    for (const [file, src] of sources) {
      const fileBlocks = byFile.get(file);
      if (!fileBlocks?.length) continue;
      if (!src.includes(surface.fn)) continue;
      const names = [surface.fn, ...indirectCallers(src, surface.fn)];
      const call = new RegExp(`\\b(?:${names.join('|')})\\s*[(<]`);
      for (const b of fileBlocks) if (call.test(maskedContext.get(b) ?? '')) exercised.push(b);
    }
    const neg = negativeSignal(surface.shape);
    const pos = positiveSignal(surface.shape);
    return {
      surface,
      exercised,
      negative: neg ? exercised.filter((b) => neg.test(b.callContext)) : [],
      positive: pos ? exercised.filter((b) => pos.test(b.callContext)) : [],
    };
  });
}

/** `lib/dataset-constraints.ts::auditDataset` — the ledger's key format. */
export function surfaceKey(s: { file: string; fn: string }): string {
  return `${s.file}::${s.fn}`;
}
