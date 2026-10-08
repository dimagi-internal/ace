/**
 * Capture one ACE Coach conversation, played by ACE as the worker, for demo
 * footage and for QA of the real production start (skills/coach-session-capture).
 *
 * ## One start, two deliveries
 *
 * A real coaching conversation begins the way Labs begins it
 * (connect-labs `tasks/ai_sessions.py`, `start_ai_session`): the worker receives a
 * FIXED opening verbatim (`message_text`, no LLM) and the briefing goes into the
 * OCS session state as `coach_briefing`, which the Coach's prompt reads as
 * `{session_state.coach_briefing}` (templates/ocs-coach/coach-prompt.md). Both
 * strings come from the `start_ocs_outreach` PREVIEW Labs returns — `opening` and
 * `prompt` per worker — so ACE never re-derives Labs' briefing composition
 * (connect-labs `workflow/run_grading.py` + `coach_briefing.py`); it reads it.
 *
 * {@link coachStartFromPreview} is that one start. The two modes differ ONLY in
 * delivery:
 *
 *   - **mobile** — Labs itself sends it: `workflow_run_action(start_ocs_outreach,
 *     deliver_to = ACE's test user)`, the "Send to me instead (QA)" path, which on a
 *     synthetic opportunity is a REAL OCS conversation on the `commcare_connect`
 *     channel (actions.py `_check_deliver_to`; ai_sessions.py skips the canned
 *     transcript when `qa_redirect` is set). ACE then plays the worker on the AVD.
 *   - **web** — no device and no Connect send: an OCS web session for ACE's own OCS
 *     login, with the SAME `session_data` written to its state before the first
 *     worker message, continued in OCS's own chat page.
 *
 * ## The carve-out this module enforces
 *
 * The coach design's owner decision is "ACE never triggers outreach". Jonathan
 * granted one narrow exception (2026-10-07): ACE may send a coaching conversation
 * to ITS OWN Connect test user, to record itself answering on mobile. Nothing else.
 * {@link assertAceTestRecipient} is that exception in code: mobile mode refuses any
 * `deliver_to` that is not the ConnectID username of ACE's `+7426` demo user,
 * resolved from CommCare HQ, never typed.
 *
 * Pure: no I/O.
 */

/** connect-id `users/const.py` TEST_NUMBER_PREFIX — every ACE test user is a demo-range number. */
export const ACE_TEST_PHONE_PREFIX = '+7426';

/** connect-labs `workflow/coach_briefing.py` BRIEFING_PREFIX (`is_briefing`). */
export const BRIEFING_PREFIX = 'BRIEFING';

export class CoachCaptureRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoachCaptureRefusal';
  }
}

/** The subset of an HQ mobile worker (commcare_list_users) this module reads. */
export interface HqUser {
  username: string;
  phone_numbers?: string[];
}

const digits = (s: string) => s.replace(/\D/g, '');

/**
 * ACE's test user's ConnectID username, read from CommCare HQ: the mobile worker
 * whose phone is `phone` (ACE_E2E_PHONE). Connect creates that HQ user under the
 * ConnectID username, so the local part of its HQ username IS the ConnectID
 * username — the same string the CommCare app shows as "Logged In: <username>".
 * Throws unless `phone` is a `+7426` demo number with exactly one HQ user.
 */
export function resolveAceTestUsername(users: HqUser[], phone: string): string {
  if (!phone.startsWith(ACE_TEST_PHONE_PREFIX)) {
    throw new CoachCaptureRefusal(
      `${phone || '(empty)'} is not an ACE test phone: ACE test users are ${ACE_TEST_PHONE_PREFIX} demo numbers.`,
    );
  }
  const want = digits(phone);
  const hits = users.filter((u) => (u.phone_numbers ?? []).some((p) => digits(p) === want));
  if (hits.length !== 1) {
    throw new CoachCaptureRefusal(
      `expected exactly one HQ mobile worker with phone ${phone}, found ${hits.length}; ` +
        'the test user must have claimed an opportunity in this HQ domain first.',
    );
  }
  const local = hits[0].username.split('@')[0];
  if (!local) throw new CoachCaptureRefusal(`HQ user ${hits[0].username} has no username`);
  return local;
}

/**
 * The carve-out guard. Mobile mode sends a REAL coaching conversation through
 * Connect, so the recipient must be ACE's own test user and nobody else — not a
 * worker, not a staff member, not a typo.
 */
export function assertAceTestRecipient(deliverTo: string, aceTestUsername: string): void {
  if (!aceTestUsername) {
    throw new CoachCaptureRefusal('ACE test user is unresolved; refusing to send a coaching conversation.');
  }
  if (deliverTo !== aceTestUsername) {
    throw new CoachCaptureRefusal(
      `refusing to send a coaching conversation to ${JSON.stringify(deliverTo)}: ACE may only send one to ` +
        `its own test user (${aceTestUsername}). Real workers are coached by a person from Labs.`,
    );
  }
}

/** One worker from a `start_ocs_outreach` preview (`workflow_run_action` without `confirm`). */
export interface PreviewWorker {
  key: string;
  name?: string;
  prompt: string;
  opening: string;
  indicators?: string[];
  sending_to?: string;
}

export interface OutreachPreview {
  type: string;
  workers: PreviewWorker[];
  arguments: Record<string, unknown> & { bot?: string; deliver_to?: string };
  bot?: { id: string; name?: string };
  qa_redirect?: boolean;
  confirm?: string;
}

/** What starts a coaching conversation, identical in both modes. */
export interface CoachStart {
  bot: string;
  workerKey: string;
  /** Sent verbatim as the Coach's first message (Labs `message_text`). */
  message_text: string;
  /** Merged into the OCS session state (Labs `session_data`, coach-relevant keys). */
  session_data: { coach_briefing: string; on_behalf_of: string; qa_recipient: string };
}

/**
 * The production start for ONE worker, taken from Labs' own preview. `recipient`
 * is who reads it: ACE's test user's ConnectID username (mobile) or ACE's OCS
 * login (web). It is recorded as `qa_recipient`, as Labs records it.
 */
export function coachStartFromPreview(preview: OutreachPreview, recipient: string): CoachStart {
  if (preview.type !== 'start_ocs_outreach') {
    throw new CoachCaptureRefusal(`not a coaching preview: action type ${preview.type}`);
  }
  if (preview.workers.length !== 1) {
    // Labs' own rule for a QA redirect: one worker per call (one OCS participant).
    throw new CoachCaptureRefusal(`a capture coaches exactly one worker; the preview names ${preview.workers.length}`);
  }
  const w = preview.workers[0];
  const bot = preview.bot?.id ?? (preview.arguments.bot as string | undefined);
  if (!bot || bot === 'synthetic-muac-coaching') {
    throw new CoachCaptureRefusal(
      `the preview resolved no real Coach (bot=${bot ?? 'none'}); on a synthetic opportunity Labs only uses ` +
        'the real bot when deliver_to is set — preview with deliver_to.',
    );
  }
  if (!w.prompt?.trimStart().startsWith(BRIEFING_PREFIX)) {
    throw new CoachCaptureRefusal(`worker ${w.key} has no Labs briefing (prompt does not start with ${BRIEFING_PREFIX})`);
  }
  if (!w.opening) throw new CoachCaptureRefusal(`worker ${w.key} has no opening in the preview`);
  const username = w.key.includes('::') ? w.key.split('::').slice(1).join('::') : w.key;
  return {
    bot,
    workerKey: w.key,
    message_text: w.opening,
    session_data: { coach_briefing: w.prompt, on_behalf_of: username, qa_recipient: recipient },
  };
}

/**
 * Mobile mode: the confirmed `workflow_run_action` arguments, guarded. Labs builds
 * the same start server-side from these (the preview's `arguments` + `confirm`).
 */
export function mobileCommitArgs(preview: OutreachPreview, aceTestUsername: string) {
  const deliverTo = String(preview.arguments.deliver_to ?? '');
  assertAceTestRecipient(deliverTo, aceTestUsername);
  if (!preview.qa_redirect) throw new CoachCaptureRefusal('the preview is not a QA redirect; refusing a real send');
  if (!preview.confirm) throw new CoachCaptureRefusal('the preview carries no confirm token');
  return {
    start: coachStartFromPreview(preview, deliverTo),
    arguments: preview.arguments,
    confirm: preview.confirm,
  };
}

/** Web mode: the start, recorded as read by ACE's OCS login. No Connect send, so no recipient guard. */
export function webStart(preview: OutreachPreview, ocsLoginEmail: string): CoachStart {
  return coachStartFromPreview(preview, ocsLoginEmail);
}

/**
 * The topics in a Labs briefing, for `findOverstatements` (lib/coach-briefing.ts).
 * Lines look like `1. Off-site visits [CL_X1] — 31 of 73 (42%), band red` — the
 * shape connect-labs `coach_briefing.py` `_TOPIC_LINE` parses for its own preview.
 */
export function topicsFromBriefing(
  briefing: string,
): Array<{ key: string; label: string; numerator?: number; denominator?: number; value?: number; band: string }> {
  const out = [];
  for (const line of briefing.split('\n')) {
    const m = /^\d+\.\s+(.*?)\s+\[([^\]]+)\]\s+—\s+(.*),\s+band\s+(\S+)\s*$/.exec(line);
    if (!m) continue;
    const [, label, key, figure, band] = m;
    const frac = /(\d+)\s+of\s+(\d+)/.exec(figure);
    const pct = /(\d+(?:\.\d+)?)%/.exec(figure);
    out.push({
      key,
      label,
      band,
      ...(frac ? { numerator: Number(frac[1]), denominator: Number(frac[2]) } : {}),
      ...(pct ? { value: Number(pct[1]) } : {}),
    });
  }
  return out;
}

// No participant-data reset here: OCS keeps participant data per (participant,
// chatbot), so ACE's re-used participants carry the last capture's status — but the
// Coach's status node already blanks every list on a new session's opening turn
// (templates/ocs-coach/status_node.py `opening_turn`). Read status from the session's
// own turns, not from participant data captured before the first reply.

export type Persona = 'agree' | 'dispute' | 'safety';

/**
 * The worker's side, scripted so a recording is repeatable. Each turn is sent only
 * after the Coach has replied to the previous one. Written for an off-site-visit
 * topic but generic enough for any one red topic: short, plain, like a field
 * worker typing on a phone.
 */
export const PERSONA_TURNS: Record<Persona, string[]> = {
  agree: [
    'Yes, I have a few minutes.',
    'Some days I record the visit after I leave, when I reach a place with network.',
    'I can record it while I am still at the waterpoint and wait for it to save.',
    'Yes, I will try that from this week.',
    'Yes. From Monday I will wait for every visit to save before I leave the waterpoint.',
  ],
  dispute: [
    'Yes, I can talk now.',
    'I was at the waterpoint every time. My phone shows the wrong place when the network is weak there.',
    'At Rijiyar Kwara the location jumps far away even when I stand next to the tap.',
    'Thank you. Please check it.',
  ],
  safety: [
    'Yes.',
    'I could not finish my visits last week. A man at one waterpoint threatened me and I am afraid to go back.',
    'Okay. Thank you.',
  ],
};

/**
 * The `REPLY_START` a mobile await recipe matches (connect-messaging-await.yaml): the
 * first `words` words of the Coach's reply as read from OCS, regex-escaped, because
 * Maestro's `text:` is a full-match regex and the recipe appends `.*`. Cut at the
 * first line break: a bubble's TextView holds the whole message, but a prefix that
 * spans a newline is where escaping and the device's rendering disagree.
 */
export function replyStartPattern(reply: string, words = 6): string {
  const firstLine = reply.trim().split('\n')[0].trim();
  const prefix = firstLine.split(/\s+/).slice(0, words).join(' ');
  return prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
