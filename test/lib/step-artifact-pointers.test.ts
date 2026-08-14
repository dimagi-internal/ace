/**
 * dimagi-internal/ace#1293 — `validate_run_state` asked for a step shape the
 * documented contract never instructs anyone to produce.
 *
 * On a fully-populated run (bednet-check-2-visit/20260814-0357, `valid: true`,
 * ZERO errors) it returned **36 warnings**, all the same pair: 18 `done` steps
 * × `artifact` + `file_id`. Every phase, including two seeded from a golden
 * run and three produced this sitting by three different code paths (a level-0
 * procedure doc, `Agent(connect-setup)`, `Agent(qa-and-training)`). A 100%
 * uniform miss is a contract gap, not a run defect — the artifacts all exist
 * and `verify_phase_artifacts` returned `ok: true` for both phases it covers.
 *
 * What skills and agent docs actually write, consistently, is
 * `summary_artifact` / `verdict_artifact` / `catalog_artifact` — the shape
 * every SKILL.md Products section and every write-back example in
 * `agents/orchestrator-reference.md` models. So:
 *
 *  - The validator now accepts ANY `*_artifact` key as the step's artifact
 *    pointer. Demanding a differently-named `artifact` field was the
 *    validator inventing a shape.
 *  - `file_id` stays a real ask — ace-web needs a Drive id to link and the
 *    per-step verifier needs something to check, and it is nearly free at the
 *    source (every skill already holds the `drive_create_doc_from_markdown`
 *    response, which returns exactly that id, and discards it). But it is
 *    reported ONCE PER PHASE with a count instead of once per step: 18
 *    identical warnings train a reader to skip the list, which is how a
 *    genuinely new warning ends up with nowhere to be seen.
 */
import { describe, it, expect } from 'vitest';
import { validateRunState } from '../../lib/run-state-validator.js';

const base = (steps: Record<string, unknown>) => ({
  opportunity: 'bednet-check-2-visit',
  run_id: '20260814-0357',
  phases: {
    'idea-to-design': {
      status: 'done',
      verdict: 'pass',
      completed_at: '2026-08-14T04:10:00Z',
      summary_artifact: '1-design/idea-to-pdd.md',
      steps,
    },
  },
});

describe('step artifact pointers (#1293)', () => {
  it('accepts summary_artifact as the step artifact pointer', () => {
    const r = validateRunState(
      base({ 'idea-to-pdd': { status: 'done', summary_artifact: '1-design/idea-to-pdd.md', file_id: 'abc' } }),
    );
    expect(r.warnings.filter((w) => w.path.endsWith('.artifact'))).toEqual([]);
  });

  it('accepts verdict_artifact and catalog_artifact too', () => {
    for (const key of ['verdict_artifact', 'catalog_artifact']) {
      const r = validateRunState(
        base({ s: { status: 'done', [key]: '1-design/x.yaml', file_id: 'abc' } }),
      );
      expect(r.warnings.filter((w) => w.path.endsWith('.artifact')), key).toEqual([]);
    }
  });

  it('still warns when a done step points at NO artifact under any name', () => {
    const r = validateRunState(base({ s: { status: 'done' } }));
    const artifactWarnings = r.warnings.filter((w) => w.path.endsWith('.artifact'));
    expect(artifactWarnings).toHaveLength(1);
    expect(artifactWarnings[0].message).toMatch(/_artifact/);
  });

  it('collapses missing file_id to ONE warning per phase, naming the steps', () => {
    const r = validateRunState(
      base({
        a: { status: 'done', summary_artifact: 'x.md' },
        b: { status: 'done', summary_artifact: 'y.md' },
        c: { status: 'done', summary_artifact: 'z.md' },
      }),
    );
    const fileIdWarnings = r.warnings.filter((w) => w.path.endsWith('.file_id'));
    expect(fileIdWarnings).toHaveLength(1);
    expect(fileIdWarnings[0].message).toMatch(/3 /);
    expect(fileIdWarnings[0].message).toMatch(/\ba\b.*\bb\b.*\bc\b/);
  });

  it('a realistic fully-populated run validates with ZERO warnings', () => {
    const r = validateRunState(
      base({
        'idea-to-pdd': { status: 'done', summary_artifact: '1-design/idea-to-pdd.md', file_id: '1aaa' },
        'idea-to-pdd-qa': { status: 'done', verdict_artifact: '1-design/idea-to-pdd-qa_result.yaml', file_id: '1bbb' },
      }),
    );
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('does not ask a partial step for either field', () => {
    const r = validateRunState(base({ s: { status: 'partial' } }));
    expect(r.warnings.filter((w) => /\.(artifact|file_id)$/.test(w.path))).toEqual([]);
  });
});
