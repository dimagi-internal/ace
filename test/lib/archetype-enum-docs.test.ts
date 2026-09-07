/**
 * dimagi-internal/ace#2128 — the archetype vocabulary is enumerated in prose in
 * six places, and every one of them was written when the enum had three values.
 *
 * `longitudinal-visits` was added to the canonical vocabulary and none of the
 * prose followed. `CLAUDE.md § Conventions` is the expensive one — it is read at
 * the start of every session in every repo with ACE installed — but the four
 * per-skill `SKILL.md` sites are worse in kind: they are the artifact-template
 * placeholders that tell a skill what value to write into `run_state.yaml`, so a
 * skill following the placeholder literally has no way to emit the missing value.
 *
 * A single-site fix relocates the drift rather than removing it, which is why the
 * obligation is a test rather than a paragraph. Same shape as
 * `test/lib/opp-root-files.test.ts`, which pins the ACE-owned opp-root registry
 * against the orchestrator doc: the registry is the source, the doc must name
 * every entry, and CI — not a reviewer's memory — enforces the sync.
 *
 * Adding a fifth archetype therefore fails here until the prose is updated, which
 * is the intent. `CLAUDE.md` itself claims "adding a new archetype is purely
 * additive (per-skill PRs)"; this test is what makes that claim true of the docs.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { ARCHETYPES } from '../../lib/decisions-archetype-consistency.js';

/**
 * Every doc that enumerates the archetype vocabulary, with the line that does it.
 *
 * `match` finds the enumerating line so the assertion reports WHICH line is stale
 * rather than "the word appears somewhere in a 2000-line skill" — several of these
 * files mention individual archetypes elsewhere, so a whole-file `toContain` would
 * pass on a stale placeholder.
 */
const ENUMERATION_SITES: ReadonlyArray<{ file: string; match: RegExp; what: string }> = [
  {
    file: 'CLAUDE.md',
    match: /^- \*\*Archetypes are first-class\.\*\*.*$/m,
    what: '§ Conventions — Archetypes are first-class',
  },
  {
    file: 'skills/llo-launch/SKILL.md',
    match: /^\s*archetype: <.*>$/m,
    what: 'products.launch.archetype placeholder',
  },
  {
    file: 'skills/pdd-to-learn-app/SKILL.md',
    match: /^\s*archetype: <.*>$/m,
    what: 'learn-app summary front-matter placeholder',
  },
  {
    file: 'skills/pdd-to-deliver-app/SKILL.md',
    match: /^\s*archetype: <.*>$/m,
    what: 'deliver-app summary front-matter placeholder',
  },
  {
    file: 'skills/cycle-grade/SKILL.md',
    match: /^\s*archetype: <.*>$/m,
    what: 'products.cycle_grade.archetype placeholder',
  },
];

describe('archetype vocabulary is enumerated completely wherever it is enumerated (#2128)', () => {
  it('the canonical enum is the four-value one, read from the declared vocabulary', () => {
    // Not a restatement to keep in sync — ARCHETYPES *is*
    // DECISION_VOCABULARIES['archetype-selection'].options. This asserts the
    // premise the rest of the suite rests on, so a vocabulary edit that drops a
    // value fails loudly here rather than silently relaxing every check below.
    expect([...ARCHETYPES]).toEqual([
      'atomic-visit',
      'longitudinal-visits',
      'focus-group',
      'multi-stage',
    ]);
  });

  for (const site of ENUMERATION_SITES) {
    it(`${site.file} names every archetype (${site.what})`, () => {
      const doc = fs.readFileSync(path.join(process.cwd(), site.file), 'utf8');
      const line = doc.match(site.match)?.[0];

      expect(line, `${site.file}: no line matched ${site.match} — did the ${site.what} move?`)
        .toBeDefined();

      for (const archetype of ARCHETYPES) {
        expect(
          line,
          `${site.file} (${site.what}) omits \`${archetype}\`. The enumerating line is:\n  ${line}`,
        ).toContain(archetype);
      }
    });
  }
});
