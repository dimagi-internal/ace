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

  // "OPEN CLEAN" is unactionable; "OPEN CLEAN auto-merge=false" names the cause
  // outright — which is how ace#2004 was diagnosed in the first place.
  it('names auto-merge state when it gives up, so the cause is actionable', () => {
    expect(CODE).toMatch(/gave up after[\s\S]*autoMergeRequest/);
  });

  //
  // ace#2004. The behavioural cases live in `land-pr-refspec.test.ts`, which
  // drives the real script against a stubbed `gh`. These three pin the SHAPE
  // those cases depend on, because the shape is what a well-meaning edit
  // silently breaks: the arm was nested inside `if [ "$m" = "DIRTY" ]` for
  // three revisions and read as deliberate every time.
  //
  it('arms auto-merge exactly once, from a single unconditional call site', () => {
    // Two call sites is how it regresses: one re-arm in the DIRTY branch, one
    // "initial" arm elsewhere, and then only one of them gets the next fix.
    const arms = CODE.match(/--auto --merge/g) ?? [];
    expect(arms).toHaveLength(1);
  });

  it('arms AFTER proving this checkout owns the PR', () => {
    // The reason the issue's one-line fix was not the fix. A bare arm hoisted
    // above the loop would arm before the wrong-worktree guard, turning a
    // refusal into a merge of someone else's PR.
    const guard = CODE.indexOf('--is-ancestor');
    const arm = CODE.indexOf('--auto --merge');
    expect(guard).toBeGreaterThan(-1);
    expect(arm).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(arm);
  });

  it('guards ancestry unconditionally, not only on the DIRTY path', () => {
    // The guard must sit OUTSIDE the `if [ "$m" = "DIRTY" ]` block. While it
    // was inside, a CLEAN PR was never checked for ownership at all.
    const guard = CODE.indexOf('--is-ancestor');
    const dirty = CODE.indexOf('"$m" = "DIRTY"');
    expect(dirty).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(dirty);
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
