import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  checkRegistryAuthoring,
  citedSections,
  pddSectionIds,
  registryIndicators,
  type RegistryDocs,
} from '../../lib/semantic-registry-authoring';

// The registry ACE authored from the Spark PDD and labs accepted as record 6369
// (spark-facilitator/20260926-1800, ace#2510). It is the positive control: it
// validated live, rendered the cascade, and every rule below must pass it.
const SPARK: RegistryDocs = JSON.parse(
  readFileSync(join(__dirname, '../fixtures/cascade/spark-facilitator-registry.json'), 'utf8'),
);
const SPARK_OPPS = [10082, 10083, 10084];
// The Spark PDD's numbered headings that the registry cites.
const SPARK_SECTIONS = ['3', '3.1', '5', '5.4', '5.5', '5.6', '7', '7.2', '7.4', '8', '8.1', '8.2'];

function clone(): RegistryDocs {
  return JSON.parse(JSON.stringify(SPARK));
}
function indicator(reg: RegistryDocs, id: string): { meta: Record<string, unknown>; sql?: string; name?: string } {
  return registryIndicators(reg.indicators_doc).find((m) => m.meta?.indicator === id) as never;
}
const checks = (reg: RegistryDocs) =>
  checkRegistryAuthoring(reg, { pddSections: SPARK_SECTIONS, opportunityIds: SPARK_OPPS }).findings.map((f) => f.check);

describe('pddSectionIds / citedSections', () => {
  it('reads numbered headings, with or without a trailing dot', () => {
    const pdd = '# Title\n## 8. Success Metrics\n### 8.1 Primary metrics\n### 8.2 Secondary\nprose §9';
    expect(pddSectionIds(pdd)).toEqual(['Title', '8', 'Success Metrics', '8.1', 'Primary metrics', '8.2', 'Secondary']);
  });
  it('extracts § citations in order, de-duplicated', () => {
    expect(citedSections('PDD §8.1 P1; §5.4 and § 7.2, again §8.1')).toEqual(['8.1', '5.4', '7.2']);
  });
});

// ace#2803: ACE's own PDD template has UNNUMBERED headings, so a PDD built from it
// can only be cited by heading name. group-payment-test/20261007-1700 reported its
// supplied PDD as "not supplied" because pddSectionIds keyed on numbers alone.
describe('named-heading anchors (ace#2803)', () => {
  const TEMPLATE_HEADINGS = readFileSync(join(__dirname, '../../templates/pdd-template.md'), 'utf8');
  const PDD = '# Program Design Document (PDD)\n## Test Script\n## Success Metrics\n### Primary metrics\nbody';
  const sections = pddSectionIds(PDD);
  const anchorFails = (note: string, pddSections: readonly string[] = sections) => {
    const reg = clone();
    for (const m of registryIndicators(reg.indicators_doc)) m.meta!.scope_note = 'PDD §8.1';
    indicator(reg, 'SF_S3').meta.scope_note = note;
    return checkRegistryAuthoring(reg, { pddSections: [...pddSections, ...SPARK_SECTIONS], opportunityIds: SPARK_OPPS })
      .findings.filter((f) => f.check === 'pdd-anchor' && f.indicator === 'SF_S3');
  };

  it('reads the unnumbered headings of ACE\'s own PDD template', () => {
    const ids = pddSectionIds(TEMPLATE_HEADINGS);
    expect(ids).toContain('Success Metrics');
    expect(ids).toContain('Problem Statement');
    expect(ids.length).toBeGreaterThan(10);
  });

  it('resolves a named citation to the PDD\'s own heading, case-insensitively', () => {
    expect(citedSections('PDD § Test Script; pdd § success metrics — target 80', sections)).toEqual([
      'Test Script',
      'Success Metrics',
    ]);
  });

  it('passes an indicator anchored by heading name (the group-payment-test shape)', () => {
    expect(anchorFails('Share of groups paid. PDD § Success Metrics.')).toEqual([]);
    expect(anchorFails('PDD §Test Script')).toEqual([]);
  });

  it('NEGATIVE CONTROL: fails a named anchor that names no real heading', () => {
    const f = anchorFails('PDD § Impact Narrative; derived from donor goals');
    expect(f).toHaveLength(1);
    expect(f[0].detail).toContain('Impact Narrative');
  });

  it('NEGATIVE CONTROL: a heading prefix that runs on into another word does not match', () => {
    expect(anchorFails('PDD § Success Metricsville')).toHaveLength(1);
  });
});

describe('checkRegistryAuthoring', () => {
  it('passes the live-accepted Spark registry with no failures', () => {
    const r = checkRegistryAuthoring(SPARK, { pddSections: SPARK_SECTIONS, opportunityIds: SPARK_OPPS });
    expect(r.findings.filter((f) => f.severity === 'fail')).toEqual([]);
    expect(r.verdict).toBe('pass');
    expect(r.indicators).toHaveLength(10);
  });

  it('fails an indicator with no PDD anchor (No inferred backstory)', () => {
    const reg = clone();
    indicator(reg, 'SF_S3').meta.scope_note = 'Spark-style participation.';
    expect(checks(reg)).toContain('pdd-anchor');
  });

  it('fails an anchor that cites a section the PDD does not have', () => {
    const reg = clone();
    indicator(reg, 'SF_S3').meta.scope_note = 'PDD §19.4';
    expect(checks(reg)).toContain('pdd-anchor');
  });

  it('fails a target the scope note does not quote (an invented goal)', () => {
    const reg = clone();
    indicator(reg, 'SF_S2').meta.target = 50;
    expect(checks(reg)).toContain('target');
  });

  it('fails percentage bands written as fractions', () => {
    const reg = clone();
    indicator(reg, 'SF_P1').meta.bands = [0.8, 0.6];
    expect(checks(reg)).toContain('bands');
  });

  it('fails an indicator whose denominator measure is missing', () => {
    const reg = clone();
    const measures = reg.indicators_doc.measures as Array<{ name: string }>;
    reg.indicators_doc.measures = measures.filter((m) => m.name !== 'sf_s6_denominator');
    expect(checks(reg)).toContain('measures');
  });

  it('fails duplicate headline positions', () => {
    const reg = clone();
    indicator(reg, 'SF_S3').meta.headline = 1;
    expect(checks(reg)).toContain('headline');
  });

  it('fails a display block missing the programme\'s nouns', () => {
    const reg = clone();
    delete (reg.indicators_doc.display as Record<string, unknown>).worker;
    expect(checks(reg)).toContain('display');
  });

  it('fails an unmapped partner opportunity — its cases would vanish from the partner level', () => {
    const r = checkRegistryAuthoring(SPARK, { opportunityIds: [...SPARK_OPPS, 10099] });
    expect(r.findings.map((f) => f.detail).join('\n')).toMatch(/10099/);
    expect(r.verdict).toBe('fail');
  });

  it('fails a model with no entity key', () => {
    const reg = clone();
    delete (reg.properties_doc.entity as Record<string, unknown>).key;
    expect(checks(reg)).toContain('model');
  });
});

// The chlorine registry: a programme with NO PDD and two real partners. ACE built it
// from the released Deliver app (opp 2158) and labs accepted it as record 6583
// (2026-10-02). Its anchors name app forms, and two partners is the programme's shape.
describe('a programme with no PDD and two real partners', () => {
  const CHLORINE: RegistryDocs = JSON.parse(
    readFileSync(join(__dirname, '../fixtures/cascade/chlorine-registry.json'), 'utf8'),
  );
  const APP_FORMS: string[] = JSON.parse(
    readFileSync(join(__dirname, '../fixtures/cascade/chlorine-app-forms.json'), 'utf8'),
  ).forms;
  const opts = { appForms: APP_FORMS, opportunityIds: [10093, 10092], partnerSource: 'programme' as const };

  it('passes when anchored on the app and given the real partner count', () => {
    const r = checkRegistryAuthoring(CHLORINE, opts);
    expect(r.findings.filter((f) => f.severity === 'fail')).toEqual([]);
    expect(r.verdict).toBe('pass');
  });

  it('warns, not fails, that two partners expose each other in a benchmark', () => {
    const warn = checkRegistryAuthoring(CHLORINE, opts).findings.find((f) => f.check === 'llo-map');
    expect(warn?.severity).toBe('warn');
  });

  it('still fails an indicator whose anchor names no released form', () => {
    const reg: RegistryDocs = JSON.parse(JSON.stringify(CHLORINE));
    indicator(reg, 'CL_Q1').meta.scope_note = 'Deliver app — Water Quality Census, pass at 0.2 mg/L';
    const f = checkRegistryAuthoring(reg, opts).findings.filter((x) => x.severity === 'fail');
    expect(f.map((x) => `${x.check}:${x.indicator}`)).toEqual(['pdd-anchor:CL_Q1']);
  });

  it('keeps the three-partner floor for partners ACE invented', () => {
    const r = checkRegistryAuthoring(CHLORINE, { ...opts, partnerSource: 'invented' });
    expect(r.findings.filter((f) => f.severity === 'fail').map((f) => f.check)).toEqual(['llo-map']);
  });

  it('does not let a PDD-less anchor through when a PDD exists', () => {
    const r = checkRegistryAuthoring(CHLORINE, { ...opts, pddSections: ['1', '2'] });
    expect(r.findings.some((f) => f.check === 'pdd-anchor' && f.severity === 'fail')).toBe(true);
  });
});

