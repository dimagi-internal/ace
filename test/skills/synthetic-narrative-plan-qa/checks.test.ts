/**
 * Unit tests for static QA checks in skills/synthetic-narrative-plan-qa/checks.ts.
 *
 * Each check is a pure function. Tests use small inline YAML strings (no
 * fixtures) to exercise individual branches.
 */

import { describe, expect, test } from 'vitest';
import {
  checkManifestYamlParses,
  checkRequiredKeysPresent,
  checkFlwPersonasWellFormed,
  checkBeneficiaryCohortsWellFormed,
  checkKpiFieldPathsResolvable,
  checkAnomaliesTraceable,
  checkCoachingArcsMatchPersonas,
  checkRandomSeedPresent,
  checkTimelineDatesConsistent,
  CHECKS,
} from '../../../skills/synthetic-narrative-plan-qa/checks';

const VALID_MANIFEST = `opportunity_id: 42
opportunity_name: "Test Opp"
random_seed: 20260509

timeline:
  start_date: "2026-04-11"
  end_date: "2026-05-09"
  weeks: 4

flw_personas:
  - id: "asha"
    display_name: "Asha M."
    archetype: "rockstar"
  - id: "bao"
    display_name: "Bao N."
    archetype: "steady"
  - id: "carla"
    display_name: "Carla R."
    archetype: "steady"
  - id: "dinesh"
    display_name: "Dinesh P."
    archetype: "struggling"
  - id: "esi"
    display_name: "Esi K."
    archetype: "new_hire"

beneficiary_cohorts:
  - id: "primary"
    size: 50

anomalies:
  - id: "dinesh-week3-price-outlier"
    type: "field_outlier"
    flw_ids: ["dinesh"]
    week: 3
    field_path: "form.product_grp.price"
    detection_path: "form.product_grp.price"

coaching_arcs:
  - flw_id: "dinesh"
    week_triggered: 3

kpi_config:
  - kpi: "accuracy"
    field_path: "form.product_grp.price"
    aggregation: "validated_rate"
    threshold_underperform: 0.75
    threshold_target: 0.90
`;

describe('checkManifestYamlParses', () => {
  test('passes on valid manifest', () => {
    expect(checkManifestYamlParses(VALID_MANIFEST).pass).toBe(true);
  });

  test('fails on garbage YAML', () => {
    const r = checkManifestYamlParses('::: not yaml :::\n  - oops\n[\n');
    expect(r.pass).toBe(false);
    expect(r.auto_fix_hint).toBeTruthy();
  });

  test('fails when top level is a sequence, not a mapping', () => {
    const r = checkManifestYamlParses('- a\n- b\n');
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/mapping/);
  });

  test('fails on empty file', () => {
    expect(checkManifestYamlParses('').pass).toBe(false);
  });
});

describe('checkRequiredKeysPresent', () => {
  test('passes when all required keys present', () => {
    expect(checkRequiredKeysPresent(VALID_MANIFEST).pass).toBe(true);
  });

  test('fails when timeline missing', () => {
    const m = VALID_MANIFEST.replace(/timeline:[\s\S]*?weeks: 4/m, '');
    const r = checkRequiredKeysPresent(m);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('timeline');
    expect(r.auto_fix_hint).toBeTruthy();
  });

  test('fails when multiple keys missing', () => {
    const m = `opportunity_id: 42\nrandom_seed: 1\n`;
    const r = checkRequiredKeysPresent(m);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('timeline');
    expect(r.detail).toContain('flw_personas');
  });
});

describe('checkFlwPersonasWellFormed', () => {
  test('passes on default 5-persona cast', () => {
    const r = checkFlwPersonasWellFormed(VALID_MANIFEST);
    expect(r.pass).toBe(true);
    expect(r.detail).toContain('5');
  });

  test('fails on empty flw_personas', () => {
    const m = VALID_MANIFEST.replace(/flw_personas:[\s\S]*?archetype: "new_hire"/m, 'flw_personas: []');
    const r = checkFlwPersonasWellFormed(m);
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/empty|missing|not an array/);
  });

  test('fails on invalid archetype value', () => {
    const m = VALID_MANIFEST.replace('archetype: "rockstar"', 'archetype: "godlike"');
    const r = checkFlwPersonasWellFormed(m);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('#0');
  });

  test('fails when persona missing required id', () => {
    // Upstream Pydantic Manifest § FlwPersona declares `id: str` REQUIRED.
    // Earlier ACE-side draft made id optional; cross-check 2026-05-09 tightened.
    const m = `opportunity_id: 1
random_seed: 1
timeline: { start_date: "2026-01-01", end_date: "2026-02-01", weeks: 4 }
flw_personas:
  - display_name: "anon"
    archetype: "steady"
beneficiary_cohorts:
  - { id: "p", size: 1 }
kpi_config: []
`;
    const r = checkFlwPersonasWellFormed(m);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('#0');
  });
});

describe('checkKpiFieldPathsResolvable', () => {
  test('passes (INFO) when no deliver-summary context provided', () => {
    const r = checkKpiFieldPathsResolvable(VALID_MANIFEST);
    expect(r.pass).toBe(true);
    expect(r.detail).toMatch(/skipped/);
  });

  test('passes when all field_paths appear in summary', () => {
    const summary = 'Form has fields: form.product_grp.price, form.weight_kg';
    const r = checkKpiFieldPathsResolvable(VALID_MANIFEST, { deliver_summary: summary });
    expect(r.pass).toBe(true);
  });

  test('fails when a field_path is not in the summary', () => {
    const summary = 'Form has fields: form.weight_kg only';
    const r = checkKpiFieldPathsResolvable(VALID_MANIFEST, { deliver_summary: summary });
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('form.product_grp.price');
  });
});

describe('checkAnomaliesTraceable', () => {
  test('passes on absent anomalies', () => {
    const m = VALID_MANIFEST.replace(/anomalies:[\s\S]*?detection_path: "form\.product_grp\.price"/m, '');
    expect(checkAnomaliesTraceable(m).pass).toBe(true);
  });

  test('passes when all anomalies are traceable', () => {
    expect(checkAnomaliesTraceable(VALID_MANIFEST).pass).toBe(true);
  });

  test('fails on anomaly without detection_path or field_path', () => {
    const m = `opportunity_id: 1
opportunity_name: "x"
random_seed: 1
timeline: { start_date: "2026-01-01", end_date: "2026-02-01", weeks: 4 }
flw_personas:
  - id: "asha"
    archetype: "rockstar"
beneficiary_cohorts:
  - { id: "p", size: 1 }
kpi_config:
  - { kpi: "x", field_path: "form.x", aggregation: "mean", threshold_underperform: 0.5 }
anomalies:
  - id: "a1"
    type: "field_outlier"
    flw_ids: ["asha"]
    week: 2
`;
    const r = checkAnomaliesTraceable(m);
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/field_path|detection_path/);
  });

  test('fails on anomaly missing flw_ids (was singular flw_id; upstream uses plural list)', () => {
    // Upstream Pydantic Manifest § Anomaly declares `flw_ids: list[str]`
    // (plural list), NOT `flw_id: str`. Earlier ACE-side draft had this
    // wrong; cross-check 2026-05-09 fixed.
    const m = `opportunity_id: 1
opportunity_name: "x"
random_seed: 1
timeline: { start_date: "2026-01-01", end_date: "2026-02-01", weeks: 4 }
flw_personas:
  - id: "asha"
    archetype: "rockstar"
beneficiary_cohorts:
  - { id: "p", size: 1 }
kpi_config:
  - { kpi: "x", field_path: "form.x", aggregation: "mean", threshold_underperform: 0.5 }
anomalies:
  - id: "a1"
    type: "field_outlier"
    week: 2
    field_path: "form.x"
`;
    const r = checkAnomaliesTraceable(m);
    expect(r.pass).toBe(false);
    expect((r.detail ?? '').toLowerCase()).toContain('required');
  });
});

describe('checkCoachingArcsMatchPersonas', () => {
  test('passes when arcs map to personas', () => {
    expect(checkCoachingArcsMatchPersonas(VALID_MANIFEST).pass).toBe(true);
  });

  test('passes when coaching_arcs absent or empty', () => {
    const m = VALID_MANIFEST.replace(/coaching_arcs:[\s\S]*?week_triggered: 3/m, 'coaching_arcs: []');
    expect(checkCoachingArcsMatchPersonas(m).pass).toBe(true);
  });

  test('fails when arc references unknown flw_id', () => {
    const m = VALID_MANIFEST.replace(
      'coaching_arcs:\n  - flw_id: "dinesh"\n    week_triggered: 3',
      'coaching_arcs:\n  - flw_id: "ghost"\n    week_triggered: 3',
    );
    const r = checkCoachingArcsMatchPersonas(m);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('ghost');
  });
});

describe('checkRandomSeedPresent', () => {
  test('passes on positive integer', () => {
    expect(checkRandomSeedPresent('random_seed: 20260509\n').pass).toBe(true);
  });

  test('fails on missing seed', () => {
    expect(checkRandomSeedPresent('opportunity_id: 1\n').pass).toBe(false);
  });

  test('fails on negative seed', () => {
    expect(checkRandomSeedPresent('random_seed: -1\n').pass).toBe(false);
  });

  test('fails on non-integer seed', () => {
    expect(checkRandomSeedPresent('random_seed: "today"\n').pass).toBe(false);
  });
});

describe('checkTimelineDatesConsistent', () => {
  test('passes on valid timeline', () => {
    expect(checkTimelineDatesConsistent(VALID_MANIFEST).pass).toBe(true);
  });

  test('fails when start >= end', () => {
    const m = VALID_MANIFEST
      .replace('start_date: "2026-04-11"', 'start_date: "2026-06-09"');
    const r = checkTimelineDatesConsistent(m);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('precede');
  });

  test('fails when weeks < 1', () => {
    const m = VALID_MANIFEST.replace('weeks: 4', 'weeks: 0');
    const r = checkTimelineDatesConsistent(m);
    expect(r.pass).toBe(false);
  });

  test('fails when timeline missing', () => {
    const m = `random_seed: 1\n`;
    const r = checkTimelineDatesConsistent(m);
    expect(r.pass).toBe(false);
  });
});

describe('checkBeneficiaryCohortsWellFormed (jjackson/ace#713)', () => {
  test('passes the valid manifest (cohort with id + size, no progression)', () => {
    expect(checkBeneficiaryCohortsWellFormed(VALID_MANIFEST).pass).toBe(true);
  });

  test('passes a cohort with a valid progression enum + binary field_distribution', () => {
    const m = VALID_MANIFEST.replace(
      /beneficiary_cohorts:[\s\S]*?size: 50/m,
      `beneficiary_cohorts:
  - id: "primary"
    size: 50
    progression: "improvement_curve"
    field_distributions:
      slept_under_net:
        distribution: "binary"
        p_yes: 0.6`,
    );
    expect(checkBeneficiaryCohortsWellFormed(m).pass).toBe(true);
  });

  test('FAILS an invalid progression value (the rising_yes_share escape)', () => {
    const m = VALID_MANIFEST.replace(
      /beneficiary_cohorts:[\s\S]*?size: 50/m,
      `beneficiary_cohorts:
  - id: "primary"
    size: 50
    progression: "rising_yes_share"`,
    );
    const r = checkBeneficiaryCohortsWellFormed(m);
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/progression/i);
    expect(r.auto_fix_hint).toBeTruthy();
  });

  test('FAILS a field_distributions entry with a non-{normal,uniform,binary} tag (the categorical escape)', () => {
    const m = VALID_MANIFEST.replace(
      /beneficiary_cohorts:[\s\S]*?size: 50/m,
      `beneficiary_cohorts:
  - id: "primary"
    size: 50
    field_distributions:
      slept_under_net:
        type: "categorical"
        values: ["yes", "no"]`,
    );
    const r = checkBeneficiaryCohortsWellFormed(m);
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/field_distributions/i);
  });

  test('fails when beneficiary_cohorts is empty', () => {
    const m = VALID_MANIFEST.replace(
      /beneficiary_cohorts:[\s\S]*?size: 50/m,
      `beneficiary_cohorts: []`,
    );
    const r = checkBeneficiaryCohortsWellFormed(m);
    expect(r.pass).toBe(false);
  });
});

describe('CHECKS array', () => {
  test('exports nine checks in stable order', () => {
    expect(CHECKS).toHaveLength(9);
    expect(CHECKS.map((c) => c.id)).toEqual([
      'manifest_yaml_parses',
      'required_keys_present',
      'flw_personas_well_formed',
      'beneficiary_cohorts_well_formed',
      'kpi_field_paths_resolvable',
      'anomalies_traceable',
      'coaching_arcs_match_personas',
      'random_seed_present',
      'timeline_dates_consistent',
    ]);
  });

  test('every check has type=static', () => {
    for (const c of CHECKS) expect(c.type).toBe('static');
  });
});
