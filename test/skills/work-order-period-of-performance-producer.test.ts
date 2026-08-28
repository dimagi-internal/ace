/**
 * The PRODUCER's guidance for `wo-period-of-performance` must describe a cell
 * value its own QA check actually accepts (dimagi-internal/ace#1781).
 *
 * `pdd-to-work-order-qa § period_of_performance_complete` accepts a whole-cell
 * single-bracket placeholder (`/^\[[^\]]+\]$/`) and rejects two bracketed spans
 * joined by "to" — an interior `]` fails the regex.
 *
 * ace#1092 fixed the READER side of this: the check's `auto_fix_hint` now names
 * the one-bracket rule explicitly, and `checks.test.ts § "auto_fix_hint is
 * actionable (#1092)"` pins hint and checker together. This file is its mirror
 * image on the WRITER side. Before it, `skills/pdd-to-work-order/SKILL.md` said
 * only "Start + end dates" (two things) and stated a general bracket convention
 * that brackets the unknown FIELD — compose those and you get
 * `[Start date on contract execution] to [Start + 10 weeks]`, the natural
 * reading of both instructions and a guaranteed failure. Observed on
 * hh-poverty-targeting/20260828-0702 Phase 1 step 2.4 attempt 1; attempt 2
 * passed 9/9, so the cost is one wasted producer/QA cycle per run — and a work
 * order drafted before a partner is selected (the normal Phase 1 case, since
 * rate/geography/languages come from the solicitation response) can essentially
 * never carry real dates, so it fires on the common path.
 *
 * SCOPE: this asserts that every bracketed exemplar the producer doc QUOTES is
 * presented consistently with what the checker does — positives pass, and any
 * failing form appears only as an explicitly negated anti-pattern. It runs the
 * REAL checker, so doc and code cannot drift apart silently.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { checkPeriodOfPerformanceComplete } from '../../skills/pdd-to-work-order-qa/checks';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..');

const PRODUCER = readFileSync(join(REPO, 'skills/pdd-to-work-order/SKILL.md'), 'utf8');

/** The two places the producer doc talks about this field: the § Process step 3
 *  table row, and the step 3(c) bracket-convention carve-out that follows it. */
const POP_ROW = PRODUCER.split('\n').find((l) => l.includes('`wo-period-of-performance` |'));

/** Render a candidate value into a minimal header table the checker can parse. */
const asCell = (value: string) => `| Period of Performance | ${value} |`;

describe('pdd-to-work-order producer guidance for wo-period-of-performance (#1781)', () => {
  test('the § Process step 3 table row exists and is not just "Start + end dates"', () => {
    expect(POP_ROW).toBeTruthy();
    // The pre-#1781 row was exactly `| \`wo-period-of-performance\` | Start + end dates | ... |`.
    // Anything that terse cannot state the whole-cell constraint.
    expect(POP_ROW!.length).toBeGreaterThan(120);
  });

  test('the row names the whole-cell single-bracket constraint', () => {
    expect(POP_ROW!).toMatch(/single bracketed placeholder|one cell value|whole cell/i);
  });

  test('the producer doc warns against the two-bracket compositional form', () => {
    expect(PRODUCER).toMatch(/never two bracketed spans joined by "to"|does not COMPOSE/i);
  });

  test('every bracketed exemplar the producer quotes is consistent with the checker', () => {
    // Backticked bracket spans anywhere in the producer doc, e.g. `[Partner Name]`
    // or `[Start and end dates set on contract execution]`, plus the quoted
    // anti-pattern. Each one is run through the REAL check.
    const exemplars = [...PRODUCER.matchAll(/`(\[[^`\n]+\])`/g)].map((m) => ({
      text: m[1],
      index: m.index ?? 0,
    }));
    expect(exemplars.length).toBeGreaterThan(0);

    const accepted: string[] = [];
    for (const ex of exemplars) {
      const passes = checkPeriodOfPerformanceComplete(asCell(ex.text)).pass;
      if (passes) {
        accepted.push(ex.text);
        continue;
      }
      // A form the checker REJECTS may appear in the doc only as an explicitly
      // negated anti-pattern — never as the thing to write.
      const preceding = PRODUCER.slice(Math.max(0, ex.index - 120), ex.index);
      expect(
        /never|not\b|NOT\b/.test(preceding),
        `producer doc quotes \`${ex.text}\` without negating it, but ` +
          `period_of_performance_complete rejects that form`,
      ).toBe(true);
    }

    // And it must actually offer a working form, not only warn about broken ones.
    expect(accepted.length).toBeGreaterThan(0);
  });

  test('the exemplar the doc recommends for an unknown period passes the real check', () => {
    const recommended = '[Start and end dates set on contract execution]';
    expect(PRODUCER).toContain(recommended);
    expect(checkPeriodOfPerformanceComplete(asCell(recommended)).pass).toBe(true);
  });

  test('the anti-pattern the doc quotes really is rejected (the warning is not stale)', () => {
    const antiPattern = '[Start date on contract execution] to [Start + 10 weeks]';
    expect(PRODUCER).toContain(antiPattern);
    expect(checkPeriodOfPerformanceComplete(asCell(antiPattern)).pass).toBe(false);
  });
});
