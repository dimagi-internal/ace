/**
 * Tests for `lib/internal-artifact-leak.ts`.
 *
 * Fixture: the seven `spark-facilitator/20260828-0703` responses that routed a
 * field supervisor to `00-program-contacts.md` — a knowledge-base file they
 * cannot open — instead of giving `ace@dimagi-ai.com`. Sentences are quoted
 * verbatim from `5-ocs/ocs-chatbot-qa_transcript-deep.md`.
 */
import { describe, it, expect } from 'vitest';
import {
  detectInternalArtifactNames,
  applyInternalArtifactLeakCap,
  formatInternalArtifactLeakReport,
  INTERNAL_ARTIFACT_LEAK_CEILING,
} from '../../lib/internal-artifact-leak.js';

/** Verbatim from the 20260828-0703 deep transcript. */
const REAL_LEAKS = [
  'For escalation contacts, refer to `00-program-contacts.md` in the programme documentation. If you do not have that document, ask your supervisor to escalate to the ACE admin group.',
  'The contact is in `00-program-contacts.md` in the opportunity knowledge base; if you do not have that file to hand, use ace@dimagi.com.',
  'If you are not sure who to contact, the programme contacts for this pilot are listed in `00-program-contacts.md`. I can look those up for you if needed.',
  'For escalation contacts, see `00-program-contacts.md` in the programme knowledge base.',
  'The contacts for escalation are in `00-program-contacts.md` in the programme materials — check that file for the correct name and address to use.',
  'For urgent escalation beyond your supervisor, the Dimagi ACE programme team contact is in `00-program-contacts.md` — I can look that up if you need it.',
  'Reach out via the contacts in `00-program-contacts.md` in the opportunity knowledge base.',
];

describe('detectInternalArtifactNames — the 20260828-0703 fixture', () => {
  it('flags every one of the seven real leak responses', () => {
    for (const text of REAL_LEAKS) {
      expect(detectInternalArtifactNames(text)).toEqual(['00-program-contacts.md']);
    }
  });

  it('finds the name whether backticked, quoted, or bare', () => {
    expect(detectInternalArtifactNames('see `00-program-contacts.md` now')).toEqual([
      '00-program-contacts.md',
    ]);
    expect(detectInternalArtifactNames('see "00-program-contacts.md" now')).toEqual([
      '00-program-contacts.md',
    ]);
    expect(detectInternalArtifactNames('see 00-program-contacts.md now')).toEqual([
      '00-program-contacts.md',
    ]);
  });

  it('flags config paths and run-state keys too', () => {
    expect(detectInternalArtifactNames('the address comes from config/agent.json')).toEqual([
      'config/agent.json',
    ]);
    expect(detectInternalArtifactNames('check run_state.yaml for the opportunity')).toEqual([
      'run_state.yaml',
    ]);
  });

  it('de-duplicates repeated mentions, preserving first-seen order', () => {
    expect(
      detectInternalArtifactNames(
        'see 00-program-contacts.md, then run_state.yaml, then 00-PROGRAM-CONTACTS.MD again',
      ),
    ).toEqual(['00-program-contacts.md', 'run_state.yaml']);
  });

  it('does NOT flag user-facing document formats a facilitator may actually hold', () => {
    expect(detectInternalArtifactNames('your Facilitator Handbook.pdf covers this')).toEqual([]);
    expect(detectInternalArtifactNames('the training deck.pptx has the slide')).toEqual([]);
    expect(detectInternalArtifactNames('the roster.xlsx from your Network Manager')).toEqual([]);
  });

  it('does not fire on ordinary prose, addresses or version numbers', () => {
    expect(detectInternalArtifactNames('Escalate to ace@dimagi-ai.com.')).toEqual([]);
    expect(detectInternalArtifactNames('CommCare 2.63.2 is the supported build.')).toEqual([]);
    expect(detectInternalArtifactNames('Submit the form. Then sync.')).toEqual([]);
  });
});

describe('applyInternalArtifactLeakCap', () => {
  it('caps a response that names a KB file, however good it otherwise reads', () => {
    const result = applyInternalArtifactLeakCap([
      { ref: 'opp-52', score: 8.4, verdict: 'pass', response_content: REAL_LEAKS[0] },
      { ref: 'opp-57', score: 8.5, verdict: 'pass', response_content: REAL_LEAKS[6] },
      {
        ref: 'opp-33',
        score: 9.1,
        verdict: 'pass',
        response_content: 'Escalate to ace@dimagi-ai.com if your supervisor cannot resolve it.',
      },
    ]);
    expect(result.entries.map((e) => [e.ref, e.score, e.verdict])).toEqual([
      ['opp-52', INTERNAL_ARTIFACT_LEAK_CEILING, 'warn'],
      ['opp-57', INTERNAL_ARTIFACT_LEAK_CEILING, 'warn'],
      ['opp-33', 9.1, 'pass'],
    ]);
    expect(result.leaks).toHaveLength(2);
  });

  it('never raises a score that is already below the ceiling', () => {
    const result = applyInternalArtifactLeakCap([
      { ref: 'opp-20', score: 4.2, verdict: 'warn', response_content: REAL_LEAKS[1] },
    ]);
    expect(result.entries[0]).toMatchObject({ score: 4.2, verdict: 'warn' });
    expect(result.leaks[0]).toMatchObject({ scoreBefore: 4.2, scoreAfter: 4.2 });
  });

  it('does not mutate the inputs', () => {
    const entries = [
      { ref: 'opp-52', score: 8.4, verdict: 'pass' as const, response_content: REAL_LEAKS[0] },
    ];
    applyInternalArtifactLeakCap(entries);
    expect(entries[0].score).toBe(8.4);
  });

  it('reports the systemic case the way the run experienced it', () => {
    const result = applyInternalArtifactLeakCap(
      REAL_LEAKS.map((response_content, i) => ({
        ref: `opp-${20 + i}`,
        score: 8.0,
        verdict: 'pass' as const,
        response_content,
      })),
    );
    expect(result.leaks).toHaveLength(7);
    const text = formatInternalArtifactLeakReport(result);
    expect(text).toContain('7 response(s) named an internal artifact');
    expect(text).toContain('[WARN] systemic');
    expect(text).toContain('skills/ocs-agent-setup');
  });

  it('is a no-op on a clean suite', () => {
    const result = applyInternalArtifactLeakCap([
      { ref: 'opp-1', score: 9.0, verdict: 'pass', response_content: 'Email ace@dimagi-ai.com.' },
    ]);
    expect(result.leaks).toEqual([]);
    expect(formatInternalArtifactLeakReport(result)).toContain('no response names');
  });
});
