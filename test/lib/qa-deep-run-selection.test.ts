/**
 * Tests for `lib/qa-deep-run-selection.ts` (ace#1950).
 *
 * Fixtures are the two REAL `run_state.yaml` shapes on `hh-poverty-targeting`,
 * read from Drive on 2026-09-05:
 *
 *   - 20260901-1932 — a Phase-7-only validation fork. `forked_from:
 *     20260828-0702`, six phases at `verdict: seeded` sharing one fork-timestamp
 *     `completed_at`, phases 8/9/10 `status: skipped` with
 *     `skip_reason: "Validation fork -- Phase 7 only."`, and an `ocs-setup` block
 *     with NO `products` at all.
 *   - 20260828-0702 — the complete run. Phases 1–8 executed with real verdicts;
 *     `phases.ocs-setup.products.ocs_chatbot.experiment_id: 13029`;
 *     `execution-management` / `closeout` still `pending`, which is what a
 *     healthy run that has not reached Phase 9 looks like.
 *
 * The defect: `resolve_current_run_id('hh-poverty-targeting')` returned
 * `20260901-1932` live — the fork — because it picks the lexicographically
 * largest FOLDER name. The negative control below reproduces that selector and
 * asserts it picks the fork, so this suite fails if the fix ever regresses to
 * newest-folder-wins.
 */
import { describe, it, expect } from 'vitest';
import {
  selectQaDeepRun,
  assessQaDeepRun,
  assertRunOwnsChatbot,
  formatQaDeepRefusal,
  type QaDeepRunCandidate,
} from '../../lib/qa-deep-run-selection.js';

/** The fork, abridged to the fields the selector reads. Verbatim values. */
const FORK_20260901_1932 = {
  opportunity: 'hh-poverty-targeting',
  run_id: '20260901-1932',
  mode: 'default',
  current_phase: 'synthetic-data-and-workflows',
  phases: {
    'idea-to-design': {
      status: 'done',
      verdict: 'seeded',
      completed_at: '2026-09-01T19:32:08.507199+00:00',
    },
    'scenarios-and-acceptance': {
      status: 'done',
      verdict: 'seeded',
      completed_at: '2026-09-01T19:32:08.507199+00:00',
    },
    'commcare-setup': {
      status: 'done',
      verdict: 'seeded',
      completed_at: '2026-09-01T19:32:08.507199+00:00',
      products: {
        apps: {
          learn: {
            nova_app_id: 'f7c9ea59-c38e-489f-83ef-e5d772299443',
            hq_app_id: 'b660b489f87d434f8bcdb8d576d7ca01',
            domain: 'connect-ace-prod',
          },
          deliver: {
            nova_app_id: 'ae580dbe-c4e9-4f95-bb6f-b6f053db9205',
            hq_app_id: 'ce668763ad6c4b48ac5f4cd4502f3f8c',
            domain: 'connect-ace-prod',
          },
        },
      },
    },
    'connect-setup': { status: 'done', verdict: 'seeded' },
    // Note: no `products` block at all — the fork's own `seeded_products_note`
    // says Phase 5 was not seeded because Phase 7 did not need it.
    'ocs-setup': { status: 'done', verdict: 'seeded' },
    'qa-and-training': { status: 'done', verdict: 'seeded' },
    'synthetic-data-and-workflows': {
      status: 'done',
      verdict: 'passed-with-deferred-evals',
    },
    'solicitation-management': {
      status: 'skipped',
      verdict: 'skipped',
      skip_reason: 'Validation fork -- Phase 7 only. The source run 20260828-0702',
    },
    'execution-management': {
      status: 'skipped',
      verdict: 'skipped',
      skip_reason: 'Validation fork -- Phase 7 only. Phase 9 is not live.',
    },
    closeout: {
      status: 'skipped',
      verdict: 'skipped',
      skip_reason: 'Validation fork -- Phase 7 only.',
    },
  },
  forked_from: '20260828-0702',
  forked_from_phase: 'synthetic-data-and-workflows',
  forked_at: '2026-09-01T19:32:08.507199+00:00',
};

/** The complete run, abridged. Verbatim values. */
const COMPLETE_20260828_0702 = {
  opportunity: 'hh-poverty-targeting',
  run_id: '20260828-0702',
  mode: 'default',
  phases: {
    'idea-to-design': { status: 'done', verdict: 'proceed-with-warn' },
    'scenarios-and-acceptance': { status: 'done', verdict: 'proceed' },
    'commcare-setup': {
      status: 'done',
      verdict: 'proceed-with-warn',
      products: {
        apps: {
          learn: { hq_app_id: 'b660b489f87d434f8bcdb8d576d7ca01' },
          deliver: { hq_app_id: 'ce668763ad6c4b48ac5f4cd4502f3f8c' },
        },
      },
    },
    'connect-setup': { status: 'done', verdict: 'proceed-with-warn' },
    'ocs-setup': {
      status: 'done',
      verdict: 'pass',
      products: {
        ocs_chatbot: {
          experiment_id: 13029,
          public_id: '2c8d5f93-8e4f-4fde-9bf8-650909255c30',
          embed_key: 'BeEwldQML9Frnm43n8nR65KBt6BhsZMM',
          team_slug: 'connect-ace',
        },
      },
    },
    'qa-and-training': { status: 'done', verdict: 'proceed-with-warn' },
    'synthetic-data-and-workflows': {
      status: 'done',
      verdict: 'passed-with-deferred-evals',
    },
    'solicitation-management': {
      status: 'done',
      verdict: 'halt-at-phase-8-to-9-boundary',
    },
    // A healthy run that has simply not reached Phase 9 yet.
    'execution-management': { status: 'pending' },
    closeout: { status: 'pending' },
  },
};

const CANDIDATES: QaDeepRunCandidate[] = [
  { run_id: '20260828-0702', run_state: COMPLETE_20260828_0702 },
  { run_id: '20260901-1932', run_state: FORK_20260901_1932 },
];

/**
 * The defect, reproduced. This is `resolve_current_run_id`'s rule verbatim:
 * "picks the lexicographically-largest folder name". It is NOT imported from
 * the module under test — shipping it would be shipping the bug.
 */
function naiveNewestFolder(candidates: QaDeepRunCandidate[]): string {
  return [...candidates].map((c) => c.run_id).sort()[candidates.length - 1];
}

describe('the defect (negative control)', () => {
  it('newest-folder-wins picks the Phase-7-only fork on real hh-poverty-targeting data', () => {
    // This is exactly what `resolve_current_run_id('hh-poverty-targeting')`
    // returned live on 2026-09-05.
    expect(naiveNewestFolder(CANDIDATES)).toBe('20260901-1932');
  });

  it('and the fork carries enough for Stage B to run to completion against it', () => {
    // The reason a failed lookup would have been the SAFE outcome: the apps
    // half has everything it reads.
    const apps = (FORK_20260901_1932.phases['commcare-setup'] as any).products.apps;
    expect(apps.learn.hq_app_id).toBeTruthy();
    expect(apps.deliver.hq_app_id).toBeTruthy();
  });
});

describe('selectQaDeepRun', () => {
  it('rejects the fork and selects the complete run', () => {
    const result = selectQaDeepRun(CANDIDATES);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.run_id).toBe('20260828-0702');
  });

  it('names the fork among the rejected candidates, with reasons', () => {
    const result = selectQaDeepRun(CANDIDATES);
    if (!result.ok) throw new Error('expected ok');
    const fork = result.rejected.find((r) => r.run_id === '20260901-1932');
    expect(fork).toBeDefined();
    const codes = fork!.reasons.map((r) => r.code);
    expect(codes).toContain('fork');
    expect(codes).toContain('seeded-phases');
    expect(codes).toContain('fork-skipped-phases');
    expect(codes).toContain('missing-products');
  });

  it('considers candidates newest-first regardless of input order', () => {
    const reversed = [...CANDIDATES].reverse();
    const result = selectQaDeepRun(reversed);
    if (!result.ok) throw new Error('expected ok');
    expect(result.run_id).toBe('20260828-0702');
    expect(result.rejected.map((r) => r.run_id)).toEqual(['20260901-1932']);
  });

  it('does NOT reject a run that legitimately stopped short of Phase 9', () => {
    // `execution-management` and `closeout` are `pending` on the complete run.
    // A stricter "every phase done" rule would reject every real qa-deep target.
    expect(assessQaDeepRun({ run_id: '20260828-0702', run_state: COMPLETE_20260828_0702 })).toEqual(
      [],
    );
  });

  it('does NOT treat a non-fork skip_reason as a fork', () => {
    const stoppedShort = {
      ...COMPLETE_20260828_0702,
      phases: {
        ...COMPLETE_20260828_0702.phases,
        closeout: {
          status: 'skipped',
          skip_reason: 'Opportunity has not ended; closeout deferred.',
        },
      },
    };
    expect(assessQaDeepRun({ run_id: '20260828-0702', run_state: stoppedShort })).toEqual([]);
  });
});

describe('selectQaDeepRun — stage scoping', () => {
  it('--apps-only still rejects the fork (it is a fork, whatever it carries)', () => {
    const result = selectQaDeepRun(CANDIDATES, 'apps');
    if (!result.ok) throw new Error('expected ok');
    expect(result.run_id).toBe('20260828-0702');
  });

  it('--apps-only tolerates a run with no OCS chatbot', () => {
    const noOcs = {
      ...COMPLETE_20260828_0702,
      phases: {
        ...COMPLETE_20260828_0702.phases,
        'ocs-setup': { status: 'pending' },
      },
    };
    const cands = [{ run_id: '20260828-0702', run_state: noOcs }];
    expect(selectQaDeepRun(cands, 'apps').ok).toBe(true);
    expect(selectQaDeepRun(cands, 'ocs').ok).toBe(false);
    expect(selectQaDeepRun(cands, 'both').ok).toBe(false);
  });
});

describe('the typed refusal', () => {
  it('refuses rather than falling back when every candidate is disqualified', () => {
    const result = selectQaDeepRun([{ run_id: '20260901-1932', run_state: FORK_20260901_1932 }]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result).not.toHaveProperty('run_id');
    expect(result.refusal).toContain('20260901-1932');
    expect(result.refusal).toContain('[BLOCKER]');
    expect(result.refusal).toContain('forked_from: 20260828-0702');
    expect(result.refusal).toContain('ace#1950');
  });

  it('rejects an unreadable run_state rather than assuming it is fine', () => {
    const result = selectQaDeepRun([{ run_id: '20260905-0000', run_state: undefined }]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.rejected[0].reasons[0].code).toBe('unreadable');
  });

  it('refuses on an empty candidate list', () => {
    const result = selectQaDeepRun([]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.refusal).toContain('no run folders');
  });

  it('names the stage it refused for', () => {
    expect(formatQaDeepRefusal([], 'ocs')).toContain('(ocs)');
  });
});

describe('assertRunOwnsChatbot (Half B)', () => {
  it('accepts the chatbot the run actually built', () => {
    const r = assertRunOwnsChatbot(COMPLETE_20260828_0702, 13029);
    expect(r.ok).toBe(true);
  });

  it('accepts a string id for the same numeric experiment', () => {
    expect(assertRunOwnsChatbot(COMPLETE_20260828_0702, '13029').ok).toBe(true);
  });

  it('refuses the branch-2 failure: right bot, wrong run folder', () => {
    // The fork carries a COPIED `5-ocs/ocs-agent-setup.md` that resolves to
    // chatbot 13029 — the source run's bot. Grading it writes a deep verdict
    // into a run that never executed Phase 5.
    const r = assertRunOwnsChatbot(FORK_20260901_1932, 13029);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected refusal');
    expect(r.expected).toBeNull();
    expect(r.resolved).toBe('13029');
    expect(r.refusal).toContain('built no chatbot of its own');
  });

  it('refuses the branch-3 failure: the golden template as the silent default', () => {
    const GOLDEN = '11792';
    const r = assertRunOwnsChatbot(COMPLETE_20260828_0702, GOLDEN);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected refusal');
    expect(r.expected).toBe('13029');
    expect(r.resolved).toBe('11792');
    expect(r.refusal).toContain('ownership mismatch');
    expect(r.refusal).toContain('llo-launch');
  });

  it('refuses when nothing resolved at all, rather than proceeding', () => {
    const r = assertRunOwnsChatbot(COMPLETE_20260828_0702, null);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected refusal');
    expect(r.refusal).toContain('OCS_GOLDEN_TEMPLATE_ID');
  });
});

describe('the command doc and the skill declare the contract', () => {
  it('commands/qa-deep.md names selectQaDeepRun and forbids resolve_current_run_id', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const path = fileURLToPath(new URL('../../commands/qa-deep.md', import.meta.url));
    const doc = readFileSync(path, 'utf8');
    expect(doc).toContain('selectQaDeepRun');
    expect(doc).toContain('lib/qa-deep-run-selection');
    // The doc must say the naive atom is the wrong tool here, not merely omit it.
    expect(doc).toMatch(/resolve_current_run_id/);
    expect(doc).toContain('ace#1950');
  });

  it('skills/ocs-chatbot-qa asserts chatbot ownership before a graded suite', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const path = fileURLToPath(new URL('../../skills/ocs-chatbot-qa/SKILL.md', import.meta.url));
    const skill = readFileSync(path, 'utf8');
    expect(skill).toContain('assertRunOwnsChatbot');
    expect(skill).toContain('phases.ocs-setup.products.ocs_chatbot.experiment_id');
    expect(skill).toContain('ace#1950');
  });

  it('the golden template is no longer offered as an unqualified fallback', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const path = fileURLToPath(new URL('../../skills/ocs-chatbot-qa/SKILL.md', import.meta.url));
    const skill = readFileSync(path, 'utf8');
    // The bare pre-fix line. It must not survive verbatim in the resolution chain.
    expect(skill).not.toContain('- Otherwise, use `$OCS_GOLDEN_TEMPLATE_ID` from the env\n');
    // But the legitimate DIAGNOSTIC use in the trace-triage control must remain.
    expect(skill).toContain('Instead probe `$OCS_GOLDEN_TEMPLATE_ID` over this same widget');
  });
});
