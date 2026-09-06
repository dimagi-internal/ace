/**
 * upstream-products-gap.ts — dimagi-internal/ace#1888.
 *
 * ## The class
 *
 * A phase's `products` block is its TYPED HANDOFF: the keys downstream phases
 * dereference (`phases.connect-setup.products.connect.opportunity.connect_int_id`,
 * `phases.commcare-setup.products.apps`, …). A phase that ran wrote one as the
 * final step of the Phase Write-Back Contract. A phase that was COPIED into
 * existence — by ace-web's fork endpoint, or by any other seeding path — never
 * did, and nothing in ACE notices.
 *
 * Observed on `hh-poverty-targeting/20260901-1932`, a real fork of
 * `20260828-0702` at `synthetic-data-and-workflows`. Every upstream phase was
 * asserted `status: done, verdict: seeded`; three of them (`idea-to-design`,
 * `ocs-setup`, `qa-and-training`) carried NO `products` key at all. The source
 * run carries a non-empty `products` block on all eight of its terminal
 * schema-registered phases.
 *
 * ## Why the existing fences are blind to it
 *
 * - `verify_phase_artifacts` passes: the Drive files really were copied.
 * - `classify_phase_writeback` reads `ok`: it judges `{status, verdict,
 *   completed_at, steps}`, and those were all copied faithfully.
 * - `verify_phase_products` / {@link classifyPhaseProducts} reads **ok:true**
 *   on a wholly-absent block for any phase with no entry in
 *   `REQUIRED_PRODUCT_KEYS` — measured on the fork above: `idea-to-design`
 *   ok=true, `ocs-setup` ok=true, both with `products` absent. Required-key
 *   checking cannot see this class, because "no required keys declared" and
 *   "no handoff written at all" are the same answer to that question.
 * - And nothing calls ANY products fence over UPSTREAM phases at resume. The
 *   orchestrator's resume-path structural precondition check
 *   (`agents/ace-orchestrator.md § Run shape on resume`) checks Drive
 *   ARTIFACTS via `artifactsConsumedBy` — there is no `products` counterpart.
 *
 * So the run looks resumable and is not, and the first symptom is a skill
 * dereferencing a key that isn't there — which, depending on the skill, is a
 * confusing empty result rather than a clean halt.
 *
 * ## The invariant, observed rather than predicted
 *
 * > A phase with a registered products schema, at a terminal status, carries a
 * > non-empty `products` block.
 *
 * Measured on the non-forked source run `hh-poverty-targeting/20260828-0702`:
 * 8 of 8 terminal schema-registered phases satisfy it. The one `done` phase
 * with no products (`scenarios-and-acceptance`) has NO registered schema, so
 * it is exempt by construction rather than by exception.
 *
 * ## Scope — what this repo can and cannot fix
 *
 * The fork endpoint lives in the **ace-web** sibling repo
 * (`apps/opps/opp_forker.py`); carrying the `products` block across a fork is
 * an ace-web change and cannot be made from here. This module is the ACE-side
 * half the issue itself asks for: turn a silent gap into a legible one, at the
 * two moments ACE owns — right after `fork-run` returns, and at the
 * orchestrator's resume precondition check.
 */

import { PHASE_PRODUCTS_SCHEMAS, classifyPhaseProducts } from './phase-products-schema.js';

/**
 * Statuses that mean "this phase is finished and its handoff is owed".
 *
 * Deliberately the same literal set as `TERMINAL_OK_STATUSES` in
 * `lib/run-state-validator.ts` and the `isTerminal` test in
 * {@link classifyPhaseProducts}. ace#992 is the record of what happens when
 * three fences disagree about which strings mean "finished": one run got
 * `ok:true` from two of them and `malformed` from the third on the same
 * literal. `test/lib/upstream-products-gap.test.ts` pins the agreement.
 */
const TERMINAL_STATUSES = new Set(['done', 'complete', 'partial']);

export type UpstreamProductsGapKind =
  /** The phase reached a terminal status with no `products` block at all. */
  | 'products-absent'
  /** A `products` block is present but is missing declared required keys. */
  | 'required-keys-missing';

export interface UpstreamProductsGap {
  phase: string;
  /** The phase's `status` as recorded in run_state. */
  status: string;
  /** The phase's `verdict`, when present — `seeded` is the fork's fingerprint. */
  verdict?: string;
  kind: UpstreamProductsGapKind;
  /**
   * Dot-paths under `products` that are missing. Empty for `products-absent`:
   * nothing was written, so there is no per-key story to tell.
   */
  missing: string[];
  /** One operator-readable line naming the phase and what it owes. */
  message: string;
}

export interface UpstreamProductsGapReport {
  /** No gaps at all. */
  ok: boolean;
  /**
   * There is at least one gap AND at least one `pending` phase left to
   * dispatch — i.e. a resume is about to run a phase whose upstream typed
   * handoff is not there. This is the halt condition; `ok:false` on a run with
   * nothing left to dispatch is a historical observation, not a blocker.
   */
  blocking: boolean;
  /** Phases with `status: pending`, in the order run_state declares them. */
  pendingPhases: string[];
  gaps: UpstreamProductsGap[];
}

function isNonEmptyObject(v: unknown): boolean {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    Object.keys(v as Record<string, unknown>).length > 0
  );
}

/**
 * Audit every terminal phase's typed handoff in a PARSED `run_state.yaml`.
 *
 * Order-free by construction: it never needs to know which phase precedes
 * which, only which are finished and whether anything is left to dispatch. So
 * it cannot be wrong about a run whose phase keys are ordered unusually, and
 * it needs no second copy of the phase sequence to drift against.
 *
 * Phases with no entry in `PHASE_PRODUCTS_SCHEMAS` (e.g.
 * `scenarios-and-acceptance`) are exempt — they are not expected to write a
 * typed handoff, and the source-run measurement above confirms they do not.
 */
export function classifyUpstreamProductsGaps(parsed: unknown): UpstreamProductsGapReport {
  const phases = (parsed as any)?.phases;
  const gaps: UpstreamProductsGap[] = [];
  const pendingPhases: string[] = [];

  if (typeof phases !== 'object' || phases === null || Array.isArray(phases)) {
    return { ok: true, blocking: false, pendingPhases, gaps };
  }

  for (const [phase, blockRaw] of Object.entries(phases as Record<string, unknown>)) {
    const block = (typeof blockRaw === 'object' && blockRaw !== null ? blockRaw : {}) as any;
    const status = typeof block.status === 'string' ? block.status : undefined;
    if (status === 'pending') pendingPhases.push(phase);
    if (status === undefined || !TERMINAL_STATUSES.has(status)) continue;
    // A phase with no registered schema owes no typed handoff.
    if (!(phase in PHASE_PRODUCTS_SCHEMAS)) continue;

    const verdict = typeof block.verdict === 'string' ? block.verdict : undefined;

    if (!isNonEmptyObject(block.products)) {
      gaps.push({
        phase,
        status,
        verdict,
        kind: 'products-absent',
        missing: [],
        message:
          `phase \`${phase}\` is \`status: ${status}\`` +
          (verdict ? `, \`verdict: ${verdict}\`` : '') +
          ' but carries no `products` block — its typed handoff was never written.',
      });
      continue;
    }

    // A block IS present: defer entirely to the existing required-key fence so
    // there is exactly one implementation of that rule.
    const c = classifyPhaseProducts(parsed, phase);
    if (!c.ok && c.issues.length > 0) {
      const missing = c.issues.map((i) => i.path);
      gaps.push({
        phase,
        status,
        verdict,
        kind: 'required-keys-missing',
        missing,
        message:
          `phase \`${phase}\` is \`status: ${status}\`` +
          (verdict ? `, \`verdict: ${verdict}\`` : '') +
          ` but its \`products\` block is missing: ${missing.join(', ')}.`,
      });
    }
  }

  return {
    ok: gaps.length === 0,
    blocking: gaps.length > 0 && pendingPhases.length > 0,
    pendingPhases,
    gaps,
  };
}

/**
 * Render a report as the operator-facing halt/warn text. Returns '' when there
 * is nothing to say, so a caller can `if (text) print(text)`.
 */
export function formatUpstreamProductsGapReport(
  report: UpstreamProductsGapReport,
  opts: { runLabel?: string } = {},
): string {
  if (report.ok) return '';
  const label = opts.runLabel ? ` ${opts.runLabel}` : '';
  const head = report.blocking
    ? `HALT: run${label} cannot be resumed — ${report.gaps.length} upstream phase(s) assert completion without a typed handoff.`
    : `WARN: run${label} has ${report.gaps.length} upstream phase(s) asserting completion without a typed handoff (nothing left to dispatch).`;
  const lines = report.gaps.map((g) => `  - ${g.message}`);
  const tail = report.blocking
    ? [
        '',
        `  Still pending: ${report.pendingPhases.join(', ')}.`,
        '  A forked or seeded run copies phase STATUSES; ace-web does not copy',
        '  `products` (ace#1888). Seed the missing block(s) verbatim from the',
        '  source run, or re-run the phase — do not re-derive them by hand.',
      ]
    : [];
  return [head, ...lines, ...tail].join('\n');
}
