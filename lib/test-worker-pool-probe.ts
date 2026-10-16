/**
 * test_worker_pool probe (scripts/doctor-test-worker-pool.ts is the CLI) — is
 * the Connect test-worker pool lock live for ACE, and does every slot it could
 * hand out carry its credentials on canopy-web? (ace#2955)
 *
 * While the `test-worker` capability is unpublished or ungranted, every device
 * session runs UNLOCKED as the legacy ACE_E2E_* worker (lib/test-worker-lease.ts's
 * rollout fallback) — the pre-pool behaviour, which lets two sessions on two
 * machines sign each other out (ace#2934). The fallback warns at the call
 * site; this probe is what keeps it from persisting silently.
 *
 * Two read-only GETs: the agent's capabilities, and the pool's MASKED slot
 * list (public values + secret KEY names). It never acquires (an acquire would
 * lock a worker someone may need, and is the only call that returns secrets).
 */
import { canopyToken } from './ace-canopy-pat.js';
import { ISSUE, PUBLISH_CMD } from './test-worker-lease.js';
import { fetchSlotDataReport, slotHttpConfig, type SlotDataReport } from './test-worker-slots.js';
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

const FALLBACK = `every device session runs UNLOCKED as the legacy ACE_E2E_* worker (${ISSUE} rollout fallback)`;
const SET_FIX =
  'store each slot\'s data as ACE: npx tsx scripts/test-worker-set.ts --slot worker-N … (secrets via --pin-env/--backup-code-env); ' +
  '--list shows what each slot has — skills/test-worker-pool/SKILL.md';

/** Pure: the verdict from the capability read and the masked slot-data report. */
export function classifyTestWorkerPool(r: {
  hasToken: boolean;
  status?: number;
  body?: unknown;
  networkError?: string;
  /** The masked slot-data report; omitted when it was not read. */
  slots?: SlotDataReport;
}): PoolProbeVerdict {
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
      remediation: "run /ace:doctor capability_lease for the same route's diagnosis",
    };
  }
  const cap = normalizeCapabilities(r.body).find((c) => c.name === TEST_WORKER_CAPABILITY);
  if (!cap) {
    return {
      status: 'warn',
      summary: `${LEASE_AGENT}/${TEST_WORKER_CAPABILITY} is NOT published on canopy-web — ${FALLBACK}`,
      remediation: `publish it: ${PUBLISH_CMD}; then a workspace admin grants it — skills/test-worker-pool/SKILL.md`,
    };
  }
  const slotGap = r.slots && !r.slots.ok ? r.slots.summary : null;
  if (!cap.granted) {
    return {
      status: 'warn',
      summary:
        `${LEASE_AGENT}/${TEST_WORKER_CAPABILITY} is published but NOT granted — ${FALLBACK}` +
        (cap.grantHint ? ` (${cap.grantHint})` : '') +
        (slotGap ? `; slot data: ${slotGap}` : ''),
      remediation:
        `a workspace admin grants agent "${LEASE_AGENT}" the "${TEST_WORKER_CAPABILITY}" capability in ACE's canopy-web workspace` +
        (slotGap ? `; and ${SET_FIX}` : ''),
    };
  }
  if (slotGap) {
    return {
      status: 'warn',
      summary:
        `the pool declares ${cap.slots.join(', ')}, but slot data is incomplete — ${slotGap}; ` +
        'a checkout handed such a slot fails TEST_WORKER_NO_CREDENTIALS',
      remediation: SET_FIX,
    };
  }
  return {
    status: 'pass',
    summary:
      `${LEASE_AGENT}/${TEST_WORKER_CAPABILITY} live: ${cap.slots.length} slot(s) (${cap.slots.join(', ')}), ` +
      `${cap.liveLeases} checked out, every slot carries its credentials on canopy-web`,
  };
}

export async function probeTestWorkerPool(fetchImpl: typeof fetch = fetch, token: string | null = canopyToken()): Promise<PoolProbeVerdict> {
  if (!token) return classifyTestWorkerPool({ hasToken: false });
  const cfg = slotHttpConfig({ token, fetchImpl, retry: { retries: 0 } })!;
  const url = `${cfg.baseUrl}${routePath('agentCapabilities', { slug: LEASE_AGENT })}`;
  let status: number;
  let body: unknown;
  try {
    const res = await fetchImpl(url, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    status = res.status;
    const text = await res.text();
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
  } catch (e) {
    return classifyTestWorkerPool({ hasToken: true, networkError: (e as Error).message });
  }
  const cap = status === 200 ? normalizeCapabilities(body).find((c) => c.name === TEST_WORKER_CAPABILITY) : undefined;
  // The masked slot list only (never an acquire): declared slots vs. their data.
  const slots = cap ? await fetchSlotDataReport(cfg, cap.slots) : undefined;
  return classifyTestWorkerPool({ hasToken: true, status, body, slots });
}
