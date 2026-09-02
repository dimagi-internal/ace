/**
 * ace#1829 — the training deck invents its own Learn module numbering.
 *
 * The fixtures are the real thing. `APP_MODULES` is the Learn suite root of
 * `hh-poverty-targeting/20260828-0702`, verified three ways: the suite-root
 * screenshot read at the pixel level (Drive `1e8BDp4cnXKG2_SmSa7hL0gg7yuYL1UBi`,
 * `journey-learn-suite-root.png`), the capture manifest's
 * `learn-tap-module-after-<name>.png` step names, and the live deck via
 * `slides_get`. The deck strings are the titles that shipped.
 */
import { describe, it, expect } from 'vitest';
import {
  checkDeckModuleLabels,
  formatDeckLabelReport,
  bareTitle,
  normalizeTitle,
  type DeckSlideLabel,
} from '../../lib/deck-module-labels.js';

/** The Learn app's six tiles, in app order, verbatim. */
const APP_MODULES = [
  'Pre-Assessment',
  'Module 1 - Administering a scorecard neutrally',
  'Module 2 - Consent and refusal handling',
  'Module 3 - What makes a visit payable',
  'Module 4 - Households, rosters and duplicates',
  'Post-Assessment',
];

/** Slides 34-39 as they shipped — the practice section that renumbered. */
const SHIPPED_PRACTICE: DeckSlideLabel[] = [
  'Complete Learn Module 1: Pre-Assessment',
  'Complete Learn Module 2: Administering a Scorecard Neutrally',
  'Complete Learn Module 3: Consent and Refusal Handling',
  'Complete Learn Module 4: What Makes a Visit Payable',
  'Complete Learn Module 5: Households, Rosters and Duplicates',
  'Complete Learn Module 6: Post-Assessment',
].map((title, i) => ({ id: `practice-${i + 1}`, title, module: 'practice' }));

/** Slides 16-19 as they shipped — the reference section, which was correct. */
const SHIPPED_REFERENCE: DeckSlideLabel[] = [
  'Module 1 — Administering a Scorecard Neutrally',
  'Module 2 — Consent and Refusal Handling',
  'Module 3 — What Makes a Visit Payable',
  'Module 4 — Households, Rosters and Duplicates',
].map((title, i) => ({ id: `learn-${i + 1}`, title, module: 'your-opportunity' }));

describe('the shipped practice section is caught (ace#1829)', () => {
  const r = checkDeckModuleLabels(SHIPPED_PRACTICE, APP_MODULES);

  it('flags every renumbered slide', () => {
    // All six are wrong: one names an unnumbered entry as Module 1, and the
    // other five are each off by one against the app.
    expect(r.findings.length).toBe(6);
  });

  it('names the timed instruction a worker cannot follow', () => {
    // "Complete Learn Module 4: What Makes a Visit Payable" is a 20-minute
    // hands-on block. The app calls that Module 3.
    const f = r.findings.find((x) => x.text.includes('What Makes a Visit Payable'))!;
    expect(f.kind).toBe('module-number-mismatch');
    expect(f.deckNumber).toBe(4);
    expect(f.appNumber).toBe(3);
    expect(f.appLabel).toBe('Module 3 - What makes a visit payable');
  });

  it('identifies the ROOT of the off-by-one: Pre-Assessment is unnumbered', () => {
    const f = r.findings.find((x) => x.text.includes('Pre-Assessment'))!;
    expect(f.kind).toBe('module-number-mismatch');
    expect(f.detail).toMatch(/UNNUMBERED/);
  });

  it('the report is actionable — it prints the app numbering', () => {
    const text = formatDeckLabelReport(r);
    expect(text).toContain('MISMATCH');
    expect(text).toContain('Module 3 - What makes a visit payable');
  });
});

describe('the shipped reference section is NOT flagged', () => {
  it('slides 16-19 already matched the app', () => {
    // Flagging these would make the check an always-fires blocker on the half
    // of the deck that was already right.
    const r = checkDeckModuleLabels(SHIPPED_REFERENCE, APP_MODULES);
    expect(r.findings).toEqual([]);
    expect(formatDeckLabelReport(r)).toContain('OK');
  });
});

describe('slide 14 — the contradiction beside its own evidence', () => {
  it('flags an ordinal list that renumbers a module with no "Module" keyword', () => {
    const slide: DeckSlideLabel = {
      id: 'learn-overview',
      module: 'your-opportunity',
      body: [
        '1. Pre-assessment',
        '2. Administering a scorecard neutrally',
        '3. Consent and refusal handling',
        '4. What makes a visit payable',
        '5. Households, rosters and duplicates',
        '6. Post-assessment',
      ],
    };
    const r = checkDeckModuleLabels([slide], APP_MODULES);
    const f = r.findings.find((x) => x.text.includes('What makes a visit payable'))!;
    expect(f).toBeTruthy();
    expect(f.deckNumber).toBe(4);
    expect(f.appNumber).toBe(3);
  });

  it('an ordinal list that AGREES with the app is clean', () => {
    const slide: DeckSlideLabel = {
      id: 'learn-overview',
      body: [
        '1. Administering a scorecard neutrally',
        '2. Consent and refusal handling',
        '3. What makes a visit payable',
        '4. Households, rosters and duplicates',
      ],
    };
    expect(checkDeckModuleLabels([slide], APP_MODULES).findings).toEqual([]);
  });
});

describe('the corrected deck is clean — the negative control', () => {
  it('lifting the app labels verbatim clears every finding', () => {
    const fixed: DeckSlideLabel[] = APP_MODULES.map((label, i) => ({
      id: `practice-${i + 1}`,
      title: `Complete: ${label}`,
      module: 'practice',
    }));
    const r = checkDeckModuleLabels(fixed, APP_MODULES);
    expect(r.findings).toEqual([]);
  });
});

describe('other shapes it catches', () => {
  it('a module number the app does not have', () => {
    const r = checkDeckModuleLabels([{ id: 's', title: 'Open Module 7 now' }], APP_MODULES);
    expect(r.findings[0].kind).toBe('module-number-not-in-app');
  });

  it('a module name the app does not ship', () => {
    const r = checkDeckModuleLabels(
      [{ id: 's', title: 'Module 2: Cash Transfer Protocol' }],
      APP_MODULES,
    );
    expect(r.findings[0].kind).toBe('module-name-not-in-app');
  });

  it('an app with no numbered modules is reported, not crashed on', () => {
    const r = checkDeckModuleLabels([{ id: 's', title: 'Module 1: Intro' }], ['Intro', 'Wrap-up']);
    expect(r.findings[0].kind).toBe('module-number-mismatch');
    expect(formatDeckLabelReport(r)).toContain('no numbered modules');
  });

  it('an empty deck finds nothing', () => {
    expect(checkDeckModuleLabels([], APP_MODULES).findings).toEqual([]);
  });
});

describe('title normalisation tolerates real-world drift', () => {
  it('matches across case, en-dashes and em-dashes', () => {
    expect(normalizeTitle('What Makes a Visit Payable')).toBe(
      normalizeTitle('What makes a visit payable'),
    );
    expect(bareTitle('Module 3 — What makes a visit payable')).toBe(
      'What makes a visit payable',
    );
    expect(bareTitle('Module 3 - What makes a visit payable')).toBe(
      'What makes a visit payable',
    );
    expect(bareTitle('Module 3: What makes a visit payable')).toBe(
      'What makes a visit payable',
    );
  });
});
