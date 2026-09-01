/**
 * Every DATE field must carry bounds on BOTH sides (dimagi-internal/ace#1788).
 *
 * `_app-component-library.md § data-quality-constraints` enumerated what a
 * deployable capture instrument must constrain — counts, cross-field counts,
 * phone format, free-text length, credit-bearing fields — and dates were not on
 * the list. Neither was any date guidance elsewhere in the component: the only
 * grep hit for /date/ in the whole section was the substring inside "validate".
 * So a PDD that specifies one side of a date is built with one side, and nothing
 * flags the open end.
 *
 * That is not cosmetic, because an unbounded date is worse than an unbounded
 * count: a bad count yields obviously-bad data, while a bad date yields a
 * downstream check that reports GREEN. Live on
 * `bednet-check-2-visit/20260828-0629` (Deliver app
 * fd1eb8db-89c1-4626-accc-3a0123d7f522): `bednet_given_date` shipped with
 * `. <= today()` and no lower bound, exactly as the PDD specified, and
 * `data_quality_validation` scored it 8.5. That programme's rule R7 requires >= 3
 * days between registration and follow-up, computed off this very field. A
 * registration typed 2025-08-14 instead of 2026-08-14 passes the field constraint
 * AND satisfies the gap check with ~365 days to spare.
 *
 * This test pins both halves of the fix: the build-side rule in the component,
 * and the eval-side SCORING ANCHOR (a paragraph the rubric cannot act on is not
 * a deduction). The specimen's arithmetic is asserted directly so the anchor
 * cannot rot into a claim the numbers do not support.
 *
 * SCOPE: offline and deterministic. Both edits are prose an LLM executes; there
 * is no runtime helper to test, so the specimen arithmetic is the closest thing
 * to an executable statement of why the rule exists.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const COMPONENT = path.join(REPO_ROOT, 'skills/_app-component-library.md');
const EVAL = path.join(REPO_ROOT, 'skills/pdd-to-deliver-app-eval/SKILL.md');

/**
 * The section with blockquote markers and hard line wraps flattened, so an
 * assertion on a phrase does not depend on where the markdown happens to wrap.
 */
function componentSection(): string {
  const text = fs.readFileSync(COMPONENT, 'utf8');
  const start = text.indexOf('### data-quality-constraints');
  const end = text.indexOf('### case-write-back', start);
  expect(start, 'data-quality-constraints section not found').toBeGreaterThan(-1);
  expect(end, 'case-write-back section not found').toBeGreaterThan(start);
  return text
    .slice(start, end)
    .split('\n')
    .map((l) => l.replace(/^\s*>\s?/, ''))
    .join(' ')
    .replace(/\s+/g, ' ');
}

function evalDimensionRow(): string {
  const text = fs.readFileSync(EVAL, 'utf8');
  const row = text.split('\n').find((l) => l.includes('| **Data-quality validation** |'));
  expect(row, 'Data-quality validation rubric row not found').toBeTruthy();
  return row as string;
}

describe('the bednet_given_date specimen (why the rule exists)', () => {
  const DAY = 86_400_000;
  const day = (iso: string) => new Date(`${iso}T00:00:00Z`).getTime();

  /** The live specimen: a year typo on a manually-entered registration date. */
  const typed = '2025-08-14';
  const intended = '2026-08-14';
  const followUp = '2026-08-16'; // two days after the intended registration
  const today = '2026-08-28'; // the run's own window
  const R7_MIN_GAP_DAYS = 3;

  it('the typo satisfies `. <= today()` — it is emphatically in the past', () => {
    expect(day(typed)).toBeLessThanOrEqual(day(today));
  });

  it('WITHOUT the typo, R7 correctly REJECTS the follow-up (2-day gap)', () => {
    const gap = (day(followUp) - day(intended)) / DAY;
    expect(gap).toBe(2);
    expect(gap >= R7_MIN_GAP_DAYS).toBe(false);
  });

  it('WITH the typo, R7 silently PASSES — the gap computes as ~365 days', () => {
    const gap = (day(followUp) - day(typed)) / DAY;
    expect(gap).toBe(367);
    expect(gap >= R7_MIN_GAP_DAYS).toBe(true);
  });

  it('a plausible lower bound from the programme window would have caught it', () => {
    // Any floor inside the programme's own window rejects a date a year early.
    const floor = '2026-06-01';
    expect(day(typed) >= day(floor)).toBe(false);
    expect(day(intended) >= day(floor)).toBe(true);
  });
});

describe('_app-component-library § data-quality-constraints covers DATE fields', () => {
  const section = componentSection();

  it('requires bounds on BOTH sides of every date field', () => {
    expect(/every DATE field MUST carry bounds on BOTH sides/i.test(section)).toBe(true);
  });

  it('names the open-side bound as programme-derived, not a fixed window', () => {
    expect(/programme's own window/i.test(section)).toBe(true);
    expect(
      /Do NOT hard-code a window/i.test(section),
      'the floor is programme-specific — a fixed default recreates the defect it fixes',
    ).toBe(true);
  });

  it('states the failure mode: a year typo silently satisfies a downstream rule', () => {
    expect(/year typo/i.test(section)).toBe(true);
    expect(/arithmetic/i.test(section)).toBe(true);
  });

  it('cites the live specimen rather than asserting the class abstractly', () => {
    expect(section).toContain('bednet_given_date');
    expect(section).toContain('bednet-check-2-visit/20260828-0629');
    expect(/ace#1788/.test(section)).toBe(true);
  });

  it('the Enforced-by line names the date class, so build and eval cannot drift', () => {
    const enforced = section.slice(section.indexOf('**Enforced by:**'));
    expect(/one-sided date bounds/i.test(enforced)).toBe(true);
  });
});

describe('pdd-to-deliver-app-eval § data_quality_validation has a date SCORING ANCHOR', () => {
  const row = evalDimensionRow();

  it('lists two-sided date bounds among what it grades', () => {
    expect(/two-sided bounds on every date field/i.test(row)).toBe(true);
  });

  it('adds dates to the 1.5-point missing-constraint-class list', () => {
    const deduction = row.slice(row.indexOf('1.5-point deduction') - 220);
    expect(/dates one-sided/i.test(deduction)).toBe(true);
  });

  it('escalates to 2 points where a downstream rule does arithmetic on the date', () => {
    expect(/2-point deduction/.test(row)).toBe(true);
    expect(/minimum gap between visits|age computation|eligibility window/i.test(row)).toBe(true);
  });

  it('states that a one-sided PDD spec is not a defence (this is a fitness dimension)', () => {
    expect(/not a defence|fitness dimension/i.test(row)).toBe(true);
  });

  it('carries the live anchor, including the score the defective build got', () => {
    expect(row).toContain('bednet_given_date');
    expect(row).toContain('8.5');
  });
});
