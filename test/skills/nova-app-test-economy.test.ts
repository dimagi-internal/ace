import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The Nova brief must keep app-test output small: Nova has no compact/delta
 * result mode (voidcraft-labs/nova-plugin#71), each continue_app_test result
 * measured 35–108 KB (~30 per build), and the kaduna-graduation/20261015-1411
 * Deliver architect reached
 * ~944k context and its 250-turn cap. Batching is the half ACE controls.
 */
const REPO = path.resolve(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(REPO, p), 'utf8');

describe('Nova brief: app-test economy', () => {
  const deliver = read('skills/pdd-to-deliver-app/SKILL.md');
  const learn = read('skills/pdd-to-learn-app/SKILL.md');

  it('the Deliver brief carries the REQUIRED paragraph with the batching contract', () => {
    expect(deliver).toContain('> REQUIRED: Keep app-test output small');
    expect(deliver).toMatch(/up to 8 `actions` per\s+> call, each with an `expect`/);
    expect(deliver).toContain('read_app_test');
    expect(deliver).toContain('voidcraft-labs/nova-plugin#71');
  });

  it('the Learn brief inserts the same paragraph by reference, not a paraphrase', () => {
    expect(learn).toMatch(/App-test economy \(always\)/);
    expect(learn).toContain('skills/pdd-to-deliver-app/SKILL.md');
    expect(learn).toContain('voidcraft-labs/nova-plugin#71');
  });
});

/**
 * ace#3124: the add_fields count check used to say "immediately call get_form",
 * which contradicted the economy paragraph's "do not call get_form", and the
 * ace#3078 arm-A architect made 0 get_form calls — the check silently never
 * ran. The count now comes from the add_fields result's `fields` array (25/25
 * successful calls echoed exactly the fields sent), with get_form only on a
 * short count.
 */
describe('Nova brief: add_fields count check does not contradict app-test economy', () => {
  const briefs = {
    deliver: read('skills/pdd-to-deliver-app/SKILL.md'),
    learn: read('skills/pdd-to-learn-app/SKILL.md'),
  };
  for (const [name, text] of Object.entries(briefs)) {
    it(`${name}: counts from the add_fields result, get_form only when short`, () => {
      expect(text).not.toMatch(/After EVERY `add_fields` call, immediately call `get_form`/);
      expect(text).toMatch(/After EVERY `add_fields` call, count the entries in the result's\s+> `fields` array/);
    });
  }
});

/**
 * ace#3078 arm A: the lookup catalog is project-wide (56 tables, ~35 KB per
 * read, three reads) because every ACE build shares one Nova Project.
 */
describe('Nova brief: lookup catalog is read once and scoped to this run', () => {
  const lib = read('skills/_app-component-library.md');
  it('says at most once, project-wide, and never another opp\'s table', () => {
    expect(lib).toContain('at most once per build');
    expect(lib).toContain('PROJECT-WIDE');
    expect(lib.match(/never\s+(?:>\s*)?bind another opp's table/g)?.length).toBe(2);
  });
});
