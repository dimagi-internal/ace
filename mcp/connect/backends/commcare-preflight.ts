/**
 * CommCare HQ pre-flight probes for ACE-side Connect orchestration.
 *
 * Defense-in-depth boundary probe for the Learn-app start path. When
 * a FLW taps "Start" on a claimed opp, the Android client POSTs to
 * `/users/start_learn_app/`, which on CCHQ-side calls
 * `create_hq_user_and_link()` to mint or re-link the mobile worker.
 * That call can fail in well-known ways (CCHQ auth rejected, domain
 * archived/typo'd, user already linked to a different ConnectID),
 * and historically those failures could bubble as opaque HTTP 500.
 * This probe catches those classes of failure pre-flight so they
 * surface as a structured `{ok, action, reason}` outcome before
 * Phase 6 boots the AVD.
 *
 *
 * **What this probe checks (cheapest probe that catches the class):**
 *
 *   1. `GET /a/<domain>/api/v0.5/user/?limit=1` with the configured
 *      `ACE_HQ_API_KEY` — proves the HQ domain exists, is accessible,
 *      and the API key has read scope on the user list. Catches:
 *        - 401/403 → key invalid/revoked/scoped to wrong domain.
 *        - 404     → domain typo / archived / not provisioned.
 *        - 5xx     → CCHQ outage.
 *      `create_hq_user_and_link` does a `POST /api/v0.5/user/` against
 *      the same endpoint family with the same auth, so anything that
 *      breaks the GET breaks the POST identically. The doctor's
 *      `hq_api_key_auth` probe runs the same call; this atom is the
 *      in-MCP equivalent runnable as part of an opp-setup pre-flight.
 *
 *   2. `GET /a/<domain>/api/v0.5/user/?username=<connect_username>` —
 *      determines whether the username `create_hq_user_and_link` is
 *      about to create already exists. CCHQ's `_create_hq_user` issues
 *      a POST; if the username is taken and the existing record's state
 *      conflicts (different domain, different connect linkage), the
 *      POST returns 400 + the same `CommCareHQAPIException` bubble.
 *      Splitting create-vs-exists ahead of time lets the operator see
 *      `would_reuse_existing` cleanly, or surface the conflict with
 *      enough state to debug without touching Phase 6.
 *
 * What this probe deliberately does NOT check:
 *
 *   - COMMCARE_CONNECT feature flag state — that's covered by the
 *     `cchq_connect_features` doctor probe (cookies-based, can't be
 *     done with just an API key). Operators get steered there by the
 *     warning message when the flag is off but the API key works.
 *   - OAuth-connection-to-Connect — same scope; doctor-probe-only.
 *   - The actual `start_learn_app` POST — that's Phase 6's job, and a
 *     dry-run would mutate the server's invite/link state which we
 *     don't want to do from a pre-flight.
 *
 * **Naming convention.** Mirrors `assertCollectionPromptInvariant`
 * (`mcp/ocs/backends/playwright.ts:102`) and the Boundary Probe Registry
 * row format: a single named function that returns a structured outcome
 * rather than throwing. The MCP atom wrapper then converts the outcome
 * into a JSON response so the caller can branch on `ok`/`reason`.
 *
 * Auth: REST API key (`Authorization: ApiKey <username>:<api_key>`),
 * NOT the Playwright cookie session. CCHQ's tastypie auth accepts
 * either; the API key route is preferred for read-only structural
 * probes because it's stateless and doesn't depend on a refreshed
 * Playwright BrowserContext. The doctor probe at
 * `bin/ace-doctor:1420` uses the same header.
 */

/** Args accepted by the pre-flight atom. */
export interface PreflightLearnAppUserArgs {
  /** HQ project space slug (e.g. `connect-ace-prod`). */
  hq_domain: string;
  /**
   * Connect-side username for the FLW about to claim the opp. CCHQ's
   * `create_hq_user_and_link` derives this from the ConnectID record;
   * it's what shows up in CCHQ's mobile-worker list once the link is
   * created. Empty/missing → the probe still validates the API key
   * + domain reachability, but skips the user-exists check.
   */
  connect_username?: string;
  /** CCHQ REST API key (40-char hex). Required. */
  api_key: string;
  /**
   * CCHQ username the API key belongs to. Required — the `ApiKey`
   * header is `<username>:<api_key>`.
   */
  hq_username: string;
  /** Base URL override. Defaults to https://www.commcarehq.org. */
  base_url?: string;
}

/** Outcome shape. Always returned; never throws on a server-side rejection. */
export interface PreflightLearnAppUserResult {
  /** True iff Phase 6's `start_learn_app` is structurally clear to run. */
  ok: boolean;
  /**
   * Coarse classification of the outcome — the operator branches on this
   * (or the LLM agent does) to decide what fix to apply. Mirrors
   * `BuildRejectedError.error` / `ConnectValidationError.error` shape.
   */
  action:
    | 'would_create'
    | 'would_reuse_existing'
    | 'conflict_existing_user'
    | 'auth_failed'
    | 'domain_unreachable'
    | 'cchq_error'
    | 'skipped';
  /**
   * Human-readable explanation. For the failure branches this names
   * the exact remediation step (rotate key, fix domain, etc.).
   */
  reason: string;
  /**
   * Raw HTTP details for the worst-case branch (`auth_failed`,
   * `domain_unreachable`, `cchq_error`). Surfaced verbatim so the
   * caller can re-parse and so a future operator reading the MCP
   * transcript can audit without re-running the probe.
   */
  cchq?: {
    status: number;
    body_excerpt: string;
    path: string;
  };
  /**
   * Existing CCHQ user record (sub-set of fields) when the probe
   * found one. Returned for both `would_reuse_existing` (compatible)
   * and `conflict_existing_user` (incompatible). Operators use it to
   * decide whether to manually reconcile or pick a different username.
   */
  existing_user?: {
    username: string;
    /**
     * CCHQ's `connect_username` field — populated for ConnectID-linked
     * mobile workers, absent for legacy HQ-only users. A populated
     * `connect_username` that doesn't match the requested one is the
     * canonical conflict shape.
     */
    connect_username?: string;
    /**
     * `is_active` from the CCHQ user serializer. Inactive workers
     * can't claim opportunities until reactivated.
     */
    is_active?: boolean;
  };
}

/**
 * Minimal CCHQ user record fields the probe reads. Tastypie's `/user/`
 * endpoint returns many more fields; we project just the ones load-bearing
 * for the conflict-detection branches.
 */
interface CchqUserRecord {
  username: string;
  connect_username?: string | null;
  is_active?: boolean;
}

/** Tastypie list response envelope (`{meta, objects}`). */
interface CchqUserListResponse {
  meta?: { total_count?: number };
  objects?: CchqUserRecord[];
}

/**
 * Run the Learn-app CCHQ pre-flight. See module doc for the bug-class rationale.
 *
 * `fetchImpl` is injectable so unit tests can stub HTTP without going
 * through real CCHQ. Defaults to the global `fetch`.
 */
export async function preflightLearnAppUser(
  args: PreflightLearnAppUserArgs,
  fetchImpl: typeof fetch = fetch,
): Promise<PreflightLearnAppUserResult> {
  const baseUrl = args.base_url ?? 'https://www.commcarehq.org';
  const authHeader = `ApiKey ${args.hq_username}:${args.api_key}`;

  // Step 1: validate API key + domain reachability with a bounded GET.
  // Mirrors `bin/ace-doctor` § hq_api_key_auth probe — small, fast,
  // and a clean 401/403/404 maps directly to a remediation command.
  const listPath = `/a/${args.hq_domain}/api/v0.5/user/?limit=1`;
  let listRes: Response;
  try {
    listRes = await fetchImpl(`${baseUrl}${listPath}`, {
      method: 'GET',
      headers: {
        Authorization: authHeader,
        Accept: 'application/json',
      },
    });
  } catch (err) {
    return {
      ok: false,
      action: 'domain_unreachable',
      reason:
        `Network error reaching CCHQ at ${baseUrl}${listPath}: ${(err as Error).message}. ` +
        'Re-run /ace:doctor to confirm net_commcarehq reachability; if degraded, wait for CCHQ.',
      cchq: { status: 0, body_excerpt: String((err as Error).message).slice(0, 300), path: listPath },
    };
  }

  if (listRes.status === 401 || listRes.status === 403) {
    const body = await safeText(listRes);
    return {
      ok: false,
      action: 'auth_failed',
      reason:
        `CCHQ rejected ACE_HQ_API_KEY against domain "${args.hq_domain}" with HTTP ${listRes.status}. ` +
        'The same key fuels `connect_create_opportunity` and the Phase 6 `start_learn_app` POST — ' +
        'both will fail identically until rotated. Mint a new HQ API key at ' +
        'https://www.commcarehq.org/account/api_keys/ as ace@dimagi-ai.com, update 1Password item ' +
        '"ACE - CommCare HQ API Key (connect-ace-prod)" field `credential`, then ' +
        '`op inject -i .env.tpl -o $CLAUDE_PLUGIN_DATA/.env --force` and /reload-plugins.',
      cchq: { status: listRes.status, body_excerpt: body.slice(0, 300), path: listPath },
    };
  }

  if (listRes.status === 404) {
    return {
      ok: false,
      action: 'domain_unreachable',
      reason:
        `CCHQ returned 404 for project space "${args.hq_domain}". The domain may be archived, ` +
        'renamed, or never provisioned. Phase 6 `start_learn_app` will 500 because ' +
        '`create_hq_user_and_link` cannot create a mobile worker in a non-existent domain. ' +
        'Verify ACE_HQ_DOMAIN spelling against https://www.commcarehq.org/domain/select/.',
      cchq: { status: 404, body_excerpt: '(empty)', path: listPath },
    };
  }

  if (listRes.status >= 500) {
    const body = await safeText(listRes);
    return {
      ok: false,
      action: 'cchq_error',
      reason:
        `CCHQ returned HTTP ${listRes.status} on the user-list probe. CCHQ may be degraded — ` +
        'check status.commcare.org. Phase 6 `start_learn_app` will fail with the same 500 class ' +
        'until CCHQ recovers; defer the run.',
      cchq: { status: listRes.status, body_excerpt: body.slice(0, 300), path: listPath },
    };
  }

  if (listRes.status !== 200) {
    const body = await safeText(listRes);
    return {
      ok: false,
      action: 'cchq_error',
      reason:
        `CCHQ returned unexpected HTTP ${listRes.status} on the user-list probe. ` +
        'Unrecognized response — re-run /ace:doctor § hq_api_key_auth and investigate.',
      cchq: { status: listRes.status, body_excerpt: body.slice(0, 300), path: listPath },
    };
  }

  // Step 2: check existence of the connect_username. Skipped if no
  // username was supplied — the auth/domain probe alone is still useful
  // for the lighter operator-driven pre-flight.
  if (!args.connect_username) {
    return {
      ok: true,
      action: 'skipped',
      reason:
        `CCHQ API key + domain "${args.hq_domain}" verified reachable. ` +
        'No connect_username supplied → user-conflict branch skipped. ' +
        'Phase 6 `start_learn_app` is clear of the auth/domain failure modes.',
    };
  }

  // Tastypie's `/user/?username=<x>` filters by username exact-match.
  const lookupPath = `/a/${args.hq_domain}/api/v0.5/user/?username=${encodeURIComponent(args.connect_username)}`;
  let lookupRes: Response;
  try {
    lookupRes = await fetchImpl(`${baseUrl}${lookupPath}`, {
      method: 'GET',
      headers: {
        Authorization: authHeader,
        Accept: 'application/json',
      },
    });
  } catch (err) {
    return {
      ok: false,
      action: 'domain_unreachable',
      reason:
        `Network error during user lookup at ${baseUrl}${lookupPath}: ${(err as Error).message}. ` +
        'Step 1 (auth+domain) passed, so this is likely transient — retry.',
      cchq: { status: 0, body_excerpt: String((err as Error).message).slice(0, 300), path: lookupPath },
    };
  }

  if (lookupRes.status !== 200) {
    const body = await safeText(lookupRes);
    return {
      ok: false,
      action: 'cchq_error',
      reason:
        `CCHQ returned HTTP ${lookupRes.status} on the user-lookup probe. ` +
        'Step 1 passed, so this is unexpected — re-run /ace:doctor and investigate the upstream.',
      cchq: { status: lookupRes.status, body_excerpt: body.slice(0, 300), path: lookupPath },
    };
  }

  let parsed: CchqUserListResponse;
  try {
    parsed = (await lookupRes.json()) as CchqUserListResponse;
  } catch (err) {
    const body = await safeText(lookupRes);
    return {
      ok: false,
      action: 'cchq_error',
      reason:
        `CCHQ user-lookup returned 200 but body was not JSON: ${(err as Error).message}. ` +
        'Endpoint shape may have changed; re-verify against ' +
        '/api/v0.5/user/?username=<x> via curl.',
      cchq: { status: 200, body_excerpt: body.slice(0, 300), path: lookupPath },
    };
  }

  const objects = parsed.objects ?? [];
  if (objects.length === 0) {
    return {
      ok: true,
      action: 'would_create',
      reason:
        `No existing CCHQ user named "${args.connect_username}" in domain "${args.hq_domain}". ` +
        '`create_hq_user_and_link` will mint a fresh mobile worker on the Phase 6 ' +
        '`start_learn_app` call — expected happy path.',
    };
  }

  // Exact match on the filter — tastypie may also return prefix matches
  // on some indexed string fields, so re-verify the username.
  const exact = objects.find((u) => u.username === args.connect_username) ?? objects[0];

  // Conflict detection: a ConnectID-linked HQ user already exists. The
  // safe-reuse path is "same user, same connect_username (or
  // connect_username unset on a legacy record)"; the conflict path is
  // "linked to a different connect_username". `create_hq_user_and_link`
  // re-runs the link step idempotently for the matching case but
  // raises `CommCareHQAPIException` for the mismatched case.
  const cu = exact.connect_username;
  const linkedToDifferentConnectUsername =
    typeof cu === 'string' && cu !== '' && cu !== args.connect_username;

  if (linkedToDifferentConnectUsername) {
    return {
      ok: false,
      action: 'conflict_existing_user',
      reason:
        `CCHQ user "${exact.username}" in domain "${args.hq_domain}" is already linked to ` +
        `connect_username="${cu}", not "${args.connect_username}". ` +
        '`create_hq_user_and_link` will reject this with CommCareHQAPIException, which ' +
        'Connect\'s `users/views.py:107 start_learn_app` view does not catch — surfaces as ' +
        'opaque HTTP 500. Either (a) pick a different `connect_username`, or (b) manually ' +
        'reconcile the HQ user record via the CCHQ web UI before re-running Phase 6.',
      existing_user: {
        username: exact.username,
        connect_username: cu ?? undefined,
        is_active: exact.is_active,
      },
    };
  }

  if (exact.is_active === false) {
    return {
      ok: false,
      action: 'conflict_existing_user',
      reason:
        `CCHQ user "${exact.username}" exists but is_active=false. Inactive mobile workers cannot ` +
        'claim opportunities; `start_learn_app` will fail until reactivated. Reactivate via the ' +
        'CCHQ web UI (Users → Mobile Workers → <user> → Reactivate) or pick a different username.',
      existing_user: {
        username: exact.username,
        connect_username: cu ?? undefined,
        is_active: false,
      },
    };
  }

  return {
    ok: true,
    action: 'would_reuse_existing',
    reason:
      `CCHQ user "${exact.username}" already exists in "${args.hq_domain}" and is compatible ` +
      '(active, no conflicting connect_username link). `create_hq_user_and_link` will reuse ' +
      'the record idempotently — Phase 6 `start_learn_app` is clear.',
    existing_user: {
      username: exact.username,
      connect_username: cu ?? undefined,
      is_active: exact.is_active,
    },
  };
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '(body unreadable)';
  }
}
