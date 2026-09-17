/**
 * The interactive dashboard's live-load probe + its evidenced escape (ace#2430).
 *
 * Fixtures are trimmed from REAL captures taken 2026-09-17 against
 * `GET /labs/workflow/api/<def>/pipeline-data/stream/?opportunity_id=10065`
 * with the labs UI session — definitions 5714 and 5695, the two dashboards
 * named in ace#2430. The `died` fixture is the shape ace#2430 observed on
 * 2026-09-15: the stream's first event lands and the connection ends with no
 * terminal `complete: true` and no `error`.
 */

import { describe, it, expect } from 'vitest';
import {
  buildLiveLoadStreamUrl,
  classifyLiveLoadEvidence,
  classifyLiveLoadStream,
  liveLoadStreamPath,
  LIVE_LOAD_PROBE_HINT,
} from '../../lib/interactive-live-load.js';

// ── real transcript fragments (def 5714 / opp 10065, 2026-09-17) ──

const PAINTED = [
  'data: {"message": "Loading workflow configuration...", "complete": false}',
  '',
  'data: {"message": "Loading pipeline configurations...", "complete": false}',
  '',
  ': heartbeat',
  '',
  'data: {"message": "Executing pipeline: Targeting surveys \\u2014 one row per submitted doorstep...", "complete": false}',
  '',
  'data: {"message": "Loaded 146 records", "complete": true, "data": {"pipelines": {"surveys": {"rows": [{"id": 1}], "metadata": {"pipeline_id": 5713, "row_count": 137, "per_opp": {"10065": {"row_count": 137, "from_cache": true}}}}, "worker_context": {"rows": [{"id": 2}], "metadata": {"pipeline_id": 5694, "row_count": 9, "per_opp": {"10065": {"row_count": 9, "from_cache": true}}}}}}}',
  '',
].join('\n');

/** ace#2430's observation: the stream ends at the first event. */
const DIED = ['data: {"message": "Loading workflow configuration...", "complete": false}', '', ''].join('\n');

const ERRORED = [
  'data: {"message": "Loading workflow configuration...", "complete": false}',
  '',
  'data: {"message": "Error", "complete": false, "error": "Workflow 5714 not found"}',
  '',
].join('\n');

/**
 * The trap WORKFLOW_REFERENCE.md documents: a multi-opp workflow's real error
 * lives at `metadata.per_opp[oppId].error`, never at the top level — so a
 * terminal event alone is not proof the page has data.
 */
const PER_OPP_ERROR = [
  'data: {"message": "Loading workflow configuration...", "complete": false}',
  '',
  'data: {"message": "Loaded 0 records", "complete": true, "data": {"pipelines": {"surveys": {"rows": [], "metadata": {"pipeline_id": 5713, "row_count": 0, "per_opp": {"10065": {"error": "Pipeline not found"}}}}}}}',
  '',
].join('\n');

describe('liveLoadStreamPath / buildLiveLoadStreamUrl — labs own diagnostic URL', () => {
  it('is the stream endpoint labs routes at api/<definition_id>/pipeline-data/stream/', () => {
    expect(liveLoadStreamPath(5714)).toBe('/labs/workflow/api/5714/pipeline-data/stream/');
  });

  it('scopes an opp-owned dashboard by opportunity_id', () => {
    expect(buildLiveLoadStreamUrl('https://labs.connect.dimagi.com/', 5714, { opportunityId: 10065 })).toBe(
      'https://labs.connect.dimagi.com/labs/workflow/api/5714/pipeline-data/stream/?opportunity_id=10065',
    );
  });

  it('scopes a program-owned rollup by program_id (an opportunity_id 404s it)', () => {
    expect(buildLiveLoadStreamUrl('https://labs.connect.dimagi.com', 5040, { programId: 10037 })).toBe(
      'https://labs.connect.dimagi.com/labs/workflow/api/5040/pipeline-data/stream/?program_id=10037',
    );
  });

  it('adds refresh=1 when asked — the cold path, because a cache hit is not evidence', () => {
    expect(
      buildLiveLoadStreamUrl('https://labs.connect.dimagi.com', 5714, { opportunityId: 10065 }, { refresh: true }),
    ).toMatch(/\?opportunity_id=10065&refresh=1$/);
  });

  it('refuses a scope with neither id — an unscoped stream resolves nothing', () => {
    expect(() => buildLiveLoadStreamUrl('https://labs.connect.dimagi.com', 5714, {})).toThrow(/scope/i);
  });
});

describe('classifyLiveLoadStream', () => {
  it('reads a completed stream as painted, with its aliases and row counts', () => {
    const r = classifyLiveLoadStream(PAINTED);
    expect(r.verdict).toBe('painted');
    expect(r.ok).toBe(true);
    expect(r.pipelineAliases).toEqual(['surveys', 'worker_context']);
    expect(r.rowCounts).toEqual({ surveys: 137, worker_context: 9 });
    expect(r.heartbeats).toBe(1);
  });

  it('reads ace#2430s observation as DIED, and names the last message it reached', () => {
    const r = classifyLiveLoadStream(DIED);
    expect(r.verdict).toBe('died');
    expect(r.ok).toBe(false);
    expect(r.lastMessage).toBe('Loading workflow configuration...');
    expect(r.detail).toMatch(/Loading workflow configuration/);
  });

  it('reads an explicit error event as errored', () => {
    const r = classifyLiveLoadStream(ERRORED);
    expect(r.verdict).toBe('errored');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not found/);
  });

  it('a terminal event is NOT enough: a per-opp error is still errored', () => {
    const r = classifyLiveLoadStream(PER_OPP_ERROR);
    expect(r.verdict).toBe('errored');
    expect(r.ok).toBe(false);
    expect(r.perOppErrors.join(' ')).toMatch(/Pipeline not found/);
  });

  it('an empty body is empty, never a vacuous pass', () => {
    const r = classifyLiveLoadStream('');
    expect(r.verdict).toBe('empty');
    expect(r.ok).toBe(false);
  });

  it('a login redirect (HTML, not SSE) is empty rather than painted', () => {
    const r = classifyLiveLoadStream('<!DOCTYPE html><html><body>Sign in</body></html>');
    expect(r.ok).toBe(false);
    expect(r.verdict).toBe('empty');
  });
});

describe('classifyLiveLoadEvidence — the producer writes it, the gate reads it', () => {
  const OK = {
    dashboard: 'llo_review',
    status: 'ok',
    run_id: 5720,
    probe_url: 'https://labs.connect.dimagi.com/labs/workflow/api/5714/pipeline-data/stream/?opportunity_id=10065',
    verified_at: '2026-09-17T07:04:00Z',
    observed: 'stream completed in 4s with complete:true; surveys 137 rows, worker_context 9 rows',
  };

  const FAILED = {
    dashboard: 'llo_review',
    status: 'failed',
    run_id: 5720,
    control_run_id: 5718,
    probe_url: 'https://labs.connect.dimagi.com/labs/workflow/api/5695/pipeline-data/stream/?opportunity_id=10065',
    verified_at: '2026-09-15T18:42:00Z',
    observed: 'connection ended while "Loading workflow configuration..." with no complete event',
    upstream_ref: 'dimagi-internal/connect-labs#1884',
  };

  it('absent evidence is absent, and never granted', () => {
    const r = classifyLiveLoadEvidence(undefined);
    expect(r.status).toBe('absent');
    expect(r.granted).toBe(false);
  });

  it('grants a complete ok record', () => {
    const r = classifyLiveLoadEvidence(OK);
    expect(r.status).toBe('ok');
    expect(r.granted).toBe(true);
    expect(r.problems).toEqual([]);
  });

  it('grants a complete failed record — the escape', () => {
    const r = classifyLiveLoadEvidence(FAILED);
    expect(r.status).toBe('failed');
    expect(r.granted).toBe(true);
  });

  it('REFUSES a failed record with no control — without one you cannot tell a sick stream from a broken dashboard', () => {
    const r = classifyLiveLoadEvidence({ ...FAILED, control_run_id: undefined });
    expect(r.granted).toBe(false);
    expect(r.problems.join(' ')).toMatch(/control_run_id/);
  });

  it('REFUSES a control that is the failing run itself', () => {
    const r = classifyLiveLoadEvidence({ ...FAILED, control_run_id: 5720 });
    expect(r.granted).toBe(false);
    expect(r.problems.join(' ')).toMatch(/control_run_id/);
  });

  it('REFUSES a failed record with no upstream ref — a labs defect nobody filed is a defect nobody fixes', () => {
    const r = classifyLiveLoadEvidence({ ...FAILED, upstream_ref: 'we told someone' });
    expect(r.granted).toBe(false);
    expect(r.problems.join(' ')).toMatch(/upstream_ref/);
  });

  it('REFUSES a blank observation — the same discipline below_programme_scale imposes', () => {
    for (const observed of ['', '   ', 'it broke']) {
      const r = classifyLiveLoadEvidence({ ...FAILED, observed });
      expect(r.granted).toBe(false);
      expect(r.problems.join(' ')).toMatch(/observed/);
    }
  });

  it('REFUSES an unknown status rather than reading it as a pass', () => {
    const r = classifyLiveLoadEvidence({ ...OK, status: 'probably fine' });
    expect(r.status).toBe('malformed');
    expect(r.granted).toBe(false);
  });

  it('REFUSES an ok record with no probe behind it', () => {
    const r = classifyLiveLoadEvidence({ ...OK, verified_at: undefined });
    expect(r.granted).toBe(false);
    expect(r.problems.join(' ')).toMatch(/verified_at/);
  });

  it('the hint names the probe, so a failing gate is one command from being satisfied', () => {
    expect(LIVE_LOAD_PROBE_HINT).toMatch(/pipeline-data\/stream/);
  });
});
