/**
 * Skill → atom FIELD drift detector (dimagi-internal/ace#1550).
 *
 * `test/skill-atom-references.test.ts` catches the rename/remove half of the
 * skill↔atom drift class: a skill naming an atom that does not exist. It
 * cannot catch the half that actually cost us here — a skill instructing an
 * agent to read a FIELD off an atom's RESULT that the atom never returns.
 * That failure is silent by construction: the atom call succeeds, the field
 * is `undefined`, and a skill with a fallback branch takes the fallback on
 * every run while still reading as a computed check.
 *
 * Canonical case: `connect-program-setup` § Step 4a summed
 * `Σ(total_budget)` over the opportunities of one program to size program-
 * budget headroom. Neither `total_budget` nor any program key was on any
 * opportunity read surface, so the sum was unobtainable on EVERY run and the
 * unknown-Σ branch was the only path that ever executed (ace#1550). Nothing
 * failed; nothing reported; two expensive hydration round-trips per run were
 * spent rediscovering a statically-known absence.
 *
 * Why a TABLE and not a general check: `docs/atom-schemas.md` documents atom
 * PARAMETERS, not return shapes, so "does this atom return field f" cannot be
 * derived generically. This is therefore a ledger — every entry is a claim a
 * skill makes about a result, pinned to the code that has to keep it true.
 * Add a row whenever a skill starts depending on a returned field whose
 * absence would fail silently.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

interface FieldClaim {
  /** The skill that reads the field off a result. */
  skill: string;
  /** The atom whose result carries it. */
  atom: string;
  /** The field the skill reads. */
  field: string;
  /** Type declaration that must declare the field. */
  typeFile: string;
  /** Backend method that must actually populate it, and the file it lives in. */
  implFile: string;
  implMethod: string;
  /** Why its silent absence would matter — quoted into the failure message. */
  why: string;
}

const CLAIMS: FieldClaim[] = [
  {
    skill: 'skills/connect-program-setup/SKILL.md',
    atom: 'connect_list_opportunities',
    field: 'total_budget',
    typeFile: 'mcp/connect/types.ts',
    implFile: 'mcp/connect/backends/playwright.ts',
    implMethod: "getOpportunity: ConnectClient['getOpportunity']",
    why: 'Step 4a sums it to size program-budget headroom; absent, the sum is unobtainable and the step always falls to its unknown-Σ branch (ace#1550).',
  },
  {
    skill: 'skills/connect-program-setup/SKILL.md',
    atom: 'connect_list_opportunities',
    field: 'program_name',
    typeFile: 'mcp/connect/types.ts',
    implFile: 'mcp/connect/backends/playwright.ts',
    implMethod: "getOpportunity: ConnectClient['getOpportunity']",
    why: 'Step 4a scopes the sum to ONE program by name; no read surface carries the program UUID, so without this the sum cannot be scoped at all (ace#1550).',
  },
];

/** The body of the returned object literal of `method` in `src`. */
function returnedObject(src: string, method: string): string {
  const at = src.indexOf(method);
  expect(at, `method not found: ${method}`).toBeGreaterThan(-1);
  const retAt = src.indexOf('return {', at);
  expect(retAt, `no returned object literal in ${method}`).toBeGreaterThan(-1);
  const end = src.indexOf('\n    };', retAt);
  expect(end, `unterminated returned object in ${method}`).toBeGreaterThan(-1);
  return src.slice(retAt, end);
}

describe('a skill may only read result fields the atom actually returns (#1550)', () => {
  for (const c of CLAIMS) {
    describe(`${path.basename(path.dirname(c.skill))} reads ${c.atom} → ${c.field}`, () => {
      it('the skill still makes the claim (drop the row instead of leaving it stale)', () => {
        expect(read(c.skill)).toContain(c.field);
      });

      it(`${c.typeFile} declares the field`, () => {
        expect(read(c.typeFile)).toMatch(new RegExp(`\\b${c.field}\\??:`));
      });

      it(`${c.implMethod.split(':')[0]} actually populates it — ${c.why}`, () => {
        const body = returnedObject(read(c.implFile), c.implMethod);
        expect(body).toMatch(new RegExp(`\\b${c.field}:`));
      });
    });
  }
});

describe('Step 4a keeps its unknown-Σ branch explicit (#1550)', () => {
  // The fields above come off a SCRAPED page, so they can vanish upstream
  // without any code change here. When they do, Step 4a must still describe
  // what to do — and must report that it took the fallback. An unreported
  // fallback is indistinguishable from a working check, which is the whole
  // reason #1550 went unnoticed.
  const skill = read('skills/connect-program-setup/SKILL.md');

  it('names UNKNOWN as a branch, not as an aside', () => {
    expect(skill).toMatch(/Σ is UNKNOWN/);
  });

  it('requires the branch taken to be recorded in the program notes', () => {
    expect(skill).toMatch(/Σ unknown/);
    expect(skill).toMatch(/never write a computed Σ you did not actually\s+compute/i);
  });
});
