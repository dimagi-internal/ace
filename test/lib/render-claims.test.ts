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
      evidence: 'CCZ b3f1c2, 0 matches',
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
      evidence: 'composed PDD has no Component 2 section',
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
