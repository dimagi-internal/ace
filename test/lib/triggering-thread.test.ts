/**
 * dimagi-internal/ace#1057 — a run triggered by an email thread has no
 * structural link back to it, and no close-out step that reports completion to
 * the person waiting.
 *
 * Found by a counterpart having to chase us. Sophie Feintuch, 2026-07-29,
 * thread 19f86579142e6ba5: "Just checking if ACE is still working on this?" —
 * sent while the run she was waiting for had been running for two days and had
 * in fact completed its last phase a few hours earlier.
 *
 * Two gaps:
 *
 *  1. The triggering thread is not first-class state. `hh-poverty-targeting/
 *     20260728-0705` recorded it only inside a free-text `notes` entry
 *     ("Triggered by Jon on thread 19f86579142e6ba5"), which nothing can read
 *     reliably. The operating model already treats `thread_id` as THE routing
 *     key for inbound (email-communicator step 7 → comms-log → inbox-triage
 *     matches on it) — but that edge is inbound-only.
 *  2. No close-out obligation. The orchestrator surfaces the run-summary URL
 *     to the operator IN SESSION; if that session ends, the counterpart learns
 *     nothing.
 *
 * A prose "remember to email the requester" is exactly the class of
 * instruction that fails under load — a phase-8 halt at 13:55 and a phase-7
 * completion at 15:45 are the moments nobody is thinking about the inbox. So
 * this is a recorded field plus a close-out step that produces a DRAFTED
 * artifact, making the omission visible rather than invisible.
 *
 * Drafted, never sent: outbound stays approval-gated (review posture), so what
 * this adds is a visible parked item, not an autonomous send.
 */
import { describe, it, expect } from 'vitest';
import {
  parseTriggeredBy,
  pendingCloseoutNotice,
} from '../../lib/triggering-thread.js';

const EMAIL_TRIGGER = {
  surface: 'email',
  thread_id: '19f86579142e6ba5',
  requester: 'sfeintuch@dimagi.com',
  requested_at: '2026-07-27T14:02:00Z',
};

describe('parseTriggeredBy (#1057)', () => {
  it('accepts a well-formed email trigger', () => {
    const r = parseTriggeredBy(EMAIL_TRIGGER);
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it('accepts absence — a manual run has no trigger and must not be failed for it', () => {
    expect(parseTriggeredBy(undefined).ok).toBe(true);
    expect(parseTriggeredBy(undefined).value).toBeUndefined();
  });

  it('requires thread_id on an email trigger — the thread IS the routing key', () => {
    const r = parseTriggeredBy({ ...EMAIL_TRIGGER, thread_id: undefined });
    expect(r.ok).toBe(false);
    expect(r.issues.join(' ')).toMatch(/thread_id/);
  });

  it('does not require thread_id on a manual trigger', () => {
    expect(parseTriggeredBy({ surface: 'manual', requester: 'jon' }).ok).toBe(true);
  });

  it('rejects an unknown surface rather than passing it through', () => {
    const r = parseTriggeredBy({ ...EMAIL_TRIGGER, surface: 'carrier-pigeon' });
    expect(r.ok).toBe(false);
    expect(r.issues.join(' ')).toMatch(/surface/);
  });
});

describe('pendingCloseoutNotice (#1057)', () => {
  it('produces a parked outbound when a triggered run reaches a terminal phase', () => {
    const n = pendingCloseoutNotice({
      triggeredBy: EMAIL_TRIGGER as any,
      runId: '20260728-0705',
      opportunity: 'hh-poverty-targeting',
      terminal: true,
      summaryUrl: 'https://labs.connect.dimagi.com/ace/w/…/summary',
    });
    expect(n).not.toBeNull();
    expect(n!.threadId).toBe('19f86579142e6ba5');
    expect(n!.status).toBe('drafted');
    expect(n!.body).toMatch(/20260728-0705/);
    expect(n!.body).toMatch(/summary/i);
  });

  it('is DRAFTED, never sent — outbound stays approval-gated', () => {
    const n = pendingCloseoutNotice({
      triggeredBy: EMAIL_TRIGGER as any,
      runId: 'r', opportunity: 'o', terminal: true, summaryUrl: 'u',
    });
    expect(n!.status).toBe('drafted');
    expect(Object.keys(n!)).not.toContain('sent_at');
  });

  it('produces nothing for a run nobody is waiting on', () => {
    expect(
      pendingCloseoutNotice({ runId: 'r', opportunity: 'o', terminal: true, summaryUrl: 'u' }),
    ).toBeNull();
  });

  it('produces nothing before the run is terminal — a mid-run ping is noise', () => {
    expect(
      pendingCloseoutNotice({
        triggeredBy: EMAIL_TRIGGER as any,
        runId: 'r', opportunity: 'o', terminal: false, summaryUrl: 'u',
      }),
    ).toBeNull();
  });

  it('still drafts when the run HALTED — silence is the failure mode, not bad news', () => {
    const n = pendingCloseoutNotice({
      triggeredBy: EMAIL_TRIGGER as any,
      runId: 'r', opportunity: 'o', terminal: true, summaryUrl: 'u',
      outcome: 'halted', haltReason: 'Phase 8 awaiting LLO selection',
    });
    expect(n).not.toBeNull();
    expect(n!.body).toMatch(/Phase 8 awaiting LLO selection/);
  });
});

describe('run_state validation of triggered_by (#1057)', () => {
  it('a run with no trigger is valid — manual runs must not be failed for it', async () => {
    const { validateRunState } = await import('../../lib/run-state-validator.js');
    expect(validateRunState({ opportunity: 'o', run_id: 'r' }).valid).toBe(true);
  });

  it('a well-formed email trigger is valid', async () => {
    const { validateRunState } = await import('../../lib/run-state-validator.js');
    const r = validateRunState({ opportunity: 'o', run_id: 'r', triggered_by: EMAIL_TRIGGER });
    expect(r.valid).toBe(true);
  });

  it('an email trigger with no thread_id is an ERROR — the reply would have nowhere to go', async () => {
    const { validateRunState } = await import('../../lib/run-state-validator.js');
    const r = validateRunState({
      opportunity: 'o', run_id: 'r',
      triggered_by: { surface: 'email', requester: 'x@y.z' },
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.path === 'triggered_by')).toBe(true);
  });
});
