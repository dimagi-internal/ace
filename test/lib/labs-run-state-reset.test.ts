import { describe, it, expect } from 'vitest';

import {
  buildResetBody,
  buildRunPageUrl,
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

/**
 * dimagi-internal/ace#2325 — the CLI used to synthesise its CSRF page as
 * `<base>/labs/workflow/run/<run_id>/`, which is not a labs route. The token
 * came off a non-page, the POST returned 404, and the 404 was reported as
 * `run-not-found` on a run that existed and was resettable. Because the spec's
 * `setup` block is `rerun: per_render`, that blocked EVERY render.
 *
 * Measured on labs run 5590 / workflow 5502 / opp 10060, 2026-09-09:
 *   `--run-id 5590 --keys record_reviews`
 *     -> "ERROR: run 5590: run-not-found — run id not found for this user/scope"
 *   the same, plus `--page-url` built to the shape below
 *     -> "run 5590: cleared record_reviews"
 */
describe('buildRunPageUrl', () => {
  it('puts the WORKFLOW id in the path and the run id in the query', () => {
    expect(buildRunPageUrl('https://labs.connect.dimagi.com', 5502, 5590, 10060)).toBe(
      'https://labs.connect.dimagi.com/labs/workflow/5502/run/?run_id=5590&opportunity_id=10060',
    );
  });

  it('omits the opportunity scope when it is not known', () => {
    expect(buildRunPageUrl('https://labs.connect.dimagi.com', 5502, 5590)).toBe(
      'https://labs.connect.dimagi.com/labs/workflow/5502/run/?run_id=5590',
    );
  });

  it('does not double the slash when the base URL carries a trailing one', () => {
    expect(buildRunPageUrl('https://labs.connect.dimagi.com/', 5577, 5584, 10061)).toBe(
      'https://labs.connect.dimagi.com/labs/workflow/5577/run/?run_id=5584&opportunity_id=10061',
    );
  });

  it('never emits the retracted run-id-only path, which resolves to nothing', () => {
    const url = buildRunPageUrl('https://labs.connect.dimagi.com', 5502, 5590, 10060);
    expect(url).not.toContain('/labs/workflow/run/');
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

  it('offers the wrong-CSRF-page reading on a 404, not only "not found for this scope"', () => {
    // The old single-reading detail is what made ace#2325 cost a live-run
    // detour: the operator-facing text asserted the run was missing, when the
    // run was fine and the token page was not a page.
    const v = classifyResetResponse(404, '');
    expect(v.outcome).toBe('run-not-found');
    expect(v.detail).toMatch(/CSRF token/i);
    expect(v.detail).toMatch(/\/labs\/workflow\/<workflow_id>\/run\//);
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
