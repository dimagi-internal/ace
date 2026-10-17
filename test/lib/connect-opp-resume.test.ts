// connect-opp-setup Step 4.0 — adopt-and-finish a half-built opportunity
// instead of minting a second one (ace#2083 fix (1)).
//
// The shape being prevented: Phase 4 dies between Step 4's create and Step 6's
// payment units, leaving a `setup_incomplete` opportunity; the re-dispatch
// records nothing, creates another, and the first is stranded until Connect's
// six-month purge. Measured: 11 of 71 rows on `ai-demo-space` (2026-09-06),
// e.g. `20260820-0832 · Bednet Check…`.
import { describe, expect, it } from 'vitest';
import { planOpportunityCreate } from '../../lib/connect-opp-resume';

const RUN = '20260820-0832';
const NAME = `${RUN} · Bednet Check`;
const complete = { complete: true, total_count: 71 };

describe('planOpportunityCreate', () => {
  it('creates when a complete listing holds nothing for this run', () => {
    const p = planOpportunityCreate({ runId: RUN, expectedName: NAME, recorded: null, listing: complete, rows: [] });
    expect(p.action).toBe('create');
  });

  it('ADOPTS an unrecorded setup_incomplete opportunity — the killed-before-write case', () => {
    const p = planOpportunityCreate({
      runId: RUN,
      expectedName: NAME,
      recorded: null,
      listing: complete,
      rows: [{ id: 'opp-1', name: NAME, dashboard_read: 'setup_incomplete', active: false }],
    });
    expect(p).toMatchObject({ action: 'adopt', opportunity_id: 'opp-1', source: 'listing', setup_incomplete: true });
  });

  it('adopts the RECORDED id and names any extra exact-name rows as orphans', () => {
    const p = planOpportunityCreate({
      runId: RUN,
      expectedName: NAME,
      recorded: { id: 'opp-2', name: NAME },
      listing: complete,
      rows: [
        { id: 'opp-1', name: NAME, dashboard_read: 'setup_incomplete' },
        { id: 'opp-2', name: NAME, dashboard_read: 'ok' },
      ],
    });
    expect(p).toMatchObject({ action: 'adopt', opportunity_id: 'opp-2', source: 'recorded', setup_incomplete: false });
    expect(p.reason).toContain('opp-1');
  });

  it('a recorded id found in the rows is adopted even when the listing is incomplete', () => {
    const p = planOpportunityCreate({
      runId: RUN,
      expectedName: NAME,
      recorded: { id: 'opp-2' },
      listing: { complete: false, total_count: 40 },
      rows: [{ id: 'opp-2', name: NAME }],
    });
    expect(p).toMatchObject({ action: 'adopt', opportunity_id: 'opp-2', setup_incomplete: null });
  });

  it('HALTS on an incomplete or failed listing instead of creating blind', () => {
    for (const [listing, rows] of [
      [{ complete: false, total_count: 40 }, []],
      [null, null],
      [complete, null],
    ] as const) {
      const p = planOpportunityCreate({ runId: RUN, expectedName: NAME, recorded: null, listing, rows: rows as never });
      expect(p).toMatchObject({ action: 'halt', code: 'LISTING_INCOMPLETE' });
    }
  });

  it('HALTS when run_state names an opportunity the complete listing does not contain', () => {
    const p = planOpportunityCreate({ runId: RUN, expectedName: NAME, recorded: { id: 'opp-9' }, listing: complete, rows: [] });
    expect(p).toMatchObject({ action: 'halt', code: 'RECORDED_OPP_NOT_FOUND', opportunity_ids: ['opp-9'] });
  });

  it('HALTS naming every id when more than one row already carries the exact name', () => {
    const p = planOpportunityCreate({
      runId: RUN,
      expectedName: NAME,
      recorded: null,
      listing: complete,
      rows: [
        { id: 'opp-1', name: NAME },
        { id: 'opp-3', name: NAME },
      ],
    });
    expect(p).toMatchObject({ action: 'halt', code: 'ORPHAN_OPPORTUNITIES', opportunity_ids: ['opp-1', 'opp-3'] });
  });

  it('HALTS on a run-id row under a different name rather than guessing', () => {
    const p = planOpportunityCreate({
      runId: RUN,
      expectedName: NAME,
      recorded: null,
      listing: complete,
      rows: [{ id: 'opp-4', name: `${RUN} · Bednet Check v2` }],
    });
    expect(p).toMatchObject({ action: 'halt', code: 'RUN_ID_COLLISION', opportunity_ids: ['opp-4'] });
  });
});
