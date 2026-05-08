/**
 * Unit tests for static QA checks in skills/pdd-to-app-journeys-qa/checks.ts.
 */

import { describe, expect, test } from 'vitest';
import {
  checkPersonaBlockPresent,
  checkArchetypeDeclared,
  checkJourneyCountInRange,
  checkEachJourneyHasGoal,
  checkEachJourneyHasHappyPath,
  checkEachJourneyHasEdgeCases,
  checkEachJourneyHasPassCriteria,
  CHECKS,
} from '../../../skills/pdd-to-app-journeys-qa/checks';

const VALID_DOC = `# Expected User Journeys — Test

Derived from: pdd.md
Archetype: atomic-visit

## Persona

CHW Asha — community health worker in TestLand pilot district. Conducts ~10 household visits per day. Smartphone-literate but new to the CommCare app. Connectivity is spotty in some target households, strong at the LLO office where she syncs end-of-day.

## Journey 1 — Complete a household visit

**Goal:** FLW finishes one household visit end-to-end.

**Happy path narrative:**
Asha confirms the household, walks through the form, photographs the card, submits, sees confirmation.

**Edge cases (UX outcomes, not error codes):**
- FLW understands why a duplicate-household submission was rejected
- FLW understands they cannot submit without a GPS reading

**Pass criteria:**
- Journey completes in <3 minutes
- Required-field errors are recoverable in-form

## Journey 2 — Pass the Learn assessment

**Goal:** FLW passes Learn assessment so Deliver app unlocks.

**Happy path narrative:**
Asha reads the onboarding module, takes the assessment, sees a passing score.

**Edge cases (UX outcomes, not error codes):**
- FLW understands what to do after a failed assessment attempt
- FLW understands why their progress was preserved between sessions

**Pass criteria:**
- Assessment passes register within 5 seconds
- Failed-attempt feedback names which questions to re-study
`;

describe('checkPersonaBlockPresent', () => {
  test('passes with substantive persona', () => {
    expect(checkPersonaBlockPresent(VALID_DOC).pass).toBe(true);
  });

  test('fails when persona section missing', () => {
    const doc = VALID_DOC.replace(/## Persona[\s\S]*?(?=## Journey)/, '');
    const r = checkPersonaBlockPresent(doc);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('Persona');
  });

  test('fails when persona is template-placeholder only', () => {
    const doc = `Archetype: atomic-visit\n\n## Persona\n\n{{persona_summary — pulled verbatim from PDD}}\n\n## Journey 1\n`;
    const r = checkPersonaBlockPresent(doc);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('placeholder');
  });

  test('fails when persona body is too short', () => {
    const doc = `## Persona\n\nx\n\n## Journey 1\n`;
    expect(checkPersonaBlockPresent(doc).pass).toBe(false);
  });
});

describe('checkArchetypeDeclared', () => {
  test('passes with valid archetype in header', () => {
    expect(checkArchetypeDeclared('Archetype: atomic-visit\n').pass).toBe(true);
  });

  test('passes with all three valid values', () => {
    for (const v of ['atomic-visit', 'focus-group', 'multi-stage']) {
      expect(checkArchetypeDeclared(`Archetype: ${v}\n`).pass).toBe(true);
    }
  });

  test('fails when no archetype declared', () => {
    const r = checkArchetypeDeclared('# Journeys\n\nNo archetype.\n');
    expect(r.pass).toBe(false);
  });

  test('fails on invalid archetype value', () => {
    const r = checkArchetypeDeclared('Archetype: bogus\n');
    expect(r.pass).toBe(false);
  });
});

describe('checkJourneyCountInRange', () => {
  test('passes with 2 journeys (lower bound)', () => {
    expect(checkJourneyCountInRange(VALID_DOC).pass).toBe(true);
  });

  test('fails with 0 journeys', () => {
    expect(checkJourneyCountInRange('Archetype: atomic-visit\n## Persona\n\nx\n').pass).toBe(false);
  });

  test('fails with 1 journey only', () => {
    const doc = `## Journey 1 — only\n\n**Goal:** ...\n`;
    const r = checkJourneyCountInRange(doc);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('1');
  });

  test('fails with 9 journeys (upper bound exceeded)', () => {
    let doc = '';
    for (let i = 1; i <= 9; i++) doc += `\n## Journey ${i} — name\n\nbody\n`;
    expect(checkJourneyCountInRange(doc).pass).toBe(false);
  });
});

describe('checkEachJourneyHasGoal', () => {
  test('passes when all journeys have **Goal:**', () => {
    expect(checkEachJourneyHasGoal(VALID_DOC).pass).toBe(true);
  });

  test('fails when one journey is missing **Goal:**', () => {
    const doc = VALID_DOC.replace('**Goal:** FLW finishes one household visit end-to-end.', '');
    const r = checkEachJourneyHasGoal(doc);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('1 journey(s)');
  });
});

describe('checkEachJourneyHasHappyPath', () => {
  test('passes on valid doc', () => {
    expect(checkEachJourneyHasHappyPath(VALID_DOC).pass).toBe(true);
  });

  test('fails when one journey is missing happy-path', () => {
    const doc = VALID_DOC.replace(/\*\*Happy path narrative:\*\*/, '');
    expect(checkEachJourneyHasHappyPath(doc).pass).toBe(false);
  });
});

describe('checkEachJourneyHasEdgeCases', () => {
  test('passes when each journey has 2+ edge bullets', () => {
    expect(checkEachJourneyHasEdgeCases(VALID_DOC).pass).toBe(true);
  });

  test('fails when a journey has only 1 edge bullet', () => {
    const doc = VALID_DOC.replace(
      `- FLW understands why a duplicate-household submission was rejected
- FLW understands they cannot submit without a GPS reading`,
      `- FLW understands why a duplicate-household submission was rejected`,
    );
    const r = checkEachJourneyHasEdgeCases(doc);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('Journey 1');
  });
});

describe('checkEachJourneyHasPassCriteria', () => {
  test('passes when each journey has criteria', () => {
    expect(checkEachJourneyHasPassCriteria(VALID_DOC).pass).toBe(true);
  });

  test('fails when criteria block missing', () => {
    const doc = VALID_DOC.replace(/\*\*Pass criteria:\*\*/g, '**Other:**');
    expect(checkEachJourneyHasPassCriteria(doc).pass).toBe(false);
  });
});

describe('CHECKS array', () => {
  test('exports 7 checks in stable order', () => {
    expect(CHECKS).toHaveLength(7);
    expect(CHECKS.map((c) => c.id)).toEqual([
      'persona_block_present',
      'archetype_declared_and_valid',
      'journey_count_in_range',
      'each_journey_has_goal',
      'each_journey_has_happy_path',
      'each_journey_has_edge_cases',
      'each_journey_has_pass_criteria',
    ]);
  });

  test('every check is type: static', () => {
    for (const c of CHECKS) {
      expect(c.type).toBe('static');
    }
  });
});
