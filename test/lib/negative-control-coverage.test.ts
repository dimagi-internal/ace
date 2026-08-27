import { describe, it, expect } from 'vitest';
import {
  classifyCoverage,
  extractTestBlocks,
  indirectCallers,
  maskLiterals,
  negativeSignal,
  positiveSignal,
  surfacesIn,
  verdictShapeOf,
  type CheckSurface,
} from '../../lib/negative-control-coverage';

/**
 * The scanner behind `test/skills/negative-control-ratchet.test.ts`.
 *
 * This module is itself a check, so it is held to the rule it enforces: every
 * case below feeds it an input it must get WRONG if the logic regresses, not
 * merely an input it can process. A coverage scanner that silently
 * over-reports is the failure class one level up — it would certify a repo
 * full of unfalsifiable gates as healthy — and a scanner that under-reports
 * manufactures a ledger of debt nobody owes, which is how a ratchet gets
 * deleted rather than paid down.
 *
 * The two masking cases are REGRESSIONS, not hypotheticals: both were found
 * by running the first cut of this scanner against ACE's own tree, and each
 * silently deleted real code before it reached any matcher.
 */

describe('maskLiterals — the offsets everything else depends on', () => {
  it('blanks literal CONTENT while preserving every other offset', () => {
    const src = `const a = 'hi}(';\nconst b = 1;`;
    const masked = maskLiterals(src);
    expect(masked).toHaveLength(src.length);
    expect(masked).not.toContain('hi}(');
    expect(masked).toContain('const b = 1;');
  });

  it('REGRESSION — a regex literal containing quotes must not desync the file', () => {
    // test/lib/scoring-arithmetic.test.ts:47 verbatim in shape. Three `"`
    // inside one regex: a quote-only masker paired them across the regex
    // boundary, then opened a phantom template literal at the backtick that
    // follows and swallowed every describe/it after it. The scanner reported
    // ZERO test blocks for a 300-line suite, and `checkScoringArithmetic` —
    // thoroughly covered — read as having no test at all.
    const src = [
      `const withUserScore = (calc: string) =>`,
      `  GOOD.replace(/calculate="\\(\\/data\\/q1_score[^"]*"/, \`calculate="\${calc}"\`);`,
      ``,
      `describe('checkScoringArithmetic', () => {`,
      `  it('passes a correct quiz', () => { expect(checkScoringArithmetic(GOOD).ok).toBe(true); });`,
      `});`,
    ].join('\n');
    const masked = maskLiterals(src);
    expect(masked).toContain('describe(');
    expect(masked).toContain('checkScoringArithmetic(GOOD).ok');
    expect(extractTestBlocks('t.test.ts', src)).toHaveLength(1);
  });

  it("REGRESSION — a dangling quote cannot swallow the rest of the file", () => {
    // lib/entity-id-grain.ts:102 carries `/^'[^']*'$/.test(a)`, whose odd
    // quote count left one open. The masker then blanked thirty lines,
    // including `export type GrainReport = CheckOutcome<…>` — so the check
    // read as having no declared verdict shape and was pinned as bespoke
    // debt it does not owe. A `'` string cannot span a newline; reaching one
    // means the quote never opened a string.
    const src = [`const isQuoted = (a: string) => /^'[^']*'$/.test(a);`, `export type R = CheckOutcome<F>;`].join('\n');
    expect(maskLiterals(src)).toContain('export type R = CheckOutcome<F>;');
  });

  it('still blanks a genuine multi-line template literal', () => {
    // The mirror of the case above: backticks legally span lines, so the
    // newline rule must NOT apply to them, or every XML fixture in the test
    // suite would be scanned as code.
    const src = 'const x = `line one\n it(\'fake\', () => {})\n`;\nconst y = 2;';
    const masked = maskLiterals(src);
    expect(masked).not.toContain("it('fake'");
    expect(masked).toContain('const y = 2;');
  });
});

describe('extractTestBlocks — attribution', () => {
  it('is not fooled by a brace or paren inside a title', () => {
    const src = `it('handles ) and } and (#1693)', () => { expect(1).toBe(1); });\nit('next', () => {});`;
    expect(extractTestBlocks('t.test.ts', src).map((b) => b.title)).toEqual([
      'handles ) and } and (#1693)',
      'next',
    ]);
  });

  it('carries the enclosing describe PROLOGUE, so a hoisted call still counts', () => {
    const src = [
      `describe('grain', () => {`,
      `  const r = checkThing(BAD);`,
      `  it('fails', () => expect(r.pass).toBe(false));`,
      `});`,
    ].join('\n');
    const [block] = extractTestBlocks('t.test.ts', src);
    expect(block.callContext).toContain('checkThing(BAD)');
  });

  it('EXCLUDES sibling it-bodies from the prologue', () => {
    // The over-reporting guard. If a describe's prologue included its
    // siblings, one negative control in a multi-check file would mark every
    // check in that file covered — laundered confidence, one level up.
    const src = [
      `describe('two', () => {`,
      `  it('a', () => { expect(checkA(BAD).pass).toBe(false); });`,
      `  it('b', () => { expect(checkB(X).detail).toBeTruthy(); });`,
      `});`,
    ].join('\n');
    const blocks = extractTestBlocks('t.test.ts', src);
    const b = blocks.find((x) => x.title === 'b')!;
    expect(b.callContext).not.toContain('checkA');
  });
});

describe('indirectCallers — one level of helper', () => {
  it('finds an arrow helper that wraps the check', () => {
    const src = `const check = (u: string, g: string) => checkPaymentUnit(pdd(u, g));`;
    expect(indirectCallers(src, 'checkPaymentUnit')).toEqual(['check']);
  });

  it('finds a function-declaration helper', () => {
    const src = `function probe(a: string) {\n  return checkThing(a);\n}`;
    expect(indirectCallers(src, 'checkThing')).toEqual(['probe']);
  });

  it('does NOT claim a helper that never calls the check', () => {
    const src = `const other = (a: string) => somethingElse(a);`;
    expect(indirectCallers(src, 'checkThing')).toEqual([]);
  });
});

describe('verdictShapeOf — which verdict vocabulary a check speaks', () => {
  const shape = (src: string, fn: string) => verdictShapeOf(src, fn).shape;

  it('reads QACheckResult as the `pass` shape', () => {
    expect(shape(`export function checkA(x: string): QACheckResult {\n  return x;\n}`, 'checkA')).toBe('pass');
  });

  it('follows a local type ALIAS to CheckOutcome', () => {
    // Four lib checks declare themselves this way
    // (`export type ScoringReport = CheckOutcome<ScoringFinding, …>`).
    // Reading only the literal text called all four bespoke and would have
    // pinned well-covered checks as debt.
    const src = [
      `export type ScoringReport = CheckOutcome<ScoringFinding, { itemScores: string[] }>;`,
      `export function checkS(x: string): ScoringReport {`,
      `  return x;`,
      `}`,
    ].join('\n');
    expect(shape(src, 'checkS')).toBe('outcome');
  });

  it('reads a bare `Finding[]` return as the findings shape', () => {
    expect(shape(`export function auditA(x: unknown): Finding[] {\n  return [];\n}`, 'auditA')).toBe('findings');
  });

  it('reads an INLINE object return type rather than calling it unannotated', () => {
    // What a hand-rolled new check tends to write. The naive "everything up
    // to the first `{`" rule read this as unannotated, so a legible `pass`
    // verdict landed in tier 2 and the author was told to adopt a uniform
    // shape they already had.
    const src = `export function checkT(x: { bad: boolean }): { pass: boolean; detail: string } {\n  return x;\n}`;
    expect(verdictShapeOf(src, 'checkT')).toEqual({ shape: 'pass', returnType: '{ pass: boolean; detail: string }' });
  });

  it('NEGATIVE — refuses to guess at a vocabulary it does not know', () => {
    // `{ stale: true }` is a FAILURE and `{ satisfiable: true }` is a pass.
    // Guessing would read a check's own passing case as a negative control,
    // which is exactly the laundering this rail exists to stop. Bespoke is
    // the honest answer, and tier 2 pins it instead.
    const src = [
      `export interface FreshnessReport { fresh: boolean; stale: StaleVerdict[]; }`,
      `export function checkGoldenFreshness(x: unknown): FreshnessReport {`,
      `  return x;`,
      `}`,
    ].join('\n');
    expect(shape(src, 'checkGoldenFreshness')).toBe('bespoke');
    expect(negativeSignal('bespoke')).toBeNull();
    expect(positiveSignal('bespoke')).toBeNull();
  });

  it('NEGATIVE — an unannotated return type is bespoke, not assumed fine', () => {
    expect(shape(`export function checkU(x: string) {\n  return { pass: true };\n}`, 'checkU')).toBe('bespoke');
  });
});

describe('surfacesIn — enumeration', () => {
  it('takes check* and audit*, and the opt-in extras, and nothing else', () => {
    const src = [
      `export function checkA(): QACheckResult { return x; }`,
      `export function auditB(): Finding[] { return []; }`,
      `export function classifyUtilities(): Finding[] { return []; }`,
      `export function formatReport(): string { return ''; }`,
      `export function renderThing(): string { return ''; }`,
    ].join('\n');
    expect(surfacesIn('lib/x.ts', src, ['classifyUtilities']).map((s) => s.fn)).toEqual([
      'checkA',
      'auditB',
      'classifyUtilities',
    ]);
  });

  it('NEGATIVE — a formatter is not a check surface, however check-adjacent', () => {
    const src = `export function formatConstraintReport(r: ConstraintReport): string { return ''; }`;
    expect(surfacesIn('lib/x.ts', src)).toEqual([]);
  });
});

describe('classifyCoverage — the verdict the ratchet reads', () => {
  const surface = (fn: string, shape: CheckSurface['shape'] = 'pass'): CheckSurface => ({
    file: 'lib/x.ts',
    fn,
    shape,
    returnType: 'QACheckResult',
  });

  const run = (src: string, s: CheckSurface) =>
    classifyCoverage([s], extractTestBlocks('t.test.ts', src), new Map([['t.test.ts', src]]))[0];

  it('separates a failure assertion from a clean one', () => {
    const src = [
      `it('rejects the bad input', () => { expect(checkA(BAD).pass).toBe(false); });`,
      `it('accepts the good one', () => { expect(checkA(OK).pass).toBe(true); });`,
    ].join('\n');
    const row = run(src, surface('checkA'));
    expect(row.negative.map((b) => b.title)).toEqual(['rejects the bad input']);
    expect(row.positive.map((b) => b.title)).toEqual(['accepts the good one']);
  });

  it('NEGATIVE — a test that merely RUNS the check counts as neither', () => {
    // The distinction the whole convention rests on. ace#1701's check 7 was
    // "exercised" on every run and could not report a defect on any of them.
    const src = `it('runs', () => { expect(checkA(X).detail).toBeTruthy(); });`;
    const row = run(src, surface('checkA'));
    expect(row.exercised).toHaveLength(1);
    expect(row.negative).toHaveLength(0);
    expect(row.positive).toHaveLength(0);
  });

  it('NEGATIVE — an assertion in a block that never calls the check is not attributed', () => {
    const src = `it('unrelated', () => { expect(other().pass).toBe(false); });`;
    expect(run(src, surface('checkA')).negative).toHaveLength(0);
  });

  it('reads a findings-shaped audit asserted INLINE, in both directions', () => {
    // `expect(auditDocFidelity([doc('…')])).toEqual([])` — no variable named
    // `findings` anywhere. Missing this form called an audit with two
    // explicit "does NOT fire" cases uncovered.
    const src = [
      `it('flags', () => { expect(auditA(BAD)).toEqual(['DOC-LITERAL-MARKDOWN']); });`,
      `it('clean', () => { expect(auditA(OK)).toEqual([]); });`,
    ].join('\n');
    const row = run(src, surface('auditA', 'findings'));
    expect(row.negative.map((b) => b.title)).toEqual(['flags']);
    expect(row.positive.map((b) => b.title)).toEqual(['clean']);
  });

  it('reads prettier-wrapped `.ok,\\n).toBe(true)` as a positive control', () => {
    // Verbatim shape from test/lib/decision-vocabularies.test.ts. The
    // tight `\\.ok\\s*\\)` form missed it and reported phantom debt.
    const src = [
      `it('accepts a subset', () => {`,
      `  expect(`,
      `    checkV({ id: 'archetype-selection' }).ok,`,
      `  ).toBe(true);`,
      `});`,
    ].join('\n');
    expect(run(src, surface('checkV', 'outcome')).positive).toHaveLength(1);
  });
});
