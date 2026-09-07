/**
 * dimagi-internal/ace#1896 — what ACE has TOLD people, checked against what has
 * since shipped.
 *
 * ## Why the fixtures are verbatim
 *
 * Every classifier here is a regex over prose a person wrote, and the one thing
 * that makes such a rule trustworthy is that it was calibrated against the real
 * sentences rather than sentences invented to match it. So the two load-bearing
 * fixtures are the actual bodies from Gmail thread `19f86579142e6ba5`, decoded
 * from `gog gmail thread get 19f86579142e6ba5 -a ace@dimagi-ai.com --client
 * canopy --full -j`:
 *
 *   - `1a025772ae8df982` (2026-08-21T17:56Z) — the stale claim. POSITIVE control.
 *   - `1a063761004267e4` (2026-09-02) — the correction that was eventually sent
 *     by hand. NEGATIVE control, and the one that proves the probe retires
 *     itself instead of nagging about work already done.
 *
 * ace#1549 closed COMPLETED at 2026-08-21T18:39:27Z — 43 minutes after the
 * first message. Eleven days elapsed.
 */

import { describe, expect, it } from 'vitest';
import {
  classifySentence,
  extractCounterpartRefs,
  findStaleCounterpartClaims,
  isAcknowledgedInThread,
  isAuthoredBy,
  splitSentences,
  uniqueSlugs,
  type IssueStatus,
  type OutboundMessage,
} from '../../lib/counterpart-asks.js';

const MAILBOX = 'ace@dimagi-ai.com';
const THREAD = '19f86579142e6ba5';

/** Verbatim, from the sent message. */
const STALE_CLAIM =
  'One honest limitation your question exposed: because a decision edit is matched by the ' +
  "decision's id, a model change that retires that decision quietly stops your edit applying " +
  '— and the view still shows it as "pending next run," which reads as "this will bind" when ' +
  'it never will. There is no state for "retired." I filed that as ace#1549 and deliberately ' +
  'left it unfixed: telling "retired by a design change" apart from "not raised because the ' +
  'run stopped early" needs a rule I would rather get right than guess at.';

/** Verbatim, from the correction sent 12 days later. */
const CORRECTION =
  'A correction that matters more\n\n' +
  'On 21 August I told you that a decision override whose id gets retired by a design change ' +
  'still renders as "pending next run", that I had filed it as ace#1549, and that I had ' +
  'deliberately left it unfixed because the discriminator needed a rule I did not want to ' +
  'guess at.\n\n' +
  'That was true when I wrote it and stopped being true forty-three minutes later. It was ' +
  'fixed and closed the same afternoon.';

const claimMsg: OutboundMessage = {
  id: '1a025772ae8df982',
  threadId: THREAD,
  from: 'ace@dimagi-ai.com',
  to: ['Sophie Feintuch <sfeintuch@dimagi-associate.com>'.replace(/.*<|>/g, '')],
  cc: ['jjackson@dimagi.com', 'nlesh@dimagi.com'],
  date: '2026-08-21T17:56:01.000Z',
  subject: 'simple povgraduate component',
  body: STALE_CLAIM,
};

const correctionMsg: OutboundMessage = {
  id: '1a063761004267e4',
  threadId: THREAD,
  from: 'ace@dimagi-ai.com',
  to: ['sfeintuch@dimagi-associate.com'],
  cc: [],
  date: '2026-09-02T18:00:00.000Z',
  subject: 'Re: simple povgraduate component',
  body: CORRECTION,
};

const inboundMsg: OutboundMessage = {
  id: '1a025a5c37474753',
  threadId: THREAD,
  from: 'Sophie Feintuch <sfeintuch@dimagi-associate.com>',
  to: [MAILBOX],
  date: '2026-08-21T18:10:00.000Z',
  body: 'So ace#1549 means I should sequence the component PDDs to avoid overrides entirely?',
};

const CLOSED_1549: IssueStatus = {
  slug: 'ace#1549',
  state: 'CLOSED',
  closedAt: '2026-08-21T18:39:27Z',
  reason: 'COMPLETED',
  title: 'A decision override retired by a design change still renders as pending',
};

const NOW = Date.parse('2026-09-01T17:56:01.000Z'); // 11 days after the claim

describe('reference extraction', () => {
  it('finds the citation in the REAL sent message, with the sentence verbatim', () => {
    const refs = extractCounterpartRefs(claimMsg);
    expect(refs).toHaveLength(1);
    expect(refs[0].slug).toBe('ace#1549');
    expect(refs[0].number).toBe(1549);
    expect(refs[0].claimsLiveConstraint).toBe(true);
    expect(refs[0].sentence).toContain('deliberately left it unfixed');
    expect(refs[0].threadId).toBe(THREAD);
  });

  it('carries the recipient set — who now believes the claim', () => {
    expect(extractCounterpartRefs(claimMsg)[0].recipients).toEqual([
      'jjackson@dimagi.com',
      'nlesh@dimagi.com',
      'sfeintuch@dimagi-associate.com',
    ]);
  });

  it('accepts owner-qualified forms and normalises them to one slug', () => {
    const refs = extractCounterpartRefs({
      ...claimMsg,
      body: 'There is no state for that; I filed dimagi-internal/ace#1549 and jjackson/ace#1549.',
    });
    expect(uniqueSlugs(refs)).toEqual(['ace#1549']);
  });

  it('does not match an issue number embedded in another word', () => {
    expect(
      extractCounterpartRefs({ ...claimMsg, body: 'There is no grace#1549 period here.' }),
    ).toEqual([]);
  });

  it('sorts slugs numerically, not lexically', () => {
    const refs = extractCounterpartRefs({
      ...claimMsg,
      body: 'There is no way to do it: ace#90, ace#1000 and ace#9 are all open.',
    });
    expect(uniqueSlugs(refs)).toEqual(['ace#9', 'ace#90', 'ace#1000']);
  });
});

describe('classifying a sentence as a live limitation', () => {
  it("classifies the real claim's own sentence as live", () => {
    const sentence = splitSentences(STALE_CLAIM).find((s) => s.includes('ace#1549'))!;
    expect(classifySentence(sentence)).toBe(true);
  });

  it('classifies a plain mention as NOT a live-limitation claim', () => {
    expect(classifySentence('The full write-up is on ace#1549 if you want the detail.')).toBe(
      false,
    );
    expect(classifySentence('I have opened ace#1549 to track your comment.')).toBe(false);
  });

  it('a historical marker in the same sentence wins over a live one', () => {
    expect(
      classifySentence('There is no state for that today, but ace#1549 was fixed last week.'),
    ).toBe(false);
  });

  /**
   * The register test. `lib/upstream-asks.ts`'s vocabulary is documentation
   * English ("blocked on", "removal criteria"); a letter to a person is not
   * written that way, and running the doc markers over correspondence misses
   * exactly the sentence this module exists to catch.
   */
  it('reads the register of correspondence, not of documentation', () => {
    for (const s of [
      'I filed that as ace#1549 and deliberately left it unfixed.',
      'There is no state for "retired" — ace#1549.',
      'ace#1549 is a known limitation for now.',
      'I cannot tell the two apart yet; that is ace#1549.',
      'We are blocked on ace#1549 for that.',
    ]) {
      expect(classifySentence(s), s).toBe(true);
    }
  });
});

describe('sentence splitting', () => {
  it('splits a wrapped paragraph so one claim is one unit of judgement', () => {
    // A real body wraps a paragraph into ONE very long line, so a line-based
    // window would swallow the whole paragraph as context.
    expect(STALE_CLAIM.split('\n')).toHaveLength(1);
    expect(splitSentences(STALE_CLAIM).length).toBeGreaterThan(1);
  });

  it('does not treat a colon as a sentence end', () => {
    // "…left it unfixed: telling X apart from Y needs a rule…" is ONE claim.
    // Splitting there severed the assertion from its subject.
    const s = splitSentences(STALE_CLAIM).find((x) => x.includes('ace#1549'))!;
    expect(s).toContain('left it unfixed: telling');
  });

  it('allows a closing quote after terminal punctuation', () => {
    // `no state for "retired."` — the period is followed by a quote, so a bare
    // /(?<=[.!?])\s+/ never split there and ran two sentences together.
    expect(splitSentences('There is no state for "retired." I filed ace#1549.')).toHaveLength(2);
  });
});

describe('the in-message acknowledgement window', () => {
  /**
   * The case the LIVE run caught, and the reason the in-message window is
   * SENTENCES rather than the whole body. A correction opens by restating what
   * it corrects — "…that I had filed it as ace#1549, and that I had deliberately
   * left it unfixed…" — and only the next sentence says it stopped being true.
   */
  it('the REAL correction does not re-raise the claim it is correcting', () => {
    const refs = extractCounterpartRefs(correctionMsg);
    expect(refs).not.toHaveLength(0);
    for (const r of refs) expect(r.claimsLiveConstraint).toBe(false);
  });

  /**
   * A whole-body window was tried and is WRONG. Measured against the real
   * 5,257-character send, it suppressed the claim outright: a long letter
   * discusses several things and any one may legitimately be in the past tense.
   */
  it('an unrelated past-tense passage elsewhere in a long letter does not suppress', () => {
    // Six sentences — comfortably past ACK_WINDOW_SENTENCES.
    const filler = 'Everything else is unchanged. '.repeat(6);
    const body =
      'I filed that as ace#1549 and deliberately left it unfixed. ' +
      filler +
      // Far outside the window, and about something else entirely.
      'Separately, the deck no longer renders the old cover, which was fixed last week.';
    const refs = extractCounterpartRefs({ ...claimMsg, body });
    expect(refs[0].claimsLiveConstraint).toBe(true);
  });

  it('a retraction within the window suppresses', () => {
    const body =
      'I filed that as ace#1549 and deliberately left it unfixed. ' +
      'That was true when I wrote it and stopped being true the same afternoon.';
    expect(extractCounterpartRefs({ ...claimMsg, body })[0].claimsLiveConstraint).toBe(false);
  });
});

describe('thread acknowledgement retires the finding', () => {
  it('the REAL correction suppresses the REAL claim', () => {
    const ref = extractCounterpartRefs(claimMsg)[0];
    expect(isAcknowledgedInThread(ref, [claimMsg, correctionMsg], MAILBOX)).toBe(true);
  });

  it('an EARLIER message cannot acknowledge a later claim', () => {
    const ref = extractCounterpartRefs(claimMsg)[0];
    const earlier = { ...correctionMsg, id: 'earlier', date: '2026-08-01T00:00:00.000Z' };
    expect(isAcknowledgedInThread(ref, [claimMsg, earlier], MAILBOX)).toBe(false);
  });

  it("a COUNTERPART saying it is fixed does not count — only ACE's own correction does", () => {
    const ref = extractCounterpartRefs(claimMsg)[0];
    const theirs = { ...correctionMsg, id: 'theirs', from: 'sfeintuch@dimagi-associate.com' };
    expect(isAcknowledgedInThread(ref, [claimMsg, theirs], MAILBOX)).toBe(false);
  });

  it('a correction that omits the issue number does NOT suppress — deliberately', () => {
    const ref = extractCounterpartRefs(claimMsg)[0];
    const vague = {
      ...correctionMsg,
      id: 'vague',
      body: 'That limitation was fixed, so it is no longer a hazard.',
    };
    expect(isAcknowledgedInThread(ref, [claimMsg, vague], MAILBOX)).toBe(false);
  });

  it('a correction on a DIFFERENT thread does not suppress', () => {
    const ref = extractCounterpartRefs(claimMsg)[0];
    const elsewhere = { ...correctionMsg, id: 'other', threadId: 'other-thread' };
    expect(isAcknowledgedInThread(ref, [claimMsg, elsewhere], MAILBOX)).toBe(false);
  });
});

describe('the report', () => {
  it('reports the canonical instance, with the days uncorrected', () => {
    const refs = extractCounterpartRefs(claimMsg);
    const out = findStaleCounterpartClaims(refs, [CLOSED_1549], [claimMsg, inboundMsg], MAILBOX, NOW);
    expect(out).toHaveLength(1);
    expect(out[0].slug).toBe('ace#1549');
    expect(out[0].reason).toBe('COMPLETED');
    // From the CLOSE (2026-08-21T18:39Z), not from the send — the claim was
    // true when written. 2026-09-01T17:56Z is ~11 days later.
    expect(out[0].daysUncorrected).toBe(11);
    expect(out[0].assertedAfterClose).toBe(false);
    expect(out[0].citations[0].messageId).toBe('1a025772ae8df982');
  });

  it('is EMPTY once the correction has been sent', () => {
    const refs = [claimMsg, correctionMsg].flatMap(extractCounterpartRefs);
    expect(
      findStaleCounterpartClaims(refs, [CLOSED_1549], [claimMsg, correctionMsg], MAILBOX, NOW),
    ).toEqual([]);
  });

  it('an OPEN issue is not a finding, however it is phrased', () => {
    const refs = extractCounterpartRefs(claimMsg);
    const open: IssueStatus = { slug: 'ace#1549', state: 'OPEN' };
    expect(findStaleCounterpartClaims(refs, [open], [claimMsg], MAILBOX, NOW)).toEqual([]);
  });

  it('an UNRESOLVABLE issue is not a finding — a 404 must never read as OPEN or CLOSED', () => {
    const refs = extractCounterpartRefs(claimMsg);
    const unknown: IssueStatus = { slug: 'ace#1549', state: 'UNKNOWN' };
    expect(findStaleCounterpartClaims(refs, [unknown], [claimMsg], MAILBOX, NOW)).toEqual([]);
  });

  it('includes a `not planned` close — the constraint got MORE permanent, not less', () => {
    const refs = extractCounterpartRefs(claimMsg);
    const notPlanned: IssueStatus = { ...CLOSED_1549, reason: 'NOT_PLANNED' };
    const out = findStaleCounterpartClaims(refs, [notPlanned], [claimMsg], MAILBOX, NOW);
    expect(out).toHaveLength(1);
    expect(out[0].reason).toBe('NOT_PLANNED');
  });

  it('flags a claim asserted AFTER the issue had already closed', () => {
    const late = { ...claimMsg, id: 'late', date: '2026-08-25T00:00:00.000Z' };
    const out = findStaleCounterpartClaims(
      extractCounterpartRefs(late),
      [CLOSED_1549],
      [late],
      MAILBOX,
      NOW,
    );
    expect(out[0].assertedAfterClose).toBe(true);
  });

  it('never reports a citation ACE did not write', () => {
    // The counterpart quoted the issue back. That is not ACE telling anyone
    // anything, and the probe filters on authorship before extraction.
    expect(isAuthoredBy(inboundMsg, MAILBOX)).toBe(false);
    expect(isAuthoredBy(claimMsg, MAILBOX)).toBe(true);
  });
});
