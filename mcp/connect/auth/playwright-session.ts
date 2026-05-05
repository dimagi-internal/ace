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

export interface Cookie { name: string; value: string }

export function extractCsrfToken(cookies: readonly Cookie[]): string | undefined {
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

    const cookies = await this.context.cookies();
    this.csrfToken = extractCsrfToken(cookies);

    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    await this.context.storageState({ path: statePath });

    return this.context;
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
    // Force server-side csrftoken rotation by hitting a Django CSRF-issuing
    // view first. `/accounts/login/` is `@ensure_csrf_cookie`-decorated;
    // GET-ing it causes Django to (re-)set the `csrftoken` cookie via
    // Set-Cookie. Playwright's BrowserContext auto-syncs the cookie jar
    // from Set-Cookie headers, so the next `cookies()` read sees the new
    // value. Without this GET, the cached cookie value persists and the
    // 0.13.9 retry path resends the same stale token the server just
    // rejected (turmeric-20260505-1024 Phase 3 hit this — both retries
    // failed identically because the cookie jar had no opportunity to
    // refresh in between). Pre-0.13.11 this was a cookie-jar-only read.
    try {
      await this.context.request.get('/accounts/login/', { maxRedirects: 0 });
    } catch {
      // If the GET fails, fall through to the cookie-jar read. The
      // recovery may still succeed if a parallel call already updated
      // the cookie; if not, the caller's retry will surface the failure.
    }
    const cookies = await this.context.cookies();
    const t = extractCsrfToken(cookies);
    if (!t) throw new Error('csrftoken cookie missing after refresh');
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
