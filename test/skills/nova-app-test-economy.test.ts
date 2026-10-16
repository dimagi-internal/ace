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
