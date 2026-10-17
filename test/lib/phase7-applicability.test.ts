import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PHASE7_SCALE_SKIP_REASON,
  pddFlwCount,
  pddNoPartnerStatement,
  phase7Applicability,
} from '../../lib/phase7-applicability.js';
import { classifyPhaseWriteBack, validateRunState } from '../../lib/run-state-validator.js';
import { phase7DddStep } from '../../lib/ddd-handoff.js';

const FIX = join(__dirname, '..', 'fixtures');
// The real PDD of the run that failed Phase 7 by construction (ace#2806):
// one worker (the requester), no partner organisation.
const ONE_WORKER = readFileSync(join(FIX, 'phase7-applicability', 'group-payment-test-20261007-1700-pdd.md'), 'utf8');
// Control: an ordinary design — 2 FLWs and an LLO not yet chosen ("None pre-named").
const CONTROL = readFileSync(join(FIX, 'ACE-PDD-Pass-001', 'pdd.md'), 'utf8');

describe('phase7Applicability (ace#2806)', () => {
  it('skips the one-worker / no-partner design, citing both PDD lines', () => {
    const r = phase7Applicability(ONE_WORKER);
    expect(r.applicable).toBe(false);
    if (r.applicable) return;
    expect(r.skip_reason).toBe(PHASE7_SCALE_SKIP_REASON);
    expect(r.flw_count).toBe(1);
    expect(r.reasons.map((x) => x.kind)).toEqual(['single-worker', 'no-partner']);
    expect(r.reasons[0].evidence).toMatch(/Number of FLWs: \*\*1\*\*/);
    expect(r.reasons[1].evidence).toMatch(/no partner organisation/);
    expect(r.detail).toMatch(/single worker/);
    // Must never read as a fork skip to qa-deep run selection.
    expect(`${r.skip_reason} ${r.detail}`).not.toMatch(/\bfork(ed|ing)?\b/i);
  });

  it('keeps Phase 7 for a multi-worker design whose LLO is merely not yet named', () => {
    const r = phase7Applicability(CONTROL);
    expect(r).toEqual({ applicable: true, flw_count: 2 });
    expect(pddNoPartnerStatement(CONTROL)).toBeNull();
  });

  it('skips on either condition alone', () => {
    const single = '## FLW Requirements\n- Number of FLWs: 1\n\n## LLO Preference\n- Preferred LLOs: Acme Health\n';
    expect(phase7Applicability(single).applicable).toBe(false);
    const noPartner = '## FLW Requirements\n- Number of FLWs: 12\n\n## LLO Preference\n- None: no partner organisation; ACE runs it.\n';
    const r = phase7Applicability(noPartner);
    expect(r.applicable).toBe(false);
    if (!r.applicable) expect(r.reasons.map((x) => x.kind)).toEqual(['no-partner']);
  });

  it('a range and an unfilled template keep Phase 7 (skipping is the claim that needs evidence)', () => {
    expect(pddFlwCount('## FLW Requirements\n- Number of FLWs: 1–3\n')?.count).toBe(3);
    expect(pddFlwCount('## FLW Requirements\n- Number of FLWs: 10\n')?.count).toBe(10);
    expect(pddFlwCount('## FLW Requirements\n- Number of FLWs: [number]\n')).toBeNull();
    expect(phase7Applicability('## FLW Requirements\n- Number of FLWs: [number]\n').applicable).toBe(true);
  });
});

describe('the Phase 7 scale-skip write-back (ace#2806)', () => {
  it('is a valid, terminal `skipped` block that no DDD dispatch follows', () => {
    const r = phase7Applicability(ONE_WORKER);
    if (r.applicable) throw new Error('fixture must skip');
    const block = {
      status: 'skipped',
      verdict: 'skipped',
      completed_at: '2026-10-16T00:00:00Z',
      summary_artifact: 'doc-id',
      skip_reason: r.skip_reason,
      skip_detail: r.detail,
      skip_evidence: r.reasons,
    };
    const state = { phases: { 'synthetic-data-and-workflows': block } };
    expect(validateRunState(state).errors).toEqual([]);
    expect(classifyPhaseWriteBack(state, 'synthetic-data-and-workflows')).toBe('skipped');
    expect(phase7DddStep(block)).toEqual({ step: 'done' });
  });

  it('the phase doc runs the helper and forbids a reduced-floor mode', () => {
    const doc = readFileSync(join(__dirname, '..', '..', 'agents', 'synthetic-data-and-workflows.md'), 'utf8');
    expect(doc).toContain('scripts/phase7-applicability.ts');
    expect(doc).toContain('skip_reason: design-below-cascade-scale');
    expect(doc).toMatch(/no reduced-floor mode/i);
  });
});
