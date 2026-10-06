import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  checkCascadeStoryPlan,
  displayNameProblem,
  exampleOrgLabelProblem,
  verifyCascadeStoryLanded,
  type CascadeStoryPlan,
  type GradedPeriod,
} from '../../lib/cascade-story';

// Fixtures from the live proof (ace#2510, spark-facilitator/20260926-1800): the
// story plan ACE authored, and the 13 saved weekly runs labs graded for
// programme report 6371 (worker rows kept for the latest run only).
//
// Two regressions are pinned on the AS-AUTHORED plan:
//  - its invented partners were bare "Partner A/B/C" for a single-implementer
//    pilot (outsider eval, spark-facilitator/20261001-2208; be59309d);
//  - the be59309d fix relabelled them "Example partner A/B/C", which canopy's
//    DDD judge scored at clarity 2 — the floor of spark-facilitator/20261004-1706
//    (ace#2727).
// The plan the rules now require is `spark-facilitator-story-named.json`: the
// same signals on realistic "(example)" organisation names, five partners, a
// display roster and a headline spread (generated from the authored plan; the
// two added partners, D and E, have no graded rows).
const fixture = (name: string) => readFileSync(join(__dirname, '../fixtures/cascade', name), 'utf8');
const AUTHORED_PLAN: CascadeStoryPlan = JSON.parse(fixture('spark-facilitator-story.json'));
const PLAN: CascadeStoryPlan = JSON.parse(fixture('spark-facilitator-story-named.json'));
const NAMES: Record<string, string> = {
  A: 'Tiyende Community Trust (example)',
  B: 'Kuunika Outreach Network (example)',
  C: "Tsogolo Women's Forum (example)",
};
const relabel = (text: string) => text.replace(/\bPartner ([ABC])\b/g, (_m, l: string) => NAMES[l]);
const PERIODS: GradedPeriod[] = JSON.parse(relabel(fixture('spark-facilitator-graded-periods.json'))).periods;
const IDS = ['SF_P1', 'SF_P3', 'SF_S1', 'SF_S2', 'SF_S3', 'SF_S4', 'SF_S5', 'SF_S6', 'SF_D1', 'SF_D2'];

const clone = (): CascadeStoryPlan => JSON.parse(JSON.stringify(PLAN));
const details = (p: CascadeStoryPlan, opts = {}) =>
  checkCascadeStoryPlan(p, IDS, undefined, opts)
    .findings.filter((f) => f.severity === 'fail')
    .map((f) => f.detail)
    .join(' | ');

describe('checkCascadeStoryPlan', () => {
  it('passes the named Spark plan', () => {
    const r = checkCascadeStoryPlan(PLAN, IDS);
    expect(r.findings).toEqual([]);
    expect(r.verdict).toBe('pass');
  });

  it('refuses invented partners labelled as if they were real implementers (be59309d: bare "Partner A")', () => {
    const r = checkCascadeStoryPlan(AUTHORED_PLAN, IDS);
    expect(r.verdict).toBe('fail');
    const msg = r.findings.map((f) => f.detail).join(' ');
    expect(msg).toMatch(/"Partner A" \(carries no trailing "\(example\)" marker\)/);
    expect(msg).toMatch(/names 1 implementing organisation/);
  });

  it('refuses the be59309d placeholder "Example partner A" — the label the DDD judge scored at clarity 2 (ace#2727)', () => {
    const p = clone();
    p.partners[0].label = 'Example partner A';
    expect(details(p)).toMatch(/"Example partner A" \(carries no trailing "\(example\)" marker\)/);
    p.partners[0].label = 'Partner A (example)';
    expect(details(p)).toMatch(/"Partner A \(example\)" \(is a placeholder, not an organisation name\)/);
  });

  it('refuses a programme name that does not say it is illustrative', () => {
    const p = clone();
    p.programme_name = 'Spark facilitator pilot';
    expect(details(p)).toMatch(/does not say it is illustrative/);
  });

  it('accepts a programme mirror only when its partner count matches the PDD', () => {
    const ok = { ...clone(), partner_source: 'programme' as const, implementing_orgs: 5 };
    expect(checkCascadeStoryPlan(ok, IDS).verdict).toBe('pass');
    const bad = { ...clone(), partner_source: 'programme' as const, implementing_orgs: 1 };
    const r = checkCascadeStoryPlan(bad, IDS);
    expect(r.verdict).toBe('fail');
    expect(r.findings.map((f) => f.detail).join()).toMatch(/PDD names 1 implementing/);
  });

  it('requires all four signal kinds', () => {
    const p = clone();
    p.signals = p.signals.filter((s) => s.kind !== 'trend');
    const r = checkCascadeStoryPlan(p, IDS);
    expect(r.verdict).toBe('fail');
    expect(r.findings.map((f) => f.signal)).toContain('trend');
  });

  it('refuses fewer than five invented partners (ace#2727 — three was too few to sort)', () => {
    const p = clone();
    const dropped = new Set(p.partners.slice(3).map((x) => x.label));
    p.partners = p.partners.slice(0, 3);
    p.workers = p.workers!.filter((w) => !dropped.has(w.partner!));
    expect(details(p)).toMatch(/3 partner\(s\); the cascade needs ≥ 5/);
  });

  it('refuses a partner on a real (non-labs-only) opportunity', () => {
    const p = clone();
    p.partners[0].opportunity_id = 2296;
    expect(details(p)).toMatch(/labs-only/);
  });

  it('refuses a signal with no PDD citation', () => {
    const p = clone();
    p.signals[2].pdd_ref = 'looks suspicious';
    expect(checkCascadeStoryPlan(p, IDS).verdict).toBe('fail');
  });

  it('refuses a signal on an indicator the registry lacks', () => {
    const p = clone();
    p.signals[1].indicator = 'SF_X9';
    expect(checkCascadeStoryPlan(p, IDS).verdict).toBe('fail');
  });

  it('refuses a worker carrier who is not on the roster', () => {
    const p = clone();
    p.signals[1].carrier = 'cbf_z99';
    expect(details(p)).toMatch(/cbf_z99/);
  });
});

describe('the display roster (ace#2727) — rows a viewer reads, not codes', () => {
  it('fails an invented plan with no worker or entity roster (the as-authored shape: usernames only)', () => {
    const p = clone();
    delete p.workers;
    delete p.entities;
    const msg = details(p);
    expect(msg).toMatch(/no `workers` display roster/);
    expect(msg).toMatch(/no `entities` display roster/);
  });

  it('fails code-shaped and placeholder worker names', () => {
    const p = clone();
    p.workers![0].display_name = 'cbf_a01';
    p.workers![1].display_name = 'Worker B';
    p.workers![2].display_name = 'Facilitator 3';
    const msg = details(p);
    expect(msg).toMatch(/cbf_a01: its display name is its code/);
    expect(msg).toMatch(/"Worker B" is a placeholder/);
    expect(msg).toMatch(/"Facilitator 3" is code-shaped/);
  });

  it('fails hashed entity ids used as names', () => {
    const p = clone();
    p.entities![0].name = p.entities![0].id;
    p.entities![1].name = 'Community A';
    const msg = details(p);
    expect(msg).toMatch(/its display name is its code/);
    expect(msg).toMatch(/"Community A" is a placeholder/);
  });

  it('fails two workers sharing a name, and a roster that does not cover every worker', () => {
    const p = clone();
    p.workers![1].display_name = p.workers![0].display_name;
    expect(details(p)).toMatch(/share the display name/);
    const q = clone();
    q.workers = q.workers!.slice(1);
    expect(details(q)).toMatch(/names 59 workers; the partners declare 60/);
  });

  it("fails a real person's name from the inputs", () => {
    const p = clone();
    p.workers![0].display_name = 'Anne Mwale';
    expect(details(p, { realPeople: ['Anne Mwale'] })).toMatch(/real person's name from the inputs/);
    expect(details(p)).toBe('');
  });

  it('a programme mirror without a roster warns rather than fails', () => {
    const p = { ...clone(), partner_source: 'programme' as const, implementing_orgs: 5 };
    delete p.workers;
    delete p.entities;
    const r = checkCascadeStoryPlan(p, IDS);
    expect(r.verdict).toBe('pass');
    expect(r.findings.filter((f) => f.severity === 'warn').length).toBe(2);
  });
});

describe('headline indicators must differ across partners (ace#2727)', () => {
  it('fails an invented plan that declares no headline', () => {
    const p = clone();
    delete p.headline_indicators;
    expect(details(p)).toMatch(/no `headline_indicators`/);
  });

  it('fails a headline flat across all partners — the "all at 100% on Step 7" shape', () => {
    const p = clone();
    for (const l of Object.keys(p.headline_spread!.SF_P1)) p.headline_spread!.SF_P1[l] = 1;
    expect(details(p)).toMatch(/SF_P1 is flat across all partners \(100%, 100%, 100%, 100%, 100%\)/);
  });

  it('fails a headline with no authored value for some partner', () => {
    const p = clone();
    delete p.headline_spread!.SF_S2["Tsogolo Women's Forum (example)"];
    expect(details(p)).toMatch(/SF_S2: no authored value for "Tsogolo Women's Forum \(example\)"/);
  });

  it('a saturated indicator demoted from the headline passes', () => {
    const p = clone();
    p.headline_indicators = ['SF_S2'];
    expect(checkCascadeStoryPlan(p, IDS).verdict).toBe('pass');
  });
});

describe('name rules, unit', () => {
  it.each([
    ['Tiyende Community Trust (example)', null],
    ['Mphamvu Health Alliance (illustrative)', null],
    ['Partner A', 'marker'],
    ['Example partner A', 'marker'],
    ['Example partner A (example)', 'placeholder'],
    ['Org 2 (example)', 'placeholder'],
    ['B (example)', 'placeholder'],
    ['(example)', 'only the marker'],
  ])('exampleOrgLabelProblem(%s)', (label, want) => {
    const got = exampleOrgLabelProblem(label);
    if (want === null) expect(got).toBeNull();
    else expect(got).toMatch(new RegExp(want));
  });

  it.each([
    ['Chikondi Banda', 'cbf_a01', null],
    ["Tiyamike Ng'oma", 'cbf_a02', null],
    ['Kalemba', 'e3b0c442', null],
    ['cbf_a07', 'cbf_a07', 'its code'],
    ['e3b0c44298fc', 'x', 'code-shaped'],
    ['chikondi banda', 'x', 'code-shaped'],
    ['Worker 7', 'x', 'code-shaped'],
    ['Village B', 'x', 'placeholder'],
    ['', 'x', 'no display name'],
  ])('displayNameProblem(%s)', (name, id, want) => {
    const got = displayNameProblem(name, id);
    if (want === null) expect(got).toBeNull();
    else expect(got).toMatch(new RegExp(want));
  });
});

describe('verifyCascadeStoryLanded — against what labs actually graded', () => {
  it('all four authored Spark signals landed, and both headlines spread', () => {
    const r = verifyCascadeStoryLanded(PLAN, PERIODS);
    expect(r.results.map((x) => [x.kind, x.landed])).toEqual([
      ['lagging_partner', true],
      ['standout_worker', true],
      ['data_quality', true],
      ['trend', true],
    ]);
    expect(r.headlines.map((h) => [h.indicator, h.spread_ok])).toEqual([
      ['SF_P1', true],
      ['SF_S2', true],
    ]);
    expect(r.verdict).toBe('pass');
  });

  it('a headline that came out flat in the graded data fails, even though the plan spread it', () => {
    const flat: GradedPeriod[] = JSON.parse(JSON.stringify(PERIODS));
    for (const row of flat[flat.length - 1].byLLO) row.ind.SF_P1 = { value: 1 };
    const r = verifyCascadeStoryLanded(PLAN, flat);
    expect(r.headlines[0]).toMatchObject({ indicator: 'SF_P1', spread_ok: false });
    expect(r.verdict).toBe('fail');
  });

  it('a signal pinned on the wrong carrier does not land', () => {
    const p = clone();
    p.signals[0].carrier = NAMES.A; // A is the programme's second-best on regularity
    expect(verifyCascadeStoryLanded(p, PERIODS).results[0].landed).toBe(false);
  });

  it('a trend declared in the wrong direction does not land', () => {
    const p = clone();
    p.signals[3].trend_direction = 'down';
    expect(verifyCascadeStoryLanded(p, PERIODS).results[3].landed).toBe(false);
  });

  it('with no saved runs nothing lands', () => {
    expect(verifyCascadeStoryLanded(PLAN, []).verdict).toBe('fail');
  });
});

describe('the rules are wired into demo-data-setup (ace#2727)', () => {
  const skill = readFileSync(join(__dirname, '../../skills/demo-data-setup/SKILL.md'), 'utf8');

  it('§ C0 asks for realistic "(example)" names, five partners, a display roster and a headline spread', () => {
    const c0 = skill.slice(skill.indexOf('**C0. Size the story.**'), skill.indexOf('**C1. Create the synthetic programme.**'));
    expect(c0).toMatch(/Default \*\*5 partners\*\*/);
    expect(c0).toMatch(/trailing `\(example\)` marker/);
    expect(c0).toMatch(/why not `Example partner A`/);
    expect(c0).toMatch(/workers: \[\{username, display_name, partner\}\]/);
    expect(c0).toMatch(/entities: \[\{id, name, worker\}\]/);
    expect(c0).toMatch(/headline_spread/);
  });

  it('§ C3 carries the labs-wiring TODO at the generation call, and guesses no labs field', () => {
    const c3 = skill.slice(skill.indexOf('**C3. Author the story, then the data.**'), skill.indexOf('**C4. Instantiate the trio.**'));
    expect(c3).toMatch(/TODO\(ace#2727\)/);
    expect(c3).toMatch(/do NOT guess a labs field/);
  });
});

describe('a programme story with two real partners and no PDD', () => {
  const CHLORINE: CascadeStoryPlan = JSON.parse(fixture('chlorine-story.json'));
  const CL_IDS = ['CL_Q1', 'CL_D1', 'CL_U1', 'CL_D2', 'CL_X1', 'CL_D3', 'CL_R1', 'CL_R2', 'CL_X2'];

  it('passes with the real partner count and app-cited signals, warning (not failing) about the benchmark and the missing roster/headline', () => {
    const r = checkCascadeStoryPlan(CHLORINE, CL_IDS);
    expect(r.verdict).toBe('pass');
    expect(r.findings.every((f) => f.severity === 'warn')).toBe(true);
    expect(r.findings.map((f) => f.detail).join(' ')).toMatch(/min_peers/);
  });

  it('refuses two partners when the plan says ACE invented them', () => {
    const p: CascadeStoryPlan = JSON.parse(JSON.stringify(CHLORINE));
    p.partner_source = 'invented';
    expect(checkCascadeStoryPlan(p, CL_IDS).verdict).toBe('fail');
  });

  it('refuses one partner even for a real programme — nothing to compare', () => {
    const p: CascadeStoryPlan = JSON.parse(JSON.stringify(CHLORINE));
    p.partners = p.partners.slice(0, 1);
    expect(checkCascadeStoryPlan(p, CL_IDS).verdict).toBe('fail');
  });

  it('refuses an app-anchored signal that names no Deliver app form', () => {
    const p: CascadeStoryPlan = JSON.parse(JSON.stringify(CHLORINE));
    p.signals[0].pdd_ref = 'the obvious water-quality metric';
    expect(checkCascadeStoryPlan(p, CL_IDS).findings.map((f) => f.signal)).toContain(p.signals[0].kind);
  });
});
