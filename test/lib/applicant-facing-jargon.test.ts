/**
 * Tests for `lib/applicant-facing-jargon.ts`.
 *
 * Every anchor here is VERBATIM from the live record of solicitation 19201
 * (`bednet-check-2-visit/20260907-1126`, labs program 231), re-fetched via
 * `get_solicitation` — not hand-written samples.
 *
 * The positive control is Q6's `framing`, the one real leak. The negative
 * controls are the other seven framings from the SAME record, composed by the
 * same skill in the same run. It matters that they pass: a check that flagged
 * them too would be worthless, because it would fire on every solicitation ACE
 * has ever written and get suppressed within a run.
 *
 * ace#2264.
 */
import { describe, it, expect } from 'vitest';
import {
  scanText,
  scanSolicitationProse,
  formatJargonScan,
} from '../../lib/applicant-facing-jargon.js';

// ── The defect this exists for, verbatim from the live record ───────────────
const Q6_FRAMING =
  'This is the archetype-specific question and it separates responders who ' +
  'have read the design from those who have not. A strong answer engages with ' +
  'the operational reality that a worker carries an open case list, must ' +
  'return to the right household after at least three days, cannot hand a ' +
  'case to a colleague, and must not re-register a household already on their ' +
  'list.';

// ── Negative controls: the other seven framings from the SAME record ────────
const CLEAN_FRAMINGS: [string, string][] = [
  [
    'paired-visit-experience',
    "A strong answer names real engagements with dates, worker counts and volumes, and is specific about whether the work involved RETURNING to the same household or person — a one-shot survey is a different operational problem from a tracked two-visit cycle. Honest 'we have done adjacent work but not this exact shape' answers score better than vague claims of broad experience.",
  ],
  [
    'flw-recruitment-and-training',
    'We are looking for a concrete recruitment pipeline and a realistic account of device access — not an assertion that workers are available. A strong answer names where workers come from, how long recruitment takes, who owns their Android device, and how you will get every worker through a seven-item assessment at a 100 percent pass bar.',
  ],
  [
    'operating-area-and-language',
    'No geography is fixed by this programme — you propose it, and this is the single most consequential thing you tell us. A strong answer names a real operating area you already work in, states the working language your workers actually use with households, flags whether English (currently configured) is workable or needs to change, and names any local permission or data-protection requirement that would apply.',
  ],
  [
    'timeline-to-field',
    "A strong answer is a week-by-week schedule anchored to the award date, treats Learn completion as a hard gate before delivery, and shows that the responder has understood that the first three delivery days produce registrations only. Generic 'we can start immediately' answers score low.",
  ],
  [
    'supervision-and-exception-review',
    'A strong answer names a supervisor-to-FLW ratio, says who personally runs the weekly exception review, and describes a concrete coaching escalation. We are especially interested in how you would detect a worker recording consent that was not given — the one integrity rule with no tolerance band.',
  ],
  [
    'rate-proposal',
    'We want a number and a justification, not agreement with our band. The indicative band is USD 10.00-24.00 per verified follow-up worker-day and it was sized without any geography in view, so a well-argued rate outside it is a legitimate answer. A strong response shows the responder has understood that registration is unpaid and that the first days of an engagement earn nothing.',
  ],
  [
    'budget-breakdown',
    'A strong answer separates worker compensation from the costs a partner absorbs — supervision, transport, devices, data, reporting time — and states which of them your proposed per-day rate is expected to cover. Vague single-line totals score low.',
  ],
];

describe('the shipped Q6 framing — the leak this exists for', () => {
  it('flags `archetype` in the live Q6 framing', () => {
    const hits = scanText('questions[5].framing', Q6_FRAMING);
    expect(hits).toHaveLength(1);
    expect(hits[0].match).toBe('archetype');
    expect(hits[0].field).toBe('questions[5].framing');
  });

  it('quotes surrounding prose so an operator can see what to rewrite', () => {
    const [hit] = scanText('questions[5].framing', Q6_FRAMING);
    expect(hit.context).toContain('separates responders');
  });
});

describe('the other seven framings from the same record — negative controls', () => {
  it.each(CLEAN_FRAMINGS)('%s is clean', (id, framing) => {
    expect(scanText(`questions.${id}.framing`, framing)).toEqual([]);
  });
});

describe('false positives a naive denylist would produce', () => {
  // `ACE` as a substring is the one that would have made this check unusable.
  it.each([
    'Work is conducted at the workplace of the partner organisation.',
    'The net is hung over the sleeping space in the household.',
    'Observe the surface on which the net is mounted.',
    'The partner provides an interface to its own reporting system.',
  ])('does not flag ACE inside an ordinary word: %s', (text) => {
    expect(scanText('scope_of_work', text)).toEqual([]);
  });

  it('does not flag an org or place name that merely contains an internal term', () => {
    // `nova` is deliberately absent from the denylist for exactly this reason —
    // see the "deliberately NOT on the list" note in the helper.
    expect(scanText('description', 'The district of Novara was not selected.')).toEqual([]);
    expect(scanText('description', 'Nova Health Partners would deliver the work.')).toEqual([]);
  });

  it('does not flag a lowercase metric-shaped string in a model number', () => {
    expect(scanText('description', 'Workers use a m4 handset or better.')).toEqual([]);
  });

  it('flags the capitalised bare metric id that a PDD actually uses', () => {
    const hits = scanText('description', 'Scored against M3 in the design.');
    expect(hits).toHaveLength(1);
    expect(hits[0].match).toBe('M3');
  });
});

describe('product vocabulary a respondent must see — the real false positives', () => {
  // Every string here is VERBATIM from 19201's live `scope_of_work`. The first
  // draft of the denylist flagged all three, passed every hand-written fixture,
  // and only failed when pointed at the real record. They are pinned here so a
  // future widening of the token list cannot silently re-break them.
  it.each([
    'Connect opportunity, verification rules and payment unit setup | Lead',
    'data is transmitted over TLS and stored encrypted at rest in CommCare HQ. Access is role-based',
    '**Storage location:** United States (CommCare HQ US cluster). **Provisional**',
    'The awarded rate becomes the configured Connect payment-unit amount.',
  ])('does not flag product vocabulary: %s', (text) => {
    expect(scanText('scope_of_work', text)).toEqual([]);
  });

  it('still flags the snake_case identifier form, which is internal', () => {
    const hits = scanText('description', 'The payment_unit is configured by Dimagi.');
    expect(hits.map((h) => h.match.toLowerCase())).toContain('payment_unit');
  });
});

describe('tokens with non-word edges still match', () => {
  it('flags a slash-prefixed command', () => {
    const hits = scanText('description', 'Re-run /ace:run to regenerate.');
    expect(hits.map((h) => h.match)).toContain('/ace:');
  });

  it('flags a dotted filename', () => {
    const hits = scanText('description', 'See decisions.yaml for the rationale.');
    expect(hits.map((h) => h.match.toLowerCase())).toContain('decisions.yaml');
  });
});

describe('scanning a whole composed payload', () => {
  it('is clean for a payload with no internal vocabulary', () => {
    const result = scanSolicitationProse({
      description: 'We are looking for a local implementing organisation.',
      scope_of_work: 'The partner conducts paired household visits.',
      questions: CLEAN_FRAMINGS.map(([id, framing]) => ({ id, text: 'Q', framing })),
    });
    expect(result.clean).toBe(true);
    expect(result.hits).toEqual([]);
    expect(formatJargonScan(result)).toBe('');
  });

  it('locates the offending field by id, not just by index', () => {
    const result = scanSolicitationProse({
      description: 'We are looking for a local implementing organisation.',
      questions: [
        { id: 'paired-visit-experience', text: 'Q1', framing: CLEAN_FRAMINGS[0][1] },
        { id: 'case-integrity-and-ownership', text: 'Q6', framing: Q6_FRAMING },
      ],
    });
    expect(result.clean).toBe(false);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].field).toBe('questions[1] (case-integrity-and-ownership).framing');
  });

  it('scans evaluation criteria, which also render to respondents', () => {
    const result = scanSolicitationProse({
      evaluation_criteria: [
        {
          id: 'payment-economics-and-budget',
          description: 'Whether the budget separates worker pay from partner-absorbed costs.',
          scoring_guide: 'Strong (8-10): engages with the archetype constraints.',
        },
      ],
    });
    expect(result.clean).toBe(false);
    expect(result.hits[0].field).toBe(
      'evaluation_criteria[0] (payment-economics-and-budget).scoring_guide',
    );
  });

  it('reports which fields it actually scanned, so coverage is provable', () => {
    const result = scanSolicitationProse({
      description: 'x',
      scope_of_work: 'y',
      questions: [{ id: 'q1', text: 'a', framing: 'b' }],
    });
    expect(result.fieldsScanned).toEqual([
      'description',
      'scope_of_work',
      'questions[0] (q1).text',
      'questions[0] (q1).framing',
    ]);
  });

  it('does not invent fields that are absent', () => {
    const result = scanSolicitationProse({ description: 'x' });
    expect(result.fieldsScanned).toEqual(['description']);
    expect(result.clean).toBe(true);
  });
});

describe('the operator-facing message', () => {
  it('names the field, the token and the context, and says not to suppress it', () => {
    const result = scanSolicitationProse({
      questions: [{ id: 'case-integrity-and-ownership', framing: Q6_FRAMING }],
    });
    const out = formatJargonScan(result);
    expect(out).toContain('[BLOCKER]');
    expect(out).toContain('case-integrity-and-ownership');
    expect(out).toContain('archetype');
    expect(out).toContain('do not suppress');
  });
});
