/**
 * The outbound half of the thread edge: who asked for this run, and have we
 * told them it finished?
 *
 * Why this exists (dimagi-internal/ace#1057). Found by a counterpart having to
 * chase us — Sophie Feintuch, 2026-07-29, thread `19f86579142e6ba5`: *"Just
 * checking if ACE is still working on this?"*, sent while the run she was
 * waiting for had been running two days and had in fact completed its last
 * phase a few hours earlier.
 *
 * Two gaps produced that silence:
 *
 *  1. **The triggering thread was not first-class state.**
 *     `hh-poverty-targeting/20260728-0705` recorded it only inside a free-text
 *     `notes` entry ("Triggered by Jon on thread 19f86579142e6ba5"). Nothing
 *     can read that reliably, so nothing downstream could act on it. The
 *     operating model already treats `thread_id` as THE routing key for
 *     inbound (`email-communicator` step 7 → comms-log → `inbox-triage`
 *     matches on it) — but that edge was inbound-only.
 *  2. **No close-out obligation.** The orchestrator surfaces the run-summary
 *     URL to the operator IN SESSION. If that session ends, or the run is
 *     long, the counterpart learns nothing.
 *
 * The failure is silent and it always points the same way: the person waiting
 * concludes we stopped working. Same trust cost as a broken link, from the
 * opposite direction.
 *
 * A prose "remember to email the requester" is exactly the class of
 * instruction that fails under load — a Phase-8 halt at 13:55 and a Phase-7
 * completion at 15:45 are the moments nobody is thinking about the inbox. So
 * this is a recorded field plus a close-out step that produces a DRAFTED
 * artifact, which makes the omission visible rather than invisible.
 *
 * **Drafted, never sent.** Outbound stays approval-gated (review posture), and
 * `bin/ace-email` remains the only send path. What this adds is a visible
 * parked item.
 */

export type TriggerSurface = 'email' | 'board' | 'manual';

export interface TriggeredBy {
  surface: TriggerSurface;
  /** Gmail thread id. Required for `email`; that is what makes the run routable. */
  thread_id?: string;
  requester?: string;
  requested_at?: string;
  /** Set once the start notice (`startNotice`) has gone out, so a resumed run does not send it twice. */
  start_notice_sent_at?: string;
}

const SURFACES: TriggerSurface[] = ['email', 'board', 'manual'];

export interface TriggeredByParse {
  ok: boolean;
  value?: TriggeredBy;
  issues: string[];
}

/**
 * Validate the block's SHAPE when present. Absence is valid — a manual
 * `/ace:run` has no trigger, and requiring one would make every local run
 * malformed.
 */
export function parseTriggeredBy(raw: unknown): TriggeredByParse {
  if (raw === undefined || raw === null) return { ok: true, issues: [] };
  if (typeof raw !== 'object') {
    return { ok: false, issues: ['triggered_by must be a mapping when present'] };
  }
  const t = raw as Record<string, unknown>;
  const issues: string[] = [];
  const surface = t.surface as TriggerSurface;
  if (!SURFACES.includes(surface)) {
    issues.push(`triggered_by.surface must be one of ${SURFACES.join(' | ')} (got ${String(t.surface)})`);
  }
  if (surface === 'email' && !t.thread_id) {
    issues.push(
      'triggered_by.thread_id is required for surface: email — the thread id is the routing key the ' +
        'comms-log and inbox-triage match on, and without it the close-out reply has nowhere to go',
    );
  }
  for (const k of ['thread_id', 'requester', 'requested_at', 'start_notice_sent_at']) {
    if (t[k] !== undefined && typeof t[k] !== 'string') issues.push(`triggered_by.${k} must be a string`);
  }
  return issues.length
    ? { ok: false, issues }
    : { ok: true, value: raw as TriggeredBy, issues: [] };
}

export interface CloseoutInput {
  triggeredBy?: TriggeredBy;
  runId: string;
  opportunity: string;
  /** Has the run reached a terminal state (complete, halted, or errored)? */
  terminal: boolean;
  summaryUrl: string;
  outcome?: 'completed' | 'halted' | 'error';
  haltReason?: string;
}

export interface PendingCloseoutNotice {
  threadId: string;
  to?: string;
  /** Always `drafted`. There is no send path through this module. */
  status: 'drafted';
  subjectHint: string;
  body: string;
}

/**
 * The parked outbound a triggered run owes its requester once it is terminal.
 *
 * Returns null when nobody is waiting (no trigger, or a non-email surface with
 * no thread) or the run is still going — a mid-run ping is noise, and noise is
 * how a real notice gets ignored.
 *
 * A HALTED run still drafts: silence is the failure mode, not bad news. The
 * counterpart on thread 19f86579142e6ba5 would have been better served by
 * "Phase 8 is waiting on LLO selection" than by two days of nothing.
 */
export function pendingCloseoutNotice(input: CloseoutInput): PendingCloseoutNotice | null {
  const t = input.triggeredBy;
  if (!t?.thread_id) return null;
  if (!input.terminal) return null;

  const outcome = input.outcome ?? 'completed';
  const headline =
    outcome === 'completed'
      ? `Run ${input.runId} on ${input.opportunity} has finished.`
      : outcome === 'halted'
        ? `Run ${input.runId} on ${input.opportunity} has stopped and is waiting on a decision.`
        : `Run ${input.runId} on ${input.opportunity} stopped with an error.`;

  const lines = [headline];
  if (input.haltReason) lines.push('', `Where it stopped: ${input.haltReason}`);
  lines.push('', `Run summary: ${input.summaryUrl}`);

  return {
    threadId: t.thread_id,
    to: t.requester,
    status: 'drafted',
    subjectHint: `${input.opportunity} — run ${input.runId} ${outcome}`,
    body: lines.join('\n'),
  };
}

export const CANOPY_BASE_URL = 'https://canopy.dimagi.com';

/**
 * The canopy page where a person watches a session live. Workspace-addressed,
 * like every canopy link ACE sends (`bin/canopy_url_scope.py`). Both values come
 * from canopy's own record of the session (`canopy_sessions_get_session`), never
 * a guess: a wrong link sends the requester to someone else's chat or a 404.
 */
export function canopySessionUrl(workspace: string, sessionId: string): string {
  return `${CANOPY_BASE_URL}/w/${workspace}/chat/${sessionId}`;
}

export interface StartNoticeInput {
  triggeredBy?: TriggeredBy;
  runId: string;
  opportunity: string;
  /** `run_state.yaml` `ace_web_summary_url`. */
  summaryUrl: string;
  /** From `canopySessionUrl`. Omitted when canopy has no record of this session. */
  sessionUrl?: string;
}

export interface StartNotice {
  threadId: string;
  to?: string;
  body: string;
}

/**
 * The one reply an email-triggered run sends when it STARTS: where to watch it.
 *
 * A run takes hours, and until this the requester heard nothing between their
 * ask and the close-out. Owner, 2026-10-28: *"if it's an e-mail channel that is
 * triggering a long run, we respond with the url on ace-web and canopy session
 * if people want to watch along."* Sophie's smallholder-seasonal/20261028-1636
 * was the case: asked by email at 16:31, Phase 3 still building hours later,
 * and the thread silent the whole time.
 *
 * This is not a progress ping. It goes once, at start, and it carries links a
 * person can open, not a status claim that goes stale. The close-out reply
 * (`pendingCloseoutNotice`) is still the answer to what they asked for.
 *
 * Returns null when nobody asked by email, or when the notice already went
 * (`start_notice_sent_at`, so a resumed run stays quiet).
 */
export function startNotice(input: StartNoticeInput): StartNotice | null {
  const t = input.triggeredBy;
  if (t?.surface !== 'email' || !t.thread_id) return null;
  if (t.start_notice_sent_at) return null;

  const lines = [
    `I've started building ${input.opportunity} (run ${input.runId}). A full build takes a few hours, and I'll reply on this thread when it finishes or needs a decision from you.`,
    '',
    `To follow along, the run's page shows each part as it's built: ${input.summaryUrl}`,
  ];
  if (input.sessionUrl) {
    lines.push('', `You can also watch me work, step by step, in Canopy: ${input.sessionUrl}`);
  }
  return { threadId: t.thread_id, to: t.requester, body: lines.join('\n') };
}
