#!/usr/bin/env npx tsx
/**
 * Refresh Nova's stored list of reachable CommCare HQ project spaces, headless,
 * as ACE's own Google identity — the Refresh button on the CommCare HQ card at
 * https://commcare.app/settings, pressed by ACE rather than by the operator.
 *
 * Why it is a browser: `lib/nova-hq-refresh.ts` header. Short version — Nova
 * stores `approved_domains` when the HQ key is saved, `get_hq_connection` returns
 * that stored set, and the only way to re-read it is a better-auth browser
 * session's server action. No MCP tool or API key reaches it.
 *
 * HEADLESS, ALWAYS (owner directive, 2026-10-08): this must never pop a window
 * on the operator's machine. There is deliberately no flag to turn headless off;
 * `test/lib/nova-hq-refresh.test.ts` fails CI if one appears.
 *
 * Credentials: Google username + password are read at runtime with `op read`
 * from `op://Agent-Ace/Ace - gmail/{username,password}` — never from `.env`,
 * never logged, never echoed into the JSON. The persistent profile at
 * `~/.ace/nova-google-profile` (outside the repo) reuses the session, so most
 * runs never reach the Google form at all.
 *
 * Lessons carried from the 2026-10-08 reference run (do not "simplify" them):
 *   - headless Google renders the email field as `#identifierId`, not
 *     `input[type=email]`; wait for it visible, then ~2s, before typing
 *   - type with pressSequentially (fill() is ignored by Google's handlers)
 *   - click Next by ROLE; password is `input[name="Passwd"]` / visible password
 *   - any Google challenge (2FA, "verify it's you", "browser not secure") is a
 *     typed, named stop — never a retry loop
 *
 * Usage:
 *   node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/nova-refresh-hq-domains.ts" [--domain <hq-space>]
 *
 *   --domain X   ensure mode: read get_hq_connection; if X is present do nothing,
 *                else refresh ONCE and re-read (lib/nova-hq-refresh.ts).
 *   (no flag)    refresh unconditionally, then report the list.
 *
 * Output (stdout, one JSON object):
 *   {ok, status, domain?, refreshed, before_count, after_count, domains[],
 *    stopped_reason?, card_text?, detail?, remediation}
 * Exit: 0 ok · 1 read/usage error · 2 refresh blocked (Google challenge,
 *       browser) · 3 still missing after refresh.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadPluginEnv } from '../lib/load-plugin-env.js';
import { novaRpc, unwrapToolResult } from '../lib/nova-rpc.js';
import {
  NOVA_SETTINGS_URL,
  classifyGoogleChallenge,
  ensureNovaHqDomain,
  exitCodeFor,
  extractDomainNames,
  type BrowserRefreshResult,
  type EnsureResult,
} from '../lib/nova-hq-refresh.js';

loadPluginEnv(import.meta.url);

const OP_USER_REF = 'op://Agent-Ace/Ace - gmail/username';
const OP_PASS_REF = 'op://Agent-Ace/Ace - gmail/password';
const PROFILE_DIR = join(homedir(), '.ace', 'nova-google-profile');

function opRead(ref: string): string {
  // execFile, not a shell: the reference contains spaces, and nothing here may
  // ever be interpolated into a command line that could be logged.
  return execFileSync('op', ['read', ref], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000 }).trim();
}

async function readDomains(): Promise<string[]> {
  const result = await novaRpc('tools/call', { name: 'get_hq_connection', arguments: {} });
  return extractDomainNames(unwrapToolResult(result, 'get_hq_connection'));
}

function excerpt(text: string): string {
  return (text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
}

/** The browser step: sign in if needed, press Refresh, read the card. */
async function browserRefresh(): Promise<BrowserRefreshResult> {
  let user: string;
  let pass: string;
  try {
    user = opRead(OP_USER_REF);
    pass = opRead(OP_PASS_REF);
  } catch {
    return { ok: false, stopped_reason: 'credentials-unavailable', detail: `op read failed for ${OP_USER_REF} / password (is 1Password signed in?)` };
  }
  if (!user || !pass) return { ok: false, stopped_reason: 'credentials-unavailable', detail: 'op read returned empty' };

  const { chromium } = await import('playwright');
  mkdirSync(PROFILE_DIR, { recursive: true });
  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: true, // NEVER configurable — see header.
      viewport: { width: 1280, height: 900 },
      args: ['--disable-blink-features=AutomationControlled'],
    });
  } catch (e) {
    return { ok: false, stopped_reason: 'browser-error', detail: excerpt((e as Error).message) };
  }

  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(NOVA_SETTINGS_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    const onGoogle = () => page.url().includes('accounts.google.com');
    if (!onGoogle() && !(await page.getByText('CommCare HQ').count())) {
      const btn = page.getByRole('button', { name: /Sign in with Google/i });
      if (await btn.count()) {
        await btn.first().click();
        await page.waitForURL('**accounts.google.com/**', { timeout: 30_000 });
      }
    }

    if (onGoogle()) {
      await page.waitForTimeout(1500);
      // An account chooser (profile remembers ace@ but the session lapsed).
      const chooser = page.getByText(user, { exact: false });
      const email = page.locator('#identifierId, input[type="email"], input[name="identifier"]').first();
      if (!(await email.isVisible().catch(() => false)) && (await chooser.count())) {
        await chooser.first().click();
        await page.waitForTimeout(4000);
      } else {
        await email.waitFor({ state: 'visible', timeout: 20_000 });
        await page.waitForTimeout(2000);
        await email.click();
        await email.pressSequentially(user, { delay: 60 });
        await page.getByRole('button', { name: 'Next' }).first().click();
        await page.waitForTimeout(5000);
      }

      if (onGoogle()) {
        const pw = page.locator('input[name="Passwd"], input[type="password"]:visible, input[name="password"]').first();
        try {
          await pw.waitFor({ state: 'visible', timeout: 15_000 });
        } catch {
          const body = await page.innerText('body').catch(() => '');
          const reason = classifyGoogleChallenge(body);
          return {
            ok: false,
            stopped_reason: reason === 'google-unknown-challenge' ? 'google-no-password-field' : reason,
            detail: excerpt(body),
          };
        }
        await pw.fill(pass);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(6000);
      }

      // Consent / continue screens.
      for (const label of ['Continue', 'Allow']) {
        const b = page.getByRole('button', { name: label });
        if (onGoogle() && (await b.count())) {
          await b.first().click();
          await page.waitForTimeout(4000);
        }
      }
      if (onGoogle()) {
        const body = await page.innerText('body').catch(() => '');
        return { ok: false, stopped_reason: classifyGoogleChallenge(body), detail: excerpt(body) };
      }
    }

    if (!page.url().includes('/settings')) {
      await page.goto(NOVA_SETTINGS_URL, { waitUntil: 'domcontentloaded' });
    }
    await page.waitForTimeout(4000);
    const refresh = page.getByRole('button', { name: 'Refresh' });
    if (!(await refresh.count())) {
      const body = await page.innerText('body').catch(() => '');
      return { ok: false, stopped_reason: 'no-refresh-button', detail: excerpt(`${page.url()} ${body}`) };
    }
    await refresh.first().click();
    await page.waitForTimeout(6000);
    const txt = await page.innerText('body').catch(() => '');
    const i = txt.indexOf('Connected to');
    return { ok: true, card_text: i >= 0 ? excerpt(txt.slice(i, i + 160)) : '' };
  } catch (e) {
    return { ok: false, stopped_reason: 'browser-error', detail: excerpt((e as Error).message) };
  } finally {
    await ctx.close().catch(() => {});
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const di = args.indexOf('--domain');
  const domain = di >= 0 ? args[di + 1] : undefined;
  if (di >= 0 && (!domain || domain.startsWith('--'))) {
    console.error('usage: nova-refresh-hq-domains.ts [--domain <hq-space>]');
    return 1;
  }

  let out: EnsureResult | Record<string, unknown>;
  if (domain) {
    out = await ensureNovaHqDomain({ domain, readDomains, refresh: browserRefresh });
    console.log(JSON.stringify(out));
    return exitCodeFor(out.status);
  }

  // Unconditional refresh.
  let before: string[] | null = null;
  try {
    before = await readDomains();
  } catch {
    before = null;
  }
  const r = await browserRefresh();
  if (!r.ok) {
    out = { ...r, ok: false, status: 'refresh-blocked', refreshed: true, before_count: before?.length ?? null, after_count: null, domains: before ?? [], remediation: `press Refresh on the CommCare HQ card at ${NOVA_SETTINGS_URL} as the ACE identity` };
    console.log(JSON.stringify(out));
    return 2;
  }
  let after: string[];
  try {
    after = await readDomains();
  } catch (e) {
    console.log(JSON.stringify({ ok: false, status: 'read-failed', refreshed: true, before_count: before?.length ?? null, after_count: null, domains: [], card_text: r.card_text, detail: excerpt((e as Error).message), remediation: 'run /ace:doctor (nova_auth / nova_scopes)' }));
    return 1;
  }
  console.log(JSON.stringify({ ok: true, status: 'refreshed', refreshed: true, before_count: before?.length ?? null, after_count: after.length, domains: after, card_text: r.card_text, remediation: '' }));
  return 0;
}

process.exit(await main());
