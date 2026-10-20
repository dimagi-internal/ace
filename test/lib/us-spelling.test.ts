import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findUkSpellings, describeUkSpellings, UK_TO_US } from '../../lib/us-spelling';
import { checkUsSpelling, CHECKS } from '../../skills/idea-to-pdd-qa/checks';

// ace#3232 — connect-fi/20261018-1440's PDD carried programme x12 / enrolment x34,
// which shipped to workers as "Enrol adults" / "Adult Enrolment".
describe('findUkSpellings', () => {
  test('flags the reproducer words in prose, with case-matched suggestions', () => {
    const f = findUkSpellings(
      'The programme will enrol adults.\nEnrolment opens in May; the organisation leads it.',
    );
    expect(f.map((x) => [x.word, x.suggestion, x.line, x.capitalized])).toEqual([
      ['programme', 'program', 1, false],
      ['enrol', 'enroll', 1, false],
      ['Enrolment', 'Enrollment', 2, true],
      ['organisation', 'organization', 2, false],
    ]);
  });

  test('a single-hyphen compound is prose and is flagged', () => {
    expect(findUkSpellings('a programme-level budget').map((x) => x.word)).toEqual(['programme']);
  });

  test('never flags identifiers: code spans, snake_case, slugs, paths, fenced code', () => {
    const text = [
      'Case property `days_to_enrolment` and `kmc_programme_metrics`.',
      'Bare snake case days_to_enrolment stays.',
      'Narrative slug connect-fi-programme-cascade stays.',
      'Path docs/programme/notes.md and file programme.yaml stay.',
      '```',
      'programme: true',
      '```',
    ].join('\n');
    expect(findUkSpellings(text)).toEqual([]);
  });

  test('US spellings and look-alikes are not flagged', () => {
    expect(
      findUkSpellings('The program enrolls; enrollment, organization, analyses, programmed, centered.'),
    ).toEqual([]);
  });

  test('describe groups per word with counts', () => {
    const d = describeUkSpellings(findUkSpellings('programme\nprogramme\nenrolment'));
    expect(d).toBe('programme→program x2 (lines 1, 2); enrolment→enrollment x1 (line 3)');
  });

  test('every rule maps to a different word', () => {
    for (const [uk, us] of UK_TO_US) expect(us).not.toBe(uk);
  });
});

describe('idea-to-pdd-qa us_spelling check', () => {
  test('is registered in CHECKS', () => {
    expect(CHECKS.map((c) => c.id)).toContain('us_spelling');
  });

  test('negative control: lower-case UK spelling fails with a fix hint', () => {
    const r = checkUsSpelling('## Overview\n\nAdults enrol in the programme.');
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/programme→program/);
    expect(r.auto_fix_hint).toMatch(/_terminology\.md/);
  });

  test('negative control on the captured reproducer PDD (connect-fi/20261018-1440)', () => {
    const real = readFileSync(
      join(__dirname, '..', 'fixtures', 'us-spelling', 'connect-fi-20261018-1440-pdd-excerpt.md'),
      'utf8',
    );
    const r = checkUsSpelling(real);
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/enrolment→enrollment x4/);
    expect(r.detail).toMatch(/enrols→enrolls x1/);
    expect(r.detail).toMatch(/enrol→enroll x1/);
    // The backticked decision id `total-programme-budget` is an identifier, not prose.
    expect(r.detail).not.toMatch(/programme/);
  });

  test('positive control: US prose passes', () => {
    expect(checkUsSpelling('## Overview\n\nAdults enroll in the program.').pass).toBe(true);
  });

  test('capitalized-only occurrences (possible proper names) pass but are listed', () => {
    const r = checkUsSpelling('Partner: Centre for Global Development.');
    expect(r.pass).toBe(true);
    expect(r.detail).toMatch(/Centre→Center/);
  });

  test('Drive-export escaping does not hide an identifier as prose', () => {
    expect(checkUsSpelling('Property days\\_to\\_enrolment is set.').pass).toBe(true);
  });
});
