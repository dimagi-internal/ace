/**
 * The documented check count must equal the actual `CHECKS.length`.
 *
 * Why this exists (dimagi-internal/ace#2272). Every Phase-1 QA skill states its
 * check count in prose, in two places — its own `SKILL.md` header and
 * `agents/idea-to-design.md`, which is what the phase agent reads. Nothing
 * pinned either to the array, so every check added since the skills shipped left
 * the counts behind: `idea-to-pdd-qa` ran 10 while documented as 6, and
 * `pdd-to-work-order-qa` ran 14 while documented as 10 (SKILL.md) and 8 (agent
 * def). Measured on bednet-check-2-visit/20260908-1544, where the runner
 * reported `checks_run: 10` and `checks_run: 14`.
 *
 * The count alone is cosmetic; what made it expensive is that the agent
 * definition ENUMERATED the original six by name, which reads as the complete
 * list. The four it omitted for `idea-to-pdd-qa` include
 * `program_parameters_coherent`, `payment_unit_matches_entity_grain` (the
 * ace#1420 guard) and `entity_state_taxonomy_declared_for_longitudinal` (the
 * ace#1783 gate) — the three that most shape the PDD. An agent trusting the
 * enumeration would not know a per-visit rate against a day-scoped grain was
 * going to be rejected, which is the exact defect that reached a signed Work
 * Order on 20260902-1555.
 *
 * The prose deliberately uses DIGITS rather than number words so this test can
 * be a plain regex rather than a word-to-number table. The CHANGELOG rows in
 * those files legitimately record historical counts ("Six static checks" as
 * shipped in 0.13.88) and are NOT matched — the anchor below is the header
 * sentence's "Binary verdict: … N static checks" shape.
 */
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHECKS as PDD_CHECKS } from '../../skills/idea-to-pdd-qa/checks';
import { CHECKS as WO_CHECKS } from '../../skills/pdd-to-work-order-qa/checks';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const SKILLS = [
  { slug: 'idea-to-pdd-qa', checks: PDD_CHECKS },
  { slug: 'pdd-to-work-order-qa', checks: WO_CHECKS },
] as const;

describe('Phase-1 QA check counts stay in sync with CHECKS.length', () => {
  test.each(SKILLS)('$slug SKILL.md header states its real check count', ({ slug, checks }) => {
    const body = readFileSync(join(REPO_ROOT, 'skills', slug, 'SKILL.md'), 'utf8');

    // Anchor on the header sentence, not the changelog: the changelog's
    // historical counts are correct as history and must not be rewritten.
    const m = body.match(
      /Binary verdict:\s*pass\s*\/\s*fail\s*\/\s*incomplete\.\s*(\d+)\s+static checks/,
    );
    expect(
      m,
      `${slug}/SKILL.md: no "Binary verdict: pass / fail / incomplete. <N> static checks" sentence ` +
        `found. Use a DIGIT, not a number word — this test is what keeps the count honest (ace#2272).`,
    ).not.toBeNull();

    expect(
      Number(m![1]),
      `${slug}/SKILL.md says ${m![1]} static checks but CHECKS has ${checks.length}. ` +
        `Update the header sentence (and the checks table) when adding a check.`,
    ).toBe(checks.length);
  });

  test.each(SKILLS)('agents/idea-to-design.md states $slug’s real check count', ({ slug, checks }) => {
    const agent = readFileSync(join(REPO_ROOT, 'agents', 'idea-to-design.md'), 'utf8');

    const m = agent.match(
      new RegExp(`\`${slug}\`[^\\n]*?runs\\s+(\\d+)\\s+static structural checks`),
    );
    expect(
      m,
      `agents/idea-to-design.md: no "runs <N> static structural checks" phrase found for ` +
        `\`${slug}\`. The phase agent reads this file, so the count has to live here too (ace#2272).`,
    ).not.toBeNull();

    expect(
      Number(m![1]),
      `agents/idea-to-design.md says ${slug} runs ${m![1]} static checks but CHECKS has ` +
        `${checks.length}. Update the agent definition when adding a check.`,
    ).toBe(checks.length);
  });

  test('the agent definition does not re-enumerate checks it will fall behind on', () => {
    const agent = readFileSync(join(REPO_ROOT, 'agents', 'idea-to-design.md'), 'utf8');

    // The original defect: a parenthetical listing the then-six checks by name,
    // which reads as exhaustive and silently omitted the three that most shape
    // the PDD. A pointer at each skill's own table cannot go stale.
    for (const marker of [
      'sections present, archetype declared, stress-test appendix',
      'evidence-model layered, reviewer-comment table if referenced',
    ]) {
      expect(
        agent.includes(marker),
        `agents/idea-to-design.md still carries the stale inline check enumeration ` +
          `("${marker}"). Point at the skill's own checks table instead — an enumeration here ` +
          `falls behind every time a check is added, and reads as complete while it does ` +
          `(ace#2272).`,
      ).toBe(false);
    }
  });
});
