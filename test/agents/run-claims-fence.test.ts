/**
 * Claims are wired into the phase boundary fence as a REPORT, not a gate.
 *
 * The regression control at the bottom is the whole point of this file: if
 * someone later makes a claims result able to stop a run, CI fails. "Report
 * loud, never halt" is a design decision with a reason —
 * `docs/superpowers/specs/2026-09-15-pre-run-claims-post-run-validation-design.md` § 2:
 * what a counterpart is owed is a diff, and a halt produces no diff.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ORCH = readFileSync(join(process.cwd(), 'agents/ace-orchestrator.md'), 'utf8');

describe('claims are wired into the fence as a REPORT, not a gate', () => {
  it('the fence batch calls verify_run_claims', () => {
    expect(ORCH).toMatch(/verify_run_claims\(/);
  });

  it('the run freezes its claim set at kickoff', () => {
    expect(ORCH).toMatch(/claims\.yaml/);
    expect(ORCH.toLowerCase()).toMatch(/freez/);
  });

  it('closeout sweeps unanswered claims to NOT REACHED', () => {
    expect(ORCH).toMatch(/NOT REACHED/);
  });

  it('the fence tells the reader that UNMET does not halt', () => {
    expect(ORCH).toMatch(/does NOT halt|never halts|NEVER HALTS/i);
  });

  it('the fence tells the phase to write the counterpart-facing sentence, not just evidence', () => {
    // `evidence` is the audit record and never leaves ACE. If the fence
    // stops naming `says`, every verdict renders to the person who asked
    // as a bare pass with nothing behind it — ace#2420, the state this
    // whole reviewer-facing half was built to leave.
    expect(ORCH).toMatch(/`says`/);
    expect(ORCH).toMatch(/missing_says/);
  });

  it('REGRESSION CONTROL: `says` is reported, never gated', () => {
    const start = ORCH.indexOf('Turn N+2:  Branch on classify_phase_writeback');
    const end = ORCH.indexOf('Turn N+3');
    const branch = ORCH.slice(start, end);
    expect(branch).not.toMatch(/missing_says/);
  });

  it('REGRESSION CONTROL: claims never appear in the Turn N+2 branch condition', () => {
    // The branch is what decides whether the run proceeds. A claims result
    // must never be able to stop it.
    const start = ORCH.indexOf('Turn N+2:  Branch on classify_phase_writeback');
    const end = ORCH.indexOf('Turn N+3');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const branch = ORCH.slice(start, end);
    expect(branch.length).toBeGreaterThan(200); // the slice actually found the block
    expect(branch).not.toMatch(/verify_run_claims/);
    expect(branch).not.toMatch(/claims\.ok/);
  });
});
