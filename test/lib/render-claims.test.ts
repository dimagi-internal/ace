/**
 * Tests for `lib/render-claims.ts` — "what changed because you asked".
 *
 * The claim set is the DENOMINATOR: every claim renders whichever way it
 * went, so an unmet one appears as an accusation rather than as an absence.
 * The regression control at the bottom is the one that matters — a run must
 * never read as fully delivered when a checkpoint never ran.
 */

import { describe, it, expect } from 'vitest';
import { renderClaimsSection } from '../../lib/render-claims.js';
import type { ClaimSet } from '../../lib/run-claims.js';

const SET: ClaimSet = {
  schema_version: 1,
  kind: 'run-claims',
  opp: 'poverty-graduation',
  frozen_at: 't0',
  source_run_id: '20260908-0510',
  claims: [
    {
      id: 'a',
      claim: 'The Deliver app marks the distribution visit unpaid.',
      artifact: 'deliver-app',
      checkable_at: 'commcare-setup',
      origin: { kind: 'counterpart-decision', person: 'Sophie Feintuch' },
      authored_by: 'ace',
      check: { kind: 'probe', how: 'parse the CCZ' },
      verdict: 'MET',
      evidence_kind: 'probed',
      evidence: 'CCZ b3f1c2 via commcare_download_ccz(app_id=e4594937), 0 matches',
      says: 'The distribution visit is no longer marked as payable work.',
    },
    {
      id: 'b',
      claim: 'Targeting v1.1 compiles as Component 2.',
      artifact: 'composed-pdd',
      checkable_at: 'idea-to-design',
      origin: {
        kind: 'counterpart-decision',
        person: 'Sophie Feintuch',
        quote: 'whether Targeting v1.1 compiles as Component 2',
      },
      authored_by: 'counterpart',
      check: { kind: 'judged', how: 'read the composed PDD' },
      verdict: 'UNMET',
      evidence_kind: 'judged',
      evidence: 'composed PDD 1u-QzTn1G82n rev 8 has no Component 2 section',
      says: 'Your Targeting doc did not come through as Component 2 — the build used the July copy.',
    },
    {
      id: 'c',
      claim: 'The support assistant says consumption support is unpaid.',
      artifact: 'ocs-chatbot',
      checkable_at: 'ocs-setup',
      origin: { kind: 'counterpart-decision', person: 'Sophie Feintuch' },
      authored_by: 'ace',
      check: { kind: 'probe', how: 'ask the bot' },
      verdict: 'NOT REACHED',
      evidence_kind: 'probed',
      // No `says` on purpose — a claim answered before the field existed.
      evidence: 'the `ocs-setup` checkpoint never ran in this run',
    },
  ],
};

describe('renderClaimsSection', () => {
  it('renders every claim, whichever way it went', () => {
    const md = renderClaimsSection(SET);
    expect(md).toContain('The Deliver app marks the distribution visit unpaid.');
    expect(md).toContain('Targeting v1.1 compiles as Component 2.');
    expect(md).toContain('The support assistant says consumption support is unpaid.');
  });

  it('marks a claim the counterpart set as theirs', () => {
    expect(renderClaimsSection(SET)).toMatch(/you asked for this/i);
  });

  it('qualifies a judged verdict so it reads as weaker than a probed one', () => {
    expect(renderClaimsSection(SET)).toMatch(/judged/i);
  });

  it('REGRESSION CONTROL: does not present the run as fully delivered when one claim never ran', () => {
    const md = renderClaimsSection(SET);
    expect(md).not.toMatch(/all .* met|everything you asked/i);
    expect(md).toMatch(/never reached/i);
  });

  it('leads with the tally so a reader knows the shape before the detail', () => {
    expect(renderClaimsSection(SET).split('\n')[0]).toMatch(/1\/3 met/);
  });

  it('surfaces would_settle_it on an indeterminate claim', () => {
    const one: ClaimSet = {
      ...SET,
      claims: [
        {
          ...SET.claims[0],
          verdict: 'INDETERMINATE',
          would_settle_it: 'which form the opportunity binds as payable',
          evidence: 'two distribution forms in the CCZ',
        },
      ],
    };
    expect(renderClaimsSection(one)).toContain('which form the opportunity binds as payable');
  });
});

describe('renderClaimsSection audience', () => {
  it('renders the counterpart-facing `says`, not the audit record', () => {
    const md = renderClaimsSection(SET);
    expect(md).toContain('The distribution visit is no longer marked as payable work.');
    expect(md).not.toContain('commcare_download_ccz');
  });

  it('defaults to the counterpart audience, so a caller cannot leak by forgetting', () => {
    expect(renderClaimsSection(SET)).toEqual(
      renderClaimsSection(SET, { audience: 'counterpart' }),
    );
  });

  it('NEVER falls back to `evidence` on the counterpart surface', () => {
    // Claim `c` has no `says`. It must render as the verdict alone —
    // silence about the detail, not the audit record in its place.
    const md = renderClaimsSection(SET);
    expect(md).toContain('The support assistant says consumption support is unpaid.');
    expect(md).not.toContain('the `ocs-setup` checkpoint never ran in this run');
  });

  it('keeps `evidence` exactly as strong on an internal surface', () => {
    const md = renderClaimsSection(SET, { audience: 'internal' });
    expect(md).toContain('commcare_download_ccz');
    expect(md).toContain('1u-QzTn1G82n rev 8');
    // `says` is not replaced by it — the internal reader gets both.
    expect(md).toContain('The distribution visit is no longer marked as payable work.');
  });

  it('falls back to `evidence` for a says-less claim ONLY on the internal surface', () => {
    const md = renderClaimsSection(SET, { audience: 'internal' });
    expect(md).toContain('the `ocs-setup` checkpoint never ran in this run');
  });

  it('keeps the completeness property on both surfaces — every claim renders either way', () => {
    for (const audience of ['counterpart', 'internal'] as const) {
      const md = renderClaimsSection(SET, { audience });
      for (const c of SET.claims) expect(md).toContain(c.claim);
      expect(md).toMatch(/not met/i);
      expect(md).toMatch(/never reached/i);
    }
  });
});
