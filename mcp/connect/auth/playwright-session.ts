import { chromium, type BrowserContext, type Browser } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SessionExpiredError } from '../errors.js';
import { hqOAuthLogin } from './hq-oauth-login.js';

export interface SessionOptions {
  baseUrl: string;
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
   * Returns an authenticated BrowserContext for Connect.
   *
   * Strategy:
   *   1. Load saved storageState if present
   *   2. Probe `${baseUrl}/a/<org>/opportunity/` (or `/`) — but actually
   *      probe `/accounts/login/` and check if we get redirected away from
   *      it (302 means already authed; 200 means anon)
   *   3. If anonymous AND HQ creds are configured, run the OAuth flow
   *   4. Persist the resulting state for next run
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
    const authed = probe.status() === 302;

    if (!authed) {
      if (this.opts.hqUsername && this.opts.hqPassword) {
        await hqOAuthLogin({
          context: this.context,
          baseUrl: this.opts.baseUrl,
          hqUsername: this.opts.hqUsername,
          hqPassword: this.opts.hqPassword,
        });
        // Verify the OAuth flow actually established an authed session
        const retry = await this.context.request.get('/accounts/login/', { maxRedirects: 0 });
        if (retry.status() !== 302) throw new SessionExpiredError();
      } else {
        throw new SessionExpiredError();
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
    const cookies = await this.context.cookies();
    const t = extractCsrfToken(cookies);
    if (!t) throw new Error('csrftoken cookie missing after refresh');
    this.csrfToken = t;
    return t;
  }

  async close(): Promise<void> {
    await this.context?.close();
    await this.browser?.close();
  }
}
