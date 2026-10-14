/**
 * capability_lease probe logic (scripts/doctor-capability-lease.ts is the CLI) — can THIS machine lease ACE's
 * `android-emulator` from canopy-web?
 *
 * One read-only GET of the agent-capabilities route (lease-contract.ts), as
 * ACE (its own canopy-web PAT, lib/ace-canopy-pat.ts). Reports what the broker
 * says: declared?, granted?, how many live leases. NEVER acquires — a probe
 * that launched a machine to prove it could would cost ~5 minutes of EC2 per
 * /ace:doctor.
 *
 * Also prints which mobile backend the default would pick here (local iff a
 * provisioned AVD exists, else lease — backend-toggle.ts), because the lease
 * failing only matters when the lease is what a run will use.
 *
 *   --format=lines  PASS/WARN/INFO lines for bin/ace-doctor (default)
 *   --format=json   the verdict object
 */
import { canopyApiBase, canopyToken } from './ace-canopy-pat.js';
import {
  LEASE_AGENT,
  LEASE_CAPABILITY,
  normalizeCapabilities,
  routePath,
} from '../mcp/mobile/backends/lease-contract.js';
import { provisionedAvds, selectionAvdHome } from '../mcp/mobile/backend-toggle.js';

export interface LeaseProbeVerdict {
  status: 'pass' | 'warn';
  summary: string;
  remediation?: string;
  declared: boolean | null;
  granted: boolean | null;
  liveLeases: number | null;
}

const DEPLOY = 'infra/capabilities/android-emulator/deploy.sh (stack + canopy-runtime publish-capabilities)';

/** Pure: turn the one HTTP answer into a verdict. Exported for the test. */
export function classifyCapabilityLease(r: {
  url: string;
  status?: number;
  body?: unknown;
  networkError?: string;
  hasToken: boolean;
}): LeaseProbeVerdict {
  const none = { declared: null, granted: null, liveLeases: null };
  if (!r.hasToken) {
    return {
      status: 'warn',
      ...none,
      summary: "no CANOPY_WEB_PAT in ACE's .env — the lease mobile backend cannot authenticate",
      remediation: 'run /ace:setup --force-env (CANOPY_WEB_PAT comes from 1Password Agent-Ace/canopy-pat)',
    };
  }
  if (r.networkError) {
    return {
      status: 'warn',
      ...none,
      summary: `cannot reach ${r.url} (${r.networkError})`,
      remediation: 'check network/VPN and CANOPY_WEB_API_URL; the lease backend needs canopy-web',
    };
  }
  switch (r.status) {
    case 200:
      break;
    case 401:
      return {
        status: 'warn',
        ...none,
        summary: `HTTP 401 — canopy-web rejected ACE's PAT`,
        remediation: "re-mint ACE's canopy-web PAT (1Password Agent-Ace/canopy-pat), then /ace:setup --force-env",
      };
    case 403:
      return {
        status: 'warn',
        ...none,
        summary: `HTTP 403 — ACE's PAT may not read agent "${LEASE_AGENT}"'s capabilities`,
        remediation: `the PAT must be ACE's own account or a member of ACE's canopy-web workspace`,
      };
    case 404:
      return {
        status: 'warn',
        ...none,
        summary: `HTTP 404 — ${r.url} does not exist; this canopy-web predates the capability broker (apps/capabilities)`,
        remediation: 'deploy a canopy-web with apps/capabilities, or use the local AVD (/ace:mobile-backend local)',
      };
    default:
      return {
        status: 'warn',
        ...none,
        summary: `GET ${r.url} → HTTP ${r.status}`,
        remediation: 'inspect canopy-web; retry /ace:doctor',
      };
  }
  const cap = normalizeCapabilities(r.body).find((c) => c.name === LEASE_CAPABILITY);
  if (!cap) {
    return {
      status: 'warn',
      declared: false,
      granted: null,
      liveLeases: null,
      summary: `${LEASE_AGENT}/${LEASE_CAPABILITY} is NOT declared on canopy-web (acquire would answer 422)`,
      remediation: `publish it: ${DEPLOY}`,
    };
  }
  if (cap.missingOutputs && cap.missingOutputs.length) {
    return {
      status: 'warn',
      declared: true,
      granted: cap.granted,
      liveLeases: cap.liveLeases,
      summary: `${LEASE_AGENT}/${LEASE_CAPABILITY}'s stack ${cap.stack ?? '?'} lacks Outputs ${cap.missingOutputs.join(', ')}`,
      remediation: `re-deploy the stack and republish: ${DEPLOY}`,
    };
  }
  if (!cap.granted) {
    return {
      status: 'warn',
      declared: true,
      granted: false,
      liveLeases: cap.liveLeases,
      summary:
        `${LEASE_AGENT}/${LEASE_CAPABILITY} is declared but NOT granted (acquire would answer 403)` +
        (cap.grantHint ? ` — ${cap.grantHint}` : ''),
      remediation: `a workspace admin grants agent "${LEASE_AGENT}" the "${LEASE_CAPABILITY}" capability (CapabilityGrant) in ACE's canopy-web workspace`,
    };
  }
  return {
    status: 'pass',
    declared: true,
    granted: true,
    liveLeases: cap.liveLeases,
    summary:
      `${LEASE_AGENT}/${LEASE_CAPABILITY} declared + granted` +
      (cap.maxConcurrent ? `, max_concurrent ${cap.maxConcurrent}` : '') +
      `, ${cap.liveLeases} live lease(s)` +
      (cap.states.length ? `, states ${cap.states.join('/')}` : '') +
      (cap.stack ? `, stack ${cap.stack}` : ''),
  };
}

export async function probeCapabilityLease(fetchImpl: typeof fetch = fetch): Promise<LeaseProbeVerdict> {
  const token = canopyToken();
  const url = `${canopyApiBase()}${routePath('agentCapabilities', { slug: LEASE_AGENT })}`;
  if (!token) return classifyCapabilityLease({ url, hasToken: false });
  try {
    const res = await fetchImpl(url, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    return classifyCapabilityLease({ url, status: res.status, body, hasToken: true });
  } catch (e) {
    return classifyCapabilityLease({ url, networkError: (e as Error).message, hasToken: true });
  }
}

/** Will a run on this machine use the lease by default? (env pin, else no provisioned AVD.) */
export function leaseIsDefaultHere(): boolean {
  const pin = (process.env.ACE_MOBILE_BACKEND ?? '').trim().toLowerCase();
  if (pin) return pin === 'lease';
  return provisionedAvds(selectionAvdHome()).length === 0;
}

export function defaultBackendLine(): string {
  if (process.env.ACE_MOBILE_BACKEND) {
    return `INFO mobile_backend_default: ACE_MOBILE_BACKEND=${process.env.ACE_MOBILE_BACKEND} is pinned in this shell's env`;
  }
  const home = selectionAvdHome();
  const avds = provisionedAvds(home);
  return avds.length
    ? `INFO mobile_backend_default: local (provisioned AVD ${avds.join(', ')} in ${home})`
    : `INFO mobile_backend_default: lease (no provisioned AVD in ${home}) — capability_lease above must PASS for Phase 6`;
}
