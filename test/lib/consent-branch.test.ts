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
import {
  checkConsentBranchCompleteness,
  flattenEffectiveRelevance,
  type BuiltField,
} from '../../lib/consent-branch.js';

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

/**
 * dimagi-internal/ace#2415 — the gate is on the GROUP, and the helper could not
 * see it.
 *
 * `checkConsentBranchCompleteness` read ONE flat `relevant` string per field. In
 * a Nova blueprint the consent gate almost always sits on the enclosing group,
 * not on each child — so run over the blueprint as BOTH callers instruct
 * (`_app-component-library.md § consent-script-floor`,
 * `pdd-to-deliver-app-eval § conditional_logic_match`), every question inside a
 * correctly gated group came back `ungated-required-after-consent`, which
 * hard-gates `conditional_logic_match` to <= 3 and fails the suite.
 *
 * Live: `poverty-graduation/20260915-1518`, Deliver app
 * `6d77c3ac-eea6-4997-bd1e-a93be6d194ff`. The targeting form
 * (`481b98c0-2da1-4e54-9bab-0eb29516f97c`) produced **14 false findings on a
 * correct build**; the one field that passed did so by accident, because it
 * happened to carry the gate on itself. The delivery form
 * (`f7c04392-5c4c-4ab0-ae5e-181ea116cfe9`) added 2 more through a second
 * mechanism — its groups gate on a hidden calculate over the consent answer, so
 * a purely syntactic match misses them even after ancestor relevance is
 * propagated.
 *
 * Every `BuiltField` in the 13 cases above is FLAT, which is why the suite could
 * not see any of it. These fixtures are trees.
 */
describe('checkConsentBranchCompleteness — ancestor relevance (ace#2415)', () => {
  // A reduced but faithful copy of the targeting form's shape: the gate on
  // `g_identity` / `g_zone`, required children carrying none of their own, one
  // field (`roster_complete`) that happens to carry it itself, and
  // `gps_onsite_confirm` as a genuinely UNGATED required field — the control
  // that keeps this suite from passing merely because the check got disabled.
  const targetingPdd = [
    { id: 'consent', required: true },
    { id: 'hh_head_name', required: true },
    { id: 'respondent_name', required: true },
    { id: 'roster_complete', required: true },
    { id: 'i1_zone', required: true },
    { id: 'gps_onsite_confirm', required: true },
  ];
  const gate = "#form/g_consent/consent = 'yes'";
  const targetingBuilt: BuiltField[] = [
    {
      id: 'g_consent',
      kind: 'group',
      children: [{ id: 'consent', kind: 'single_select', required: 'true()' }],
    },
    {
      id: 'g_identity',
      kind: 'group',
      relevant: gate,
      children: [
        { id: 'hh_head_name', kind: 'text', required: 'true()' },
        { id: 'respondent_name', kind: 'text', required: 'true()' },
        // Two container levels below the gate, and carrying the gate itself as
        // well — the effective relevance is the conjunction of both.
        {
          id: 'roster',
          kind: 'repeat',
          children: [
            { id: 'roster_complete', kind: 'single_select', required: 'true()', relevant: gate },
          ],
        },
      ],
    },
    {
      id: 'g_zone',
      kind: 'group',
      relevant: gate,
      children: [{ id: 'i1_zone', kind: 'single_select', required: 'true()' }],
    },
    { id: 'gps_onsite_confirm', kind: 'single_select', required: 'true()' },
  ];
  const gatedFields = ['hh_head_name', 'respondent_name', 'roster_complete', 'i1_zone'];

  it('a required field gated ONLY by its parent group reads as GATED, not ungated', () => {
    const r = checkConsentBranchCompleteness(targetingBuilt, targetingPdd, {
      consentField: 'consent',
      disclosedInMemo: gatedFields,
    });
    for (const id of gatedFields) {
      const f = r.findings.find((x) => x.field === id);
      expect(f, `${id} must be reported`).toBeDefined();
      expect(f!.kind, `${id} is inside a consent-gated group`).toBe('disclosed-consent-gate');
    }
    // Pre-fix, every one of these came back as the hard-gate kind.
    expect(
      r.findings.filter((f) => f.kind === 'ungated-required-after-consent').map((f) => f.field),
    ).toEqual(['gps_onsite_confirm']);
  });

  it('a genuinely ungated required field after consent STILL reads as ungated', () => {
    // The fix must not simply stop firing. `gps_onsite_confirm` sits outside
    // every gated group, and it alone must fail the report.
    const r = checkConsentBranchCompleteness(targetingBuilt, targetingPdd, {
      consentField: 'consent',
      disclosedInMemo: gatedFields,
    });
    expect(r.pass).toBe(false);
    const ungated = r.findings.filter((f) => f.kind === 'ungated-required-after-consent');
    expect(ungated).toHaveLength(1);
    expect(ungated[0].field).toBe('gps_onsite_confirm');
    expect(ungated[0].detail).toMatch(/invented/i);
  });

  it('the correct build passes once the memo discloses it — the 14-false-findings case', () => {
    const correct = targetingBuilt.filter((f) => f.id !== 'gps_onsite_confirm');
    const r = checkConsentBranchCompleteness(correct, targetingPdd, {
      consentField: 'consent',
      disclosedInMemo: gatedFields,
    });
    expect(r.findings.map((f) => f.kind)).toEqual(Array(4).fill('disclosed-consent-gate'));
    expect(r.pass).toBe(true);
  });

  it('inherits through MORE than one container level', () => {
    const deep: BuiltField[] = [
      { id: 'consent_confirmed', required: true },
      {
        id: 'outer',
        kind: 'group',
        relevant: "/data/consent_confirmed = 'yes'",
        children: [
          {
            id: 'middle',
            kind: 'section',
            children: [
              { id: 'inner', kind: 'repeat', children: [{ id: 'net_hanging', required: true }] },
            ],
          },
        ],
      },
    ];
    const r = checkConsentBranchCompleteness(deep, pdd, {
      consentField: 'consent_confirmed',
      disclosedInMemo: ['net_hanging'],
    });
    expect(r.pass).toBe(true);
    expect(r.findings).toEqual([
      expect.objectContaining({ field: 'net_hanging', kind: 'disclosed-consent-gate' }),
    ]);
  });

  it('an ancestor gate on something OTHER than consent is still an undisclosed narrowing', () => {
    // Inheritance must not launder an unrelated gate into a consent gate.
    const r = checkConsentBranchCompleteness(
      [
        { id: 'consent_confirmed', required: true },
        {
          id: 'g_big_hh',
          kind: 'group',
          relevant: '/data/hh_size > 3',
          children: [{ id: 'net_hanging', required: true }],
        },
      ],
      pdd,
      { consentField: 'consent_confirmed' },
    );
    expect(r.pass).toBe(false);
    expect(r.findings).toEqual([
      expect.objectContaining({ field: 'net_hanging', kind: 'undisclosed-narrowing' }),
    ]);
  });

  it('resolves ONE hop of hidden-calculate indirection (the delivery-form shape)', () => {
    // `g_transfer` gates on `enrollment_outcome`, a hidden calculate over
    // `participation_consent`: gated on consent in every sense that matters,
    // and invisible to a purely syntactic match.
    const deliveryPdd = [
      { id: 'participation_consent', required: true },
      { id: 'transfer_method', required: true },
    ];
    const built: BuiltField[] = [
      { id: 'participation_consent', kind: 'single_select', required: 'true()' },
      {
        id: 'enrollment_outcome',
        kind: 'hidden',
        calculate: "if(#form/participation_consent = 'yes', 'enrolled', 'declined')",
      },
      {
        id: 'g_transfer',
        kind: 'group',
        relevant: "#form/enrollment_outcome = 'enrolled'",
        children: [{ id: 'transfer_method', kind: 'single_select', required: 'true()' }],
      },
    ];
    const r = checkConsentBranchCompleteness(built, deliveryPdd, {
      consentField: 'participation_consent',
      disclosedInMemo: ['transfer_method'],
    });
    expect(r.pass).toBe(true);
    expect(r.findings).toEqual([
      expect.objectContaining({ field: 'transfer_method', kind: 'disclosed-consent-gate' }),
    ]);
  });

  it('a calculate that does NOT reach consent is not laundered into a consent gate', () => {
    const r = checkConsentBranchCompleteness(
      [
        { id: 'consent_confirmed', required: true },
        { id: 'hh_is_large', kind: 'hidden', calculate: '/data/hh_size > 3' },
        {
          id: 'g',
          kind: 'group',
          relevant: "/data/hh_is_large = 'yes'",
          children: [{ id: 'net_hanging', required: true }],
        },
      ],
      pdd,
      { consentField: 'consent_confirmed' },
    );
    expect(r.findings).toEqual([
      expect.objectContaining({ field: 'net_hanging', kind: 'undisclosed-narrowing' }),
    ]);
  });

  it("reads Nova's `true()` / `false()` strings as requiredness", () => {
    const r = checkConsentBranchCompleteness(
      [
        { id: 'consent_confirmed', required: 'true()' },
        { id: 'slept_under_net', required: 'true()' },
        { id: 'net_hanging', required: 'false()' },
      ],
      pdd,
      { consentField: 'consent_confirmed' },
    );
    // `false()` is not required, so only the genuinely-required field is in the
    // collision. Read as a plain truthy string it produced a second, false one.
    expect(r.findings.map((f) => f.field)).toEqual(['slept_under_net']);
  });

  it("reads Nova's structured `{parts:[…]}` relevance as well as a plain string", () => {
    const r = checkConsentBranchCompleteness(
      [
        { id: 'consent_confirmed', required: true },
        {
          id: 'g',
          kind: 'group',
          relevant: { parts: [{ text: "#form/consent_confirmed = 'yes'" }] },
          children: [{ id: 'net_hanging', required: true }],
        },
      ],
      pdd,
      { consentField: 'consent_confirmed', disclosedInMemo: ['net_hanging'] },
    );
    expect(r.pass).toBe(true);
    expect(r.findings[0].kind).toBe('disclosed-consent-gate');
  });

  it('scoping (ace#1509) still applies to fields reached through a group', () => {
    const r = checkConsentBranchCompleteness(targetingBuilt, targetingPdd, {
      consentField: 'consent',
      governs: ['hh_head_name'],
      disclosedInMemo: ['hh_head_name'],
    });
    expect(r.pass).toBe(true);
    expect(r.findings.map((f) => f.field)).toEqual(['hh_head_name']);
  });
});

describe('flattenEffectiveRelevance (ace#2415)', () => {
  it('conjoins ancestor and own relevance, outermost first', () => {
    const leaves = flattenEffectiveRelevance([
      {
        id: 'outer',
        kind: 'group',
        relevant: 'A',
        children: [
          {
            id: 'inner',
            kind: 'group',
            relevant: 'B',
            children: [{ id: 'q', required: true, relevant: 'C' }],
          },
        ],
      },
    ]);
    expect(leaves.map((f) => f.id)).toEqual(['q']);
    expect(leaves[0].relevant).toBe('(A) and (B) and (C)');
  });

  it('leaves a single expression unwrapped, and an ungated leaf undefined', () => {
    const leaves = flattenEffectiveRelevance([
      { id: 'g', kind: 'group', relevant: 'A', children: [{ id: 'q', required: true }] },
      { id: 'free', required: true },
    ]);
    expect(leaves.map((f) => [f.id, f.relevant])).toEqual([
      ['q', 'A'],
      ['free', undefined],
    ]);
  });

  it('is a no-op on an already-flat list — the pre-ace#2415 input shape still works', () => {
    const flat: BuiltField[] = [{ id: 'q', required: true, relevant: "/data/c = 'yes'" }];
    expect(flattenEffectiveRelevance(flat)).toEqual([
      { id: 'q', required: true, relevant: "/data/c = 'yes'", children: undefined },
    ]);
  });

  it('does not emit containers as answerable leaves', () => {
    const leaves = flattenEffectiveRelevance([
      {
        id: 'g',
        kind: 'group',
        relevant: 'A',
        children: [
          { id: 'a', required: true },
          { id: 'b', required: true },
        ],
      },
    ]);
    expect(leaves.map((f) => f.id)).toEqual(['a', 'b']);
  });
});
