/**
 * Why did a headless `/ace:run` stop? (dimagi-internal/ace — run supervision)
 *
 * ## The failure this exists to end
 *
 * The iterate loop spawns seeded runs as
 *
 *     claude -p "/ace:run <opp>/<run-id> …" --dangerously-skip-permissions \
 *       > iter1-run.log 2>&1
 *
 * and then observes them by polling Drive. When the process dies, the whole
 * forensic record is whatever landed in that log. Observed 2026-08-13 on
 * `bednet-check-2-visit/20260814-0357`: the process ran **41 minutes** and
 * exited with the single string `Execution error`. The loop could not say
 * whether it hit a usage limit, an MCP crash, a phase halt, or an OOM — so it
 * could not decide whether the iteration counted, and the operator's question
 * ("why are we doing a process that can run for 41 minutes and die and you
 * don't know what happened?") had no answer.
 *
 * Text on stdout is not a supervision channel. `claude -p` already offers two
 * facts the spawn above throws away:
 *
 *   --session-id <uuid>        pre-assign the transcript, so the supervisor
 *                              knows which .jsonl to read with no discovery
 *                              race (today the loop hunts for it by mtime)
 *   --output-format stream-json --verbose
 *                              one JSON event per line, including the final
 *                              `result` event carrying subtype + usage
 *
 * plus the exit code, which the redirect above discards entirely.
 *
 * ## Design
 *
 * Pure by design, exactly like `lib/env-freshness.ts` and
 * `lib/plugin-cache-freshness.ts`: the caller does the I/O (read the tail of
 * the stream, read stderr, collect the exit code) and this module decides.
 * That keeps every classification unit-testable without spawning a run — and
 * a supervisor you cannot test is the thing we already have.
 *
 * ## Why a typed reason rather than a message
 *
 * The iterate loop branches on this. `session_limit` must NOT count as a dirty
 * iteration — the run never got to fail, and recording it as a failure_class
 * pollutes the pass rate with an operator-account fact (three concurrent
 * jjackson sessions exhausted the limit simultaneously on 2026-08-13). A
 * `phase_halt` is a real verdict. `mcp_crash` is a restart, not a code fix.
 * Collapsing those into "it died" is what makes the health number unreadable.
 */

/** Terminal classification of a supervised headless run. */
export type RunExitReason =
  /** The run reached its own end and the CLI reported success. */
  | 'ok'
  /** Account usage/session limit reached mid-run. NOT a run failure. */
  | 'session_limit'
  /** An ACE phase deliberately halted (a real verdict the loop should judge). */
  | 'phase_halt'
  /** An MCP subprocess died or was bound to pruned code. Needs a restart. */
  | 'mcp_crash'
  /** The CLI reported an error result with no more specific signature. */
  | 'execution_error'
  /** Killed by a signal (operator kill, OOM, host sleep). */
  | 'killed'
  /** The supervisor's own wall-clock cap fired. */
  | 'timeout'
  /** Exited without a `result` event and without a recognised signature. */
  | 'unknown';

export interface RunExitInput {
  /** Process exit code; `null` when terminated by a signal. */
  exitCode: number | null;
  /** Signal name if terminated by one (e.g. `SIGKILL`). */
  signal?: string | null;
  /**
   * Parsed stream-json events, oldest → newest. The caller may pass only the
   * tail; classification never needs more than the final `result` event plus
   * any `system` events near it.
   */
  events?: unknown[];
  /** Captured stderr, if any. */
  stderr?: string;
  /** True iff the supervisor's own wall-clock cap fired. */
  timedOut?: boolean;
}

export interface RunExit {
  reason: RunExitReason;
  /** One line, safe to put straight into a `failure_class`. */
  detail: string;
  /** Session id from the stream, when the CLI reported one. */
  sessionId: string | null;
  /** Total cost in USD, when the final `result` event carried it. */
  totalCostUsd: number | null;
  /** Wall-clock ms as reported by the CLI, when present. */
  durationMs: number | null;
  /** Turn count as reported by the CLI, when present. */
  numTurns: number | null;
  /**
   * Whether this exit should count as an iteration for pass-rate purposes.
   * False for exits that say nothing about ACE's own quality.
   */
  countsAsIteration: boolean;
  exitCode: number | null;
}

/**
 * Signatures that mean "the account ran out", not "the run failed".
 *
 * Anchored on the two stable halves of the CLI's own wording — the phrasing
 * observed live is "You've hit your session limit · resets 2:10am
 * (America/Denver)". Matching the whole sentence would pin the timezone and
 * the reset time, so this matches only the invariant part.
 */
const LIMIT_PATTERNS: RegExp[] = [
  /hit your (session|usage) limit/i,
  /\brate[_ -]?limit(ed|_error)?\b/i,
  /\busage limit reached\b/i,
];

/**
 * An MCP subprocess died, or is executing from a pruned plugin-cache dir.
 * The second signature is `lib/plugin-cache-freshness.ts`'s failure as it
 * appears from OUTSIDE the session — see that module for why the symptom is a
 * missing `package.json` raised inside playwright-core.
 */
const MCP_CRASH_PATTERNS: RegExp[] = [
  /MCP server ".*" (crashed|exited|failed to start)/i,
  /Cannot find module '\.\/\.\.\/\.\.\/\.\.\/package\.json'/,
  /\bMCP error -32000\b/,
];

/** A phase stopped on purpose. This is a verdict, not a crash. */
const PHASE_HALT_PATTERNS: RegExp[] = [
  /\bstatus:\s*blocked\b/i,
  /\bhalt(ing|ed)? loud\b/i,
];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** The final `{"type":"result"}` event, if the stream produced one. */
export function findResultEvent(events: unknown[]): Record<string, unknown> | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (isRecord(e) && e.type === 'result') return e;
  }
  return null;
}

/** First session id the stream reports — `system`/`init` carries it. */
export function findSessionId(events: unknown[]): string | null {
  for (const e of events) {
    if (isRecord(e) && typeof e.session_id === 'string' && e.session_id) {
      return e.session_id;
    }
  }
  return null;
}

/**
 * Everything the classifier reads for signatures: the result event's own
 * error text plus stderr. Deliberately NOT the whole transcript — a run that
 * merely *discusses* a session limit (this review, for instance) must not be
 * classified as having hit one.
 */
function signatureText(result: Record<string, unknown> | null, stderr: string): string {
  const parts: string[] = [stderr];
  if (result) {
    for (const k of ['subtype', 'error', 'result', 'message'] as const) {
      const v = result[k];
      if (typeof v === 'string') parts.push(v);
    }
  }
  return parts.join('\n');
}

function matchAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Classify a finished headless run.
 *
 * Order matters: a usage limit and an MCP crash both surface as a non-zero
 * exit with an error result, so the specific signatures are tested before the
 * generic `execution_error` fallback. `timedOut` wins outright — the
 * supervisor killed it, so any signature below is a consequence, not a cause.
 */
export function classifyRunExit(input: RunExitInput): RunExit {
  const events = input.events ?? [];
  const stderr = input.stderr ?? '';
  const result = findResultEvent(events);
  const text = signatureText(result, stderr);

  const base = {
    sessionId: findSessionId(events),
    totalCostUsd: result ? num(result.total_cost_usd) : null,
    durationMs: result ? num(result.duration_ms) : null,
    numTurns: result ? num(result.num_turns) : null,
    exitCode: input.exitCode,
  };

  const decide = (
    reason: RunExitReason,
    detail: string,
    countsAsIteration: boolean,
  ): RunExit => ({ reason, detail, countsAsIteration, ...base });

  if (input.timedOut) {
    return decide('timeout', 'supervisor wall-clock cap fired', false);
  }

  // A limit can be reached on a run that otherwise looks clean, so this is
  // tested before the exit code — the CLI has been observed exiting 0 after
  // printing the limit notice.
  if (matchAny(text, LIMIT_PATTERNS)) {
    return decide(
      'session_limit',
      'account session/usage limit reached mid-run — not an ACE failure',
      false,
    );
  }

  if (matchAny(text, MCP_CRASH_PATTERNS)) {
    return decide(
      'mcp_crash',
      'an MCP subprocess died or is bound to pruned plugin-cache code — needs a full Claude restart',
      false,
    );
  }

  if (input.signal) {
    return decide('killed', `terminated by ${input.signal}`, false);
  }

  if (matchAny(text, PHASE_HALT_PATTERNS)) {
    return decide('phase_halt', 'a phase halted deliberately — judge the run verdicts', true);
  }

  if (input.exitCode === 0 && result && result.is_error !== true) {
    return decide('ok', 'run completed', true);
  }

  if (result && result.is_error === true) {
    const sub = typeof result.subtype === 'string' ? result.subtype : 'error';
    return decide('execution_error', `CLI reported an error result (${sub})`, true);
  }

  if (input.exitCode !== 0) {
    return decide(
      'unknown',
      `exit ${input.exitCode} with no result event — the stream ended early`,
      true,
    );
  }

  return decide('unknown', 'exit 0 with no result event', true);
}

/** Operator-facing one-liner for the supervisor's stdout and the loop's notes. */
export function formatRunExit(e: RunExit): string {
  const bits = [`reason=${e.reason}`, `exit=${e.exitCode ?? 'signal'}`];
  if (e.sessionId) bits.push(`session=${e.sessionId}`);
  if (e.durationMs !== null) bits.push(`${Math.round(e.durationMs / 1000)}s`);
  if (e.numTurns !== null) bits.push(`${e.numTurns} turns`);
  if (e.totalCostUsd !== null) bits.push(`$${e.totalCostUsd.toFixed(2)}`);
  bits.push(e.countsAsIteration ? 'counts-as-iteration' : 'does-not-count');
  return `${bits.join('  ')}\n  ${e.detail}`;
}
