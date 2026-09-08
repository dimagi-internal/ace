/**
 * Connect REMOVED the "Login with CommCareHQ" button from its login template.
 *
 * Verified anonymously on 2026-09-08 — `curl https://connect.dimagi.com/accounts/login/`
 * returns a plain email/password form (`name="login"` + `name="password"`) whose
 * markup contains no occurrence of "commcarehq" in any case. This is NOT the
 * already-authenticated case covered by `hq-oauth-login-already-authed.test.ts`:
 * it reproduces with no session at all, ON the login page.
 *
 * The OAuth ROUTE is untouched. `/accounts/commcarehq/login/?process=login` still
 * serves allauth's "Sign In Via commcarehq … Continue" interstitial — a single
 * `<form method="post">` with one `<button type="submit">`. So the driver goes
 * straight there when the login page offers no button, and the old button is
 * still tried first so the flow is unchanged if the template ever puts it back.
 *
 * Without this, `hqOAuthLogin` throws on every genuine login — which takes out
 * `/ace:connect-login`, `/ace:labs-login` and the ace-connect backend's
 * auto-relogin the moment an existing session cookie expires.
 */
import { describe, it, expect } from 'vitest';
import type { BrowserContext, Page } from 'playwright';
import { hqOAuthLogin } from '../../../../mcp/connect/auth/hq-oauth-login.js';

const BASE_URL = 'https://connect.dimagi.com';
const CREDS = { hqUsername: 'ace@dimagi-ai.com', hqPassword: 'unused-on-this-path' };

/**
 * A Page that starts on the login page, records every goto(), and serves
 * selectors from `buttons`. After the OAuth button is clicked it reports the
 * Connect host again — CCHQ's silent re-grant (landing case (c)), which is the
 * shortest path through the rest of the driver.
 */
function fakePage(buttons: Record<string, boolean>) {
  const state = { gotos: [] as string[], selectors: [] as string[], clicked: 0 };
  let url = `${BASE_URL}/accounts/login/`;
  const page = {
    goto: async (u: string) => {
      state.gotos.push(u);
      url = u;
      return null;
    },
    url: () => url,
    $: async (selector: string) => {
      state.selectors.push(selector);
      if (!buttons[selector]) return null;
      return {
        click: async () => {
          state.clicked += 1;
          // Silent re-grant lands straight back on Connect.
          url = `${BASE_URL}/a/ai-demo-space/opportunity/`;
        },
      };
    },
    waitForURL: async () => undefined,
    close: async () => undefined,
  } as unknown as Page;
  return { page, state };
}

const context = (page: Page) => ({ newPage: async () => page }) as unknown as BrowserContext;

const LOGIN_PAGE_BUTTON = 'button:has-text("Login with CommCareHQ")';
const INTERSTITIAL_BUTTON = 'form button[type="submit"]';
const OAUTH_ENTRY = `${BASE_URL}/accounts/commcarehq/login/?process=login`;

describe('hqOAuthLogin — OAuth entry when the login page has no button', () => {
  it('falls back to /accounts/commcarehq/login/ and clicks its submit button', async () => {
    const { page, state } = fakePage({ [INTERSTITIAL_BUTTON]: true });

    await expect(
      hqOAuthLogin({ context: context(page), baseUrl: BASE_URL, ...CREDS }),
    ).resolves.toBeUndefined();

    expect(state.gotos).toContain(OAUTH_ENTRY);
    expect(state.clicked).toBe(1);
  });

  it('still prefers the login-page button when Connect serves one', async () => {
    // Nothing about this path changed; if the template puts the button back,
    // the driver must not take the extra navigation.
    const { page, state } = fakePage({ [LOGIN_PAGE_BUTTON]: true });

    await expect(
      hqOAuthLogin({ context: context(page), baseUrl: BASE_URL, ...CREDS }),
    ).resolves.toBeUndefined();

    expect(state.gotos).not.toContain(OAUTH_ENTRY);
    expect(state.clicked).toBe(1);
  });

  it('tries the login-page button BEFORE navigating away', async () => {
    const { page, state } = fakePage({ [INTERSTITIAL_BUTTON]: true });
    await hqOAuthLogin({ context: context(page), baseUrl: BASE_URL, ...CREDS });

    expect(state.selectors[0]).toBe(LOGIN_PAGE_BUTTON);
    expect(state.selectors.indexOf(INTERSTITIAL_BUTTON)).toBeGreaterThan(0);
  });
});
