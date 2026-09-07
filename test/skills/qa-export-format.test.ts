/**
 * Class preventer for the `*-qa` Drive-export-format bug (ace#1609, ace#1617,
 * ace#2169 — three instances of one class in three separate skills).
 *
 * THE CLASS. A `*-qa` skill reads its artifact back out of Drive and runs
 * static checks over the text. `drive_read_file` has TWO export formats for a
 * Google Doc and they return DIFFERENT text:
 *
 *   - `text/plain` (the atom's default) — a real Docs heading exports as bare
 *     text with no `#` marker at all; literal `#` characters in the body
 *     survive verbatim.
 *   - `text/markdown` — real Docs styles export as `##` / `**`, but literal
 *     markdown characters in the body have to be ESCAPED to be preserved, so
 *     `## Prompt 4` comes back as `\#\# Prompt 4`.
 *
 * Which one a skill needs follows from two readable facts: how the PRODUCER
 * wrote the doc (`drive_create_doc_from_markdown` → real styles;
 * `drive_create_file` → literal markdown characters, since it uploads the body
 * as `text/plain` media and Drive never runs the markdown conversion), and
 * what that skill's `checks.ts` matches. Get it wrong and a CORRECT artifact
 * scores near-zero, the auto-fix loop hands the producer hints to "fix"
 * something that is already right, and the phase burns its retries and lands
 * `incomplete`. Measured: 9/9 → 4/9 on a work order (ace#1609), 9/9 → 4/9 on
 * a PDD (ace#1617), 8/8 → 2/8 on a 58-prompt test-prompt suite (ace#2169).
 *
 * THE INVARIANT, stated narrowly enough to be true: a `*-qa` skill whose
 * `checks.ts` anchors on markdown SYNTAX must name an `exportAs` in its
 * SKILL.md, so the format is a decision someone made rather than one the agent
 * improvises per run. Most QA skills read YAML, JSON or non-Drive artifacts
 * and are correctly silent about it — those are not in scope here.
 *
 * THIS IS A RATCHET, NOT A BLANKET RULE. `KNOWN_UNFIXED` below holds the
 * instances that exist today and have not been through the per-skill
 * derivation. A NEW markdown-anchoring QA skill cannot join that list. Landing
 * a red test on main is the gap PR #952 closed; do not reopen it.
 */

import { describe, expect, test } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';

const SKILLS_DIR = join(__dirname, '..', '..', 'skills');

/**
 * QA skills that have been through the per-skill derivation and carry an
 * explicit `exportAs` mandate, with the format each one landed on. The two
 * PDD-adjacent ones are deliberately OPPOSITE — that is the point of the
 * class, not an inconsistency.
 */
const MANDATED: Record<string, 'text/plain' | 'text/markdown'> = {
  // Reads a PDD written by `drive_create_doc_from_markdown` — real heading
  // styles, so plain text drops every `#` the checks match (ace#1617).
  'idea-to-pdd-qa': 'text/markdown',
  // Reads a rendered work-order gdoc, but its checks match the unescaped
  // plain-text form, which markdown escaping defeats (ace#1609).
  'pdd-to-work-order-qa': 'text/plain',
  // Reads an artifact written by `drive_create_file` — a Google Doc whose
  // body is LITERAL markdown, which the markdown export escapes (ace#2169).
  'pdd-to-test-prompts-qa': 'text/plain',
};

/**
 * Markdown-anchoring QA skills that predate the invariant and have NOT been
 * through the derivation. Each entry is a latent instance, not a live failure:
 * they get the right text today only because nobody has passed the other
 * format yet — which is exactly how ace#2169 sat until one run happened to.
 *
 * To retire an entry: work out which format that skill's checks need (from its
 * producer's writer atom and its own anchors), mandate it in SKILL.md, route
 * the checks through `normalizeDriveExport`, then MOVE the entry into
 * `MANDATED`. The list is asserted to be exact, so a fixed skill left here
 * fails too — it cannot rot.
 */
const KNOWN_UNFIXED: string[] = [
  // Producer writes with `drive_create_file`; checks anchor on `^##` and
  // `**bold**`. Same shape as ace#2169 — tracked separately, out of that
  // issue's scope.
  'solicitation-review-qa',
];

/**
 * Does this `checks.ts` match markdown SYNTAX (as opposed to structure that
 * survives either export)? Three anchor families, each observed in a real
 * instance of the class:
 *   - heading markers   `^#`, `^##`  → ace#1617, ace#2169
 *   - bold runs         `\*\*`       → ace#2169
 *   - pipe-table cells  `^\s*\|`     → ace#1609
 */
function anchorsOnMarkdownSyntax(source: string): boolean {
  const HEADING_ANCHOR = /\^#|\^\\{1,2}#|\^\\s\*#/;
  const BOLD_ANCHOR = /\\\\\*\\\\\*|\\\*\\\*/;
  const PIPE_TABLE_ANCHOR = /\^\\s\*\\\|/;
  return (
    HEADING_ANCHOR.test(source) || BOLD_ANCHOR.test(source) || PIPE_TABLE_ANCHOR.test(source)
  );
}

function qaSkillsWithChecks(): { name: string; checks: string; skill: string }[] {
  return readdirSync(SKILLS_DIR)
    .filter((n) => n.endsWith('-qa'))
    .filter((n) => existsSync(join(SKILLS_DIR, n, 'checks.ts')))
    .map((n) => ({
      name: n,
      checks: readFileSync(join(SKILLS_DIR, n, 'checks.ts'), 'utf-8'),
      skill: readFileSync(join(SKILLS_DIR, n, 'SKILL.md'), 'utf-8'),
    }));
}

describe('*-qa Drive export format (ace#1609 / ace#1617 / ace#2169)', () => {
  const skills = qaSkillsWithChecks();

  test('the survey finds QA skills at all (guards a silently-empty sweep)', () => {
    expect(skills.length).toBeGreaterThanOrEqual(6);
  });

  test('every markdown-anchoring QA skill is either mandated or on the ratchet', () => {
    const unaccounted = skills
      .filter((s) => anchorsOnMarkdownSyntax(s.checks))
      .map((s) => s.name)
      .filter((n) => !(n in MANDATED) && !KNOWN_UNFIXED.includes(n));

    expect(
      unaccounted,
      'These *-qa skills anchor on markdown syntax but name no exportAs in SKILL.md. ' +
        'Work out which export their checks need (see the header of this file) and ' +
        'mandate it — do NOT add them to KNOWN_UNFIXED, which is closed to new entries.',
    ).toEqual([]);
  });

  test.each(Object.entries(MANDATED))(
    '%s mandates exportAs: %s',
    (name, format) => {
      const skill = skills.find((s) => s.name === name);
      expect(skill, `${name} has no checks.ts — did the skill move?`).toBeDefined();
      expect(skill!.skill).toContain(`exportAs: '${format}'`);
      // The mandate must be stated as a requirement, not mentioned in passing.
      expect(skill!.skill).toMatch(/REQUIRED here, not optional/);
    },
  );

  test.each(Object.entries(MANDATED))(
    '%s normalises drive-export escaping so the format is not load-bearing (%s)',
    (name) => {
      const skill = skills.find((s) => s.name === name)!;
      expect(
        skill.checks,
        `${name}/checks.ts must route through normalizeDriveExport — the mandate says ` +
          'which format to pass, this is what makes passing the other one non-fatal.',
      ).toContain('normalizeDriveExport');
    },
  );

  test('the ratchet list is exact — a fixed skill must be moved out of it', () => {
    for (const name of KNOWN_UNFIXED) {
      const skill = skills.find((s) => s.name === name);
      expect(skill, `KNOWN_UNFIXED names ${name}, which has no checks.ts`).toBeDefined();
      expect(
        anchorsOnMarkdownSyntax(skill!.checks),
        `${name} no longer anchors on markdown syntax — remove it from KNOWN_UNFIXED.`,
      ).toBe(true);
      expect(
        skill!.skill.includes('exportAs'),
        `${name} now names an exportAs — move it from KNOWN_UNFIXED into MANDATED.`,
      ).toBe(false);
    }
  });

  test('MANDATED and KNOWN_UNFIXED are disjoint', () => {
    const overlap = Object.keys(MANDATED).filter((n) => KNOWN_UNFIXED.includes(n));
    expect(overlap).toEqual([]);
  });
});
