#!/usr/bin/env tsx
/**
 * doctor-mobile-auth: live auth probe for the ace-mobile MCP's Playwright
 * cookie jar. Mobile auth is unique among ACE MCPs because cookies live in
 * a Chromium persistent profile (SQLite, OS-keychain-encrypted on macOS),
 * so we can't curl them directly the way OCS and Connect do. This helper
 * launches the same persistent context that mcp/mobile/auth/fetch-otp.ts
 * uses, makes ONE authed-only HTTP GET (no OTP consumption), and prints
 * a single JSON line so bin/ace-doctor can parse it.
 *
 * Output schema: { ok: boolean, status: number|null, url: string|null,
 *                  message?: string }
 *   ok=true  → cookies are valid and the OTP page renders authed
 *   ok=false → cookies missing/expired (status 200 = bounced to login form,
 *              302 to /accounts/login/ = expired, network error = message)
 */

import { chromium } from 'playwright';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Probe `/accounts/login/` rather than `/users/connect_user_otp/` (the URL
// fetch-otp.ts actually scrapes). Reasons: the OTP page has unrelated
// permission/header checks that can return 403 even for an authed session
// (observed 2026-05-06 during the doctor [Auth liveness] rollout); the
// login-form bounce is a cleaner authed-state signal — same probe shape
// the Connect MCP uses in mcp/connect/auth/playwright-session.ts. 302 =
// authed (Connect bounces logged-in users away from the form), 200 = anon.
const PROBE_URL = 'https://connect.dimagi.com/accounts/login/';

async function main(): Promise<void> {
  const userDataDir =
    process.env.ACE_PLAYWRIGHT_USER_DATA_DIR ||
    path.join(os.homedir(), '.ace', 'playwright-userdata');

  if (!fs.existsSync(userDataDir)) {
    process.stdout.write(
      JSON.stringify({ ok: false, status: null, url: null, message: `userDataDir missing: ${userDataDir}` }) + '\n',
    );
    return;
  }

  const context = await chromium.launchPersistentContext(userDataDir, { headless: true });
  try {
    const res = await context.request.get(PROBE_URL, { maxRedirects: 0, timeout: 8000 });
    const status = res.status();
    const url = res.url();
    if (status === 301 || status === 302) {
      process.stdout.write(JSON.stringify({ ok: true, status, url }) + '\n');
    } else if (status === 200) {
      process.stdout.write(
        JSON.stringify({ ok: false, status, url, message: 'login form rendered (cookies expired or missing)' }) + '\n',
      );
    } else {
      process.stdout.write(
        JSON.stringify({ ok: false, status, url, message: `unexpected status ${status}` }) + '\n',
      );
    }
  } catch (e) {
    process.stdout.write(
      JSON.stringify({ ok: false, status: null, url: null, message: (e as Error).message }) + '\n',
    );
  } finally {
    await context.close().catch(() => {});
  }
}

main().catch((e) => {
  process.stdout.write(
    JSON.stringify({ ok: false, status: null, url: null, message: `fatal: ${(e as Error).message}` }) + '\n',
  );
  process.exit(0);
});
