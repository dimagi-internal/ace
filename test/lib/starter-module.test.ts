/**
 * dimagi-internal/ace#1787 — unit tests for the identity check that can see
 * Nova's canonical starter module.
 *
 * The controls that matter here are the two live structures from
 * `bednet-check-2-visit/20260828-0629`:
 *
 *  - POSITIVE control — the Deliver app's surviving seed, verbatim from the
 *    issue's `get_app` read:
 *
 *      - Module "Survey" [uuid 81de30fd-…] [top-level menu]
 *        - Form "Survey" [uuid 473c60dc-…] (survey, 1 field)
 *          - question_1 [uuid c46ede4a-…] (text): "Question 1"
 *
 *  - NEGATIVE control — the real modules of the same app must stay clean, or
 *    the gate is a halt on every run and gets deleted within a week.
 *
 * The count-blindness property is asserted directly: the audit fires on the
 * dirty app while blueprint and CCZ form counts are EQUAL, which is the exact
 * condition under which `app-release-qa` Step 4 reported green.
 */
import { describe, it, expect } from 'vitest';
import {
  auditReleasedModules,
  isCanonicalStarterModule,
  isPlaceholderField,
} from '../../lib/starter-module.js';
import { isPass } from '../../lib/check-outcome.js';

/** The seeded module, exactly as Nova's `create_app` leaves it. */
const seededModule = {
  name: 'Survey',
  forms: [
    {
      name: 'Survey',
      declaresConnectMarker: false,
      fields: [{ name: 'question_1', label: 'Question 1', type: 'text' }],
    },
  ],
};

/** Two real Deliver modules from the same app. */
const realModules = [
  {
    name: 'Bednet Check Visit',
    forms: [
      {
        name: 'Household Visit',
        declaresConnectMarker: true,
        fields: [
          { name: 'household_id', label: 'Household ID', type: 'text' },
          { name: 'nets_observed', label: 'Nets observed', type: 'int' },
          { name: 'net_photo', label: 'Photo of net', type: 'image' },
        ],
      },
    ],
  },
  {
    name: 'Follow-up',
    forms: [
      {
        name: 'Second Visit',
        declaresConnectMarker: true,
        fields: [{ name: 'still_in_use', label: 'Still in use?', type: 'select' }],
      },
    ],
  },
];

describe('isPlaceholderField', () => {
  it('matches the seeded name and the seeded label independently', () => {
    expect(isPlaceholderField({ name: 'question_1' })).toBe(true);
    expect(isPlaceholderField({ name: 'question1' })).toBe(true);
    // Relabelling the placeholder without deleting it has still shipped it.
    expect(isPlaceholderField({ name: 'q_first', label: 'Question 1' })).toBe(true);
    expect(isPlaceholderField({ name: 'QUESTION_1' })).toBe(true);
  });

  it('does not match real fields', () => {
    expect(isPlaceholderField({ name: 'question_2', label: 'Question 2' })).toBe(false);
    expect(isPlaceholderField({ name: 'household_id', label: 'Household ID' })).toBe(false);
    // A survey question that legitimately mentions the word.
    expect(isPlaceholderField({ name: 'q1_nets', label: 'Question 1 of 6: how many nets?' })).toBe(
      false,
    );
  });
});

describe('isCanonicalStarterModule', () => {
  it('flags the live seeded module from bednet-check-2-visit/20260828-0629', () => {
    expect(isCanonicalStarterModule(seededModule)).toBe(true);
  });

  it('flags it after a rename — the name is not the signature', () => {
    // The obvious "no module named Survey" check is defeated by one rename.
    // The seeded FIELD is what survives.
    expect(
      isCanonicalStarterModule({
        name: 'Data Collection',
        forms: [{ name: 'Intake', fields: [{ name: 'question_1', label: 'Question 1' }] }],
      }),
    ).toBe(true);
  });

  it('does not flag real modules', () => {
    for (const m of realModules) expect(isCanonicalStarterModule(m)).toBe(false);
  });

  it('does not flag a real module that merely contains a question_1 among others', () => {
    // Cardinality is what keeps this from firing on a legitimate KAP form.
    expect(
      isCanonicalStarterModule({
        name: 'Knowledge survey',
        forms: [
          {
            name: 'KAP',
            fields: [
              { name: 'question_1', label: 'Question 1' },
              { name: 'question_2', label: 'Question 2' },
            ],
          },
        ],
      }),
    ).toBe(false);
  });

  it('does not flag a single-field module whose one field is real', () => {
    expect(
      isCanonicalStarterModule({
        name: 'Consent',
        forms: [{ name: 'Consent', fields: [{ name: 'consent_given', label: 'Consent given?' }] }],
      }),
    ).toBe(false);
  });
});

describe('auditReleasedModules — the gate (#1787)', () => {
  /** Narrow to the `checked` branch, failing loudly if the check did not run. */
  function ran(out: ReturnType<typeof auditReleasedModules>) {
    if (out.status !== 'checked') {
      throw new Error(`expected a checked outcome, got unable: ${out.reason}`);
    }
    return out;
  }

  it('POSITIVE control: fails the dirty app, and names the module and form', () => {
    const out = ran(
      auditReleasedModules({
        released: [...realModules, seededModule],
        declared: ['Bednet Check Visit', 'Follow-up'],
      }),
    );

    expect(out.ok).toBe(false);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toMatchObject({
      kind: 'starter-module',
      tier: 'blocker',
      module: 'Survey',
      form: 'Survey',
    });
  });

  it('NEGATIVE control: passes the same app with the seed removed', () => {
    const out = ran(
      auditReleasedModules({
        released: realModules,
        declared: ['Bednet Check Visit', 'Follow-up'],
      }),
    );

    expect(isPass(out)).toBe(true);
    expect(out.findings).toEqual([]);
    expect(out.declared_structure).toBe('compared');
  });

  it('fires while the form COUNTS agree — the property Step 4 was blind to', () => {
    // The starter module is present in the CCZ *and* in the Nova blueprint, so
    // form-count equality holds on the dirty app. That is not a near miss; it
    // is the defining case a count cannot distinguish.
    const dirty = [...realModules, seededModule];
    const blueprintFormCount = dirty.reduce((n, m) => n + (m.forms?.length ?? 0), 0);
    const cczFormCount = blueprintFormCount; // equal, exactly as observed

    expect(cczFormCount).toBe(blueprintFormCount);
    expect(isPass(auditReleasedModules({ released: dirty }))).toBe(false);
  });

  it('flags a module the brief never declared, even with no placeholder field', () => {
    const out = ran(
      auditReleasedModules({
        released: [
          ...realModules,
          { name: 'Scratch', forms: [{ name: 'Scratch', fields: [{ name: 'a' }, { name: 'b' }] }] },
        ],
        declared: ['Bednet Check Visit', 'Follow-up'],
      }),
    );

    expect(out.ok).toBe(false);
    expect(out.findings.filter((f) => f.kind === 'undeclared-module').map((f) => f.module)).toEqual([
      'Scratch',
    ]);
  });

  it('compares declared names case- and whitespace-insensitively', () => {
    const out = ran(
      auditReleasedModules({
        released: realModules,
        declared: ['bednet  check visit', 'FOLLOW-UP'],
      }),
    );
    expect(out.findings).toEqual([]);
  });

  it('SKIPS the undeclared half when no declared list is available — and says so', () => {
    // A missing input must not manufacture a BLOCKER on every module. The
    // signature check still stands, and `declared_structure` keeps a clean
    // result from hiding a comparison that never ran.
    const out = ran(auditReleasedModules({ released: realModules }));

    expect(isPass(out)).toBe(true);
    expect(out.findings).toEqual([]);
    expect(out.declared_structure).toBe('unavailable');
    expect(out.notes.join(' ')).toMatch(/not compared against the brief/i);
  });

  it('still catches the seed when no declared list is available', () => {
    const out = ran(auditReleasedModules({ released: [...realModules, seededModule] }));
    expect(out.ok).toBe(false);
    expect(out.declared_structure).toBe('unavailable');
  });

  it('reports a name-only match as suspect, and suspects do not halt', () => {
    // A PDD may legitimately specify a module called "Survey". Halting the
    // phase on the name alone is how a gate earns its own deletion — so the
    // finding is recorded with tier `suspect` and the skill does not halt on it.
    const out = ran(
      auditReleasedModules({
        released: [
          {
            name: 'Survey',
            forms: [
              {
                name: 'Survey',
                fields: [
                  { name: 'nets_hung', label: 'Nets hung' },
                  { name: 'nets_torn', label: 'Nets torn' },
                ],
              },
            ],
          },
        ],
        declared: ['Survey'],
      }),
    );

    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].tier).toBe('suspect');
    expect(out.findings.some((f) => f.tier === 'blocker')).toBe(false);
  });

  it('an EMPTY module list is `unable`, never a pass', () => {
    // "Found no starter module" read off a check that inspected nothing is the
    // blind-gate class (ace#1332 -> #1538 -> #1576 -> #1634). A released
    // CommCare app always has modules, so an empty list is a caller bug.
    const out = auditReleasedModules({ released: [] });

    expect(out.status).toBe('unable');
    expect(isPass(out)).toBe(false);
    if (out.status === 'unable') expect(out.reason).toMatch(/could not be built/i);
  });
});
