import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  ARC_PRECHECK_RUBRIC,
  buildArcPrecheckPrompt,
  checkArcPrecheck,
  extractFacts,
  gateArcPrecheckVerdict,
  resolveSurface,
  settledComponent,
  type PrecheckSpec,
} from '../../lib/demo-arc-precheck';
import { checkSceneVariety } from '../../lib/demo-scene-variety';
import { checkArcLadder } from '../../lib/demo-arc-ladder';

// ace#2735. The fixture is the authored spec + realized map of
// spark-facilitator/20261004-1706's Phase 7 DDD run (2026-10-06-002), whose
// post-render arc judge reported, verbatim: "Scenes 4 and 5 both end on the same
// community visit-list component", "The finale (scene 6) restates scene 1/2's
// headline fact (Kuunika 66.0% ...)", and "Scene 5 ... is a side-branch ... its
// slot is not load-bearing". Each is pinned here to be found from the TEXT,
// before any render.
const SPEC: PrecheckSpec = JSON.parse(readFileSync(join(__dirname, '../fixtures/demo-arc/spark-facilitator-20261004-1706-spec.json'), 'utf8')).spec;
const REALIZED: Record<string, unknown> = JSON.parse(
  readFileSync(join(__dirname, '../fixtures/demo-arc/spark-facilitator-20261004-1706-spec.json'), 'utf8'),
).realized;
const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x));

describe('the Spark spec the arc judge marked down', () => {
  const r = checkArcPrecheck(SPEC, REALIZED);

  it('blocks scenes 4 and 5: the same component (the community visit list) of the same worker-review surface', () => {
    const f = r.findings.find((x) => x.kind === 'same-surface-component');
    expect(f?.scenes).toEqual([4, 5]);
    expect(f?.blocking).toBe(true);
    expect(f?.detail).toMatch(/labs\/workflow\/7412\/run\//);
    expect(r.pass).toBe(false);
  });

  it('reports the finale restating the opening headline fact (Kuunika 66%)', () => {
    const f = r.findings.find((x) => x.kind === 'finale-restates-opening');
    expect(f?.blocking).toBe(false);
    expect(f?.detail).toMatch(/Kuunika 66%/);
  });

  it('reports scene 5 as a side-branch', () => {
    const f = r.findings.find((x) => x.kind === 'side-branch-scene');
    expect(f?.scenes).toEqual([5]);
    expect(f?.blocking).toBe(false);
  });

  it('is the gap the existing sequence checks leave: both pass this spec', () => {
    expect(checkSceneVariety(SPEC as never).pass).toBe(true);
    expect(checkArcLadder(SPEC as never).pass).toBe(true);
  });
});

describe('controls — each rule passes the spec once its finding is fixed', () => {
  it('scene 5 framed on another component of the review page clears the blocker', () => {
    const s = copy(SPEC);
    s.scenes![4].actions = s.scenes![4].actions!.filter((a) => !(a.kind === 'wait_for' && /h2/.test(a.target ?? '')));
    const r = checkArcPrecheck(s, REALIZED);
    expect(r.findings.some((f) => f.kind === 'same-surface-component')).toBe(false);
    expect(r.pass).toBe(true);
  });

  it('without the realized map the two review URLs are different templates and the rule cannot see them as one surface', () => {
    expect(checkArcPrecheck(SPEC).findings.some((f) => f.kind === 'same-surface-component')).toBe(false);
    expect(resolveSurface('${worker_review_url}', REALIZED)).toBe(resolveSurface('${data_quality_worker_review_url}', REALIZED));
  });

  it('a finale whose claim adds only the opening claim\'s facts is blocking', () => {
    const s = copy(SPEC);
    s.scenes![5].concept_claim = 'The report grades the programme against the 80% and 75% targets.';
    const f = checkArcPrecheck(s, REALIZED).findings.find((x) => x.kind === 'finale-restates-opening');
    expect(f?.blocking).toBe(true);
  });

  it('a finale that names new facts only is not reported', () => {
    const s = copy(SPEC);
    s.scenes![5].narrative = 'Daniel opens Benchmarks: Kuunika is 5th of 5, and the other four sit between 87.8% and 95.6%.';
    expect(checkArcPrecheck(s, REALIZED).findings.some((x) => x.kind === 'finale-restates-opening')).toBe(false);
  });

  it('a scene tied to its neighbour by name is not a side-branch', () => {
    const s = copy(SPEC);
    s.scenes![4].narrative += ' Unlike Chisoti, these meetings all happened.';
    expect(checkArcPrecheck(s, REALIZED).findings.some((x) => x.kind === 'side-branch-scene')).toBe(false);
  });
});

// ace#2747. canopy's ddd-spec-qa requires a `role: overview` scene on any spec of
// ≥4 scenes, and its renderer absorbs that scene into the intro title card. On
// spark-facilitator/20261004-1706 (Phase 7 attempt 3) the judge pass, shown the
// overview as scene 1, scored escalation 2 — "Scene 1 is a roadmap with no data"
// — and the gate blocked a spec canopy accepts. The overview is the title, not a
// body scene.
describe('a role: overview scene is canopy\'s intro card, not a body scene (ace#2747)', () => {
  const OVERVIEW = {
    id: 'programme-review-overview',
    role: 'overview',
    persona: SPEC.scenes![0].persona,
    title: 'How the programme review works',
    url: SPEC.scenes![0].url,
    concept_claim: 'The review grades the programme against the 80% and 75% targets, then drills to partners and facilitators.',
    narrative: 'This is a quick overview of how we review the programme: first the headline, then partners, then facilitators.',
    actions: [],
  };
  const withOverview = (): PrecheckSpec => {
    const s = copy(SPEC);
    s.scenes = [copy(OVERVIEW), ...s.scenes!];
    delete s.scenes[1].url; // the first body scene on the overview's surface omits its url, as authored
    return s;
  };

  it('finds the same defects, named by their spec positions', () => {
    const r = checkArcPrecheck(withOverview(), REALIZED);
    expect(r.judged).toBe(6);
    expect(r.findings.find((x) => x.kind === 'same-surface-component')?.scenes).toEqual([5, 6]);
    expect(r.findings.find((x) => x.kind === 'side-branch-scene')?.scenes).toEqual([6]);
    expect(r.findings.find((x) => x.kind === 'finale-restates-opening')?.scenes).toEqual([2, 7]);
  });

  it('never compares the finale with the overview: restating its roadmap is not restating an opening fact', () => {
    const s = withOverview();
    s.scenes![6].concept_claim = 'The report grades the programme against the 80% and 75% targets.';
    s.scenes![1].concept_claim = 'The headline tiles show meeting regularity at 66% for one partner.';
    expect(checkArcPrecheck(s, REALIZED).findings.some((x) => x.kind === 'finale-restates-opening' && x.blocking)).toBe(false);
  });

  it('keeps the overview out of the judge prompt and tells the judge it is the title card', () => {
    const p = buildArcPrecheckPrompt(withOverview(), checkArcPrecheck(withOverview(), REALIZED), REALIZED);
    expect(p).not.toMatch(/## Scene 1: /);
    expect(p).not.toMatch(/quick overview of how we review/);
    expect(p).toMatch(/## Scene 2: /);
    expect(p).toMatch(/Scene 1 \(role: overview\) is not listed below: the renderer absorbs the overview into the narrated intro title card/);
    expect(p).toMatch(/# Scenes \(6\)/);
    // the first body scene inherits the overview's surface
    expect(p).toMatch(/## Scene 2: [^\n]*\npersona: [^\n]*surface: (?!\(unset\))/);
  });

  it('a recorded-style spec has no title card, so its overview stays a scene', () => {
    const s = { ...withOverview(), style: 'recorded' };
    expect(checkArcPrecheck(s, REALIZED).judged).toBe(7);
    expect(buildArcPrecheckPrompt(s, checkArcPrecheck(s, REALIZED), REALIZED)).toMatch(/## Scene 1: /);
  });

  it('demo-narrative authors the overview before 3c, so the gate judges the spec canopy renders', () => {
    const skill = readFileSync(join(__dirname, '../../skills/demo-narrative/SKILL.md'), 'utf8');
    const step3 = skill.slice(skill.indexOf('\n3. '), skill.indexOf('\n3b. '));
    expect(step3).toMatch(/role: overview/);
    expect(step3).toMatch(/ace#2747/);
  });
});

describe('units', () => {
  it('normalises facts and components', () => {
    expect(extractFacts('80.0% vs 80% and 5th of 5')).toEqual(['80%', '5 of 5']);
    expect(settledComponent({ actions: [{ kind: 'wait_for', target: 'css:tr:has-text("x")' }] })).toBeNull();
    expect(settledComponent({ actions: [{ kind: 'wait_for', target: 'css:h2:has-text("Community A")' }] })).toBe('css:h2:has-text("…")');
  });

  it('never passes an empty deck as judged', () => {
    expect(checkArcPrecheck({ scenes: [] }).judged).toBe(0);
  });
});

describe('the text-only judge pass mirrors ddd-arc-eval and never replaces it', () => {
  it('carries the five ddd-arc-eval dimensions with their weights', () => {
    expect(ARC_PRECHECK_RUBRIC.dimensions.map((d) => [d.id, d.weight])).toEqual([
      ['arc_shape', 0.3], ['escalation', 0.25], ['visual_variety', 0.2], ['persona_coherence', 0.15], ['opening_and_close', 0.1],
    ]);
  });

  it('puts every scene and every deterministic finding in the prompt', () => {
    const p = buildArcPrecheckPrompt(SPEC, checkArcPrecheck(SPEC, REALIZED), REALIZED);
    expect(p).toMatch(/## Scene 6: /);
    expect(p).toMatch(/same-surface-component, blocking\] scenes 4, 5/);
    expect(p).toMatch(/not the verdict/);
  });

  it('gates on the verdict: ≤ 2 blocks, 3 is reported, a missing dimension fails', () => {
    const all = (n: number) => Object.fromEntries(ARC_PRECHECK_RUBRIC.dimensions.map((d) => [d.id, { score: n }]));
    expect(gateArcPrecheckVerdict({ dimensions: all(4) }).pass).toBe(true);
    expect(gateArcPrecheckVerdict({ dimensions: all(3) }).detail).toMatch(/at 3 \(reported\)/);
    expect(gateArcPrecheckVerdict({ dimensions: { ...all(4), arc_shape: { score: 2 } } }).pass).toBe(false);
    expect(gateArcPrecheckVerdict({ dimensions: { arc_shape: { score: 4 } } }).pass).toBe(false);
  });

  it('is wired into demo-narrative before the hand-off and into Phase 7 before the DDD dispatch', () => {
    const skill = readFileSync(join(__dirname, '../../skills/demo-narrative/SKILL.md'), 'utf8');
    expect(skill).toMatch(/demo-arc-precheck/);
    expect(skill).toMatch(/never replaces .*ddd-arc-eval/i);
    const agent = readFileSync(join(__dirname, '../../agents/synthetic-data-and-workflows.md'), 'utf8');
    expect(agent).toMatch(/demo-arc-precheck/);
  });
});
