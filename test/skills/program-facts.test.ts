import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

/**
 * The reach half of the program-facts rule.
 *
 * `skills/_program-facts.md` settles the facts more than one artifact asserts —
 * who pays the field worker, the caps, the payment conditions, consent order,
 * the name of each captured field. `skills/reconcile-outputs` catches a
 * violation after the fact.
 *
 * Neither helps if the writer never meets the rule. That is precisely how the
 * terminology rule failed before `connect-terminology.test.ts` added its own
 * reach check: the rule was correct, enforced in one place, and linked by none
 * of the producers, so it got re-litigated per instruction and an outbound
 * email shipped with the retired name.
 *
 * This test makes the LINK structural. A new prose producer cannot be added
 * without inheriting the contract, and `reconcile-outputs` cannot drift away
 * from the file it is named for.
 *
 * Observed on `tekzal/20261013-2314`: the Round 1 work order and all four
 * training documents disagreed on who pays the field worker, and the partner
 * rated the round 2/4 and stopped.
 *
 * Rule: `skills/_program-facts.md`. Detection: `skills/reconcile-outputs`.
 */

const REPO_ROOT = join(__dirname, '..', '..');

/**
 * Every skill that writes an artifact asserting a shared program fact.
 *
 * Linked DIRECTLY rather than transitively through `_training-template.md`.
 * The terminology test learned that lesson the expensive way (ace#3232): a
 * transitive reach was not enough, because a producer that mentions the shared
 * template only for its Drive upload mechanics never meets the rule inside it.
 */
const PROGRAM_FACTS_BOUND = [
  // Settles the facts.
  'skills/idea-to-pdd/SKILL.md',
  // Asserts them in the contract.
  'skills/pdd-to-work-order/SKILL.md',
  // Assert them to the partner and to the worker. These are the five that
  // disagreed with the contract in tekzal Round 1.
  'skills/training-llo-guide/SKILL.md',
  'skills/training-flw-guide/SKILL.md',
  'skills/training-faq/SKILL.md',
  'skills/training-quick-reference/SKILL.md',
  'skills/training-deck-generate/SKILL.md',
  'skills/training-onboarding-email/SKILL.md',
  // The shared training contract, so a future training producer inherits it.
  'skills/_training-template.md',
  // The detector itself.
  'skills/reconcile-outputs/SKILL.md',
];

describe('program facts reach the writer', () => {
  it('every producer of a fact-asserting artifact links the contract', () => {
    const missing = PROGRAM_FACTS_BOUND.filter((rel) => {
      const body = readFileSync(join(REPO_ROOT, rel), 'utf8');
      return !body.includes('_program-facts.md');
    });

    expect(
      missing,
      `These write an artifact that asserts a shared program fact and do not link the\n` +
        `contract, so the writer never sees the rule:\n\n` +
        missing.map((m) => `  ${m}`).join('\n') +
        `\n\nAdd a "## Program facts" section pointing at skills/_program-facts.md.\n` +
        `Catching the contradiction in reconcile-outputs is not enough: by then the wrong\n` +
        `value is already in a document, and the producer will write it again next run.`,
    ).toEqual([]);
  });

  it('every link actually resolves', () => {
    // A pointer to a file that is not there is worse than no pointer: it reads
    // as compliance. Resolve each link relative to the file that carries it,
    // because `skills/_training-template.md` sits one level up from the
    // `skills/<name>/SKILL.md` producers and needs `./` where they need `../`.
    const broken: string[] = [];
    for (const rel of PROGRAM_FACTS_BOUND) {
      const body = readFileSync(join(REPO_ROOT, rel), 'utf8');
      const m = body.match(/\]\((\.{1,2}\/_program-facts\.md)\)/);
      if (!m) {
        broken.push(`${rel}: links the name but not as a resolvable markdown link`);
        continue;
      }
      const target = resolve(dirname(join(REPO_ROOT, rel)), m[1]);
      if (!existsSync(target)) broken.push(`${rel}: ${m[1]} does not resolve`);
    }
    expect(broken, broken.join('\n')).toEqual([]);
  });
});

describe('the program-facts contract still binds', () => {
  const contract = readFileSync(join(REPO_ROOT, 'skills/_program-facts.md'), 'utf8');

  it('states the payment direction with no exception', () => {
    expect(contract).toMatch(/Dimagi pays the partner organization/i);
    expect(contract).toMatch(/never pays an FLW\s*\n?\s*directly/i);
    // The retired wording must stay named, so a future writer recognises it.
    expect(contract).toMatch(/disbursed through Connect directly to the FLW/);
  });

  it('states consent precedes every question', () => {
    expect(contract).toMatch(/Consent precedes \*\*every\*\* question/i);
  });

  it('carries the generic approvals line verbatim', () => {
    // reconcile-outputs' approvals check exists to force prose onto this exact
    // sentence; if the contract stops carrying it there is nothing to converge on.
    expect(contract).toMatch(
      /Take all required approvals from respective authorities for smooth deployment/,
    );
  });

  it('states that translation is the partner’s responsibility', () => {
    expect(contract).toMatch(/Translation is the partner's responsibility/i);
  });

  it('bans device and camera guidance and names the one control that remains', () => {
    expect(contract).toMatch(/No device or camera guidance/i);
    expect(contract).toMatch(/live photo only, no gallery upload/i);
  });

  it('keeps the three rules that govern the per-run table', () => {
    expect(contract).toMatch(/Same count, not just same content/i);
    expect(contract).toMatch(/The caps must multiply out/i);
    expect(contract).toMatch(/One name per field/i);
  });

  it('points at its own detector', () => {
    expect(contract).toMatch(/reconcile-outputs/);
  });
});
