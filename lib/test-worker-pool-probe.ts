/**
 * test_worker_pool probe (scripts/doctor-test-worker-pool.ts is the CLI) — is
 * the Connect test-worker pool lock live for ACE, and does this machine hold
 * credentials for every slot it could be handed? (ace#2955)
 *
 * While the `test-worker` capability is unpublished or ungranted, every device
 * session runs UNLOCKED as worker-1 (lib/test-worker-lease.ts's rollout
 * fallback) — today's behaviour, which lets two sessions on two machines sign
 * each other out (ace#2934). The fallback warns at the call site; this probe
 * is what keeps it from persisting silently. One read-only GET; never acquires
 * (an acquire would lock a worker someone may need).
 */
import { aceEnvValue, canopyApiBase, canopyToken } from './ace-canopy-pat.js';
import { POOL_ENV, loadTestWorkerPool } from './test-worker-pool.js';
import { ISSUE, PUBLISH_CMD } from './test-worker-lease.js';
import {
  LEASE_AGENT,
  TEST_WORKER_CAPABILITY,
  normalizeCapabilities,
  routePath,
} from '../mcp/mobile/backends/lease-contract.js';

export interface PoolProbeVerdict {
  status: 'pass' | 'warn';
  summary: string;
  remediation?: string;
}

const FALLBACK = `every device session runs UNLOCKED as worker-1 (${ISSUE} rollout fallback)`;

/** Pure: the verdict from the capability read and this machine's credential slots. */
export function classifyTestWorkerPool(r: {
  hasToken: boolean;
  status?: number;
  body?: unknown;
  networkError?: string;
  /** Slots this machine has credentials for, or an error string when the pool JSON is broken. */
  localSlots: string[] | string;
}): PoolProbeVerdict {
  if (typeof r.localSlots === 'string') {
    return {
      status: 'warn',
      summary: `the local worker pool is invalid: ${r.localSlots}`,
      remediation: 'fix the 1Password item connect-test-workers (pool-json), then /ace:setup --force-env — skills/test-worker-pool/SKILL.md',
    };
  }
  const local = r.localSlots;
  if (!r.hasToken) {
    return {
      status: 'warn',
      summary: `no CANOPY_WEB_PAT in ACE's .env, so the pool lock cannot be taken — ${FALLBACK}`,
      remediation: "run /ace:setup --force-env (CANOPY_WEB_PAT comes from the canopy-pat item in the ACE instance's vault)",
    };
  }
  if (r.networkError) {
    return { status: 'warn', summary: `cannot reach canopy-web (${r.networkError})`, remediation: 'check network/VPN and CANOPY_WEB_API_URL' };
  }
  if (r.status !== 200) {
    return {
      status: 'warn',
      summary: `GET agent capabilities → HTTP ${r.status}; the pool lock state is unknown`,
      remediation: 'run /ace:doctor capability_lease for the same route\'s diagnosis',
    };
  }
  const cap = normalizeCapabilities(r.body).find((c) => c.name === TEST_WORKER_CAPABILITY);
  if (!cap) {
    return {
      status: 'warn',
      summary: `${LEASE_AGENT}/${TEST_WORKER_CAPABILITY} is NOT published on canopy-web — ${FALLBACK}`,
      remediation: `publish it (owner-approved): ${PUBLISH_CMD}; then a workspace admin grants it — skills/test-worker-pool/SKILL.md`,
    };
  }
  if (!cap.granted) {
    return {
      status: 'warn',
      summary: `${LEASE_AGENT}/${TEST_WORKER_CAPABILITY} is published but NOT granted — ${FALLBACK}` + (cap.grantHint ? ` (${cap.grantHint})` : ''),
      remediation: `a workspace admin grants agent "${LEASE_AGENT}" the "${TEST_WORKER_CAPABILITY}" capability in ACE's canopy-web workspace`,
    };
  }
  const missing = cap.slots.filter((s) => !local.includes(s));
  if (missing.length) {
    return {
      status: 'warn',
      summary:
        `the pool declares ${cap.slots.join(', ')} but this machine has no credentials for ${missing.join(', ')} — ` +
        'a checkout handed one of those fails TEST_WORKER_NO_CREDENTIALS',
      remediation: `add them to connect-test-workers (${POOL_ENV}), then /ace:setup --force-env and restart Claude Code`,
    };
  }
  return {
    status: 'pass',
    summary:
      `${LEASE_AGENT}/${TEST_WORKER_CAPABILITY} live: ${cap.slots.length} slot(s) (${cap.slots.join(', ')}), ` +
      `${cap.liveLeases} checked out, credentials here for all`,
  };
}

/** The env the MCP would see: ACE's .env values for the pool keys, over process.env. */
function poolEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of [POOL_ENV, 'ACE_E2E_PHONE', 'ACE_E2E_PHONE_LOCAL', 'ACE_E2E_COUNTRY_CODE', 'ACE_E2E_PIN', 'ACE_E2E_BACKUP_CODE', 'ACE_E2E_NAME']) {
    if (!env[k]) {
      const v = aceEnvValue(k);
      if (v) env[k] = v;
    }
  }
  return env;
}

export async function probeTestWorkerPool(fetchImpl: typeof fetch = fetch): Promise<PoolProbeVerdict> {
  let localSlots: string[] | string;
  try {
    localSlots = [...loadTestWorkerPool(poolEnv()).keys()];
  } catch (e) {
    localSlots = (e as Error).message;
  }
  const token = canopyToken();
  if (!token) return classifyTestWorkerPool({ hasToken: false, localSlots });
  const url = `${canopyApiBase()}${routePath('agentCapabilities', { slug: LEASE_AGENT })}`;
  try {
    const res = await fetchImpl(url, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    return classifyTestWorkerPool({ hasToken: true, status: res.status, body, localSlots });
  } catch (e) {
    return classifyTestWorkerPool({ hasToken: true, networkError: (e as Error).message, localSlots });
  }
}
