//
// Choose WHICH run `/ace:qa-deep` grades.
//
// `commands/qa-deep.md` reads five paths shaped `runs/<run-id>/...` and never
// says how `<run-id>` is chosen. The obvious atom, `resolve_current_run_id`,
// returns the lexicographically-largest folder under `<opp>/runs/` — by its own
// docstring, "run-ids are `YYYYMMDD-HHMM`, so lex order matches chronological
// order." That is a correct answer to a different question: it finds the newest
// FOLDER, and a folder is not a run.
//
// Measured on `hh-poverty-targeting`, 2026-09-05:
//
//     resolve_current_run_id('hh-poverty-targeting') -> 20260901-1932
//
// which is a deliberate Phase-7-only validation fork. Its `run_state.yaml`
// carries `forked_from: 20260828-0702`, six phases at `verdict: seeded` sharing
// one fork-timestamp `completed_at` (nothing executed), phases 8/9/10 at
// `status: skipped` with `skip_reason: "Validation fork -- Phase 7 only."`, and
// an `ocs-setup` block with NO `products` at all.
//
// Why that is worse than a failed lookup. Stage B reads
// `3-commcare/app-test-cases.yaml` and `commcare-setup.products.apps`, both of
// which the fork DOES carry (hand-seeded because Phase 7 needed them). So the
// apps half runs to completion against a fork and writes
// `app-ux-eval_verdict-deep.yaml` into the fork's folder. Phase 9 `llo-launch`
// then reads that verdict as its go-live gate, and nothing downstream can tell
// that the evidence describes a run which never executed Phase 6 and explicitly
// skipped Phase 8. The gate does not fail — it PASSES on the wrong evidence.
//
// (Adjacent to ace#1888, which explains why a fork is under-populated. Fixing
// that would make this defect strictly worse, not better: a more completely
// populated fork is a more convincing wrong answer.)
//
// ── The safety property that shapes this module ─────────────────────────────
//
// There is no silent fallback. When no candidate qualifies, this returns a
// TYPED REFUSAL naming every rejected run and why — never "closest match", never
// the newest folder anyway. A deep verdict is pre-go-live clearance; producing
// one against an unknown run is the failure mode, so refusing to produce one is
// the correct terminal state. The operator can always pin a run by hand.
//
// ace#1950.
//

/** Which halves of `/ace:qa-deep` are going to run. `--ocs-only` / `--apps-only`. */
export type QaDeepStage = 'ocs' | 'apps' | 'both';

/** Why a candidate run was rejected. */
export type QaDeepRejectionCode =
  /** `run_state.yaml` carries `forked_from` — this is a fork, not a run. */
  | 'fork'
  /** One or more phases are `verdict: seeded` — hand-seeded, never executed. */
  | 'seeded-phases'
  /** A phase is `status: skipped` with a fork-shaped `skip_reason`. */
  | 'fork-skipped-phases'
  /** A phase the requested stage depends on did not reach `status: done`. */
  | 'phase-not-done'
  /** The phase ran but the product the stage grades against is absent. */
  | 'missing-products'
  /** `run_state.yaml` was absent or unparseable for this run folder. */
  | 'unreadable';

export interface QaDeepRejection {
  code: QaDeepRejectionCode;
  /** Human-readable specifics — which phases, which missing key. */
  detail: string;
}

/** One run folder under `<opp>/runs/`, with its parsed `run_state.yaml`. */
export interface QaDeepRunCandidate {
  run_id: string;
  /**
   * The parsed `run_state.yaml` for this run, or `null`/`undefined` when the
   * file was missing or failed to parse (rejected as `unreadable`).
   */
  run_state?: unknown;
}

export interface QaDeepRunRejectionReport {
  run_id: string;
  reasons: QaDeepRejection[];
}

export type SelectQaDeepRunResult =
  | {
      ok: true;
      run_id: string;
      /** Newer candidates that were considered and rejected, newest first. */
      rejected: QaDeepRunRejectionReport[];
    }
  | {
      ok: false;
      /** A ready-to-print refusal naming every rejected candidate. */
      refusal: string;
      rejected: QaDeepRunRejectionReport[];
    };

/**
 * Phases each stage depends on, and the `products` path it must be able to read.
 * Stage A (OCS) grades the chatbot the run built; Stage B (apps) grades the apps
 * the run built. Both read Phase 2's ground truth.
 */
const STAGE_REQUIREMENTS: Record<
  Exclude<QaDeepStage, 'both'>,
  { phase: string; productPath: string[] | null; why: string }[]
> = {
  ocs: [
    {
      phase: 'scenarios-and-acceptance',
      productPath: null,
      why: '2-scenarios/pdd-to-test-prompts.md is the OCS deep ground truth',
    },
    {
      phase: 'ocs-setup',
      productPath: ['ocs_chatbot', 'experiment_id'],
      why: 'the deep suite must talk to the chatbot THIS run built',
    },
  ],
  apps: [
    {
      phase: 'scenarios-and-acceptance',
      productPath: null,
      why: '2-scenarios/pdd-to-app-journeys.md is the app deep ground truth',
    },
    {
      phase: 'commcare-setup',
      productPath: ['apps'],
      why: 'the deep journeys run against the apps THIS run built',
    },
  ],
};

function requirementsFor(stage: QaDeepStage) {
  if (stage === 'both') return [...STAGE_REQUIREMENTS.ocs, ...STAGE_REQUIREMENTS.apps];
  return STAGE_REQUIREMENTS[stage];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function dig(root: unknown, path: string[]): unknown {
  let cur: unknown = root;
  for (const seg of path) {
    if (!isRecord(cur)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/**
 * A `skip_reason` that says the phase was skipped because this is a fork, rather
 * than because the run legitimately stopped short. Deliberately narrow: a run
 * that halted at the Phase 8→9 boundary is a perfectly good qa-deep target.
 */
const FORK_SKIP_REASON = /\bfork(ed|ing)?\b/i;

/**
 * Judge ONE candidate. Exported so a caller can explain a specific run without
 * re-running the whole selection.
 */
export function assessQaDeepRun(
  candidate: QaDeepRunCandidate,
  stage: QaDeepStage = 'both',
): QaDeepRejection[] {
  const reasons: QaDeepRejection[] = [];
  const state = candidate.run_state;

  if (!isRecord(state)) {
    return [{ code: 'unreadable', detail: 'run_state.yaml is missing or not a mapping' }];
  }

  if (state.forked_from !== undefined && state.forked_from !== null) {
    const from = String(state.forked_from);
    const at = state.forked_from_phase ? ` at phase ${String(state.forked_from_phase)}` : '';
    reasons.push({
      code: 'fork',
      detail: `forked_from: ${from}${at} — a fork inherits artifacts it did not produce`,
    });
  }

  const phases = isRecord(state.phases) ? state.phases : {};

  const seeded: string[] = [];
  const forkSkipped: string[] = [];
  for (const [name, blockRaw] of Object.entries(phases)) {
    if (!isRecord(blockRaw)) continue;
    if (blockRaw.verdict === 'seeded') seeded.push(name);
    if (
      blockRaw.status === 'skipped' &&
      typeof blockRaw.skip_reason === 'string' &&
      FORK_SKIP_REASON.test(blockRaw.skip_reason)
    ) {
      forkSkipped.push(name);
    }
  }
  if (seeded.length > 0) {
    reasons.push({
      code: 'seeded-phases',
      detail: `verdict: seeded on ${seeded.join(', ')} — hand-seeded products, nothing executed`,
    });
  }
  if (forkSkipped.length > 0) {
    reasons.push({
      code: 'fork-skipped-phases',
      detail: `status: skipped with a fork skip_reason on ${forkSkipped.join(', ')}`,
    });
  }

  for (const req of requirementsFor(stage)) {
    const block = phases[req.phase];
    if (!isRecord(block) || block.status !== 'done') {
      const got = isRecord(block) ? String(block.status ?? 'absent') : 'absent';
      reasons.push({
        code: 'phase-not-done',
        detail: `phases.${req.phase}.status is ${got}, need done — ${req.why}`,
      });
      continue;
    }
    if (req.productPath) {
      const value = dig(block.products, req.productPath);
      if (value === undefined || value === null || value === '') {
        reasons.push({
          code: 'missing-products',
          detail: `phases.${req.phase}.products.${req.productPath.join('.')} is absent — ${req.why}`,
        });
      }
    }
  }

  // De-duplicate: `scenarios-and-acceptance` appears in both stages' requirements.
  const seen = new Set<string>();
  return reasons.filter((r) => {
    const key = `${r.code}::${r.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Pick the newest COMPLETE run for a `/ace:qa-deep` invocation.
 *
 * Candidates are considered newest-first by run-id (`YYYYMMDD-HHMM`, so string
 * order is chronological order). The first one with no rejection reasons wins.
 * If none qualifies, the result is a typed refusal listing every candidate and
 * why it was rejected — there is deliberately no fallback to "newest anyway".
 */
export function selectQaDeepRun(
  candidates: QaDeepRunCandidate[],
  stage: QaDeepStage = 'both',
): SelectQaDeepRunResult {
  const ordered = [...candidates].sort((a, b) =>
    a.run_id < b.run_id ? 1 : a.run_id > b.run_id ? -1 : 0,
  );
  const rejected: QaDeepRunRejectionReport[] = [];

  for (const candidate of ordered) {
    const reasons = assessQaDeepRun(candidate, stage);
    if (reasons.length === 0) {
      return { ok: true, run_id: candidate.run_id, rejected };
    }
    rejected.push({ run_id: candidate.run_id, reasons });
  }

  return { ok: false, refusal: formatQaDeepRefusal(rejected, stage), rejected };
}

/** Render a refusal the operator can act on without opening Drive. */
export function formatQaDeepRefusal(
  rejected: QaDeepRunRejectionReport[],
  stage: QaDeepStage = 'both',
): string {
  const lines: string[] = [];
  lines.push(
    `[BLOCKER] /ace:qa-deep (${stage}) found no run it can grade. ` +
      `A deep verdict is pre-go-live clearance; it will not be produced against ` +
      `a run that did not execute the phases it grades.`,
  );
  if (rejected.length === 0) {
    lines.push('  (no run folders under <opp>/runs/ at all)');
  }
  for (const report of rejected) {
    lines.push(`  ${report.run_id}:`);
    for (const reason of report.reasons) {
      lines.push(`    - [${reason.code}] ${reason.detail}`);
    }
  }
  lines.push(
    'Pin a run explicitly if you know one is good; do NOT fall back to ' +
      '`resolve_current_run_id`, which returns the newest FOLDER and cannot ' +
      'tell a run from a fork (ace#1950).',
  );
  return lines.join('\n');
}

//
// ── Half B: the bot being graded must be the bot the run built ──────────────
//
// Run selection alone does not close this. `skills/ocs-chatbot-qa` § Process
// step 1 resolves the target bot through a three-branch fallback chain —
// `experiment_id`, else the run folder's `5-ocs/ocs-agent-setup.md`, else
// `$OCS_GOLDEN_TEMPLATE_ID` — and NO branch asserts the bot belongs to the run
// being graded. Observed on the 20260901-1932 fork: branch 2 fires on a COPIED
// `ocs-agent-setup.md`, grading the right chatbot into the wrong run folder with
// no warning; and with no readable copy, branch 3 grades the pristine golden
// template and reports its score as the opportunity's. Either way `llo-launch`
// reads it as clearance.
//
// The golden-template probe stays where it is legitimately a DIAGNOSTIC (the
// trace-triage control in step 5 — "target fails, golden passes" is real signal).
// What it must never be is the silent default for a GRADED suite.
//

export type ChatbotOwnershipResult =
  | { ok: true; experiment_id: string }
  | { ok: false; refusal: string; expected: string | null; resolved: string | null };

/**
 * Assert that the chatbot a graded suite resolved is the one this run built.
 *
 * `expected` comes from `phases.ocs-setup.products.ocs_chatbot.experiment_id` in
 * the run being graded. A missing `expected` is itself a refusal: it means the
 * run has no chatbot of its own, so ANY bot the resolver found belongs to some
 * other run (or is the golden template).
 */
export function assertRunOwnsChatbot(
  runState: unknown,
  resolvedExperimentId: string | number | null | undefined,
): ChatbotOwnershipResult {
  const expectedRaw = dig(runState, [
    'phases',
    'ocs-setup',
    'products',
    'ocs_chatbot',
    'experiment_id',
  ]);
  const expected =
    expectedRaw === undefined || expectedRaw === null || expectedRaw === ''
      ? null
      : String(expectedRaw);
  const resolved =
    resolvedExperimentId === undefined ||
    resolvedExperimentId === null ||
    resolvedExperimentId === ''
      ? null
      : String(resolvedExperimentId);

  if (expected === null) {
    return {
      ok: false,
      expected: null,
      resolved,
      refusal:
        '[BLOCKER] This run has no `phases.ocs-setup.products.ocs_chatbot.experiment_id`, ' +
        'so it built no chatbot of its own. Refusing to run a GRADED OCS suite: ' +
        `whatever bot was resolved (${resolved ?? 'none'}) belongs to another run or is the ` +
        'golden template, and its verdict would be read by `llo-launch` as clearance ' +
        'for this one (ace#1950).',
    };
  }
  if (resolved === null) {
    return {
      ok: false,
      expected,
      resolved: null,
      refusal:
        `[BLOCKER] Could not resolve a chatbot to grade, but this run built ${expected}. ` +
        'Refusing to fall back to `$OCS_GOLDEN_TEMPLATE_ID` for a graded suite (ace#1950).',
    };
  }
  if (resolved !== expected) {
    return {
      ok: false,
      expected,
      resolved,
      refusal:
        `[BLOCKER] Chatbot ownership mismatch: resolved experiment ${resolved}, but this run's ` +
        `\`phases.ocs-setup.products.ocs_chatbot.experiment_id\` is ${expected}. ` +
        "A deep verdict describing a different run's bot (or the golden template) is read by " +
        '`llo-launch` as go-live clearance for THIS run (ace#1950). Pin the right run, or ' +
        're-run Phase 5 for this one.',
    };
  }
  return { ok: true, experiment_id: expected };
}
