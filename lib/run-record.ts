/**
 * The run-level record a cross-run view needs: how a run ENDED, what it
 * DESCENDS from, and what BLOCKED it — in typed fields rather than prose.
 *
 * ## Why these exist
 *
 * Measured across 22 runs of `spark-facilitator` + `hh-poverty-targeting`:
 *
 * - **Outcome: 1 of 22.** Nothing recorded why a run stopped. The reason is
 *   structural, not sloppiness: a run that dies mid-phase never executes
 *   again, so it cannot write its own epitaph. Abandonment is the MAJORITY
 *   path, not an edge case — so `outcome` is written by the run that
 *   REPLACES a dead one, and falls back to read-time inference. Nothing here
 *   ever depends on a graceful exit.
 * - **Lineage: 2 of 22 typed**, though 8 runs described a supersession in
 *   prose. `hh-poverty/20260728-0705` opens a note with "WHY A FRESH RUN,
 *   NOT A RESUME OF 20260727-1406:" and then explains it correctly — a
 *   perfect `lineage.reason`, stored as the 21st line of a string array.
 * - **Blockers: spread across 12 different key names** — `blocker`,
 *   `blockers`, `halt_reason`, `halt_class`, `blocked_at`, `session_halt`,
 *   `blocker_class`, `blocker_detail`, `blocker_history`, `resume_from`,
 *   `halted_at`, `run_halted_at`. Twelve spellings is zero queryability.
 *
 * ## The freshness rule (the expensive one)
 *
 * `run_state.yaml` is a JOURNAL: every line was true when written and
 * promises nothing about now. Of 176 GitHub issues cited across those 22
 * runs, **166 (98%) are already closed**. A view that renders a journal
 * claim as current state is wrong on nearly every load — which is why a
 * blocker carries a resolvable `ref` and an `as_of`, and consumers are
 * expected to resolve the ref rather than trust the text. The journal then
 * never needs pruning, and a stale claim becomes structurally unable to
 * present itself as a live to-do.
 */

/** How a run ended. */
export const RUN_OUTCOME_STATES = [
  /** Reached its intended terminal phase. */
  'shipped',
  /** A later run replaced it; see `lineage`. */
  'superseded',
  /** Stopped and nothing replaced it. The default for a killed session. */
  'abandoned',
  /** Stopped deliberately at a gate or on a blocker it recorded. */
  'halted',
] as const;
export type RunOutcomeState = (typeof RUN_OUTCOME_STATES)[number];

/**
 * Who established the outcome. A dead run cannot classify itself, so this
 * says whether a human/successor asserted it or a reader inferred it.
 */
export const OUTCOME_DETERMINERS = ['next-run', 'operator', 'inferred'] as const;
export type OutcomeDeterminer = (typeof OUTCOME_DETERMINERS)[number];

/**
 * Why a run stopped, as a closed set. Deliberately coarse: the value of an
 * enum here is being able to ask "how many runs died on tooling this month",
 * and a 20-value vocabulary answers that worse than a 6-value one.
 */
export const BLOCKER_CLASSES = [
  /** Upstream auth/session expiry — Nova, HQ, Connect, OCS. */
  'upstream-auth',
  /** A tool, MCP binding, harness or environment failure. */
  'tooling',
  /** A defect in what the run built. */
  'build-defect',
  /** Waiting on a decision only a human can make. */
  'design-decision',
  /** Waiting on a person or partner outside the run. */
  'awaiting-human',
  /** The operator redirected the work elsewhere. */
  'operator-redirect',
] as const;
export type BlockerClass = (typeof BLOCKER_CLASSES)[number];

export const BLOCKER_STATES = ['open', 'cleared', 'overturned'] as const;
export type BlockerState = (typeof BLOCKER_STATES)[number];

/** Reference schemes a consumer knows how to resolve live. */
export const REF_SCHEMES = ['github', 'drive', 'gmail', 'run'] as const;

export interface RunOutcome {
  state: RunOutcomeState;
  determined_by: OutcomeDeterminer;
  /** `<phase>/<step>` the run stopped at, when known. */
  stopped_at?: string;
  cause_class?: BlockerClass;
  cause?: string;
  /** Run id that established this outcome (when `determined_by: next-run`). */
  closed_by?: string;
}

export interface RunLineage {
  /** Run id this one replaces. */
  supersedes?: string;
  /** Run id this one forked from, when it inherited upstream phases. */
  forked_from?: string;
  /** Phase the fork was taken at. */
  forked_at_phase?: string;
  /** WHY a fresh run rather than a resume. The field prose keeps trying to be. */
  reason?: string;
}

export interface RunBlocker {
  class: BlockerClass;
  /** `<phase>/<step>` where it bit. */
  at?: string;
  detail?: string;
  /**
   * A resolvable pointer — `github:owner/repo#123`, `drive:<fileId>`,
   * `gmail:<threadId>`, `run:<runId>`. Consumers resolve it live rather than
   * trusting the text; see the freshness rule above.
   */
  ref?: string;
  /** When the claim was true. Required whenever `ref` is set. */
  as_of?: string;
  state: BlockerState;
}

export interface ParseResult<T> {
  ok: boolean;
  value?: T;
  issues: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ].*)?$/;

/** `<scheme>:<rest>` where scheme is known and rest is non-empty. */
export function parseRef(raw: string): { scheme: string; id: string } | null {
  const i = raw.indexOf(':');
  if (i <= 0 || i === raw.length - 1) return null;
  const scheme = raw.slice(0, i);
  if (!(REF_SCHEMES as readonly string[]).includes(scheme)) return null;
  return { scheme, id: raw.slice(i + 1) };
}

/** Absence is valid — most runs predate these fields. Presence is validated. */
export function parseOutcome(raw: unknown): ParseResult<RunOutcome> {
  if (raw === undefined || raw === null) return { ok: true, issues: [] };
  if (!isObj(raw)) return { ok: false, issues: ['outcome must be a mapping when present'] };
  const issues: string[] = [];
  if (!(RUN_OUTCOME_STATES as readonly unknown[]).includes(raw.state)) {
    issues.push(
      `outcome.state must be one of ${RUN_OUTCOME_STATES.join(' | ')} (got ${String(raw.state)})`,
    );
  }
  if (!(OUTCOME_DETERMINERS as readonly unknown[]).includes(raw.determined_by)) {
    issues.push(
      `outcome.determined_by must be one of ${OUTCOME_DETERMINERS.join(' | ')} — a dead run cannot ` +
        `classify itself, so a reader must be able to tell an asserted outcome from an inferred one ` +
        `(got ${String(raw.determined_by)})`,
    );
  }
  if (raw.cause_class !== undefined && !(BLOCKER_CLASSES as readonly unknown[]).includes(raw.cause_class)) {
    issues.push(`outcome.cause_class must be one of ${BLOCKER_CLASSES.join(' | ')}`);
  }
  if (raw.determined_by === 'next-run' && !raw.closed_by) {
    issues.push(
      'outcome.closed_by is required when determined_by is `next-run` — the successor run id is the ' +
        'evidence for the claim',
    );
  }
  for (const k of ['stopped_at', 'cause', 'closed_by']) {
    if (raw[k] !== undefined && typeof raw[k] !== 'string') issues.push(`outcome.${k} must be a string`);
  }
  return issues.length ? { ok: false, issues } : { ok: true, value: raw as unknown as RunOutcome, issues: [] };
}

export function parseLineage(raw: unknown): ParseResult<RunLineage> {
  if (raw === undefined || raw === null) return { ok: true, issues: [] };
  if (!isObj(raw)) return { ok: false, issues: ['lineage must be a mapping when present'] };
  const issues: string[] = [];
  for (const k of ['supersedes', 'forked_from', 'forked_at_phase', 'reason']) {
    if (raw[k] !== undefined && typeof raw[k] !== 'string') issues.push(`lineage.${k} must be a string`);
  }
  if (raw.supersedes === undefined && raw.forked_from === undefined) {
    issues.push('lineage must name at least one of `supersedes` or `forked_from`');
  }
  if (raw.forked_at_phase !== undefined && raw.forked_from === undefined) {
    issues.push('lineage.forked_at_phase is only meaningful with `forked_from`');
  }
  return issues.length ? { ok: false, issues } : { ok: true, value: raw as unknown as RunLineage, issues: [] };
}

export function parseBlockers(raw: unknown): ParseResult<RunBlocker[]> {
  if (raw === undefined || raw === null) return { ok: true, issues: [] };
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      issues: [
        'blockers must be a LIST of typed entries. The twelve legacy spellings (`blocker`, ' +
          '`halt_reason`, `halt_class`, `blocked_at`, `session_halt`, ...) are superseded by this one key.',
      ],
    };
  }
  const issues: string[] = [];
  raw.forEach((b, i) => {
    if (!isObj(b)) {
      issues.push(`blockers[${i}] must be a mapping`);
      return;
    }
    if (!(BLOCKER_CLASSES as readonly unknown[]).includes(b.class)) {
      issues.push(`blockers[${i}].class must be one of ${BLOCKER_CLASSES.join(' | ')} (got ${String(b.class)})`);
    }
    if (!(BLOCKER_STATES as readonly unknown[]).includes(b.state)) {
      issues.push(`blockers[${i}].state must be one of ${BLOCKER_STATES.join(' | ')} (got ${String(b.state)})`);
    }
    if (b.ref !== undefined) {
      if (typeof b.ref !== 'string' || parseRef(b.ref) === null) {
        issues.push(
          `blockers[${i}].ref must be \`<scheme>:<id>\` with scheme one of ${REF_SCHEMES.join(' | ')} ` +
            `(e.g. github:dimagi-internal/ace#1624) — an unresolvable pointer is why 98% of cited ` +
            `issues read as live when they are closed`,
        );
      }
      if (b.as_of === undefined) {
        issues.push(
          `blockers[${i}].as_of is required whenever \`ref\` is set — the ref says WHAT was claimed, ` +
            `as_of says WHEN it was true, and a claim without a date cannot be aged out`,
        );
      }
    }
    if (b.as_of !== undefined && (typeof b.as_of !== 'string' || !ISO_DATE.test(b.as_of))) {
      issues.push(`blockers[${i}].as_of must be an ISO date or timestamp`);
    }
    for (const k of ['at', 'detail']) {
      if (b[k] !== undefined && typeof b[k] !== 'string') issues.push(`blockers[${i}].${k} must be a string`);
    }
  });
  return issues.length ? { ok: false, issues } : { ok: true, value: raw as unknown as RunBlocker[], issues: [] };
}

/**
 * Read-time outcome inference for a run that never got one written.
 *
 * This is the half that needs no cooperation from the dead session, and it is
 * why abandonment is safe to design for: the furthest recorded phase is
 * always readable, whatever happened to the process.
 */
export function inferOutcome(args: {
  /** Phase statuses in authored order. */
  phaseStates: { ordinal: number; name: string; status: string }[];
  /** Run id that supersedes this one, if a later run claimed it. */
  supersededBy?: string;
  /** Any blockers the run recorded before stopping. */
  blockers?: RunBlocker[];
  /** Days since the run last wrote anything. */
  idleDays: number;
  /** Phase count that counts as "reached the end". */
  terminalPhase: number;
}): RunOutcome {
  const done = args.phaseStates.filter((p) => !['pending', ''].includes(p.status));
  const furthest = done.length ? Math.max(...done.map((p) => p.ordinal)) : 0;
  const last = args.phaseStates.find((p) => p.ordinal === furthest);
  const stopped_at = last ? last.name : undefined;

  if (args.supersededBy) {
    return {
      state: 'superseded',
      determined_by: 'next-run',
      closed_by: args.supersededBy,
      stopped_at,
    };
  }
  if (furthest >= args.terminalPhase) {
    return { state: 'shipped', determined_by: 'inferred', stopped_at };
  }
  const open = (args.blockers ?? []).filter((b) => b.state === 'open');
  if (open.length > 0) {
    return {
      state: 'halted',
      determined_by: 'inferred',
      stopped_at,
      cause_class: open[0].class,
      cause: open[0].detail,
    };
  }
  // Stopped short, nothing recorded, nothing replaced it, and it has gone
  // quiet. That is abandonment — the normal case, named rather than guessed at.
  if (args.idleDays > 7) {
    return { state: 'abandoned', determined_by: 'inferred', stopped_at };
  }
  return { state: 'halted', determined_by: 'inferred', stopped_at };
}
