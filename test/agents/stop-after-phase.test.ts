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
});
