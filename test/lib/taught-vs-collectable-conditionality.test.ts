/**
 * dimagi-internal/ace#2856 — the fourth recurrence of this module's own
 * documented bug class ("the matcher, not the curriculum": ace#1332, #1538,
 * #1576, #1634, then #1793).
 *
 * Measured on the regex as it stood, with the issue's control table:
 *
 *     --- phrasings that SHOULD be caught as unconditional ---
 *     checked   "Take a photograph of the stall at every visit."
 *     checked   "Always take a photograph of the stall."
 *     unable    "Take a photograph of the stall, every time."
 *     unable    "Take a photograph of the stall each time."
 *     unable    "Take a photograph of the stall at every stall."
 *     unable    "Take a photograph of every seller you visit."
 *     unable    "Take a photograph in all cases."
 *     unable    "Take a photograph without exception."
 *     2/8 matched
 *
 * The two that matched are literally the two already in the regex.
 *
 * **Adding the other six is the fix shape that does not converge** — it is
 * what ace#1793 did, and the class recurred on the next opportunity with a
 * different noun. So this suite pins two things instead:
 *
 *  1. The ONE change to the matcher is a REMOVAL — the closed noun list after
 *     `every`/`each` (`visit|household|door|outcome`), which made any
 *     programme with another unit of observation unreachable by construction.
 *  2. The real fix: `unable` no longer conflates "the curriculum teaches
 *     nothing unconditionally" with "the matcher could not tell". The second
 *     is now loud and quotes the labels it could not read, which is what every
 *     recurrence of this class needed and did not have.
 */
import { describe, it, expect } from 'vitest';
import {
  checkTaughtStepsCollectable,
  classifyLearnLabel,
  formatTaughtVsCollectableReport,
  type Blueprint,
} from '../../lib/taught-vs-collectable';
import { assertUnable } from '../../lib/check-outcome';

/** The issue's control table, verbatim. */
const CONTROL = [
  'Take a photograph of the stall at every visit.',
  'Always take a photograph of the stall.',
  'Take a photograph of the stall, every time.',
  'Take a photograph of the stall each time.',
  'Take a photograph of the stall at every stall.',
  'Take a photograph of every seller you visit.',
  'Take a photograph in all cases.',
  'Take a photograph without exception.',
];

/** The hh-poverty-targeting shape the check exists for: a consent-gated photo. */
const DELIVER: Blueprint = {
  modules: [
    {
      module_name: 'Survey',
      forms: [
        {
          form_name: 'turmeric_survey',
          fields: [
            { id: 'consent', kind: 'single_select', label: 'Consent given?' },
            {
              id: 'stall_photo',
              kind: 'image',
              label: 'Photograph of the stall',
              relevant: "consent = 'yes'",
            },
          ],
        },
      ],
    },
  ],
};

const learnWith = (...labels: string[]): Blueprint => ({
  modules: [
    {
      module_name: 'M1',
      forms: [
        {
          form_name: 'F1',
          fields: labels.map((label, i) => ({ id: `m1_${i}`, kind: 'label', label })),
        },
      ],
    },
  ],
});

describe('the closed noun list is gone (ace#2856)', () => {
  it('reads the programme\'s OWN unit of observation as unconditional', () => {
    // "stall" and "seller" are this programme's nouns. The old list could
    // never have contained them, and no list could contain every programme's.
    expect(classifyLearnLabel('Take a photograph of the stall at every stall.')).toBe(
      'unconditional',
    );
    expect(classifyLearnLabel('Take a photograph of every seller you visit.')).toBe(
      'unconditional',
    );
    expect(classifyLearnLabel('Take a photograph of the stall, every time.')).toBe(
      'unconditional',
    );
    expect(classifyLearnLabel('Take a photograph of the stall each time.')).toBe('unconditional');
  });

  it('keeps every phrasing ace#1793 fixed working', () => {
    for (const t of [
      'Every visit captures a location, including the ones that pay nothing.',
      'Take a photograph of the stall at every visit.',
      'On every visit, capture a GPS fix.',
      'Always take a photograph of the stall.',
      'Vacant dwelling, no eligible respondent, refusal — all three get a location fix.',
      'You still do all of this on an empty household.',
    ]) {
      expect(classifyLearnLabel(t), t).toBe('unconditional');
    }
  });

  it('still does NOT pretend to catch every phrasing — and that is deliberate', () => {
    // These two are the non-converging half of the control table. Enumerating
    // them is the move that produced this recurrence, so they stay unmatched
    // and are caught by `unclassified` instead.
    expect(classifyLearnLabel('Take a photograph in all cases.')).toBe('unclassified');
    expect(classifyLearnLabel('Take a photograph without exception.')).toBe('unclassified');
  });

  it('the control table is now 6/8 matched and 2/8 LOUD — never silent', () => {
    const classes = CONTROL.map(classifyLearnLabel);
    expect(classes.filter((c) => c === 'unconditional')).toHaveLength(6);
    expect(classes.filter((c) => c === 'unclassified')).toHaveLength(2);
    expect(classes).not.toContain('conditional');
  });
});

describe('conditional is read affirmatively, not guessed (ace#2856)', () => {
  it('reads the live turmeric curriculum as conditional', () => {
    // The run's own labels. The `unable` verdict there was SUBSTANTIVELY
    // correct — the curriculum teaches the photograph conditionally — but
    // nothing distinguished that from a missed match.
    expect(classifyLearnLabel('If she agrees, photograph the turmeric she has for sale.')).toBe(
      'conditional',
    );
    expect(
      classifyLearnLabel('Which photographs you are asked for depends on what you ticked.'),
    ).toBe('conditional');
    // NOTE, measured 2026-10-13: neither of those two labels matches
    // EVIDENCE_ACTIONS in the first place, so on that run the verdict came
    // from the no-evidence-action branch rather than the conditional one.
    // ace#2856 states the EVIDENCE_ACTIONS half matched; for these two quoted
    // labels it does not. That is a SEPARATE matcher gap in a different
    // regex, filed on its own rather than widened here under this issue's
    // cover. `classifyLearnLabel` is orthogonal to it and is what is asserted
    // above.
  });

  it('an unconditional marker OUTRANKS a conditional one', () => {
    // "even if she declines" is unconditional prose containing `if`. The
    // precedence makes this change monotonic: no label that classified as
    // unconditional before can be reclassified by the new marker list.
    expect(
      classifyLearnLabel('Always take a photograph of the stall, even if she declines to talk.'),
    ).toBe('unconditional');
    expect(
      classifyLearnLabel('Capture a GPS fix at every stall, only when you are standing there.'),
    ).toBe('unconditional');
  });
});

describe('unable says WHICH of its two meanings it means (ace#2856)', () => {
  it('MATCHER LIMITED when an evidence label cannot be classified', () => {
    const report = checkTaughtStepsCollectable(
      learnWith('Take a photograph in all cases.'),
      DELIVER,
    );
    assertUnable(report);
    expect(report.reason).toMatch(/MATCHER LIMITED, not a clean negative/);
    // It must quote the label, or the reader is back to reading both
    // curricula by hand — the work this check exists to remove.
    expect(report.reason).toMatch(/Take a photograph in all cases\./);
    expect(report.reason).toMatch(/READ THESE AND DECIDE BY HAND/);
    // And it must name the class, so the next reader recognises it.
    expect(report.reason).toMatch(/#1793/);
  });

  it('a CONFIDENT negative when every evidence label is conditional', () => {
    const report = checkTaughtStepsCollectable(
      learnWith(
        'If she agrees, take a photograph of the turmeric she has for sale.',
        'Only when she consents, capture a photograph of the stall.',
      ),
      DELIVER,
    );
    assertUnable(report);
    expect(report.reason).toMatch(/states every one of them CONDITIONALLY/);
    expect(report.reason).toMatch(/not a matcher giving up/);
    expect(report.reason).not.toMatch(/MATCHER LIMITED/);
  });

  it('a mixed curriculum reports MATCHER LIMITED, and counts the rest', () => {
    // An unreadable label is not excused by a readable one next to it.
    const report = checkTaughtStepsCollectable(
      learnWith(
        'If she agrees, take a photograph of the turmeric she has for sale.',
        'Take a photograph without exception.',
      ),
      DELIVER,
    );
    assertUnable(report);
    expect(report.reason).toMatch(/MATCHER LIMITED/);
    expect(report.reason).toMatch(/1 further label\(s\) WERE read as conditional/);
  });

  it('a curriculum teaching no evidence action at all gets the third reason', () => {
    const report = checkTaughtStepsCollectable(
      learnWith('Connect pays you for verified visits. Ask your supervisor if unsure.'),
      DELIVER,
    );
    assertUnable(report);
    expect(report.reason).toMatch(/no Learn label teaches an evidence step at all/);
    expect(report.reason).not.toMatch(/MATCHER LIMITED/);
  });

  it('every unable branch still renders as NOT a pass', () => {
    for (const learn of [
      learnWith('Take a photograph in all cases.'),
      learnWith('If she agrees, take a photograph of the turmeric she has for sale.'),
      learnWith('Connect pays you for verified visits.'),
    ]) {
      const text = formatTaughtVsCollectableReport(
        checkTaughtStepsCollectable(learn, DELIVER),
      );
      expect(text).toMatch(/UNABLE TO CHECK/);
      expect(text).toMatch(/NOT a pass/);
      expect(text).not.toMatch(/\bclean negative\b.*\bok\b/i);
    }
  });
});

describe('the widened matcher actually CHECKS the defect it exists for', () => {
  it('flags the consent-gated photo once the programme-noun phrasing is read', () => {
    // This is the whole point: before ace#2856 this Learn/Deliver pair
    // produced `unable`, so the gated photo went unverified.
    const report = checkTaughtStepsCollectable(
      learnWith('Take a photograph of the stall at every stall.'),
      DELIVER,
    );
    expect(report.status).toBe('checked');
    if (report.status !== 'checked') throw new Error('unreachable');
    expect(report.ok).toBe(false);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].reason).toBe('gated');
    expect(report.findings[0].gate).toBe("consent = 'yes'");
  });

  it('is clean when the same step is collectable on every branch', () => {
    const ungated: Blueprint = {
      modules: [
        {
          module_name: 'Survey',
          forms: [
            {
              form_name: 'turmeric_survey',
              fields: [{ id: 'stall_photo', kind: 'image', label: 'Photograph of the stall' }],
            },
          ],
        },
      ],
    };
    const report = checkTaughtStepsCollectable(
      learnWith('Take a photograph of every seller you visit.'),
      ungated,
    );
    expect(report.status).toBe('checked');
    if (report.status !== 'checked') throw new Error('unreachable');
    expect(report.ok).toBe(true);
  });
});
