/**
 * Probe: drive the connect.dimagi.com → CommCare HQ OAuth flow programmatically
 * using ACE_HQ_USERNAME / ACE_HQ_PASSWORD from .env. Saves the resulting
 * Connect storageState to ~/.ace/connect-session.json.
 *
 * Run: npx tsx scripts/probe-connect-login.ts
 *
 * This is an investigation script — re-run it whenever the Connect or HQ
 * login template changes; the observations recorded at the bottom of the
 * file are the canonical reference for hq-oauth-login.ts selectors.
 */
import 'dotenv/config';
import { chromium } from 'playwright';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const baseUrl = process.env.CONNECT_BASE_URL ?? 'https://connect.dimagi.com';
const hqUser = process.env.ACE_HQ_USERNAME;
const hqPass = process.env.ACE_HQ_PASSWORD;
if (!hqUser || !hqPass) {
  throw new Error('ACE_HQ_USERNAME and ACE_HQ_PASSWORD must be set in .env');
}

const stateFile = path.join(os.homedir(), '.ace', 'connect-session.json');

const headed = process.env.HEADED !== '0';
const browser = await chromium.launch({ headless: !headed });
const context = await browser.newContext({ baseURL: baseUrl });
const page = await context.newPage();

console.log(`[probe] Navigating to ${baseUrl}/accounts/login/`);
await page.goto('/accounts/login/');
console.log(`[probe] Initial URL: ${page.url()}`);
console.log(`[probe] Initial title: ${await page.title()}`);

// Connect login page has TWO forms:
//   1) local email/password (name="login", name="password")
//   2) OAuth button: <form action="/accounts/commcarehq/login/?process=login">
//      with a <button> containing text "Login with CommCareHQ"
// Click the OAuth button.
const oauthButton = await page.$('button:has-text("Login with CommCareHQ")');
if (oauthButton) {
  console.log('[probe] Found OAuth button — clicking');
  await Promise.all([
    page.waitForLoadState('networkidle'),
    oauthButton.click(),
  ]).catch((e) => console.log('[probe] click awaits errored (often safe to ignore):', e.message));
} else {
  console.log('[probe] OAuth button NOT found — Connect template may have changed');
}

const afterClickUrl = page.url();
console.log(`[probe] URL after click: ${afterClickUrl}`);

if (/commcarehq\.org/.test(afterClickUrl)) {
  console.log('[probe] On CommCare HQ; filling creds');
  // HQ login form selectors confirmed live: input[name="auth-username"] / auth-password.
  await page.fill('input[name="auth-username"]', hqUser);
  await page.fill('input[name="auth-password"]', hqPass);
  console.log('[probe] Submitting HQ login form');

  // HQ login form is Knockout-driven with multiple <button type="submit"> elements
  // in the page (language picker, Continue, Sign In). Use the visible "Sign In"
  // button — the Knockout `data-bind="visible:..."` toggles which is displayed.
  const signInButton = page.locator('button:has-text("Sign In"):visible').first();

  // Wait for the post-submit nav to leave the login page. The match below uses
  // a URL host check (not regex over the full URL) because the OAuth-callback
  // URL contains "connect.dimagi.com" in its redirect_uri querystring, which
  // would falsely satisfy /connect\.dimagi\.com/.
  const isHostConnect = (u: URL) => u.hostname === 'connect.dimagi.com';
  const isHqAuthorize = (u: URL) => u.hostname === 'www.commcarehq.org' && u.pathname.startsWith('/oauth/authorize');

  try {
    await Promise.all([
      page.waitForURL((u) => isHostConnect(new URL(u)) || isHqAuthorize(new URL(u)), { timeout: 30_000 }),
      signInButton.click(),
    ]);

    // If HQ presented an OAuth-approve page (first-time grant), click the approve button
    if (isHqAuthorize(new URL(page.url()))) {
      console.log('[probe] On OAuth approve page; clicking Authorize');
      const approve = page.locator('input[name="allow"], button:has-text("Authorize"), button:has-text("Allow")').first();
      await Promise.all([
        page.waitForURL((u) => isHostConnect(new URL(u)), { timeout: 15_000 }),
        approve.click(),
      ]);
    }
    console.log('[probe] OAuth flow completed — back on Connect');
  } catch (e) {
    console.log(`[probe] Did NOT land back on Connect: ${(e as Error).message}`);
    console.log(`[probe] Stuck at: ${page.url()}`);
    // Capture the page so we can see whether HQ rejected creds, asked for 2FA, or showed an OAuth-approve prompt
    const snippet = (await page.content()).slice(0, 4000);
    console.log('[probe] Page HTML snippet:');
    console.log(snippet);
  }
}

console.log(`[probe] Final URL: ${page.url()}`);
console.log('[probe] Cookies:');
for (const c of await context.cookies()) {
  console.log(`  ${c.domain}/${c.name} = ${c.value.slice(0, 12)}…`);
}

fs.mkdirSync(path.dirname(stateFile), { recursive: true });
await context.storageState({ path: stateFile });
console.log(`[probe] storageState saved to ${stateFile}`);

await browser.close();

/* Observations (record after running):
 *
 * Date:        2026-04-28
 * Connect URL: https://connect.dimagi.com/
 *
 * 1. Initial nav lands on:    [TODO: fill in]
 * 2. OAuth-button selector:   [TODO: fill in OR record "no button — local form"]
 * 3. HQ login URL:            [TODO]
 * 4. HQ user-input selector:  [TODO]
 * 5. HQ pass-input selector:  [TODO]
 * 6. Session cookie name(s):  [TODO]
 * 7. Authed probe URL:        [TODO — first 200-when-authed page we found]
 */
