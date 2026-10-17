/**
 * Phase 7 must name a non-converged DDD ending as `partial-…`, never as
 * `passed-with-deferred-evals` (ace#2995).
 *
 * The gap: `agents/synthetic-data-and-workflows.md` told Phase 7 to write
 * `verdict: passed-with-deferred-evals` whenever canopy's DDD loop ended
 * anything other than `converged_clean`. ace-web's `_verdict_caveat`
 * (apps/opps/summary.py) matches verdict substrings in a fixed order —
 * `deferred`, then `warn`, then `partial` — so the anonymous run-summary
 * page told outsiders "Built; some quality checks were deferred" when the
 * checks had run and the loop stopped short of its bar
 * (dimagi-team/noora-health/20261015-1129, ended `stopped_not_converged`).
 *
 * `caveatClass` below mirrors that matching order (read from ace-web's
 * main on 2026-10-15). If ace-web's order changes, update it here too.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DOC = readFileSync(join(process.cwd(), 'agents/synthetic-data-and-workflows.md'), 'utf8');

// Every DDD ending other than converged_clean (the doc's own enumeration).
const NON_CLEAN = ['converged_with_open_questions', 'stopped_not_converged', 'diverging'];

function caveatClass(verdict: string): 'deferred' | 'warn' | 'partial' | 'other' {
  const v = verdict.trim().toLowerCase();
  if (v.includes('deferred')) return 'deferred';
  if (v.includes('warn')) return 'warn';
  if (v.includes('partial')) return 'partial';
  return 'other';
}

function nonCleanSection(): string {
  const start = DOC.indexOf('**On a non-`converged_clean` ending, do not halt the run.**');
  expect(start, 'Phase 7 doc lost its non-converged-ending rule').toBeGreaterThan(-1);
  const end = DOC.indexOf('### ', start);
  return DOC.slice(start, end > start ? end : undefined);
}

describe('Phase 7 non-converged DDD verdict (ace#2995)', () => {
  it('the doc enumerates the terminal statuses this test covers', () => {
    for (const s of ['converged_clean', ...NON_CLEAN]) expect(DOC).toContain(s);
  });

  it('prescribes partial-ddd-<terminal_status> for a non-converged_clean ending', () => {
    const sec = nonCleanSection();
    expect(sec).toContain('verdict: partial-ddd-<terminal_status>');
    expect(sec).not.toMatch(/\(`verdict: passed-with-deferred-evals`\)/);
  });

  it('every prescribed non-clean verdict renders as partial, not deferred, on ace-web', () => {
    for (const s of NON_CLEAN) {
      expect(caveatClass(`partial-ddd-${s}`), `partial-ddd-${s}`).toBe('partial');
    }
  });

  it('the write-back template lists the partial-ddd verdict', () => {
    expect(DOC).toMatch(/verdict: <pass\|partial-ddd-found_not_fixed\|partial-ddd-<terminal_status>\|passed-with-deferred-evals>/); // found_not_fixed: ace#2337
  });
});
