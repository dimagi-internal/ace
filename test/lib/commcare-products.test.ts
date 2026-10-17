/**
 * dimagi-internal/ace#2157 — a componentized Phase 3 had nowhere declared to
 * record which components each app built. `CommcareProducts` is `.strict()`
 * with only `apps`, so `poverty-graduation/20260905-1345` smuggled the fact
 * through the `.passthrough()` app entries under two spellings
 * (`components_covered` on Learn, `components_built` on Deliver).
 *
 * Operator decision 2026-10-16: the key is `components_built`, per app. These
 * tests validate the BUILDER's own output against the schema (the #1999
 * pattern), so producer and schema cannot drift apart again.
 */
import { describe, it, expect } from 'vitest';
import {
  buildCommcareProducts,
  learnComponentsBuilt,
  CommcareProductsError,
} from '../../lib/commcare-products';
import { planLearnModules } from '../../lib/learn-module-plan';
import {
  validatePhaseProductsComplete,
  validatePhaseProductsFragment,
} from '../../lib/phase-products-schema';
import { AppsProductsSchema } from '../../lib/products-apps-schema';

// The component set poverty-graduation/20260905-1345 actually built (run_state
// `phases.commcare-setup.products.apps.*.components_*` — ["2","4","5","6"]).
const PHASE1_COMPONENTS = ['2', '4', '5', '6'].map((id) => ({
  component_id: id,
  title: `Component ${id}`,
  pdd_file_id: `pdd-${id}`,
}));

const learnFacts = (components_built?: string[]) => ({
  name: 'Graduation Learn',
  nova_app_id: 'nova-learn-1',
  hq_app_id: 'hq-learn-1',
  hq_url: 'https://www.commcarehq.org/a/connect-ace-prod/apps/view/hq-learn-1/',
  build_status: 'success' as const,
  ...(components_built ? { components_built } : {}),
});
const deliverFacts = (components_built?: string[]) => ({
  name: 'Graduation Deliver',
  nova_app_id: 'nova-deliver-1',
  hq_app_id: 'hq-deliver-1',
  hq_url: 'https://www.commcarehq.org/a/connect-ace-prod/apps/view/hq-deliver-1/',
  build_status: 'success' as const,
  ...(components_built ? { components_built } : {}),
});

describe('buildCommcareProducts — componentized (ace#2157)', () => {
  const plan = planLearnModules({ components: PHASE1_COMPONENTS });
  const built = buildCommcareProducts({
    components: PHASE1_COMPONENTS,
    learn: learnFacts(learnComponentsBuilt(plan)),
    deliver: deliverFacts(['6', '2', '5', '4', '2']),
  });

  it('records components_built per app, deduped and in component order', () => {
    expect(built.apps.learn?.components_built).toEqual(['2', '4', '5', '6']);
    expect(built.apps.deliver?.components_built).toEqual(['2', '4', '5', '6']);
    expect(built.apps.learn?.nova_url).toBe('https://commcare.app/build/nova-learn-1');
  });

  it('validates as a complete commcare-setup products block', () => {
    const res = validatePhaseProductsComplete('commcare-setup', built);
    expect(res.issues).toEqual([]);
    expect(res.valid).toBe(true);
  });

  it('survives AppsProductsSchema.parse — components_built is not stripped', () => {
    const parsed = AppsProductsSchema.parse(built.apps);
    expect(parsed.learn.components_built).toEqual(['2', '4', '5', '6']);
  });

  it('refuses an app with no components_built on a componentized run', () => {
    expect(() =>
      buildCommcareProducts({ components: PHASE1_COMPONENTS, learn: learnFacts() }),
    ).toThrow(CommcareProductsError);
  });

  it('refuses a component Phase 1 never declared', () => {
    expect(() =>
      buildCommcareProducts({ components: PHASE1_COMPONENTS, deliver: deliverFacts(['2', '3']) }),
    ).toThrow(/never declared: 3/);
  });
});

describe('buildCommcareProducts — synthesized path is unchanged', () => {
  it('emits no components_built and validates', () => {
    const built = buildCommcareProducts({ learn: learnFacts(), deliver: deliverFacts() });
    expect(built.apps.learn).not.toHaveProperty('components_built');
    expect(validatePhaseProductsComplete('commcare-setup', built).valid).toBe(true);
  });

  it('refuses components_built without Phase-1 components', () => {
    expect(() => buildCommcareProducts({ deliver: deliverFacts(['2']) })).toThrow(
      /synthesized run/,
    );
  });
});

describe('schema still rejects the drift it replaces', () => {
  it('rejects components_built at the products level (it is per app)', () => {
    const res = validatePhaseProductsFragment('commcare-setup', {
      apps: {},
      components_built: ['2'],
    });
    expect(res.valid).toBe(false);
  });

  it('rejects a mistyped components_built inside an app entry', () => {
    const res = validatePhaseProductsFragment('commcare-setup', {
      apps: { learn: { components_built: [] } },
    });
    expect(res.valid).toBe(false);
  });
});
