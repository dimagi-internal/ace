import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkRegistryAuthoring, registryQAOutcomes, REGISTRY_AUTHORING_CHECKS, type RegistryDocs } from '../../lib/semantic-registry-authoring';
import { aggregateQAResult } from '../../lib/qa-types';

// The live-accepted Spark registry (spark-facilitator, ace#2510).
const REGISTRY = join(__dirname, '../fixtures/cascade/spark-facilitator-registry.json');
const SECTIONS = ['1', '2', '3', '5', '7', '7.1', '7.2', '8', '10', '10.1', '14'];

describe('registryQAOutcomes', () => {
  it('turns the real registry into one counted outcome per check', () => {
    const reg = JSON.parse(readFileSync(REGISTRY, 'utf8')) as RegistryDocs;
    const report = checkRegistryAuthoring(reg, { opportunityIds: [10082, 10083, 10084] });
    const outcomes = registryQAOutcomes(report, { valid: true, errors: [] }, { pddSections: SECTIONS, opportunityIds: [10082, 10083, 10084] });
    expect(outcomes.map((o) => o.check)).toEqual(['labs-validate', ...REGISTRY_AUTHORING_CHECKS]);
    const result = aggregateQAResult({ skill: 'semantic-registry-author-qa', target: 't', capture_path: 'p', outcomes });
    expect(result.stats.checks_run).toBe(12);
  });

  it('fails a check whose input was not supplied, and a missing labs validation', () => {
    const reg = JSON.parse(readFileSync(REGISTRY, 'utf8')) as RegistryDocs;
    const outcomes = registryQAOutcomes(checkRegistryAuthoring(reg), null, {});
    const failed = outcomes.filter((o) => !o.result.pass).map((o) => o.check);
    expect(failed).toEqual(expect.arrayContaining(['labs-validate', 'pdd-anchor', 'llo-map']));
  });

  it('says a supplied PDD parsed to no headings, rather than "not supplied" (ace#2803)', () => {
    const reg = JSON.parse(readFileSync(REGISTRY, 'utf8')) as RegistryDocs;
    const anchor = (pddSupplied: boolean) =>
      registryQAOutcomes(checkRegistryAuthoring(reg), null, { pddSections: [], pddSupplied }).find((o) => o.check === 'pdd-anchor')!;
    expect(anchor(true).result.pass).toBe(false);
    expect(anchor(true).result.detail).toMatch(/PDD was supplied but no section headings parsed/);
    expect(anchor(false).result.detail).toMatch(/neither the PDD nor the released app was supplied/);
  });

  it('fails labs-validate when labs rejects the registry', () => {
    const reg = JSON.parse(readFileSync(REGISTRY, 'utf8')) as RegistryDocs;
    const [labs] = registryQAOutcomes(checkRegistryAuthoring(reg), { valid: false, errors: [{ path: 'measures.x', msg: 'unknown column' }] }, {});
    expect(labs.result.pass).toBe(false);
    expect(labs.result.detail).toMatch(/unknown column/);
  });
});
