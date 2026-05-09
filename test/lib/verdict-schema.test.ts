import { describe, it, expect } from 'vitest';
import { validateVerdict, VerdictSchema } from '../../lib/verdict-schema.js';

const validVerdict = {
  skill: 'ocs-chatbot-eval',
  target: 'experiment_id=12003',
  mode: 'deep',
  ran_at: '2026-04-28T18:00:00Z',
  capture_path: 'qa-captures/2026-04-28-ocs-chat-deep.md',
  overall_score: 9.1,
  verdict: 'pass',
  dimensions: {
    correctness:  { score: 9.8, weight: 0.4 },
    source_usage: { score: 8.0, weight: 0.3 },
    tone:         { score: 9.2, weight: 0.2 },
    tagging:      { score: 9.5, weight: 0.1 },
  },
  per_item: [
    { ref: 'prompt-1', score: 9.5, verdict: 'pass', note: 'cited correct file' },
  ],
  auto_surfaced: [
    { severity: 'INFO', message: 'one prompt elaborated detail not in PDD; verify' },
  ],
  gate: { threshold: 7.0, disposition: 'approve' },
};

describe('verdict schema', () => {
  it('accepts a fully-populated valid verdict', () => {
    const r = validateVerdict(validVerdict);
    expect(r.errors, JSON.stringify(r.errors)).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('accepts a minimal verdict (no per_item, auto_surfaced, gate, mode)', () => {
    const minimal = { ...validVerdict };
    delete (minimal as any).mode;
    delete (minimal as any).per_item;
    delete (minimal as any).auto_surfaced;
    delete (minimal as any).gate;
    const r = validateVerdict(minimal);
    expect(r.ok, JSON.stringify(r.errors)).toBe(true);
  });

  it('rejects verdicts missing required top-level fields', () => {
    const broken = { ...validVerdict };
    delete (broken as any).overall_score;
    const r = validateVerdict(broken);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('overall_score'))).toBe(true);
  });

  it('rejects out-of-range scores', () => {
    const broken = {
      ...validVerdict,
      dimensions: { correctness: { score: 11, weight: 1.0 } },
    };
    const r = validateVerdict(broken);
    expect(r.ok).toBe(false);
  });

  it('rejects unknown verdict dispositions', () => {
    const r = validateVerdict({ ...validVerdict, verdict: 'maybe' });
    expect(r.ok).toBe(false);
  });

  it('warns when dimension weights do not sum to 1.0', () => {
    const broken = {
      ...validVerdict,
      dimensions: {
        a: { score: 5, weight: 0.4 },
        b: { score: 5, weight: 0.4 }, // sums to 0.8
      },
    };
    const r = validateVerdict(broken);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('weights sum'))).toBe(true);
  });

  it('allows extra domain-specific fields in per_item entries', () => {
    const withExtras = {
      ...validVerdict,
      per_item: [
        { ref: 'p1', score: 9, verdict: 'pass', prompt: 'What is X?', cited_files: ['a.md'] },
      ],
    };
    const r = validateVerdict(withExtras);
    expect(r.ok, JSON.stringify(r.errors)).toBe(true);
  });

  // audit: tests that the named export exists and parses one valid input;
  // import statement already validates the export, and 'accepts a fully-populated
  // valid verdict' covers the parse case. weak-assertion / redundant-with-sibling.
  it.skip('exports VerdictSchema as a Zod schema', () => {
    expect(VerdictSchema.safeParse(validVerdict).success).toBe(true);
  });

  it('accepts v2 verdict tiers (incomplete, partial)', () => {
    for (const v of ['incomplete', 'partial']) {
      const r = validateVerdict({ ...validVerdict, verdict: v });
      expect(r.ok, `${v}: ${JSON.stringify(r.errors)}`).toBe(true);
    }
  });

  it('accepts v2 severity tiers (PLATFORM, DRIFT, INFO-SKIPPED)', () => {
    for (const sev of ['PLATFORM', 'DRIFT', 'INFO-SKIPPED']) {
      const r = validateVerdict({
        ...validVerdict,
        auto_surfaced: [{ severity: sev, message: 'sample' }],
      });
      expect(r.ok, `${sev}: ${JSON.stringify(r.errors)}`).toBe(true);
    }
  });

  it('rejects unknown severity tiers', () => {
    const r = validateVerdict({
      ...validVerdict,
      auto_surfaced: [{ severity: 'CRITICAL', message: 'sample' }],
    });
    expect(r.ok).toBe(false);
  });

  it('per_item.verdict is restricted to pass/warn/fail (no partial/incomplete)', () => {
    for (const v of ['incomplete', 'partial']) {
      const r = validateVerdict({
        ...validVerdict,
        per_item: [{ ref: 'p1', score: 5, verdict: v }],
      });
      expect(r.ok, `per_item should reject ${v}`).toBe(false);
    }
  });

  it('accepts optional live_state_verified boolean', () => {
    for (const lsv of [true, false]) {
      const r = validateVerdict({ ...validVerdict, live_state_verified: lsv });
      expect(r.ok, `live_state_verified=${lsv}: ${JSON.stringify(r.errors)}`).toBe(true);
    }
  });

  it('accepts optional overall_score_pre_cap', () => {
    const r = validateVerdict({ ...validVerdict, overall_score_pre_cap: 9.4, overall_score: 8.5 });
    expect(r.ok, JSON.stringify(r.errors)).toBe(true);
  });

  it('accepts numeric target (experiment_id, nova_app_id, opportunity_id)', () => {
    const r = validateVerdict({ ...validVerdict, target: 12027 });
    expect(r.ok, JSON.stringify(r.errors)).toBe(true);
  });

  it('accepts null dimension scores (opp-eval partial-coverage shape)', () => {
    const r = validateVerdict({
      ...validVerdict,
      dimensions: {
        design:    { score: null, weight: 0.4 },
        commcare:  { score: null, weight: 0.3 },
        ocs:       { score: 8.4,  weight: 0.3 },
      },
    });
    expect(r.ok, JSON.stringify(r.errors)).toBe(true);
  });
});
