/**
 * Surface a run's out-of-band `operator_stop_after_phase` directive in the
 * boundary-fence atoms' own results (dimagi-internal/ace#3330).
 *
 * The directive is armed by writing a top-level block to `run_state.yaml`
 * (`agents/ace-orchestrator.md § Ad-hoc stop-after-phase instructions`). The
 * fence used to check it only inside the all-OK branch of Turn N+2, so a
 * repair branch that re-ran ONE check (`verify_phase_products` after patching
 * a value) reached `Agent(<next-phase>)` without ever looking at it —
 * smallholder-seasonal/20261028-1636 then ran Phases 4 and 5 past a pending
 * stop on Phase 3 and minted a create-time-only Connect opportunity.
 *
 * `classify_phase_writeback` and `verify_phase_products` already load
 * run_state.yaml, so they return the directive whenever it exists. Any fence
 * call — including the one a repair branch re-runs — then puts the stop in
 * front of the model. `fires_now` is the whole decision: the orchestrator
 * must not dispatch the next phase while it is true.
 */

export interface OperatorStopSurface {
  /** The `phases.<phase>` key the stop names. */
  phase: string | null;
  /** `pending` until it fires, then `fired`. Anything else is passed through verbatim. */
  status: string | null;
  /** True iff `status: pending` AND `phase` is the phase this fence call checked. */
  fires_now: boolean;
  /** What to do, in one line — so the model does not have to remember it. */
  note: string;
}

/**
 * Read `operator_stop_after_phase` from a parsed run_state and describe it
 * relative to `checkedPhase`. Returns `undefined` when the block is absent
 * (the default — the fence result then carries no `operator_stop` key at all).
 */
export function operatorStopFor(
  runState: unknown,
  checkedPhase: string,
): OperatorStopSurface | undefined {
  if (!runState || typeof runState !== 'object') return undefined;
  const block = (runState as Record<string, unknown>).operator_stop_after_phase;
  if (block === undefined || block === null) return undefined;
  const b = (typeof block === 'object' ? block : {}) as Record<string, unknown>;
  const phase = typeof b.phase === 'string' && b.phase.trim() ? b.phase.trim() : null;
  const status = typeof b.status === 'string' && b.status.trim() ? b.status.trim() : null;
  const fires_now = status === 'pending' && phase !== null && phase === checkedPhase;
  let note: string;
  if (fires_now) {
    note =
      `STOP: operator_stop_after_phase is pending on ${phase}. Do NOT dispatch the next phase on any branch ` +
      `(repair branches included); patch status to fired and report the stop.`;
  } else if (status === 'pending') {
    note = `operator_stop_after_phase is pending on ${phase ?? '<unnamed phase>'}, not ${checkedPhase}; it fires at that phase's boundary.`;
  } else {
    note = `operator_stop_after_phase is ${status ?? '<no status>'}; nothing to do.`;
  }
  return { phase, status, fires_now, note };
}

/** Spread helper: `{...withOperatorStop(parsed, phase)}` adds the key only when the block exists. */
export function withOperatorStop(
  runState: unknown,
  checkedPhase: string,
): { operator_stop?: OperatorStopSurface } {
  const s = operatorStopFor(runState, checkedPhase);
  return s ? { operator_stop: s } : {};
}
