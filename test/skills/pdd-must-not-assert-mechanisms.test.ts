import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Class-level preventer for ace#1213: Phase 1 can spec a mechanism ACE will
// not deliver, and no gate catches it until Phase 3 — by which point the
// PDD, the Work Order and the Phase-6 training materials all describe a
// control that does not exist.
//
// The section ships as TWO tables, and the split is the point:
//
//   Table A — closed at the platform surface. No path; the design changes.
//   Table B — buildable, but not something ACE's toolchain produces today.
//             Same PDD behaviour (don't assert it), different escalation
//             path (a capability request, not a dead end).
//
// Collapsing B into A manufactures false platform constraints. That is not
// hypothetical: this section SHIPPED with question-bank randomization in
// the unbuildable table, on two wrong arguments — "XForms can't express it"
// (it can: a seeded once(random()) over a fixture nodeset, or hidden
// questions gated on relevant) and "Connect's single passing_score makes it
// incommensurable" (only true for a VARIABLE-size draw; the spec was a
// fixed 12-of-30, so the denominator is constant and passing_score works
// normally). A false constraint in a Work Order outlives the constraint.
//
// Hence the retired-claims guard below: these specific wrong assertions are
// checked for by name, because a doc can be restructured and still quietly
// carry the claim that made it wrong.

const REPO = join(__dirname, '..', '..');
const LIBRARY = join(REPO, 'skills', '_app-component-library.md');
const SECTION = 'Mechanisms a PDD must not assert';

function librarySource(): string {
  return readFileSync(LIBRARY, 'utf8');
}

/** Extract a section body between its heading and the next same-or-higher heading. */
export function extractSection(source: string, heading: string, level = 2): string {
  const lines = source.split('\n');
  const hashes = '#'.repeat(level);
  const start = lines.findIndex((l) => new RegExp(`^${hashes}\\s+${heading}\\s*$`).test(l));
  if (start === -1) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => new RegExp(`^#{1,${level}}\\s+`).test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

/** Parse markdown table rows out of a section (excluding header + separator). */
export function tableRows(section: string): string[][] {
  const rows: string[][] = [];
  for (const line of section.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) continue;
    if (/^\|[\s|:-]+\|$/.test(trimmed)) continue;
    rows.push(trimmed.slice(1, -1).split('|').map((c) => c.trim()));
  }
  return rows.length > 1 ? rows.slice(1) : [];
}

const TABLE_A = 'Table A — closed at the platform surface';
const TABLE_B = "Table B — buildable, but not supported by ACE's toolchain today";

describe('mechanisms a PDD must not assert (ace#1213)', () => {
  it('the section exists and carries BOTH tables', () => {
    expect(existsSync(LIBRARY)).toBe(true);
    const section = extractSection(librarySource(), SECTION);
    expect(section).not.toBe('');
    expect(section, 'Table A (platform-closed) must exist').toContain(TABLE_A);
    expect(section, 'Table B (buildable, unsupported) must exist').toContain(TABLE_B);
  });

  it('seeds the three shipped instances across the two tables', () => {
    const section = extractSection(librarySource(), SECTION);
    const a = tableRows(extractSection(section, TABLE_A, 3));
    const b = tableRows(extractSection(section, TABLE_B, 3));

    expect(a.length, 'Table A must be seeded').toBeGreaterThanOrEqual(2);
    expect(b.length, 'Table B must be seeded').toBeGreaterThanOrEqual(1);

    const aBody = a.map((r) => r.join(' ')).join('\n');
    const bBody = b.map((r) => r.join(' ')).join('\n');

    // Platform-closed: the Connect verification-flags surface, and the
    // JavaRosa calculate-recomputation semantics.
    expect(aBody).toMatch(/ace#1006/);
    expect(aBody).toMatch(/ace#995/);

    // Buildable-but-unsupported: question-bank randomization. It must be in
    // B, and must NOT have crept back into A.
    expect(bBody, 'question-bank randomization belongs in Table B').toMatch(/ace#1121/);
    expect(aBody, 'question-bank randomization must NOT be in Table A').not.toMatch(/ace#1121/);
  });

  it('every row names a mechanism, a status, an alternative, and an origin', () => {
    const section = extractSection(librarySource(), SECTION);
    const rows = [
      ...tableRows(extractSection(section, TABLE_A, 3)),
      ...tableRows(extractSection(section, TABLE_B, 3)),
    ];
    const defective: string[] = [];

    for (const cells of rows) {
      const label = (cells[0] ?? '(blank)').slice(0, 60);
      if (cells.length < 4) {
        defective.push(`${label}: expected 4 columns, got ${cells.length}`);
        continue;
      }
      const [, why, alternative, origin] = cells;
      if (why.length < 40) defective.push(`${label}: status/reason too thin to verify`);
      if (alternative.length < 30) defective.push(`${label}: no usable alternative`);
      if (!/ace#\d+|#\d+/.test(origin)) defective.push(`${label}: origin cites no issue`);
    }

    expect(
      defective,
      'Every row must name the mechanism, its verified status, what ACE does ' +
        'instead, and an origin issue — see the section\'s "How to add a row" bar.',
    ).toEqual([]);
  });

  it('does not resurrect the two retired false claims about randomization', () => {
    // Both of these shipped and both were wrong. Named explicitly so a
    // future rewrite cannot quietly reintroduce them.
    const source = librarySource();
    const producer = readFileSync(join(REPO, 'skills', 'idea-to-pdd', 'SKILL.md'), 'utf8');

    for (const [name, text] of [
      ['_app-component-library.md', source],
      ['idea-to-pdd/SKILL.md', producer],
    ] as const) {
      expect(
        text,
        `${name}: "incommensurable" was the wrong argument — a FIXED-size draw ` +
          `keeps the denominator constant, so Connect's single passing_score is ` +
          `not violated. Do not restore it.`,
      ).not.toMatch(/incommensurable/i);

      expect(
        text,
        `${name}: must not claim CommCare/XForms cannot randomize — it can ` +
          `(seeded once(random()) over a fixture nodeset, or hidden questions ` +
          `gated on relevant).`,
      ).not.toMatch(/CommCare (has no|cannot) random/i);
    }
  });

  it('keeps the evidence-discipline rule and the default-to-Table-B tiebreak', () => {
    const section = extractSection(librarySource(), SECTION);
    expect(section).toMatch(/Evidence discipline/i);
    expect(section).toMatch(/verified at the surface/i);
    // The tiebreak is what stops the next over-claim.
    expect(
      section,
      'The section must say that an uncertain mechanism defaults to Table B.',
    ).toMatch(/when in doubt it goes in \*\*table b\*\*/i);
  });

  it('the producer and the grader both point at the section', () => {
    const producer = readFileSync(join(REPO, 'skills', 'idea-to-pdd', 'SKILL.md'), 'utf8');
    const grader = readFileSync(join(REPO, 'skills', 'idea-to-pdd-eval', 'SKILL.md'), 'utf8');

    for (const [name, source] of [
      ['idea-to-pdd', producer],
      ['idea-to-pdd-eval', grader],
    ] as const) {
      expect(source, `${name}/SKILL.md must reference § ${SECTION}`).toMatch(
        // Whitespace-tolerant: the reference legitimately wraps in prose.
        /Mechanisms a PDD\s+must not assert/i,
      );
    }
  });
});

describe('section/table parsing helpers', () => {
  it('extracts a section and stops at the next heading', () => {
    expect(extractSection(['## A', 'body a', '## B', 'body b'].join('\n'), 'A').trim()).toBe(
      'body a',
    );
  });

  it('extracts a level-3 subsection without swallowing the next one', () => {
    const doc = ['### One', 'a', '### Two', 'b'].join('\n');
    expect(extractSection(doc, 'One', 3).trim()).toBe('a');
  });

  it('returns empty for a missing section', () => {
    expect(extractSection('## A\nbody', 'Nope')).toBe('');
  });

  it('drops the header and separator rows', () => {
    const section = ['| M | Why | Alt | Origin |', '|---|---|---|---|', '| a | b | c | d |'].join(
      '\n',
    );
    expect(tableRows(section)).toEqual([['a', 'b', 'c', 'd']]);
  });
});
