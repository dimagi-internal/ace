/**
 * Proving that the INTERACTIVE dashboard's page can actually load
 * (dimagi-internal/ace#2430).
 *
 * ## The asymmetry the mandate rests on
 *
 * `demo-data-setup § The interactive run stays live` leaves exactly one run
 * `in_progress` so the reviewer's decision is performable on camera, and
 * `demo-data-setup-qa` check 8 enforces it. What neither did was verify that
 * the resulting page LOADS — and the two run states do not reach their data
 * the same way:
 *
 * - a **completed** run carries a snapshot, and the runner returns early on it:
 *   `if (snapshotCarriesPipelines) return;` before it ever opens a stream
 *   (`connect_labs/static/js/workflow-runner.tsx`, read at `origin/main`
 *   c3135130). Its page needs nothing live.
 * - an **`in_progress`** run has no snapshot, so every page load — including
 *   every render take — re-runs the live pipeline stream
 *   `GET /labs/workflow/api/<definition_id>/pipeline-data/stream/`
 *   (`connect_labs/workflow/urls.py:95`, `PipelineDataStreamView`).
 *
 * So the mandate buys a performable control at the price of a live dependency
 * on every load, and nothing in ACE ever exercised that dependency. On
 * `poverty-graduation/20260915-1518` the stream died after its first event —
 * `yield send_sse_event("Loading workflow configuration...")`, the event
 * emitted before any network I/O (`views.py:5512`) — and the page rendered a
 * shell plus a banner guessing at three causes. The SAME definition over the
 * SAME pipeline rendered perfectly as a completed run, because a completed run
 * never opens the stream. Check 8 then *enforced* the dead configuration: it
 * fails a `completed` interactive run, so the only QA-passing shape was the one
 * that could not render.
 *
 * ## What this module is
 *
 * The offline half of the probe labs documents for itself —
 * *"open `/labs/workflow/api/<definition_id>/pipeline-data/stream/?<scope>`
 * directly … read the raw SSE text directly … the final `"complete": true`
 * payload's `metadata.per_opp[oppId]` is where multi-opp errors actually live"*
 * (`connect_labs/workflow/WORKFLOW_REFERENCE.md:1300`). The fetch is the
 * skill's job; the judgement is here, pure and unit-tested, in the same shape
 * as `checkDashboardBindings` and `classifyResetResponse`.
 *
 * The labs-side half is filed as `dimagi-internal/connect-labs#1884` (no
 * fallback and no diagnostic when the stream dies), which is the reference an
 * escape record cites today.
 *
 * Verified live 2026-09-17 against definitions 5714 and 5695 on labs opp 10065
 * — the exact pair ace#2430 names. Both streams completed (4s / 7s, terminal
 * `complete: true`, 137 + 9 rows), i.e. the labs-side failure did NOT reproduce
 * two days later, which is itself the argument for probing at the moment the
 * `par_url` is recorded rather than reasoning about it once.
 */

/**
 * Default labs origin. Deliberately a literal rather than an import of
 * `labs-run-state-reset.LABS_BASE_URL`: that module imports the evidence
 * classifier below for check 18's stand-down, and a cycle between the two is
 * not worth saving one constant.
 */
const DEFAULT_LABS_BASE_URL = 'https://labs.connect.dimagi.com';

/** The SSE endpoint an `in_progress` run page depends on for its data. */
export function liveLoadStreamPath(definitionId: number): string {
  return `/labs/workflow/api/${definitionId}/pipeline-data/stream/`;
}

/**
 * Scope for the stream, which follows the same OWNERSHIP rule as the `par_url`
 * (`demo-data-setup` step 4): opp-owned dashboards send `opportunity_id`,
 * program-owned rollups send `program_id`. The view coerces whichever it gets
 * (`views.py` `_coerce_int`), and an unscoped request resolves nothing.
 */
export interface LiveLoadScope {
  opportunityId?: number;
  programId?: number;
}

export function buildLiveLoadStreamUrl(
  baseUrl: string,
  definitionId: number,
  scope: LiveLoadScope,
  opts: { refresh?: boolean } = {},
): string {
  const origin = (baseUrl || DEFAULT_LABS_BASE_URL).replace(/\/+$/, '');
  const params: string[] = [];
  if (scope.opportunityId !== undefined) params.push(`opportunity_id=${scope.opportunityId}`);
  else if (scope.programId !== undefined) params.push(`program_id=${scope.programId}`);
  else {
    throw new Error(
      'buildLiveLoadStreamUrl: a scope is required — opportunityId for an opp-owned dashboard, ' +
        'programId for a program-owned rollup (demo-data-setup step 4)',
    );
  }
  // `refresh=1` forces a live fetch past the 1-hour pipeline cache. Prefer it:
  // a cache-served pass is not evidence about the path the render will take,
  // the same reason `demo-data-setup` step 3 requires `from_cache: false`.
  if (opts.refresh) params.push('refresh=1');
  return `${origin}${liveLoadStreamPath(definitionId)}?${params.join('&')}`;
}

// ── reading the raw SSE transcript ─────────────────────────────────

export type LiveLoadVerdict = 'painted' | 'errored' | 'died' | 'empty';

export interface LiveLoadStreamEvent {
  message?: string;
  complete?: boolean;
  error?: string;
  data?: { pipelines?: Record<string, unknown> } & Record<string, unknown>;
}

export interface LiveLoadProbeResult {
  verdict: LiveLoadVerdict;
  /** `true` only for `painted`. */
  ok: boolean;
  events: LiveLoadStreamEvent[];
  /** The last progress message the stream reached — the diagnostic on a death. */
  lastMessage: string | null;
  /** A stream-level error, if one was emitted. */
  error: string | null;
  /** Per-opp errors, which is where a multi-opp failure actually lives. */
  perOppErrors: string[];
  /** SSE comment lines (`: heartbeat`) — evidence the connection was held open. */
  heartbeats: number;
  pipelineAliases: string[];
  rowCounts: Record<string, number>;
  detail: string;
}

/**
 * Classify the raw body of the stream request.
 *
 * `send_sse_event` (`connect_labs/labs/analysis/sse_streaming.py:78`) is the
 * whole wire contract: every event is one `data: {json}` line, `complete` is
 * `true` only on the terminal event that carries the payload, and an `error`
 * key is set on a failure event. A body that ends with neither is a DIED
 * stream — which is what the page shows as a generic banner.
 */
export function classifyLiveLoadStream(raw: string): LiveLoadProbeResult {
  const events: LiveLoadStreamEvent[] = [];
  let heartbeats = 0;
  let malformed = 0;

  for (const line of (raw ?? '').split('\n')) {
    const trimmed = line.trimEnd();
    if (trimmed === '') continue;
    if (trimmed.startsWith(':')) {
      heartbeats += 1;
      continue;
    }
    if (!trimmed.startsWith('data:')) continue;
    const body = trimmed.slice('data:'.length).trim();
    try {
      events.push(JSON.parse(body) as LiveLoadStreamEvent);
    } catch {
      malformed += 1;
    }
  }

  const lastMessage = [...events].reverse().find((e) => typeof e.message === 'string')?.message ?? null;
  const error = events.find((e) => typeof e.error === 'string' && e.error.trim() !== '')?.error ?? null;
  const terminal = events.find((e) => e.complete === true);

  const pipelineAliases: string[] = [];
  const rowCounts: Record<string, number> = {};
  const perOppErrors: string[] = [];
  const pipelines = (terminal?.data?.pipelines ?? {}) as Record<string, unknown>;
  for (const [alias, value] of Object.entries(pipelines)) {
    pipelineAliases.push(alias);
    const meta = ((value as Record<string, unknown>)?.metadata ?? {}) as Record<string, unknown>;
    const rowCount = typeof meta.row_count === 'number' ? meta.row_count : undefined;
    const rows = (value as Record<string, unknown>)?.rows;
    rowCounts[alias] = rowCount ?? (Array.isArray(rows) ? rows.length : 0);
    const perOpp = (meta.per_opp ?? {}) as Record<string, { error?: string }>;
    for (const [oppId, entry] of Object.entries(perOpp)) {
      if (entry && typeof entry.error === 'string' && entry.error.trim() !== '') {
        perOppErrors.push(`${alias}[opp ${oppId}]: ${entry.error}`);
      }
    }
  }

  let verdict: LiveLoadVerdict;
  if (events.length === 0) verdict = 'empty';
  else if (error || perOppErrors.length > 0) verdict = 'errored';
  else if (terminal) verdict = 'painted';
  else verdict = 'died';

  const detail = (() => {
    const tail = malformed > 0 ? ` (${malformed} unparsable data line(s))` : '';
    switch (verdict) {
      case 'painted':
        return `stream completed: ${pipelineAliases.length} pipeline(s) — ${
          pipelineAliases.map((a) => `${a}=${rowCounts[a]} rows`).join(', ') || 'none declared'
        }${tail}`;
      case 'errored':
        return `stream reported an error: ${[error, ...perOppErrors].filter(Boolean).join('; ')}${tail}`;
      case 'died':
        return `stream ended with no terminal complete event — last message "${
          lastMessage ?? '(none)'
        }" after ${events.length} event(s), ${heartbeats} heartbeat(s)${tail}`;
      case 'empty':
      default:
        return `no SSE events in the response body${tail} — an expired labs session returns a login page here, not a stream`;
    }
  })();

  return {
    verdict,
    ok: verdict === 'painted',
    events,
    lastMessage,
    error,
    perOppErrors,
    heartbeats,
    pipelineAliases,
    rowCounts,
    detail,
  };
}

// ── the record the producer writes, and the gate reads ─────────────

/**
 * `source.interactive_live_load` — the producer's record of having watched the
 * interactive dashboard's page load (or fail to).
 *
 * `status: 'failed'` is an ESCAPE, and it costs the same citation
 * `checkDetectionCohortFloor` charges for `below_programme_scale`: a blank flag
 * exempts nothing. The CONTROL is the load-bearing field — without a sibling
 * run of the same definition that does render, "the page is dead" cannot be
 * told from "this dashboard is broken", and completing a broken dashboard's run
 * ships a broken page rather than repairing one.
 */
export interface InteractiveLiveLoadEvidence {
  /** The `source.dashboards[].key` this record is about. */
  dashboard?: string;
  status?: string;
  /** The exact URL probed — the stream endpoint, with its scope. */
  probe_url?: string;
  verified_at?: string;
  /** What was observed, verbatim enough to be checkable. */
  observed?: string;
  /** The `in_progress` run that was probed. */
  run_id?: number;
  /** `status: failed` only — the completed run of the same definition that DOES render. */
  control_run_id?: number;
  /** `status: failed` only — where the labs-side defect is filed. */
  upstream_ref?: string;
}

export interface LiveLoadEvidenceVerdict {
  status: 'ok' | 'failed' | 'malformed' | 'absent';
  /** The record is complete for its status — only then does it license anything. */
  granted: boolean;
  problems: string[];
}

/** An observation shorter than this is a label, not an observation. */
export const MIN_OBSERVATION_CHARS = 20;

/** `owner/repo#123` or `#123`. */
const ISSUE_REF = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#\d+$/;

export const LIVE_LOAD_PROBE_HINT =
  'Probe the interactive run before recording its par_url: ' +
  'curl -sS -N --max-time 180 -b "sessionid=<labs session>" ' +
  '"https://labs.connect.dimagi.com/labs/workflow/api/<def_id>/pipeline-data/stream/?opportunity_id=<opp>&refresh=1" ' +
  '| tee <transcript>, then classifyLiveLoadStream() it and write source.interactive_live_load ' +
  '{dashboard, status, probe_url, verified_at, observed, run_id} — plus {control_run_id, upstream_ref} ' +
  'when it failed and the run ships completed instead (demo-data-setup step 4c; ace#2430).';

export function classifyLiveLoadEvidence(evidence: unknown): LiveLoadEvidenceVerdict {
  if (evidence === undefined || evidence === null) {
    return {
      status: 'absent',
      granted: false,
      problems: ['no source.interactive_live_load recorded — the in_progress mandate was never verified'],
    };
  }
  if (typeof evidence !== 'object') {
    return { status: 'malformed', granted: false, problems: ['source.interactive_live_load is not a mapping'] };
  }

  const ev = evidence as InteractiveLiveLoadEvidence;
  const problems: string[] = [];
  const status = (ev.status ?? '').trim().toLowerCase();

  if (status !== 'ok' && status !== 'failed') {
    return {
      status: 'malformed',
      granted: false,
      problems: [`source.interactive_live_load.status is '${ev.status ?? '(unset)'}' — must be 'ok' or 'failed'`],
    };
  }

  const observed = (ev.observed ?? '').trim();
  if (observed.length < MIN_OBSERVATION_CHARS) {
    problems.push(
      `observed is ${observed.length} chars — record what the stream actually did ` +
        `(at least ${MIN_OBSERVATION_CHARS} chars: the terminal event, or the last message before it ended)`,
    );
  }
  if (!(ev.verified_at ?? '').trim()) {
    problems.push('verified_at is missing — an undated probe is not evidence about this run');
  }
  if (!Number.isInteger(ev.run_id)) {
    problems.push('run_id is missing or not an integer — name the run that was probed');
  }

  if (status === 'failed') {
    if (!Number.isInteger(ev.control_run_id)) {
      problems.push(
        'control_run_id is missing — the escape needs a completed run of the SAME definition that DOES ' +
          'render, or a dead stream cannot be told from a broken dashboard',
      );
    } else if (ev.control_run_id === ev.run_id) {
      problems.push('control_run_id is the failing run itself — the control must be a different, rendering run');
    }
    if (!ISSUE_REF.test((ev.upstream_ref ?? '').trim())) {
      problems.push(
        "upstream_ref is missing or not an issue reference ('owner/repo#123') — a labs defect nobody filed " +
          'is a defect nobody fixes',
      );
    }
  }

  return { status, granted: problems.length === 0, problems };
}

/**
 * Convenience for the producer: turn a probe result straight into the record,
 * so the archived evidence is the transcript that was actually read rather
 * than a second, hand-typed account of it.
 */
export function evidenceFromProbe(
  probe: LiveLoadProbeResult,
  fields: { dashboard: string; probe_url: string; run_id: number; verified_at: string; control_run_id?: number; upstream_ref?: string },
): InteractiveLiveLoadEvidence {
  return {
    dashboard: fields.dashboard,
    status: probe.ok ? 'ok' : 'failed',
    probe_url: fields.probe_url,
    verified_at: fields.verified_at,
    observed: probe.detail,
    run_id: fields.run_id,
    ...(fields.control_run_id === undefined ? {} : { control_run_id: fields.control_run_id }),
    ...(fields.upstream_ref === undefined ? {} : { upstream_ref: fields.upstream_ref }),
  };
}

/** Shared formatting so check 8 and check 18 say the same thing about a record. */
export function describeLiveLoadEvidence(verdict: LiveLoadEvidenceVerdict, ev: unknown): string {
  const e = (ev ?? {}) as InteractiveLiveLoadEvidence;
  if (verdict.status === 'absent') return verdict.problems.join('; ');
  const cite = [
    e.probe_url ? `probe ${e.probe_url}` : null,
    e.run_id === undefined ? null : `run ${e.run_id}`,
    e.control_run_id === undefined ? null : `control run ${e.control_run_id}`,
    e.upstream_ref ?? null,
    e.verified_at ?? null,
  ]
    .filter(Boolean)
    .join(', ');
  return cite;
}
