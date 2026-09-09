import { describe, it, expect } from 'vitest';

import {
  buildResetBody,
  checkRenderResetRegistered,
  classifyResetResponse,
  extractCsrfToken,
  runStateApiPath,
} from '../../lib/labs-run-state-reset';

/**
 * dimagi-internal/ace#2297 — a labs run's `spawned_tasks` persists across
 * renders, so the second take of a scene whose payoff CREATES something finds
 * the control already gone and its `must_succeed` click aborts the render.
 *
 * The controls below encode the four labs-side facts the reset depends on
 * (each verified in `dimagi-internal/connect-labs` source, cited in
 * `lib/labs-run-state-reset.ts`) plus the two-sided registration contract:
 * the handoff declares the reset, the spec's `setup` block runs it
 * `per_render`. Either half alone is a no-op.
 */
describe('runStateApiPath', () => {
  it('targets the per-run state endpoint', () => {
    expect(runStateApiPath(5508)).toBe('/labs/workflow/api/run/5508/state/');
  });
});

describe('extractCsrfToken', () => {
  it('reads the hidden input Django renders for {% csrf_token %}', () => {
    const html = '<form><input type="hidden" name="csrfmiddlewaretoken" value="abc123"></form>';
    expect(extractCsrfToken(html)).toBe('abc123');
  });

  it('reads it with the attributes in the other order, single-quoted', () => {
    const html = "<input value='tok-9' type='hidden' name='csrfmiddlewaretoken'>";
    expect(extractCsrfToken(html)).toBe('tok-9');
  });

  it("falls back to the runner page's data-csrf-token attribute", () => {
    const html = '<div id="workflow-root" data-csrf-token="runner-tok"></div>';
    expect(extractCsrfToken(html)).toBe('runner-tok');
  });

  it('returns null on a page with no token — a logged-out redirect, not a silent empty string', () => {
    expect(extractCsrfToken('<html><body>Please log in</body></html>')).toBeNull();
  });

  it('is not fooled by the hx-headers X-CSRFToken attribute alone', () => {
    // base.html:22 carries `hx-headers='{"X-CSRFToken": "..."}'` on <body>;
    // that is a header name, not the form field, and must not match.
    const html = `<body hx-headers='{"X-CSRFToken": "hx-tok"}'></body>`;
    expect(extractCsrfToken(html)).toBeNull();
  });
});

describe('buildResetBody', () => {
  it('NESTS the payload under `state` — the flat form is a 400', () => {
    // views.py:1012 `data.get("state")`; absent -> 400 "state required in request body".
    expect(buildResetBody(['spawned_tasks'])).toEqual({ state: { spawned_tasks: {} } });
  });

  it('names every key explicitly, because update_run_state SHALLOW-MERGES', () => {
    // data_access.py:779 `{**current_state, **sanitized}` — an unnamed key survives.
    expect(buildResetBody(['worker_states', 'spawned_tasks'])).toEqual({
      state: { worker_states: {}, spawned_tasks: {} },
    });
  });

  it('refuses an empty key list rather than posting a silent no-op', () => {
    expect(() => buildResetBody([])).toThrow(/shallow-merge/i);
  });

  it('honours a baseline for a key whose empty is not {}', () => {
    expect(buildResetBody(['notes'], { notes: [] })).toEqual({ state: { notes: [] } });
  });
});

describe('classifyResetResponse', () => {
  it('names a completed run rather than reporting a generic failure', () => {
    const v = classifyResetResponse(409, '{"error": "Run is completed; state is immutable."}');
    expect(v.outcome).toBe('run-completed');
    expect(v.detail).toMatch(/in_progress/);
  });

  it('names the body shape on a 400', () => {
    const v = classifyResetResponse(400, '{"error": "state required in request body"}');
    expect(v.outcome).toBe('body-shape');
    expect(v.detail).toMatch(/NESTED/);
  });

  it('names session-or-CSRF on a 403, and says the cookie does not exist', () => {
    const v = classifyResetResponse(403, 'CSRF verification failed');
    expect(v.outcome).toBe('auth-or-csrf');
    expect(v.detail).toMatch(/CSRF_USE_SESSIONS/);
  });

  it('passes a 200 through', () => {
    expect(classifyResetResponse(200, '{"success": true}').outcome).toBe('ok');
  });

  it('does not swallow an unexpected status', () => {
    expect(classifyResetResponse(502, 'bad gateway').outcome).toBe('server-error');
  });
});

describe('checkRenderResetRegistered', () => {
  const interactiveDash = [{ key: 'llo_review', role: 'review-action', interactive: true }];
  const goodReset = {
    required: true,
    run_id: 5508,
    state_keys: ['worker_states', 'spawned_tasks'],
    command: 'npx tsx scripts/reset-labs-run-state.ts --run-id 5508 --keys worker_states,spawned_tasks',
  };

  it('passes a demo with no interactive dashboard — nothing mutates', () => {
    const r = checkRenderResetRegistered({
      dashboards: [{ key: 'program_admin', role: 'overview' }],
      renderReset: null,
    });
    expect(r.pass).toBe(true);
  });

  it('FAILS an interactive dashboard with no registered reset — the ace#2297 shape', () => {
    const r = checkRenderResetRegistered({ dashboards: interactiveDash, renderReset: null });
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/render_reset\.required/);
    expect(r.auto_fix_hint).toBeTruthy();
  });

  it('treats a role-only interactive dashboard the same as an explicit flag', () => {
    const r = checkRenderResetRegistered({
      dashboards: [{ key: 'weekly', role: 'decision' }],
      renderReset: null,
    });
    expect(r.pass).toBe(false);
  });

  it('fails a reset that names no state keys', () => {
    const r = checkRenderResetRegistered({
      dashboards: interactiveDash,
      renderReset: { ...goodReset, state_keys: [] },
    });
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/no-op/);
  });

  it('fails a reset with no run id', () => {
    const r = checkRenderResetRegistered({
      dashboards: interactiveDash,
      renderReset: { ...goodReset, run_id: undefined },
    });
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/run_id/);
  });

  it('FAILS `rerun: once` — what let iteration 0 pass and every later one abort', () => {
    const r = checkRenderResetRegistered({
      dashboards: interactiveDash,
      renderReset: goodReset,
      specSetup: { command: `${goodReset.command} && ./realize.sh`, rerun: 'once' },
    });
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/per_render/);
  });

  it('FAILS a per_render setup whose command never runs the reset', () => {
    const r = checkRenderResetRegistered({
      dashboards: interactiveDash,
      renderReset: goodReset,
      specSetup: { command: './realize.sh', rerun: 'per_render' },
    });
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/resets nothing/);
  });

  it('fails a spec with no setup block at all', () => {
    const r = checkRenderResetRegistered({
      dashboards: interactiveDash,
      renderReset: goodReset,
      specSetup: null,
    });
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/NO setup block/);
  });

  it('passes both halves wired', () => {
    const r = checkRenderResetRegistered({
      dashboards: interactiveDash,
      renderReset: goodReset,
      specSetup: { command: `${goodReset.command} && ./realize.sh`, rerun: 'per_render' },
    });
    expect(r.pass).toBe(true);
  });

  it('reports — never silently passes — the spec half when the spec does not exist yet', () => {
    const r = checkRenderResetRegistered({ dashboards: interactiveDash, renderReset: goodReset });
    expect(r.pass).toBe(true);
    expect(r.detail).toMatch(/not judged/);
  });
});
