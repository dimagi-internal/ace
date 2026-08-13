import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Class-level preventer for ace#1213: Phase 1 can spec a mechanism the
// platform cannot build, and no gate catches it until Phase 3 — by which
// point the PDD, the Work Order and the Phase-6 training materials all
// describe a control that does not exist.
//
// Three instances shipped that way (ace#995 dead now(), ace#1006 GPS gate,
// ace#1121 randomized item draw) because the knowledge lived as prose
// scattered across whichever component happened to be adjacent. The fix is
// an ENUMERABLE list Phase 1 checks against.
//
// This test guards the list's structure and its wiring — that every row
// carries the three things a row is useless without (mechanism, why it is
// closed, sanctioned alternative), and that both the producer and the
// grader actually point at it. Semantic detection ("is this PDD asserting a
// listed mechanism?") needs the LLM; the structural half is cheap.

const REPO = join(__dirname, '..', '..');
const LIBRARY = join(REPO, 'skills', '_app-component-library.md');
const SECTION = 'Known-unbuildable mechanisms';

function librarySource(): string {
  return readFileSync(LIBRARY, 'utf8');
}

/** Extract the section body between its heading and the next same-level heading. */
export function extractSection(source: string, heading: string): string {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^##\\s+${heading}\\s*$`).test(l));
  if (start === -1) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^##\s+/.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

/** Parse the markdown table rows out of a section (excluding header + separator). */
export function tableRows(section: string): string[][] {
  const rows: string[][] = [];
  for (const line of section.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) continue;
    if (/^\|[\s|:-]+\|$/.test(trimmed)) continue; // separator
    const cells = trimmed.slice(1, -1).split('|').map((c) => c.trim());
    rows.push(cells);
  }
  return rows.length > 1 ? rows.slice(1) : []; // drop header
}

describe('known-unbuildable mechanisms list (ace#1213)', () => {
  it('the section exists in the component library', () => {
    expect(existsSync(LIBRARY)).toBe(true);
    expect(extractSection(librarySource(), SECTION)).not.toBe('');
  });

  it('seeds the three shipped instances', () => {
    const rows = tableRows(extractSection(librarySource(), SECTION));
    expect(rows.length).toBeGreaterThanOrEqual(3);

    const body = rows.map((r) => r.join(' ')).join('\n');
    // The three mechanisms that shipped into a Work Order before anyone noticed.
    expect(body).toMatch(/ace#1006/);
    expect(body).toMatch(/ace#995/);
    expect(body).toMatch(/ace#1121/);
  });

  it('every row names a mechanism, why it is closed, and a sanctioned alternative', () => {
    const rows = tableRows(extractSection(librarySource(), SECTION));
    const defective: string[] = [];

    for (const cells of rows) {
      const [mechanism, why, alternative, origin] = cells;
      const label = (mechanism ?? '(blank)').slice(0, 60);
      if (cells.length < 4) {
        defective.push(`${label}: expected 4 columns, got ${cells.length}`);
        continue;
      }
      // A row without a stated closure is a rumour, and a row without an
      // alternative just tells Phase 1 "no" with nowhere to go.
      if (why.length < 40) defective.push(`${label}: "why it is closed" is too thin to verify`);
      if (alternative.length < 30) defective.push(`${label}: no usable sanctioned alternative`);
      if (!/ace#\d+|#\d+/.test(origin)) defective.push(`${label}: origin cites no issue`);
    }

    expect(
      defective,
      'Every row in § Known-unbuildable mechanisms must name the mechanism, ' +
        'WHY it is closed (which enforcement surfaces, and how), a sanctioned ' +
        'alternative, and an origin issue. A row missing any of these is worse ' +
        'than no row — see the section\'s own "How to add a row" bar.',
    ).toEqual([]);
  });

  it('the producer and the grader both point at the list', () => {
    // The list only works if the skills that must consult it actually name it.
    const producer = readFileSync(join(REPO, 'skills', 'idea-to-pdd', 'SKILL.md'), 'utf8');
    const grader = readFileSync(join(REPO, 'skills', 'idea-to-pdd-eval', 'SKILL.md'), 'utf8');

    for (const [name, source] of [
      ['idea-to-pdd', producer],
      ['idea-to-pdd-eval', grader],
    ] as const) {
      expect(source, `${name}/SKILL.md must reference § ${SECTION}`).toMatch(
        // Whitespace-tolerant: the reference legitimately wraps across a
        // line break in prose ("§ Known-unbuildable\n    mechanisms").
        /Known-unbuildable\s+mechanisms/i,
      );
    }
  });

  it('keeps the evidence-discipline caveat that stops rows becoming rumours', () => {
    // "Not exposed on Nova's surface" is a fact about ACE's builder, not a
    // proof about XForms. Losing this note is how an unverified claim gets
    // laundered into a platform constraint.
    const section = extractSection(librarySource(), SECTION);
    expect(section).toMatch(/Evidence discipline/i);
    expect(section).toMatch(/verified at the surface/i);
  });
});

describe('section/table parsing helpers', () => {
  it('extracts a section and stops at the next heading', () => {
    const doc = ['## A', 'body a', '## B', 'body b'].join('\n');
    expect(extractSection(doc, 'A').trim()).toBe('body a');
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
