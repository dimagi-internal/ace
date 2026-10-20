import { describe, it, expect } from 'vitest';
import {
  PHASE_DEFS,
  phaseModeFromRunState,
  runStatePhaseBlock,
  type Phase,
} from '../../lib/artifact-manifest.js';
import { diffArtifacts, computeExpectedRequiredArtifacts } from '../../lib/phase-closeout.js';

// dimagi-internal/ace#3267 — verify_phase_artifacts resolved the run's phase
// MODE from `phases[phaseAgentName(phase)]`. run_state does NOT key every phase
// block by its agent name: Phase 9 is written as `phases.execution-management`
// while its agentName is `execution-manager`, so a simulated run's
// `mode: simulated` was never seen and the three real-LLO artifacts stayed
// required (observed on connect-fi/20261018-1440).

const LLO_ROWS = [
  '9-execution-manager/llo-onboarding_comms-log.md',
  '9-execution-manager/llo-uat_results.md',
  '9-execution-manager/llo-launch_record.md',
];

describe('phaseModeFromRunState (ace#3267)', () => {
  it('reads phases.execution-management.mode — the key run_state actually writes', () => {
    const runState = { phases: { 'execution-management': { status: 'in_progress', mode: 'simulated' } } };
    expect(phaseModeFromRunState(runState, 'execution-management')).toBe('simulated');
  });

  it('a simulated run_state relaxes the three llo-* rows with no explicit mode', () => {
    const runState = { phases: { 'execution-management': { status: 'in_progress', mode: 'simulated' } } };
    const mode = phaseModeFromRunState(runState, 'execution-management');
    const required = computeExpectedRequiredArtifacts('execution-management').map((e) => e.path);
    for (const p of LLO_ROWS) expect(required, `${p} is required in the default mode`).toContain(p);
    const present = required.filter((p) => !LLO_ROWS.includes(p));
    const report = diffArtifacts('execution-management', present, { mode });
    expect(report.missing.map((m) => m.path)).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('still reads agent-name-keyed blocks (phases.commcare-setup, phases.idea-to-design)', () => {
    const runState = {
      phases: {
        'commcare-setup': { status: 'done', mode: 'x-commcare' },
        'idea-to-design': { status: 'done', mode: 'x-design' },
      },
    };
    expect(phaseModeFromRunState(runState, 'commcare')).toBe('x-commcare');
    expect(phaseModeFromRunState(runState, 'design')).toBe('x-design');
  });

  it('resolves every phase whose agentName differs from its key under EITHER spelling', () => {
    const differing = PHASE_DEFS.filter((d) => d.agentName !== d.key);
    expect(differing.length).toBeGreaterThan(0);
    for (const d of differing) {
      for (const name of [d.agentName, d.key]) {
        const runState = { phases: { [name]: { status: 'done', mode: 'm' } } };
        expect(runStatePhaseBlock(runState, d.key as Phase), `${d.key} via ${name}`).toEqual({
          status: 'done',
          mode: 'm',
        });
      }
    }
  });

  it('returns undefined for missing / malformed run_state and non-string mode', () => {
    expect(phaseModeFromRunState(undefined, 'execution-management')).toBeUndefined();
    expect(phaseModeFromRunState({}, 'execution-management')).toBeUndefined();
    expect(phaseModeFromRunState({ phases: [] }, 'execution-management')).toBeUndefined();
    expect(
      phaseModeFromRunState({ phases: { 'execution-management': { mode: 3 } } }, 'execution-management'),
    ).toBeUndefined();
  });
});
