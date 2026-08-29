/**
 * dimagi-internal/ace#1259 — the Learn curriculum teaches a step the Deliver
 * form cannot record.
 *
 * Live on hh-poverty-targeting/20260813-1612. Learn module M8 ("Photo and GPS
 * Evidence"), field `worked_example` — the padlocked dwelling — instructs
 * verbatim:
 *
 *     You still do all of this:
 *     1. Take one photograph of the front of the building.
 *     2. Walk into the open ground in front and capture the GPS fix.
 *     3. Record the outcome as vacant.
 *     4. Submit.
 *
 * The Deliver form's only `dwelling_photo` lives in a group carrying
 * `relevant: consent = 'yes'`. On a VACANT visit `consent` is never reached, so
 * the form never asks for the photograph the training just told the worker to
 * take. GPS is handled correctly by contrast — `gps_raw` is required with no
 * relevance — which is what makes the photo case a real asymmetry rather than
 * a blanket "training over-promises".
 *
 * Both apps are PDD-conformant (§5.1 lists the live photograph under "a payable
 * visit requires all of"; §5.2 gates screen 11 on Consent = yes), so WHICH
 * artifact is wrong is a judgement. The missing CHECK is not: nothing in ACE
 * cross-reads the two blueprints, and a human found it by reading them side by
 * side.
 */
import { describe, it, expect } from 'vitest';

import {
  checkTaughtStepsCollectable,
  formatTaughtVsCollectableReport,
} from '../../lib/taught-vs-collectable.js';

import { assertChecked, assertUnable } from '../../lib/check-outcome.js';
/** M8's worked example, plus a module that teaches nothing procedural. */
const LEARN = {
  modules: [
    {
      module_name: 'Photo and GPS Evidence',
      forms: [
        {
          form_name: 'M8',
          fields: [
            {
              id: 'worked_example',
              kind: 'label',
              label:
                'The padlocked dwelling. You still do all of this: 1. Take one photograph of the front of the building. 2. Walk into the open ground in front and capture the GPS fix. 3. Record the outcome as vacant. 4. Submit.',
            },
          ],
        },
      ],
    },
  ],
};

/** The Deliver form: gps unconditional, photo gated behind consent. */
const DELIVER = {
  modules: [
    {
      module_name: 'Household survey',
      forms: [
        {
          form_name: 'household_survey_visit',
          fields: [
            { id: 'visit_outcome', kind: 'single_select', label: 'Visit outcome',
              options: [{ label: 'completed' }, { label: 'vacant' }, { label: 'refused' }] },
            { id: 'gps_raw', kind: 'geopoint', label: 'Capture the GPS fix', required: true },
            {
              id: 'dwelling_photograph',
              kind: 'group',
              relevant: "consent = 'yes'",
              children: [{ id: 'dwelling_photo', kind: 'image', label: 'Photograph of the dwelling' }],
            },
          ],
        },
      ],
    },
  ],
};

describe('checkTaughtStepsCollectable (#1259)', () => {
  it('flags the photograph M8 teaches but the form gates behind consent', () => {
    const report = checkTaughtStepsCollectable(LEARN, DELIVER);
    assertChecked(report);
    expect(report.ok).toBe(false);
    const photo = report.findings.find((f) => /photograph/i.test(f.taught));
    expect(photo).toBeDefined();
    expect(photo!.reason).toBe('gated');
    // Name the gate so the fix is one edit away — either drop the relevance or
    // stop teaching it as unconditional.
    expect(photo!.field).toBe('dwelling_photo');
    expect(photo!.gate).toMatch(/consent/);
  });

  it('does NOT flag GPS — it is required with no relevance, so the taught step works on every outcome', () => {
    const report = checkTaughtStepsCollectable(LEARN, DELIVER);
    assertChecked(report);
    expect(report.findings.some((f) => /gps/i.test(f.taught))).toBe(false);
  });

  it('passes once the photo field is ungated', () => {
    const fixed = JSON.parse(JSON.stringify(DELIVER));
    delete fixed.modules[0].forms[0].fields[2].relevant;
    const report = checkTaughtStepsCollectable(LEARN, fixed);
    assertChecked(report);
    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('flags a taught step with NO corresponding Deliver field at all', () => {
    const noPhoto = JSON.parse(JSON.stringify(DELIVER));
    noPhoto.modules[0].forms[0].fields.splice(2, 1);
    const report = checkTaughtStepsCollectable(LEARN, noPhoto);
    assertChecked(report);
    expect(report.findings.find((f) => /photograph/i.test(f.taught))!.reason).toBe('absent');
  });

  it('is UNABLE, not clean, when the curriculum states no unconditional evidence step', () => {
    const chatty = {
      modules: [
        { module_name: 'Welcome', forms: [{ form_name: 'M1', fields: [
          { id: 'intro', kind: 'label', label: 'Connect pays you for verified visits. Ask your supervisor if unsure.' },
        ] }] },
      ],
    };
    const report = checkTaughtStepsCollectable(chatty, DELIVER);
    // Nothing to cross-check is NOT the two apps agreeing, and there is no
    // `ok` on this branch to say otherwise (ace#1634).
    expect(report.status).toBe('unable');
    assertUnable(report);
    expect(report.reason).toMatch(/unconditionally-taught evidence step/i);
    const text = formatTaughtVsCollectableReport(report);
    expect(text).toMatch(/UNABLE TO CHECK/);
    expect(text).toMatch(/NOT a pass/);
    // No green-looking word anywhere: "clean" is what the checked-and-fine
    // branch says, and "not applicable" is the benign phrasing three prior
    // instances of this class were signed off under.
    expect(text).not.toMatch(/\bclean\b/i);
    expect(text).not.toMatch(/not applicable/i);
  });

  // ace#1793 — the fifth instance of this module's own recurring failure mode:
  // the curriculum DID teach an unconditional evidence step and the matcher,
  // not the curriculum, was the reason nothing was checked. Live on
  // hh-poverty-targeting/20260828-0702, Nova Learn app
  // f7c9ea59-c38e-489f-83ef-e5d772299443, Module 3 field `m3_gps_why`.
  //
  // Both misses were near-neighbours of phrasings already in the list: bare
  // sentence-initial "Every visit" (the list had only "at/on every visit"),
  // and "all three" (the list had "all four" — but the count is a property of
  // the programme, which here has three non-payable outcomes).
  //
  // These three strings are the negative-control corpus. Before the widening
  // every one returned status 'unable'; each must now be CHECKED.
  it('matches the unconditional GPS step taught on hh-poverty-targeting (ace#1793)', () => {
    const taughtTexts = [
      'Every visit captures a location, including the ones that pay nothing.',
      'So: vacant dwelling, no eligible respondent, refusal - all three get a '
        + 'location fix before you leave the address. Capture it while you are standing there.',
      'Each visit gets a location fix, including the ones that pay nothing.',
    ];

    for (const label of taughtTexts) {
      const learn = {
        modules: [
          { module_name: 'Module 3 - What makes a visit payable', forms: [{
            form_name: 'What makes a visit payable',
            fields: [{ id: 'm3_gps_why', kind: 'label', label }],
          }] },
        ],
      };
      // An ungated geopoint: the Deliver app CAN record it on every branch, so
      // the check should run and come back ok — never 'unable'.
      const deliver = {
        modules: [
          { module_name: 'Household Visit', forms: [{
            form_name: 'Household Poverty Targeting Visit',
            fields: [
              { id: 'gps', kind: 'geopoint', required: true },
              { id: 'consent', kind: 'single_select', required: true },
            ],
          }] },
        ],
      };
      const report = checkTaughtStepsCollectable(learn, deliver);
      expect(report.status, `should have checked: ${label.slice(0, 48)}`).toBe('checked');
      assertChecked(report);
      expect(report.ok).toBe(true);
    }
  });

  it('still flags a taught GPS step the Deliver form gates away (ace#1793)', () => {
    // The widening must not turn the check into a rubber stamp: same taught
    // text, but the geopoint now sits behind the consent gate, so a vacant
    // door records no location and the finding must fire.
    const learn = {
      modules: [
        { module_name: 'Module 3 - What makes a visit payable', forms: [{
          form_name: 'What makes a visit payable',
          fields: [{
            id: 'm3_gps_why',
            kind: 'label',
            label: 'Every visit captures a location, including the ones that pay nothing.',
          }],
        }] },
      ],
    };
    const gatedDeliver = {
      modules: [
        { module_name: 'Household Visit', forms: [{
          form_name: 'Household Poverty Targeting Visit',
          fields: [{
            id: 'gps',
            kind: 'geopoint',
            required: true,
            relevant: "consent = 'yes'",
          }],
        }] },
      ],
    };
    const report = checkTaughtStepsCollectable(learn, gatedDeliver);
    expect(report.status).toBe('checked');
    assertChecked(report);
    expect(report.ok).toBe(false);
  });

  it('reports enough for a human to adjudicate which artifact is wrong', () => {
    // The check deliberately does NOT decide whether Learn over-teaches or
    // Deliver under-collects — both were PDD-conformant here. It surfaces the
    // disagreement and cites both sides.
    const text = formatTaughtVsCollectableReport(checkTaughtStepsCollectable(LEARN, DELIVER));
    expect(text).toMatch(/Photo and GPS Evidence/);
    expect(text).toMatch(/dwelling_photo/);
    expect(text).toMatch(/which artifact is wrong is a judgement/i);
  });
});
