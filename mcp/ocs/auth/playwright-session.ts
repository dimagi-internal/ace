import { chromium, type BrowserContext, type Browser } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SessionExpiredError } from '../errors.js';

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
    const storageState = fs.existsSync(statePath) ? statePath : undefined;

    this.browser = await chromium.launch({ headless: true });
    this.context = await this.browser.newContext({ storageState, baseURL: this.opts.baseUrl });

    // Verify authentication by hitting an authenticated URL
    const res = await this.context.request.get(`/a/${this.opts.teamSlug}/chatbots/`);
    if (res.status() === 302 || res.status() === 401 || res.status() === 403) {
      throw new SessionExpiredError();
    }

    // Extract CSRF token from cookies
    const cookies = await this.context.cookies();
    this.csrfToken = extractCsrfToken(cookies);

    // Persist storage state for next run
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    await this.context.storageState({ path: statePath });

    return this.context;
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
