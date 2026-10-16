import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { validatePhaseProductsFragment } from '../../lib/phase-products-schema.js';

/**
 * `products.synthetic.source` is typed (ace#2318).
 *
 * `spark-facilitator/20260908-2215` wrote `source.dashboards` as bare strings
 * (`[programme_overview, weekly_review]`) and dropped `data_shape`,
 * `detectable_signal` and `render_reset` — the producer's own QA had quoted
 * them, so the loss was at write-back, and `update_yaml_file`'s `validateAs`
 * accepted it because `source` was untyped. Three consumers then lost their
 * inputs silently.
 */

const FIXTURES = join(__dirname, '..', 'fixtures');
// Captured: a real `done` Phase 7 (cascade path), spark-facilitator/20261001-2208.
const CASCADE_RUN = join(FIXTURES, 'decisions-backfill', 'spark-facilitator-20261001-2208', 'run_state.yaml');
const REAL_RUN_STATES = [
  CASCADE_RUN,
  join(FIXTURES, 'release-readiness', 'spark-20260926-1800', 'run_state.yaml'),
  join(FIXTURES, 'training-deck', 'spark-20260926-1800', 'run_state.yaml'),
];

type RunState = { phases: Record<string, { products?: Record<string, unknown> } | undefined> };
const load = (p: string) => parseYaml(readFileSync(p, 'utf8')) as RunState;

function phase7Products(): { synthetic: { source: Record<string, unknown> } } {
  const products = load(CASCADE_RUN).phases['synthetic-data-and-workflows']?.products;
  return structuredClone(products) as { synthetic: { source: Record<string, unknown> } };
}

describe('products.synthetic.source is typed (ace#2318)', () => {
  it('POSITIVE CONTROL: the real cascade-path source block validates', () => {
    const products = phase7Products();
    expect(Array.isArray(products.synthetic.source.dashboards)).toBe(true);
    const r = validatePhaseProductsFragment('synthetic-data-and-workflows', products);
    expect(r.issues).toEqual([]);
    expect(r.valid).toBe(true);
  });

  it('every captured run_state still validates, phase by phase', () => {
    for (const file of REAL_RUN_STATES) {
      for (const [phase, block] of Object.entries(load(file).phases)) {
        if (!block?.products) continue;
        const r = validatePhaseProductsFragment(phase, block.products);
        expect(r.issues, `${file} :: ${phase}`).toEqual([]);
      }
    }
  });

  it('NEGATIVE CONTROL: the 20260908-2215 shape — bare-string dashboards — is rejected', () => {
    const products = phase7Products();
    const dashboards = products.synthetic.source.dashboards as Array<{ key: string }>;
    products.synthetic.source.dashboards = dashboards.map((d) => d.key);
    const r = validatePhaseProductsFragment('synthetic-data-and-workflows', products);
    expect(r.valid).toBe(false);
    expect(r.issues.map((i) => i.path).join('\n')).toMatch(/synthetic\.source\.dashboards/);
  });

  it('NEGATIVE CONTROL: a dashboard object missing its template/role is rejected', () => {
    const products = phase7Products();
    products.synthetic.source.dashboards = [{ key: 'programme', par_url: 'https://x.test/' }];
    expect(validatePhaseProductsFragment('synthetic-data-and-workflows', products).valid).toBe(false);
  });

  it('NEGATIVE CONTROL: a data_shape missing an axis is rejected (demo-narrative 2b needs all three)', () => {
    const products = phase7Products();
    products.synthetic.source.data_shape = { rows: 12, periods: 13 };
    const r = validatePhaseProductsFragment('synthetic-data-and-workflows', products);
    expect(r.valid).toBe(false);
    expect(r.issues.map((i) => i.path).join('\n')).toMatch(/data_shape\.groups/);
  });

  it('NEGATIVE CONTROL: render_reset without its `required` discriminator is rejected', () => {
    const products = phase7Products();
    products.synthetic.source.render_reset = { run_id: 5590, state_keys: ['record_reviews'] };
    expect(validatePhaseProductsFragment('synthetic-data-and-workflows', products).valid).toBe(false);
  });

  it('accepts the documented render_reset, detectable_signal forms and a denovo flat record_counts', () => {
    const products = phase7Products();
    Object.assign(products.synthetic.source, {
      record_counts: { opportunity: 1, user_visits: 276, user_data: 5, completed_works: 0, completed_module: 0 },
      render_reset: {
        required: true,
        run_id: 5590,
        state_keys: ['record_reviews'],
        command: 'bash "$(…)/bin/ace-reset-labs-run" --run-id 5590 --workflow-id 5502',
        verified_at: null,
      },
      detectable_signal: 'none (PDD declares no verification rules)',
    });
    expect(validatePhaseProductsFragment('synthetic-data-and-workflows', products).issues).toEqual([]);
    products.synthetic.source.detectable_signal = { control: 'payability', below_programme_scale: '…' };
    products.synthetic.source.render_reset = { required: false };
    expect(validatePhaseProductsFragment('synthetic-data-and-workflows', products).issues).toEqual([]);
  });
});
