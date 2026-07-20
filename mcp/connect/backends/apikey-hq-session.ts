import { request as pwRequest, type APIRequestContext } from 'playwright';
import type { CommCareSession } from './commcare.js';

/**
 * A session-less CommCare HQ "session" authenticated purely by an API key.
 *
 * This is how the ace-connect MCP talks to NON-default HQ clusters (e.g. EU
 * while US stays the shared-session default) without standing up a second
 * browser + OAuth flow. Every request carries `Authorization: ApiKey
 * <username>:<key>`, which CCHQ's Tastypie resources accept and which makes
 * Django's `CsrfViewMiddleware` skip CSRF entirely (no cookie/token dance).
 *
 * It implements the narrow {@link CommCareSession} surface `CommCareBackend`
 * uses (`getContext()` → `{ request }`, `invalidate()`), so the same backend
 * class drives it unchanged. `invalidate()` disposes and lazily rebuilds the
 * request context (harmless for key auth — keys don't expire on a session
 * clock — but keeps the runWithSessionRetry contract intact).
 *
 * Scope note: this covers the REST/Tastypie atoms (reads, lookup tables, users,
 * cases, CCZ download, etc.) which accept API-key auth. HTML-form web views
 * that REQUIRE a logged-in browser session + CSRF (e.g. `commcare_create_domain`,
 * `commcare_delete_app`, multimedia upload) are not reachable this way; those
 * on a non-default cluster await a real CCHQ-direct browser session (follow-up).
 */
export class ApiKeyHqSession implements CommCareSession {
  private ctx?: APIRequestContext;

  constructor(
    private readonly opts: { baseUrl: string; username: string; apiKey: string },
  ) {}

  private authHeader(): string {
    return `ApiKey ${this.opts.username}:${this.opts.apiKey}`;
  }

  async getContext(): Promise<{ request: APIRequestContext }> {
    if (!this.ctx) {
      this.ctx = await pwRequest.newContext({
        baseURL: this.opts.baseUrl,
        extraHTTPHeaders: { Authorization: this.authHeader() },
      });
    }
    return { request: this.ctx };
  }

  async invalidate(): Promise<void> {
    try { await this.ctx?.dispose(); } catch { /* ignore */ }
    this.ctx = undefined;
  }

  async close(): Promise<void> {
    try { await this.ctx?.dispose(); } catch { /* ignore */ }
    this.ctx = undefined;
  }
}
