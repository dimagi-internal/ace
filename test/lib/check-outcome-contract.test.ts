/**
 * Source rail: the two-boolean check shape must not come back.
 *
 * ## What this guards
 *
 * ACE's most expensive defect class this run was **a check that reports
 * success without having checked anything**. Its mechanical signature is a
 * helper returning `{ checked: boolean; ok: boolean; findings }` where the
 * not-run path sets `ok: true`:
 *
 * ```ts
 * // lib/scoring-arithmetic.ts:112, before PR #1677
 * return { checked: false, ok: true, itemScores: [], findings: [] };
 * ```
 *
 * A caller reading `.ok` cannot distinguish "verified fine" from "didn't
 * look." Live cost: on `bednet-check-2-visit/20260825-1310`,
 * `checkScoringArithmetic` returned `checked: false` for BOTH Learn scoring
 * forms including the gating assessment, so the scoring gate covered nothing
 * while reporting fine (ace#1634 — the fourth instance of the same
 * regex-blindness class: #1332 → #1538 → #1576 → #1634).
 *
 * `lib/check-outcome.ts` makes the conflation unrepresentable in TYPES. This
 * test makes it unrepresentable in SOURCE, so a future helper cannot
 * hand-roll the old shape and quietly recreate the class.
 *
 * ## Why a source scan rather than a type test
 *
 * The type only binds code that imports `CheckOutcome`. A brand-new helper
 * declaring its own `interface FooReport { checked: boolean; ok: boolean }`
 * type-checks perfectly — that is exactly how four of these shipped. The
 * scan is deliberately at the level the defect actually recurs at.
 *
 * ## Scope
 *
 * Only helpers with a "did I actually run" concept are in scope. 21 files
 * under `lib/` declare `ok: boolean`; the great majority (`phase-closeout`,
 * `version-uniqueness`, `dataset-constraints`, …) report on an input they
 * always inspect and have no not-run path, so they are none of this test's
 * business and are deliberately not churned.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const LIB = join(__dirname, '..', '..', 'lib');

/**
 * Helpers that genuinely cannot move onto `CheckOutcome`, with the reason.
 *
 * EMPTY, and it should stay that way. This is debt to pay down, never a
 * parking space: an entry here is a helper that can still report a blind
 * check as a pass. If you are about to add one, the bar is that migrating is
 * impossible, not that it is inconvenient — and the comment must say which.
 */
const ALLOWLIST: Record<string, string> = {};

/** Field names that mean "did this check actually run". */
const RAN_FIELD =
  /^\s*(checked|ran|applied|applicable|evaluated|performed|inspected|examined|attempted|has_?run)\??\s*:\s*boolean\s*;?\s*$/;

function libSources(): { file: string; text: string }[] {
  return readdirSync(LIB)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((file) => ({ file, text: readFileSync(join(LIB, file), 'utf8') }));
}

/**
 * Strip line and block comments so the prose ABOUT this defect — which every
 * migrated helper now carries, quoting the old literal verbatim — does not
 * trip the scanner that the prose exists to explain.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Split into `{...}` object-literal / type-body candidates, brace-balanced. */
function braceBlocks(src: string): { start: number; body: string }[] {
  const out: { start: number; body: string }[] = [];
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== '{') continue;
    let depth = 0;
    for (let j = i; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') {
        depth--;
        if (depth === 0) {
          out.push({ start: i, body: src.slice(i, j + 1) });
          break;
        }
      }
    }
  }
  return out;
}

function lineOf(src: string, index: number): number {
  return src.slice(0, index).split('\n').length;
}

/**
 * `braceBlocks` visits every enclosing block, so one offending literal also
 * matches the `if` and the function around it. Report only the innermost
 * matching block, so the failure names the line to fix rather than three.
 */
function innermost<T extends { start: number; body: string }>(matches: T[]): T[] {
  const end = (m: T) => m.start + m.body.length;
  return matches.filter(
    (m) => !matches.some((o) => o !== m && o.start >= m.start && end(o) <= end(m) && o.body.length < m.body.length),
  );
}

describe('CheckOutcome source rail (ace#1634)', () => {
  it('no lib helper returns ok:true on a checked:false path', () => {
    const offenders: string[] = [];
    for (const { file, text } of libSources()) {
      if (ALLOWLIST[file]) continue;
      const src = stripComments(text);
      const hits = braceBlocks(src).filter(
        ({ body }) =>
          /\bchecked\s*:\s*false\b/.test(body) &&
          // `ok: true`, and also `ok: !anythingAtAll` / `ok: <expr>` — any
          // truthy-capable `ok` alongside `checked: false` is the conflation.
          /\bok\s*:\s*(true|![^,\n}]+|[^,\n}]+)/.test(body),
      );
      for (const { start, body } of innermost(hits)) {
        const okAssign = /\bok\s*:\s*(true|![^,\n}]+|[^,\n}]+)/.exec(body)!;
        offenders.push(
          `${file}:${lineOf(src, start)} — a literal sets \`checked: false\` and \`ok: ${okAssign[1].trim()}\`. ` +
            'A check that did not run has no `ok`. Return `unable(reason)` from lib/check-outcome.ts.',
        );
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('no lib helper declares both a did-I-run boolean and an ok boolean', () => {
    const offenders: string[] = [];
    for (const { file, text } of libSources()) {
      if (ALLOWLIST[file]) continue;
      const src = stripComments(text);
      const hits = braceBlocks(src).filter(({ body }) => {
        const lines = body.split('\n');
        return (
          lines.some((l) => RAN_FIELD.test(l)) &&
          lines.some((l) => /^\s*ok\??\s*:\s*boolean\s*;?\s*$/.test(l))
        );
      });
      for (const { start, body } of innermost(hits)) {
        const ran = body.split('\n').find((l) => RAN_FIELD.test(l))!;
        offenders.push(
          `${file}:${lineOf(src, start)} — declares \`${ran.trim()}\` alongside \`ok: boolean\`. ` +
            'Two booleans let a caller read `.ok` without ever narrowing on whether the check ran. ' +
            'Use `CheckOutcome<F, Extra>` from lib/check-outcome.ts instead.',
        );
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('the allowlist is empty — an entry means a helper can still report blind as green', () => {
    // Not a style rule. Every name here is a live instance of the class this
    // rail exists to prevent; the list is a ledger, and it should read empty.
    expect(Object.keys(ALLOWLIST)).toEqual([]);
  });

  it('the scanner is non-vacuous: it catches the exact literal that shipped', () => {
    // The pre-fix line from lib/scoring-arithmetic.ts:112. If a future
    // refactor of the scanner stops matching this, the rail is decorative and
    // the suite must say so — a test that passes on both the broken and the
    // fixed tree is worth nothing.
    const shipped = `
      export function checkScoringArithmetic(xml: string): ScoringReport {
        if (items.length === 0) {
          return { checked: false, ok: true, itemScores: [], findings: [] };
        }
      }
    `;
    const src = stripComments(shipped);
    const hit = braceBlocks(src).some(
      ({ body }) => /\bchecked\s*:\s*false\b/.test(body) && /\bok\s*:\s*true\b/.test(body),
    );
    expect(hit, 'the scanner no longer matches the literal it was written for').toBe(true);
  });

  it('the declaration scanner is non-vacuous: it catches the exact interface that shipped', () => {
    const shipped = `
      export interface ScoringReport {
        checked: boolean;
        ok: boolean;
        itemScores: string[];
        findings: ScoringFinding[];
      }
    `;
    const src = stripComments(shipped);
    const hit = braceBlocks(src).some(({ body }) => {
      const lines = body.split('\n');
      return (
        lines.some((l) => RAN_FIELD.test(l)) &&
        lines.some((l) => /^\s*ok\??\s*:\s*boolean\s*;?\s*$/.test(l))
      );
    });
    expect(hit, 'the scanner no longer matches the interface it was written for').toBe(true);
  });

  it('comment stripping does not blind the scanner to real code', () => {
    // The migrated helpers all QUOTE the old literal in their doc comments.
    // Stripping must remove the prose and keep the code — verify both halves,
    // or the first test above passes because it sees nothing at all.
    const mixed = `
      /** return { checked: false, ok: true }; <- prose, must be ignored */
      const a = 1; // { checked: false, ok: true } also prose
      const real = { checked: false, ok: true };
    `;
    const src = stripComments(mixed);
    expect(src).not.toContain('prose, must be ignored');
    expect(src).toContain('const real');
    const hits = braceBlocks(src).filter(
      ({ body }) => /\bchecked\s*:\s*false\b/.test(body) && /\bok\s*:\s*true\b/.test(body),
    );
    expect(hits.length).toBe(1);
  });
});
