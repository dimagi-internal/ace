/**
 * The Phase 9 `llo-launch` gate refuses activation on a STALE deep verdict.
 * It decides staleness by reading `artifact_refs.<field>` off each verdict and
 * comparing it to the artifact's current state. That only works if the skill
 * that WRITES the verdict is told to emit the field.
 *
 * It was not, on the OCS side. `llo-launch` § step 4 has always read
 * `artifact_refs.version_number` from `ocs-chatbot-eval_verdict-deep.yaml`,
 * while `skills/ocs-chatbot-eval/SKILL.md` mentioned `artifact_refs` exactly
 * zero times and documented a verdict shape without it. `app-ux-eval` — the
 * other half of the same gate — documents it twice, so the app side worked and
 * the asymmetry was invisible.
 *
 * Found on `spark-facilitator/20260828-0703`: the deep verdict written
 * 2026-09-04 carried no `artifact_refs`, so the OCS freshness comparison had
 * nothing to read. A consumer that documents a contract its producer does not
 * implement is not a gate.
 *
 * This test is the drift detector: for every `artifact_refs.<field>` that
 * `llo-launch` reads off a named verdict file, the producing skill must
 * document that field.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/** verdict filename stem -> the skill that produces it. */
const PRODUCER_OF: Record<string, string> = {
  'ocs-chatbot-eval_verdict-deep.yaml': 'skills/ocs-chatbot-eval/SKILL.md',
  'app-ux-eval_verdict-deep.yaml': 'skills/app-ux-eval/SKILL.md',
};

describe('Phase 9 freshness gate — every field the consumer reads, a producer writes', () => {
  const gate = read('skills/llo-launch/SKILL.md');

  it('llo-launch still gates on artifact_refs (guards this test against silent removal)', () => {
    expect(gate).toContain('artifact_refs');
  });

  for (const [verdictFile, producerPath] of Object.entries(PRODUCER_OF)) {
    it(`${verdictFile}: its producer documents artifact_refs`, () => {
      const producer = read(producerPath);
      expect(
        producer.includes('artifact_refs'),
        `${producerPath} never mentions artifact_refs, but llo-launch reads it off ` +
          `${verdictFile} to decide verdict freshness. A gate that reads a field no ` +
          `producer writes is not a gate.`,
      ).toBe(true);
    });

    it(`${verdictFile}: its producer shows artifact_refs in the verdict YAML shape`, () => {
      const producer = read(producerPath);
      // Must appear as a YAML key in a fenced block, not only in prose.
      expect(
        /^\s*artifact_refs:\s*$/m.test(producer),
        `${producerPath} mentions artifact_refs but never shows it as a YAML key in the ` +
          `verdict shape. An agent copies the shape, not the prose.`,
      ).toBe(true);
    });
  }

  it('the OCS producer names version_number, the field llo-launch compares', () => {
    const producer = read(PRODUCER_OF['ocs-chatbot-eval_verdict-deep.yaml']);
    expect(producer).toMatch(/version_number/);
  });

  it('the app producer names both build ids llo-launch compares', () => {
    const producer = read(PRODUCER_OF['app-ux-eval_verdict-deep.yaml']);
    expect(producer).toMatch(/learn_build_id/);
    expect(producer).toMatch(/deliver_build_id/);
  });
});
