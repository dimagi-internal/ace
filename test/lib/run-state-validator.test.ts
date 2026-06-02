/**
 * Tests for `lib/run-state-validator.ts` — the pure-function validator
 * the orchestrator's Phase Write-Back Verifier will use to decide
 * whether a phase agent wrote its block correctly.
 *
 * Source-of-truth contract:
 *   - `agents/orchestrator-reference.md § Phase Write-Back Contract`
 *
 * Coverage:
 *   - Empty / null run_state.yaml is valid (run-init state)
 *   - Top-level non-object is an error
 *   - phases mapping vs scalar
 *   - status enum (phase + step) — accepted values, rejected values
 *   - done phase missing completed_at → warning
 *   - done step missing artifact/file_id → warning (per the
 *     malaria-itn-app/20260523-0750 observation)
 *   - verdict/artifact/file_id/summary_artifact type guards
 *   - classifyPhaseWriteBack — the convenience helper for the
 *     silent-dispatch retry path
 */

import { describe, it, expect } from 'vitest';
import {
  validateRunState,
  classifyPhaseWriteBack,
  validateIterateState,
} from '../../lib/run-state-validator.js';

describe('validateRunState', () => {
  describe('empty / minimal', () => {
    it('treats null (empty YAML doc) as valid', () => {
      const r = validateRunState(null);
      expect(r.valid).toBe(true);
      expect(r.errors).toEqual([]);
    });

    it('treats undefined as valid', () => {
      const r = validateRunState(undefined);
      expect(r.valid).toBe(true);
    });

    it('treats {} (no phases yet) as valid', () => {
      const r = validateRunState({});
      expect(r.valid).toBe(true);
    });

    it('treats {phases: {}} (no phases written yet) as valid', () => {
      const r = validateRunState({ phases: {} });
      expect(r.valid).toBe(true);
    });
  });

  describe('top-level errors', () => {
    it('rejects a top-level string', () => {
      const r = validateRunState('not yaml');
      expect(r.valid).toBe(false);
      expect(r.errors[0]?.message).toMatch(/must be a mapping/);
    });

    it('rejects a top-level array', () => {
      const r = validateRunState([{ phases: {} }]);
      expect(r.valid).toBe(false);
    });

    it('rejects phases as a non-object', () => {
      const r = validateRunState({ phases: 'done' });
      expect(r.valid).toBe(false);
      expect(r.errors[0]?.path).toBe('phases');
    });
  });

  describe('phase status enum', () => {
    it.each(['pending', 'in_progress', 'done', 'error', 'blocked', 'skipped'])(
      'accepts phase status = %s',
      (status) => {
        const r = validateRunState({
          phases: { 'idea-to-design': { status } },
        });
        expect(r.errors.filter((e) => e.path.endsWith('.status'))).toEqual([]);
      },
    );

    it('rejects an unrecognized phase status', () => {
      const r = validateRunState({
        phases: { 'idea-to-design': { status: 'maybe' } },
      });
      expect(r.valid).toBe(false);
      expect(r.errors[0].path).toBe('phases.idea-to-design.status');
      expect(r.errors[0].actual).toBe('maybe');
    });

    it('rejects a missing phase status', () => {
      const r = validateRunState({ phases: { 'idea-to-design': {} } });
      expect(r.valid).toBe(false);
      expect(r.errors[0].message).toMatch(/missing required `status`/);
    });

    it('rejects a phase block that is a string instead of an object', () => {
      const r = validateRunState({ phases: { 'idea-to-design': 'done' } });
      expect(r.valid).toBe(false);
      expect(r.errors[0].path).toBe('phases.idea-to-design');
    });
  });

  describe('phase status: done warnings', () => {
    it('warns when status: done has no completed_at', () => {
      const r = validateRunState({
        phases: { 'idea-to-design': { status: 'done' } },
      });
      expect(r.valid).toBe(true); // warnings don't fail
      expect(r.warnings.some((w) => w.path.endsWith('.completed_at'))).toBe(
        true,
      );
    });

    it('does NOT warn when status: done has completed_at', () => {
      const r = validateRunState({
        phases: {
          'idea-to-design': {
            status: 'done',
            completed_at: '2026-05-24T10:00:00Z',
          },
        },
      });
      expect(r.warnings).toEqual([]);
    });
  });

  describe('verdict / summary_artifact type guards', () => {
    it('rejects a non-string verdict', () => {
      const r = validateRunState({
        phases: { p: { status: 'done', verdict: 42 } },
      });
      expect(r.valid).toBe(false);
      expect(r.errors[0].path).toBe('phases.p.verdict');
    });

    it('rejects a non-string summary_artifact', () => {
      const r = validateRunState({
        phases: { p: { status: 'done', summary_artifact: { id: 'x' } } },
      });
      expect(r.valid).toBe(false);
      expect(r.errors[0].path).toBe('phases.p.summary_artifact');
    });
  });

  describe('steps', () => {
    it('accepts steps as an object with valid statuses', () => {
      const r = validateRunState({
        phases: {
          'idea-to-design': {
            status: 'done',
            completed_at: '2026-05-24T10:00:00Z',
            steps: {
              'idea-to-pdd': {
                status: 'done',
                artifact: '1-design/idea-to-pdd.md',
                file_id: 'abc123',
              },
            },
          },
        },
      });
      expect(r.errors).toEqual([]);
      expect(r.warnings).toEqual([]);
    });

    it('rejects steps as a non-object', () => {
      const r = validateRunState({
        phases: { p: { status: 'done', steps: 'foo' } },
      });
      expect(r.valid).toBe(false);
      expect(r.errors[0].path).toBe('phases.p.steps');
    });

    it('rejects an invalid step status', () => {
      const r = validateRunState({
        phases: {
          p: {
            status: 'done',
            steps: { s1: { status: 'partial' } },
          },
        },
      });
      expect(r.valid).toBe(false);
      expect(r.errors[0].path).toBe('phases.p.steps.s1.status');
    });

    it('warns when a status: done step has no artifact (Producer Artifact Verifier signal)', () => {
      const r = validateRunState({
        phases: {
          p: {
            status: 'done',
            steps: { s1: { status: 'done' } },
          },
        },
      });
      expect(r.valid).toBe(true);
      expect(r.warnings.some((w) => w.path === 'phases.p.steps.s1.artifact')).toBe(true);
      expect(r.warnings.some((w) => w.path === 'phases.p.steps.s1.file_id')).toBe(true);
    });

    it('accepts the legacy `complete` step status as a synonym for `done`', () => {
      const r = validateRunState({
        phases: {
          p: {
            status: 'done',
            completed_at: '2026-05-24T10:00:00Z',
            steps: { s1: { status: 'complete', artifact: 'x.md', file_id: 'id' } },
          },
        },
      });
      expect(r.valid).toBe(true);
      expect(r.warnings).toEqual([]);
    });

    it('rejects non-string artifact / file_id', () => {
      const r = validateRunState({
        phases: {
          p: {
            status: 'done',
            steps: { s1: { status: 'done', artifact: 42, file_id: ['x'] } },
          },
        },
      });
      expect(r.valid).toBe(false);
      expect(r.errors.map((e) => e.path).sort()).toEqual([
        'phases.p.steps.s1.artifact',
        'phases.p.steps.s1.file_id',
      ]);
    });
  });

  describe('multi-phase happy path', () => {
    it('validates a realistic mid-run run_state.yaml', () => {
      const parsed = {
        mode: 'default',
        created: '2026-05-24T08:00:00Z',
        opportunity: 'malaria-rdt',
        run_id: '20260524-0800',
        phases: {
          'idea-to-design': {
            status: 'done',
            started_at: '2026-05-24T08:00:00Z',
            completed_at: '2026-05-24T08:15:00Z',
            verdict: 'pass',
            summary_artifact: 'doc-abc',
            steps: {
              'idea-to-pdd': {
                status: 'done',
                verdict: 'pass',
                artifact: '1-design/idea-to-pdd.md',
                file_id: 'doc-pdd',
              },
            },
          },
          'scenarios-and-acceptance': {
            status: 'in_progress',
            started_at: '2026-05-24T08:15:30Z',
          },
        },
      };
      const r = validateRunState(parsed);
      expect(r.valid).toBe(true);
      expect(r.errors).toEqual([]);
      expect(r.warnings).toEqual([]);
    });
  });
});

describe('classifyPhaseWriteBack', () => {
  it('returns missing when no phases block exists', () => {
    expect(classifyPhaseWriteBack({}, 'p')).toBe('missing');
    expect(classifyPhaseWriteBack(null, 'p')).toBe('missing');
    expect(classifyPhaseWriteBack({ phases: null }, 'p')).toBe('missing');
  });

  it('returns missing when the named phase is absent', () => {
    expect(
      classifyPhaseWriteBack({ phases: { other: { status: 'done' } } }, 'p'),
    ).toBe('missing');
  });

  it('returns in_progress when status is in_progress / pending', () => {
    expect(
      classifyPhaseWriteBack(
        { phases: { p: { status: 'in_progress' } } },
        'p',
      ),
    ).toBe('in_progress');
    expect(
      classifyPhaseWriteBack({ phases: { p: { status: 'pending' } } }, 'p'),
    ).toBe('in_progress');
  });

  it('returns ok when status is done (and well-formed)', () => {
    expect(
      classifyPhaseWriteBack(
        {
          phases: {
            p: { status: 'done', completed_at: '2026-05-24T10:00:00Z' },
          },
        },
        'p',
      ),
    ).toBe('ok');
  });

  it('returns error when status is error', () => {
    expect(
      classifyPhaseWriteBack({ phases: { p: { status: 'error' } } }, 'p'),
    ).toBe('error');
  });

  it('returns blocked when status is blocked (operator-actionable halt, not malformed) — #571', () => {
    expect(
      classifyPhaseWriteBack({ phases: { p: { status: 'blocked' } } }, 'p'),
    ).toBe('blocked');
  });

  it('returns skipped when status is skipped (run-shape decision, terminal — #672)', () => {
    expect(
      classifyPhaseWriteBack({ phases: { p: { status: 'skipped' } } }, 'p'),
    ).toBe('skipped');
  });

  it('returns malformed when the block has an invalid status', () => {
    expect(
      classifyPhaseWriteBack({ phases: { p: { status: 'whatever' } } }, 'p'),
    ).toBe('malformed');
  });
});

describe('validateIterateState', () => {
  const minimal = {
    opp: 'bednet-spot-check',
    target_phases: [3, 6],
    golden_run_id: '20260601-1252',
    runner: 'web',
    streak: 0,
    required_streak: 5,
    iterations: [],
  };

  it('accepts a minimal well-formed state', () => {
    const r = validateIterateState(minimal);
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('rejects a non-object', () => {
    expect(validateIterateState('nope').valid).toBe(false);
    expect(validateIterateState(42).valid).toBe(false);
  });

  it('requires opp, golden_run_id, runner', () => {
    const r = validateIterateState({ ...minimal, opp: undefined });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.path === 'opp')).toBe(true);
  });

  it('rejects an unknown runner', () => {
    const r = validateIterateState({ ...minimal, runner: 'cloud' });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.path === 'runner')).toBe(true);
  });

  it('rejects a negative or non-integer streak', () => {
    expect(validateIterateState({ ...minimal, streak: -1 }).valid).toBe(false);
    expect(validateIterateState({ ...minimal, streak: 2.5 }).valid).toBe(false);
  });

  it('requires target_phases to be a non-empty integer array', () => {
    expect(validateIterateState({ ...minimal, target_phases: [] }).valid).toBe(false);
    expect(validateIterateState({ ...minimal, target_phases: ['3'] }).valid).toBe(false);
  });

  it('validates each iteration entry shape', () => {
    const r = validateIterateState({
      ...minimal,
      iterations: [
        { run_id: '20260601-1300', verdict: 'clean', version_at_run: '0.13.502' },
        { run_id: '20260601-1330', verdict: 'bogus' },
      ],
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.path === 'iterations[1].verdict')).toBe(true);
  });

  it('treats null as valid (fresh, not-yet-written state)', () => {
    expect(validateIterateState(null).valid).toBe(true);
  });
});
