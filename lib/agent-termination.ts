/**
 * How a dispatched phase subagent STOPPED, and which recovery verb that admits.
 *
 * ## Why this exists
 *
 * ACE's orchestrator has, historically, exactly one recovery verb for a phase
 * dispatch that did not deliver: **re-dispatch** (`agents/ace-orchestrator.md`
 * § Auto-retry silent Agent dispatches). That verb is correct for the case it
 * was written for — an agent that never started its workflow — and it is wrong,
 * expensively, for the two cases below, because it discards a build context that
 * was still reachable, or addresses a target that no longer exists.
 *
 * The distinguishing fact is not in `run_state.yaml` and not in the artifacts.
 * It is in the `<task-notification>` the orchestrator already receives, and in
 * whether one arrives at all.
 *
 * ## The two termination classes that are not "it never started"
 *
 * **`stream-watchdog`** — Claude Code aborts a subagent that emits no streaming
 * progress for `CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS` (default 600000; the timer
 * resets on each streaming progress event). The parent is told:
 *
 *     <status>failed</status>
 *     <summary>Agent "…" failed: Agent stalled: no progress for 600s
 *              (stream watchdog did not recover)</summary>
 *
 * The agent is **still reachable**. The notification says so itself — *"The user
 * can send it another message and resume it, so the same task-id may notify more
 * than once"* — and the `SendMessage` contract says a send "resumes it from its
 * transcript". So the recovery is RESUME, and resuming is what preserves the
 * half-built external state (a Nova app, a Connect opportunity) that a fresh
 * dispatch would duplicate. This is the same invariant ace#1504 protects, seen
 * one layer up.
 *
 * **`session-exit`** — the whole Claude Code process ended. No notification ever
 * arrives, because there is nothing left to deliver it into; the evidence is a
 * NEW session picking the phase up. `SendMessage` has no target here — not an
 * unlikely resume, an impossible one. The recovery is to reconcile external
 * state first (`list_apps` and friends are the only authority; Drive can be
 * empty while Nova holds a half-built app) and then decide.
 *
 * ## What this file is NOT
 *
 * It is not a timeout ACE sets. `CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS` is the
 * harness's, settable only in `~/.claude/settings.json` `env` alongside the
 * `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` pin — and ACE deliberately does not
 * raise it. See `agents/ace-orchestrator.md` § Auto-retry for why raising it is
 * the wrong lever: in the one measured kill the watchdog was RIGHT, and a longer
 * leash would only have waited longer for a turn that was never coming.
 *
 * Like `lib/agent-depth.ts`, nothing imports this at runtime — the consumers are
 * procedure docs. It is the declaration the docs are cross-checked against by
 * `test/lib/agent-termination.test.ts`, so a doc that drops a branch fails CI
 * instead of quietly reverting to re-dispatch-everything.
 */

/** How a dispatched subagent stopped. */
export type TerminationClass =
  /** Ran to completion and returned. Nothing to recover. */
  | 'completed'
  /** Aborted by the harness stall watchdog. Still addressable. */
  | 'stream-watchdog'
  /** The host session ended. No notification, no target. */
  | 'session-exit'
  /** A `failed` notification whose cause is not one of the above. */
  | 'unknown';

/** What the orchestrator should DO about it. */
export type RecoveryVerb =
  /** Nothing — the dispatch delivered. */
  | 'none'
  /** `SendMessage` the same task-id. Keeps the agent's build context. */
  | 'resume'
  /**
   * Establish external ground truth from the owning system FIRST, then choose
   * between resume, repair and rebuild. Never re-dispatch blind.
   */
  | 'reconcile-then-decide';

export interface TerminationVerdict {
  readonly termination: TerminationClass;
  /** Whether `SendMessage` to the agent's task-id can still land. */
  readonly reachable: boolean;
  readonly recovery: RecoveryVerb;
  /** One line an orchestrator can put in front of a human. */
  readonly why: string;
}

/**
 * The declared classes, in the order a doc should present them. Every entry with
 * a recovery verb other than `none` MUST be described in
 * `agents/ace-orchestrator.md`; the test enforces it.
 */
export const TERMINATION_CLASSES: readonly TerminationClass[] = [
  'completed',
  'stream-watchdog',
  'session-exit',
  'unknown',
];

/**
 * Substrings that identify a stall abort in a `<task-notification>` summary.
 *
 * Deliberately three independent anchors rather than one exact string: the
 * summary is the harness's prose and has no compatibility promise, while the
 * number in `no progress for 600s` moves the moment anyone sets
 * `CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS`. Matching any one of them is enough,
 * because the alternative branch (`unknown`) is also non-destructive.
 */
const STALL_MARKERS: readonly RegExp[] = [
  /stream watchdog/i,
  /agent stalled/i,
  /no progress for \d+\s*s\b/i,
];

const FAILED = /<status>\s*failed\s*<\/status>/i;
const COMPLETED = /<status>\s*completed\s*<\/status>/i;

/**
 * The failure marker as it appears when only the `<summary>` line is passed —
 * `Agent "…" failed: Agent stalled: …`. Without this, the summary-only input
 * mode this function documents falls through to `unknown` on every stall.
 *
 * Both halves are load-bearing together, and a mutation test is what proved it.
 * Dropping the failure requirement entirely (matching on the stall anchors
 * alone) survives every other assertion here, and then misreads a COMPLETED
 * agent whose NAME contains the words — `Agent "Agent stream watchdog config"
 * finished` is a real summary from this repo — as a stall, prescribing a resume
 * for an agent that already returned.
 */
const FAILED_SUMMARY = /\bfailed:/i;

/**
 * Classify how a dispatched subagent stopped.
 *
 * @param notification The `<task-notification>` block the orchestrator received,
 *   or its `<summary>` line. Pass `null`/`''` for the case where NO notification
 *   arrived and a new session is picking the phase up — that absence is itself
 *   the evidence of `session-exit`, and it is the only way that class can be
 *   observed.
 */
export function classifyAgentTermination(
  notification: string | null | undefined,
): TerminationVerdict {
  if (notification == null || notification.trim() === '') {
    return {
      termination: 'session-exit',
      reachable: false,
      recovery: 'reconcile-then-decide',
      why:
        'No task-notification arrived — the host session ended, so SendMessage ' +
        'has no target. Read external state from the owning system before ' +
        'deciding; an empty run folder is not evidence that nothing was built.',
    };
  }

  if (COMPLETED.test(notification)) {
    return {
      termination: 'completed',
      reachable: true,
      recovery: 'none',
      why: 'The dispatch ran to completion and returned.',
    };
  }

  const failed = FAILED.test(notification) || FAILED_SUMMARY.test(notification);
  if (failed && STALL_MARKERS.some((m) => m.test(notification))) {
    return {
      termination: 'stream-watchdog',
      reachable: true,
      recovery: 'resume',
      why:
        'The harness stall watchdog aborted the agent, which is still ' +
        'addressable: SendMessage the same task-id to resume it from its ' +
        'transcript. Re-dispatching instead discards the build context and can ' +
        'duplicate external resources the agent already created.',
    };
  }

  return {
    termination: 'unknown',
    reachable: failed,
    recovery: 'reconcile-then-decide',
    why:
      'A notification arrived but its cause is not a recognised class. The ' +
      'session is alive, so the agent may still be addressable — establish ' +
      'external ground truth before choosing resume or rebuild.',
  };
}
