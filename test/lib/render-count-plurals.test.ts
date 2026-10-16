import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCountPlurals, renderCountPluralReport } from '../../lib/render-count-plurals';

// Captured verbatim via `workflow_get(5482, opportunity_id=10057)` on
// 2026-10-16 — render_code v2 of the spark-facilitator/20260907-1120 ledger
// that rendered "1 were committee meetings" (ace#2248).
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/render-code/workflow-5482-v2.jsx');
const WORKFLOW_5482 = readFileSync(FIXTURE, 'utf8');

describe('checkCountPlurals (ace#2248)', () => {
  it('fails the real workflow 5482 render on both shortfall phrases', () => {
    const r = checkCountPlurals(WORKFLOW_5482);
    expect(r.pass).toBe(false);
    expect(r.findings.map((f) => f.phrase)).toEqual([
      'were committee meetings',
      'were meetings that did not happen',
    ]);
    expect(r.findings.map((f) => f.expr)).toEqual(['t.committee', 't.notHeld']);
  });

  it('stays quiet on the same file\'s grammatical concatenations', () => {
    // `totals.committee + " committee, "`, `below.length + " of "` and
    // `... + " UTC"` are all in the fixture and are all fine at 1.
    const r = checkCountPlurals(WORKFLOW_5482);
    expect(r.findings).toHaveLength(2);
  });

  it('passes once the phrase branches on the singular', () => {
    const fixed = WORKFLOW_5482.replace(
      't.committee + " were committee meetings"',
      't.committee + (t.committee === 1 ? " was a committee meeting" : " were committee meetings")',
    ).replace(
      't.notHeld + " were meetings that did not happen"',
      't.notHeld + (t.notHeld === 1 ? " was a meeting that did not happen" : " were meetings that did not happen")',
    );
    expect(checkCountPlurals(fixed).pass).toBe(true);
  });

  it('flags a plural noun only on a count-shaped expression', () => {
    const src = readFileSync(FIXTURE, 'utf8')
      .replace('below.length + " of " + table.length', 'below.length + " facilitators of " + table.length')
      .replace('"Meeting records filed"', 't.name + " shows records"');
    const r = checkCountPlurals(src);
    expect(r.pass).toBe(false);
    expect(r.findings.map((f) => f.expr)).toContain('below.length');
    expect(r.findings.map((f) => f.expr)).not.toContain('t.name');
  });

  it('names the singular fix in its report', () => {
    const out = renderCountPluralReport(checkCountPlurals(WORKFLOW_5482).findings);
    expect(out).toContain('t.committee === 1');
    expect(out).toContain('ace#2248');
  });
});
