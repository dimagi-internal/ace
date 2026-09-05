import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

//
// A ratchet on the one step that was actually forgotten.
//
// `skills/shipping` carried the disarm-before-rebase rule and assumed one
// rebase wins the race. The first hand-rolled retry loop (2026-09-05) retried
// correctly and FORGOT to disarm — and landed anyway, purely because CI had not
// yet gone green on the pre-rebase head. That is luck, and luck is exactly what
// a test should replace: without the disarm, a merge already in flight discards
// the rebase and the PR lands carrying the OLD version, which the
// version-keyed plugin cache then makes unreachable by `/ace:update`.
//
const SCRIPT = readFileSync(resolve(__dirname, '../../scripts/land-pr.sh'), 'utf8');

/**
 * The executable half only. The header comment quotes the recipe verbatim
 * (`--rebase-first`, `--disable-auto`), so an ordering assertion over the whole
 * file compares prose against code — which is how the first version of the
 * ordering test below failed for the wrong reason.
 */
const CODE = SCRIPT.split('\n')
  .filter((l) => !l.trimStart().startsWith('#'))
  .join('\n');

describe('scripts/land-pr.sh', () => {
  it('disarms auto-merge before rebasing', () => {
    expect(CODE).toMatch(/--disable-auto/);
  });

  it('disarms BEFORE it rebases, not after', () => {
    const disarm = CODE.indexOf('--disable-auto');
    const rebase = CODE.indexOf('--rebase-first');
    expect(disarm).toBeGreaterThan(-1);
    expect(rebase).toBeGreaterThan(-1);
    expect(disarm).toBeLessThan(rebase);
  });

  it('re-arms auto-merge only after pushing the corrected version', () => {
    const push = CODE.indexOf('force-with-lease');
    const rearm = CODE.lastIndexOf('--auto --merge');
    expect(rearm).toBeGreaterThan(push);
  });

  it('treats a non-version conflict as a human matter, not another retry', () => {
    expect(SCRIPT).toMatch(/non-version file conflicts/);
    expect(SCRIPT).toMatch(/exit 2/);
  });

  it('is bounded — it cannot spin forever against a moving main', () => {
    expect(SCRIPT).toMatch(/MAX="\$\{2:-\d+\}"/);
    expect(SCRIPT).toMatch(/gave up after/);
  });

  it('carries the measured evidence for why the retry exists', () => {
    // Prose, but load-bearing prose: the next reader must not "simplify" the
    // loop back to a single pass.
    expect(SCRIPT).toMatch(/2026-09-05/);
    expect(SCRIPT).toMatch(/every 2-4 minutes/);
  });
});
