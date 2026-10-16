/**
 * The day-1 Connect platform-constraint check (ace#3036 follow-up).
 *
 * The kaduna fixture is a VERBATIM excerpt of the real Phase 1 PDD of
 * kaduna-graduation/20261015-1411 — the run whose role-gated Learn app (9 FLW +
 * 5 enumerator modules) Connect could never complete. It must FAIL at Phase 1.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { DecisionRowStrictSchema } from '../../lib/decisions-schema';
import {
  checkPlatformConstraints,
  deriveFacts,
  findingToDecisionRow,
  loadPlatformConstraints,
  parseDeliverUnitMap,
  validatePlatformConstraints,
  type PlatformConstraintsConfig,
} from '../../lib/platform-constraints';
import { extractArchetype, programParametersFromPdd } from '../../skills/idea-to-pdd-qa/checks';

const KADUNA = readFileSync(
  fileURLToPath(new URL('../fixtures/platform-constraints/kaduna-graduation-20261015-1411-pdd.md', import.meta.url)),
  'utf8',
);
const CLEAN = readFileSync(fileURLToPath(new URL('../fixtures/ACE-PDD-Pass-001/pdd.md', import.meta.url)), 'utf8');

function params(rows: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(rows));
}

const ids = (m: Map<string, string>, archetype?: string) => checkPlatformConstraints(m, archetype).map((f) => f.rule.id);

describe('config/platform-constraints.yaml', () => {
  const cfg = loadPlatformConstraints();

  it('is structurally valid and every rule cites Connect at the pinned sha', () => {
    expect(() => validatePlatformConstraints(cfg)).not.toThrow();
    for (const r of cfg.rules) {
      for (const s of r.source) expect(s).toMatch(new RegExp(`^dimagi/commcare-connect@${cfg.connect_sha}:commcare_connect/\\S+\\.py:\\d+(-\\d+)?$`));
    }
  });

  it('encodes the brief\'s platform facts', () => {
    expect(cfg.rules.map((r) => r.id)).toEqual(
      expect.arrayContaining([
        'learn-completion-counts-every-module',
        'learn-modules-never-deleted',
        'one-active-opportunity-per-app',
        'deliver-unit-needs-payment-unit',
        'optional-only-payment-unit-never-completes',
        'daily-cap-per-payment-unit',
        'visits-before-start-are-trial',
        'repeat-visit-same-entity-is-duplicate',
        'budget-funds-claims-in-order',
        'passing-score-is-per-app',
      ]),
    );
  });

  it('rejects an uncited rule, an unknown fact and a recommended outside options', () => {
    const bad: PlatformConstraintsConfig = {
      connect_sha: 'c7409bd35',
      rules: [{ ...cfg.rules[0], source: ['models.py says so'], recommended: 'nope', when: { fact: 'made_up', op: 'truthy' } }],
    };
    expect(() => validatePlatformConstraints(bad)).toThrow(/not <owner>\/<repo>@<sha>.*\n.*recommended.*\n.*unknown fact "made_up"/s);
  });
});


describe('the real PDDs', () => {
  it('kaduna (verbatim Program Parameters) trips the multi-role Learn rule', () => {
    const findings = checkPlatformConstraints(programParametersFromPdd(KADUNA), extractArchetype(KADUNA));
    expect(findings.map((f) => f.rule.id)).toContain('learn-module-visibility-undeclared-multi-role');
    expect(findings.map((f) => f.severity)).toContain('blocker');
  });

  it('the clean PDD has no findings', () => {
    const findings = checkPlatformConstraints(programParametersFromPdd(CLEAN), extractArchetype(CLEAN));
    expect(findings).toEqual([]);
  });
});

describe('each rule fires on its predicate and only there', () => {
  it('fractional payment amounts', () => {
    expect(ids(params({ payment_rate_min: '1.50 [PROPOSED]' }))).toContain('payment-amounts-whole-units');
    expect(ids(params({ payment_rate_min: '1,500 [PROPOSED]' }))).not.toContain('payment-amounts-whole-units');
  });

  it('daily cap of zero / per payment unit', () => {
    expect(ids(params({ daily_cap_per_flw: '0' }))).toContain('daily-cap-at-least-one');
    expect(ids(params({ daily_cap_per_flw: '5', payment_unit_count: '3' }))).toContain('daily-cap-per-payment-unit');
    expect(ids(params({ daily_cap_per_flw: '5' }))).toEqual([]);
  });

  it('optional deliver units', () => {
    expect(parseDeliverUnitMap('visit: hh_visit, photo?; followup: fu?')).toEqual(
      new Map([
        ['visit', [{ form: 'hh_visit', optional: false }, { form: 'photo', optional: true }]],
        ['followup', [{ form: 'fu', optional: true }]],
      ]),
    );
    const found = ids(params({ deliver_unit_map: 'visit: hh_visit, photo?; followup: fu?' }));
    expect(found).toContain('optional-only-payment-unit-never-completes');
    expect(found).toContain('optional-deliver-units-are-any-of');
  });

  it('unpaid deliver forms', () => {
    expect(ids(params({ unpaid_deliver_forms: 'group formation, referral' }))).toContain('deliver-unit-needs-payment-unit');
    expect(ids(params({ unpaid_deliver_forms: 'none' }))).toEqual([]);
  });

  it('repeat visits to one entity id on a longitudinal PDD', () => {
    expect(ids(params({ entity_id_grain: 'household id' }), 'longitudinal-visits')).toContain('repeat-visit-same-entity-is-duplicate');
    expect(ids(params({ entity_id_grain: 'participant id + scheduled month' }), 'longitudinal-visits')).toEqual([]);
    expect(ids(params({ entity_id_grain: 'household id' }), 'atomic-visit')).toEqual([]);
  });

  it('paid work before the start date', () => {
    expect(ids(params({ opportunity_start_date: '2026-11-01', payment_unit_start_date: '2026-12-01' }))).toContain('visits-before-start-are-trial');
    expect(ids(params({ paid_work_before_start: 'yes' }))).toContain('visits-before-start-are-trial');
  });

  it('budget below the cohort\'s reserved claims', () => {
    expect(ids(params({ total_budget: '1000', flw_payment_per_visit: '100', llo_payment_per_visit: '10', campaign_target_visits: '20' }))).toContain(
      'budget-funds-claims-in-order',
    );
    // kaduna's own arithmetic: 2132 x (1000 + 100) = 2345200 exactly
    expect(ids(params({ total_budget: '2345200', flw_payment_per_visit: '1000', llo_payment_per_visit: '100', campaign_target_visits: '2132' }))).toEqual([]);
  });

  it('a pass mark per role', () => {
    expect(ids(params({ learn_passing_score: '80 for FLWs, 70 for enumerators' }))).toContain('passing-score-is-per-app');
    expect(ids(params({ learn_passing_score: '80' }))).toEqual([]);
  });

  it('reused Learn app', () => {
    expect(ids(params({ learn_app_source: 'reuse the 2025 cohort app' }))).toContain('learn-modules-never-deleted');
  });

  it('derives two roles from a role property even without worker_roles', () => {
    expect(deriveFacts(params({ role_property: 'worker role on the HQ user' })).worker_role_count).toBe(2);
    expect(deriveFacts(params({})).worker_role_count).toBe(1);
  });
});

describe('findings become decision rows', () => {
  it('every rule\'s row is a valid strict decision row, already resolved from source', () => {
    for (const rule of loadPlatformConstraints().rules) {
      const row = findingToDecisionRow({ rule, severity: rule.severity, evidence: {} });
      const parsed = DecisionRowStrictSchema.safeParse(row);
      expect(parsed.success, `${rule.id}: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`).toBe(true);
      expect(row).toMatchObject({ kind: 'platform-behaviour', resolved_by: 'source', options: rule.options, 'ai-default': rule.recommended });
      expect(row.review_ask).toBe(rule.severity === 'blocker' ? 'required-before' : 'recommended-confirmation');
    }
  });
});

