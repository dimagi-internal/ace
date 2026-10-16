/**
 * dimagi-internal/ace#3036 — Connect computes Learn completion over EVERY
 * learn_module, so a role-gated learn_module form makes Learn uncompletable.
 *
 * The suite excerpts below are VERBATIM menu lines from the released Learn CCZ
 * of kaduna-graduation/20261015-1411 (HQ app cee375a8a5aa4b858d1247e7734a1990,
 * build b7a5e1dcc83f482aabdf99858cdc97c0). Run over that whole suite.xml the
 * helper reports 14 of 14 learn_module forms as blockers, matching the device
 * finding (an FLW saw 9 modules, Connect counted 14).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  checkLearnModuleDisplayGating,
  commandIdForFormPath,
  formatLearnModuleDisplayGating,
} from '../../lib/learn-module-display-gating';

const KADUNA_SUITE = `
<suite>
  <menu id="m1" relevant="instance('commcaresession')/session/user/data/kgrad_role = 'FLW'" style="grid">
    <text><locale id="modules.m1"/></text>
    <command id="m1-f0"/>
  </menu>
  <menu id="m10" relevant="instance('commcaresession')/session/user/data/kgrad_role = 'enumerator'" style="grid">
    <text><locale id="modules.m10"/></text>
    <command id="m10-f0"/>
  </menu>
  <menu id="m15" relevant="instance('commcaresession')/session/user/data/kgrad_role = 'FLW' or instance('commcaresession')/session/user/data/kgrad_role = 'enumerator'" style="grid">
    <command id="m15-f0"/>
  </menu>
</suite>`;

const UNGATED_SUITE = `
<suite>
  <menu id="m0" style="grid"><command id="m0-f0"/></menu>
  <menu id="m1" style="grid"><command id="m1-f0"/></menu>
</suite>`;

// The whole released suite.xml, captured 2026-10-16 via
// commcare_download_ccz(connect-ace-prod, cee375a8a5aa4b858d1247e7734a1990,
// build b7a5e1dcc83f482aabdf99858cdc97c0) — kaduna-graduation/20261015-1411.
const REAL_SUITE = readFileSync(
  fileURLToPath(new URL('../fixtures/ccz/kaduna-graduation-learn-suite-20261015.xml', import.meta.url)),
  'utf8',
);
// `projected_connect_state.learn_modules[]` from the same download (slug, first_seen_in).
const REAL_MODULES: Array<[string, string]> = [
  ['f1_role', 'modules-1/forms-0.xml'], ['e1_role', 'modules-10/forms-0.xml'],
  ['e2_consent', 'modules-11/forms-0.xml'], ['e3_surveys', 'modules-12/forms-0.xml'],
  ['e4_verify', 'modules-13/forms-0.xml'], ['e5_graduation', 'modules-14/forms-0.xml'],
  ['f2_consent', 'modules-2/forms-0.xml'], ['f3_community', 'modules-3/forms-0.xml'],
  ['f4_eligibility', 'modules-4/forms-0.xml'], ['f5_enroll', 'modules-5/forms-0.xml'],
  ['f6_sessions', 'modules-6/forms-0.xml'], ['f7_business', 'modules-7/forms-0.xml'],
  ['f8_homevisits', 'modules-8/forms-0.xml'], ['f9_escalation', 'modules-9/forms-0.xml'],
];

describe('the real kaduna released Learn suite (ace#3036)', () => {
  it('reports all 14 learn_module forms as role-gated blockers (9 FLW + 5 enumerator)', () => {
    const o = checkLearnModuleDisplayGating({
      suiteXml: REAL_SUITE,
      learnModules: REAL_MODULES.map(([slug, firstSeenIn]) => ({ slug, firstSeenIn })),
    });
    if (o.status !== 'checked') throw new Error(`expected checked, got ${o.reason}`);
    expect(o.ok).toBe(false);
    expect(o.findings.filter((f) => f.severity === 'blocker')).toHaveLength(14);
    const roleOf = (f: (typeof o.findings)[number]) => f.gatedAt[0].relevant.match(/= '(\w+)'/)?.[1];
    expect(o.findings.filter((f) => roleOf(f) === 'FLW')).toHaveLength(9);
    expect(o.findings.filter((f) => roleOf(f) === 'enumerator')).toHaveLength(5);
  });

  it('negative control: the same suite with its relevant= attributes stripped is clean', () => {
    const o = checkLearnModuleDisplayGating({
      suiteXml: REAL_SUITE.replace(/\s+relevant="[^"]*"/g, ''),
      learnModules: REAL_MODULES.map(([slug, firstSeenIn]) => ({ slug, firstSeenIn })),
    });
    expect(o.status === 'checked' && o.ok && o.findings.length === 0).toBe(true);
  });
});

describe('commandIdForFormPath', () => {
  it('maps a CCZ form path to its suite command', () => {
    expect(commandIdForFormPath('modules-10/forms-0.xml')).toBe('m10-f0');
    expect(commandIdForFormPath('suite.xml')).toBeNull();
  });
});

describe('checkLearnModuleDisplayGating', () => {
  it('blocks the kaduna role-gated learn modules (the ace#3036 repro)', () => {
    const o = checkLearnModuleDisplayGating({
      suiteXml: KADUNA_SUITE,
      learnModules: [
        { slug: 'f1_role', firstSeenIn: 'modules-1/forms-0.xml' },
        { slug: 'e1_role', firstSeenIn: 'modules-10/forms-0.xml' },
      ],
    });
    expect(o.status).toBe('checked');
    if (o.status !== 'checked') return;
    expect(o.ok).toBe(false);
    expect(o.findings.map((f) => [f.slug, f.gateClass, f.severity])).toEqual([
      ['f1_role', 'user-property', 'blocker'],
      ['e1_role', 'user-property', 'blocker'],
    ]);
    expect(formatLearnModuleDisplayGating(o)).toContain('[BLOCKER]');
  });

  it('passes an app whose learn modules every worker can open', () => {
    const o = checkLearnModuleDisplayGating({
      suiteXml: UNGATED_SUITE,
      learnModules: [
        { slug: 'm0_intro', firstSeenIn: 'modules-0/forms-0.xml' },
        { slug: 'm1_core', firstSeenIn: 'modules-1/forms-0.xml' },
      ],
    });
    expect(o.status === 'checked' && o.ok && o.findings.length === 0).toBe(true);
  });

  it('a gate on the form command, or on a parent menu, counts', () => {
    const suite = `
      <menu id="m0" relevant="instance('commcaresession')/session/user/data/role = 'a'"><command id="m0-f0"/></menu>
      <menu id="m1" root="m0"><command id="m1-f0"/></menu>
      <menu id="m2"><command id="m2-f0" relevant="instance('commcaresession')/session/user/data/role = 'b'"/></menu>`;
    const o = checkLearnModuleDisplayGating({
      suiteXml: suite,
      learnModules: [
        { slug: 'child', firstSeenIn: 'modules-1/forms-0.xml' },
        { slug: 'cmd', firstSeenIn: 'modules-2/forms-0.xml' },
      ],
    });
    if (o.status !== 'checked') throw new Error('expected checked');
    expect(o.findings.map((f) => [f.slug, f.gatedAt[0].element, f.severity])).toEqual([
      ['child', 'menu', 'blocker'],
      ['cmd', 'command', 'blocker'],
    ]);
  });

  it('a non-user-property condition is a warn, not a blocker', () => {
    const o = checkLearnModuleDisplayGating({
      suiteXml: `<menu id="m0" relevant="count(instance('casedb')/casedb/case) > 0"><command id="m0-f0"/></menu>`,
      learnModules: [{ slug: 'x', firstSeenIn: 'modules-0/forms-0.xml' }],
    });
    if (o.status !== 'checked') throw new Error('expected checked');
    expect(o.ok).toBe(true);
    expect(o.findings[0].severity).toBe('warn');
  });

  it('is unable, never ok, when it located nothing', () => {
    expect(checkLearnModuleDisplayGating({ suiteXml: UNGATED_SUITE, learnModules: [] }).status).toBe('unable');
    expect(
      checkLearnModuleDisplayGating({ suiteXml: '', learnModules: [{ slug: 'x', firstSeenIn: 'modules-0/forms-0.xml' }] })
        .status,
    ).toBe('unable');
    expect(
      checkLearnModuleDisplayGating({
        suiteXml: UNGATED_SUITE,
        learnModules: [{ slug: 'x', firstSeenIn: 'modules-9/forms-0.xml' }],
      }).status,
    ).toBe('unable');
  });
});
