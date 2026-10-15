/**
 * capability_lease probe logic (scripts/doctor-capability-lease.ts is the CLI) — can THIS machine lease ACE's
 * `android-emulator` from canopy-web, for the CommCare its selector map is for?
 *
 * Two read-only GETs, as ACE (its own canopy-web PAT, lib/ace-canopy-pat.ts):
 *   1. the agent-capabilities route — declared? granted? the stack's Outputs
 *      present? live leases? and is `cc-<ACE_CONNECT_APK_VERSION>` in the
 *      manifest's state enum (the lease refuses LEASE_STATE_UNAVAILABLE
 *      otherwise, so a run would die at Phase 6's first ensure);
 *   2. a lease GET for a lease that cannot exist, with an out-of-range
 *      `?wait_s=99` — a broker that long-polls validates the param (422),
 *      one that predates it ignores it and answers 404. Informational: the
 *      client falls back to short polling either way.
 * NEVER acquires — a probe that launched a machine to prove it could would
 * cost ~5 minutes of EC2 per /ace:doctor.
 *
 * Also prints which mobile backend the default would pick here (local iff a
 * provisioned AVD exists, else lease — backend-toggle.ts), because the lease
 * failing only matters when the lease is what a run will use.
 *
 *   --format=lines  PASS/WARN/INFO lines for bin/ace-doctor (default)
 *   --format=json   the verdict object
 */
import { aceEnvValue, canopyApiBase, canopyToken } from './ace-canopy-pat.js';
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
  /** The state the client would lease (`cc-<apk version>`) and whether the manifest bakes it. */
  wantedState?: string | null;
  stateBaked?: boolean | null;
  /** Whether the broker long-polls `?wait_s` (null = not determined). */
  longPoll?: boolean | null;
}

/** Read the long-poll answer: 422 naming wait_s → supported; 404 → ignored; else unknown. */
export function classifyLongPoll(r: { status?: number; body?: unknown }): boolean | null {
  if (r.status === 422) return /wait_s/.test(JSON.stringify(r.body ?? ''));
  if (r.status === 404) return false;
  return null;
}

const DEPLOY = 'infra/capabilities/android-emulator/deploy.sh (stack + canopy-runtime publish-capabilities)';

/** Pure: turn the HTTP answers into a verdict. Exported for the test. */
export function classifyCapabilityLease(r: {
  url: string;
  status?: number;
  body?: unknown;
  networkError?: string;
  hasToken: boolean;
  /** The selector-map version (ACE_CONNECT_APK_VERSION); its `cc-` state must be baked. */
  apkVersion?: string | null;
  longPoll?: boolean | null;
}): LeaseProbeVerdict {
  const none = { declared: null, granted: null, liveLeases: null };
  if (!r.hasToken) {
    return {
      status: 'warn',
      ...none,
      summary: "no CANOPY_WEB_PAT in ACE's .env — the lease mobile backend cannot authenticate",
      remediation: 'run /ace:setup --force-env (CANOPY_WEB_PAT comes from the canopy-pat item in the ACE instance\'s 1Password vault)',
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
        remediation: "re-mint ACE's canopy-web PAT (canopy-pat in the ACE instance's 1Password vault), then /ace:setup --force-env",
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
  const wantedState = r.apkVersion ? `cc-${r.apkVersion}` : null;
  const stateBaked = wantedState && cap.states.length ? cap.states.includes(wantedState) : null;
  const longPoll = r.longPoll ?? null;
  const extras = { wantedState, stateBaked, longPoll };
  if (stateBaked === false) {
    return {
      status: 'warn',
      declared: true,
      granted: true,
      liveLeases: cap.liveLeases,
      ...extras,
      summary:
        `${LEASE_AGENT}/${LEASE_CAPABILITY} does not bake ${wantedState} (baked: ${cap.states.join(', ')}) — ` +
        `the selector map in force is ${r.apkVersion} (ACE_CONNECT_APK_VERSION), so every lease would refuse LEASE_STATE_UNAVAILABLE`,
      remediation:
        `bake it: add "${r.apkVersion}" to commcare_versions in infra/capabilities/android-emulator/image/variables.pkr.hcl ` +
        'and params.state in capability.yaml, run bake.sh, then deploy.sh; until then use the local AVD (/ace:mobile-backend local)',
    };
  }
  return {
    status: 'pass',
    declared: true,
    granted: true,
    liveLeases: cap.liveLeases,
    ...extras,
    summary:
      `${LEASE_AGENT}/${LEASE_CAPABILITY} declared + granted` +
      (cap.maxConcurrent ? `, max_concurrent ${cap.maxConcurrent}` : '') +
      `, ${cap.liveLeases} live lease(s)` +
      (cap.states.length ? `, states ${cap.states.join('/')}` : '') +
      (wantedState ? `, ${wantedState} baked` : '') +
      (cap.stack ? `, stack ${cap.stack}` : '') +
      (cap.missingOutputs ? ', stack Outputs complete' : '') +
      (longPoll === true ? ', long-poll yes' : longPoll === false ? ', long-poll no (client short-polls)' : ''),
  };
}

/** The selector-map version a run here would use: ACE's .env, else the shipped default. */
async function configuredApkVersion(): Promise<string | null> {
  const fromEnv = (process.env.ACE_CONNECT_APK_VERSION ?? '').trim() || aceEnvValue('ACE_CONNECT_APK_VERSION');
  if (fromEnv) return fromEnv;
  try {
    return (await import('../mcp/mobile/client.js')).DEFAULT_APK_VERSION;
  } catch {
    return null;
  }
}

/** A lease id no broker will ever have issued (the nil UUID). */
const NO_SUCH_LEASE = '00000000-0000-0000-0000-000000000000';

async function getJson(fetchImpl: typeof fetch, url: string, token: string): Promise<{ status: number; body: unknown }> {
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
  return { status: res.status, body };
}

export async function probeCapabilityLease(fetchImpl: typeof fetch = fetch): Promise<LeaseProbeVerdict> {
  const token = canopyToken();
  const base = canopyApiBase();
  const url = `${base}${routePath('agentCapabilities', { slug: LEASE_AGENT })}`;
  if (!token) return classifyCapabilityLease({ url, hasToken: false });
  const apkVersion = await configuredApkVersion();
  let main: { status: number; body: unknown };
  try {
    main = await getJson(fetchImpl, url, token);
  } catch (e) {
    return classifyCapabilityLease({ url, networkError: (e as Error).message, hasToken: true, apkVersion });
  }
  let longPoll: boolean | null = null;
  if (main.status === 200) {
    try {
      longPoll = classifyLongPoll(
        await getJson(fetchImpl, `${base}${routePath('get', { lease_id: NO_SUCH_LEASE }, { wait_s: '99' })}`, token),
      );
    } catch {
      longPoll = null;
    }
  }
  return classifyCapabilityLease({ url, status: main.status, body: main.body, hasToken: true, apkVersion, longPoll });
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
