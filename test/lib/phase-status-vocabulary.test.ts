/**
 * The `phases.<phase>.status` vocabulary, locked across every surface that
 * reads it. Regression suite for dimagi-internal/ace#1139 + ace#992.
 *
 * The bug class both issues describe is NOT "an agent typed the wrong word" —
 * it is "the contract disagrees with itself, and the error channel is too
 * coarse to say so":
 *
 *   - ace#1139: the phase docs MANDATE `status: partial` when a declared
 *     producer parks; `validateRunState` rejected it, so
 *     `classifyPhaseWriteBack` returned `malformed` — one of the
 *     orchestrator's silent-dispatch RETRY triggers. Documented-correct
 *     behaviour was indistinguishable from an agent that failed to write.
 *   - ace#992: `complete` was simultaneously accepted by
 *     `verify_phase_products`, accepted at STEP level by the validator, and
 *     rejected at PHASE level — one run got `ok: true` from two boundary
 *     fences and `malformed` from the third on the same literal string.
 *
 * So the assertions here are deliberately CROSS-SURFACE: for each terminal
 * status, all three fences must agree. A single-surface test would have
 * passed happily through both bugs.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  validateRunState,
  classifyPhaseWriteBack,
  PHASE_STATUS_VALUES,
  STEP_STATUS_VALUES,
} from '../../lib/run-state-validator.js';
import { classifyPhaseProducts } from '../../lib/phase-products-schema.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * A Phase 3 write-back in exactly the state ace#1139 hit live
 * (`spark-facilitator/20260731-0656`): both apps built, deployed and released
 * — so the typed `products` handoff Phase 4 reads is complete — but
 * `app-test-cases` shipped only the Learn smoke recipe, with the Deliver smoke
 * parked on ace#1081 + ace#1138.
 */
function parkedProducerRunState(status: string) {
  return {
    phases: {
      'commcare-setup': {
        status,
        started_at: '2026-07-31T06:56:00Z',
        completed_at: '2026-07-31T09:12:00Z',
        verdict: 'partial-producer-deferred',
        status_note:
          'app-test-cases shipped recipes/journey-learn.yaml; Deliver smoke parked on ace#1081 + ace#1138.',
        products: {
          apps: {
            domain: 'ace-spark-facilitator',
            learn: { name: 'Learn', hq_app_id: 'abc123', build_status: 'success' },
            deliver: { name: 'Deliver', hq_app_id: 'def456', build_status: 'success' },
          },
        },
        steps: {
          'app-deploy': {
            status: 'done',
            verdict: 'pass',
            artifact: '3-commcare/app-deploy.yaml',
            file_id: '1deployFileId',
          },
          'app-test-cases': {
            status: 'incomplete',
            verdict: 'partial',
          },
        },
      },
    },
  };
}

describe('parked-producer phase (status: partial) — ace#1139', () => {
  const parsed = parkedProducerRunState('partial');

  it('validateRunState calls it VALID', () => {
    const r = validateRunState(parsed);
    expect(r.errors).toEqual([]);
    expect(r.valid).toBe(true);
  });

  it('classifyPhaseWriteBack returns a NON-RETRY disposition', () => {
    const disposition = classifyPhaseWriteBack(parsed, 'commcare-setup');
    // The orchestrator's silent-dispatch retry set (agents/ace-orchestrator.md
    // § Auto-retry silent Agent dispatches). `partial` must never land in it —
    // re-running the phase would not un-park the parked producer.
    expect(['missing', 'in_progress', 'malformed']).not.toContain(disposition);
    expect(disposition).toBe('ok');
  });

  it('classifyPhaseProducts AGREES — terminal, and the strict check ran', () => {
    const c = classifyPhaseProducts(parsed, 'commcare-setup');
    expect(c.status).toBe('partial');
    // `partial` may park ARTIFACTS; it may never park the typed handoff, so it
    // sits on the strict side of the fragment/complete line.
    expect(c.mode).toBe('complete');
    expect(c.issues).toEqual([]);
    expect(c.ok).toBe(true);
  });

  it('still FAILS the products fence when the parked producer owned a required handoff key', () => {
    // The escape hatch must not become a way to ship a hole downstream cannot
    // proceed past — that state is `blocked`, not `partial`.
    const missingHandoff = parkedProducerRunState('partial');
    delete (missingHandoff.phases['commcare-setup'].products.apps as any).deliver;
    const c = classifyPhaseProducts(missingHandoff, 'commcare-setup');
    expect(c.mode).toBe('complete');
    expect(c.ok).toBe(false);
    expect(JSON.stringify(c.issues)).toContain('apps.deliver.hq_app_id');
  });

  it('accepts `partial` at STEP level too (synonym of incomplete)', () => {
    const r = validateRunState({
      phases: { p: { status: 'partial', completed_at: 'x', steps: { s1: { status: 'partial' } } } },
    });
    expect(r.valid).toBe(true);
  });

  it('warns when a terminal `partial` phase has no completed_at', () => {
    const r = validateRunState({ phases: { p: { status: 'partial' } } });
    expect(r.valid).toBe(true);
    expect(r.warnings.some((w) => w.path === 'phases.p.completed_at')).toBe(true);
  });
});

describe('`complete` — the three-way split is closed (ace#992)', () => {
  const parsed = parkedProducerRunState('complete');

  it('validateRunState accepts it at PHASE level (was: rejected → malformed)', () => {
    expect(validateRunState(parsed).valid).toBe(true);
  });

  it('classifyPhaseWriteBack returns ok (was: malformed → full phase re-dispatch)', () => {
    expect(classifyPhaseWriteBack(parsed, 'commcare-setup')).toBe('ok');
  });

  it('classifyPhaseProducts agrees it is terminal (it always did — that was the split)', () => {
    expect(classifyPhaseProducts(parsed, 'commcare-setup').mode).toBe('complete');
  });

  it('warns at both levels that `done` is canonical', () => {
    const r = validateRunState({
      phases: {
        p: { status: 'complete', completed_at: 'x', steps: { s1: { status: 'complete' } } },
      },
    });
    expect(r.valid).toBe(true);
    const paths = r.warnings.filter((w) => /legacy synonym/.test(w.message)).map((w) => w.path);
    expect(paths).toContain('phases.p.status');
    expect(paths).toContain('phases.p.steps.s1.status');
    expect(r.warnings.find((w) => w.path === 'phases.p.status')?.expected).toBe('done');
  });
});

describe('all three fences agree on every terminal status', () => {
  // The load-bearing invariant. Any future status added to one surface without
  // the others fails here rather than on a live run.
  for (const status of ['done', 'complete', 'partial']) {
    it(`\`${status}\`: valid + non-retry + strict products check`, () => {
      const parsed = parkedProducerRunState(status);
      expect(validateRunState(parsed).valid).toBe(true);
      expect(classifyPhaseWriteBack(parsed, 'commcare-setup')).toBe('ok');
      expect(classifyPhaseProducts(parsed, 'commcare-setup').mode).toBe('complete');
      expect(classifyPhaseProducts(parsed, 'commcare-setup').ok).toBe(true);
    });
  }

  it('an in-flight phase is still fragment-checked and still retryable', () => {
    const parsed = parkedProducerRunState('in_progress');
    expect(classifyPhaseWriteBack(parsed, 'commcare-setup')).toBe('in_progress');
    expect(classifyPhaseProducts(parsed, 'commcare-setup').mode).toBe('fragment');
  });

  it('an unrecognized status is still malformed (the enum is not open)', () => {
    const parsed = parkedProducerRunState('mostly-done');
    expect(validateRunState(parsed).valid).toBe(false);
    expect(classifyPhaseWriteBack(parsed, 'commcare-setup')).toBe('malformed');
  });
});

/**
 * The class-level preventer ace#1139 asked for: "a grep-driven test over
 * `agents/*.md` for `status: <value>` would have caught this the day the rule
 * was written." Phase-agent prose is the only thing a dispatched agent reads
 * before writing its block; a status word that appears there and not in the
 * enum is a re-dispatch waiting to happen.
 */
describe('every `status: <value>` prescribed in agents/*.md is a legal enum value', () => {
  /**
   * Status vocabularies in agents/*.md that are NOT run_state phase/step
   * statuses. Adding to this list must be a conscious act — if a token here is
   * really a phase/step status, it belongs in the enum instead.
   */
  const OTHER_VOCABULARIES = new Set([
    'open', // products.solicitation.status (open until awarded)
    'overridden', // decisions.yaml row status
    'ai-default', // decisions.yaml row status
  ]);

  it('has no unlisted status word', () => {
    const agentsDir = path.join(REPO_ROOT, 'agents');
    const offenders: string[] = [];
    const legal = new Set([...PHASE_STATUS_VALUES, ...STEP_STATUS_VALUES]);

    for (const file of fs.readdirSync(agentsDir).filter((f) => f.endsWith('.md'))) {
      const lines = fs.readFileSync(path.join(agentsDir, file), 'utf-8').split('\n');
      lines.forEach((line, i) => {
        for (const m of line.matchAll(/status:\s*([a-z][a-z_-]*)/g)) {
          const value = m[1];
          // A pipe-separated legend (`status: in_progress | done | error`) is
          // documentation of the enum, not a prescription of one value; the
          // first alternative is still checked by this same regex.
          if (legal.has(value) || OTHER_VOCABULARIES.has(value)) continue;
          offenders.push(`agents/${file}:${i + 1} — status: ${value}`);
        }
      });
    }

    expect(
      offenders,
      `agents/*.md prescribes status values the run_state validator rejects.\n` +
        `Writing one of these makes classify_phase_writeback return 'malformed', which the\n` +
        `orchestrator treats as a silent-dispatch failure and re-runs the whole phase (ace#1139).\n` +
        `Fix the doc, add the value to PHASE_STATUS_VALUES/STEP_STATUS_VALUES in\n` +
        `lib/run-state-validator.ts, or (if it is a different vocabulary entirely)\n` +
        `add it to OTHER_VOCABULARIES in this test.\n\n` +
        offenders.join('\n'),
    ).toEqual([]);
  });
});
