import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The decide-then-show rule must reach the MID-RUN surface, not only send paths.
 *
 * ## The failure class
 *
 * ACE already carries decide-then-show in three places — `CLAUDE.md` (by
 * reference to canopy's operating-model §1b), `skills/agent-turn-review` §C/§F,
 * and `skills/inbox-triage`. Every one of them governs a **turn-closing reply or
 * an inbox reply**: they fire at SEND time.
 *
 * A mid-run status update inside `/ace:run` never reaches a send path. So the
 * rule that exists three times over did not apply to the one surface that kept
 * failing. Measured (Ada conduct cycle, 2026-09-02): ALL FOUR human corrections
 * in a 24h `canopy agent-review ace` window were `[confusion]`, and all four
 * landed on mid-run status updates —
 *
 *   "Clarify what you want my opinion on. I can't follow. This is a lot of text."
 *   "I'm lost. Be clear on exactly what questions you have, what the options
 *    are, and what you recommend. If you know the right answer, just go ahead
 *    and improve this or this run accordingly."
 *
 * The fix is deliberately NOT a fourth copy of the rule. `ace-orchestrator.md`
 * is what level 0 actually reads, and it gets a pointer that binds the existing
 * rule to this surface, plus the second half of the correction — *stop asking
 * when the run's own contract settles it*, the interactive twin of the
 * already-measured `auto`-mode "never end a turn with a question" rule.
 *
 * SCOPE: three assertions about the orchestrator's operator-facing contract.
 * Each corresponds to a distinct half of the correction; dropping any one
 * re-opens the specific complaint it answers.
 */

const ROOT = join(__dirname, '..', '..');
const ORCH = readFileSync(join(ROOT, 'agents', 'ace-orchestrator.md'), 'utf8');

/** The section governing operator-facing mid-run messages. */
function section(): string {
  const start = ORCH.indexOf('### Talking to the operator mid-run');
  if (start === -1) return '';
  const rest = ORCH.slice(start + 4);
  const end = rest.indexOf('\n### ');
  return end === -1 ? rest : rest.slice(0, end);
}

describe('mid-run operator messages have a declared shape', () => {
  it('ace-orchestrator.md governs the mid-run status update at all', () => {
    expect(
      section(),
      'agents/ace-orchestrator.md has no section governing operator-facing ' +
        'mid-run messages. The three existing decide-then-show rules all fire ' +
        'at SEND time and do not reach this surface — which is where all four ' +
        '2026-09-02 [confusion] corrections landed.',
    ).not.toBe('');
  });

  it('requires the decision or ask FIRST, with detail below', () => {
    const s = section();
    expect(
      /open(s|ing)? with the (single )?decision|lead with the decision/i.test(s),
      'The section no longer requires leading with the decision/ask.',
    ).toBe(true);
    expect(
      /below|last|skippable/i.test(s),
      'The section no longer says supporting detail goes BELOW the decision. ' +
        'Ordering is the whole rule — "include a decision somewhere" is what ' +
        'the buried-verdict turns already did.',
    ).toBe(true);
  });

  it('carries the "just decide" half, not only the "ask legibly" half', () => {
    const s = section();
    expect(
      /if you know the right answer|prefer not asking|stop asking/i.test(s),
      'The section teaches only how to ask more legibly. Jonathan\'s correction ' +
        'also said "If you know the right answer, just go ahead" — a run that ' +
        'asks beautifully but needlessly has not been fixed.',
    ).toBe(true);
  });

  it('points at the existing rule instead of restating it as a fourth copy', () => {
    expect(
      /agent-turn-review/.test(section()),
      'The section restates decide-then-show without binding to ' +
        'skills/agent-turn-review. Four independent copies drift; the point of ' +
        'this one is that it is a POINTER to a rule that already exists.',
    ).toBe(true);
  });
});

/**
 * The self-heal sweep must exhaust its backlog or disclose `N of M` + why.
 *
 * ## Ground truth, which differs from the finding as filed
 *
 * The 2026-09-02 review routed "a self-heal loop stopped at 5" to
 * `agents/iterate-loop.md`. It did not happen there. The real stop site was the
 * post-run self-heal sweep on `bednet-o0sen` (2026-09-01): ~26 issues
 * classified, 14 closed, 5 PRs shipped, then a stop.
 *
 * Critically, that session DID disclose — it wrote "Closed: 14 of ~26" with a
 * per-issue reason. So "never a silent truncation" was already satisfied and is
 * not the defect. Jonathan's correction ("don't stop at 5, fix everything") was
 * about the STOP. Its two stated reasons were:
 *
 *   1. The remaining issues were `mcp/` code — in a sweep that had ALREADY
 *      shipped #1813, an `mcp/ocs/` change, on exactly the
 *      unit-tests-plus-named-residual basis CLAUDE.md prescribes. The session
 *      wrote "My reason for holding these does not survive scrutiny" and then
 *      held them anyway.
 *   2. "five PRs just raced for VERSION" — a solved, one-rebase-per-collision
 *      cost (`scripts/version-bump.sh --rebase-first`), not a stopping condition.
 *
 * So the pinned contract is: exhaustion is the default, a stop must name N of M,
 * and neither of those two reasons is admissible.
 */
describe('self-heal sweep exhausts or discloses', () => {
  function sweep(): string {
    const start = ORCH.indexOf('### Self-heal sweep');
    expect(start, 'the Self-heal sweep section vanished').toBeGreaterThan(-1);
    const rest = ORCH.slice(start + 4);
    const end = rest.indexOf('\n## ');
    return end === -1 ? rest : rest.slice(0, end);
  }

  it('states the exhaust-or-report-N-of-M contract', () => {
    const s = sweep();
    expect(
      /exhaust/i.test(s),
      'The sweep no longer requires exhausting the self-healable set.',
    ).toBe(true);
    expect(
      /N of M|how many of how many/i.test(s),
      'The sweep no longer requires an early stop to report how many of how many.',
    ).toBe(true);
  });

  it('names VERSION contention as a cost, not a stopping condition', () => {
    const s = sweep();
    expect(
      /--rebase-first/.test(s) && /never a reason|not a reason/i.test(s),
      'The sweep no longer rebuts the VERSION-race excuse. That was half the ' +
        'stated reason for stopping at 5, and it is already solved by ' +
        '`scripts/version-bump.sh --rebase-first`.',
    ).toBe(true);
  });

  it('rules out a reason that applies equally to the issues already shipped', () => {
    expect(
      /already refuted|does not survive|is not a reason/i.test(sweep()),
      'The sweep no longer rejects a self-refuting hold reason. The measured ' +
        'case held five `mcp/` issues on a rule the same sweep had already ' +
        'made an exception to, in writing, in the same message.',
    ).toBe(true);
  });

  it('caps per-dispatch scope without capping the NUMBER of dispatches', () => {
    expect(
      /Bundling is what's banned, not volume|not a cap on how many|does NOT cap how many/i.test(
        sweep(),
      ),
      '"One issue per dispatch" reads as a volume cap unless the sweep says ' +
        'otherwise — which is exactly how a per-subagent scope rule becomes a ' +
        'reason to ship only the first few.',
    ).toBe(true);
  });
});
