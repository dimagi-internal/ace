// canopy-web capability-broker HTTP, shared by every ACE client of the broker:
// the android-emulator lease (`lease.ts`) and the test-worker pool lock
// (`lib/test-worker-lease.ts`, ace#2955). One request path, one retry policy,
// one mapping of the broker's failure statuses to typed errors — so a second
// capability does not grow a second HTTP client that drifts from the first.
//
// Route strings live in `lease-contract.ts`, never here.

import { spawnSync } from 'node:child_process';
import { MobileError } from '../errors.js';
import { LEASE_AGENT, LEASE_CAPABILITY } from './lease-contract.js';
import { fetchWithRetry, type Problem, type RetryConfig } from './remote-io.js';

/**
 * The restore after a lost machine. One sentence, used by every LEASE_LOST /
 * LEASE_NOT_FOUND path, because the part a caller gets wrong is the second
 * half: a fresh machine is a fresh device, so the prerequisite recipes must
 * run again before the step is repeated.
 */
export const LEASE_RESTORE_HINT =
  'Re-run mobile_ensure_avd_running for a fresh machine, then the prerequisite recipes ' +
  '(connect-login, then connect-resume-opp or connect-claim-opp) before repeating the step — ' +
  'login, claim and Learn state do not survive onto a new machine. A lease is released after ' +
  'idle_release_s (900 s) with no call: keep LLM-heavy work (Drive uploads, PRs) out of the gap ' +
  'between device ops, or bridge a long gap with mobile_diagnose.';

export interface BrokerHttpConfig {
  baseUrl: string;
  token: string;
  fetchImpl: typeof fetch;
  requestTimeoutMs: number;
  retry: RetryConfig;
  /** The capability named in typed errors (default `android-emulator`). */
  capability?: string;
  /** Called whenever the broker answered at all — every answered call resets its idle clock. */
  onAnswered?: () => void;
}

/**
 * One broker call: JSON in, JSON out, typed errors on failure. `retry: false`
 * sends a non-idempotent POST once (an acquire retried on a gateway 5xx could
 * queue a second lease, an exec retried could run twice). `ambiguous` names
 * an exec whose lost answer must surface as LEASE_EXEC_AMBIGUOUS.
 */
export async function brokerRequest<T>(
  cfg: BrokerHttpConfig,
  method: string,
  routePathStr: string,
  body?: unknown,
  opts: { retry?: boolean; ambiguous?: string } = {},
): Promise<T> {
  const url = `${cfg.baseUrl}${routePathStr}`;
      const headers = new Headers({ authorization: `Bearer ${cfg.token}`, accept: 'application/json' });
      const init: RequestInit = { method, headers, signal: AbortSignal.timeout(cfg.requestTimeoutMs) };
      if (body !== undefined) {
        headers.set('content-type', 'application/json');
        init.body = JSON.stringify(body);
      }
      // Non-idempotent POSTs are sent once: an acquire retried on a gateway 5xx
      // could queue a second lease, an exec retried could run twice.
      const retry = opts.retry === false ? { ...cfg.retry, retries: 0 } : cfg.retry;
      const { response, lastError, attempts } = await fetchWithRetry(cfg.fetchImpl, url, init, retry);
      if (response) cfg.onAnswered?.();
      if (!response) {
        if (opts.ambiguous) throw execAmbiguous(opts.ambiguous, `no answer (${(lastError as Error)?.message ?? 'transport error'})`);
        throw new MobileError(
          'LEASE_FETCH_FAILED',
          `${method} ${url} failed after ${attempts} attempt(s): ${(lastError as Error)?.message ?? 'unknown error'}`,
          'Check network reachability of canopy-web (CANOPY_WEB_API_URL) and run /ace:doctor (capability_lease).',
        );
      }
      const text = await response.text();
      let payload: unknown = undefined;
      let parsed = true;
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          parsed = false;
        }
      }
      if (!response.ok) {
        const problem = (parsed && payload && typeof payload === 'object' ? payload : {}) as Problem;
        if (opts.ambiguous && response.status >= 500) {
          // canopy-web's own 502 names a SendCommand that FAILED — not sent, not
          // ambiguous. A gateway's 5xx (or any unreadable one) says nothing.
          const said = `${problem.title ?? ''} ${problem.detail ?? ''}`;
          if (!/could not send the command/i.test(said)) {
            throw execAmbiguous(opts.ambiguous, `HTTP ${response.status}${said.trim() ? `: ${said.trim()}` : ''}`);
          }
        }
        throw leaseHttpError(response.status, problem, method, routePathStr, cfg.capability);
      }
      if (!parsed) {
        if (opts.ambiguous) throw execAmbiguous(opts.ambiguous, `non-JSON ${response.status} answer`);
        throw new MobileError('LEASE_BAD_RESPONSE', `non-JSON response from ${method} ${url} (status ${response.status})`);
      }
      return payload as T;
}

/** The exec may or may not have started: never retried, the caller looks at the device first. */
function execAmbiguous(cmd: string, why: string): MobileError {
  return new MobileError(
    'LEASE_EXEC_AMBIGUOUS',
    `ace-mobile ${cmd}: the broker's answer to the exec was lost (${why}) — the command may or may not be running on the machine`,
    'It was NOT retried (a retry could run it twice, and a Learn walk is one-way). Check the device before ' +
      'repeating anything: mobile_capture_ui_dump for the screen, and for a walk connect_get_learn_progress. ' +
      'Repeat the step only if the device shows it did not run.',
  );
}

/** Typed errors for the broker's failure statuses (spec §3/§4). */
export function leaseHttpError(
  status: number,
  problem: Problem,
  method: string,
  route: string,
  capability: string = LEASE_CAPABILITY,
): MobileError {
  // canopy-web's bare HttpError puts the same text in title and detail.
  const said = [...new Set([problem.title, problem.detail].filter(Boolean))].join(' — ');
  const where = `${method} ${route.split('?')[0]}`;
  const path = route.split('?')[0];
  const isLeaseRoute = /^\/api\/capabilities\/leases\/[^/]+/.test(path);
  switch (status) {
    case 401:
      return new MobileError(
        'LEASE_AUTH',
        `canopy-web rejected ACE's PAT on ${where}${said ? `: ${said}` : ''}`,
        "Re-mint ACE's canopy-web PAT (canopy-pat in the ACE instance's 1Password vault) and run /ace:setup --force-env.",
      );
    case 403:
      // canopy-web answers 403 for two different things: no CapabilityGrant
      // ("… has no grant for capability …"), and a caller below the editor
      // role ("leasing ace's capabilities needs the editor role …").
      if (/editor role|own login/i.test(said)) {
        return new MobileError(
          'LEASE_FORBIDDEN',
          `${where}: this PAT may not lease ${LEASE_AGENT}'s capabilities${said ? `: ${said}` : ''}`,
          "Use ACE's own PAT (CANOPY_WEB_PAT in ACE's .env), or a member PAT with the editor role in ACE's workspace.",
        );
      }
      return new MobileError(
        'LEASE_NO_GRANT',
        `no capability grant lets ${LEASE_AGENT} lease ${capability}${said ? `: ${said}` : ''}`,
        `A workspace admin must grant agent "${LEASE_AGENT}" the "${capability}" capability in ACE's ` +
          'canopy-web workspace (PUT /api/capabilities/grants). /ace:doctor capability_lease shows the grant state.',
      );
    case 404:
      return isLeaseRoute
        ? new MobileError(
            'LEASE_NOT_FOUND',
            `${where}: not found${said ? ` (${said})` : ''}`,
            `The lease is gone (released, idled out, expired or swept). ${LEASE_RESTORE_HINT}`,
          )
        : new MobileError(
            'LEASE_AGENT_NOT_VISIBLE',
            `${where}: ${said || 'not found'}`,
            `canopy-web hides agent "${LEASE_AGENT}" from this PAT, or predates the capability broker — ` +
              'run /ace:doctor (capability_lease).',
          );
    case 409:
      return new MobileError('LEASE_LOST', `${where}: ${said || 'the lease is not ready'}`, LEASE_RESTORE_HINT);
    case 422: {
      const validation = problem.extras && 'errors' in problem.extras;
      if (!validation && /declares no capability|is not brokered/.test(said)) {
        return new MobileError(
          'LEASE_UNDECLARED',
          `${LEASE_AGENT} has not declared ${capability} on canopy-web${said ? `: ${said}` : ''}`,
          capability === LEASE_CAPABILITY
            ? 'Publish the manifest: infra/capabilities/android-emulator/deploy.sh (runs canopy-runtime publish-capabilities).'
            : `Publish ACE's capability manifests: canopy-runtime publish-capabilities --spec runtime.yaml --agent ${LEASE_AGENT}.`,
        );
      }
      return new MobileError(
        'LEASE_INVALID_REQUEST',
        `${where}: ${said || 'request refused'}` +
          (validation ? `: ${JSON.stringify(problem.extras?.errors)}` : ''),
        'A param outside the manifest (e.g. an unknown state — see mobile_list_avds), a stale CANOPY_TURN_ID, ' +
          'or argv/upload names the broker refuses.',
      );
    }
    default:
      return new MobileError(`LEASE_HTTP_${status}`, `${where} returned ${status}${said ? `: ${said}` : ''}`);
  }
}

/**
 * Exit-time release. `'exit'` listeners must be synchronous, so this blocks
 * on curl for at most a few seconds. The PAT goes on stdin (`-H @-`), never
 * argv, where any local process could read it (ace#1114).
 */
export function curlDeleteSync(url: string, token: string): void {
  spawnSync('curl', ['-sS', '-o', '/dev/null', '--max-time', '5', '-X', 'DELETE', '-H', '@-', url], {
    input: `Authorization: Bearer ${token}\n`,
    timeout: 7_000,
    stdio: ['pipe', 'ignore', 'ignore'],
  });
}
