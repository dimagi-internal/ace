/**
 * Pre-deploy half of the ace#3036 gate: the same display-gating verdict read
 * from the Nova blueprint, so it can run before `app-deploy` (the CCZ check
 * needs a released build). Fixture: verbatim get_module + get_form fields from
 * the kaduna Nova Learn app, read 2026-10-16.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { checkLearnModuleDisplayGatingFromBlueprint } from '../../lib/learn-module-display-gating';

const BLUEPRINT = JSON.parse(
  readFileSync(fileURLToPath(new URL('../fixtures/nova/kaduna-learn-blueprint-20261016.json', import.meta.url)), 'utf8'),
);

describe('checkLearnModuleDisplayGatingFromBlueprint (pre-deploy, ace#3036)', () => {
  it('blocks both role-gated kaduna learn modules from the blueprint alone', () => {
    const r = checkLearnModuleDisplayGatingFromBlueprint(BLUEPRINT);
    expect(r.status).toBe('checked');
    if (r.status !== 'checked') return;
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => [f.slug, f.severity, f.gateClass])).toEqual([
      ['f1_role', 'blocker', 'user-property'],
      ['e1_role', 'blocker', 'user-property'],
    ]);
    expect(r.findings[0].gatedAt[0].relevant).toBe("(user('kgrad_role') = 'FLW')");
  });

  it('is clean once the module display conditions are removed', () => {
    const ungated = { modules: BLUEPRINT.modules.map((m: any) => ({ ...m, display_condition: null })) };
    const r = checkLearnModuleDisplayGatingFromBlueprint(ungated);
    expect(r.status).toBe('checked');
    if (r.status !== 'checked') return;
    expect(r.ok).toBe(true);
    expect(r.findings).toEqual([]);
  });

  it('reads a form-level condition and walks parent modules', () => {
    const r = checkLearnModuleDisplayGatingFromBlueprint({
      modules: [
        { uuid: 'p', display_condition: "#user/role = 'x'", forms: [] },
        { uuid: 'c', parent_module_uuid: 'p', forms: [{ uuid: 'f', displayCondition: 'today() > 0', connect: { learn_module: { id: 'm' } } }] },
      ],
    });
    expect(r.status).toBe('checked');
    if (r.status !== 'checked') return;
    expect(r.findings[0].gatedAt.map((g) => g.element)).toEqual(['command', 'menu']);
    expect(r.findings[0].severity).toBe('blocker');
  });

  it('a non-user condition warns rather than blocks', () => {
    const r = checkLearnModuleDisplayGatingFromBlueprint({
      modules: [{ uuid: 'a', display_condition: 'today() > 0', forms: [{ uuid: 'f', connect: { learn_module: { id: 'm' } } }] }],
    });
    expect(r).toMatchObject({ status: 'checked', ok: true });
  });

  it('is unable — not a pass — when no form carries a learn_module marker', () => {
    expect(checkLearnModuleDisplayGatingFromBlueprint({ modules: [{ uuid: 'a', forms: [{ uuid: 'f' }] }] }).status).toBe('unable');
  });
});
