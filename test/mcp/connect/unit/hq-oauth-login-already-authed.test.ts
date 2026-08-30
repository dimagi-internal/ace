/**
 * Unit tests for `hqOAuthLogin`'s already-authenticated fast path (ace#1862).
 *
 * Background: `hqOAuthLogin` navigated to `${baseUrl}/accounts/login/` and threw
 * `OAuth button "Login with CommCareHQ" not found on Connect login page.
 * Connect template may have changed` whenever the button was absent. But Connect
 * REDIRECTS `/accounts/login/` away when the BrowserContext already carries a
 * live `sessionid` — so on an already-authenticated context the button is
 * legitimately absent and the driver threw on a state that was already correct.
 *
 * That is not exotic. Labs and Connect sessions expire on very different clocks:
 * in the storage state observed on 2026-08-29 the `labs.connect.dimagi.com`
 * sessionid had expired 2.8 h earlier while the `connect.dimagi.com` sessionid
 * was good for another 321 h. `bin/labs-walkthrough-login.ts` correctly probed
 * labs (302), called `hqOAuthLogin` to establish Connect (already established),
 * and died — blocking every walkthrough render whose labs session had aged out
 * while its Connect session had not.
 *
 * The function's postcondition is "the context holds a valid Connect session".
 * When the login page redirects away, that is already true — so return.
 * The throw is reserved for the case the error text actually describes: we ARE
 * on the login page and the button is missing (real upstream template drift).
 */
import { describe, it, expect } from 'vitest';
import type { BrowserContext, Page } from 'playwright';
import { hqOAuthLogin } from '../../../../mcp/connect/auth/hq-oauth-login.js';

const BASE_URL = 'https://connect.dimagi.com';

/**
 * A Page that lands on `landingUrl` after goto() and exposes `queried` so a
 * test can assert whether the OAuth-button lookup was even attempted.
 */
function fakePage(landingUrl: string, buttonPresent: boolean) {
  const state = { queried: false, closed: false };
  const page = {
    goto: async () => null,
    url: () => landingUrl,
    $: async (selector: string) => {
      state.queried = true;
      if (selector.includes('Login with CommCareHQ') && buttonPresent) {
        return { click: async () => undefined };
      }
      return null;
    },
    close: async () => {
      state.closed = true;
    },
  } as unknown as Page;
  return { page, state };
}

function fakeContext(page: Page): BrowserContext {
  return { newPage: async () => page } as unknown as BrowserContext;
}

const CREDS = { hqUsername: 'ace@dimagi-ai.com', hqPassword: 'unused-on-this-path' };

describe('hqOAuthLogin — already-authenticated fast path', () => {
  it('returns without error when Connect redirects the login page away (live session)', async () => {
    // Connect bounces an authenticated user off /accounts/login/ to the app.
    const { page, state } = fakePage(`${BASE_URL}/a/ai-demo-space/opportunity/`, false);

    await expect(
      hqOAuthLogin({ context: fakeContext(page), baseUrl: BASE_URL, ...CREDS }),
    ).resolves.toBeUndefined();

    // The fast path must short-circuit BEFORE the button lookup — a missing
    // button on a page that is not the login page says nothing about drift.
    expect(state.queried).toBe(false);
  });

  it('still returns cleanly when the redirect lands on the Connect root', async () => {
    const { page } = fakePage(`${BASE_URL}/`, false);
    await expect(
      hqOAuthLogin({ context: fakeContext(page), baseUrl: BASE_URL, ...CREDS }),
    ).resolves.toBeUndefined();
  });

  it('STILL throws template-drift when we are on the login page and the button is gone', async () => {
    // The negative control: this is the case the error message describes, and
    // the fast path must not swallow it.
    const { page, state } = fakePage(`${BASE_URL}/accounts/login/`, false);

    await expect(
      hqOAuthLogin({ context: fakeContext(page), baseUrl: BASE_URL, ...CREDS }),
    ).rejects.toThrow(/OAuth button "Login with CommCareHQ" not found/);

    expect(state.queried).toBe(true);
  });

  it('treats a login page carrying a ?next= query as the login page, not a redirect', async () => {
    // Query strings must not be mistaken for a redirect away from the form.
    const { page } = fakePage(`${BASE_URL}/accounts/login/?next=/a/x/opportunity/`, false);
    await expect(
      hqOAuthLogin({ context: fakeContext(page), baseUrl: BASE_URL, ...CREDS }),
    ).rejects.toThrow(/OAuth button "Login with CommCareHQ" not found/);
  });
});
