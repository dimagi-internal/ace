import { chromium, type BrowserContext, type Browser, type APIRequestContext } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { SessionExpiredError, ConnectLoginFailedError } from '../errors.js';
import { hqOAuthLogin } from './hq-oauth-login.js';
import { extractFormCsrfToken } from '../backends/html-scrape.js';
import {
  defaultStateDir,
  extractCsrfToken,
  persistStorageState,
  resolveSavedStorageState,
  type Cookie,
} from '../../lib/playwright-session.js';

// Re-export the shared cookie type and CSRF extractor so existing import
// paths (`from '.../mcp/connect/auth/playwright-session'`) keep resolving
// — particularly `test/mcp/connect/unit/csrf-extraction.test.ts` and
// callers under `mcp/connect/backends/`. Centralising the impl in
// `mcp/lib` is internal plumbing.
export { extractCsrfToken, type Cookie };

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

export class PlaywrightSession {
  private browser?: Browser;
  private context?: BrowserContext;
  private csrfToken?: string;

  constructor(private opts: SessionOptions) {}

  private stateFile(): string {
    const dir = this.opts.stateDir ?? defaultStateDir();
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

    this.browser = await chromium.launch({ headless: true });
    this.context = await this.browser.newContext({
      storageState: resolveSavedStorageState(statePath),
      baseURL: this.opts.baseUrl,
    });

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

    // Extract Connect's CSRF token from the HTML body of a rendered
    // form, NOT from a Set-Cookie header.
    //
    // Connect runs Django with `CSRF_USE_SESSIONS=True` (verified live
    // 2026-05-06 against the prod deploy). Under that setting, Django
    // stores the CSRF token in `request.session['_csrftoken']` rather
    // than a cookie — `Set-Cookie: csrftoken=...` headers are NEVER
    // sent. The token is exposed only via the `csrfmiddlewaretoken`
    // hidden input that Django's `{% csrf_token %}` template tag
    // renders into every CSRF-protected form. CsrfViewMiddleware then
    // accepts that token (via the `csrfmiddlewaretoken` form field on
    // multipart/x-www-form-urlencoded POSTs OR the `X-CSRFToken`
    // header on JSON POSTs) and compares it against the
    // session-stored value.
    //
    // Pre-0.13.24 this entire module looked for a cookie that doesn't
    // exist on Connect's deploy. Every cookie-based CSRF self-heal
    // (0.13.13 cookie rotation, 0.13.14 forced cookie issuance,
    // 0.13.15 bottom-out reauth, 0.13.22 silent-fallback removal) was
    // chasing the wrong abstraction. The fix is to GET an HTML page
    // that renders a form, regex out the `csrfmiddlewaretoken` value,
    // and cache that as `this.csrfToken` for `RestBackend` to send via
    // `X-CSRFToken`.
    //
    // `/accounts/login/` is the most reliable form-rendering URL: it
    // 200s for authed and anon users alike (allauth re-renders the
    // login form with a fresh CSRF token even after auth — the response
    // body still includes the form), and the form ALWAYS has a
    // `csrfmiddlewaretoken` input. We could also use any authed view
    // with a form (e.g. the org settings page), but `/accounts/login/`
    // is universal across orgs and auth states.
    //
    // Empirical proof: same-session GET `/accounts/login/` → extract
    // token → POST `/api/programs/<uuid>/opportunities/` with
    // `X-CSRFToken: <token>` returned `401 "Authentication credentials
    // were not provided"` (CSRF check passed; auth failed because the
    // session was anon). Pre-fix it returned `403 "CSRF Failed: CSRF
    // token missing"`. The 403→401 transition is the goalpost.
    const hydrationUrls = ['/accounts/login/', '/'];
    let lastStatus: number | undefined;
    for (const url of hydrationUrls) {
      let html: string | undefined;
      try {
        const resp = await this.context.request.get(url);
        lastStatus = resp.status();
        html = await resp.text();
      } catch {
        continue;
      }
      const t = extractFormCsrfToken(html);
      if (t) {
        this.csrfToken = t;
        break;
      }
    }

    if (!this.csrfToken) {
      // None of the hydration GETs produced a parseable
      // csrfmiddlewaretoken. Surface diagnostic data the next
      // investigation will need: which URLs were tried, the last
      // response status, and the cookies actually in the jar (names
      // + domains, no values). Drop the on-disk state so a retry
      // starts from a clean slate rather than reloading the broken
      // state.
      const cookies = await this.context.cookies();
      const summary = cookies
        .map((c) => `${c.name}@${c.domain ?? '?'}`)
        .join(', ');
      try { fs.unlinkSync(statePath); } catch { /* ignore */ }
      throw new Error(
        `csrfmiddlewaretoken not found in Connect HTML after auth. ` +
          `Tried [${hydrationUrls.join(', ')}], last response status=${lastStatus ?? 'n/a'}. ` +
          `Cookies in jar: [${summary}]. ` +
          'Connect uses CSRF_USE_SESSIONS=True (no cookie) — token must be ' +
          'extracted from the csrfmiddlewaretoken hidden input on a ' +
          'rendered form. If that input is missing, Connect changed the ' +
          'CSRF mechanism upstream and this skill needs a new probe URL. ' +
          'Stale storageState dropped; next getContext() will run a fresh OAuth flow.',
      );
    }

    await persistStorageState(this.context, statePath);

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
    // Same HTML-body extraction strategy as getContext(): GET a
    // form-rendering URL, regex out the `csrfmiddlewaretoken` value.
    // Connect uses CSRF_USE_SESSIONS=True so there's no cookie to
    // refresh — the token is bound to the session and reading it from
    // the form's hidden input gives the current valid value for the
    // current session.
    const hydrationUrls = ['/accounts/login/', '/'];
    let t: string | undefined;
    for (const url of hydrationUrls) {
      let html: string | undefined;
      try {
        const resp = await this.context.request.get(url);
        html = await resp.text();
      } catch {
        continue;
      }
      const found = extractFormCsrfToken(html);
      if (found) {
        t = found;
        break;
      }
    }
    if (!t) {
      const cookies = await this.context.cookies();
      const summary = cookies.map((c) => `${c.name}@${c.domain ?? '?'}`).join(', ');
      throw new Error(
        `csrfmiddlewaretoken not found in Connect HTML after refresh. ` +
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
