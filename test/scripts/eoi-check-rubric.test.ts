// skills/eoi-criteria-proposal/check_rubric.py — refuses a proposed EOI rubric
// that leaves any part implicit: anchors at 1/3/5/7/10 written as observable
// evidence, a Silent rule, Measures/Separates in each rationale, and the outcome
// rules in the basis. Python (stdlib only) because the skill runs it with nothing
// installed; vitest drives it.

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(process.cwd(), 'skills/eoi-criteria-proposal/check_rubric.py');

// An invented round: no real organisation, person or place.
const guide = (topic: string) =>
  [
    `1: gives no ${topic} at all, or answers N/A`,
    `3: names a ${topic} only in general terms, with nothing checkable`,
    `5: names one ${topic} with some detail but no unit or source`,
    `7: names a ${topic} with a unit and says where it came from`,
    `10: names several ${topic}s by size, each from its own field contact`,
    'Silent: 2 - blank, "No" or "we will find out"; cite the answer with absent: true',
  ].join('\n');

const criterion = (id: string, weight: number) => ({
  id,
  name: id.replace('_', ' '),
  weight,
  scoring_guide: guide(id.replace('_', ' ')),
  rationale: `Measures: whether the applicant shows ${id}.\nSeparates: 9 of 30 give one; 21 do not.`,
});

const basis = [
  'Written after reading 30 invented submissions; approved by the requester.',
  '',
  'Outcome rules:',
  'Score: weighted score = sum(weight x criterion score) / 10, from 10 to 100.',
  'Slots: 2: site A and site B, one partner each.',
  'Pick: the highest-scoring credible applicant per slot.',
  'Backup: the next two per slot, in score order.',
  'Waitlist: credible but not a pick or backup.',
  'Pass: outside every slot, or 1-2 on a criterion the call needs.',
  'Overrides: slot coverage beats score order; a pick may be conditional on rescoping to one site.',
].join('\n');

const goodRubric = () => ({
  criteria: [
    criterion('named_sites', 25),
    criterion('price_data', 25),
    criterion('chain_links', 20),
    criterion('sampling_plan', 15),
    criterion('cost_fit', 15),
  ],
  basis,
});

function run(rubric: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'eoi-check-rubric-'));
  writeFileSync(join(dir, 'rubric.json'), JSON.stringify(rubric));
  return spawnSync('python3', [SCRIPT, join(dir, 'rubric.json')], { encoding: 'utf8', timeout: 20_000 });
}

describe('eoi-criteria-proposal check_rubric.py', () => {
  it('passes an explicit rubric', () => {
    const r = run(goodRubric());
    expect(r.error).toBeUndefined();
    expect(r.stdout.trim()).toBe('OK: rubric is explicit');
    expect(r.status).toBe(0);
  });

  it('reads the round shape labs returns', () => {
    const g = goodRubric();
    const r = run({ round: { evaluation_criteria: g.criteria, criteria_basis: g.basis } });
    expect(r.status).toBe(0);
  });

  it('refuses the banded 1-3 / 4-6 / 7-8 / 9-10 guide with no anchors or silent rule', () => {
    const g = goodRubric();
    g.criteria[0].scoring_guide =
      '1-3: no site. 4-6: a region only. 7-8: one site with districts. 9-10: one site, districts and the mix.';
    const r = run(g);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/named_sites: scoring_guide has no anchor for 3/);
    expect(r.stdout).toMatch(/named_sites: scoring_guide has no anchor for 10/);
    expect(r.stdout).toMatch(/named_sites: scoring_guide has no 'Silent:' rule/);
  });

  it('refuses an anchor that judges without saying what the answer contains', () => {
    const g = goodRubric();
    g.criteria[1].scoring_guide = g.criteria[1].scoring_guide.replace(
      /^7: .*$/m,
      '7: a good and strong answer',
    );
    g.criteria[2].scoring_guide = g.criteria[2].scoring_guide.replace(/^5: .*$/m, '5: adequate');
    const r = run(g);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/price_data anchor 7: anchor judges the answer without saying what is in it/);
    expect(r.stdout).toMatch(/chain_links anchor 5: anchor is 1 word/);
  });

  it('requires the Silent rule to give a score', () => {
    const g = goodRubric();
    g.criteria[3].scoring_guide = g.criteria[3].scoring_guide.replace(/^Silent: .*$/m, 'Silent: score it low');
    const r = run(g);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/sampling_plan: the Silent rule must start with the score/);
  });

  it('requires Measures and Separates (with a count) in each rationale', () => {
    const g = goodRubric();
    g.criteria[0].rationale = 'It matters a lot.';
    g.criteria[1].rationale = 'Measures: price knowledge.\nSeparates: some do and some do not.';
    const r = run(g);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/named_sites: rationale has no 'Measures:' line/);
    expect(r.stdout).toMatch(/named_sites: rationale has no 'Separates:' line/);
    expect(r.stdout).toMatch(/price_data: 'Separates:' gives no count from the pool/);
  });

  it('requires weights to sum to 100, 5-8 criteria and unique snake_case ids', () => {
    const g = goodRubric();
    g.criteria[4].weight = 20;
    g.criteria[3].id = 'named_sites';
    g.criteria[2].id = 'Chain Links';
    const r = run(g);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/weights sum to 105, not 100/);
    expect(r.stdout).toMatch(/named_sites: id used twice/);
    expect(r.stdout).toMatch(/Chain Links: id must be a snake_case slug/);
    const few = run({ criteria: goodRubric().criteria.slice(0, 3), basis });
    expect(few.stdout).toMatch(/3 criteria; propose 5-8/);
  });

  it('requires the outcome rules in the basis', () => {
    const none = run({ ...goodRubric(), basis: 'Written after reading the pool.' });
    expect(none.status).toBe(1);
    expect(none.stdout).toMatch(/basis has no 'Outcome rules:' section/);
    const partial = run({ ...goodRubric(), basis: basis.replace(/^Overrides: .*$/m, '').replace(/^Slots: .*$/m, '') });
    expect(partial.stdout).toMatch(/outcome rules have no 'Slots:' line/);
    expect(partial.stdout).toMatch(/outcome rules have no 'Overrides:' line/);
  });

  it('exits 2 on a file it cannot read', () => {
    const r = spawnSync('python3', [SCRIPT, '/nonexistent/rubric.json'], { encoding: 'utf8' });
    expect(r.status).toBe(2);
  });
});
