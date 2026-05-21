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
 *   1. GET ${opts.baseUrl}/accounts/login/
 *   2. Click `button:has-text("Login with CommCareHQ")` — submits a form to
 *      `/accounts/commcarehq/login/?process=login`
 *   3. Bounce to www.commcarehq.org. Three possible landings depending on what
 *      cookies the BrowserContext already carries:
 *        (a) `/accounts/login/?next=/oauth/authorize/...` — HQ login form
 *        (b) `/oauth/authorize/?...` — OAuth consent prompt (CCHQ session
 *            still valid; e.g. stale Connect storageState + fresh CCHQ session)
 *        (c) back on Connect (silent re-grant — CCHQ session AND a prior
 *            consent grant both still valid)
 *   4. (a only) Fill input[name="auth-username"] + input[name="auth-password"]
 *      and click `button:has-text("Sign In"):visible` (Knockout-driven: page
 *      has multiple <button type="submit">; only one is visible at a time)
 *   5. (a or b) Click input[name="allow"] on the OAuth consent prompt
 *   6. Final landing: /a/<org>/opportunity/
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
    const isHqLogin = (u: URL) =>
      u.hostname === 'www.commcarehq.org' && u.pathname.startsWith('/accounts/login');

    // Click → bounce to HQ. Wait until the bounce lands somewhere actionable:
    // the HQ login form, the OAuth authorize prompt, or all the way back to
    // Connect (full silent re-grant). Previously this only waited for the
    // host to change to commcarehq.org, then immediately tried to fill the
    // login form — which times out on `input[name="auth-username"]` when
    // the bounce skipped the login form because CCHQ still had a valid
    // session cookie (e.g. stale Connect storageState loaded with a fresh
    // CCHQ session). See investigation in scripts/probe-hq-login-stale.ts.
    await Promise.all([
      page.waitForURL(
        (u) => {
          const url = new URL(u);
          return isHqLogin(url) || isHqAuthorize(url) || isHostConnect(url);
        },
        { timeout: 30_000 },
      ),
      oauthButton.click(),
    ]);

    // (c) CCHQ silently re-granted all the way back to Connect — done.
    if (isHostConnect(new URL(page.url()))) {
      return;
    }

    // (a) Landed on the HQ login form — fill creds and submit. If we
    // skipped this branch we're already on the OAuth consent prompt (b).
    if (isHqLogin(new URL(page.url()))) {
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
        if (isHqLogin(new URL(page.url()))) {
          throw new ConnectLoginFailedError(opts.hqUsername, 'hq-creds');
        }
        throw err;
      }
    }

    // (a continued, or b) Handle the OAuth consent prompt if still on it.
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
