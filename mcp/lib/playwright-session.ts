/**
 * Shared utilities for Playwright-cookie-based MCP auth.
 *
 * OCS (`mcp/ocs/auth/playwright-session.ts`) and Connect
 * (`mcp/connect/auth/playwright-session.ts`) both authenticate against
 * Django apps via headless Playwright, cache the resulting session
 * cookies in a storageState JSON, and use a CSRF token for write-side
 * requests. Their login flows diverge sharply (OCS = form fill,
 * Connect = OAuth-via-CCHQ) and their CSRF source diverges since
 * 0.13.24 (OCS = `csrftoken` cookie; Connect = `csrfmiddlewaretoken`
 * scraped from rendered HTML, because Connect runs Django with
 * `CSRF_USE_SESSIONS=True`). A full common base class would force the
 * wrong abstraction.
 *
 * What IS genuinely shareable lives here: the cookie type, the canonical
 * `extractCsrfToken` (with the multi-domain `domainFilter` that landed
 * after the turmeric-20260505-1024 + leep-paint-collection-20260505-1505
 * incidents), the default state-dir, and the storage-state plumbing.
 */

import { type BrowserContext } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Minimal cookie shape — superset of the pre-0.13.19 `{name, value}`
 * pair OCS used and the `{name, value, domain?}` shape Connect needed
 * once the multi-domain CSRF bug forced domain-aware filtering.
 * `domain` is optional so single-domain callers can keep passing the
 * smaller shape; passing it is what unlocks `extractCsrfToken`'s
 * `domainFilter` for any future MCP that lands a multi-domain auth.
 */
export interface Cookie {
  name: string;
  value: string;
  domain?: string;
}

/**
 * Extract a `csrftoken` cookie value from a cookie jar, optionally
 * filtered by a domain substring.
 *
 * Multi-domain sessions (e.g. Connect's OAuth-via-CCHQ flow that
 * establishes both `connect.dimagi.com` AND `www.commcarehq.org`
 * cookies) carry TWO `csrftoken` cookies that are NOT interchangeable
 * — each Django app validates the header against its own domain's
 * cookie, and a token from the wrong domain produces an
 * indistinguishable `403 CSRF Failed`. `domainFilter` is a substring;
 * pass `'connect.dimagi.com'` for Connect REST/UI calls or
 * `'commcarehq'` for CCHQ.
 *
 * **When `domainFilter` is provided and no matching cookie is found,
 * returns `undefined`** — the call site is responsible for surfacing
 * the failure. The pre-0.13.19 implementation silently fell back to
 * the first csrftoken regardless of domain, which defeated multi-domain
 * guards (a truthy wrong-domain token didn't trip downstream throws)
 * and let every Connect REST POST 403 with the HQ csrftoken in the
 * header. Surfaced live on leep-paint-collection-20260505-1505 Phase 4
 * Step 2; the silent fallback was the footgun behind the documented
 * bug class.
 *
 * When `domainFilter` is omitted, the first `csrftoken` cookie wins —
 * present for backwards compat with single-domain callers (OCS
 * pre-multi-domain-cookie-jar; original Connect pre-0.13.12).
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

/**
 * The canonical `~/.ace/` state directory. Both OCS
 * (`ocs-session-<team>.json`) and Connect (`connect-session.json`)
 * write here by default; callers can pass an explicit `stateDir` to
 * override (mainly for tests).
 */
export function defaultStateDir(): string {
  return path.join(os.homedir(), '.ace');
}

/**
 * Resolve a saved-storageState file path into the value Playwright's
 * `browser.newContext({ storageState })` expects: the path string when
 * the file exists, `undefined` when it doesn't. Centralises the
 * `existsSync` ternary that both PlaywrightSession classes do.
 */
export function resolveSavedStorageState(statePath: string): string | undefined {
  return fs.existsSync(statePath) ? statePath : undefined;
}

/**
 * Persist a context's storageState to disk, creating any missing
 * parent directories. Both PlaywrightSession classes do this exactly
 * the same way at the end of `getContext()` once auth has settled.
 */
export async function persistStorageState(
  context: BrowserContext,
  statePath: string,
): Promise<void> {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  await context.storageState({ path: statePath });
}
