/**
 * The ACE winner is awarded as a labs DEMONSTRATION, and only the ACE winner is
 * (dimagi-internal/ace#3257; observed on connect-fi/20261018-1440, response 1000050).
 *
 * Labs' own-side rule keys on the USER: ace@ belongs to the winner org
 * (`connect_orgs.llo_org`), so a plain `create_review` / `award_response` on the
 * seeded winner is refused ("never a response from your own side";
 * connect-labs `solicitations/access.py` `_is_own_side`). Labs' narrow exception
 * is `demonstration: true` on a response created `synthetic: true`, on an
 * unlisted call, by someone who manages it.
 *
 * What this pins:
 *   1. `solicitation-seed-responses` (via `buildCreateResponsePayloads`) marks
 *      every seeded response `synthetic: true` — the marker is creation-only.
 *   2. `solicitation-review` passes `demonstration: true` to both
 *      `create_review` and `award_response`, and every place it names the flag
 *      is gated on `ace_winner` + the seeded winner — never a real award.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..', '..');
const review = readFileSync(join(root, 'skills', 'solicitation-review', 'SKILL.md'), 'utf-8');
const seed = readFileSync(join(root, 'skills', 'solicitation-seed-responses', 'SKILL.md'), 'utf-8');
const lib = readFileSync(join(root, 'lib', 'synthetic-responses.ts'), 'utf-8');

function codeBlockCalling(text: string, atom: string): string {
  const block = text.split('```').find((chunk) => chunk.includes(`mcp__connect-labs__${atom}(`));
  if (!block) throw new Error(`no code block calls ${atom}`);
  return block;
}

describe('ace_winner demonstration award (ace#3257)', () => {
  it('the review skill passes demonstration on create_review and award_response, each gated on ace_winner', () => {
    for (const atom of ['create_review', 'award_response']) {
      const line = codeBlockCalling(review, atom)
        .split('\n')
        .find((l) => /^\s*demonstration:\s*true/.test(l));
      expect(line, `${atom} call names demonstration: true`).toBeDefined();
      expect(line).toMatch(/ONLY/);
      expect(line).toMatch(/ace_winner/);
    }
  });

  it('every mention of the demonstration flag in the review skill sits beside its ace_winner guard', () => {
    const paragraphs = review.split(/\n\s*\n/).filter((p) => /demonstration:\s*true/.test(p));
    expect(paragraphs.length).toBeGreaterThan(0);
    for (const p of paragraphs) {
      const guarded = /ace_winner/.test(p) || /Step 3's rule/.test(p);
      expect(guarded, `unguarded demonstration mention:\n${p}`).toBe(true);
    }
    expect(review).toMatch(/never for a real award/i);
  });

  it('the seed skill and its payload builder carry the synthetic marker', () => {
    expect(seed).toMatch(/synthetic: true/);
    expect(lib).toMatch(/synthetic: true,/);
  });
});
