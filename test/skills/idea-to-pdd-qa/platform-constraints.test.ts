/**
 * idea-to-pdd-qa § platform_constraints on the REAL kaduna PDD (ace#3036).
 *
 * The fixture is a verbatim excerpt of kaduna-graduation/20261015-1411's Phase 1
 * PDD — the run whose role-gated Learn app (9 FLW + 5 enumerator modules)
 * Connect could never complete. It must FAIL at Phase 1; either remedy must
 * clear it; a clean PDD must pass.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { runChecks } from '../../../lib/qa-runner';
import { CHECKS, checkPlatformConstraints } from '../../../skills/idea-to-pdd-qa/checks';

const KADUNA = readFileSync(
  fileURLToPath(new URL('../../fixtures/platform-constraints/kaduna-graduation-20261015-1411-pdd.md', import.meta.url)),
  'utf8',
);
const CLEAN = readFileSync(fileURLToPath(new URL('../../fixtures/ACE-PDD-Pass-001/pdd.md', import.meta.url)), 'utf8');

/** Append rows to the end of § Program Parameters (the last table in the kaduna excerpt). */
function withRows(pdd: string, ...rows: string[]): string {
  const at = pdd.indexOf('| work_order | none this run |');
  return pdd.slice(0, at) + rows.map((r) => `${r}\n`).join('') + pdd.slice(at);
}

describe('kaduna-graduation/20261015-1411 — fails at Phase 1', () => {
  it('the real PDD fails idea-to-pdd-qa on platform_constraints', async () => {
    const result = await runChecks({
      skill: 'idea-to-pdd-qa',
      target: 'kaduna-graduation/20261015-1411',
      capture_path: '1-design/idea-to-pdd.md',
      artifact: KADUNA,
      checks: CHECKS.filter((c) => c.id === 'platform_constraints'),
    });
    expect(result.verdict).toBe('fail');
    expect(result.failures[0].check).toBe('platform_constraints');
    // It read the two-role signal kaduna actually declared (role_property), not a `worker_roles` row it never wrote.
    expect(result.failures[0].detail).toMatch(/learn-module-visibility-undeclared-multi-role.*worker_role_count=2/);
    expect(result.failures[0].auto_fix_hint).toMatch(/learn_module_visibility \| all-workers/);
    expect(result.failures[0].auto_fix_hint).toMatch(/scripts\/platform-constraints\.ts/);
  });

  it('the check itself reports the failure on the verbatim PDD', () => {
    const r = checkPlatformConstraints(KADUNA);
    expect(r.pass).toBe(false);
  });

  it('declaring the role gating it actually built fails on Learn completion', () => {
    const r = checkPlatformConstraints(withRows(KADUNA, '| worker_roles | FLW, enumerator |', '| learn_module_visibility | per-role |'));
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/learn-completion-counts-every-module/);
    expect(r.detail).toMatch(/models\.py:398-406/);
  });

  it('"one opportunity per role" on the same apps fails on the one-active-opportunity rule', () => {
    const r = checkPlatformConstraints(withRows(KADUNA, '| worker_roles | FLW, enumerator |', '| opportunity_structure | per-role |'));
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/one-active-opportunity-per-app/);
  });

  it('either remedy clears it — every worker sees every module, or per-role opportunities with their own apps', () => {
    const allWorkers = checkPlatformConstraints(withRows(KADUNA, '| worker_roles | FLW, enumerator |', '| learn_module_visibility | all-workers |'));
    expect(allWorkers.pass).toBe(true);
    const perRole = checkPlatformConstraints(
      withRows(
        KADUNA,
        '| worker_roles | FLW, enumerator |',
        '| opportunity_structure | per-role |',
        '| learn_module_visibility | per-role |',
        '| learn_app_count | 2 |',
        '| deliver_app_count | 2 |',
      ),
    );
    expect(perRole.pass).toBe(true);
  });
});

describe('a clean PDD passes', () => {
  it('ACE-PDD-Pass-001 has no platform finding at all', () => {
    const r = checkPlatformConstraints(CLEAN);
    expect(r.pass).toBe(true);
    expect(r.detail).toBe('no Connect platform constraint contradicted');
  });
});

describe('it is fast', () => {
  it('evaluates the kaduna PDD 200 times well under a second', () => {
    checkPlatformConstraints(KADUNA); // warm the config cache
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) checkPlatformConstraints(KADUNA);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});
