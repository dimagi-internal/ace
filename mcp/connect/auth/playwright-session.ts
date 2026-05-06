import { chromium, type BrowserContext, type Browser, type APIRequestContext } from 'playwright';
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
 * REST/UI calls or `'commcarehq'` for CCHQ. **When provided and no
 * matching cookie is found, returns `undefined`** — the call site is
 * responsible for surfacing the failure. The pre-0.13.19 implementation
 * silently fell back to the first csrftoken regardless of domain, which
 * defeated the throw guard in `getContext()` (it saw a truthy
 * wrong-domain token and didn't fire) and let every Connect REST POST
 * 403 with the HQ csrftoken in the header. Surfaced live on
 * leep-paint-collection-20260505-1505 Phase 3 Step 2; the `extractCsrfToken`
 * fallback was the silent footgun behind the documented bug class.
 *
 * When `domainFilter` is omitted, the first `csrftoken` cookie wins —
 * present only for backwards compat with the pre-0.13.12 callers.
 */
export function extractCsrfToken(
  cookies: readonly Cookie[],
  domainFilter?: string,
): string | undefined {
  if (domainFilter) {
    return cookies.find(
      (c) => c.name === 'csrftoken' && c.domain?.includes(domainFilter),
    )?.value;
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
    // Hydrate a Connect-domain csrftoken cookie. We try a sequence of
    // URLs because the right one to GET varies with Connect's auth state
    // and which org ace lands on by default:
    //   1. `/accounts/login/` followed-redirect → for an authed user this
    //      should land on `/a/<default-org>/opportunity/`, which renders
    //      with @ensure_csrf_cookie semantics. Worked historically.
    //   2. `/` — Connect's homepage. If logged in, redirects to a default
    //      dashboard; that destination almost always renders a CSRF form.
    //   3. `/api/programs/` — a DRF endpoint that issues csrftoken on the
    //      response of a GET (DRF's SessionAuthentication.enforce_csrf is
    //      a no-op on safe methods, but the framework still sets
    //      csrftoken via Django's middleware on the response).
    // We stop as soon as a connect.dimagi.com csrftoken lands in the jar.
    const hydrationUrls = ['/accounts/login/', '/', '/api/programs/'];
    let lastStatus: number | undefined;
    for (const url of hydrationUrls) {
      try {
        const resp = await this.context.request.get(url);
        lastStatus = resp.status();
      } catch {
        // continue to next URL
      }
      const cookies = await this.context.cookies();
      const csrf = extractCsrfToken(cookies, this.connectDomain());
      if (csrf) {
        this.csrfToken = csrf;
        break;
      }
    }

    if (!this.csrfToken) {
      // None of the hydration GETs produced a same-domain csrftoken.
      // Surface the diagnostic data the next investigation will need: the
      // cookies actually in the jar (names + domains, no values for
      // safety) and the last response status. Also drop the on-disk
      // state so a retry starts from a clean slate rather than reloading
      // this broken state.
      const cookies = await this.context.cookies();
      const summary = cookies
        .map((c) => `${c.name}@${c.domain ?? '?'}`)
        .join(', ');
      try { fs.unlinkSync(statePath); } catch { /* ignore */ }
      throw new Error(
        `csrftoken cookie missing for ${this.connectDomain()} after CSRF hydration. ` +
          `Tried [${hydrationUrls.join(', ')}], last response status=${lastStatus ?? 'n/a'}. ` +
          `Cookies in jar: [${summary}]. ` +
          'OAuth completed but Connect did not set a same-domain csrftoken on any tried URL. ' +
          'Stale storageState dropped; next getContext() will run a fresh OAuth flow.',
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
    // Same multi-URL hydration sequence as getContext(): try each in turn
    // until one produces a connect.dimagi.com csrftoken. 0.13.19 widens
    // the candidate list past `/accounts/login/` after that URL was
    // empirically observed to land somewhere that didn't trigger CSRF
    // middleware on leep-paint-collection-20260505-1505 Phase 3 Step 2.
    const hydrationUrls = ['/accounts/login/', '/', '/api/programs/'];
    let t: string | undefined;
    for (const url of hydrationUrls) {
      try {
        await this.context.request.get(url);
      } catch {
        // continue
      }
      const cookies = await this.context.cookies();
      t = extractCsrfToken(cookies, this.connectDomain());
      if (t) break;
    }
    if (!t) {
      const cookies = await this.context.cookies();
      const summary = cookies.map((c) => `${c.name}@${c.domain ?? '?'}`).join(', ');
      throw new Error(
        `csrftoken cookie missing for ${this.connectDomain()} after refresh. ` +
          `Tried [${hydrationUrls.join(', ')}]. Cookies in jar: [${summary}].`,
      );
    }
    this.csrfToken = t;
    return t;
  }

  /**
   * Synchronous accessor for the current authenticated `APIRequestContext`,
   * if one is cached. Returns undefined when no context has been
   * established yet (pre-`getContext()`) or when `invalidate()` has dropped
   * it. Used by `PlaywrightBackend` (0.13.17) to lazily resolve a
   * fresh request handle on every call rather than caching a constructor-
   * bound one — which goes stale on `RestBackend.reauth()` and then fails
   * subsequent reads with `apiRequestContext.get: Target page, context or
   * browser has been closed`.
   */
  peekRequest(): APIRequestContext | undefined {
    return this.context?.request;
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
