/**
 * Class preventer for the "stated count drifts behind the mandated set" bug in
 * `skills/pdd-to-app-journeys/SKILL.md` (ace#2274; third instance in this file
 * family after ace#1545).
 *
 * THE CLASS. `pdd-to-app-journeys` states a journey COUNT inside each
 * `## Archetypes` branch ("Generate 2-4 journeys"), and separately states a set
 * of BLOCKING `## Coverage rules` that mandate journeys. The two are written in
 * different sections by different edits, and nothing tied them together — so
 * when Coverage rule 4 made a Learn smoke journey mandatory for every archetype
 * with a Learn app (2026-05-18, after the `malaria-itn-app/20260517-1829`
 * Phase 6 halt), no branch count moved with it.
 *
 * The result, live until 2026-09-08: `longitudinal-visits` declared 3-5 against
 * a compliant floor of 6 (visit-flow + data-quality-error inherited from
 * atomic-visit, plus case-selection, followup-with-preload, repeat-activity,
 * plus `registration` whenever the entity is registered in-app), and
 * `atomic-visit` declared 2-4 against a floor of 5. Both ranges were
 * UNSATISFIABLE while complying with the same file's blocking rules. An agent
 * following the branch count under-generates and gets sent back by rule 4; one
 * following the rules exceeds the stated count and hands
 * `pdd-to-app-journeys-eval § archetype_alignment` a set whose size contradicts
 * the producer doc it is graded against. Measured on
 * `bednet-check-2-visit/20260908-1544`: the compliant set was 7 journeys
 * against a declared ceiling of 5.
 *
 * Note this failure is QUIET. Nothing errors; a phase agent just spends a turn
 * reconciling two numbers in one file, every longitudinal and atomic run. That
 * is why it gets a ratchet rather than only corrected numbers — the numbers
 * were correct once too.
 *
 * THE INVARIANT. For each archetype branch, the declared journey-count CEILING
 * must be at least the number of categories that branch mandates — its own
 * bullets plus any it declares it keeps from another branch. Plus the wording
 * that makes the count readable: each branch says its count is DELIVER-SIDE,
 * and says either that the Learn smoke is additional to it or that the
 * archetype has no Learn app.
 *
 * SCOPE. `multi-stage` declares no count of its own (it composes the other
 * branches per stage), so it is deliberately not asserted here.
 */

import { describe, expect, test } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SKILL_PATH = join(
  __dirname,
  '..',
  '..',
  'skills',
  'pdd-to-app-journeys',
  'SKILL.md',
);

/** Branches that declare their own journey count. `multi-stage` does not. */
const COUNTED_BRANCHES = [
  'atomic-visit',
  'longitudinal-visits',
  'focus-group',
] as const;

/** Branches whose archetype has a Learn app, so Coverage rule 4 adds one. */
const HAS_LEARN_APP: Record<string, boolean> = {
  'atomic-visit': true,
  'longitudinal-visits': true,
  // The branch itself states there is no Learn app for focus-group (the OCS
  // chatbot is the primary training surface), so rule 4 adds nothing.
  'focus-group': false,
};

interface Branch {
  name: string;
  body: string;
  /** Declared ceiling, e.g. 6 from "Generate **4-6 DELIVER-SIDE journeys**". */
  ceiling: number;
  /** Declared floor. */
  floor: number;
  /** Category bullets listed in this branch. */
  ownCategories: string[];
  /** Categories this branch declares it keeps from another branch. */
  inheritedCategories: string[];
}

/**
 * Slice the `## Archetypes` section into its `### <branch>` bodies.
 *
 * Exported so the control tests below can drive it with synthetic prose — a
 * parser that only ever sees the file it is meant to guard cannot be shown to
 * FAIL on a regression, which is the difference between a ratchet and a
 * decoration.
 */
export function parseBranches(doc: string): Branch[] {
  const archetypes = doc.slice(doc.indexOf('\n## Archetypes'));
  const headingRe = /^###\s+`?([a-z-]+)`?.*$/gim;
  const heads: { name: string; index: number; length: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(archetypes)) !== null) {
    heads.push({ name: m[1], index: m.index, length: m[0].length });
  }

  const out: Branch[] = [];
  for (let i = 0; i < heads.length; i++) {
    const start = heads[i].index + heads[i].length;
    const end = i + 1 < heads.length ? heads[i + 1].index : archetypes.length;
    const body = archetypes.slice(start, end);

    // "Generate **2-4 DELIVER-SIDE journeys**" / "Generate **4-6 ... journeys**".
    // Accept either hyphen or en-dash between the two numbers.
    const countMatch = body.match(
      /Generate\s+\*\*(\d+)\s*[-–]\s*(\d+)[^*]*\*\*/i,
    );
    if (!countMatch) continue;

    // Top-level category bullets: "- **case-selection** — ...".
    const ownCategories = [...body.matchAll(/^-\s+\*\*([a-z][a-z-]*)\*\*/gim)].map(
      (b) => b[1],
    );

    // "Keep `visit-flow` and `data-quality-error` from `atomic-visit`".
    const inheritedCategories: string[] = [];
    const keepMatch = body.match(/Keep\s+((?:`[a-z-]+`(?:\s*(?:,|and)\s*)?)+)\s*\n?\s*from/i);
    if (keepMatch) {
      inheritedCategories.push(
        ...[...keepMatch[1].matchAll(/`([a-z-]+)`/g)].map((k) => k[1]),
      );
    }

    out.push({
      name: heads[i].name,
      body,
      floor: parseInt(countMatch[1], 10),
      ceiling: parseInt(countMatch[2], 10),
      ownCategories,
      inheritedCategories,
    });
  }
  return out;
}

/** Categories a branch mandates: its own bullets plus what it keeps. */
export function mandatedCategoryCount(b: Branch): number {
  return new Set([...b.ownCategories, ...b.inheritedCategories]).size;
}

const DOC = readFileSync(SKILL_PATH, 'utf-8');
const BRANCHES = parseBranches(DOC);

describe('pdd-to-app-journeys journey counts are consistent with the coverage rules', () => {
  test('every counted branch is found and parsed', () => {
    const names = BRANCHES.map((b) => b.name);
    for (const expected of COUNTED_BRANCHES) {
      expect(
        names,
        `branch \`${expected}\` no longer declares a parseable "Generate **N-M ... journeys**" count. ` +
          'If a branch legitimately stops declaring a count, remove it from COUNTED_BRANCHES here ' +
          'and say why in the SKILL.md § How to read a branch count.',
      ).toContain(expected);
    }
  });

  for (const name of COUNTED_BRANCHES) {
    describe(name, () => {
      const branch = () => {
        const b = BRANCHES.find((x) => x.name === name);
        if (!b) throw new Error(`branch ${name} not parsed`);
        return b;
      };

      test('the declared ceiling covers every category the branch mandates', () => {
        const b = branch();
        const mandated = mandatedCategoryCount(b);
        expect(
          b.ceiling,
          `\`${name}\` declares a ceiling of ${b.ceiling} Deliver-side journeys but mandates ` +
            `${mandated} categories (own: ${b.ownCategories.join(', ') || 'none'}; ` +
            `kept from another branch: ${b.inheritedCategories.join(', ') || 'none'}). ` +
            'A branch whose ceiling is below its own category list is unsatisfiable — that is ' +
            'ace#2274. Adding a category means re-deriving the count in the same edit.',
        ).toBeGreaterThanOrEqual(mandated);
      });

      test('the floor is not above the ceiling', () => {
        const b = branch();
        expect(b.floor).toBeLessThanOrEqual(b.ceiling);
      });

      test('the count says it is DELIVER-SIDE', () => {
        expect(
          branch().body,
          `\`${name}\`'s journey count must say DELIVER-SIDE. Reading it as a TOTAL is how ` +
            'the Learn smoke got silently absorbed into the count (ace#2274).',
        ).toMatch(/DELIVER-SIDE/);
      });

      test('the branch says what Coverage rule 4 does to its count', () => {
        const b = branch();
        if (HAS_LEARN_APP[name]) {
          expect(
            b.body,
            `\`${name}\` has a Learn app, so Coverage rule 4 adds a mandatory ` +
              '`training-completion-smoke` journey on top of the branch count. The branch must ' +
              'say the Learn smoke is ADDITIONAL to this count.',
          ).toMatch(/ADDITIONAL to this count/i);
        } else {
          expect(
            b.body,
            `\`${name}\` has no Learn app, so Coverage rule 4 adds nothing. The branch must say ` +
              'so, otherwise the next reader adds a phantom +1.',
          ).toMatch(/no Learn app/i);
        }
      });
    });
  }

  test('the derivation rule is documented, not just the numbers', () => {
    expect(
      DOC,
      'SKILL.md must carry a § How to read a branch count explaining that the count is ' +
        'Deliver-side, that the Learn smoke is additive, and that the numbers are derived. ' +
        'Without it the next category addition repeats ace#2274.',
    ).toMatch(/###\s+How to read a branch count/);
  });
});

describe('controls — the parser can actually fail', () => {
  const SYNTHETIC_TOO_SMALL = `
## Archetypes

### \`made-up-archetype\`

Generate **2–3 DELIVER-SIDE journeys**. The mandatory Learn smoke is ADDITIONAL
to this count. Keep \`visit-flow\` and \`data-quality-error\` from
\`atomic-visit\`, and add:

- **case-selection** — finds the entity.
- **followup-with-preload** — a follow-up against an existing case.
- **repeat-activity** — an activity the entity already had.
`;

  test('a branch whose ceiling is below its category list is detected', () => {
    const [b] = parseBranches(SYNTHETIC_TOO_SMALL);
    expect(b.name).toBe('made-up-archetype');
    expect(b.ceiling).toBe(3);
    // 3 own bullets + 2 kept = 5 mandated, against a ceiling of 3.
    expect(mandatedCategoryCount(b)).toBe(5);
    expect(b.ceiling).toBeLessThan(mandatedCategoryCount(b));
  });

  test('the inherited-category clause is actually parsed, not assumed', () => {
    const [b] = parseBranches(SYNTHETIC_TOO_SMALL);
    expect(b.inheritedCategories).toEqual(['visit-flow', 'data-quality-error']);
  });

  test('a branch with no Keep clause reports no inherited categories', () => {
    const [b] = parseBranches(`
## Archetypes

### \`solo\`

Generate **1–2 DELIVER-SIDE journeys** covering. There is no Learn app for solo.

- **visit-flow** — the happy path.
`);
    expect(b.inheritedCategories).toEqual([]);
    expect(mandatedCategoryCount(b)).toBe(1);
  });
});
