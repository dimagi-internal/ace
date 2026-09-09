/**
 * The per-render reset of a LIVE connect-labs workflow run's state.
 *
 * ## Why this exists (dimagi-internal/ace#2297)
 *
 * A demo whose payoff is a stakeholder *creating* something — the "Create
 * coaching task" button on the weekly facilitator review — mutates real
 * server-side state while it is being filmed. That state PERSISTS: the labs
 * run keeps the spawned task, so the next render finds the button already
 * gone and its `must_succeed` click aborts the whole render. The failure is
 * order-dependent and invisible on the first pass — iteration 0 passes, every
 * iteration after it fails on a scene that has not changed.
 *
 * Measured on `spark-facilitator/20260908-2215` Phase 7, DDD run
 * `spark-fcap-facilitation-2026-09-08-001`, labs run 5508 (workflow 5502,
 * opp 10060). Iterations 0-2 passed only because someone had reset the state
 * BY HAND, which left no trace in `run_state.yaml` or any run artifact.
 *
 * canopy's `UnifiedSpec.setup` already has the right primitive —
 * `rerun: per_render` runs the setup command before EVERY render, and its own
 * docstring names this exact case ("demos that MUTATE state during recording
 * … film the wrong UI on every re-render unless the generator runs again
 * first"). What was missing is a reset that (a) lives somewhere durable rather
 * than in a swept run directory, and (b) is registered in the handoff so the
 * narrative author wires it instead of rediscovering the need.
 *
 * ## The four external-system facts, verified in labs source
 *
 * Read against `dimagi-internal/connect-labs` at 67f048f3c:
 *
 * 1. **The body must be NESTED — `{"state": {...}}`.** `update_state_api`
 *    (`commcare_connect/workflow/views.py:1004-1015`) does
 *    `data.get("state")` and returns 400 `{"error": "state required in
 *    request body"}` when that is absent. A flat `{"spawned_tasks": {}}` is a
 *    400, not a partial write (ace#2297).
 * 2. **There is no `csrftoken` cookie on the labs domain.**
 *    `CSRF_USE_SESSIONS = True` + `CSRF_COOKIE_HTTPONLY = True`
 *    (`config/settings/base.py:269-270`) put the CSRF secret in the SESSION,
 *    so the token has to be read out of a rendered page's
 *    `csrfmiddlewaretoken` input. This is a settings-level fact, not a quirk
 *    of one session — no amount of re-login produces the cookie.
 * 3. **`update_run_state` SHALLOW-MERGES** (`data_access.py:756-780`:
 *    `{...current_state, ...sanitized}`), so posting `{"state": {}}` is a
 *    silent no-op that leaves every mutated key exactly as it was. A reset
 *    must name each key it is clearing. There is no delete — overwrite is the
 *    only reset.
 * 4. **A completed run refuses the write with 409** ("Run is completed; state
 *    is immutable"). Only the INTERACTIVE dashboard's run — the one
 *    `demo-data-setup § The interactive run stays live` deliberately leaves
 *    `in_progress` — is resettable, which is also the only one that needs it.
 *
 * WHICH keys to clear is not a guess either: a workflow's mutable state keys
 * are declared in its own `snapshot_inputs.state_keys`
 * (e.g. `["worker_states", "spawned_tasks"]` for `llo_weekly_review`), which
 * `workflow_get` returns under `saved_runs.snapshot_inputs`.
 *
 * The pure helpers here are the offline half; `scripts/reset-labs-run-state.ts`
 * is the CLI that makes the HTTP calls.
 */

import type { QACheckResult } from './qa-types.js';

/** Default labs origin; every ACE demo dashboard lives here. */
export const LABS_BASE_URL = 'https://labs.connect.dimagi.com';

/** The state-write endpoint for one run. */
export function runStateApiPath(runId: number): string {
  return `/labs/workflow/api/run/${runId}/state/`;
}

/**
 * Pull Django's CSRF token out of a rendered labs page.
 *
 * Required because labs sets no `csrftoken` cookie (fact 2 above). Django
 * renders `{% csrf_token %}` as a hidden input; we accept either attribute
 * order, single or double quotes. Every labs page extending `base.html`
 * carries one (`templates/base.html:66`), and the workflow RUNNER page — the
 * page a `par_url` opens — additionally exposes it as
 * `data-csrf-token` on `#workflow-root` (`templates/workflow/run.html:242`),
 * which is read as a last resort.
 */
export function extractCsrfToken(html: string): string | null {
  const patterns = [
    /name=["']csrfmiddlewaretoken["'][^>]*\svalue=["']([^"']+)["']/i,
    /value=["']([^"']+)["'][^>]*\sname=["']csrfmiddlewaretoken["']/i,
    /data-csrf-token=["']([^"']+)["']/i,
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (m) return m[1];
  }
  return null;
}

/**
 * Build the POST body that clears `stateKeys`.
 *
 * Nested under `state` (fact 1) and naming every key explicitly (fact 3).
 * The empty value defaults to `{}` — the dict-shaped keys ACE's dashboards
 * mutate (`spawned_tasks`, `worker_states`) are read by render code as
 * `view.state.spawned_tasks || {}` (`templates/llo_weekly_review.py:56`), so
 * `{}` is indistinguishable from absent. A key whose cleared shape is a list
 * or a scalar must be passed explicitly via `baseline`.
 */
export function buildResetBody(
  stateKeys: string[],
  baseline: Record<string, unknown> = {},
): { state: Record<string, unknown> } {
  if (stateKeys.length === 0) {
    throw new Error(
      'buildResetBody: no state keys. labs shallow-merges run state, so an empty ' +
        'patch is a silent no-op — name the keys to clear (workflow_get -> ' +
        'saved_runs.snapshot_inputs.state_keys).',
    );
  }
  const state: Record<string, unknown> = {};
  for (const key of stateKeys) {
    state[key] = key in baseline ? baseline[key] : {};
  }
  return { state };
}

export type ResetOutcome =
  | 'ok'
  | 'run-completed'
  | 'run-not-found'
  | 'auth-or-csrf'
  | 'body-shape'
  | 'server-error';

export interface ResetClassification {
  outcome: ResetOutcome;
  /** Operator-facing explanation naming the mechanism, not just the code. */
  detail: string;
}

/**
 * Turn a response from the state endpoint into a named failure class.
 *
 * Every branch here is a distinct remedy, and three of the four are
 * indistinguishable from "the reset didn't work" without this mapping.
 */
export function classifyResetResponse(status: number, body: string): ResetClassification {
  if (status >= 200 && status < 300) {
    return { outcome: 'ok', detail: 'run state written' };
  }
  if (status === 409) {
    return {
      outcome: 'run-completed',
      detail:
        "run is completed and its state is immutable — only the INTERACTIVE dashboard's run stays " +
        'in_progress (demo-data-setup § The interactive run stays live); check the run id, or the run ' +
        'was snapshotted when it should not have been',
    };
  }
  if (status === 404) {
    return { outcome: 'run-not-found', detail: 'run id not found for this user/scope' };
  }
  if (status === 403 || status === 401) {
    return {
      outcome: 'auth-or-csrf',
      detail:
        'rejected before the handler — a stale labs session or a missing/incorrect X-CSRFToken. ' +
        'labs sets NO csrftoken cookie (CSRF_USE_SESSIONS=True), so the token must come from the ' +
        'page DOM; re-run /ace:labs-login if the session itself is stale',
    };
  }
  if (status === 400) {
    return {
      outcome: 'body-shape',
      detail:
        `400 from the state endpoint — the body must be NESTED as {"state": {...}}; the flat form is ` +
        `rejected with "state required in request body" (ace#2297). Server said: ${body.slice(0, 200)}`,
    };
  }
  return { outcome: 'server-error', detail: `HTTP ${status}: ${body.slice(0, 200)}` };
}

// ── The QA half: is the reset REGISTERED, or does the loop rediscover it? ──

/** One dashboard as `run_state…products.synthetic.source.dashboards[]` records it. */
export interface ResetDashboardRef {
  key: string;
  role?: string;
  interactive?: boolean;
}

/** The `source.render_reset` block `demo-data-setup` emits. */
export interface RenderResetContract {
  required?: boolean;
  run_id?: number;
  state_keys?: string[];
  command?: string;
}

/** The authored `UnifiedSpec.setup` block, when the spec exists yet. */
export interface SpecSetupBlock {
  command?: string;
  rerun?: string;
  outputs?: string | null;
}

export interface RenderResetCheckInput {
  dashboards: ResetDashboardRef[];
  renderReset?: RenderResetContract | null;
  /** Omit when QA runs BEFORE the narrative is authored — that half is then reported, not judged. */
  specSetup?: SpecSetupBlock | null;
}

const INTERACTIVE_ROLES = new Set(['review-action', 'review', 'decision']);

function isInteractive(d: ResetDashboardRef): boolean {
  if (d.interactive === true) return true;
  return INTERACTIVE_ROLES.has((d.role ?? '').trim().toLowerCase().replace(/_/g, '-'));
}

const RESET_HINT =
  'Register the per-render reset in the handoff: set source.render_reset = {required: true, run_id: ' +
  '<the interactive run>, state_keys: <workflow_get -> saved_runs.snapshot_inputs.state_keys>, command: ' +
  '"npx tsx <ace-root>/scripts/reset-labs-run-state.ts --run-id <id> --keys <k1,k2>"}, and author the ' +
  'spec\'s setup block as {command: "<that command> && <the realize command>", rerun: per_render}. ' +
  'rerun: once is what let iteration 0 pass and every later iteration abort (ace#2297).';

/**
 * A demo with a state-mutating surface must carry a registered per-render
 * reset — in the handoff AND in the authored spec's `setup` block.
 *
 * Both halves are load-bearing and each is a no-op without the other: a
 * registered reset the spec never runs changes nothing, and `rerun: per_render`
 * over a command that only re-emits `realized.json` re-derives the same data
 * while leaving the run's `spawned_tasks` exactly as the last take left them.
 */
export function checkRenderResetRegistered(input: RenderResetCheckInput): QACheckResult {
  const interactive = input.dashboards.filter(isInteractive);
  if (interactive.length === 0) {
    return {
      pass: true,
      detail: 'no interactive dashboard — no state-mutating surface for a render to leave dirty',
    };
  }
  const names = interactive.map((d) => d.key).join(', ');
  const problems: string[] = [];
  const reset = input.renderReset ?? undefined;

  if (!reset || reset.required !== true) {
    problems.push(
      `dashboard(s) ${names} are interactive but source.render_reset.required is not true — the ` +
        'reset is unregistered, so a re-render films a world the previous take already mutated',
    );
  } else {
    if (!Number.isInteger(reset.run_id)) {
      problems.push('source.render_reset.run_id is missing or not an integer');
    }
    if (!reset.state_keys || reset.state_keys.length === 0) {
      problems.push(
        'source.render_reset.state_keys is empty — labs shallow-merges run state, so a reset that ' +
          'names no key is a silent no-op',
      );
    }
    if (!reset.command || reset.command.trim() === '') {
      problems.push('source.render_reset.command is empty — nothing for the spec setup block to run');
    }
  }

  let specNote = '';
  if (input.specSetup === undefined) {
    specNote = ' (spec setup block not supplied — that half not judged)';
  } else {
    const setup = input.specSetup ?? undefined;
    if (!setup) {
      problems.push(
        'the authored spec has NO setup block, so nothing runs before a render — a state-mutating ' +
          'demo needs setup.rerun: per_render',
      );
    } else {
      if ((setup.rerun ?? 'per_render') !== 'per_render') {
        problems.push(
          `spec setup.rerun is '${setup.rerun}' — per_render is required for a state-mutating demo; ` +
            'once skips the command whenever the outputs file already exists, which is exactly the ' +
            'second render',
        );
      }
      const command = setup.command ?? '';
      if (command.trim() === '') {
        problems.push('the spec setup.command is empty');
      } else if (reset?.command && !command.includes(reset.command.trim())) {
        problems.push(
          'the spec setup.command does not contain the registered reset command — the setup runs ' +
            'per_render but resets nothing',
        );
      }
    }
  }

  if (problems.length === 0) {
    return {
      pass: true,
      detail: `per-render reset registered for interactive dashboard(s) ${names}${specNote}`,
    };
  }
  return { pass: false, detail: problems.join('; ') + specNote, auto_fix_hint: RESET_HINT };
}
