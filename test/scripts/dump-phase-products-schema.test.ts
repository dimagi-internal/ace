/**
 * Staleness gate for `scripts/dump-phase-products-schema.ts`.
 *
 * `docs/phase-products-schema.json` is the cross-repo single source of truth
 * for the run_state `phases.<phase>.products.*` contract — ace-web reads it.
 * If `lib/phase-products-schema.ts` changes and the JSON isn't regenerated,
 * the two repos drift. This test fails CI until the committed JSON matches.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('dump-phase-products-schema', () => {
  it('docs/phase-products-schema.json is in sync with lib/phase-products-schema.ts', () => {
    const result = spawnSync('npx', ['tsx', 'scripts/dump-phase-products-schema.ts', '--check'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    if (result.status !== 0) {
      throw new Error(
        `dump-phase-products-schema --check failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}\n\n` +
          `Run: npx tsx scripts/dump-phase-products-schema.ts\nand commit docs/phase-products-schema.json.`,
      );
    }
    expect(result.status).toBe(0);
  });

  it('the generated contract covers the phases ace-web summary reads', () => {
    const doc = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'docs', 'phase-products-schema.json'), 'utf-8'),
    );
    for (const phase of ['commcare-setup', 'connect-setup', 'qa-and-training', 'ocs-setup', 'solicitation-management']) {
      expect(doc.phases[phase]).toBeDefined();
      expect(doc.phases[phase].schema).toBeDefined();
    }
    // the two boundary-critical required-key contracts are present
    expect(doc.phases['connect-setup'].requiredProductKeys).toContain('connect.opportunity.url');
    expect(doc.phases['qa-and-training'].requiredProductKeys).toContain('training.deck');
    expect(doc.phases['qa-and-training'].requiredProductKeys).toContain('training.docs.onboarding_email');
  });

  it('the generated contract carries the product-key producers ace-web forks by (ace#2354)', () => {
    const doc = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'docs', 'phase-products-schema.json'), 'utf-8'),
    );
    // The semantics sentence travels WITH the data so a Python reader does not
    // re-derive prefix/wildcard rules from the TypeScript.
    expect(typeof doc.productProducersSemantics).toBe('string');
    expect(doc.productProducersSemantics).toContain('*');
    // The canonical three-writer block is attributed one level down.
    const p7 = doc.phases['synthetic-data-and-workflows'];
    expect(p7.productProducers['synthetic.source']).toBe('demo-data-setup');
    expect(p7.productProducers['synthetic.narrative']).toBe('demo-narrative');
    expect(p7.productProducers['synthetic.ddd_*']).toBe('synthetic-data-and-workflows');
    expect(p7.productProducers.synthetic).toBeUndefined();
    expect(p7.unattributedProductKeys).toEqual([]);
    // Every phase carries the two keys, `null` (not `{}`) meaning "declares none".
    for (const v of Object.values(doc.phases) as any[]) {
      expect('productProducers' in v).toBe(true);
      expect(Array.isArray(v.unattributedProductKeys)).toBe(true);
    }
    expect(doc.phases['idea-to-design'].unattributedProductKeys.map((u: any) => u.key)).toEqual(['decisions_log']);
  });
});
