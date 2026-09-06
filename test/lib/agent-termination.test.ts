/**
 * A phase dispatch that stopped is not automatically a phase dispatch to re-run.
 *
 * ## The incident
 *
 * `poverty-graduation/20260905-1345`. `Agent(ace:commcare-setup)` was aborted by
 * the harness stall watchdog, and the parent was told so in as many words:
 *
 *     <status>failed</status>
 *     <summary>Agent "Learn build only (re-dispatch)" failed: Agent stalled:
 *              no progress for 600s (stream watchdog did not recover)</summary>
 *     <note>… The user can send it another message and resume it …</note>
 *
 * The orchestrator had exactly one verb for that — `agents/ace-orchestrator.md`
 * § Auto-retry silent Agent dispatches, "re-dispatch the SAME phase ONE more
 * time" — so it re-dispatched, and briefed the fresh agent that the previous one
 * "wrote **nothing** … there is no partial work to reconcile: start clean."
 *
 * Drive-side that was true. Nova-side it was not: app
 * `de612428-258f-4ed9-afa0-cd748e65ed84` existed, one module of an intended
 * seven, with no trace in `run_state.yaml` or the run folder. It is still there
 * (verified 2026-09-06) alongside the eventual real build — the exact duplicate
 * that ace#1504's "never reach for /nova:autobuild while an app for this run
 * exists" was written to prevent, arrived at from one level up. That orphan is
 * ace#2058.
 *
 * ## Why the fix is the VERB and not the topology
 *
 * ace#2059 read the kill as "a phase subagent that dispatches /nova:autobuild is
 * killed while its child builds, so Phase 3 cannot be a background Agent," and
 * proposed flattening Phase 3 to inline. Both halves are refuted by the saved
 * transcripts:
 *
 *   - Four `ace:commcare-setup` dispatches (2026-08-28 … 2026-09-05) sat silent
 *     for 462s, 557s, 570s, 820s and 899s awaiting
 *     `Agent(nova:nova-architect-autonomous)` and were NOT killed; one closed
 *     `Phase 3 — status: done, verdict: pass`.
 *   - The dispatch that WAS killed made zero Nova dispatches. It stalled
 *     mid-generation, before reaching one.
 *
 * So the watchdog does not count a wait on a child, the middle layer is not the
 * mechanism, and flattening would move a ~300K-token phase into the
 * orchestrator's own window — raising stall risk to fix a cause that isn't
 * there. What was actually missing is the branch this file guards: a
 * watchdog-killed agent is REACHABLE, and the recovery is to resume it.
 *
 * ## Scope
 *
 * Two halves, deliberately narrow. The classifier's behaviour on the REAL
 * notification strings, and the orchestrator doc actually carrying the branch —
 * because a declaration no doc reads changes nothing about what an orchestrator
 * does at 3am.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  TERMINATION_CLASSES,
  classifyAgentTermination,
} from '../../lib/agent-termination.js';

const ROOT = join(__dirname, '..', '..');
const ORCHESTRATOR = readFileSync(join(ROOT, 'agents', 'ace-orchestrator.md'), 'utf8');

/** Verbatim from the parent session's transcript for `a0d9af9d1d0329451`. */
const REAL_STALL_NOTIFICATION = `<task-notification>
<task-id>a0d9af9d1d0329451</task-id>
<tool-use-id>toolu_01Jy3diYLthhR9PwoS2zLAdM</tool-use-id>
<status>failed</status>
<summary>Agent "Learn build only (re-dispatch)" failed: Agent stalled: no progress for 600s (stream watchdog did not recover)</summary>
<note>A task-notification fires each time this agent stops with no live background children of its own. The user can send it another message and resume it, so the same task-id may notify more than once.</note>
</task-notification>`;

const REAL_COMPLETED_NOTIFICATION = `<task-notification>
<task-id>a174aedc34246bc74</task-id>
<status>completed</status>
<summary>Agent "Agent stream watchdog config" finished</summary>
</task-notification>`;

describe('classifyAgentTermination', () => {
  it('reads the real stall notification as resumable, not as a re-dispatch', () => {
    const v = classifyAgentTermination(REAL_STALL_NOTIFICATION);
    expect(v.termination).toBe('stream-watchdog');
    expect(v.reachable).toBe(true);
    expect(v.recovery).toBe('resume');
  });

  it('treats an ABSENT notification as session-exit — unreachable', () => {
    // The only way session-exit is observable: nothing was ever delivered,
    // because there was nothing left to deliver it into.
    for (const absent of [null, undefined, '', '   ']) {
      const v = classifyAgentTermination(absent);
      expect(v.termination, `for ${JSON.stringify(absent)}`).toBe('session-exit');
      expect(v.reachable).toBe(false);
      expect(v.recovery).toBe('reconcile-then-decide');
    }
  });

  it('never answers "resume" for an agent it says is unreachable', () => {
    // The pairing is the load-bearing part: SendMessage to a dead session is not
    // an unlikely recovery, it is an impossible one (ace#2058).
    const notifications = [
      REAL_STALL_NOTIFICATION,
      REAL_COMPLETED_NOTIFICATION,
      null,
      '<status>failed</status><summary>Agent "x" failed: something else</summary>',
    ];
    for (const n of notifications) {
      const v = classifyAgentTermination(n);
      if (v.recovery === 'resume') expect(v.reachable).toBe(true);
      if (!v.reachable) expect(v.recovery).not.toBe('resume');
    }
  });

  it('recognises a stall on any one anchor, so the 600 is not load-bearing', () => {
    // `no progress for 600s` moves the moment anyone sets
    // CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS, and the summary is harness prose with
    // no compatibility promise. Any single anchor must be enough.
    const variants = [
      '<status>failed</status><summary>Agent "p3" failed: Agent stalled: no progress for 1800s (stream watchdog did not recover)</summary>',
      '<status>failed</status><summary>Agent "p3" failed: the stream watchdog gave up</summary>',
      '<status>failed</status><summary>Agent "p3" failed: Agent stalled</summary>',
    ];
    for (const v of variants) {
      expect(classifyAgentTermination(v).termination, v).toBe('stream-watchdog');
    }
  });

  it('does not read a COMPLETED agent as a stall just because the words appear', () => {
    // The guide-agent notification above is literally titled "Agent stream
    // watchdog config" — a completed run whose summary contains the anchor. A
    // status-blind matcher turns that into a spurious resume.
    const v = classifyAgentTermination(REAL_COMPLETED_NOTIFICATION);
    expect(v.termination).toBe('completed');
    expect(v.recovery).toBe('none');
  });

  it('classifies a bare SUMMARY line, the second documented input mode', () => {
    // A summary carries no <status> tag at all. Requiring one made every
    // summary-only stall fall through to `unknown` — found by mutation-testing
    // this file, not by reading it.
    const v = classifyAgentTermination(
      'Agent "Learn build only (re-dispatch)" failed: Agent stalled: no progress for 600s (stream watchdog did not recover)',
    );
    expect(v.termination).toBe('stream-watchdog');
    expect(v.recovery).toBe('resume');
  });

  it('does not resume on a COMPLETED bare summary that merely names the watchdog', () => {
    // The adversarial half of the pair above, and the reason the failure marker
    // cannot simply be dropped: this exact summary occurred in this repo.
    const v = classifyAgentTermination('Agent "Agent stream watchdog config" finished');
    expect(v.termination).not.toBe('stream-watchdog');
    expect(v.recovery).not.toBe('resume');
  });

  it('falls back to reconcile-then-decide, never to a blind re-dispatch', () => {
    const v = classifyAgentTermination(
      '<status>failed</status><summary>Agent "p5" failed: quota exhausted</summary>',
    );
    expect(v.termination).toBe('unknown');
    expect(v.recovery).toBe('reconcile-then-decide');
  });

  it('gives every verdict a non-empty why an orchestrator can surface', () => {
    for (const n of [REAL_STALL_NOTIFICATION, REAL_COMPLETED_NOTIFICATION, null, 'x']) {
      expect(classifyAgentTermination(n).why.length).toBeGreaterThan(20);
    }
  });
});

/**
 * The § Auto-retry block, sliced out so a mention ANYWHERE else in a 2000-line
 * doc cannot satisfy these. The branch has to live where the orchestrator is
 * standing when it decides to re-dispatch.
 */
function autoRetrySection(): string {
  const start = ORCHESTRATOR.indexOf('**Auto-retry silent Agent dispatches');
  expect(start, 'the § Auto-retry block must exist to be checked').toBeGreaterThan(-1);
  const end = ORCHESTRATOR.indexOf('**Pre-load phase atoms', start);
  expect(end, 'the § Auto-retry block must end at § Pre-load phase atoms').toBeGreaterThan(start);
  return ORCHESTRATOR.slice(start, end);
}

describe('the orchestrator carries the termination branch, not just the re-dispatch', () => {
  const section = autoRetrySection();

  it('names every declared class other than the trivial one', () => {
    for (const cls of TERMINATION_CLASSES) {
      if (cls === 'completed') continue;
      expect(section, `§ Auto-retry must name the '${cls}' class`).toContain(cls);
    }
  });

  it('prescribes SendMessage — resume — for a watchdog kill', () => {
    expect(section).toMatch(/SendMessage/);
    expect(section).toMatch(/RESUME/i);
    expect(section).toContain('lib/agent-termination.ts');
  });

  it('does not present re-dispatch as unconditional any more', () => {
    // Pre-fix the block read "On silent failure, re-dispatch the SAME phase ONE
    // more time" with nothing between it and the classifier result. That literal
    // sentence is what re-dispatched into ace#2058's orphan.
    expect(section).not.toMatch(/On silent failure, re-dispatch the SAME phase/);
    expect(section).toMatch(/not[^\n]*`stream-watchdog`[\s\S]{0,80}re-dispatch/);
  });

  it('names the harness knob AND says ACE does not turn it', () => {
    // Without this, the next reader re-derives "just raise the timeout" — which
    // in the measured case would only have waited longer for a turn that was
    // never coming.
    expect(section).toContain('CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS');
    expect(section).toMatch(/leaves\s+it\s+alone|do not raise|deliberately/i);
  });

  it('records the measurement that keeps Phase 3 a subagent', () => {
    // The refuted premise of ace#2059. Deleting this invites the flatten-Phase-3
    // remedy back, and that one is expensive to undo.
    expect(section).toMatch(/899s/);
    expect(section).toMatch(/ace#2059/);
  });
});
