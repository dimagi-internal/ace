import { chromium, type BrowserContext, type Browser } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SessionExpiredError, OcsLoginFailedError } from '../errors.js';

export interface SessionOptions {
  baseUrl: string;
  teamSlug: string;
  stateDir?: string;
  username?: string;
  password?: string;
}

// Minimal cookie shape (matches both Playwright's Cookie and our test fixtures)
export interface Cookie {
  name: string;
  value: string;
}

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
    return path.join(dir, `ocs-session-${this.opts.teamSlug}.json`);
  }

  async getContext(): Promise<BrowserContext> {
    if (this.context) return this.context;
    const statePath = this.stateFile();

    this.browser = await chromium.launch({ headless: true });

    // Try the saved storageState first.
    let context = await this.openContextWithSavedState(statePath);
    let authed = await this.isAuthenticated(context);

    if (!authed) {
      // Saved session is missing or expired. Try credential-driven auto-login.
      if (!this.opts.username || !this.opts.password) {
        await context.close();
        throw new SessionExpiredError();
      }
      await context.close();
      context = await this.browser.newContext({ baseURL: this.opts.baseUrl });
      await this.loginWithCredentials(context);
      authed = await this.isAuthenticated(context);
      if (!authed) {
        await context.close();
        throw new OcsLoginFailedError(this.opts.username);
      }
    }

    this.context = context;

    const cookies = await this.context.cookies();
    this.csrfToken = extractCsrfToken(cookies);

    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    await this.context.storageState({ path: statePath });

    return this.context;
  }

  private async openContextWithSavedState(statePath: string): Promise<BrowserContext> {
    const storageState = fs.existsSync(statePath) ? statePath : undefined;
    return this.browser!.newContext({ storageState, baseURL: this.opts.baseUrl });
  }

  private async isAuthenticated(context: BrowserContext): Promise<boolean> {
    // maxRedirects:0 is load-bearing. Without it Playwright follows the
    // 302→/accounts/login/→200 chain and we incorrectly return true on
    // expired sessions, gating out the auto-relogin path. The URL guard
    // is belt-and-braces in case Playwright behavior changes. Surfaced
    // 2026-05-02 in leep-paint-collection Phase 4.
    const res = await context.request.get(`/a/${this.opts.teamSlug}/chatbots/`, {
      maxRedirects: 0,
    });
    return res.status() === 200 && !res.url().includes('/accounts/login/');
  }

  // Drives the OCS login form at /accounts/login/ headlessly. The form has
  // fields `login` (email) + `password` and a CSRF hidden field that
  // Playwright fills automatically when it loads the page. Post-login the
  // server redirects to /a/<first-team>/dashboard/ — any path outside
  // /accounts/login/ counts as success; the caller verifies team-specific
  // access separately via isAuthenticated().
  private async loginWithCredentials(context: BrowserContext): Promise<void> {
    const page = await context.newPage();
    try {
      await page.goto('/accounts/login/');
      await page.fill('input[name="login"]', this.opts.username!);
      await page.fill('input[name="password"]', this.opts.password!);
      await Promise.all([
        page
          .waitForURL((url) => !url.pathname.startsWith('/accounts/login'), { timeout: 15_000 })
          .catch(() => null),
        page.click('input[type="submit"], button[type="submit"]'),
      ]);
    } finally {
      await page.close();
    }
  }

  getCsrfToken(): string {
    if (!this.csrfToken) {
      throw new Error('CSRF token not available — call getContext() first');
    }
    return this.csrfToken;
  }

  async close(): Promise<void> {
    await this.context?.close();
    await this.browser?.close();
  }
}
