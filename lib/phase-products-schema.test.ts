import { describe, it, expect } from 'vitest';
import {
  validatePhaseProductsFragment,
  validatePhaseProductsComplete,
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

describe('registry coverage', () => {
  it('every phase with a REQUIRED_PRODUCT_KEYS entry has a registered schema', () => {
    for (const phase of Object.keys(REQUIRED_PRODUCT_KEYS)) {
      expect(PHASE_PRODUCTS_SCHEMAS[phase as keyof typeof PHASE_PRODUCTS_SCHEMAS]).toBeDefined();
    }
  });
});
