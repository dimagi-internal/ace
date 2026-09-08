/**
 * dimagi-internal/ace#1346 — Phase 7 wrote "0 constraint violations, all
 * hand-checked" into run_state for a dataset that violated four.
 *
 * Run spark-facilitator/20260813-2126. Auditing the actual `user_visits.json`
 * against the PDD's own "Data-quality constraints (required-for-credit and
 * bounds)" table found, in 253 records:
 *
 *   251  people-counts emitted as FLOATS (hh_represented: 45.33,
 *        male_attendance: 41.305, members_with_disability: 1.311) across 11
 *        fields — the PDD requires integers, bounds 0-500
 *   242  savings amounts not whole Malawi Kwacha (amount_saved_mwk: 65993.1)
 *    34  no_meeting_reason populated where meeting_conducted = yes — the form
 *        skips that branch entirely
 *    22  meeting_conducted = no carrying full attendance blocks: a meeting that
 *        did not happen, with 41 attendees
 *    17  meeting_conducted = no with no reason at all
 *
 * Plus a structural one the PDD states as a premise ("20 CBFs across 20 Malawi
 * FCAP communities, 1 CBF per community"): 190 distinct (facilitator,
 * community) pairs across 20 facilitators, which makes the PDD's dedup key
 * (community + meeting date) meaningless.
 *
 * Root cause: the labs manifest is a DISTRIBUTION language. It draws every
 * field independently, integers are enforced only when the HQ form schema
 * types the question Int, and conditional blocks are populated regardless of
 * branch. Nothing checks the result, and `demo-data-setup-qa` passed — it
 * checks that dashboard URLs are live run deep-links, not that the records are
 * legal.
 *
 * Why blocks-e2e: a funder-facing dashboard rendering "45.33 households
 * represented" and "a meeting that did not happen, attended by 41 people" is
 * the first thing a partner M&E director checks, and it discredits the
 * arithmetic the whole demo exists to make credible.
 */
import { describe, it, expect } from 'vitest';
import {
  auditDataset,
  formatConstraintReport,
  scrubOffBranchFields,
  parseJsonPreservingBigInts,
  stringifyJsonPreservingBigInts,
} from '../../lib/dataset-constraints.js';

const SPEC = {
  integerFields: [
    { field: 'hh_represented', min: 0, max: 500 },
    { field: 'male_attendance', min: 0, max: 500 },
    { field: 'members_with_disability', min: 0, max: 500 },
  ],
  wholeCurrencyFields: ['amount_saved_mwk'],
  conditionalFields: [
    { field: 'no_meeting_reason', requiredWhen: { field: 'meeting_conducted', equals: 'no' } },
  ],
  crossFieldRules: [
    { lhs: 'members_with_disability', op: '<=' as const, rhs: 'male_attendance' },
  ],
  uniquePairs: [{ fields: ['facilitator', 'community'], perFirst: 1 }],
};

const CLEAN = [
  { facilitator: 'f1', community: 'c1', meeting_conducted: 'yes', hh_represented: 45,
    male_attendance: 41, members_with_disability: 1, amount_saved_mwk: 65993 },
  { facilitator: 'f2', community: 'c2', meeting_conducted: 'no', no_meeting_reason: 'rain',
    hh_represented: 0, male_attendance: 0, members_with_disability: 0, amount_saved_mwk: 0 },
];

describe('auditDataset (#1346)', () => {
  it('passes a legal set', () => {
    const r = auditDataset(CLEAN, SPEC);
    expect(r.ok).toBe(true);
    expect(r.total).toBe(2);
    expect(r.violations).toEqual([]);
  });

  it('catches the float people-counts — the 251-of-253 case', () => {
    const r = auditDataset([{ ...CLEAN[0], hh_represented: 45.33, male_attendance: 41.305 }], SPEC);
    expect(r.ok).toBe(false);
    const kinds = r.violations.map((v) => v.kind);
    expect(kinds).toContain('non-integer');
    expect(r.violations.find((v) => v.kind === 'non-integer')!.count).toBe(1);
  });

  it('catches an out-of-bounds count separately from a non-integer one', () => {
    const r = auditDataset([{ ...CLEAN[0], hh_represented: 900 }], SPEC);
    expect(r.violations.map((v) => v.kind)).toContain('out-of-bounds');
  });

  it('catches fractional currency', () => {
    const r = auditDataset([{ ...CLEAN[0], amount_saved_mwk: 65993.1 }], SPEC);
    expect(r.violations.map((v) => v.kind)).toContain('fractional-currency');
  });

  it('catches a conditional field populated on the wrong branch — the form skips it entirely', () => {
    const r = auditDataset([{ ...CLEAN[0], no_meeting_reason: 'rain' }], SPEC);
    expect(r.violations.map((v) => v.kind)).toContain('conditional-off-branch');
  });

  it('catches a conditional field MISSING on the branch that requires it', () => {
    const r = auditDataset([{ ...CLEAN[1], no_meeting_reason: undefined }], SPEC);
    expect(r.violations.map((v) => v.kind)).toContain('conditional-missing');
  });

  // ── ace#1693: an AND of gates, evaluated as an AND ────────────────────
  //
  // `specFromDeliverApp` emits one spec per gate, so a question under a group
  // `relevant` AND its own `relevant` yields two entries. Checking
  // `conditional-missing` per gate made that field unsatisfiable in both
  // directions. The gates below are the two this run's deliver app
  // (28464041b4d54511af2989f4349fce30 v14, opp 2219) declares for
  // /data/consent_and_photograph/meeting_photo, verbatim.
  const PHOTO_SPEC = {
    conditionalFields: [
      { field: 'meeting_photo', requiredWhen: { field: 'meeting_conducted', equals: 'yes' } },
      { field: 'meeting_photo', requiredWhen: { field: 'consent_given', equals: 'yes' } },
    ],
  };

  it('does not demand a multi-gated field when only ONE of its gates holds (#1693)', () => {
    // The meeting happened; the meeting DECLINED the photograph. The form skips
    // meeting_photo — this is the only legal record shape for that case.
    const r = auditDataset([{ meeting_conducted: 'yes', consent_given: 'no' }], PHOTO_SPEC);
    expect(r.violations.map((v) => v.kind)).not.toContain('conditional-missing');
    expect(r.ok).toBe(true);
  });

  it('still flags a multi-gated field populated off ANY of its gates (#1693)', () => {
    const r = auditDataset(
      [{ meeting_conducted: 'yes', consent_given: 'no', meeting_photo: 'p.jpg' }],
      PHOTO_SPEC,
    );
    expect(r.violations.map((v) => v.kind)).toContain('conditional-off-branch');
  });

  it('still demands a multi-gated field when EVERY gate holds (#1693)', () => {
    const r = auditDataset([{ meeting_conducted: 'yes', consent_given: 'yes' }], PHOTO_SPEC);
    const missing = r.violations.find((v) => v.kind === 'conditional-missing');
    expect(missing).toBeDefined();
    expect(missing!.count).toBe(1);
    expect(missing!.detail).toContain('meeting_conducted = "yes" and consent_given = "yes"');
  });

  it('catches a cross-field rule violation', () => {
    const r = auditDataset([{ ...CLEAN[0], members_with_disability: 99, male_attendance: 5 }], SPEC);
    expect(r.violations.map((v) => v.kind)).toContain('cross-field');
  });

  it('catches the roaming-facilitator premise break', () => {
    const roaming = [
      { ...CLEAN[0], facilitator: 'f1', community: 'c1' },
      { ...CLEAN[0], facilitator: 'f1', community: 'c2' },
    ];
    const r = auditDataset(roaming, SPEC);
    const v = r.violations.find((x) => x.kind === 'pair-cardinality');
    expect(v).toBeDefined();
    expect(v!.detail).toMatch(/f1/);
  });

  it('counts violations per class so "0 violations" becomes a MEASURED number', () => {
    const r = auditDataset(
      [{ ...CLEAN[0], hh_represented: 1.5 }, { ...CLEAN[0], hh_represented: 2.5 }],
      SPEC,
    );
    expect(r.violations.find((v) => v.kind === 'non-integer')!.count).toBe(2);
    expect(formatConstraintReport(r)).toMatch(/2 of 2/);
  });

  it('reports the clean case as a measured zero, not an assertion', () => {
    expect(formatConstraintReport(auditDataset(CLEAN, SPEC))).toMatch(/0 violation/i);
    expect(formatConstraintReport(auditDataset(CLEAN, SPEC))).toMatch(/2 record/);
  });

  it('is inert on an empty spec rather than inventing rules', () => {
    expect(auditDataset(CLEAN, {}).ok).toBe(true);
  });
});

describe('scrubOffBranchFields preserves 60-bit fixture ids (ace#2249)', () => {
  // Real value from bednet-check-2-visit/20260907-1126 (labs opp 10058). It
  // exceeds Number.MAX_SAFE_INTEGER (9007199254740991), so it cannot even be
  // WRITTEN as a JS number literal without already losing precision — the
  // only lossless representations are `bigint` or `string`. The labs
  // generator mints `visit.id` as exactly this shape of integer on purpose
  // (connect_labs/labs/synthetic/generator/fixtures/engine.py).
  const REAL_ID = 1151582223307334984n;

  it('does not corrupt an already-lossless id passed through the deep copy', () => {
    // Pre-fix, `scrubOffBranchFields`'s internal
    // `JSON.parse(JSON.stringify(records))` deep copy throws
    // "Do not know how to serialize a BigInt" the instant a record carries a
    // bigint id — so a caller that got the read side right (bigint-safe
    // parse) still cannot get a scrubbed set back.
    const rows = [{ id: REAL_ID, consent_confirmed: 'no', slept_under_net: 'yes' }];
    const { records } = scrubOffBranchFields(rows, [
      {
        field: 'slept_under_net',
        path: '/data/net_check/slept_under_net',
        requiredWhen: { field: 'consent_confirmed', equals: 'yes' },
      },
    ]);
    expect(records[0].id).toBe(REAL_ID);
    // The scrub itself still ran correctly — the id survives WHILE the
    // off-branch field is still cleared.
    expect(records[0].slept_under_net).toBeUndefined();
  });

  it('round-trips the id byte-identical through read text -> parse -> scrub -> serialize -> write text', () => {
    // This is the actual demo-data-setup § 2c.2 workflow: a labs fixture is
    // read as TEXT off Drive (drive_read_file), parsed into records, scrubbed,
    // then serialized back to TEXT for the write-back (drive_update_file). A
    // plain `JSON.parse`/`JSON.stringify` at either end rounds the literal
    // before any application code — including `scrubOffBranchFields` — ever
    // sees the real digits.
    const rawFixtureText =
      '[{"id":1151582223307334984,"consent_confirmed":"no","slept_under_net":"yes"}]';

    const records = parseJsonPreservingBigInts(rawFixtureText) as Array<Record<string, unknown>>;
    expect(records[0].id).toBe(REAL_ID);

    const { records: scrubbed } = scrubOffBranchFields(records, [
      {
        field: 'slept_under_net',
        path: '/data/net_check/slept_under_net',
        requiredWhen: { field: 'consent_confirmed', equals: 'yes' },
      },
    ]);

    const writtenBackText = stringifyJsonPreservingBigInts(scrubbed);
    expect(writtenBackText).toContain('"id":1151582223307334984');
    expect(writtenBackText).not.toContain('1151582223307334900'); // the corrupted value #2249 measured
  });

  it('demonstrates the corruption class a plain JSON round-trip still has, for contrast', () => {
    const rawFixtureText = '[{"id":1151582223307334984}]';
    const lossy = JSON.parse(rawFixtureText);
    expect(JSON.stringify(lossy)).not.toContain('1151582223307334984'); // already rounded on the way IN
  });
});
