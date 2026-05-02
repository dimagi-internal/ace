/**
 * Search every Connect org/opportunity that ace@dimagi-ai.com has admin
 * access to and report any opportunity whose `/user_invite/` page contains
 * the target phone. Used by `/ace:mobile-bootstrap` step 8 to verify (or
 * just locate) the FLW invite that prevents Connect-id `start_configuration`
 * from crashing the CommCare worker on first registration.
 *
 * Scope caveat: Connect-id's `check_number_for_existing_invites(phone)` is a
 * GLOBAL check, but this probe is org-scoped to whatever orgs the cached
 * session can see (links on /accounts/login/). A clean miss here does NOT
 * prove the invite is missing system-wide — it just means it isn't in any
 * visible org.
 *
 * Inputs (env): TARGET_PHONE (required, e.g. +74260000100), CONNECT_BASE_URL,
 * USERDATA. Optionally pre-seed cookies via `scripts/seed-connect-cookies.ts`.
 *
 * Run:
 *   TARGET_PHONE=+74260000100 npx tsx scripts/probe-find-phone-invite.ts
 */
import * as os from 'os';
import * as path from 'path';
import { chromium, type APIRequestContext, type BrowserContext } from 'playwright';
import { hqOAuthLogin } from '../mcp/connect/auth/hq-oauth-login.js';

interface Match {
  org: string;
  opp_id: string;
  via: string;
}

async function discoverOrgsFromLanding(
  ctx: BrowserContext,
  baseUrl: string,
): Promise<string[]> {
  // /accounts/login/ on an authed session redirects to /a/<org>/opportunity/
  // and renders an org-switcher with /a/<other-org>/... links.
  const page = await ctx.newPage();
  try {
    await page.goto(`${baseUrl}/accounts/login/`);
    const hrefs = await page.$$eval('a[href]', (as) =>
      as.map((a) => a.getAttribute('href')!).filter((h) => h && h.startsWith('/a/')),
    );
    return [...new Set(hrefs.map((h) => h.split('/')[2]).filter(Boolean))];
  } finally {
    await page.close();
  }
}

async function listOpps(
  request: APIRequestContext,
  baseUrl: string,
  org: string,
): Promise<string[]> {
  const r = await request.get(`${baseUrl}/a/${org}/opportunity/`);
  if (!r.ok()) return [];
  const html = await r.text();
  const re = new RegExp(`/a/${org}/opportunity/([0-9a-f-]{36})/`, 'g');
  return [...new Set([...html.matchAll(re)].map((m) => m[1]))];
}

async function probeOppForPhone(
  request: APIRequestContext,
  baseUrl: string,
  org: string,
  oppId: string,
  phone: string,
): Promise<{ matched: boolean; via: string | null }> {
  // /user_invite/ is the FLW-invite list page (confirmed via probe-opp-paths.ts).
  // Phones appear without the leading `+` in rendered HTML.
  const candidates = [
    `/a/${org}/opportunity/${oppId}/user_invite/`,
    `/a/${org}/opportunity/${oppId}/`,
  ];
  const noPlus = phone.replace(/^\+/, '');
  const variants = [
    phone,
    noPlus,
    encodeURIComponent(phone),
    phone.replace('+', '%2B'),
    phone.replace('+', '&#43;'),
  ];
  for (const p of candidates) {
    const r = await request.get(`${baseUrl}${p}`);
    if (!r.ok()) continue;
    const txt = await r.text();
    if (variants.some((v) => txt.includes(v))) {
      return { matched: true, via: p };
    }
  }
  return { matched: false, via: null };
}

async function main() {
  const target = process.env.TARGET_PHONE;
  if (!target) {
    console.error('TARGET_PHONE env var required (e.g. +74260000100)');
    process.exit(2);
  }
  const baseUrl = process.env.CONNECT_BASE_URL ?? 'https://connect.dimagi.com';
  const userDataDir = process.env.USERDATA ?? path.join(os.homedir(), '.ace/playwright-userdata');

  const ctx = await chromium.launchPersistentContext(userDataDir, { headless: true });
  try {
    let orgs = (process.env.ORGS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (orgs.length === 0) {
      orgs = await discoverOrgsFromLanding(ctx, baseUrl);
    }
    if (orgs.length === 0 && process.env.ACE_HQ_USERNAME && process.env.ACE_HQ_PASSWORD) {
      // Cookies stale — re-auth once and retry org discovery.
      await hqOAuthLogin({
        context: ctx,
        baseUrl,
        hqUsername: process.env.ACE_HQ_USERNAME,
        hqPassword: process.env.ACE_HQ_PASSWORD,
      });
      orgs = await discoverOrgsFromLanding(ctx, baseUrl);
    }
    console.log(`orgs to scan: ${JSON.stringify(orgs)}`);

    const matches: Match[] = [];
    for (const org of orgs) {
      const opps = await listOpps(ctx.request, baseUrl, org);
      console.log(`[${org}] opportunities discovered: ${opps.length}`);
      for (const oppId of opps) {
        const r = await probeOppForPhone(ctx.request, baseUrl, org, oppId, target);
        if (r.matched) {
          console.log(`[${org}] MATCH opp=${oppId} via=${r.via}`);
          matches.push({ org, opp_id: oppId, via: r.via! });
        }
      }
    }

    console.log('\n=== SUMMARY ===');
    console.log(`Target: ${target}`);
    console.log(`Matches: ${matches.length}`);
    if (matches.length) {
      console.log(JSON.stringify(matches, null, 2));
      console.log('RESULT: INVITE_FOUND');
    } else {
      console.log('RESULT: NO_INVITE_FOUND_IN_VISIBLE_ORGS');
      console.log(
        'NOTE: Connect-id check is global; this probe is org-scoped. ' +
          'Run scripts/probe-flw-invite.ts to add an invite to a known turmeric opp.',
      );
    }
  } finally {
    await ctx.close();
  }
}

main().catch((e) => {
  console.error('FAIL:', e?.message ?? e);
  process.exit(1);
});
