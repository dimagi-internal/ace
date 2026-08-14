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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppsProductsSchema } from '../../lib/products-apps-schema.js';

const REPO = join(__dirname, '..', '..');

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

/**
 * dimagi-internal/ace#1331 + #1295 — three skills each assumed that every
 * Deliver form is a paid one.
 *
 * The standard ACE Deliver shape carries an unpaid registration form as a
 * deliberate auxiliary participant with no `deliver_unit` (decided by ROLE,
 * not form type — ace#1327). On bednet-check-2-visit/20260814-0856 that
 * shape tripped two more skills:
 *
 *  - `app-release-eval`'s `deliver_units_enumerable` said "at least one unit
 *    per Deliver-app form = full marks", and defined a deduction only for the
 *    ZERO case — so 2 forms / 1 unit fell in undefined territory that the
 *    literal reading points at a 4-point deduction, on an app that is
 *    correct and was independently verified correct three ways.
 *  - `pdd-to-deliver-app § 4f` HALTS on any free-text field feeding an
 *    `entity_id`. Its stated rationale is payment correctness — "one typo
 *    mints a second payable delivery" — but it fired on an UNPAID unit whose
 *    key is `concat(username, hh_head_name, bednet_given_date)`, where
 *    `hh_head_name` is a household head's personal name on a household being
 *    registered for the first time. There is no roster, so step 4f's own
 *    escape ladder has no rung that fits, and no payment unit exists for
 *    either failure mode to occur through.
 */
describe('the unpaid-registration Deliver shape (#1331, #1295)', () => {
  const read = (p: string) => readFileSync(join(REPO, p), 'utf8');

  it('app-release-eval scores deliver units against PAYABLE stages, not form count', () => {
    const src = read('skills/app-release-eval/SKILL.md');
    expect(src, 'the form-count rule must be gone').not.toMatch(
      /At least one unit per Deliver-app form = full marks/,
    );
    expect(src).toMatch(/payable/i);
    expect(src, 'must still deduct when there are zero units').toMatch(/zero units at all/i);
    expect(src).toMatch(/1331/);
  });

  it('pdd-to-deliver-app 4f halts only when payment can actually be affected', () => {
    const src = read('skills/pdd-to-deliver-app/SKILL.md');
    expect(src).toMatch(/feeds_entity_id\D{0,40}PAYABLE/);
    expect(src, 'must name the unpaid exemption').toMatch(/UNPAID/);
    expect(src, 'must name the non-enumerable-by-nature exemption').toMatch(/non-enumerable BY NATURE/i);
    expect(src, 'exemptions must be recorded, not silent').toMatch(/build memo with the reason/i);
    expect(src).toMatch(/1295/);
  });
});
