/**
 * Ad-hoc "stop after phase N" is a one-shot run directive, distinct from
 * the `mode` matrix (`default`/`review`/`auto`).
 *
 * The gap: a `canopy agent-review ace` pass flagged a strong_correction —
 * Jonathan told a live run "once the idea-to-design is done, stop and let
 * me know" and the run kept going past Phase 1, because the only pause
 * mechanism was full `review` mode (pauses at EVERY phase checkpoint), not
 * a lighter-weight one-off ask. This file pins the fix: the orchestrator
 * recognizes the instruction mid-run, records it durably in
 * `run_state.yaml`, and the Phase boundary fence honors it exactly once
 * at the next completed write-back — without changing the Turn N+2→N+3
 * path for any run that was never given the instruction.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ORCH = readFileSync(join(process.cwd(), 'agents/ace-orchestrator.md'), 'utf8');
const REF = readFileSync(join(process.cwd(), 'agents/orchestrator-reference.md'), 'utf8');

function branchSlice(md: string): string {
  const start = md.indexOf('Turn N+2:  Branch on classify_phase_writeback');
  const end = md.indexOf('Turn N+3', start);
  expect(start, 'orchestrator lost its Turn N+2 branch').toBeGreaterThan(-1);
  expect(end, 'orchestrator lost its Turn N+3 marker').toBeGreaterThan(start);
  return md.slice(start, end);
}

describe('ad-hoc stop-after-phase instructions (dimagi-internal/ace agent-review, turn e0505ad2)', () => {
  it('the orchestrator declares the recognition procedure', () => {
    expect(ORCH).toMatch(/### Ad-hoc stop-after-phase instructions/);
  });

  it('is distinguished explicitly from a mode change', () => {
    expect(ORCH).toMatch(/is not a mode change/);
    expect(ORCH).toMatch(/distinct from `mode`/);
  });

  it('is recorded durably in run_state.yaml, not just in conversation', () => {
    expect(ORCH).toMatch(/operator_stop_after_phase/);
    expect(ORCH).toMatch(/Record it immediately/);
  });

  it('the schema field is documented in the reference state schema', () => {
    expect(REF).toMatch(/operator_stop_after_phase:/);
    expect(REF).toMatch(/phase: <phase-key>/);
    expect(REF).toMatch(/status: pending\|fired/);
  });

  it('the Pause Points table links to it as an orthogonal mechanism', () => {
    const start = REF.indexOf('## Pause Points');
    expect(start).toBeGreaterThan(-1);
    const section = REF.slice(start, start + 1500);
    expect(section).toMatch(/not the only way to pause/);
    expect(section).toMatch(/operator_stop_after_phase/);
  });

  it('the Turn N+2 branch checks the directive before Turn N+3 dispatches the next phase', () => {
    const branch = branchSlice(ORCH);
    expect(branch).toMatch(/operator_stop_after_phase/);
    expect(branch).toMatch(/status: fired/);
    expect(branch).toMatch(/do NOT dispatch/);
  });

  it('REGRESSION CONTROL: absence of the directive leaves the existing branch unchanged', () => {
    expect(ORCH).toMatch(/Absence is the default/);
    expect(ORCH).toMatch(/additive only|changes nothing about the fence/);
  });

  it('fires in every mode, including auto, without being the banned "end a turn with a question"', () => {
    const start = ORCH.indexOf('### Ad-hoc stop-after-phase instructions');
    const end = ORCH.indexOf('### Why default mode looks like this');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const section = ORCH.slice(start, end);
    expect(section).toMatch(/runs in \*\*every mode\*\*/);
    expect(section).toMatch(/not.*the "ending a turn with a question" anti-pattern|NOT the/i);
  });

  it('tells the reader how to resume a run stopped this way', () => {
    const start = ORCH.indexOf('### Ad-hoc stop-after-phase instructions');
    const end = ORCH.indexOf('### Why default mode looks like this');
    const section = ORCH.slice(start, end);
    expect(section).toMatch(/\/ace:run <opp>\/<run-id>/);
  });

  /**
   * ace#2848 — the directive was reachable in theory and not in practice.
   *
   * "Record it immediately" cannot be obeyed from inside a phase dispatch:
   * the level-0 orchestrator is parked in `Agent(<phase>)`, and a message
   * sent to the session is not injected into its context until that call
   * returns. Measured 2026-10-12 on turmeric-market-study-ghana/20261012-1749
   * — Phase 1 dispatched 17:59:18, an operator stop request sent 18:17:09 was
   * absent from the transcript 100s later and run_state.yaml was untouched at
   * revision 19.
   *
   * So the stop has to be armable WITHOUT the orchestrator receiving anything,
   * which makes the fence's read the load-bearing part: it must come off Drive
   * at the boundary, not from a copy taken before the dispatch.
   */
  it('the fence RE-READS run_state.yaml rather than trusting an already-read copy', () => {
    const branch = branchSlice(ORCH);
    expect(branch).toMatch(/RE-READ run_state\.yaml/);
    // The old wording is the bug: a copy read before the dispatch cannot hold
    // a directive written during it.
    expect(branch).not.toMatch(/already-read/);
  });

  it('says plainly that a mid-phase message is not delivered when it is sent', () => {
    const start = ORCH.indexOf('### Ad-hoc stop-after-phase instructions');
    const end = ORCH.indexOf('### Why default mode looks like this');
    const section = ORCH.slice(start, end);
    expect(section).toMatch(/parked inside `Agent\(<phase>\)`/);
    expect(section).toMatch(/not injected into your context until that\s+call returns/);
    expect(section).toMatch(/2848/);
  });

  it('documents the out-of-band arming path, which needs no message at all', () => {
    const start = ORCH.indexOf('### Ad-hoc stop-after-phase instructions');
    const end = ORCH.indexOf('### Why default mode looks like this');
    const section = ORCH.slice(start, end);
    expect(section).toMatch(/update_yaml_file/);
    expect(section).toMatch(/out-of-band/);
    // Anyone with Drive write access — not only a level-0 orchestrator.
    expect(section).toMatch(/second session|another agent|ace-web/);
  });

  it('the reference doc carries the same warning, not just the procedure doc', () => {
    expect(REF).toMatch(/2848/);
    expect(REF).toMatch(/out-of-band/);
  });
});
