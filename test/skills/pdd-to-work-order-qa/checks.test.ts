/**
 * Unit tests for static QA checks in skills/pdd-to-work-order-qa/checks.ts.
 *
 * Each check is a pure function. Tests use the fixture files under
 * test/skills/pdd-to-work-order-qa/fixtures/ for realistic full-document
 * coverage, plus small inline strings to exercise individual branches.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  checkAllRequiredSectionsPresent,
  checkRequiredWoDecisionsPresent,
  checkPeriodOfPerformanceComplete,
  checkPaymentScheduleSumsTo100,
  checkTotalNtePresent,
  checkSignatureBlocksPresent,
  checkArchetypeAppropriateScope,
  checkNoScaffoldingMarkers,
  CHECKS,
} from '../../../skills/pdd-to-work-order-qa/checks';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures');

const GOOD_WO = readFileSync(join(FIXTURES, 'good-work-order.md'), 'utf8');
const MISSING_SECTIONS_WO = readFileSync(join(FIXTURES, 'missing-sections.md'), 'utf8');
const BAD_PAYMENT_WO = readFileSync(join(FIXTURES, 'bad-payment-schedule.md'), 'utf8');
const GOOD_DECISIONS = readFileSync(join(FIXTURES, 'good-decisions.yaml'), 'utf8');
const MISSING_WO_DECISIONS = readFileSync(join(FIXTURES, 'missing-wo-decisions.yaml'), 'utf8');

describe('checkAllRequiredSectionsPresent', () => {
  test('passes for the good fixture (all 11 sections)', () => {
    const r = checkAllRequiredSectionsPresent(GOOD_WO);
    expect(r.pass).toBe(true);
  });

  test('fails for missing-sections fixture (payment terms removed)', () => {
    const r = checkAllRequiredSectionsPresent(MISSING_SECTIONS_WO);
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/Payment Terms|Total Not-to-Exceed|Payment Schedule/i);
    expect(r.auto_fix_hint).toBeTruthy();
  });
});

describe('checkRequiredWoDecisionsPresent', () => {
  test('passes for good-decisions.yaml (all four wo-* rows)', () => {
    const r = checkRequiredWoDecisionsPresent(GOOD_DECISIONS);
    expect(r.pass).toBe(true);
  });

  test('fails when wo-total-not-to-exceed-usd and wo-payment-schedule-split missing', () => {
    const r = checkRequiredWoDecisionsPresent(MISSING_WO_DECISIONS);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('wo-total-not-to-exceed-usd');
    expect(r.detail).toContain('wo-payment-schedule-split');
    expect(r.auto_fix_hint).toBeTruthy();
  });
});

describe('checkPeriodOfPerformanceComplete', () => {
  test('passes for explicit "2026-05-22 to 2026-07-31"', () => {
    const r = checkPeriodOfPerformanceComplete(GOOD_WO);
    expect(r.pass).toBe(true);
  });

  test('passes for [TBD] placeholder', () => {
    const wo = GOOD_WO.replace('2026-05-22 to 2026-07-31', '[TBD]');
    expect(checkPeriodOfPerformanceComplete(wo).pass).toBe(true);
  });

  test('fails when scaffolding marker remains', () => {
    const wo = GOOD_WO.replace('2026-05-22 to 2026-07-31', '{{wo_period_of_performance}}');
    const r = checkPeriodOfPerformanceComplete(wo);
    expect(r.pass).toBe(false);
    expect(r.auto_fix_hint).toBeTruthy();
  });

  test('fails when only one date is present', () => {
    const wo = GOOD_WO.replace('2026-05-22 to 2026-07-31', '2026-05-22');
    const r = checkPeriodOfPerformanceComplete(wo);
    expect(r.pass).toBe(false);
  });
});

describe('checkPaymentScheduleSumsTo100', () => {
  test('passes when 40% + 60% sum to 100', () => {
    const r = checkPaymentScheduleSumsTo100(GOOD_WO);
    expect(r.pass).toBe(true);
  });

  test('fails when 40% + 50% sum to 90', () => {
    const r = checkPaymentScheduleSumsTo100(BAD_PAYMENT_WO);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('90');
    expect(r.auto_fix_hint).toBeTruthy();
  });

  test('fails when payment schedule section is missing', () => {
    const r = checkPaymentScheduleSumsTo100(MISSING_SECTIONS_WO);
    expect(r.pass).toBe(false);
  });
});

describe('checkTotalNtePresent', () => {
  test('passes for "USD 2500" in section 6.1', () => {
    expect(checkTotalNtePresent(GOOD_WO).pass).toBe(true);
  });

  test('passes for "USD [TBD]" placeholder', () => {
    const wo = GOOD_WO.replace('USD 2500', 'USD [TBD]');
    expect(checkTotalNtePresent(wo).pass).toBe(true);
  });

  test('fails when section is missing entirely', () => {
    const r = checkTotalNtePresent(MISSING_SECTIONS_WO);
    expect(r.pass).toBe(false);
    expect(r.auto_fix_hint).toBeTruthy();
  });

  test('fails when USD has no value or placeholder', () => {
    const wo = GOOD_WO.replace('USD 2500', 'USD ');
    const r = checkTotalNtePresent(wo);
    expect(r.pass).toBe(false);
  });
});

describe('checkSignatureBlocksPresent', () => {
  test('passes when both Subcontractor and Dimagi blocks present', () => {
    expect(checkSignatureBlocksPresent(GOOD_WO).pass).toBe(true);
  });

  test('fails when Subcontractor block missing', () => {
    const wo = GOOD_WO.replace('**Subcontractor**', '');
    const r = checkSignatureBlocksPresent(wo);
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/Subcontractor/i);
  });

  test('fails when Dimagi block missing', () => {
    const wo = GOOD_WO.replace('**Dimagi, Inc.**', '');
    const r = checkSignatureBlocksPresent(wo);
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/Dimagi/i);
  });
});

describe('checkArchetypeAppropriateScope', () => {
  test('atomic-visit passes when scope mentions per-visit + photo/GPS', () => {
    const r = checkArchetypeAppropriateScope(GOOD_WO, 'atomic-visit');
    expect(r.pass).toBe(true);
  });

  test('atomic-visit fails when scope lacks per-visit phrasing', () => {
    const wo = GOOD_WO.replace(/per visit/gi, 'as part of the program');
    const r = checkArchetypeAppropriateScope(wo, 'atomic-visit');
    expect(r.pass).toBe(false);
    expect(r.auto_fix_hint).toBeTruthy();
  });

  test('focus-group passes when scope mentions per-session + gdoc', () => {
    const wo = GOOD_WO.replace(
      /## 2. Scope of Work[\s\S]*?## 3\./,
      `## 2. Scope of Work\n\nThe Partner facilitates one focus-group session per session, capturing notes in a gdoc and ending with an attestation form.\n\n## 3.`,
    );
    const r = checkArchetypeAppropriateScope(wo, 'focus-group');
    expect(r.pass).toBe(true);
  });

  test('focus-group fails when no per-session/attestation phrasing', () => {
    const r = checkArchetypeAppropriateScope(GOOD_WO, 'focus-group');
    expect(r.pass).toBe(false);
  });

  test('multi-stage passes when scope mentions stages', () => {
    const wo = GOOD_WO.replace(
      /## 2. Scope of Work[\s\S]*?## 3\./,
      `## 2. Scope of Work\n\nThe intervention runs across stage 1, stage 2, and stage 3 of the care pathway, with one form per stage.\n\n## 3.`,
    );
    const r = checkArchetypeAppropriateScope(wo, 'multi-stage');
    expect(r.pass).toBe(true);
  });

  test('multi-stage fails when no stage phrasing', () => {
    const r = checkArchetypeAppropriateScope(GOOD_WO, 'multi-stage');
    expect(r.pass).toBe(false);
  });
});

describe('checkNoScaffoldingMarkers', () => {
  test('passes when no <<...>> markers remain', () => {
    expect(checkNoScaffoldingMarkers(GOOD_WO).pass).toBe(true);
  });

  test('fails when a <<placeholder>> marker leaked through', () => {
    const wo = GOOD_WO + '\n\n<<unfilled_placeholder>> leaked here.\n';
    const r = checkNoScaffoldingMarkers(wo);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('<<unfilled_placeholder>>');
    expect(r.auto_fix_hint).toBeTruthy();
  });

  test('lists deduplicated markers when several appear', () => {
    const wo = GOOD_WO + '\n\n<<a>> and <<a>> and <<b>>.\n';
    const r = checkNoScaffoldingMarkers(wo);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('<<a>>');
    expect(r.detail).toContain('<<b>>');
    // dedup: <<a>> appears once in detail
    expect((r.detail!.match(/<<a>>/g) || []).length).toBe(1);
  });
});

describe('CHECKS array', () => {
  test('exports eight checks in canonical order', () => {
    expect(CHECKS).toHaveLength(8);
    const ids = CHECKS.map((c) => c.id);
    expect(ids).toEqual([
      'all_required_sections_present',
      'required_wo_decisions_present',
      'period_of_performance_complete',
      'payment_schedule_sums_to_100',
      'total_nte_present',
      'signature_blocks_present',
      'archetype_appropriate_scope',
      'no_scaffolding_markers',
    ]);
  });
});
