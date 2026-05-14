/**
 * Contract-shape tests for the `app-deploy` skill's structured output.
 *
 * `app-deploy` is the sole writer of
 * `run_state.yaml.phases.commcare-setup.products.apps` — a structured
 * Learn + Deliver app handoff consumed by `connect-opp-setup`, `llo-uat`,
 * `llo-launch`, and the ace-web summary view. Each reader unpacks fields
 * directly; silent drift (missing key, malformed URL, unknown status)
 * breaks every downstream consumer.
 *
 * These tests pin the structural contract via a Zod schema in
 * `lib/products-apps-schema.ts` and assert positive + negative shape
 * cases. The schema can be imported by `app-deploy`'s eventual TS
 * implementation to validate before writing.
 *
 * Pattern mirrors `test/skills/nova-contracts.test.ts` — contract on a
 * structured handoff, not on prose. The prose summary
 * (`3-commcare/app-deploy_summary.md`) is LLM-consumed and not asserted
 * here.
 */
import { describe, it, expect } from 'vitest';
import { AppsProductsSchema } from '../../lib/products-apps-schema.js';

function validApp(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    name: 'CHW Training',
    nova_app_id: 'nova-abc-123',
    nova_url: 'https://commcare.app/build/nova-abc-123',
    hq_app_id: 'hq-app-xyz-789',
    hq_url: 'https://www.commcarehq.org/a/connect-ace-prod/apps/view/hq-app-xyz-789/',
    build_status: 'success',
    ...overrides,
  };
}

function validBlock() {
  return {
    learn: validApp({ name: 'CHW Training (Learn)' }),
    deliver: validApp({
      name: 'CHW Visits (Deliver)',
      nova_app_id: 'nova-def-456',
      nova_url: 'https://commcare.app/build/nova-def-456',
      hq_app_id: 'hq-app-uvw-012',
      hq_url: 'https://www.commcarehq.org/a/connect-ace-prod/apps/view/hq-app-uvw-012/',
    }),
  };
}

describe('app-deploy products.apps contract', () => {
  it('accepts a valid Learn + Deliver block', () => {
    const result = AppsProductsSchema.safeParse(validBlock());
    expect(result.success, JSON.stringify(result, null, 2)).toBe(true);
  });

  it('rejects a block missing the learn key', () => {
    const { learn, ...rest } = validBlock();
    void learn;
    expect(AppsProductsSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects a block missing the deliver key', () => {
    const { deliver, ...rest } = validBlock();
    void deliver;
    expect(AppsProductsSchema.safeParse(rest).success).toBe(false);
  });

  it.each([
    ['name', ''],
    ['nova_app_id', ''],
    ['hq_app_id', ''],
  ])('rejects an empty %s on an app entry', (field, value) => {
    const block = validBlock();
    (block.learn as Record<string, unknown>)[field] = value;
    expect(AppsProductsSchema.safeParse(block).success).toBe(false);
  });

  it.each([
    'nova_url',
    'hq_url',
  ])('rejects a non-URL value for %s', (field) => {
    const block = validBlock();
    (block.learn as Record<string, unknown>)[field] = 'not-a-url';
    expect(AppsProductsSchema.safeParse(block).success).toBe(false);
  });

  it('rejects build_status outside the enum {success,errored,pending}', () => {
    const block = validBlock();
    (block.learn as Record<string, unknown>).build_status = 'unknown';
    expect(AppsProductsSchema.safeParse(block).success).toBe(false);
  });

  it.each(['success', 'errored', 'pending'])(
    'accepts build_status=%s',
    (status) => {
      const block = validBlock();
      block.learn.build_status = status as 'success' | 'errored' | 'pending';
      expect(AppsProductsSchema.safeParse(block).success).toBe(true);
    },
  );

  it('rejects a nova_url that does not match https://commcare.app/build/<nova_app_id>', () => {
    const block = validBlock();
    // Valid URL, wrong shape — the legacy `/apps/<id>` route that 404s
    block.learn.nova_url = 'https://commcare.app/apps/nova-abc-123';
    const result = AppsProductsSchema.safeParse(block);
    expect(result.success).toBe(false);
    if (!result.success) {
      // Schema points the user at the right field
      const issues = result.error.issues.map((i) => i.path.join('.'));
      expect(issues).toContain('learn.nova_url');
    }
  });

  it('rejects a nova_url that points to a different nova_app_id than the entry declares', () => {
    const block = validBlock();
    block.learn.nova_app_id = 'nova-abc-123';
    block.learn.nova_url = 'https://commcare.app/build/different-id-999';
    expect(AppsProductsSchema.safeParse(block).success).toBe(false);
  });
});
