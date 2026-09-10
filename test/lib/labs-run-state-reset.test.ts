import { describe, it, expect } from 'vitest';

import {
  buildResetBody,
  buildRunPageUrl,
  checkRenderResetRegistered,
  classifyPinnedResetCommand,
  classifyResetResponse,
  extractCsrfToken,
  renderResetCommand,
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

/**
 * dimagi-internal/ace#2351 — the registered reset command used to be an
 * ABSOLUTE path into ONE user's VERSIONED plugin cache
 * (`/Users/jjackson/.claude/plugins/cache/ace/ace/0.13.1426/scripts/…`).
 * `demo-narrative` copies it verbatim into the spec's `setup.command`, so the
 * per-run state pinned (a) a version directory — the cache keeps every prior
 * version, so the path keeps RESOLVING and runs stale code after every
 * `/ace:update` — and (b) a home directory, unusable from another account.
 * Measured on `spark-facilitator/20260909-2242` (pinned 0.13.1413, pre-ace#2325,
 * `grep -c buildRunPageUrl` = 0 there) and `20260910-0541` (`/Users/jjackson/…`).
 *
 * The self-resolving form locates the INSTALLED root through
 * `installed_plugins.json` at run time, and check 18 now fails loud on a pin.
 */
describe('checkRenderResetRegistered — pinned vs self-resolving commands (ace#2351)', () => {
  const interactiveDash = [{ key: 'llo_review', role: 'review-action', interactive: true }];
  const args = { runId: 5590, workflowId: 5502, opportunityId: 10060, stateKeys: ['record_reviews'] };
  const base = { required: true, run_id: 5590, state_keys: ['record_reviews'] };

  it('FAILS a command pinned to a versioned plugin-cache directory — the 20260909-2242 shape', () => {
    const r = checkRenderResetRegistered({
      dashboards: interactiveDash,
      renderReset: {
        ...base,
        command:
          'npx tsx /Users/jjackson/.claude/plugins/cache/ace/ace/0.13.1426/scripts/reset-labs-run-state.ts ' +
          '--run-id 5590 --workflow-id 5502 --opportunity-id 10060 --keys record_reviews',
      },
    });
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/render_reset_command_pinned/);
    expect(r.detail).toMatch(/plugin-cache/);
  });

  it('FAILS a command pinned to a home directory even outside the plugin cache', () => {
    const r = checkRenderResetRegistered({
      dashboards: interactiveDash,
      renderReset: {
        ...base,
        command:
          'node /Users/jjackson/src/ace/scripts/reset-labs-run-state.ts --run-id 5590 --workflow-id 5502 --keys record_reviews',
      },
    });
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/render_reset_command_pinned/);
    expect(r.detail).toMatch(/home directory/);
  });

  it("FAILS a Linux home pin too — the class is one machine's snapshot, not one OS", () => {
    const r = checkRenderResetRegistered({
      dashboards: interactiveDash,
      renderReset: {
        ...base,
        command:
          'bash /home/ace/.claude/plugins/cache/ace/ace/0.13.1400/bin/ace-reset-labs-run --run-id 5590 --workflow-id 5502 --keys record_reviews',
      },
    });
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/render_reset_command_pinned/);
  });

  it('FAILS a spec setup.command that pins, even when the registered command is clean', () => {
    // The spec is what canopy actually runs; a hand-edited pin there is the
    // same stale-code path with one extra hop.
    const command = renderResetCommand(args);
    const r = checkRenderResetRegistered({
      dashboards: interactiveDash,
      renderReset: { ...base, command },
      specSetup: {
        command: `${command} && node /Users/jjackson/.claude/plugins/cache/ace/ace/0.13.1400/scripts/realize.ts`,
        rerun: 'per_render',
      },
    });
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/setup\.command.*pinned/);
  });

  it('PASSES the self-resolving form, in the handoff and copied into the spec', () => {
    const command = renderResetCommand(args);
    const r = checkRenderResetRegistered({
      dashboards: interactiveDash,
      renderReset: { ...base, command },
      specSetup: { command: `${command} && ./realize.sh`, rerun: 'per_render' },
    });
    expect(r.pass).toBe(true);
  });

  it('the hint teaches the self-resolving form, not the pinned one', () => {
    const r = checkRenderResetRegistered({ dashboards: interactiveDash, renderReset: null });
    expect(r.auto_fix_hint).toContain('installed_plugins.json');
    expect(r.auto_fix_hint).toContain('bin/ace-reset-labs-run');
    expect(r.auto_fix_hint).not.toContain('<ace-root>');
  });
});

describe('renderResetCommand (ace#2351)', () => {
  it('locates the shim through installed_plugins.json — never a version directory, never a home', () => {
    const cmd = renderResetCommand({
      runId: 5590,
      workflowId: 5502,
      opportunityId: 10060,
      stateKeys: ['record_reviews'],
    });
    expect(cmd).toContain('installed_plugins.json');
    expect(cmd).toContain("['plugins']['ace@ace'][0]['installPath']");
    expect(cmd).toContain('/bin/ace-reset-labs-run');
    expect(cmd).toContain('--run-id 5590');
    expect(cmd).toContain('--workflow-id 5502');
    expect(cmd).toContain('--opportunity-id 10060');
    expect(cmd).toContain('--keys record_reviews');
    expect(cmd).not.toMatch(/plugins\/cache\/ace\/ace\//);
    expect(cmd).not.toMatch(/\/Users\//);
    expect(classifyPinnedResetCommand(cmd)).toBeNull();
  });

  it('is a single shell line, because canopy runs setup.command through `sh -c` (record_video.py:398)', () => {
    const cmd = renderResetCommand({ runId: 1, workflowId: 2, stateKeys: ['a', 'b'] });
    expect(cmd).not.toContain('\n');
    expect(cmd).toContain('--keys a,b');
    expect(cmd).not.toContain('--opportunity-id');
  });

  it('refuses an empty key list, like buildResetBody', () => {
    expect(() => renderResetCommand({ runId: 1, workflowId: 2, stateKeys: [] })).toThrow(/shallow-merge/i);
  });
});

describe('classifyPinnedResetCommand (ace#2351)', () => {
  it('names the plugin-cache pin first when both pins are present', () => {
    expect(
      classifyPinnedResetCommand('npx tsx /Users/x/.claude/plugins/cache/ace/ace/0.13.1/scripts/r.ts'),
    ).toMatch(/plugin-cache/);
  });
  it('does not flag a path merely containing the word Users mid-token', () => {
    expect(classifyPinnedResetCommand('bash ./tools/Users-report --run-id 1')).toBeNull();
  });
  it('returns null on the empty string (the empty case is reported separately)', () => {
    expect(classifyPinnedResetCommand('')).toBeNull();
  });
});
