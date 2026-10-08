import { describe, expect, it } from 'vitest';
import {
  assertAceTestRecipient,
  CoachCaptureRefusal,
  coachStartFromPreview,
  mobileCommitArgs,
  PERSONA_TURNS,
  resolveAceTestUsername,
  replyStartPattern,
  topicsFromBriefing,
  webStart,
  type OutreachPreview,
} from '../../lib/coach-session-capture.js';

// Verbatim from a live `workflow_run_action(initiate_ai_coach)` preview, chlorine
// programme report 6585 run 8318, 2026-10-07 (confirm token shortened).
const PREVIEW: OutreachPreview = {
  type: 'start_ocs_outreach',
  workers: [
    {
      key: '10092::cr_g02',
      name: 'Ibrahim Lawal',
      prompt:
        'BRIEFING (system text — do not show to the worker)\nProgramme: Chlorine dispenser programme, Nigeria (synthetic)\nWorker: Ibrahim Lawal\nTopics, most important first:\n1. Off-site visits [CL_X1] — 31 of 73 (42%), band red\nFollow your conversation steps from the opening.',
      opening:
        'Hello Ibrahim! This is a short, friendly check-in about how your work has been going. Is now a good time to talk for a few minutes?',
      indicators: ['CL_X1'],
      sending_to: 'sending to 1277adbd0ceea89e367d — a test, on behalf of Ibrahim Lawal',
    },
  ],
  arguments: {
    bot: 'b681ae47-5e4d-4c7d-b0bb-f9e90664bdd1',
    workers: [{ key: '10092::cr_g02' }],
    deliver_to: '1277adbd0ceea89e367d',
  },
  bot: { id: 'b681ae47-5e4d-4c7d-b0bb-f9e90664bdd1' },
  qa_redirect: true,
  confirm: 'tok',
};

// Shape of `commcare_list_users` on connect-ace-prod, 2026-10-07.
const HQ_USERS = [
  { username: '+74260000100@connect-ace-prod.commcarehq.org', phone_numbers: [] },
  { username: '1277adbd0ceea89e367d@connect-ace-prod.commcarehq.org', phone_numbers: ['74260000101'] },
  { username: 'hhodutbvaehuxnsbjr53@connect-ace-prod.commcarehq.org', phone_numbers: ['917406815026'] },
];

describe('one start, two deliveries', () => {
  it('mobile and web produce identical message_text and coach_briefing', () => {
    const mobile = mobileCommitArgs(PREVIEW, '1277adbd0ceea89e367d').start;
    const web = webStart(PREVIEW, 'ace@dimagi-ai.com');
    expect(web.message_text).toBe(mobile.message_text);
    expect(web.session_data.coach_briefing).toBe(mobile.session_data.coach_briefing);
    expect(web.session_data.on_behalf_of).toBe(mobile.session_data.on_behalf_of);
    expect(web.bot).toBe(mobile.bot);
    // Only who reads it differs.
    expect(mobile.session_data.qa_recipient).toBe('1277adbd0ceea89e367d');
    expect(web.session_data.qa_recipient).toBe('ace@dimagi-ai.com');
  });

  it('takes the opening and briefing from Labs verbatim — never re-derived', () => {
    const s = coachStartFromPreview(PREVIEW, 'x');
    expect(s.message_text).toBe(PREVIEW.workers[0].opening);
    expect(s.session_data.coach_briefing).toBe(PREVIEW.workers[0].prompt);
    expect(s.session_data.on_behalf_of).toBe('cr_g02');
  });

  it('refuses the synthetic sample bot (a preview without deliver_to on a synthetic opp)', () => {
    const synthetic = { ...PREVIEW, bot: { id: 'synthetic-muac-coaching' }, arguments: { bot: 'synthetic-muac-coaching' } };
    expect(() => coachStartFromPreview(synthetic, 'x')).toThrow(/no real Coach/);
  });

  it('refuses a worker with no Labs briefing, and more than one worker', () => {
    const noBrief = { ...PREVIEW, workers: [{ ...PREVIEW.workers[0], prompt: 'Please remind them.' }] };
    expect(() => coachStartFromPreview(noBrief, 'x')).toThrow(/no Labs briefing/);
    const two = { ...PREVIEW, workers: [PREVIEW.workers[0], PREVIEW.workers[0]] };
    expect(() => coachStartFromPreview(two, 'x')).toThrow(/exactly one worker/);
  });
});

describe('the carve-out: mobile sends only to ACE’s own test user', () => {
  it('resolves the ConnectID username from HQ by the +7426 phone', () => {
    expect(resolveAceTestUsername(HQ_USERS, '+74260000101')).toBe('1277adbd0ceea89e367d');
  });

  it('refuses a phone outside the demo range, and an unknown or ambiguous one', () => {
    expect(() => resolveAceTestUsername(HQ_USERS, '+917406815026')).toThrow(CoachCaptureRefusal);
    expect(() => resolveAceTestUsername(HQ_USERS, '+74269999999')).toThrow(/found 0/);
    const dup = [...HQ_USERS, { username: 'other@x', phone_numbers: ['+7 426 000 0101'] }];
    expect(() => resolveAceTestUsername(dup, '+74260000101')).toThrow(/found 2/);
    expect(() => resolveAceTestUsername(HQ_USERS, '')).toThrow(CoachCaptureRefusal);
  });

  it('refuses any recipient other than the test user — a real worker, staff, or empty', () => {
    expect(() => assertAceTestRecipient('cr_g02', '1277adbd0ceea89e367d')).toThrow(/only send one to its own test user/);
    expect(() => assertAceTestRecipient('hhodutbvaehuxnsbjr53', '1277adbd0ceea89e367d')).toThrow(CoachCaptureRefusal);
    expect(() => assertAceTestRecipient('', '1277adbd0ceea89e367d')).toThrow(CoachCaptureRefusal);
    expect(() => assertAceTestRecipient('anything', '')).toThrow(/unresolved/);
    expect(() => assertAceTestRecipient('1277adbd0ceea89e367d', '1277adbd0ceea89e367d')).not.toThrow();
  });

  it('mobileCommitArgs refuses a preview whose deliver_to is not the test user, or not a QA redirect', () => {
    const toWorker = { ...PREVIEW, arguments: { ...PREVIEW.arguments, deliver_to: 'cr_g02' } };
    expect(() => mobileCommitArgs(toWorker, '1277adbd0ceea89e367d')).toThrow(CoachCaptureRefusal);
    const noRedirect = { ...PREVIEW, arguments: { bot: PREVIEW.arguments.bot }, qa_redirect: false };
    expect(() => mobileCommitArgs(noRedirect, '1277adbd0ceea89e367d')).toThrow(CoachCaptureRefusal);
    const noConfirm = { ...PREVIEW, confirm: undefined };
    expect(() => mobileCommitArgs(noConfirm, '1277adbd0ceea89e367d')).toThrow(/confirm/);
  });
});

describe('topicsFromBriefing', () => {
  it('reads the Labs topic line into a findOverstatements topic', () => {
    expect(topicsFromBriefing(PREVIEW.workers[0].prompt)).toEqual([
      { key: 'CL_X1', label: 'Off-site visits', band: 'red', numerator: 31, denominator: 73, value: 42 },
    ]);
  });
});

describe('replyStartPattern', () => {
  it('takes the first words of the first line, regex-escaped', () => {
    expect(replyStartPattern("Good, let's get into it — there are (two) things.\n\nThe first...")).toBe(
      "Good, let's get into it —",
    );
    expect(replyStartPattern('Is that 31? Yes.', 3)).toBe('Is that 31\\?');
  });
});

describe('personas', () => {
  it('each persona is a short scripted worker side', () => {
    for (const turns of Object.values(PERSONA_TURNS)) {
      expect(turns.length).toBeGreaterThanOrEqual(3);
      for (const t of turns) expect(t.split(/\s+/).length).toBeLessThanOrEqual(25);
    }
  });
});
