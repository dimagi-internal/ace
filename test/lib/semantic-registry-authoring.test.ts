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
    expect(pddSectionIds(pdd)).toEqual(['8', '8.1', '8.2']);
  });
  it('extracts § citations in order, de-duplicated', () => {
    expect(citedSections('PDD §8.1 P1; §5.4 and § 7.2, again §8.1')).toEqual(['8.1', '5.4', '7.2']);
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
