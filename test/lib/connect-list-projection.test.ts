/**
 * ace#1799 — `connect_list_opportunities(hydrate)` and `connect_list_programs`
 * overflow the harness tool-result cap in a mature org, and both are MANDATED
 * by `connect-program-setup` (Step 4a and Step 2 respectively).
 *
 * Measured live against `ai-demo-space` on 2026-09-01:
 *   connect_list_programs               42 rows → 57,425 chars (56.1 KB),
 *                                       43,239 of them (75.3%) description prose
 *   connect_list_opportunities(hydrate) 71 rows → 81,175 chars (79.3 KB)
 *
 * These pin the PURE half of the fix — the projection and the Step 4a
 * aggregation — so it is testable without spawning the MCP subprocess (whose
 * code binds at spawn and cannot be live-validated from a running session).
 * The atom-signature half is pinned in
 * test/mcp/connect/list-atom-payload-handles.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  projectProgramDescriptions,
  summarizeOpportunitiesByProgram,
  PROGRAM_LIST_DESCRIPTION_SNIPPET_CHARS,
} from '../../lib/connect-list-projection.js';

describe('projectProgramDescriptions', () => {
  it('caps a long description and marks the row', () => {
    const long = 'x'.repeat(5_000);
    const out = projectProgramDescriptions([{ id: 'a', description: long }]);
    expect(out.programs[0].description).toHaveLength(PROGRAM_LIST_DESCRIPTION_SNIPPET_CHARS);
    expect(out.programs[0].description_truncated).toBe(true);
    expect(out.truncated_rows).toBe(1);
    expect(out.chars_removed).toBe(5_000 - PROGRAM_LIST_DESCRIPTION_SNIPPET_CHARS);
  });

  it('leaves a short description untouched and UNMARKED', () => {
    // A truncation marker on a row that was not truncated would send a reader
    // to `connect_get_program` for prose they already have.
    const out = projectProgramDescriptions([{ id: 'a', description: 'short' }]);
    expect(out.programs[0].description).toBe('short');
    expect(out.programs[0].description_truncated).toBeUndefined();
    expect(out.truncated_rows).toBe(0);
    expect(out.chars_removed).toBe(0);
  });

  it('tolerates null / missing descriptions without inventing a string', () => {
    const out = projectProgramDescriptions([{ id: 'a', description: null }, { id: 'b' }]);
    expect(out.programs[0].description).toBeNull();
    expect(out.programs[1].description).toBeUndefined();
    expect(out.truncated_rows).toBe(0);
  });

  it('preserves every other field on the row', () => {
    const out = projectProgramDescriptions([
      { id: 'a', name: 'P', delivery_type: null, description: 'y'.repeat(1_000) },
    ]);
    expect(out.programs[0]).toMatchObject({ id: 'a', name: 'P', delivery_type: null });
  });

  it('reproduces the measured saving on the live ai-demo-space shape', () => {
    // 42 rows, Σ description = 43,239 chars, so ~1,030 chars/row on average.
    const rows = Array.from({ length: 42 }, (_, i) => ({ id: `p${i}`, description: 'd'.repeat(1_030) }));
    const before = JSON.stringify(rows).length;
    const out = projectProgramDescriptions(rows);
    const after = JSON.stringify(out.programs).length;
    expect(after).toBeLessThan(before * 0.5);
    expect(out.truncated_rows).toBe(42);
  });
});

describe('summarizeOpportunitiesByProgram — connect-program-setup Step 4a', () => {
  const base = { listingComplete: true, programName: 'Bednet' };

  it('sums total_budget over the rows definitively inside the program', () => {
    const s = summarizeOpportunitiesByProgram(
      [
        { id: '1', program_name: 'Bednet', total_budget: 100, dashboard_read: 'ok' },
        { id: '2', program_name: 'Bednet', total_budget: 250, dashboard_read: 'ok' },
      ],
      base,
    );
    expect(s.sigma_total_budget).toBe(350);
    expect(s.matched_rows).toBe(2);
    expect(s.matched_opportunity_ids).toEqual(['1', '2']);
    expect(s.sigma_known).toBe(true);
    expect(s.sigma_unknown_reasons).toEqual([]);
  });

  it('EXCLUDES a dashboard_read:ok row with no program_name without making Σ unknown (ace#1637)', () => {
    // The load-bearing half of ace#1637: on such a row the missing
    // program_name is a FACT (the opp is in no program), not a read failure.
    const s = summarizeOpportunitiesByProgram(
      [
        { id: '1', program_name: 'Bednet', total_budget: 100, dashboard_read: 'ok' },
        { id: '2', total_budget: 900, dashboard_read: 'ok' },
        { id: '3', program_name: 'Other', total_budget: 900, dashboard_read: 'ok' },
      ],
      base,
    );
    expect(s.sigma_total_budget).toBe(100);
    expect(s.excluded_outside_program).toBe(2);
    expect(s.unreadable_rows).toBe(0);
    expect(s.sigma_known).toBe(true);
  });

  it('counts a non-ok dashboard_read as UNREADABLE and makes Σ unknown (ace#1637)', () => {
    const s = summarizeOpportunitiesByProgram(
      [
        { id: '1', program_name: 'Bednet', total_budget: 100, dashboard_read: 'ok' },
        { id: '2', dashboard_read: 'no_cards' },
      ],
      base,
    );
    expect(s.unreadable_rows).toBe(1);
    expect(s.excluded_outside_program).toBe(0);
    expect(s.sigma_known).toBe(false);
    expect(s.sigma_unknown_reasons.join(' ')).toMatch(/unreadable_rows/);
  });

  it('treats a row with no dashboard_read at all as not_fetched, never as ok', () => {
    const s = summarizeOpportunitiesByProgram([{ id: '1', program_name: 'Bednet', total_budget: 5 }], base);
    expect(s.unreadable_rows).toBe(1);
    expect(s.sigma_total_budget).toBe(0);
    expect(s.sigma_known).toBe(false);
    expect(s.dashboard_read_counts).toEqual({ not_fetched: 1 });
  });

  it('makes Σ unknown when the listing walk was incomplete (ace#1590)', () => {
    const s = summarizeOpportunitiesByProgram(
      [{ id: '1', program_name: 'Bednet', total_budget: 100, dashboard_read: 'ok' }],
      { ...base, listingComplete: false, listingTruncatedReason: 'walked 50 pages' },
    );
    expect(s.sigma_known).toBe(false);
    expect(s.sigma_unknown_reasons.join(' ')).toMatch(/listing_incomplete/);
    expect(s.sigma_unknown_reasons.join(' ')).toMatch(/walked 50 pages/);
  });

  it('makes Σ unknown when a matched row carries no total_budget', () => {
    const s = summarizeOpportunitiesByProgram(
      [{ id: '1', program_name: 'Bednet', dashboard_read: 'ok' }],
      base,
    );
    expect(s.matched_rows).toBe(1);
    expect(s.rows_missing_total_budget).toBe(1);
    expect(s.sigma_known).toBe(false);
  });

  it('makes Σ unknown when the org has two programs by this name', () => {
    const s = summarizeOpportunitiesByProgram(
      [{ id: '1', program_name: 'Bednet', total_budget: 100, dashboard_read: 'ok' }],
      { ...base, duplicateProgramName: true },
    );
    expect(s.sigma_known).toBe(false);
    expect(s.sigma_unknown_reasons.join(' ')).toMatch(/duplicate_program_name/);
  });

  it('reports the ace#1637 split as a first-class field', () => {
    // Measured live 2026-09-01 on ai-demo-space: 60 ok, 11 no_cards of 71.
    const rows = [
      ...Array.from({ length: 60 }, (_, i) => ({ id: `ok${i}`, dashboard_read: 'ok' })),
      ...Array.from({ length: 11 }, (_, i) => ({ id: `nc${i}`, dashboard_read: 'no_cards' })),
    ];
    const s = summarizeOpportunitiesByProgram(rows, base);
    expect(s.dashboard_read_counts).toEqual({ ok: 60, no_cards: 11 });
    expect(s.total_rows).toBe(71);
  });

  it('is orders of magnitude smaller than the rows it replaces', () => {
    // The whole point: 71 hydrated rows measured at 81,175 chars inline.
    const rows = Array.from({ length: 71 }, (_, i) => ({
      id: `opp-${i}`,
      program_name: i % 7 === 0 ? 'Bednet' : `Other ${i}`,
      total_budget: 100,
      dashboard_read: 'ok',
    }));
    const s = summarizeOpportunitiesByProgram(rows, base);
    expect(JSON.stringify(s).length).toBeLessThan(2_000);
  });
});
