/**
 * Reset a LIVE connect-labs workflow run's mutable state, so the next render
 * of a state-mutating demo scene finds the world as the first take found it.
 *
 * Run (this is what a DDD spec's `setup.command` invokes, `rerun: per_render`):
 *
 *   npx tsx scripts/reset-labs-run-state.ts --run-id 5508 --keys worker_states,spawned_tasks
 *
 * Why it is a committed script rather than a file in the run directory
 * (dimagi-internal/ace#2297): the reset used to live as `reset_and_realize.py`
 * inside the DDD run dir, which is not worktree-portable (ace#2287), is not
 * committed, and is swept. Three iterations of `spark-facilitator/20260908-2215`
 * passed only because a human had run that reset by hand, leaving no trace in
 * `run_state.yaml` or any artifact.
 *
 * The mechanics and the four labs-side facts behind them are documented in
 * `lib/labs-run-state-reset.ts` and `playbook/integrations/connect-labs.md
 * § Resetting a live run's state between renders`.
 *
 * Auth: the labs UI session persisted by `/ace:labs-login` at
 * `~/.ace/labs-session.json` (a Playwright storage_state). This endpoint is
 * `@login_required` + CSRF-protected — the MCP PAT is for `/mcp/` only and
 * does not work here.
 *
 * Exit codes: 0 = every run reset, 1 = any failure (with the class named).
 */
import { readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  LABS_BASE_URL,
  buildResetBody,
  classifyResetResponse,
  extractCsrfToken,
  runStateApiPath,
} from '../lib/labs-run-state-reset.js';
import { loadPluginEnv } from '../lib/load-plugin-env.js';

// A Bash tool call inherits none of ACE's secrets (ace#1964); this script is
// reachable from `demo-data-setup` and reads `LABS_BASE_URL`.
loadPluginEnv(import.meta.url);

interface StorageStateCookie {
  name: string;
  value: string;
  domain?: string;
}

interface StorageState {
  cookies?: StorageStateCookie[];
}

function log(msg: string): void {
  process.stdout.write(`[reset-labs-run-state] ${msg}\n`);
}

function fail(msg: string): never {
  process.stderr.write(`[reset-labs-run-state] ERROR: ${msg}\n`);
  process.exit(1);
}

interface Args {
  runIds: number[];
  keys: string[];
  baseline: Record<string, unknown>;
  baseUrl: string;
  sessionPath: string;
  /** Page to read the CSRF token from; defaults to the run-detail page per run. */
  pageUrl?: string;
}

function parseArgs(argv: string[]): Args {
  const runIds: number[] = [];
  let keys: string[] = [];
  let baseline: Record<string, unknown> = {};
  let baseUrl = process.env.LABS_BASE_URL ?? LABS_BASE_URL;
  let sessionPath = path.join(os.homedir(), '.ace', 'labs-session.json');
  let pageUrl: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined) fail(`${arg} needs a value`);
      i += 1;
      return v;
    };
    switch (arg) {
      case '--run-id':
        for (const part of next().split(',')) {
          const n = Number(part.trim());
          if (!Number.isInteger(n)) fail(`--run-id must be an integer (got ${part})`);
          runIds.push(n);
        }
        break;
      case '--keys':
        keys = next()
          .split(',')
          .map((k) => k.trim())
          .filter(Boolean);
        break;
      case '--baseline':
        // JSON object of `{key: clearedValue}` for keys whose empty is not `{}`.
        baseline = JSON.parse(readFileSync(next(), 'utf8')) as Record<string, unknown>;
        break;
      case '--base-url':
        baseUrl = next();
        break;
      case '--session':
        sessionPath = next();
        break;
      case '--page-url':
        // Any authenticated labs page carries the token (base.html renders
        // `{% csrf_token %}`); pass the dashboard's own par_url when in doubt.
        pageUrl = next();
        break;
      case '--help':
      case '-h':
        process.stdout.write(
          'Usage: npx tsx scripts/reset-labs-run-state.ts --run-id <id[,id]> --keys <k1,k2> ' +
            '[--baseline <json-file>] [--page-url <url>] [--base-url <url>] ' +
            '[--session <storage-state.json>]\n',
        );
        process.exit(0);
        break;
      default:
        fail(`unknown argument: ${arg}`);
    }
  }

  if (runIds.length === 0) fail('--run-id is required');
  if (keys.length === 0) {
    fail(
      '--keys is required. labs shallow-merges run state, so a reset that names no key writes ' +
        'nothing; read the keys from workflow_get -> saved_runs.snapshot_inputs.state_keys',
    );
  }
  return { runIds, keys, baseline, baseUrl, sessionPath, pageUrl };
}

function cookieHeader(sessionPath: string, baseUrl: string): string {
  let raw: string;
  try {
    raw = readFileSync(sessionPath, 'utf8');
  } catch {
    return fail(`no labs session at ${sessionPath} — run /ace:labs-login first`);
  }
  const state = JSON.parse(raw) as StorageState;
  const host = new URL(baseUrl).hostname;
  const cookies = (state.cookies ?? []).filter((c) => {
    const domain = (c.domain ?? '').replace(/^\./, '');
    return domain === '' || host === domain || host.endsWith(`.${domain}`);
  });
  if (cookies.length === 0) fail(`labs session at ${sessionPath} carries no cookies for ${host}`);
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

async function resetRun(runId: number, args: Args, cookie: string): Promise<boolean> {
  // labs sets no csrftoken cookie (CSRF_USE_SESSIONS=True), so read the token
  // out of a rendered page's csrfmiddlewaretoken input.
  const pageUrl = args.pageUrl ?? `${args.baseUrl}/labs/workflow/run/${runId}/`;
  const page = await fetch(pageUrl, { headers: { Cookie: cookie }, redirect: 'follow' });
  const html = await page.text();
  const token = extractCsrfToken(html);
  if (!token) {
    process.stderr.write(
      `[reset-labs-run-state] ERROR: no csrfmiddlewaretoken in ${pageUrl} (HTTP ${page.status}) — ` +
        'the session is probably stale (a logged-out response redirects to the login page); ' +
        're-run /ace:labs-login\n',
    );
    return false;
  }

  const body = buildResetBody(args.keys, args.baseline);
  const url = `${args.baseUrl}${runStateApiPath(runId)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Cookie: cookie,
      'Content-Type': 'application/json',
      'X-CSRFToken': token,
      Referer: pageUrl,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const verdict = classifyResetResponse(res.status, text);
  if (verdict.outcome === 'ok') {
    log(`run ${runId}: cleared ${args.keys.join(', ')}`);
    return true;
  }
  process.stderr.write(`[reset-labs-run-state] ERROR: run ${runId}: ${verdict.outcome} — ${verdict.detail}\n`);
  return false;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cookie = cookieHeader(args.sessionPath, args.baseUrl);
  let ok = true;
  for (const runId of args.runIds) {
    // Sequential on purpose: the endpoint read-modify-writes the run record,
    // so concurrent writes to the same run would race.
    // eslint-disable-next-line no-await-in-loop
    const done = await resetRun(runId, args, cookie);
    ok = ok && done;
  }
  if (!ok) process.exit(1);
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
