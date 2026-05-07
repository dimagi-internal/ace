/**
 * Drive the Connect-Labs OAuth login flow given a Connect-authed BrowserContext.
 *
 * Connect-Labs uses Connect (connect.dimagi.com) as its OAuth provider.
 * The button on labs's login page reads "Authorize with Connect" and
 * bounces to the Connect OAuth endpoint. If the BrowserContext already
 * has a valid Connect session, Connect will silently re-grant the OAuth
 * authorization (no consent prompt) and redirect back to labs with an
 * auth code; labs exchanges it for a session cookie scoped to
 * labs.connect.dimagi.com.
 *
 * If the BrowserContext does NOT have a Connect session yet, the caller
 * must run `hqOAuthLogin` first — this helper is a click-through ONLY,
 * not a full login driver. The `mcp/connect/auth/hq-oauth-login.ts`
 * helper handles the Connect-side OAuth-via-CommCareHQ flow.
 *
 * Selectors confirmed against labs's login template at:
 *   https://labs.connect.dimagi.com/labs/login/
 * The page renders an OAuth-only login UI ("Authorize with Connect" CTA;
 * "Secure OAuth authentication only" subtitle). No password fields.
 *
 * On success, `BrowserContext.cookies()` will include cookies for
 * `labs.connect.dimagi.com` (the labs Django session) in addition to
 * the Connect cookies that were already present.
 */

import type { BrowserContext } from 'playwright';

export interface LabsOAuthLoginOptions {
  context: BrowserContext;
  /** Labs base URL, e.g. `https://labs.connect.dimagi.com`. */
  labsBaseUrl: string;
}

export class LabsLoginFailedError extends Error {
  constructor(reason: string) {
    super(`Connect-Labs login failed: ${reason}`);
    this.name = 'LabsLoginFailedError';
  }
}

export async function labsOAuthLogin(opts: LabsOAuthLoginOptions): Promise<void> {
  const { context, labsBaseUrl } = opts;
  const labsHost = new URL(labsBaseUrl).hostname;

  const page = await context.newPage();
  try {
    await page.goto(`${labsBaseUrl}/labs/login/`);

    // The labs login page is OAuth-only — no form fields to fill, just
    // a single CTA. The exact element shape varies (anchor vs form
    // submit), so match by visible text and click whichever is hit-able.
    const authorize = page
      .locator('button:has-text("Authorize with Connect"), a:has-text("Authorize with Connect")')
      .first();

    if ((await authorize.count()) === 0) {
      throw new LabsLoginFailedError(
        'expected "Authorize with Connect" CTA on labs login page; ' +
          'labs template may have changed (last verified 2026-05-06).',
      );
    }

    // Click → bounce(s) through Connect OAuth → land back on labs.
    // Two terminal states:
    //   1. Silent re-grant: existing Connect session is approved without
    //      prompting; we land directly on labs (e.g. /labs/overview/).
    //   2. Consent prompt on Connect: a one-time "Authorize this app?"
    //      with an "Allow" / "Authorize" button. Click it.
    await Promise.all([
      page.waitForURL(
        (u) =>
          new URL(u).hostname === labsHost ||
          new URL(u).hostname === 'connect.dimagi.com',
        { timeout: 30_000 },
      ),
      authorize.click(),
    ]);

    // If we landed on connect.dimagi.com with a consent prompt, click
    // through. If we landed on labs already, the OAuth was silently
    // re-granted and we're done.
    const here = new URL(page.url());
    if (here.hostname === 'connect.dimagi.com') {
      // Heuristic match for the consent button — Connect's OAuth
      // template uses Django-allauth's defaults but the exact label
      // varies by template version. Try the common shapes.
      const allow = page
        .locator(
          'input[name="allow"], button:has-text("Authorize"), button:has-text("Allow"), input[value="Authorize"]',
        )
        .first();
      if ((await allow.count()) === 0) {
        throw new LabsLoginFailedError(
          'landed on connect.dimagi.com but did not find an Authorize/Allow button. ' +
            `URL: ${page.url()}`,
        );
      }
      await Promise.all([
        page.waitForURL((u) => new URL(u).hostname === labsHost, { timeout: 30_000 }),
        allow.click(),
      ]);
    }

    // Sanity-check we're authed on labs now: hit /labs/overview/ and
    // expect 200 (not a 302 to /labs/login/).
    const probe = await context.request.get(`${labsBaseUrl}/labs/overview/`, {
      maxRedirects: 0,
    });
    if (probe.status() === 302) {
      // Was the redirect back to login? That'd mean the OAuth dance
      // didn't establish a labs session.
      const location = probe.headers()['location'] ?? '';
      if (location.includes('/labs/login/')) {
        throw new LabsLoginFailedError(
          `OAuth flow completed but labs session did not stick — /labs/overview/ ` +
            `redirected back to login. Likely a cookie-domain mismatch or ` +
            `OAuth-grant rejection. Last URL: ${page.url()}`,
        );
      }
    } else if (probe.status() !== 200) {
      throw new LabsLoginFailedError(
        `unexpected /labs/overview/ status ${probe.status()} after OAuth completion`,
      );
    }
  } finally {
    await page.close().catch(() => {
      /* ignore */
    });
  }
}
