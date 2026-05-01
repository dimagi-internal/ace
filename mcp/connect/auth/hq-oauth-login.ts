import type { BrowserContext } from 'playwright';
import { ConnectLoginFailedError } from '../errors.js';

export interface HqOAuthLoginOptions {
  context: BrowserContext;
  baseUrl: string;        // Connect base URL (e.g. https://connect.dimagi.com)
  hqUsername: string;
  hqPassword: string;
}

/**
 * Drive the Connect → CommCareHQ OAuth flow with the supplied creds.
 * On success, the BrowserContext's cookie jar contains a valid Connect session.
 *
 * Selectors confirmed live on 2026-04-28 (see `scripts/probe-connect-login.ts`):
 *
 *   1. GET ${baseUrl}/accounts/login/
 *   2. Click `button:has-text("Login with CommCareHQ")` — submits a form to
 *      `/accounts/commcarehq/login/?process=login`
 *   3. Bounce to www.commcarehq.org/accounts/login/?next=/oauth/authorize/...
 *   4. Fill input[name="auth-username"] + input[name="auth-password"]
 *   5. Click `button:has-text("Sign In"):visible` (Knockout-driven: page has
 *      multiple <button type="submit">; only one is visible at a time)
 *   6. Either land on connect.dimagi.com (silent re-grant) OR on the OAuth
 *      authorize page; click input[name="allow"] to consent
 *   7. Final landing: /a/<org>/opportunity/
 */
export async function hqOAuthLogin(opts: HqOAuthLoginOptions): Promise<void> {
  const page = await opts.context.newPage();
  try {
    await page.goto(`${opts.baseUrl}/accounts/login/`);

    const oauthButton = await page.$('button:has-text("Login with CommCareHQ")');
    if (!oauthButton) {
      throw new Error(
        'OAuth button "Login with CommCareHQ" not found on Connect login page. ' +
        'Connect template may have changed; re-run scripts/probe-connect-login.ts to update selectors.'
      );
    }

    const isHostConnect = (u: URL) => u.hostname === new URL(opts.baseUrl).hostname;
    const isHqAuthorize = (u: URL) =>
      u.hostname === 'www.commcarehq.org' && u.pathname.startsWith('/oauth/authorize');

    // Click → bounce to HQ login
    await Promise.all([
      page.waitForURL((u) => /commcarehq\.org/.test(new URL(u).hostname), { timeout: 30_000 }),
      oauthButton.click(),
    ]);

    // Fill HQ creds and submit
    await page.fill('input[name="auth-username"]', opts.hqUsername);
    await page.fill('input[name="auth-password"]', opts.hqPassword);
    const signIn = page.locator('button:has-text("Sign In"):visible').first();

    // Wait for either: back on Connect (silent re-grant), OR the OAuth
    // authorize prompt on HQ. The match below uses URL.hostname to avoid
    // false-positives from "connect.dimagi.com" appearing in redirect_uri
    // querystrings on the HQ side. If the URL never leaves the HQ login form,
    // HQ rejected the creds — distinguish that from generic timeout.
    try {
      await Promise.all([
        page.waitForURL((u) => isHostConnect(new URL(u)) || isHqAuthorize(new URL(u)), { timeout: 30_000 }),
        signIn.click(),
      ]);
    } catch (err) {
      const here = new URL(page.url());
      if (here.hostname === 'www.commcarehq.org' && here.pathname.startsWith('/accounts/login')) {
        throw new ConnectLoginFailedError(opts.hqUsername, 'hq-creds');
      }
      throw err;
    }

    if (isHqAuthorize(new URL(page.url()))) {
      const approve = page.locator('input[name="allow"], button:has-text("Authorize"), button:has-text("Allow")').first();
      try {
        await Promise.all([
          page.waitForURL((u) => isHostConnect(new URL(u)), { timeout: 15_000 }),
          approve.click(),
        ]);
      } catch (err) {
        if (isHqAuthorize(new URL(page.url()))) {
          throw new ConnectLoginFailedError(opts.hqUsername, 'oauth-consent');
        }
        throw err;
      }
    }

    if (!isHostConnect(new URL(page.url()))) {
      throw new ConnectLoginFailedError(opts.hqUsername, 'unknown');
    }
  } finally {
    await page.close();
  }
}
