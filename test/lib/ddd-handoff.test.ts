import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { phase7DddStep, handoffProblem } from '../../lib/ddd-handoff';
import { classifyPhaseWriteBack } from '../../lib/run-state-validator';

const REPO = path.resolve(__dirname, '..', '..');

const HANDOFF = {
  prompt_file_id: '1abcPromptFile',
  runs_dir: '/Users/x/.canopy/ddd/runs/ace-noora-health-20261015-1129',
  narrative_slug: 'newborn-care-classes-programme-cascade',
  resume_run_id: null,
  workspace: 'connect',
  prepared_at: '2026-10-15T22:32:00Z',
};

function block(status: string, synthetic: Record<string, unknown> = {}) {
  return { status, products: { synthetic } };
}

describe('phase7DddStep', () => {
  it('no block / no hand-off → build (ordinary dispatch rules)', () => {
    expect(phase7DddStep(undefined)).toEqual({ step: 'build' });
    expect(phase7DddStep(block('in_progress'))).toEqual({ step: 'build' });
  });

  it('a hand-off with no loop ending → dispatch canopy:ddd from it', () => {
    const r = phase7DddStep(block('in_progress', { ddd_handoff: HANDOFF }));
    expect(r.step).toBe('dispatch-ddd');
    if (r.step === 'dispatch-ddd') expect(r.handoff.prompt_file_id).toBe('1abcPromptFile');
  });

  it('the loop ending recorded but phase open → finalize', () => {
    const r = phase7DddStep(
      block('in_progress', {
        ddd_handoff: HANDOFF,
        ddd_run_id: 'newborn-care-classes-programme-cascade-2026-10-15-001',
        ddd_terminal_status: 'stopped_not_converged',
      }),
    );
    expect(r.step).toBe('finalize');
  });

  it('a terminal phase status → done, whatever the products say', () => {
    for (const s of ['done', 'complete', 'partial', 'skipped', 'error', 'blocked']) {
      expect(phase7DddStep(block(s, { ddd_handoff: HANDOFF })).step).toBe('done');
    }
  });

  it('a half-written hand-off is malformed, naming the field — never guessed at', () => {
    const r = phase7DddStep(block('in_progress', { ddd_handoff: { ...HANDOFF, workspace: '' } }));
    expect(r).toEqual({ step: 'malformed', reason: 'ddd_handoff.workspace is missing or empty' });
    expect(handoffProblem('x')).toBe('ddd_handoff is not a mapping');
    expect(handoffProblem({ ...HANDOFF, resume_run_id: 7 })).toMatch(/resume_run_id/);
  });

  it('an awaiting-DDD Phase 7 IS what classifyPhaseWriteBack calls in_progress — so the hand-off check must come first', () => {
    // The trap this module exists for: the silent-retry rule fires on
    // 'in_progress', and re-dispatching the build half redoes data generation.
    const rs = {
      phases: { 'synthetic-data-and-workflows': block('in_progress', { ddd_handoff: HANDOFF }) },
    };
    expect(classifyPhaseWriteBack(rs, 'synthetic-data-and-workflows')).toBe('in_progress');
    expect(phase7DddStep(rs.phases['synthetic-data-and-workflows']).step).toBe('dispatch-ddd');
  });
});

describe('the orchestrator and Phase 7 docs use the hand-off', () => {
  const orch = fs.readFileSync(path.join(REPO, 'agents/ace-orchestrator.md'), 'utf8');
  const p7 = fs.readFileSync(path.join(REPO, 'agents/synthetic-data-and-workflows.md'), 'utf8');

  it('the orchestrator dispatches canopy:ddd from the hand-off and checks it before silent-retry', () => {
    expect(orch).toContain('phase7DddStep');
    expect(orch).toContain('Agent(canopy:ddd)');
    expect(orch).toMatch(/mode: finalize/);
  });

  it('Phase 7 returns at the hand-off instead of waiting on the loop', () => {
    expect(p7).toContain('ddd_handoff');
    expect(p7).toMatch(/mode: finalize/);
    // The pattern the hand-off replaced: sleeping a phase agent past the cache window.
    expect(p7).not.toMatch(/select\(undef,\s*undef,\s*undef,\s*\d{3}/);
  });
});
