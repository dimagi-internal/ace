/**
 * Tests for `lib/contact-domain-drift.ts`.
 *
 * Fixture: the two `spark-facilitator/20260828-0703` responses (second deep
 * run, chatbot published v4, 2026-09-02 transcript) that gave the ACE contact
 * as `ace@dimagi.com` where the knowledge base holds `ace@dimagi-ai.com`.
 * Sentences are quoted verbatim from
 * `5-ocs/ocs-chatbot-qa_transcript-deep.md`.
 *
 * These two were the ONLY Fails in a 68-prompt suite that scored 8.5 overall,
 * so they alone are why the `--deep` gate did not clear (ace#1935). The other
 * 37 occurrences of the address in the same suite were correct, which is what
 * makes this a drift rather than a missing value.
 */
import { describe, it, expect } from 'vitest';
import {
  detectContactDomainDrift,
  applyContactDomainDriftClamp,
  formatContactDomainDriftReport,
  CONTACT_DRIFT_CEILING,
  CONTACT_DRIFT_MARKER,
  type ScannableEntry,
} from '../../lib/contact-domain-drift.js';

const CANONICAL = ['ace@dimagi-ai.com'];

/** Verbatim from the 20260828-0703 second deep transcript. */
const OPP_37 =
  'If you cannot reach your supervisor, the ACE admin group contact is: **ace@dimagi.com**';
const OPP_56 =
  'Escalate the account and device question to the Dimagi programme team before anything else is tried. The right contact for this pilot is: **ace@dimagi.com**';

/** Verbatim from the same suite — the 37 that were right. */
const CORRECT =
  'Contact the Dimagi ACE programme team at **ace@dimagi-ai.com**. Use this for issues that go beyond coaching.';

describe('detectContactDomainDrift — the 20260828-0703 fixture', () => {
  it('flags both real drift responses', () => {
    for (const text of [OPP_37, OPP_56]) {
      expect(detectContactDomainDrift(text, CANONICAL)).toEqual([
        { found: 'ace@dimagi.com', expected: 'ace@dimagi-ai.com' },
      ]);
    }
  });

  it('does not flag the canonical address', () => {
    expect(detectContactDomainDrift(CORRECT, CANONICAL)).toEqual([]);
  });

  it('does not flag an unrelated third-party address', () => {
    const text = 'Use the Reserve Bank of Malawi, or write to enquiries@rbm.mw for the rate.';
    expect(detectContactDomainDrift(text, CANONICAL)).toEqual([]);
  });

  it('is case-insensitive on both local-part and domain', () => {
    expect(detectContactDomainDrift('Write to ACE@Dimagi.COM.', CANONICAL)).toEqual([
      { found: 'ACE@Dimagi.COM', expected: 'ace@dimagi-ai.com' },
    ]);
  });

  it('reports a drifted address once even when repeated', () => {
    const text = 'Mail ace@dimagi.com. If that bounces, try ace@dimagi.com again.';
    expect(detectContactDomainDrift(text, CANONICAL)).toHaveLength(1);
  });

  it('flags a subdomain near-miss, which reads as plausible to a human', () => {
    expect(detectContactDomainDrift('Write to ace@mail.dimagi-ai.com.', CANONICAL)).toEqual([
      { found: 'ace@mail.dimagi-ai.com', expected: 'ace@dimagi-ai.com' },
    ]);
  });

  it('treats a local-part legitimately on two canonical domains as no drift', () => {
    const canonical = ['ace@dimagi-ai.com', 'ace@dimagi.org'];
    expect(detectContactDomainDrift('Write to ace@dimagi.org.', canonical)).toEqual([]);
    expect(detectContactDomainDrift('Write to ace@dimagi.com.', canonical)).toEqual([
      { found: 'ace@dimagi.com', expected: 'ace@dimagi-ai.com' },
    ]);
  });

  it('returns nothing for empty text or an empty canonical set', () => {
    expect(detectContactDomainDrift('', CANONICAL)).toEqual([]);
    expect(detectContactDomainDrift(OPP_37, [])).toEqual([]);
  });

  it('ignores malformed canonical entries rather than throwing', () => {
    expect(detectContactDomainDrift(OPP_37, ['', 'not-an-address', 'ace@dimagi-ai.com'])).toEqual([
      { found: 'ace@dimagi.com', expected: 'ace@dimagi-ai.com' },
    ]);
  });
});

describe('applyContactDomainDriftClamp', () => {
  /** The two entries at the scores the rubric gave them before the clamp. */
  const entries: ScannableEntry[] = [
    { ref: 'opp-37', score: 8.5, verdict: 'pass', response_content: OPP_37 },
    { ref: 'opp-38', score: 8.5, verdict: 'pass', response_content: CORRECT },
    { ref: 'opp-56', score: 8.5, verdict: 'pass', response_content: OPP_56 },
  ];

  it('clamps both drifted entries to fail and leaves the correct one alone', () => {
    const { entries: out, drifts } = applyContactDomainDriftClamp(entries, CANONICAL);

    expect(out.map((e) => [e.ref, e.score, e.verdict])).toEqual([
      ['opp-37', CONTACT_DRIFT_CEILING, 'fail'],
      ['opp-38', 8.5, 'pass'],
      ['opp-56', CONTACT_DRIFT_CEILING, 'fail'],
    ]);
    expect(drifts.map((d) => d.ref)).toEqual(['opp-37', 'opp-56']);
  });

  it('is what turns a zero-Fail suite into a gated one', () => {
    // The regression this exists to prevent: without the clamp the suite
    // reports no Fails and `--deep` reads as clearance for Phase 9.
    expect(entries.filter((e) => e.verdict === 'fail')).toHaveLength(0);
    const { entries: out } = applyContactDomainDriftClamp(entries, CANONICAL);
    expect(out.filter((e) => e.verdict === 'fail')).toHaveLength(2);
  });

  it('records the before/after on each drift', () => {
    const { drifts } = applyContactDomainDriftClamp(entries, CANONICAL);
    expect(drifts[0]).toMatchObject({
      ref: 'opp-37',
      found: 'ace@dimagi.com',
      expected: 'ace@dimagi-ai.com',
      scoreBefore: 8.5,
      scoreAfter: CONTACT_DRIFT_CEILING,
      verdictBefore: 'pass',
      verdictAfter: 'fail',
    });
  });

  it('appends a marker naming the wrong address and the right one', () => {
    const { entries: out } = applyContactDomainDriftClamp(entries, CANONICAL);
    const surfaced = out[0].auto_surfaced as string[];
    expect(surfaced).toHaveLength(1);
    expect(surfaced[0]).toContain(CONTACT_DRIFT_MARKER);
    expect(surfaced[0]).toContain('ace@dimagi.com');
    expect(surfaced[0]).toContain('ace@dimagi-ai.com');
  });

  it('preserves existing auto_surfaced lines', () => {
    const withMarkers: ScannableEntry[] = [
      { ref: 'opp-37', score: 8.5, auto_surfaced: ['[PLATFORM] empty cited_files'], response_content: OPP_37 },
    ];
    const { entries: out } = applyContactDomainDriftClamp(withMarkers, CANONICAL);
    expect(out[0].auto_surfaced).toHaveLength(2);
    expect((out[0].auto_surfaced as string[])[0]).toBe('[PLATFORM] empty cited_files');
  });

  it('does not mutate the inputs', () => {
    const original: ScannableEntry[] = [{ ref: 'opp-37', score: 8.5, verdict: 'pass', response_content: OPP_37 }];
    applyContactDomainDriftClamp(original, CANONICAL);
    expect(original[0].score).toBe(8.5);
    expect(original[0].verdict).toBe('pass');
    expect(original[0].auto_surfaced).toBeUndefined();
  });

  it('is idempotent — a second pass adds no marker and lowers no score', () => {
    const once = applyContactDomainDriftClamp(entries, CANONICAL);
    const twice = applyContactDomainDriftClamp(once.entries as ScannableEntry[], CANONICAL);
    expect(twice.entries[0].score).toBe(CONTACT_DRIFT_CEILING);
    expect(twice.entries[0].auto_surfaced).toHaveLength(1);
  });

  it('never raises a score that is already below the ceiling', () => {
    const low: ScannableEntry[] = [{ ref: 'opp-37', score: 1.0, verdict: 'fail', response_content: OPP_37 }];
    const { entries: out } = applyContactDomainDriftClamp(low, CANONICAL);
    expect(out[0].score).toBe(1.0);
  });

  it('handles an entry with no response_content', () => {
    const bare: ScannableEntry[] = [{ ref: 'opp-1', score: 9.0, verdict: 'pass' }];
    const { entries: out, drifts } = applyContactDomainDriftClamp(bare, CANONICAL);
    expect(out[0].score).toBe(9.0);
    expect(drifts).toEqual([]);
  });
});

describe('formatContactDomainDriftReport', () => {
  it('says so plainly when nothing drifted', () => {
    const clean = applyContactDomainDriftClamp(
      [{ ref: 'opp-38', score: 8.5, response_content: CORRECT }],
      CANONICAL,
    );
    expect(formatContactDomainDriftReport(clean)).toContain('none');
  });

  it('names each clamp and flags two-or-more as systemic', () => {
    const result = applyContactDomainDriftClamp(
      [
        { ref: 'opp-37', score: 8.5, verdict: 'pass', response_content: OPP_37 },
        { ref: 'opp-56', score: 8.5, verdict: 'pass', response_content: OPP_56 },
      ],
      CANONICAL,
    );
    const report = formatContactDomainDriftReport(result);
    expect(report).toContain('opp-37');
    expect(report).toContain('opp-56');
    expect(report).toContain('ace@dimagi.com');
    expect(report).toContain('[WARN]');
    expect(report).toContain('systemic');
  });
});
