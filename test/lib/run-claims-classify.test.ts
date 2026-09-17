/**
 * Tests for `classifyRunClaims` — the whole body of the `verify_run_claims`
 * atom, kept in the pure module so it can be tested for real.
 *
 * The MCP server files `await server.connect(transport)` at module top
 * level, so a test cannot import them (see
 * test/mcp/registration-coverage.test.ts). Putting the logic here rather
 * than inline in the atom is what keeps it covered instead of mirrored by
 * a copy in a test, which would pass whether or not the atom worked.
 */

import { describe, it, expect } from 'vitest';
import YAML from 'yaml';
import { classifyRunClaims } from '../../lib/run-claims.js';

const FIXTURE = `
schema_version: 1
kind: run-claims
opp: poverty-graduation
frozen_at: '2026-09-15T10:30:00Z'
source_run_id: '20260908-0510'
claims:
  - id: cs-deliver-unpaid
    claim: The Deliver app's distribution visit carries no payment marker.
    artifact: deliver-app
    checkable_at: commcare-setup
    origin: {kind: counterpart-decision, person: Sophie Feintuch}
    authored_by: ace
    check: {kind: probe, how: Parse the released Deliver CCZ.}
  - id: cs-connect-no-pu
    claim: The Connect opportunity has no payment unit for consumption support.
    artifact: connect-opportunity
    checkable_at: connect-setup
    origin: {kind: counterpart-decision, person: Sophie Feintuch}
    authored_by: counterpart
    check: {kind: probe, how: List payment units.}
`;

const parsed = () => YAML.parse(FIXTURE);

describe('classifyRunClaims', () => {
  it('reports only the claims due at this phase', () => {
    expect(classifyRunClaims(parsed(), 'commcare-setup').due).toHaveLength(1);
    expect(classifyRunClaims(parsed(), 'connect-setup').due).toHaveLength(1);
    expect(classifyRunClaims(parsed(), 'ocs-setup').due).toHaveLength(0);
  });

  it('carries the claim text and who authored it, so the fence can act without a second read', () => {
    const due = classifyRunClaims(parsed(), 'connect-setup').due[0];
    expect(due.claim).toMatch(/no payment unit/);
    expect(due.authored_by).toBe('counterpart');
    expect(due.person).toBe('Sophie Feintuch');
    expect(due.check.kind).toBe('probe');
  });

  it('reports the RUN-level tally, not just this phase', () => {
    expect(classifyRunClaims(parsed(), 'commcare-setup').summary).toMatch(/0\/2 met/);
    expect(classifyRunClaims(parsed(), 'commcare-setup').all_met).toBe(false);
  });

  it('an unreadable claims file reports ok:false rather than throwing', () => {
    const r = classifyRunClaims({ kind: 'run-claims', claims: 'not a list' }, 'commcare-setup');
    expect(r.ok).toBe(false);
    expect(r.issues.length).toBeGreaterThan(0);
    expect(r.due).toEqual([]);
  });

  it('names an ANSWERED claim with no counterpart-facing sentence in missing_says', () => {
    const set = parsed();
    set.claims[0].verdict = 'MET';
    set.claims[0].evidence_kind = 'probed';
    set.claims[0].evidence = 'commcare_download_ccz(app_id=e4594937) — 0 matches';
    set.claims[1].verdict = 'MET';
    set.claims[1].evidence_kind = 'probed';
    set.claims[1].evidence = 'two payment units, neither for consumption support';
    set.claims[1].says = 'Nobody is paid for consumption support on this opportunity.';
    const r = classifyRunClaims(set, 'commcare-setup');
    // Reported, never fatal — the verdict stands and the run continues.
    expect(r.ok).toBe(true);
    expect(r.missing_says).toEqual(['cs-deliver-unpaid']);
  });

  it('does not name an UNANSWERED claim in missing_says — it has nothing to say yet', () => {
    expect(classifyRunClaims(parsed(), 'commcare-setup').missing_says).toEqual([]);
  });

  it('an ABSENT claims file is ok with nothing due — most opps have none', () => {
    const r = classifyRunClaims(null, 'commcare-setup');
    expect(r.ok).toBe(true);
    expect(r.due).toEqual([]);
    expect(r.summary).toMatch(/no claims/i);
  });
});
