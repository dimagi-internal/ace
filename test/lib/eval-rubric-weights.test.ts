import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Class-level preventer for the drift class ace#1187 walked into: a rubric
// revision that SPLITS, ADDS, or REWEIGHTS a dimension has to keep the
// dimension weights summing to 1.0, and nothing checked that. The weighted
// mean is computed by an LLM judge reading this table at runtime, so a table
// summing to 0.97 or 1.03 does not throw anywhere — it silently rescales
// every score in that rubric, and the resulting drift is indistinguishable
// from judge variance.
//
// (ace#1187 split `assessment_discrimination` 0.08 -> 0.05 + a new
// `assessment_operation_coverage` 0.03. That arithmetic was hand-checked.
// This test is so the next one doesn't have to be.)
//
// Scope: every `skills/*-eval/SKILL.md` yaml block that declares a
// `dimensions:` map using the inline `name: { weight: N }` shape. Rubrics
// that carry no inline weights (the training-* family scores unweighted) are
// skipped by construction — they have no sum to check.

const TOLERANCE = 0.005;

interface WeightBlock {
  blockIndex: number;
  weights: { name: string; weight: number }[];
  sum: number;
}

function extractYamlBlocks(source: string): string[] {
  const lines = source.split('\n');
  const blocks: string[] = [];
  let inBlock = false;
  let buf: string[] = [];
  for (const line of lines) {
    if (!inBlock && /^\s*```ya?ml\s*$/.test(line)) {
      inBlock = true;
      buf = [];
      continue;
    }
    if (inBlock && /^\s*```\s*$/.test(line)) {
      blocks.push(buf.join('\n'));
      inBlock = false;
      continue;
    }
    if (inBlock) buf.push(line);
  }
  return blocks;
}

export function findWeightBlocks(source: string): WeightBlock[] {
  const out: WeightBlock[] = [];
  const blocks = extractYamlBlocks(source);
  for (let i = 0; i < blocks.length; i++) {
    const body = blocks[i];
    if (!/^\s*dimensions:\s*$/m.test(body)) continue;
    const weights: { name: string; weight: number }[] = [];
    for (const m of body.matchAll(
      /^\s*([a-z_][a-z0-9_]*):\s*\{[^}]*weight:\s*([0-9.]+)[^}]*\}/gm,
    )) {
      weights.push({ name: m[1], weight: Number.parseFloat(m[2]) });
    }
    if (weights.length === 0) continue;
    out.push({
      blockIndex: i,
      weights,
      sum: weights.reduce((a, w) => a + w.weight, 0),
    });
  }
  return out;
}

function listEvalSkills(skillsDir: string): string[] {
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.endsWith('-eval'))
    .map((d) => d.name)
    .sort();
}

describe('eval rubric dimension weights', () => {
  const skillsDir = join(process.cwd(), 'skills');
  const evalSkills = listEvalSkills(skillsDir);

  // Synthetic fixtures first: if the extractor silently found nothing, every
  // per-skill assertion below would pass vacuously.
  describe('detection — synthetic fixtures', () => {
    const wrap = (body: string) => ['```yaml', body, '```'].join('\n');

    it('sums a well-formed dimensions block to 1.0', () => {
      const src = wrap(
        ['dimensions:', '  alpha: { weight: 0.6 }', '  beta:  { weight: 0.4 }'].join('\n'),
      );
      const found = findWeightBlocks(src);
      expect(found).toHaveLength(1);
      expect(found[0].sum).toBeCloseTo(1.0, 5);
      expect(found[0].weights.map((w) => w.name)).toEqual(['alpha', 'beta']);
    });

    it('catches a block that no longer sums to 1.0 (the split-a-dimension defect)', () => {
      // 0.08 split into 0.05 + 0.02 instead of 0.05 + 0.03 — the ace#1187 near-miss.
      const src = wrap(
        [
          'dimensions:',
          '  gating:        { weight: 0.92 }',
          '  discrimination: { weight: 0.05 }',
          '  coverage:      { weight: 0.02 }',
        ].join('\n'),
      );
      const found = findWeightBlocks(src);
      expect(found).toHaveLength(1);
      expect(Math.abs(found[0].sum - 1.0)).toBeGreaterThan(TOLERANCE);
    });

    it('tolerates trailing comments and mid-brace fields', () => {
      const src = wrap(
        [
          'dimensions:',
          '  alpha: { weight: 0.5 }   # null + redistribute when N/A',
          '  beta:  { score: null, weight: 0.5 }',
        ].join('\n'),
      );
      const found = findWeightBlocks(src);
      expect(found[0].sum).toBeCloseTo(1.0, 5);
    });

    it('ignores yaml blocks that declare no dimensions map', () => {
      const src = wrap(['verdict: pass', 'overall_score: 8.2'].join('\n'));
      expect(findWeightBlocks(src)).toEqual([]);
    });
  });

  it('finds weighted rubrics across the eval-skill family', () => {
    const withWeights = evalSkills.filter(
      (s) => findWeightBlocks(readFileSync(join(skillsDir, s, 'SKILL.md'), 'utf8')).length > 0,
    );
    // Guards against a rename/relocation that makes every check below vacuous.
    expect(withWeights.length).toBeGreaterThanOrEqual(25);
  });

  for (const skill of evalSkills) {
    it(`${skill}/SKILL.md dimension weights sum to 1.0`, () => {
      const source = readFileSync(join(skillsDir, skill, 'SKILL.md'), 'utf8');
      const blocks = findWeightBlocks(source);
      for (const block of blocks) {
        const detail = block.weights.map((w) => `${w.name}=${w.weight}`).join(', ');
        expect(
          Math.abs(block.sum - 1.0),
          `skills/${skill}/SKILL.md yaml block ${block.blockIndex} weights sum to ` +
            `${block.sum.toFixed(4)}, not 1.0 — the weighted mean silently rescales. ` +
            `Dimensions: ${detail}`,
        ).toBeLessThanOrEqual(TOLERANCE);
      }
    });
  }

  // ace#1206: the blind-probe redesign is only half-applied if the rubric drops
  // the two probe dimensions but never lands the structural one that carries
  // their combined weight.
  it('pdd-to-learn-app-eval declares assessment_rule_coverage', () => {
    const source = readFileSync(join(skillsDir, 'pdd-to-learn-app-eval', 'SKILL.md'), 'utf8');
    const names = findWeightBlocks(source).flatMap((b) => b.weights.map((w) => w.name));
    expect(names).toContain('assessment_rule_coverage');
  });

  // ace#1206: the retired probe dimensions must not come back as WEIGHTED
  // dimensions without a deliberate decision. Both hard-gated on an LLM
  // "untrained field persona" reader standing in for a low-literacy CHW — a
  // proxy that was never validated against a real CHW, and whose gate was
  // arithmetically the same statistic the rubric had just declared too noisy to
  // gate on (`delta <= 1 - untrained_ratio`, tight whenever the trained reader
  // scores 100%). Prose in the change log is not enough to stop a future
  // revision reinstating them; this assertion is.
  it('pdd-to-learn-app-eval does not reinstate the retired probe dimensions', () => {
    const source = readFileSync(join(skillsDir, 'pdd-to-learn-app-eval', 'SKILL.md'), 'utf8');
    const names = findWeightBlocks(source).flatMap((b) => b.weights.map((w) => w.name));
    expect(names).not.toContain('assessment_discrimination');
    expect(names).not.toContain('assessment_operation_coverage');
  });
});
