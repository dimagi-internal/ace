/**
 * Archetype enumeration drift detector (ace#1486).
 *
 * `longitudinal-visits` shipped on 2026-08-17 (13a14cfa): it landed in
 * `skills/idea-to-pdd-qa/checks.ts § VALID_ARCHETYPES` and in
 * `skills/pdd-to-work-order-qa/checks.ts`'s scope branch, but NOT in the three
 * prose surfaces that tell authors and producers which archetypes exist. Two
 * of those still enumerated the old three-item set, and
 * `skills/pdd-to-work-order/SKILL.md § Archetypes` had no branch for it at all
 * — so the executable checks demanded a longitudinal marker that the guidance
 * a producer follows never mentioned. Filed ten hours later, from a run that
 * tripped the resulting check-7 blocker.
 *
 * The class: an archetype is added to code and the prose enumerations are
 * updated by hand, or not at all. `VALID_ARCHETYPES` is the single source of
 * truth; this test makes every prose surface answer to it, so adding an
 * archetype fails CI until the guidance catches up.
 *
 * Sibling of `test/skill-atom-references.test.ts` (skills vs atom signatures)
 * and `test/skills/decisions-example-currency.test.ts` (skills vs schema
 * version) — same failure shape, different registry.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Parse the canonical list out of its declaration rather than restating it. */
function validArchetypes(): string[] {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'skills/idea-to-pdd-qa/checks.ts'), 'utf8');
  const m = src.match(/const VALID_ARCHETYPES\s*=\s*\[([^\]]+)\]/);
  if (!m) throw new Error('VALID_ARCHETYPES not found in skills/idea-to-pdd-qa/checks.ts');
  return [...m[1].matchAll(/['"]([a-z-]+)['"]/g)].map((x) => x[1]);
}

const ARCHETYPES = validArchetypes();

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

describe('archetype enumerations track VALID_ARCHETYPES', () => {
  it('parses a plausible canonical list', () => {
    expect(ARCHETYPES).toContain('atomic-visit');
    expect(ARCHETYPES.length).toBeGreaterThanOrEqual(3);
  });

  // Every prose surface that tells a human or a producer which archetypes
  // exist. A surface missing an archetype is guidance that contradicts the
  // check the producer will be graded by.
  it.each([
    ['skills/idea-to-pdd-qa/SKILL.md', 'the check-2 row a PDD author reads'],
    ['skills/pdd-to-work-order-qa/SKILL.md', 'the check-7 row describing per-archetype scope'],
    ['skills/pdd-to-work-order/SKILL.md', '§ Archetypes — the branch the producer follows'],
  ])('%s names every archetype (%s)', (rel, _why) => {
    const text = read(rel);
    const missing = ARCHETYPES.filter((a) => !text.includes(a));
    expect(
      missing,
      `${rel} does not mention: ${missing.join(', ')}. An archetype in VALID_ARCHETYPES ` +
        'but absent from the guidance is how ace#1486 happened — the executable check ' +
        'demanded a condition the prose never stated.',
    ).toEqual([]);
  });

  // The work-order producer branches on archetype for scope/verification/
  // payment/RACI, so a bare mention is not enough — it needs its own section.
  it('pdd-to-work-order § Archetypes has a heading per archetype', () => {
    const text = read('skills/pdd-to-work-order/SKILL.md');
    const section = text.slice(text.indexOf('\n## Archetypes'));
    const headed = [...section.matchAll(/^###\s+`([a-z-]+)`/gm)].map((m) => m[1]);
    const missing = ARCHETYPES.filter((a) => !headed.includes(a));
    expect(
      missing,
      `§ Archetypes has no \`### \` branch for: ${missing.join(', ')}. Without one the ` +
        'producer has no scope/verification/payment/RACI guidance for that archetype.',
    ).toEqual([]);
  });
});
