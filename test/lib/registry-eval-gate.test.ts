import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkRegistryEvalGate, describeRegistryEvalGate } from '../../lib/registry-eval-gate';
import { assertChecked } from '../../lib/check-outcome';

//
// Phase 7 registry gate. On noora-health/20261015-1129, kaduna-graduation/
// 20261015-1411 and smallholder-seasonal/20261015-1402 the registry eval ran
// AFTER data generation and the dashboards, so any finding meant rebuilding the
// cascade. The gate makes "graded and not failing" a precondition of generation.
//
function verdict(disposition: string, extra = ''): string {
  return [
    'skill: semantic-registry-author-eval',
    'target: 6369',
    'ran_at: 2026-10-16T10:00:00Z',
    'capture_path: 7-synthetic/semantic-registry-author_registry.json',
    `overall_score: ${disposition === 'fail' ? 3.2 : 8.1}`,
    `verdict: ${disposition}`,
    'dimensions:',
    '  pdd_fidelity: {score: 8, weight: 0.30}',
    '  definition_correctness: {score: 8, weight: 0.25}',
    '  coverage_honesty: {score: 8, weight: 0.20}',
    '  domain_expert_fitness: {score: 8, weight: 0.15}',
    '  legibility: {score: 9, weight: 0.10}',
    extra,
  ].join('\n');
}

// Verbatim smallholder-seasonal/20261015-1402 verdict (Drive 1fsS5l-QesVWX0enO-t7bBtaLwrSaxWSX,
// revision 7). Its regrade_history records two FAIL grades (registry v2 5.1, v3 6.6)
// before this warn — and the run's manifests zip was written 03:56, the eval at 04:36:
// the data was generated against a registry its eval was failing.
const REAL = readFileSync(
  resolve(__dirname, '../fixtures/registry-eval-gate/smallholder-seasonal-20261015-1402_semantic-registry-author-eval_verdict.yaml'),
  'utf8',
);

describe('checkRegistryEvalGate — real verdict', () => {
  it('opens on the real warn verdict', () => {
    const o = checkRegistryEvalGate(REAL);
    assertChecked(o);
    expect(o.ok).toBe(true);
    expect(o.verdict).toBe('warn');
    expect(o.overall_score).toBe(7.5);
  });

  it('blocks the same verdict at its recorded earlier fail grade', () => {
    // The v3 regrade from regrade_history: generation should have waited here.
    const atV3 = REAL.replace(/^overall_score: 7\.5$/m, 'overall_score: 6.6').replace(/^verdict: warn$/m, 'verdict: fail');
    expect(atV3).not.toBe(REAL);
    const o = checkRegistryEvalGate(atV3);
    assertChecked(o);
    expect(o.ok).toBe(false);
    expect(o.findings[0].code).toBe('failing');
  });
});

describe('checkRegistryEvalGate', () => {
  it('blocks when the verdict file is missing', () => {
    for (const input of [null, undefined, '', '   \n']) {
      const o = checkRegistryEvalGate(input);
      assertChecked(o);
      expect(o.ok).toBe(false);
      expect(o.findings[0].code).toBe('missing');
      expect(o.findings[0].message).toMatch(/run semantic-registry-author-eval first/);
    }
  });

  it('opens on pass and on warn, and reports the score', () => {
    for (const d of ['pass', 'warn']) {
      const o = checkRegistryEvalGate(verdict(d));
      assertChecked(o);
      expect(o.ok).toBe(true);
      expect(o.verdict).toBe(d);
      expect(o.notes).toEqual([]);
      expect(describeRegistryEvalGate(o)).toMatch(/OPEN/);
    }
  });

  it('blocks on fail', () => {
    const o = checkRegistryEvalGate(verdict('fail'));
    assertChecked(o);
    expect(o.ok).toBe(false);
    expect(o.findings[0].code).toBe('failing');
    expect(describeRegistryEvalGate(o)).toMatch(/BLOCKED/);
  });

  it('blocks an ungraded verdict (incomplete / partial / absent) — a deferred eval is not a gate', () => {
    for (const d of ['incomplete', 'partial']) {
      const o = checkRegistryEvalGate(verdict(d));
      assertChecked(o);
      expect(o.ok).toBe(false);
      expect(o.findings[0].code).toBe('not-graded');
    }
    const noVerdict = checkRegistryEvalGate('skill: semantic-registry-author-eval\noverall_score: 8\n');
    assertChecked(noVerdict);
    expect(noVerdict.findings[0].code).toBe('not-graded');
  });

  it("blocks another skill's verdict passed by mistake", () => {
    const o = checkRegistryEvalGate(verdict('pass').replace('semantic-registry-author-eval', 'semantic-registry-author-qa'));
    assertChecked(o);
    expect(o.findings[0].code).toBe('wrong-skill');
  });

  it('blocks unparseable YAML and a non-mapping', () => {
    for (const bad of ['skill: [unclosed', '- just\n- a list\n', '42']) {
      const o = checkRegistryEvalGate(bad);
      assertChecked(o);
      expect(o.ok).toBe(false);
      expect(['unparseable', 'wrong-skill']).toContain(o.findings[0].code);
    }
  });

  it('notes, but does not block on, schema untidiness in a passing verdict', () => {
    const untidy = verdict('pass').replace('weight: 0.10', 'weight: 0.40');
    const o = checkRegistryEvalGate(untidy);
    assertChecked(o);
    expect(o.ok).toBe(true);
    expect(o.notes.join(' ')).toMatch(/weights sum/);
  });
});
