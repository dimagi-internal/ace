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

  //
  // Merge queues. `main` has none yet; one is about to be enabled to close
  // ace#1776/#1914. The behavioural cases live in `land-pr-refspec.test.ts`,
  // which models a queued PR in its `gh` stub. These pin the SHAPE those cases
  // depend on — the same reason the arm-site ratchets above exist.
  //
  describe('merge queue', () => {
    it('DETECTS the queue rather than assuming there is none', () => {
      // `mergeQueueEntry` is null when no queue exists, so one read answers for
      // both worlds and no flag day is needed. It has to be GraphQL:
      // `gh pr view --json` exposes neither field (gh 2.88.1).
      expect(CODE).toMatch(/isInMergeQueue/);
      expect(CODE).toMatch(/mergeQueueEntry/);
      expect(CODE).toMatch(/gh api graphql/);
    });

    it('decides queued-ness BEFORE it reaches the DIRTY rebase branch', () => {
      // The whole hazard in one assertion. On a queued PR gh's
      // `--disable-auto` is a no-op that exits 0 (`inMergeQueue()` runs before
      // the disable branch, cli/cli v2.88.1 merge.go:543-553, mapped to
      // `return nil` at merge.go:167), so a script that disarms and then
      // force-pushes rewrites a head whose merge group is already under test.
      // The queued branch must therefore short-circuit ahead of DIRTY.
      const queued = CODE.indexOf('"$queued" = "true"');
      const dirty = CODE.indexOf('"$m" = "DIRTY"');
      expect(queued).toBeGreaterThan(-1);
      expect(dirty).toBeGreaterThan(-1);
      expect(queued).toBeLessThan(dirty);
    });

    it('does not spend an attempt on time the QUEUE is spending', () => {
      // The attempt budget bounds how many times WE rebase against a moving
      // `main`. A PR in the queue is the queue doing that work, so waiting on
      // it must not burn the budget — otherwise a PR three deep exhausts MAX
      // and reports a stall while it is plainly progressing. The `continue`
      // has to come before the increment.
      const cont = CODE.indexOf('continue');
      const bump = CODE.indexOf('attempt=$((attempt + 1))');
      expect(cont).toBeGreaterThan(-1);
      expect(bump).toBeGreaterThan(-1);
      expect(cont).toBeLessThan(bump);
      // ...and it must still be bounded, or a permanently queued PR spins.
      expect(CODE).toMatch(/queue_deadline/);
    });

    it('separates "still queued" from "gave up" with its own exit code', () => {
      // CLAUDE.md calls "PR queued but actually stuck" the #1 bad handoff. A PR
      // moving through a queue is the opposite case and must not share exit 3
      // with it.
      expect(CODE).toMatch(/exit 5/);
      expect(SCRIPT).toMatch(/PROGRESS, NOT A STALL/);
    });

    it('names the queue in the give-up line, not just auto-merge', () => {
      // "OPEN BLOCKED auto-merge=true" reads as stuck. The same line with
      // "queue=true queued=false" says the PR never reached the queue at all —
      // a different problem with a different fix.
      expect(CODE).toMatch(/gave up after[\s\S]*queue=/);
    });

    it('keeps `--auto --merge` intact — the strategy flag is not the problem', () => {
      // Under a queue gh only WARNS "The merge strategy for <branch> is set by
      // the merge queue" and sets payload.auto anyway (merge.go:298-304).
      // Making the flag conditional would be worse: without a queue, `--auto`
      // with no strategy is a HARD non-interactive failure (merge.go:310-312),
      // so a false-positive detection would leave the PR never armed. This
      // ratchet exists because "drop --merge under a queue" is the obvious
      // wrong fix.
      expect(CODE).toMatch(/--auto --merge/);
    });
  });

  //
  // ace#2175. The behavioural cases live in `land-pr-refspec.test.ts` (both
  // directions, driven against a stubbed `gh` + classifier) and the decision
  // rule in `test/lib/land-pr-classify.test.ts`. These pin the SHAPE those
  // depend on — the shape a well-meaning simplification silently breaks.
  //
  describe('BLOCKED version collision', () => {
    it('recovers on more than DIRTY — BLOCKED is a second, separate trigger', () => {
      // The bug in one assertion: DIRTY was the ONLY way into the recovery, and
      // the common version collision never produces it (identical VERSION files
      // merge cleanly, so it lands as a failed required check => BLOCKED).
      expect(CODE).toMatch(/"\$m" = "BLOCKED"/);
      expect(CODE).toMatch(/classify_blocked/);
    });

    it('requires a VERDICT before rebasing — never `BLOCKED` on its own', () => {
      // The reason the issue's one-line fix (`DIRTY || BLOCKED`) is wrong.
      // BLOCKED also covers a red unit test, a pending check and a missing
      // review; force-pushing any of those is worse than the hang. The rebase
      // must be gated on the classifier answering `recover`.
      expect(CODE).toMatch(/cls_action" = "recover"/);
      // ...and the DIRTY branch must not have been widened in place.
      expect(CODE).not.toMatch(/"\$m" = "DIRTY" \] \|\| \[ "\$m" = "BLOCKED"/);
    });

    it('derives the verdict from the version authority, not from CI log prose', () => {
      // `land-pr-classify.ts` calls the same `lib/version-uniqueness.ts`
      // functions `check-version-unique` runs. A regex over another job's log
      // output would drift the moment that message is reworded — and would be
      // matchable by nothing else, which is exactly the property that makes the
      // trigger safe.
      expect(CODE).toMatch(/land-pr-classify\.ts/);
    });

    it('defaults to WAIT when the classifier cannot answer', () => {
      // A degraded read is the ONLY route to a wrong recovery, so it has to
      // fall on the side of leaving the PR alone.
      expect(CODE).toMatch(/cls_action="wait"/);
      expect(CODE).toMatch(/classifier-unavailable/);
    });

    it('bounds the recovery and is loud at the bound', () => {
      expect(CODE).toMatch(/REBASE_MAX/);
      expect(SCRIPT).toMatch(/REBASE CAP REACHED/);
    });

    it('narrates each poll — a silent wait is indistinguishable from a hang', () => {
      // Ten minutes of no output is what made ace#2175 read as a hang rather
      // than a wait, and is why it was killed instead of left to work.
      expect(CODE).toMatch(/poll \$poll\/\$POLLS_PER_ATTEMPT/);
      // The give-up line must name the cause, not just the merge state.
      expect(CODE).toMatch(/cause=\$last_cause/);
    });
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
