/**
 * dimagi-internal/ace#1781 — the WRITER-side mirror of #1092.
 *
 * #1092 fixed the READER side: `period_of_performance_complete`'s `auto_fix_hint`
 * under-specified the accepted placeholder form, so a producer that followed the
 * hint burned a second auto-fix cycle. That fix shipped, and it works — the hint
 * now names the one-bracket rule and even names the anti-pattern.
 *
 * It was too narrow in one specific way: it made the checker good at EXPLAINING
 * itself AFTER a rejection, and left the producer with no way to know the
 * constraint BEFORE tripping it. `skills/pdd-to-work-order/SKILL.md` asked for
 * "Start + end dates" (two things) and stated a bracket-the-unknown-FIELD
 * convention twice. Compose those and you get
 * `[Start date on contract execution] to [Start + 10 weeks]` — the natural
 * reading of both instructions, and a deterministic failure, because
 * `checkPeriodOfPerformanceComplete` anchors its placeholder branch on the
 * WHOLE cell (`/^\[[^\]]+\]$/`) and an interior `]` breaks it. Observed on
 * hh-poverty-targeting/20260828-0702 Phase 1 step 2.4 attempt 1.
 *
 * The class, stated generally: a field whose QA checker parses the ENTIRE cell
 * value cannot take a placeholder composed out of per-field brackets. This suite
 * pins the producer's `## Whole-cell fields` table against the real checkers, so
 * a documented "accepted form" the checker rejects — or a whole-cell field the
 * producer forgets to document — fails CI.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import type { QACheckResult } from '../../lib/qa-types';
import { checkPeriodOfPerformanceComplete } from '../../skills/pdd-to-work-order-qa/checks';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PRODUCER = readFileSync(
  path.join(REPO_ROOT, 'skills', 'pdd-to-work-order', 'SKILL.md'),
  'utf8',
);

/**
 * Checker functions the producer doc is allowed to name in § Whole-cell fields.
 * A row naming anything else fails — that is the drift guard: you cannot add a
 * whole-cell field to the doc without wiring its real checker in here.
 */
const CHECKERS: Record<string, (wo: string) => QACheckResult> = {
  checkPeriodOfPerformanceComplete,
};

/** Render a value into the header-table layout the checkers parse. */
const asCell = (label: string, value: string) => `| ${label} | ${value} |\n`;

/** The header label each checker reads its cell from. */
const CELL_LABEL: Record<string, string> = {
  checkPeriodOfPerformanceComplete: 'Period of Performance',
};

function sectionBody(heading: string): string {
  const start = PRODUCER.indexOf(`## ${heading}\n`);
  expect(start, `producer SKILL.md is missing a \`## ${heading}\` section`).toBeGreaterThan(-1);
  const rest = PRODUCER.slice(start + heading.length + 4);
  const end = rest.indexOf('\n## ');
  return end === -1 ? rest : rest.slice(0, end);
}

/** Backticked spans inside a string, in order. */
const backticked = (s: string) => [...s.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

type WholeCellRow = { field: string; checker: string; acceptedForms: string[] };

function parseWholeCellTable(): WholeCellRow[] {
  const body = sectionBody('Whole-cell fields');
  const rows: WholeCellRow[] = [];
  for (const line of body.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const cols = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cols.length < 3) continue;
    if (/^-+$/.test(cols[0].replace(/[:\s]/g, '')) || cols[0] === 'Field') continue;
    const checker = backticked(cols[1]).find((b) => b.startsWith('check'));
    expect(
      checker,
      `§ Whole-cell fields row "${cols[0]}" must name its checker FUNCTION in backticks`,
    ).toBeTruthy();
    rows.push({
      field: backticked(cols[0])[0] ?? cols[0],
      checker: checker!,
      // Accepted forms are the backticked spans in the third column.
      acceptedForms: backticked(cols[2]),
    });
  }
  return rows;
}

describe('pdd-to-work-order producer agrees with pdd-to-work-order-qa (#1781)', () => {
  test('the step-3 `wo-period-of-performance` row states the one-cell constraint', () => {
    // The line the failing run actually read. Pre-fix it was exactly
    // `| \`wo-period-of-performance\` | Start + end dates | Header + Timeline section |`
    // — "Start + end dates" reads as two things, and composing two bracketed
    // placeholders out of it is a deterministic QA failure. This assertion is
    // deliberately independent of the § Whole-cell fields section below, so it
    // pins the defect itself rather than the shape of the remedy.
    const row = sectionBody('Process')
      .split('\n')
      .find((l) => l.trim().startsWith('| `wo-period-of-performance`'));
    expect(row, '§ Process has no `wo-period-of-performance` row').toBeTruthy();
    expect(
      /whole[- ]cell|single bracketed|ONE cell value/i.test(row!),
      'the `wo-period-of-performance` row must state that the value is ONE cell parsed whole — a bare "Start + end dates" is what produced #1781',
    ).toBe(true);
  });

  test('§ Whole-cell fields documents at least one field', () => {
    expect(parseWholeCellTable().length).toBeGreaterThan(0);
  });

  test('every checker the producer names is a real, wired checker', () => {
    for (const r of parseWholeCellTable()) {
      expect(
        CHECKERS[r.checker],
        `§ Whole-cell fields names \`${r.checker}\`, which is not exported/wired in this test's CHECKERS map`,
      ).toBeTruthy();
    }
  });

  test('every "accepted whole-cell form" the producer quotes actually PASSES its checker', () => {
    // The writer-side mirror of #1092's hint-exemplar assertion. A producer
    // instruction that quotes a form the checker rejects is always a bug.
    for (const r of parseWholeCellTable()) {
      const run = CHECKERS[r.checker];
      const label = CELL_LABEL[r.checker];
      expect(r.acceptedForms.length, `${r.field}: no accepted forms quoted`).toBeGreaterThan(0);
      for (const form of r.acceptedForms) {
        const res = run(asCell(label, form));
        expect(
          res.pass,
          `${r.field}: producer documents \`${form}\` as accepted, but ${r.checker} rejects it — ${res.detail}`,
        ).toBe(true);
      }
    }
  });

  test('the composed per-field bracket form is documented as rejected AND really is', () => {
    const composed = '[Start date on contract execution] to [Start + 10 weeks]';
    // The producer must name the anti-pattern, not just the accepted form —
    // the failure mode is that "start + end dates" + "bracket the unknown
    // field" compose into it silently.
    expect(
      PRODUCER,
      'producer SKILL.md must quote the two-bracket anti-pattern so the writer sees it before tripping it',
    ).toContain(composed);
    expect(checkPeriodOfPerformanceComplete(asCell('Period of Performance', composed)).pass).toBe(
      false,
    );
  });

  test('the step-3 `wo-*` row for each whole-cell field points at the constraint', () => {
    // This is the line the run actually read: `| \`wo-period-of-performance\` |
    // Start + end dates | ... |`. "Start + end dates" alone is what invited the
    // composition, so the row itself must carry the pointer.
    const process = sectionBody('Process');
    for (const r of parseWholeCellTable()) {
      const row = process
        .split('\n')
        .find((l) => l.trim().startsWith(`| \`${r.field}\``));
      expect(row, `§ Process has no \`${r.field}\` row`).toBeTruthy();
      expect(
        /whole[- ]cell/i.test(row!),
        `the \`${r.field}\` row in § Process must point at § Whole-cell fields — a bare field description is what produced #1781`,
      ).toBe(true);
    }
  });

  test('the bracket-placeholder convention states that it does not compose', () => {
    // Stated twice in the producer (step 3(c) and the step-4 paragraph); both
    // need the carve-out, because either one read alone produces the bad form.
    const lines = sectionBody('Process').split('\n');
    const idx = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => l.includes('[Partner Name]') && /bracketed placeholder/i.test(l))
      .map(({ i }) => i);
    expect(idx.length).toBeGreaterThanOrEqual(2);
    for (const i of idx) {
      // The carve-out may sit on the statement line itself or in the paragraph
      // immediately attached to it — scan the statement plus its continuation.
      const block = lines.slice(i, i + 4).join('\n');
      expect(
        /whole[- ]cell|does not compose|ONE pair of brackets/i.test(block),
        `bracket-convention statement carries no whole-cell carve-out: ${lines[i].trim().slice(0, 120)}`,
      ).toBe(true);
    }
  });
});
