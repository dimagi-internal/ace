/**
 * lib/nova-hq-refresh.ts
 *
 * Decision logic behind `scripts/nova-refresh-hq-domains.ts` — ACE refreshing
 * Nova's stored list of reachable CommCare HQ project spaces by ITSELF, instead
 * of telling the operator to press Refresh (owner directive, 2026-10-08).
 *
 * ── Why a browser at all ──────────────────────────────────────────────────
 *
 * Nova stores the HQ key's reachable spaces when the key is saved
 * (voidcraft-labs/commcare-nova `lib/db/settings.ts` approved_domains), and
 * `get_hq_connection.available_domains` returns that stored set. A space the
 * key's user joins later — every partner workspace's fresh HQ space — is
 * missing until the settings page's Refresh button runs `refreshDomainsAction`
 * → `refreshApprovedDomains` (`app/(app)/(site)/settings/actions.ts`). That is
 * a browser-session server action behind Google sign-in (better-auth); no MCP
 * tool and no API key can trigger it. So the script signs in to
 * https://commcare.app as ace@ with ACE's own Google login, HEADLESS, and
 * presses it. Measured 2026-10-08: one such run made `connect-ace-spark`
 * appear in `get_hq_connection`.
 *
 * ── The rule this module encodes ──────────────────────────────────────────
 *
 * Present → do nothing. Missing → refresh ONCE → re-read. Halt for the operator
 * only when the space is STILL missing (the key's HQ user is not a member — a
 * refresh cannot fix that) or when the refresh itself stopped on a Google
 * challenge (2FA, "verify it's you", "browser not secure") — then the operator
 * presses Refresh by hand. Never loop: a second refresh of an unchanged
 * membership answers the same.
 *
 * No I/O here. The browser step and the Nova read are injected, so the
 * decision is unit-tested without a live browser (CI has none).
 */

/** Why a refresh stopped before pressing the button. Named, never generic. */
export type RefreshStopReason =
  | 'credentials-unavailable'
  | 'google-2fa'
  | 'google-verify-identity'
  | 'google-browser-not-secure'
  | 'google-captcha'
  | 'google-wrong-password'
  | 'google-unknown-challenge'
  | 'google-no-password-field'
  | 'no-refresh-button'
  | 'browser-error';

export interface BrowserRefreshResult {
  ok: boolean;
  stopped_reason?: RefreshStopReason;
  /** The CommCare HQ card's text after Refresh (diagnostic; may be empty). */
  card_text?: string;
  /** Short page excerpt at the stop point. Never contains the password. */
  detail?: string;
}

export type EnsureStatus = 'present' | 'refreshed' | 'still-missing' | 'refresh-blocked' | 'read-failed';

export interface EnsureResult {
  ok: boolean;
  status: EnsureStatus;
  domain: string;
  /** True when the browser refresh was attempted in this call. */
  refreshed: boolean;
  before_count: number | null;
  after_count: number | null;
  domains: string[];
  stopped_reason?: RefreshStopReason;
  card_text?: string;
  detail?: string;
  /** Operator remediation. Empty when ok. */
  remediation: string;
}

export const NOVA_SETTINGS_URL = 'https://commcare.app/settings';

/**
 * Pull `available_domains[].name` out of a `get_hq_connection` payload. Accepts
 * both the object entries Nova returns today and bare strings.
 */
export function extractDomainNames(payload: unknown): string[] {
  const p = (payload ?? {}) as { available_domains?: unknown };
  if (!Array.isArray(p.available_domains)) return [];
  return (p.available_domains as Array<unknown>)
    .map((d) => (typeof d === 'string' ? d : String((d as { name?: unknown })?.name ?? '')))
    .filter(Boolean);
}

/**
 * Name the Google screen the sign-in stopped on, from its visible text. The
 * caller has already decided the page is still on accounts.google.com after
 * submitting the password; this only says WHICH challenge it is, so the halt
 * message is specific.
 */
export function classifyGoogleChallenge(bodyText: string): RefreshStopReason {
  const t = bodyText ?? '';
  if (/browser or app may not be secure|couldn.t sign you in|this browser or app/i.test(t)) {
    return 'google-browser-not-secure';
  }
  if (/wrong password|password was changed|incorrect password/i.test(t)) return 'google-wrong-password';
  if (/captcha|type the text you (hear|see)/i.test(t)) return 'google-captcha';
  if (/2-step verification|verification code|google authenticator|check your phone|tap yes|security key|enter the code/i.test(t)) {
    return 'google-2fa';
  }
  if (/verify it.s you|confirm it.s you|confirm your recovery/i.test(t)) return 'google-verify-identity';
  return 'google-unknown-challenge';
}

/** What the operator does when ACE could not make the space appear itself. */
export function operatorRemediation(domain: string, status: EnsureStatus, reason?: RefreshStopReason): string {
  if (status === 'still-missing') {
    return (
      `ACE refreshed Nova's stored list headlessly and "${domain}" is still not in get_hq_connection.available_domains, ` +
      `so the HQ key's user cannot reach it: add that user (the ACE identity) to "${domain}" on CommCare HQ ` +
      `(or correct the HQ domain), then re-run.`
    );
  }
  if (status === 'refresh-blocked') {
    return (
      `ACE's headless refresh of Nova's HQ space list stopped (${reason ?? 'unknown'}). ` +
      `Sign in at ${NOVA_SETTINGS_URL} as the ACE identity and press Refresh on the CommCare HQ card, ` +
      `then re-run. If "${domain}" is still missing after that, add the HQ key's user to it on CommCare HQ.`
    );
  }
  if (status === 'read-failed') {
    return (
      `Could not read Nova's get_hq_connection (NOVA_API_KEY / network). Run /ace:doctor and fix nova_auth / ` +
      `nova_scopes first.`
    );
  }
  return '';
}

/**
 * Ensure `domain` is among Nova's reachable HQ spaces: read, refresh once if
 * missing, read again. `readDomains` throws on transport failure; `refresh`
 * reports a stop reason instead of throwing.
 */
export async function ensureNovaHqDomain(args: {
  domain: string;
  readDomains: () => Promise<string[]>;
  refresh: () => Promise<BrowserRefreshResult>;
}): Promise<EnsureResult> {
  const { domain, readDomains, refresh } = args;
  const base = { domain, refreshed: false, before_count: null, after_count: null, domains: [] as string[] };

  let before: string[];
  try {
    before = await readDomains();
  } catch (e) {
    return {
      ...base,
      ok: false,
      status: 'read-failed',
      detail: (e as Error).message.slice(0, 300),
      remediation: operatorRemediation(domain, 'read-failed'),
    };
  }
  if (before.includes(domain)) {
    return {
      ...base,
      ok: true,
      status: 'present',
      before_count: before.length,
      after_count: before.length,
      domains: before,
      remediation: '',
    };
  }

  const r = await refresh();
  if (!r.ok) {
    return {
      ...base,
      ok: false,
      status: 'refresh-blocked',
      refreshed: true,
      before_count: before.length,
      domains: before,
      stopped_reason: r.stopped_reason ?? 'browser-error',
      card_text: r.card_text,
      detail: r.detail,
      remediation: operatorRemediation(domain, 'refresh-blocked', r.stopped_reason ?? 'browser-error'),
    };
  }

  let after: string[];
  try {
    after = await readDomains();
  } catch (e) {
    return {
      ...base,
      ok: false,
      status: 'read-failed',
      refreshed: true,
      before_count: before.length,
      domains: before,
      card_text: r.card_text,
      detail: (e as Error).message.slice(0, 300),
      remediation: operatorRemediation(domain, 'read-failed'),
    };
  }
  const found = after.includes(domain);
  return {
    ...base,
    ok: found,
    status: found ? 'refreshed' : 'still-missing',
    refreshed: true,
    before_count: before.length,
    after_count: after.length,
    domains: after,
    card_text: r.card_text,
    remediation: found ? '' : operatorRemediation(domain, 'still-missing'),
  };
}

/** Exit code for the script, per status. 0 ok · 2 blocked by Google/browser · 3 still missing · 1 other. */
export function exitCodeFor(status: EnsureStatus): number {
  switch (status) {
    case 'present':
    case 'refreshed':
      return 0;
    case 'refresh-blocked':
      return 2;
    case 'still-missing':
      return 3;
    default:
      return 1;
  }
}
