/**
 * ace#1421 — decisions.yaml is append-only and idempotent-by-id, so a
 * correction cannot edit the original in place. Without supersession the log
 * holds the wrong value AND the right one, both `status: ai-default`, with
 * nothing machine-readable saying which wins.
 *
 * That is a correctness problem, not tidiness. `pdd-to-work-order § Process`
 * step 3(a) instructs the next skill to look up a canonical id and "use that
 * value as-is" — which on bednet-check-2-visit/20260814-2019 resolves
 * `payment-rate` to a superseded per-visit band and puts it into the Phase 4
 * payment unit and a contractual document.
 */
import { describe, it, expect } from 'vitest';
import { composeAppendedLog, DecisionsWriteError } from '../../lib/decisions-write';
import {
  parseDecisionsYaml,
  liveDecisions,
  resolveDecision,
  effectiveValue,
} from '../../lib/decisions-schema';

const base = (over: Record<string, unknown> = {}) => ({
  phase: '1-design',
  skill: 'idea-to-pdd',
  question: 'What is the payment rate?',
  options: ['USD 1.50 to 2.50 per verified follow-up visit', 'USD 9.00 to 15.00 per verified follow-up day'],
  source: 'inputs/idea.md § Connect Deliver app',
  status: 'ai-default' as const,
  evidence_basis: 'stated' as const,
  resolved_by: "ace" as const,
  ...over,
});

const compose = (rows: unknown[], existingYamlText = '') =>
  composeAppendedLog({
    existingYamlText,
    opportunity: 'bednet-check-2-visit',
    run_id: '20260814-2019',
    rows: rows as never[],
    now: () => '2026-08-15T00:00:00.000Z',
  });

describe('the live scenario', () => {
  // Phase 1 wrote a per-visit rate; later in the SAME phase, drafting the Work
  // Order surfaced that the pinned entity_id grain makes the payable unit a
  // worker-day (#1420), so the real band is 6x higher and per day.
  const first = compose([
    base({ id: 'payment-rate', 'ai-default': 'USD 1.50 to 2.50 per verified follow-up visit' }),
  ]);
  const second = compose(
    [
      base({
        id: 'payment-rate-per-payable-day',
        'ai-default': 'USD 9.00 to 15.00 per verified follow-up day',
        supersedes: 'payment-rate',
      }),
    ],
    first.content,
  );
  const log = parseDecisionsYaml(second.content);

  it('keeps both rows — the audit trail is the point of an append-only log', () => {
    expect(log.decisions.map((d) => d.id)).toEqual([
      'payment-rate',
      'payment-rate-per-payable-day',
    ]);
  });

  it('stamps superseded_by on the predecessor', () => {
    const old = log.decisions.find((d) => d.id === 'payment-rate')!;
    expect(old.superseded_by).toBe('payment-rate-per-payable-day');
  });

  it('resolves the canonical id to the CORRECTED value', () => {
    // This is the assertion that matters: the consumer looks up `payment-rate`.
    const live = resolveDecision(log, 'payment-rate')!;
    expect(effectiveValue(live)).toBe('USD 9.00 to 15.00 per verified follow-up day');
  });

  it('liveDecisions excludes the superseded row', () => {
    expect(liveDecisions(log).map((d) => d.id)).toEqual(['payment-rate-per-payable-day']);
  });

  it('a bare id lookup still returns the stale row — which is why the helper exists', () => {
    const naive = log.decisions.find((d) => d.id === 'payment-rate')!;
    expect(effectiveValue(naive)).toContain('per verified follow-up visit');
  });
});

describe('the write boundary rejects broken references', () => {
  it('a dangling supersedes, rather than silently ignoring it', () => {
    expect(() =>
      compose([base({ id: 'corrected-rate', 'ai-default': 'USD 9.00 to 15.00 per verified follow-up day', supersedes: 'no-such-row' })]),
    ).toThrow(DecisionsWriteError);
    expect(() =>
      compose([base({ id: 'corrected-rate', 'ai-default': 'USD 9.00 to 15.00 per verified follow-up day', supersedes: 'no-such-row' })]),
    ).toThrow(/not in the log or this batch/);
  });

  it('a row superseding itself', () => {
    expect(() =>
      compose([base({ id: 'payment-rate', 'ai-default': 'USD 1.50 to 2.50 per verified follow-up visit', supersedes: 'payment-rate' })]),
    ).toThrow(/cannot supersede itself/);
  });

  it('two rows superseding the same predecessor — the chain must stay single-valued', () => {
    const first = compose([base({ id: 'payment-rate', 'ai-default': 'USD 1.50 to 2.50 per verified follow-up visit' })]);
    const second = compose(
      [base({ id: 'rate-fix-a', 'ai-default': 'USD 9.00 to 15.00 per verified follow-up day', supersedes: 'payment-rate' })],
      first.content,
    );
    expect(() =>
      compose(
        [base({ id: 'rate-fix-b', 'ai-default': 'USD 9.00 to 15.00 per verified follow-up day', supersedes: 'payment-rate' })],
        second.content,
      ),
    ).toThrow(/already superseded by rate-fix-a/);
  });
});

describe('interaction with the existing write semantics', () => {
  it('supersedes a row appended earlier in the SAME batch', () => {
    const r = compose([
      base({ id: 'payment-rate', 'ai-default': 'USD 1.50 to 2.50 per verified follow-up visit' }),
      base({ id: 'payment-rate-corrected', 'ai-default': 'USD 9.00 to 15.00 per verified follow-up day', supersedes: 'payment-rate' }),
    ]);
    const log = parseDecisionsYaml(r.content);
    expect(resolveDecision(log, 'payment-rate')!.id).toBe('payment-rate-corrected');
  });

  it('stays idempotent — re-appending the same correction is a no-op, not a double-stamp', () => {
    const first = compose([base({ id: 'payment-rate', 'ai-default': 'USD 1.50 to 2.50 per verified follow-up visit' })]);
    const rows = [base({ id: 'rate-fix', 'ai-default': 'USD 9.00 to 15.00 per verified follow-up day', supersedes: 'payment-rate' })];
    const second = compose(rows, first.content);
    const third = compose(rows, second.content);

    expect(third.skipped).toContain('rate-fix');
    const log = parseDecisionsYaml(third.content);
    expect(log.decisions.find((d) => d.id === 'payment-rate')!.superseded_by).toBe('rate-fix');
    expect(log.decisions).toHaveLength(2);
  });

  it('follows a multi-step chain A → B → C', () => {
    let y = compose([base({ id: 'a', 'ai-default': 'USD 1.50 to 2.50 per verified follow-up visit' })]).content;
    y = compose([base({ id: 'b', 'ai-default': 'USD 9.00 to 15.00 per verified follow-up day', supersedes: 'a' })], y).content;
    y = compose([base({ id: 'c', 'ai-default': 'USD 1.50 to 2.50 per verified follow-up visit', supersedes: 'b' })], y).content;
    const log = parseDecisionsYaml(y);
    expect(resolveDecision(log, 'a')!.id).toBe('c');
    expect(liveDecisions(log).map((d) => d.id)).toEqual(['c']);
  });

  it('leaves ordinary rows untouched', () => {
    const log = parseDecisionsYaml(
      compose([base({ id: 'working-language', 'ai-default': 'USD 1.50 to 2.50 per verified follow-up visit' })]).content,
    );
    const row = log.decisions[0];
    expect(row.superseded_by).toBeUndefined();
    expect(row.supersedes).toBeUndefined();
    expect(resolveDecision(log, 'working-language')!.id).toBe('working-language');
  });

  it('resolveDecision returns undefined for an unknown id', () => {
    const log = parseDecisionsYaml(compose([base({ id: 'x', 'ai-default': 'USD 1.50 to 2.50 per verified follow-up visit' })]).content);
    expect(resolveDecision(log, 'nope')).toBeUndefined();
  });
});
