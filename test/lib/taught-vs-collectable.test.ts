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
    expect(report.findings.some((f) => /gps/i.test(f.taught))).toBe(false);
  });

  it('passes once the photo field is ungated', () => {
    const fixed = JSON.parse(JSON.stringify(DELIVER));
    delete fixed.modules[0].forms[0].fields[2].relevant;
    const report = checkTaughtStepsCollectable(LEARN, fixed);
    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('flags a taught step with NO corresponding Deliver field at all', () => {
    const noPhoto = JSON.parse(JSON.stringify(DELIVER));
    noPhoto.modules[0].forms[0].fields.splice(2, 1);
    const report = checkTaughtStepsCollectable(LEARN, noPhoto);
    expect(report.findings.find((f) => /photograph/i.test(f.taught))!.reason).toBe('absent');
  });

  it('is inert when the curriculum states no unconditional evidence step', () => {
    const chatty = {
      modules: [
        { module_name: 'Welcome', forms: [{ form_name: 'M1', fields: [
          { id: 'intro', kind: 'label', label: 'Connect pays you for verified visits. Ask your supervisor if unsure.' },
        ] }] },
      ],
    };
    const report = checkTaughtStepsCollectable(chatty, DELIVER);
    expect(report.checked).toBe(false);
    expect(report.ok).toBe(true);
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
