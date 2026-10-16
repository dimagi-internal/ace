/**
 * dimagi-internal/ace#1924 — `probe-upstream-asks` could not see Drive-resident
 * opp inputs, so the `/ace:iterate` fixture brief kept pinning a retired Nova
 * limitation (voidcraft-labs/commcare-nova#458, closed COMPLETED 2026-08-15)
 * as binding, observed on bednet-check-2-visit/20260902-1555 and
 * 20260908-1544. The Drive pass reads fixture opps' `inputs/` through an
 * injected reader; these tests feed it a fixture brief.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  collectDriveInputRefs,
  driveInputLabel,
  isScannableInput,
  type DriveInputsReader,
} from '../../lib/upstream-asks-drive.js';
import { findStaleAsks, type IssueStatus } from '../../lib/upstream-asks.js';

const BRIEF = readFileSync(join(__dirname, '../fixtures/upstream-asks/fixture-brief-idea.md'), 'utf8');

const NOVA_458_CLOSED: IssueStatus = {
  slug: 'voidcraft-labs/commcare-nova#458',
  state: 'CLOSED',
  closedAt: '2026-08-15T00:00:00Z',
  reason: 'completed',
};

function reader(opps: Record<string, { fixture: boolean; inputs: Record<string, string> | Error }>): DriveInputsReader {
  return {
    listOpps: async () => Object.entries(opps).map(([opp, o]) => ({ opp, fixture: o.fixture })),
    readInputs: async (opp) => {
      const i = opps[opp].inputs;
      if (i instanceof Error) throw i;
      return Object.entries(i).map(([name, text]) => ({ name, text }));
    },
  };
}

describe('Drive pass over fixture opps inputs/ (#1924)', () => {
  it('reports a fixture brief that cites a CLOSED upstream issue as a live constraint', async () => {
    const scan = await collectDriveInputRefs(
      reader({ 'bednet-check-2-visit': { fixture: true, inputs: { 'idea.md': BRIEF } } }),
    );
    expect(scan.errors).toEqual([]);
    expect(scan.scanned).toEqual(['bednet-check-2-visit']);
    const stale = findStaleAsks(scan.refs, [NOVA_458_CLOSED]);
    expect(stale).toHaveLength(1);
    expect(stale[0].slug).toBe('voidcraft-labs/commcare-nova#458');
    expect(stale[0].citations[0].file).toBe('drive:ACE/bednet-check-2-visit/inputs/idea.md');
    expect(stale[0].citations[0].text).toMatch(/cannot read its own case/);
  });

  it('NEGATIVE CONTROL: the same brief with the pin acknowledged as retired is not reported', async () => {
    const acked = BRIEF.replace(
      '- Two visits per household',
      '  RETIRED 2026-08-29 — the upstream fix shipped; key on the case id.\n- Two visits per household',
    );
    const scan = await collectDriveInputRefs(
      reader({ 'bednet-check-2-visit': { fixture: true, inputs: { 'idea.md': acked } } }),
    );
    expect(findStaleAsks(scan.refs, [NOVA_458_CLOSED])).toEqual([]);
  });

  it('scans fixture opps only by default; allOpps widens it', async () => {
    const r = reader({
      'bednet-check-2-visit': { fixture: true, inputs: { 'idea.md': BRIEF } },
      'one-off-opp': { fixture: false, inputs: { 'idea.md': BRIEF } },
    });
    expect((await collectDriveInputRefs(r)).scanned).toEqual(['bednet-check-2-visit']);
    expect((await collectDriveInputRefs(r, { allOpps: true })).scanned).toEqual([
      'bednet-check-2-visit',
      'one-off-opp',
    ]);
  });

  it('records a reader failure instead of reading it as "nothing stale"', async () => {
    const scan = await collectDriveInputRefs(
      reader({
        broken: { fixture: true, inputs: new Error('403 Forbidden') },
        'bednet-check-2-visit': { fixture: true, inputs: { 'idea.md': BRIEF } },
      }),
    );
    expect(scan.errors).toEqual(['broken: reading inputs/ failed: 403 Forbidden']);
    expect(scan.scanned).toEqual(['bednet-check-2-visit']);
    expect(scan.refs.length).toBeGreaterThan(0);
  });

  it('skips non-text inputs and labels Drive citations distinctly from repo paths', () => {
    expect(isScannableInput('idea.md')).toBe(true);
    expect(isScannableInput('Program brief')).toBe(true); // a Google Doc: no extension
    expect(isScannableInput('decision-overrides.yaml')).toBe(true);
    expect(isScannableInput('site-photo.jpg')).toBe(false);
    expect(isScannableInput('proposal.pdf')).toBe(false);
    expect(driveInputLabel('x', 'idea.md')).toBe('drive:ACE/x/inputs/idea.md');
  });
});
