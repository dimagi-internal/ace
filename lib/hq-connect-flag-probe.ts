/**
 * Replay Nova's project-space compatibility probe for `commcare_connect` with
 * ACE's OWN HQ key, so an `unverified` Nova refusal can be attributed (ace#2704).
 *
 * Nova's probe (voidcraft-labs/commcare-nova `lib/commcare/client.ts`,
 * `probeHqProjectSpaceCompatibility` + `probePrivateFeatureFlag`) makes two
 * calls with the HQ key stored in Nova's Settings:
 *   1. GET /api/user_domains/v1/?limit=100           — target must be visible
 *   2. GET /api/user_domains/v1/?limit=100&feature_flag=commcare_connect
 * Any non-200, malformed body or 5 s timeout settles to `unverified`; an
 * empty filtered list with a visible target settles to `missing`.
 *
 * This module is the pure classifier over the two responses; the network
 * half lives in `scripts/probe-hq-connect-flag.ts`.
 */

export const CONNECT_FLAG_SLUG = 'commcare_connect';

export type ProbeLeg =
  | { ok: true; domains: string[] }
  | { ok: false; status: number | 'error' };

export type ConnectFlagVerdict =
  /** ACE's key confirms the flag: an `unverified` from Nova is Nova's stored-key path, not the space. */
  | 'available'
  /** Target visible, flag off: a genuine `missing` — Step 4.5 remedies apply. */
  | 'missing'
  /** ACE's key cannot see the target at all: membership / key scope problem. */
  | 'domain-not-visible'
  /** ACE's own key also fails: HQ outage or ACE key problem, not Nova. */
  | 'hq-unreachable';

/** Parse a `/api/user_domains/v1/` body into domain slugs, or null if malformed. */
export function parseUserDomains(body: unknown): string[] | null {
  if (typeof body !== 'object' || body === null) return null;
  const objects = (body as { objects?: unknown }).objects;
  const meta = (body as { meta?: { total_count?: unknown } }).meta;
  if (!Array.isArray(objects) || typeof meta?.total_count !== 'number') return null;
  const names: string[] = [];
  for (const row of objects) {
    const name = (row as { domain_name?: unknown } | null)?.domain_name;
    if (typeof name !== 'string') return null;
    names.push(name);
  }
  // Nova treats a short page without a `next` pointer as malformed (502).
  if (names.length !== meta.total_count) return null;
  return names;
}

export function classifyConnectFlag(
  domain: string,
  visible: ProbeLeg,
  flagged: ProbeLeg,
): ConnectFlagVerdict {
  if (!visible.ok) return 'hq-unreachable';
  if (!visible.domains.includes(domain)) return 'domain-not-visible';
  if (!flagged.ok) return 'hq-unreachable';
  return flagged.domains.includes(domain) ? 'available' : 'missing';
}

export const VERDICT_REMEDY: Record<ConnectFlagVerdict, string> = {
  available:
    "ACE's key confirms commcare_connect on this space. Nova's `unverified` comes from its own live check with the HQ key stored in Nova Settings — re-save that key (commcare.app -> Settings -> CommCare HQ) and retry the upload.",
  missing:
    'commcare_connect is OFF on this space. Follow app-deploy Step 4.5 `missing` remedies (support@dimagi.com).',
  'domain-not-visible':
    "ACE's HQ user cannot see this space. Fix the project-space membership or ACE_HQ_DOMAIN before retrying.",
  'hq-unreachable':
    "ACE's own key cannot complete the check either — HQ outage or ACE key problem, not a Nova defect.",
};
