// ace#2364 — every § Program Parameters row says whether its value was READ
// from an author document, DERIVED by ACE, or BORROWED from material about a
// different programme, and a derived value names the decision row behind it.
//
// Reproducer: poverty-graduation/20260908-0510. `assessment_items: 30` /
// `pre_assessment_items: 20` sat in the table exactly like author-read values,
// no input stated them, ACE's email attributed them to the author, and no
// decisions.yaml row recorded where they came from. The table below is that
// shape: a 30/20 count marked derived from a decision that was never written.
import { describe, expect, it } from 'vitest';

import { checkProgramParametersProvenance } from '../../../skills/idea-to-pdd-qa/checks';
import { readFileSync } from 'node:fs';

const pdd = (rows: string, header = '| Key | Value | Provenance |\n|---|---|---|') =>
  `## Program Parameters\n\n${header}\n${rows}\n\n## Budget\n- Estimated cost: 1\n`;

const DECISIONS = `decisions:
  - id: assessment-bank-sizing
    phase: 1-design
  - id: "payment-rate"
    phase: 1-design
`;

const CLEAN = [
  '| learn_passing_score | 80 | read: Learn annex §2 |',
  '| assessment_items | 30 | derived: assessment-bank-sizing |',
  '| payment_rate_min | 5 | derived: payment-rate |',
  '| total_cap_per_flw | 300 | derived: daily_cap_per_flw, flw_count_max |',
  '| daily_cap_per_flw | 10 | read: Deliver annex §3 |',
  '| flw_count_max | 15 | read: Deliver annex §3 |',
  '| transfer_months | 10 | borrowed: model-comparison table, Kaduna column |',
].join('\n');

describe('checkProgramParametersProvenance', () => {
  it('passes a table where every row carries provenance and every derived ref resolves', () => {
    const r = checkProgramParametersProvenance(pdd(CLEAN), { decisionsYaml: DECISIONS });
    expect(r.pass).toBe(true);
    expect(r.detail).toContain('7 rows');
  });

  it('passes a table whose derived rows name only other table keys, with no decisions.yaml', () => {
    const rows = ['| daily_cap_per_flw | 10 | read: annex |', '| total_cap_per_flw | 300 | derived: daily_cap_per_flw |'].join('\n');
    expect(checkProgramParametersProvenance(pdd(rows)).pass).toBe(true);
  });

  it('fails the pre-ace#2364 two-column table', () => {
    const r = checkProgramParametersProvenance(pdd('| assessment_items | 30 |', '| Key | Value |\n|---|---|'));
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('no Provenance column');
  });

  it('fails the poverty-graduation shape: a derived count naming a decision that was never written', () => {
    const rows = '| assessment_items | 30 | derived: assessment-item-count |\n| pre_assessment_items | 20 | derived: assessment-item-count |';
    const r = checkProgramParametersProvenance(pdd(rows), { decisionsYaml: DECISIONS });
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('"assessment-item-count" is not a decisions.yaml row id');
  });

  it('fails an empty or unrecognised provenance cell', () => {
    const r = checkProgramParametersProvenance(pdd('| assessment_items | 30 |  |\n| flw_count_max | 15 | ANCHORED |'), {
      decisionsYaml: DECISIONS,
    });
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('assessment_items: provenance is empty');
    expect(r.detail).toContain('"ANCHORED" is not read:/derived:/borrowed:');
  });

  it('fails a derived cell that names nothing', () => {
    const r = checkProgramParametersProvenance(pdd('| assessment_items | 30 | derived: ACE estimate |'), { decisionsYaml: DECISIONS });
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('names no decision row');
  });

  it('fails as an invocation gap when a decision ref cannot be resolved for want of decisions.yaml', () => {
    const r = checkProgramParametersProvenance(pdd(CLEAN));
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('decisions.yaml was not supplied');
    expect(r.auto_fix_hint).toContain('--decisions');
  });

  it('passes the committed clean fixture PDD and fails the committed pre-provenance one', () => {
    expect(checkProgramParametersProvenance(readFileSync('test/fixtures/ACE-PDD-Pass-001/pdd.md', 'utf8')).pass).toBe(true);
    const bad = checkProgramParametersProvenance(readFileSync('test/fixtures/ACE-PDD-Bad-001/pdd.md', 'utf8'));
    expect(bad.pass).toBe(false);
    expect(bad.detail).toContain('no Provenance column');
  });

  it('leaves a PDD with no § Program Parameters to program_parameters_coherent', () => {
    expect(checkProgramParametersProvenance('## Budget\n- x\n').pass).toBe(true);
  });
});
