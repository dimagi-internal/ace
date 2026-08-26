/**
 * dimagi-internal/ace#1326 — element (c) of the consent-script floor ("you
 * may stop at any time, INCLUDING after being asked") and an unconditional
 * required-field rule collide on the withdrawal branch, and nothing owned the
 * interaction.
 *
 * A PDD that fires `consent-script-floor` normally also states its
 * observation fields as unconditionally required — that is the natural way to
 * write a data-completeness rule. On the withdrawal branch both cannot hold:
 *
 *  - Resolve toward the literal completeness rule (keep `required`, no
 *    `relevant`): the worker who has just read aloud "you can stop at any
 *    time" must then interrogate the household that just withdrew, or put
 *    SOMETHING in the fields to close the form. Since the fields cannot be
 *    legitimately answered, what lands is INVENTED DATA — in exactly the
 *    fields the programme's primary metric is computed from.
 *  - Resolve toward consent (add `relevant: <consent> = 'yes'`): correct, but
 *    it silently changes an observable program fact and puts blank-observation
 *    records into a denominator the PDD defined with no exclusion.
 *
 * Both were silently shippable. `conditional_logic_match` deducts for a
 * MISSING or INVERTED relevance; an ADDED one that neuters a stated
 * requirement was not a class it scored. `field_answerability`'s reachability
 * check passes both shapes (the gate is answered in an earlier group either
 * way).
 *
 * Live: bednet-check-2-visit/20260814-0856, whose primary metric is "share of
 * followed-up households with slept_under_net = yes AND net_hanging = yes"
 * over closed household cases, with NO denominator exclusion for withdrawn
 * consent — and which targets >= 90% consent_confirmed = yes, so up to ~10%
 * of follow-ups can carry the bias.
 */
import { describe, it, expect } from 'vitest';
import { checkConsentBranchCompleteness } from '../../lib/consent-branch.js';

const pdd = [
  { id: 'consent_confirmed', required: true },
  { id: 'slept_under_net', required: true },
  { id: 'net_hanging', required: true },
];

describe('checkConsentBranchCompleteness (#1326)', () => {
  it('flags the R5-literal resolution: required observations with no consent gate', () => {
    const r = checkConsentBranchCompleteness(
      [
        { id: 'consent_confirmed', required: true },
        { id: 'slept_under_net', required: true },
        { id: 'net_hanging', required: true },
      ],
      pdd,
      { consentField: 'consent_confirmed' },
    );
    expect(r.pass).toBe(false);
    expect(r.findings.map((f) => f.kind)).toEqual([
      'ungated-required-after-consent',
      'ungated-required-after-consent',
    ]);
    expect(r.findings[0].detail).toMatch(/invented|fabricat/i);
  });

  it('accepts the consent resolution when the memo discloses it', () => {
    const r = checkConsentBranchCompleteness(
      [
        { id: 'consent_confirmed', required: true },
        { id: 'slept_under_net', required: true, relevant: "/data/consent_confirmed = 'yes'" },
        { id: 'net_hanging', required: true, relevant: "/data/consent_confirmed = 'yes'" },
      ],
      pdd,
      { consentField: 'consent_confirmed', disclosedInMemo: ['slept_under_net', 'net_hanging'] },
    );
    expect(r.pass).toBe(true);
    expect(r.findings.every((f) => f.kind === 'disclosed-consent-gate')).toBe(true);
    expect(r.findings[0].detail, 'must carry the denominator consequence').toMatch(/denominator/i);
  });

  it('flags the SAME correct build when the memo is silent — the deviation must be disclosed', () => {
    const r = checkConsentBranchCompleteness(
      [
        { id: 'consent_confirmed', required: true },
        { id: 'slept_under_net', required: true, relevant: "/data/consent_confirmed = 'yes'" },
      ],
      pdd,
      { consentField: 'consent_confirmed' },
    );
    expect(r.pass).toBe(false);
    expect(r.findings[0].kind).toBe('undisclosed-consent-gate');
  });

  it('flags an added relevance that has nothing to do with consent as an undisclosed narrowing', () => {
    const r = checkConsentBranchCompleteness(
      [{ id: 'net_hanging', required: true, relevant: "/data/hh_size > 3" }],
      pdd,
      { consentField: 'consent_confirmed' },
    );
    expect(r.pass).toBe(false);
    expect(r.findings[0].kind).toBe('undisclosed-narrowing');
  });

  it('says nothing when the PDD itself specified the relevance', () => {
    const r = checkConsentBranchCompleteness(
      [{ id: 'net_hanging', required: true, relevant: "/data/consent_confirmed = 'yes'" }],
      [{ id: 'net_hanging', required: true, relevant: "consent_confirmed = yes" }],
      { consentField: 'consent_confirmed' },
    );
    expect(r.pass).toBe(true);
    expect(r.findings).toEqual([]);
  });

  it('is inert when no consent field exists — it must not fire on every app', () => {
    const r = checkConsentBranchCompleteness(
      [{ id: 'net_hanging', required: true }],
      [{ id: 'net_hanging', required: true }],
      {},
    );
    expect(r.pass).toBe(true);
    expect(r.findings).toEqual([]);
  });

  it('ignores optional fields — the collision is with REQUIREDNESS', () => {
    const r = checkConsentBranchCompleteness(
      [{ id: 'note', required: false }],
      [{ id: 'note', required: false }],
      { consentField: 'consent_confirmed' },
    );
    expect(r.findings).toEqual([]);
  });
});

describe('checkConsentBranchCompleteness — scoped gates (spark-facilitator/20260817-1610)', () => {
  // A consent gate does not always govern the whole instrument. On an FCAP
  // community meeting record the photo-consent announcement governs the
  // PHOTOGRAPH; the attendance and savings counts are observations of an open
  // public assembly that the PDD states explicitly has no per-beneficiary
  // consent. Run unscoped, this check flagged every unrelated required field
  // and would have hard-gated a correct build to `fail`.
  const meetingPdd = [
    { id: 'photo_consent_announced', required: true },
    { id: 'attach_a_photo_for_the_meeting', required: true },
    { id: 'male_attendance', required: true },
    { id: 'female_attendance', required: true },
    { id: 'amt_savings', required: true },
  ];
  const meetingBuilt = [
    { id: 'photo_consent_announced', required: true },
    { id: 'attach_a_photo_for_the_meeting', required: true, relevant: "/data/photo_consent_announced = 'yes'" },
    { id: 'male_attendance', required: true },
    { id: 'female_attendance', required: true },
    { id: 'amt_savings', required: true },
  ];

  it('UNSCOPED: flags every unrelated required field — the false-fail this option exists to stop', () => {
    const r = checkConsentBranchCompleteness(meetingBuilt, meetingPdd, {
      consentField: 'photo_consent_announced',
    });
    expect(r.pass).toBe(false);
    // The false-fail class: three observations of a public assembly, none of
    // which the photo-consent announcement has anything to say about.
    const ungated = r.findings.filter((f) => f.kind === 'ungated-required-after-consent');
    expect(ungated.map((f) => f.field).sort()).toEqual([
      'amt_savings',
      'female_attendance',
      'male_attendance',
    ]);
  });

  it('SCOPED: checks only the fields the gate governs', () => {
    const r = checkConsentBranchCompleteness(meetingBuilt, meetingPdd, {
      consentField: 'photo_consent_announced',
      governs: ['attach_a_photo_for_the_meeting'],
      disclosedInMemo: ['attach_a_photo_for_the_meeting'],
    });
    expect(r.pass).toBe(true);
    expect(r.findings.every((f) => f.field === 'attach_a_photo_for_the_meeting')).toBe(true);
  });

  it('SCOPED still catches a real miss INSIDE the scope', () => {
    const ungatedPhoto = meetingBuilt.map((f) =>
      f.id === 'attach_a_photo_for_the_meeting' ? { id: f.id, required: true } : f,
    );
    const r = checkConsentBranchCompleteness(ungatedPhoto, meetingPdd, {
      consentField: 'photo_consent_announced',
      governs: ['attach_a_photo_for_the_meeting'],
    });
    expect(r.pass).toBe(false);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({
      field: 'attach_a_photo_for_the_meeting',
      kind: 'ungated-required-after-consent',
    });
  });

  it('an empty governs list means unscoped — the default is not silently narrowed', () => {
    const r = checkConsentBranchCompleteness(meetingBuilt, meetingPdd, {
      consentField: 'photo_consent_announced',
      governs: [],
    });
    expect(r.pass).toBe(false);
    expect(r.findings.filter((f) => f.kind === 'ungated-required-after-consent')).toHaveLength(3);
  });
});
