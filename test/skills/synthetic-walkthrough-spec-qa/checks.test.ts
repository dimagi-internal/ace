/**
 * Unit tests for static QA checks in skills/synthetic-walkthrough-spec-qa/checks.ts.
 *
 * Each check is a pure function. Tests use small inline YAML strings to
 * exercise individual branches.
 */

import { describe, expect, test } from 'vitest';
import {
  checkSpecYamlParses,
  checkRequiredTopLevelKeys,
  checkScenesArrayWellFormed,
  checkScenePersonasResolvable,
  checkAiQualityAssertionsFalsifiable,
  checkPersonaPainPointsDocumented,
  checkSceneTitlesUnique,
  CHECKS,
} from '../../../skills/synthetic-walkthrough-spec-qa/checks';

const VALID_SPEC = `name: "turmeric-funder-walkthrough"
narrative: "How a funder evaluates this opp running well"
base_url: "https://labs.connect.dimagi.com"
auth:
  type: command
  check: "test -f ~/.ace/labs-session.json"
  login: "bash login.sh"

personas:
  funder:
    name: "Pat Funder"
    role: "Program officer"
    color: "#16a34a"
    intro: "Cares about cost-per-verified-visit and quality verification flow."

scenes:
  - persona: funder
    title: "Headline panel"
    show: "labs landing page top of screen"
    impressive_because: "138 visits in 4 weeks across 50 vendors"
    ai_quality: "KPI panel must show ≥3 named FLWs with archetype labels visible"
  - persona: funder
    title: "FLW roster"
    show: "labs FLW list"
    impressive_because: "Asha M. delivered 38 visits at 92% completeness"
    ai_quality: "FLW table must include named persona Asha M. with completeness percentage"
  - persona: funder
    title: "Anomaly callout"
    show: "anomaly drill-down for Dinesh week 3"
    impressive_because: "Dinesh's price outliers visibly flagged with context"
    ai_quality: "Page must reference specific FLW + week + field path matching the manifest anomaly"
  - persona: funder
    title: "Cost panel"
    show: "per-verified-visit cost panel"
    impressive_because: "$3.50 per verified visit visible"
    ai_quality: "Page must show a per-visit dollar figure with verification breakdown by Layer A/B/C"
`;

describe('checkSpecYamlParses', () => {
  test('passes on valid spec', () => {
    expect(checkSpecYamlParses(VALID_SPEC).pass).toBe(true);
  });

  test('fails on garbage YAML', () => {
    const r = checkSpecYamlParses('::: not yaml :::\n[\n');
    expect(r.pass).toBe(false);
    expect(r.auto_fix_hint).toBeTruthy();
  });

  test('fails when top level is a sequence', () => {
    expect(checkSpecYamlParses('- a\n- b\n').pass).toBe(false);
  });

  test('fails on empty file', () => {
    expect(checkSpecYamlParses('').pass).toBe(false);
  });
});

describe('checkRequiredTopLevelKeys', () => {
  test('passes on valid spec', () => {
    expect(checkRequiredTopLevelKeys(VALID_SPEC).pass).toBe(true);
  });

  test('fails when narrative missing', () => {
    const m = VALID_SPEC.replace(/narrative:.*\n/, '');
    const r = checkRequiredTopLevelKeys(m);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('narrative');
  });

  test('fails when scenes missing', () => {
    const m = `name: "x"\nnarrative: "y"\nbase_url: "z"\nauth: {}\npersonas: {}\n`;
    const r = checkRequiredTopLevelKeys(m);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('scenes');
  });
});

describe('checkScenesArrayWellFormed', () => {
  test('passes on valid 4-scene spec', () => {
    expect(checkScenesArrayWellFormed(VALID_SPEC).pass).toBe(true);
  });

  test('fails when scenes < 4', () => {
    const m = VALID_SPEC.split('- persona: funder')
      .slice(0, 3) // header + first 2 scenes
      .join('- persona: funder');
    const r = checkScenesArrayWellFormed(m);
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/minimum is 4/);
  });

  test('fails when a scene is missing required fields', () => {
    const m = VALID_SPEC.replace(
      'ai_quality: "KPI panel must show ≥3 named FLWs with archetype labels visible"',
      '',
    );
    const r = checkScenesArrayWellFormed(m);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('#0');
  });

  test('fails when scenes is not an array', () => {
    const m = VALID_SPEC.replace(/scenes:[\s\S]*$/m, 'scenes: not-an-array\n');
    expect(checkScenesArrayWellFormed(m).pass).toBe(false);
  });
});

describe('checkScenePersonasResolvable', () => {
  test('passes when all scene persona keys exist in personas', () => {
    expect(checkScenePersonasResolvable(VALID_SPEC).pass).toBe(true);
  });

  test('fails on orphan persona key', () => {
    const m = VALID_SPEC.replace('persona: funder\n    title: "Headline panel"', 'persona: ghost\n    title: "Headline panel"');
    const r = checkScenePersonasResolvable(m);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('ghost');
  });
});

describe('checkAiQualityAssertionsFalsifiable', () => {
  test('passes on substantive assertions', () => {
    expect(checkAiQualityAssertionsFalsifiable(VALID_SPEC).pass).toBe(true);
  });

  test('fails on trivial "looks good"', () => {
    const m = VALID_SPEC.replace(
      'ai_quality: "KPI panel must show ≥3 named FLWs with archetype labels visible"',
      'ai_quality: "looks good"',
    );
    const r = checkAiQualityAssertionsFalsifiable(m);
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/looks good|trivial|too short/i);
  });

  test('fails on TBD placeholder', () => {
    const m = VALID_SPEC.replace(
      'ai_quality: "KPI panel must show ≥3 named FLWs with archetype labels visible"',
      'ai_quality: "TBD"',
    );
    const r = checkAiQualityAssertionsFalsifiable(m);
    expect(r.pass).toBe(false);
  });
});

describe('checkPersonaPainPointsDocumented', () => {
  test('passes when each persona has an intro', () => {
    expect(checkPersonaPainPointsDocumented(VALID_SPEC).pass).toBe(true);
  });

  test('fails when intro missing', () => {
    const m = VALID_SPEC.replace(/intro:.*\n/, '');
    const r = checkPersonaPainPointsDocumented(m);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('funder');
  });

  test('fails when personas mapping empty', () => {
    const m = VALID_SPEC.replace(/personas:[\s\S]*?(?=\nscenes:)/m, 'personas: {}\n');
    const r = checkPersonaPainPointsDocumented(m);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('empty');
  });
});

describe('checkSceneTitlesUnique', () => {
  test('passes when all titles are unique', () => {
    expect(checkSceneTitlesUnique(VALID_SPEC).pass).toBe(true);
  });

  test('fails on duplicate titles', () => {
    const m = VALID_SPEC.replace('title: "FLW roster"', 'title: "Headline panel"');
    const r = checkSceneTitlesUnique(m);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('Headline panel');
  });
});

describe('CHECKS array', () => {
  test('exports seven checks in stable order', () => {
    expect(CHECKS).toHaveLength(7);
    expect(CHECKS.map((c) => c.id)).toEqual([
      'spec_yaml_parses',
      'required_top_level_keys',
      'scenes_array_well_formed',
      'scene_personas_resolvable',
      'ai_quality_assertions_falsifiable',
      'persona_pain_points_documented',
      'scene_titles_unique',
    ]);
  });

  test('every check has type=static', () => {
    for (const c of CHECKS) expect(c.type).toBe('static');
  });
});
