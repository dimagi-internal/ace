import { describe, it, expect } from 'vitest';
import {
  validatePhaseProductsFragment,
  validatePhaseProductsComplete,
  classifyPhaseProducts,
  PHASE_PRODUCTS_SCHEMAS,
  REQUIRED_PRODUCT_KEYS,
} from './phase-products-schema.js';

describe('validatePhaseProductsFragment — strict root catches the real drift', () => {
  it('connect-setup: canonical products.connect.{opportunity,program,domain} is valid', () => {
    const r = validatePhaseProductsFragment('connect-setup', {
      connect: {
        domain: 'connect-ace-prod',
        organization_slug: 'ai-demo-space',
        program: { id: 'p1', name: 'Prog', url: 'https://connect.dimagi.com/a/x/program/p1/' },
        opportunity: {
          id: 'o1',
          name: 'Opp',
          url: 'https://connect.dimagi.com/a/x/opportunity/o1/',
          start_date: '2026-06-04',
          end_date: '2026-07-12',
          // internal detail ace-web doesn't read — passthrough must allow it
          int_id: 1949,
          payment_units: [{ id: 2125, amount: 25 }],
        },
      },
    });
    expect(r.valid).toBe(true);
    expect(r.skipped).toBe(false);
  });

  it('connect-setup: the malaria-rdt drift (products.opportunity instead of products.connect) is REJECTED', () => {
    const r = validatePhaseProductsFragment('connect-setup', {
      opportunity: { id: 'o1', url: 'https://connect.dimagi.com/a/x/opportunity/o1/' },
      program: { id: 'p1', url: 'https://connect.dimagi.com/a/x/program/p1/' },
    });
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => /unrecognized/i.test(i.message) && /opportunity/.test(i.message))).toBe(true);
  });

  it('connect-setup: partial fragment (opportunity only, no program) is valid — writes are incremental', () => {
    const r = validatePhaseProductsFragment('connect-setup', {
      connect: { opportunity: { url: 'https://connect.dimagi.com/a/x/opportunity/o1/' } },
    });
    expect(r.valid).toBe(true);
  });

  it('qa-and-training: canonical products.training.{deck,docs.onboarding_email} is valid', () => {
    const r = validatePhaseProductsFragment('qa-and-training', {
      training: {
        deck: { title: 'Training deck', web_view_link: 'https://docs.google.com/presentation/d/abc/edit' },
        docs: {
          onboarding_email: { title: 'Onboarding email', web_view_link: 'https://docs.google.com/document/d/xyz/edit' },
        },
      },
    });
    expect(r.valid).toBe(true);
  });

  it('qa-and-training: the heal drift (products.training_materials) is REJECTED', () => {
    const r = validatePhaseProductsFragment('qa-and-training', {
      training_materials: { deck: { file_id: 'abc' } },
    });
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => /training_materials/.test(i.message))).toBe(true);
  });

  it('commcare-setup: fragment with hq_app_id only is valid', () => {
    const r = validatePhaseProductsFragment('commcare-setup', {
      apps: { learn: { hq_app_id: '0413ee9cebcc485c84b8261e3289db07' } },
    });
    expect(r.valid).toBe(true);
  });

  it('commcare-setup: a malformed hq_url is REJECTED (URL type-check)', () => {
    const r = validatePhaseProductsFragment('commcare-setup', {
      apps: { learn: { hq_app_id: 'x', hq_url: 'not-a-url' } },
    });
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => /hq_url/.test(i.path))).toBe(true);
  });

  it('unregistered phase (scenarios-and-acceptance) is skipped, not failed', () => {
    const r = validatePhaseProductsFragment('scenarios-and-acceptance', { anything: { goes: true } });
    expect(r.valid).toBe(true);
    expect(r.skipped).toBe(true);
  });

  it('null / undefined products is a no-op pass', () => {
    expect(validatePhaseProductsFragment('connect-setup', undefined).valid).toBe(true);
    expect(validatePhaseProductsFragment('connect-setup', null).valid).toBe(true);
  });
});

describe('validatePhaseProductsComplete — boundary completeness', () => {
  it('connect-setup missing connect.opportunity.url is INCOMPLETE at boundary', () => {
    const r = validatePhaseProductsComplete('connect-setup', {
      connect: { domain: 'connect-ace-prod' },
    });
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => /opportunity\.url/.test(i.path))).toBe(true);
  });

  it('connect-setup with both required keys present is complete', () => {
    const r = validatePhaseProductsComplete('connect-setup', {
      connect: {
        domain: 'connect-ace-prod',
        opportunity: { url: 'https://connect.dimagi.com/a/x/opportunity/o1/' },
      },
    });
    expect(r.valid).toBe(true);
  });

  it('qa-and-training without onboarding_email is INCOMPLETE', () => {
    const r = validatePhaseProductsComplete('qa-and-training', {
      training: { docs: { faq: { web_view_link: 'https://docs.google.com/document/d/f/edit' } } },
    });
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => /onboarding_email/.test(i.path))).toBe(true);
  });

  it('a wrong-shape fragment fails the complete check too (shape is gated first)', () => {
    const r = validatePhaseProductsComplete('connect-setup', { opportunity: { url: 'https://x.dev/o' } });
    expect(r.valid).toBe(false);
  });
});

describe('classifyPhaseProducts — boundary-fence classifier', () => {
  it('a DONE phase missing a required handoff key is not ok (mode: complete)', () => {
    const parsed = {
      phases: { 'qa-and-training': { status: 'done', products: { training: { docs: { faq: { web_view_link: 'https://docs.google.com/document/d/f/edit' } } } } } },
    };
    const r = classifyPhaseProducts(parsed, 'qa-and-training');
    expect(r.mode).toBe('complete');
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => /onboarding_email/.test(i.path))).toBe(true);
  });

  it('a DONE phase with all required keys is ok', () => {
    const parsed = {
      phases: { 'connect-setup': { status: 'done', products: { connect: { domain: 'connect-ace-prod', opportunity: { url: 'https://connect.dimagi.com/a/x/opportunity/o1/' } } } } },
    };
    const r = classifyPhaseProducts(parsed, 'connect-setup');
    expect(r.mode).toBe('complete');
    expect(r.ok).toBe(true);
  });

  it('an IN-FLIGHT phase (not done) only shape-checks — a partial fragment is ok', () => {
    const parsed = {
      phases: { 'connect-setup': { status: 'in_progress', products: { connect: { domain: 'connect-ace-prod' } } } },
    };
    const r = classifyPhaseProducts(parsed, 'connect-setup');
    expect(r.mode).toBe('fragment');
    expect(r.ok).toBe(true); // missing opportunity.url is fine pre-done
  });

  it('an IN-FLIGHT phase with a drifted shape still fails the shape check', () => {
    const parsed = {
      phases: { 'connect-setup': { status: 'in_progress', products: { opportunity: { url: 'https://x.dev/o' } } } },
    };
    const r = classifyPhaseProducts(parsed, 'connect-setup');
    expect(r.mode).toBe('fragment');
    expect(r.ok).toBe(false);
  });

  it('a phase with no registered schema is skipped', () => {
    const parsed = { phases: { 'scenarios-and-acceptance': { status: 'done', products: { x: 1 } } } };
    const r = classifyPhaseProducts(parsed, 'scenarios-and-acceptance');
    expect(r.mode).toBe('skipped');
    expect(r.ok).toBe(true);
  });

  it('an absent phase block is ok/skipped-safe (no crash on null run_state)', () => {
    expect(classifyPhaseProducts(null, 'connect-setup').ok).toBe(true);
    expect(classifyPhaseProducts({ phases: {} }, 'connect-setup').status).toBeUndefined();
  });
});

describe('registry coverage', () => {
  it('every phase with a REQUIRED_PRODUCT_KEYS entry has a registered schema', () => {
    for (const phase of Object.keys(REQUIRED_PRODUCT_KEYS)) {
      expect(PHASE_PRODUCTS_SCHEMAS[phase as keyof typeof PHASE_PRODUCTS_SCHEMAS]).toBeDefined();
    }
  });
});
