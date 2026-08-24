import { describe, it, expect } from 'vitest';
import {
  validatePhaseProductsFragment,
  validatePhaseProductsComplete,
  classifyPhaseProducts,
  declaresPerRunTestUser,
  requiredProductKeys,
  PER_RUN_TEST_USER_REQUIRED_KEYS,
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

  it('connect-setup with all required keys present is complete', () => {
    const r = validatePhaseProductsComplete('connect-setup', {
      connect: {
        domain: 'connect-ace-prod',
        opportunity: { url: 'https://connect.dimagi.com/a/x/opportunity/o1/' },
        // Third required key since ace#1184 — proof Step 7's invite read-back
        // actually ran. See the CI-892 incident note in phase-products-schema.ts.
        ace_test_user: { invite_row_present: true },
      },
    });
    expect(r.valid).toBe(true);
  });

  it('connect-setup missing the invite read-back is INCOMPLETE at boundary (ace#1184)', () => {
    const r = validatePhaseProductsComplete('connect-setup', {
      connect: {
        domain: 'connect-ace-prod',
        opportunity: { url: 'https://connect.dimagi.com/a/x/opportunity/o1/' },
      },
    });
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => /ace_test_user\.invite_row_present/.test(i.path))).toBe(true);
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
      phases: { 'connect-setup': { status: 'done', products: { connect: { domain: 'connect-ace-prod', opportunity: { url: 'https://connect.dimagi.com/a/x/opportunity/o1/' }, ace_test_user: { invite_row_present: true } } } } },
    };
    const r = classifyPhaseProducts(parsed, 'connect-setup');
    expect(r.mode).toBe('complete');
    expect(r.ok).toBe(true);
  });

  it('a DONE connect-setup that never read back the invite is NOT ok (ace#1184 / CI-892)', () => {
    // The exact shape Phase 4 shipped on turmeric-market-study/20260807-1903:
    // opportunity created and activated, invite "sent", read-back never run.
    // The boundary fence must refuse this rather than let Phase 6 discover the
    // dead invite a dispatch later.
    const parsed = {
      phases: { 'connect-setup': { status: 'done', products: { connect: { domain: 'connect-ace-prod', opportunity: { url: 'https://connect.dimagi.com/a/x/opportunity/o1/' } } } } },
    };
    const r = classifyPhaseProducts(parsed, 'connect-setup');
    expect(r.mode).toBe('complete');
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => /ace_test_user\.invite_row_present/.test(i.path))).toBe(true);
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

/**
 * dimagi-internal/ace#1289 — the Phase-4 invite gate INVERTS under a per-run
 * demo phone, and the inversion must be inert while `ACE_PER_RUN_TEST_USER` is
 * off. Both halves are asserted here: the default answer is byte-identical, and
 * the per-run answer only ever comes from a products block that DECLARED it.
 */
describe('per-run test user — the required-key inversion (ace#1289)', () => {
  const baseConnect = {
    domain: 'connect-ace-prod',
    opportunity: { url: 'https://connect.dimagi.com/a/x/opportunity/o1/' },
  };

  it('INERT: requiredProductKeys with no products argument is unchanged', () => {
    expect(requiredProductKeys('connect-setup')).toEqual(REQUIRED_PRODUCT_KEYS['connect-setup']);
  });

  it('INERT: a products block that does not declare per_run gets the default set', () => {
    for (const products of [
      undefined,
      {},
      { connect: baseConnect },
      { connect: { ...baseConnect, ace_test_user: { invite_row_present: true } } },
      { connect: { ...baseConnect, ace_test_user: { invite_row_present: true, per_run: false } } },
    ]) {
      expect(requiredProductKeys('connect-setup', undefined, products)).toEqual(
        REQUIRED_PRODUCT_KEYS['connect-setup'],
      );
    }
  });

  it('INERT: today\'s passing Phase-4 block still passes, and today\'s failing one still fails', () => {
    expect(
      validatePhaseProductsComplete('connect-setup', {
        connect: { ...baseConnect, ace_test_user: { invite_row_present: true } },
      }).valid,
    ).toBe(true);
    expect(validatePhaseProductsComplete('connect-setup', { connect: baseConnect }).valid).toBe(false);
  });

  it('declaresPerRunTestUser is true ONLY for a literal per_run: true', () => {
    expect(declaresPerRunTestUser(undefined)).toBe(false);
    expect(declaresPerRunTestUser(null)).toBe(false);
    expect(declaresPerRunTestUser({ connect: { ace_test_user: {} } })).toBe(false);
    expect(declaresPerRunTestUser({ connect: { ace_test_user: { per_run: false } } })).toBe(false);
    // Not truthy-coerced: only the boolean flips the contract.
    expect(declaresPerRunTestUser({ connect: { ace_test_user: { per_run: 'true' } } })).toBe(false);
    expect(declaresPerRunTestUser({ connect: { ace_test_user: { per_run: 1 } } })).toBe(false);
    expect(declaresPerRunTestUser({ connect: { ace_test_user: { per_run: true } } })).toBe(true);
  });

  it('a run that DECLARED per_run must also record the minted phone', () => {
    const r = validatePhaseProductsComplete('connect-setup', {
      connect: {
        ...baseConnect,
        // invite_row_present:false is EXPECTED at Phase 4 under a per-run phone —
        // the ConnectID user does not exist yet, so it must not be the failure.
        ace_test_user: { invite_row_present: false, per_run: true },
      },
    });
    expect(r.valid).toBe(false);
    expect(r.issues.map((i) => i.path)).toContain('products.connect.ace_test_user.phone');
    // ...and specifically NOT because the row was absent.
    expect(r.issues.some((i) => /invite_row_present/.test(i.path))).toBe(false);
  });

  it('a complete per-run Phase-4 block passes with invite_row_present FALSE', () => {
    const r = validatePhaseProductsComplete('connect-setup', {
      connect: {
        ...baseConnect,
        ace_test_user: {
          phone: '+74263120415',
          per_run: true,
          invite_row_present: false,
          connect_user_id: null,
          status: 'unknown',
          checked_at: '2026-08-23T10:00:00Z',
        },
      },
    });
    expect(r.valid).toBe(true);
  });

  it('the per-run set still requires the read-back to have RUN (invite_row_present present)', () => {
    expect(PER_RUN_TEST_USER_REQUIRED_KEYS['connect-setup']).toContain(
      'connect.ace_test_user.invite_row_present',
    );
    const r = validatePhaseProductsComplete('connect-setup', {
      connect: { ...baseConnect, ace_test_user: { phone: '+74263120415', per_run: true } },
    });
    expect(r.valid).toBe(false);
    expect(r.issues.map((i) => i.path)).toContain('products.connect.ace_test_user.invite_row_present');
  });

  it('per_run + registered_at are DECLARED fields, not passthrough leftovers', () => {
    const r = validatePhaseProductsFragment('connect-setup', {
      connect: { ace_test_user: { per_run: true, registered_at: '2026-08-23T10:05:00Z' } },
    });
    expect(r.valid).toBe(true);
    // Wrong type is caught, which is what "declared" buys over passthrough.
    expect(
      validatePhaseProductsFragment('connect-setup', {
        connect: { ace_test_user: { per_run: 'yes' } },
      }).valid,
    ).toBe(false);
  });
});

describe('registry coverage', () => {
  it('every phase with a REQUIRED_PRODUCT_KEYS entry has a registered schema', () => {
    for (const phase of Object.keys(REQUIRED_PRODUCT_KEYS)) {
      expect(PHASE_PRODUCTS_SCHEMAS[phase as keyof typeof PHASE_PRODUCTS_SCHEMAS]).toBeDefined();
    }
  });
});
