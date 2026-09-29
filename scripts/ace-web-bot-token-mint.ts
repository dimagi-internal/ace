#!/usr/bin/env tsx
/**
 * Mint ACE's OWN ace-web token — as ace@dimagi-ai.com, headlessly, through
 * ace-web's ordinary sign-in and authorize pages.
 *
 * ## Why this exists
 *
 * `ACE_WEB_PAT_TOKEN` authenticates ACE to ace-web's API (bin/ace-bind, fork-run,
 * clone-to-new-workspace, share-run-access invites, the video skills,
 * upload-transcript). It used to be minted by `/ace:ace-web-pat-mint`, which
 * opens the OPERATOR'S browser — so the token belongs to whichever human
 * clicked Authorize, and ace-web attributes ACE's writes to that person. Since
 * ace-web#670, `ace@dimagi-ai.com` is a first-class ace-web user (an OWNER of
 * `dimagi-team`), so ACE should hold its own token, provisioned like every
 * credential, obtained automatically by `/ace:setup` on each machine.
 *
 * The only documented way to get that token was a server-side management
 * command (`mint_personal_token`), which needs shell access to the deployed
 * ace-web — not an operator's job. This script uses nothing but the public
 * surfaces a human uses, driven as ACE:
 *
 *   hqOAuthLogin                (ACE's maintained Connect login as
 *                                ACE_HQ_USERNAME — handles HQ's
 *                                project-space consent step)
 *   → /auth/cli/authorize/?cb=… (login_required → /auth/login/)
 *   → "Sign in with Connect"    (/auth/initiate/ → Connect OAuth consent)
 *   → back on /auth/cli/authorize/ → click Authorize
 *   → 302 to http://127.0.0.1:<port>/cb?token=…&state=…
 *
 * ace-web admits ace@dimagi-ai.com by its workspace MEMBERSHIP
 * (apps/auth/login_gate.py `admission_rule`), not by domain.
 *
 * The loopback redirect lands on a listener this process binds to 127.0.0.1
 * for the duration of the mint, so the token never leaves the machine. The
 * state nonce is checked exactly as the interactive flow checks it.
 *
 * Usage:
 *   npx tsx scripts/ace-web-bot-token-mint.ts --ensure
 *
 * Called by `bin/ace-setup` and the doctor's heal — there is no separate step
 * and no stored copy anywhere but this machine's `.env`. `--ensure`:
 *   - keeps the current ACE_WEB_PAT_TOKEN if it already authenticates as
 *     ace@dimagi-ai.com (no browser launched);
 *   - otherwise mints a token labelled for THIS machine (`ace-bot-<host>`),
 *     writes it to the local-only block of the plugin .env (the block
 *     `/ace:setup` preserves), and revokes this machine's earlier tokens, so
 *     re-running never accumulates them.
 * It is the same move ACE already makes for Connect and OCS — log in as ACE
 * on first use and keep the result locally — except ace-web wants a token
 * rather than a cookie.
 *
 * Status lines go to stderr/stdout; the token itself is never printed.
 * Exit 0 = a verified token is in .env; 1 = could not get one.
 */

import { chromium } from 'playwright';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { createServer } from 'node:http';
import { loadPluginEnv } from '../lib/load-plugin-env.js';
import { hqOAuthLogin } from '../mcp/connect/auth/hq-oauth-login.js';
import { writeTokenToEnv } from './ace-web-pat-mint.js';

loadPluginEnv(import.meta.url);

const BASE = (process.env.ACE_WEB_BASE_URL || 'https://labs.connect.dimagi.com/ace').replace(/\/$/, '');
const EXPECTED_EMAIL = 'ace@dimagi-ai.com';
const CONNECT_BASE = (process.env.CONNECT_BASE_URL || 'https://connect.dimagi.com').replace(/\/$/, '');
const LOOPBACK_PORT = 49_152 + Math.floor(Math.random() * 10_000);
const CB = `http://127.0.0.1:${LOOPBACK_PORT}/cb`;

/** Stable per machine, so a re-mint can find and revoke its predecessors. */
export function machineLabel(host: string = hostname()): string {
  const h = host.split('.')[0].replace(/[^A-Za-z0-9-]/g, '').toLowerCase() || 'host';
  return `ace-bot-${h}`;
}

/** Pure: pull the token out of the loopback redirect, refusing a state mismatch. */
export function tokenFromCallback(url: string, expectedState: string): string {
  const u = new URL(url);
  if (u.searchParams.get('state') !== expectedState) {
    throw new Error('state mismatch on the loopback redirect — refusing the token');
  }
  const token = u.searchParams.get('token');
  if (!token) throw new Error('loopback redirect carried no token');
  return token;
}

export async function mintAceWebBotToken(label: string): Promise<string> {
  const user = process.env.ACE_HQ_USERNAME;
  const pass = process.env.ACE_HQ_PASSWORD;
  if (!user || !pass) throw new Error('ACE_HQ_USERNAME / ACE_HQ_PASSWORD missing from the plugin .env');
  if (user.toLowerCase() !== EXPECTED_EMAIL) {
    // The whole point is a token that belongs to ACE. Minting under anyone
    // else's HQ login would recreate the attribution problem this replaces.
    throw new Error(`ACE_HQ_USERNAME is ${user}, not ${EXPECTED_EMAIL} — refusing to mint under another identity`);
  }

  const state = randomBytes(32).toString('base64url');
  const authorizeUrl =
    `${BASE}/auth/cli/authorize/?cb=${encodeURIComponent(CB)}&state=${state}` +
    `&label=${encodeURIComponent(label)}`;

  const browser = await chromium.launch({ headless: true });
  const closers: Array<() => Promise<void>> = [];
  try {
    const context = await browser.newContext();

    // 1. A Connect session as ACE, through ACE's own maintained login (the HQ
    //    project-space consent step and its quirks live there, not here).
    console.error(`[1/5] Connect session as ${EXPECTED_EMAIL} (hqOAuthLogin)`);
    await hqOAuthLogin({ context, baseUrl: CONNECT_BASE, hqUsername: user, hqPassword: pass });

    const page = await context.newPage();
    if (process.env.ACE_TOKEN_MINT_DEBUG) {
      page.on('response', (r) => console.error(`  ${r.request().method()} ${r.status()} ${r.url().split('?')[0]}`));
      page.on('requestfailed', (r) => console.error(`  FAILED ${r.url().split('?')[0]} ${r.failure()?.errorText}`));
    }
    // A real loopback listener, like the interactive flow. (Intercepting the
    // redirect with page.route did not fire for this cross-origin 302 — the
    // browser went to the socket and got ECONNREFUSED — while the token had
    // already been minted server-side. A listener is what ace-web's
    // cli_authorize is designed to hand off to.)
    let captured: string | null = null;
    const server = createServer((req, res) => {
      captured = `http://127.0.0.1:${LOOPBACK_PORT}${req.url ?? ''}`;
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(LOOPBACK_PORT, '127.0.0.1', () => resolve());
    });
    closers.push(() => new Promise<void>((r) => server.close(() => r())));

    console.error(`[2/5] opening ace-web authorize (${BASE})`);
    await page.goto(authorizeUrl, { waitUntil: 'load' });

    if (new URL(page.url()).pathname.includes('/auth/login')) {
      console.error('[3/5] ace-web login → Sign in with Connect');
      await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('a:has-text("Sign in with Connect")')]);
    }

    // 2. Connect's one-time "authorize ace-web?" consent, then back to ace-web.
    for (let hop = 0; hop < 4 && !captured; hop++) {
      await page.waitForLoadState('load');
      if (new URL(page.url()).pathname.endsWith('/auth/cli/authorize/')) break;
      const allow = page
        .locator('input[name="allow"]:not([disabled]), button:has-text("Authorize"), button:has-text("Allow"), input[value="Authorize"]')
        .first();
      if ((await allow.count()) === 0) break;
      console.error(`[3/5] consent on ${new URL(page.url()).host}`);
      await Promise.all([page.waitForLoadState('load'), allow.click()]);
    }

    if (!captured) {
      if (!new URL(page.url()).pathname.endsWith('/auth/cli/authorize/')) {
        const msg = (await page.locator('body').innerText().catch(() => '')).slice(0, 300).replace(/\s+/g, ' ');
        throw new Error(`did not reach ace-web's authorize page — at ${page.url()} :: ${msg}`);
      }
      console.error('[4/5] ace-web authorize → Authorize');
      await page.locator('form button[type="submit"]:has-text("Authorize")').click();
      for (let i = 0; i < 40 && !captured; i++) await page.waitForTimeout(250);
    }
    if (!captured) {
      const body = (await page.locator('body').innerText().catch(() => '')).slice(0, 300).replace(/\s+/g, ' ');
      throw new Error(`Authorize was clicked but no loopback redirect arrived — at ${page.url()} :: ${body}`);
    }
    return tokenFromCallback(captured, state);
  } finally {
    for (const close of closers) await close();
    await browser.close();
  }
}

/** Prove the token authenticates AS ACE before anyone stores it. */
export async function verifyAceWebToken(token: string): Promise<{ email: string }> {
  // /api/auth/me is behind session_auth, which accepts Bearer tokens.
  const res = await fetch(`${BASE}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`minted token does not authenticate: GET /api/auth/me → HTTP ${res.status}`);
  const email = String(((await res.json()) as { email?: string }).email ?? '').toLowerCase();
  if (email !== EXPECTED_EMAIL) throw new Error(`token authenticates as ${email || '(no email)'}, not ${EXPECTED_EMAIL}`);
  return { email };
}

/** Does this token authenticate as ACE? Network errors count as "no". */
async function isAceToken(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  try {
    await verifyAceWebToken(token);
    return true;
  } catch {
    return false;
  }
}

/** Revoke every OTHER token on ACE's account that carries this machine's label. */
export async function revokeSiblings(token: string, label: string): Promise<number[]> {
  const res = await fetch(`${BASE}/api/tokens`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return [];
  const rows = (await res.json()) as Array<{ id: number; name: string; created_at: string }>;
  const mine = rows.filter((r) => r.name === label).sort((x, y) => y.created_at.localeCompare(x.created_at));
  const revoked: number[] = [];
  for (const old of mine.slice(1)) {
    const del = await fetch(`${BASE}/api/tokens/${old.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (del.status === 204) revoked.push(old.id);
  }
  return revoked;
}

export function pluginEnvPath(): string {
  const dir = process.env.CLAUDE_PLUGIN_DATA || `${process.env.HOME}/.claude/plugins/data/ace-ace`;
  return `${dir}/.env`;
}

async function ensure(): Promise<number> {
  if (await isAceToken(process.env.ACE_WEB_PAT_TOKEN)) {
    console.log(`PASS ace_web_token: ACE_WEB_PAT_TOKEN already authenticates as ${EXPECTED_EMAIL}`);
    return 0;
  }
  const label = machineLabel();
  const token = await mintAceWebBotToken(label);
  await verifyAceWebToken(token);
  const envPath = pluginEnvPath();
  await writeTokenToEnv(envPath, 'ACE_WEB_PAT_TOKEN', token);
  const revoked = await revokeSiblings(token, label);
  console.log(
    `PASS ace_web_token: signed in to ace-web as ${EXPECTED_EMAIL}, minted "${label}" into ${envPath}` +
      (revoked.length ? ` (revoked this machine's older token(s): ${revoked.join(', ')})` : ''),
  );
  return 0;
}

async function main(): Promise<void> {
  if (!process.argv.includes('--ensure')) {
    console.error('usage: ace-web-bot-token-mint.ts --ensure   (called by /ace:setup)');
    process.exit(2);
  }
  process.exit(await ensure());
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.log(`WARN ace_web_token: could not get ACE's ace-web token — ${(e as Error).message}`);
    process.exit(1);
  });
}
