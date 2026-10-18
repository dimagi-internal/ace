/**
 * The optional-steps framework (plan 2026-10-18 PR1) must leave a DEFAULT run
 * exactly as it was. These tests pin that, and pin the shapes the optional
 * track adds:
 *
 *   - a run_state with no `optional_steps` block validates and classifies
 *     exactly as before;
 *   - a persisted block is validated, including its hard implications;
 *   - `phases.execution-management.mode: simulated` is the one legal mode there,
 *     and it (and only it) exempts the real onboarding / UAT / launch artifacts;
 *   - the products schema accepts the new keys without loosening its strict root.
 */
import { describe, expect, it } from 'vitest';
import { classifyPhaseWriteBack, validateRunState } from '../../lib/run-state-validator.js';
import { diffArtifacts } from '../../lib/phase-closeout.js';
import { validatePhaseProductsComplete, validatePhaseProductsFragment } from '../../lib/phase-products-schema.js';
import { resolveOptionalSteps } from '../../lib/optional-steps.js';

// A Phase 8 block as a default (no --with) run writes it today.
const DEFAULT_RUN = {
  opportunity: 'bednet-check-2-visit',
  run_id: '20261018-1200',
  mode: 'default',
  phases: {
    'solicitation-management': {
      status: 'done',
      started_at: '2026-10-18T12:00:00Z',
      completed_at: '2026-10-18T12:30:00Z',
      verdict: 'pass',
      summary_artifact: 'file-id-summary',
      products: {
        solicitation: { url: 'https://labs.connect.dimagi.com/solicitations/1/', status: 'open' },
        selected_llo: { org_slug: null },
      },
    },
  },
};

describe('a default run is unchanged', () => {
  it('no --with and no opp.yaml steps resolves to no block at all', () => {
    expect(resolveOptionalSteps({})).toBeNull();
  });

  it('validates and classifies exactly as before (no optional_steps block)', () => {
    const r = validateRunState(DEFAULT_RUN);
    expect(r.errors).toEqual([]);
    expect(classifyPhaseWriteBack(DEFAULT_RUN, 'solicitation-management')).toBe('ok');
    expect(classifyPhaseWriteBack(DEFAULT_RUN, 'execution-management')).toBe('missing');
  });

  it('Phase 9 with no mode still requires the real execution artifacts', () => {
    const report = diffArtifacts('execution-management', ['9-execution-manager/execution-manager_summary.md']);
    expect(report.ok).toBe(false);
    expect(report.missing.map((m) => m.path)).toEqual(
      expect.arrayContaining([
        '9-execution-manager/llo-onboarding_comms-log.md',
        '9-execution-manager/llo-uat_results.md',
        '9-execution-manager/llo-launch_record.md',
      ]),
    );
  });
});

describe('the optional_steps block in run_state', () => {
  const steps = resolveOptionalSteps({ withFlag: 'labs_e2e', now: new Date('2026-10-18T14:02:00Z') })!;

  it('a resolved block validates clean', () => {
    expect(validateRunState({ ...DEFAULT_RUN, optional_steps: steps }).errors).toEqual([]);
  });

  it('a hand-edited block that puts fabricated responses on a public call is an error', () => {
    const r = validateRunState({ ...DEFAULT_RUN, optional_steps: { ...steps, private_solicitation: false } });
    expect(r.valid).toBe(false);
    expect(r.errors[0].path).toBe('optional_steps');
  });

  it('the block is run-level, so it never changes a phase classification', () => {
    expect(
      classifyPhaseWriteBack({ ...DEFAULT_RUN, optional_steps: steps }, 'solicitation-management'),
    ).toBe('ok');
  });
});

describe('phases.execution-management.mode: simulated', () => {
  const block = (mode: unknown) => ({
    phases: {
      'execution-management': {
        status: 'done',
        completed_at: '2026-10-18T15:00:00Z',
        verdict: 'pass',
        mode,
      },
    },
  });

  it('is legal; any other value there is an error', () => {
    expect(validateRunState(block('simulated')).errors).toEqual([]);
    expect(classifyPhaseWriteBack(block('simulated'), 'execution-management')).toBe('ok');
    expect(validateRunState(block('real')).valid).toBe(false);
    expect(classifyPhaseWriteBack(block('pretend'), 'execution-management')).toBe('malformed');
  });

  it('exempts only the real onboarding / UAT / launch artifacts; the summary is still required', () => {
    const ok = diffArtifacts('execution-management', ['9-execution-manager/execution-manager_summary.md'], {
      mode: 'simulated',
    });
    expect(ok.missing.map((m) => m.path)).toEqual([]);
    expect(ok.ok).toBe(true);
    const noSummary = diffArtifacts('execution-management', [], { mode: 'simulated' });
    expect(noSummary.missing.map((m) => m.path)).toEqual(['9-execution-manager/execution-manager_summary.md']);
  });

  it('does not relax any other phase', () => {
    const qa = diffArtifacts('qa-and-training', [], { mode: 'simulated' });
    const qaDefault = diffArtifacts('qa-and-training', []);
    expect(qa.missing.map((m) => m.path)).toEqual(qaDefault.missing.map((m) => m.path));
  });
});

describe('products shapes the optional track adds', () => {
  it('Phase 8: solicitation.visibility and selected_llo.synthetic_winner', () => {
    const products = {
      solicitation: { url: 'https://labs.connect.dimagi.com/solicitations/2/', visibility: 'private' },
      selected_llo: { org_slug: 'ace-llo-org', source: 'solicitation', synthetic_winner: true },
    };
    expect(validatePhaseProductsComplete('solicitation-management', products).issues).toEqual([]);
    expect(
      validatePhaseProductsFragment('solicitation-management', {
        solicitation: { url: 'https://labs.connect.dimagi.com/solicitations/2/', visibility: 'unlisted' },
      }).valid,
    ).toBe(false);
  });

  it('Phase 9: supply_chain and simulation are accepted; the strict root still rejects unknown keys', () => {
    const products = {
      supply_chain: { program_id: 900, labs_org_ids: { pm: 386, llo: 412 }, commodities: ['feature-handset'] },
      simulation: { calendar: { sim_start: '2026-09-07' }, weekly_reviews: ['f1', 'f2', 'f3', 'f4'] },
    };
    expect(validatePhaseProductsComplete('execution-management', products, 'simulated').issues).toEqual([]);
    expect(validatePhaseProductsFragment('execution-management', { procurement: {} }).valid).toBe(false);
  });
});
