import { chromium, type BrowserContext, type Browser } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SessionExpiredError, ConnectLoginFailedError } from '../errors.js';
import { hqOAuthLogin } from './hq-oauth-login.js';

export interface SessionOptions {
  baseUrl: string;
  /**
   * Optional CommCare HQ base URL (e.g. `https://www.commcarehq.org`). When
   * supplied, `getContext()` runs a CCHQ-side authed probe in addition to
   * the Connect-platform probe. CCHQ session cookies expire on a separate
   * clock from `connect.dimagi.com` cookies; without this probe a stale
   * CCHQ session goes undetected at boot and every commcare_* atom 302s
   * mid-run with no chance to recover (turmeric-20260505-1024 surfaced
   * exactly this — Connect probe said "authed" while CCHQ rejected every
   * request).
   */
  cchqBaseUrl?: string;
  stateDir?: string;
  hqUsername?: string;
  hqPassword?: string;
}

export interface Cookie { name: string; value: string; domain?: string }

/**
 * Extract a `csrftoken` cookie value from a cookie jar, optionally
 * filtered by a domain substring. After OAuth-via-CCHQ login completes,
 * the BrowserContext jar carries TWO `csrftoken` cookies — one for
 * `connect.dimagi.com` and one for `www.commcarehq.org` — set by the
 * different views the OAuth flow walked through. They are NOT
 * interchangeable: each Django app validates the header against its own
 * domain's cookie, and a token from the wrong domain produces an
 * indistinguishable `403 CSRF Failed` (turmeric-20260505-1024 Phase 3
 * Step 2 hit this — `RestBackend` was sending the HQ csrftoken on
 * `connect.dimagi.com` POSTs).
 *
 * `domainFilter` is a substring; pass `'connect.dimagi.com'` for Connect
 * REST/UI calls or `'commcarehq'` for CCHQ. When omitted, the first
 * `csrftoken` cookie wins, which is unsafe in multi-domain contexts —
 * present only for backwards compat with the pre-0.13.12 callers.
 */
export function extractCsrfToken(
  cookies: readonly Cookie[],
  domainFilter?: string,
): string | undefined {
  if (domainFilter) {
    const match = cookies.find(
      (c) => c.name === 'csrftoken' && c.domain?.includes(domainFilter),
    );
    if (match) return match.value;
  }
  return cookies.find((c) => c.name === 'csrftoken')?.value;
}

export class PlaywrightSession {
  private browser?: Browser;
  private context?: BrowserContext;
  private csrfToken?: string;

  constructor(private opts: SessionOptions) {}

  private stateFile(): string {
    const dir = this.opts.stateDir ?? path.join(os.homedir(), '.ace');
    return path.join(dir, 'connect-session.json');
  }

  /**
   * Returns an authenticated BrowserContext for Connect *and* CCHQ.
   *
   * Strategy:
   *   1. Load saved storageState if present
   *   2. Probe `${baseUrl}/accounts/login/` — 302 means Connect-platform authed
   *   3. (When cchqBaseUrl is set) probe CCHQ separately — 302 to login means
   *      CCHQ session is stale even if Connect's is valid
   *   4. If either probe says anon AND HQ creds are configured, run a full
   *      OAuth flow (which establishes both services' cookies in one bounce)
   *   5. Persist the resulting state for next run
   */
  async getContext(): Promise<BrowserContext> {
    if (this.context) return this.context;
    const statePath = this.stateFile();
    const storageState = fs.existsSync(statePath) ? statePath : undefined;

    this.browser = await chromium.launch({ headless: true });
    this.context = await this.browser.newContext({ storageState, baseURL: this.opts.baseUrl });

    // Authed-state probe: GET /accounts/login/. If we're already authed,
    // Connect 302s us to /a/<org>/opportunity/. If anon, 200 with the form.
    const probe = await this.context.request.get('/accounts/login/', { maxRedirects: 0 });
    let authed = probe.status() === 302;

    // CCHQ-side probe (only if cchqBaseUrl was supplied). CCHQ's
    // `/accounts/login/` redirects (302) when authed, returns 200 with the
    // login form when anon — same shape as Connect. Cookies expire on a
    // separate clock; without this check a stale CCHQ session is invisible
    // until the first commcare_* atom 302s mid-run.
    if (authed && this.opts.cchqBaseUrl) {
      const cchqProbe = await this.context.request.get(
        `${this.opts.cchqBaseUrl}/accounts/login/`,
        { maxRedirects: 0 },
      );
      if (cchqProbe.status() !== 302) {
        // CCHQ stale even though Connect cookies are fresh. Treat as fully
        // anonymous so the OAuth flow re-establishes both. Closing+rebuilding
        // the context guarantees hqOAuthLogin starts from a clean slate
        // (otherwise the existing Connect cookies would short-circuit the
        // OAuth button discovery on `/accounts/login/`).
        await this.context.close();
        this.browser && (await this.browser.close());
        this.browser = await chromium.launch({ headless: true });
        this.context = await this.browser.newContext({ baseURL: this.opts.baseUrl });
        authed = false;
      }
    }

    if (!authed) {
      if (!this.opts.hqUsername || !this.opts.hqPassword) {
        throw new SessionExpiredError();
      }
      await hqOAuthLogin({
        context: this.context,
        baseUrl: this.opts.baseUrl,
        hqUsername: this.opts.hqUsername,
        hqPassword: this.opts.hqPassword,
      });
      // Verify the OAuth flow actually established an authed session.
      // hqOAuthLogin throws ConnectLoginFailedError on detected creds/consent
      // failures; this catches the rarer "OAuth completed but session didn't
      // stick" case.
      const retry = await this.context.request.get('/accounts/login/', { maxRedirects: 0 });
      if (retry.status() !== 302) {
        throw new ConnectLoginFailedError(this.opts.hqUsername, 'unknown');
      }
    }

    // Force Connect to issue a `csrftoken` cookie for its own domain.
    // The OAuth-via-CCHQ bounce can leave the jar with ONLY a CCHQ
    // `csrftoken` (verified live on turmeric-20260505-1024 — `jq` over
    // the saved storageState confirmed exactly one csrftoken row, on
    // www.commcarehq.org, and zero on connect.dimagi.com), so the
    // domain-filter selection silently fell back to the wrong-domain
    // token and every Connect REST POST 403'd. GET-ing
    // `/accounts/login/` with redirect-following lands on the authed
    // org dashboard (`/a/<org>/opportunity/`), which renders through
    // Django's CSRF middleware and sets `csrftoken` for
    // connect.dimagi.com via Set-Cookie. Playwright's BrowserContext
    // syncs the cookie automatically; the read below then has a real
    // Connect-domain row to pick up. Pre-0.13.14 this was a `maxRedirects:0`
    // probe that intentionally short-circuited the redirect for the
    // authed-state probe — the new follow-the-redirect call is purely
    // for CSRF cookie hydration and is run AFTER the authed-state
    // determination is already settled.
    try {
      await this.context.request.get('/accounts/login/');
    } catch {
      // Best-effort: if the hydration GET fails, fall through to read
      // whatever's in the jar. The next REST POST will surface the
      // failure if we still don't have a Connect csrftoken.
    }
    const cookies = await this.context.cookies();
    // Capture the connect.dimagi.com csrftoken specifically. CCHQ-bound
    // atoms in `commcare.ts` filter independently via their own
    // `csrfFromCookies()` helper.
    this.csrfToken = extractCsrfToken(cookies, this.connectDomain());
    if (!this.csrfToken) {
      // Loud-fail rather than fall back to the wrong-domain token. The
      // unfiltered fallback in `extractCsrfToken` was the silent footgun
      // that hid this bug for four dispatches; refusing to ship without
      // a domain-matching cookie surfaces the real problem on attempt 1.
      throw new Error(
        `csrftoken cookie missing for ${this.connectDomain()} after CSRF hydration GET. ` +
          'OAuth completed but Connect did not set a same-domain csrftoken; ' +
          'check whether `/accounts/login/` still renders an authed dashboard ' +
          'with `@ensure_csrf_cookie` semantics, or `/ace:connect-login` to recover manually.',
      );
    }

    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    await this.context.storageState({ path: statePath });

    return this.context;
  }

  /**
   * Domain substring used to filter the multi-domain cookie jar down to
   * the Connect-platform `csrftoken`. Derived from `opts.baseUrl`.
   */
  private connectDomain(): string {
    try {
      return new URL(this.opts.baseUrl).hostname;
    } catch {
      return 'connect.dimagi.com';
    }
  }

  /**
   * Get the current CSRF token. Connect's Django CSRF cookie name is
   * `csrftoken`. Pages that mutate state need this in the
   * `csrfmiddlewaretoken` form field AND/OR the `X-CSRFToken` header.
   */
  getCsrfToken(): string {
    if (!this.csrfToken) {
      throw new Error('CSRF token not available — call getContext() first');
    }
    return this.csrfToken;
  }

  async refreshCsrfToken(): Promise<string> {
    if (!this.context) throw new Error('No context — call getContext() first');
    // GET an authed Connect view that renders through CSRF middleware so
    // a fresh `Set-Cookie: csrftoken` is issued for connect.dimagi.com.
    // 0.13.11 used `/accounts/login/` with `maxRedirects:0` — but for an
    // authed session that 302s BEFORE rendering, so no Set-Cookie was
    // emitted. 0.13.14 follows the redirect to `/a/<org>/opportunity/`,
    // which DOES render and DOES set csrftoken. Same path used in
    // `getContext()` for initial cookie hydration; reusing it here keeps
    // the recovery semantics consistent.
    try {
      await this.context.request.get('/accounts/login/');
    } catch {
      // Best-effort: fall through to a cookie-jar read.
    }
    const cookies = await this.context.cookies();
    const t = extractCsrfToken(cookies, this.connectDomain());
    if (!t) throw new Error('csrftoken cookie missing for ' + this.connectDomain() + ' after refresh');
    this.csrfToken = t;
    return t;
  }

  /**
   * Drop the cached BrowserContext, csrf token, and the on-disk session file.
   * The next `getContext()` call will re-init from scratch and run the full
   * `hqOAuthLogin` flow (since both the cached and on-disk states are gone).
   *
   * Use this when an atom detects mid-session expiry that the boot-time
   * probe didn't catch — e.g. a CCHQ POST returning a 302 to `/login/`.
   * Pair with a one-shot retry at the call site so the operator sees the
   * recovery happen transparently instead of a dead session.
   */
  async invalidate(): Promise<void> {
    try { await this.context?.close(); } catch { /* ignore */ }
    try { await this.browser?.close(); } catch { /* ignore */ }
    this.context = undefined;
    this.browser = undefined;
    this.csrfToken = undefined;
    const statePath = this.stateFile();
    try { if (fs.existsSync(statePath)) fs.unlinkSync(statePath); } catch { /* ignore */ }
  }

  async close(): Promise<void> {
    await this.context?.close();
    await this.browser?.close();
  }
}
