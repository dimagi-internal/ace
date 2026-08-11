#!/usr/bin/env tsx
/**
 * Labs MCP Personal Access Token minter.
 *
 * Drives the full Labs → Connect → CommCareHQ OAuth chain headlessly as
 * ace@dimagi-ai.com, navigates to the self-service tokens UI at
 * /labs/mcp/tokens/, creates a token, scrapes the raw value, and prints
 * it to stdout.
 *
 * Backs the `/ace:labs-token-mint` slash command. Use that command
 * (or run this script directly) to:
 *   - First-time PAT provision on a new machine
 *   - Rotate an expired or compromised PAT
 *   - Mint a labelled second token for testing alongside the production one
 *
 * Reads ACE_HQ_USERNAME / ACE_HQ_PASSWORD from the installed .env at
 * `${CLAUDE_PLUGIN_DATA}/.env` (or the legacy plugin-root fallback).
 *
 * Usage:
 *   npx tsx scripts/labs-mint-token.ts [name] [ttl_days]
 *     name      defaults to "ACE-plugin"
 *     ttl_days  defaults to 0 (no expiry)
 *
 * Stdout: just the raw token (pipeable). Diagnostics on stderr.
 *
 * Run from the plugin root so Playwright resolves out of node_modules/.
 */

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const ENV_FILE = process.env.CLAUDE_PLUGIN_DATA
  ? `${process.env.CLAUDE_PLUGIN_DATA}/.env`
  : `${process.env.HOME}/.claude/plugins/data/ace-ace/.env`;
const env = Object.fromEntries(
  readFileSync(ENV_FILE, 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const eq = l.indexOf('=');
      return [l.slice(0, eq).trim(), l.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '')];
    }),
);
const HQ_USERNAME = env.ACE_HQ_USERNAME;
const HQ_PASSWORD = env.ACE_HQ_PASSWORD;
if (!HQ_USERNAME || !HQ_PASSWORD) {
  throw new Error('ACE_HQ_USERNAME / ACE_HQ_PASSWORD missing from .env');
}

const TOKEN_NAME = process.argv[2] || 'ACE-plugin';
// Labs constrains ttl_days to 1..365 (`min="1" max="365"` on the form input).
// 0 ("no expiry") used to be accepted and is now rejected client-side, which
// manifests as a silent no-op POST — so 365 is the longest available default.
const TTL_DAYS = process.argv[3] || '365';
const LABS_BASE = 'https://labs.connect.dimagi.com';
const TOKENS_URL = `${LABS_BASE}/labs/mcp/tokens/`;
const INITIATE_URL = `${LABS_BASE}/labs/initiate/?next=/labs/mcp/tokens/`;

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.error(`[1/5] navigating to ${INITIATE_URL}`);
  await page.goto(INITIATE_URL, { waitUntil: 'load' });

  console.error(`[2/5] current URL: ${page.url()}`);

  // We expect to be on www.commcarehq.org/accounts/login eventually.
  if (!page.url().includes('commcarehq.org')) {
    // Try clicking through Connect-side auth buttons if present.
    const connectButton = await page.$('button:has-text("Login with CommCareHQ"), a:has-text("Login with CommCareHQ")');
    if (connectButton) {
      console.error(`[2/5] clicking Connect's "Login with CommCareHQ"`);
      await Promise.all([
        page.waitForURL((u) => /commcarehq\.org/.test(new URL(u).hostname), { timeout: 30_000 }),
        connectButton.click(),
      ]);
    }
  }

  if (!page.url().includes('commcarehq.org')) {
    throw new Error(`Did not reach CCHQ login. Current URL: ${page.url()}`);
  }

  console.error(`[3/5] CCHQ login: filling creds`);
  await page.fill('input[name="auth-username"]', HQ_USERNAME);
  await page.fill('input[name="auth-password"]', HQ_PASSWORD);
  const signIn = page.locator('button:has-text("Sign In"):visible').first();
  await Promise.all([
    page.waitForURL(
      (u) => {
        const host = new URL(u).hostname;
        return host === 'connect.dimagi.com' || host === 'labs.connect.dimagi.com' ||
               (host === 'www.commcarehq.org' && new URL(u).pathname.startsWith('/oauth/authorize'));
      },
      { timeout: 30_000 },
    ),
    signIn.click(),
  ]);

  // Walk through any OAuth consent screens
  for (let hop = 0; hop < 3; hop++) {
    const url = new URL(page.url());
    if (url.hostname === 'labs.connect.dimagi.com' && url.pathname.startsWith('/labs/mcp/tokens')) {
      break;
    }
    const allow = page.locator('input[name="allow"], button:has-text("Authorize"), button:has-text("Allow")').first();
    if (await allow.count() > 0) {
      console.error(`[3/5] OAuth consent hop ${hop + 1} on ${url.host}${url.pathname}`);
      await Promise.all([
        page.waitForLoadState('load'),
        allow.click(),
      ]);
    } else {
      // Maybe redirected automatically — wait briefly then re-evaluate
      await page.waitForLoadState('load');
      const newUrl = new URL(page.url());
      if (newUrl.host === url.host && newUrl.pathname === url.pathname) {
        // No progress; bail
        break;
      }
    }
  }

  // Make sure we end on /labs/mcp/tokens/
  if (!page.url().includes('/labs/mcp/tokens')) {
    console.error(`[4/5] not on tokens page (${page.url()}), navigating directly`);
    await page.goto(TOKENS_URL, { waitUntil: 'load' });
  }

  if (!page.url().includes('/labs/mcp/tokens')) {
    throw new Error(`Failed to land on tokens UI. Current URL: ${page.url()}`);
  }

  console.error(`[4/5] on tokens page, filling form: name="${TOKEN_NAME}" ttl_days=${TTL_DAYS}`);
  await page.fill('input[name="name"]', TOKEN_NAME);

  // Validate ttl_days against the form's OWN bounds before submitting.
  // An out-of-range value is rejected by HTML5 constraint validation, which
  // blocks the POST silently — the click resolves, no token is created, and the
  // failure only surfaces 15s later as a confusing '#raw-token' timeout. Read
  // min/max off the live input so this keeps working if labs changes them.
  const ttlInput = page.locator('input[name="ttl_days"]');
  const bounds = await ttlInput.evaluate((el) => ({
    min: (el as HTMLInputElement).min,
    max: (el as HTMLInputElement).max,
  }));
  const ttlNum = Number(TTL_DAYS);
  const min = bounds.min === '' ? -Infinity : Number(bounds.min);
  const max = bounds.max === '' ? Infinity : Number(bounds.max);
  if (!Number.isFinite(ttlNum) || ttlNum < min || ttlNum > max) {
    throw new Error(
      `ttl_days=${TTL_DAYS} is outside the range labs accepts (min=${bounds.min || 'none'}, ` +
        `max=${bounds.max || 'none'}). Note that 0 ("no expiry") is no longer accepted — ` +
        `pass ${bounds.max || 365} for the longest-lived token.`,
    );
  }
  await ttlInput.fill(TTL_DAYS);
  // Submit the create form
  await Promise.all([
    page.waitForLoadState('load'),
    page.locator('form[action*="/labs/mcp/tokens/create/"] button[type="submit"]').first().click(),
  ]);

  console.error(`[5/5] submitted; reading raw token from DOM`);
  // The created token is rendered as <code id="raw-token">...</code>
  const rawTokenLocator = page.locator('#raw-token');
  try {
    await rawTokenLocator.waitFor({ state: 'visible', timeout: 15_000 });
  } catch {
    // Still sitting on the form means the POST never landed. Surface any
    // server-side form errors instead of a bare locator timeout.
    const formErrors = (await page.locator('.errorlist, [role="alert"], .text-red-600').allTextContents())
      .map((t) => t.trim())
      .filter(Boolean);
    throw new Error(
      `#raw-token never rendered — the create POST did not complete.` +
        (formErrors.length ? ` Form errors: ${formErrors.join('; ')}.` : '') +
        ` Check that ttl_days is in range and that no token row was created before retrying.`,
    );
  }
  const rawToken = (await rawTokenLocator.textContent())?.trim();
  if (!rawToken) {
    throw new Error('raw-token element empty');
  }

  // stdout: just the raw token (so it's pipeable)
  process.stdout.write(rawToken + '\n');
  console.error(`[done] minted token "${TOKEN_NAME}", length=${rawToken.length}`);

  await browser.close();
}

main().catch((err) => {
  console.error(`FATAL: ${err.message}`);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
