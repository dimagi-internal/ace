/**
 * One-shot probe: invite the ACE test phone to the live turmeric opp using
 * the new connect_send_flw_invite atom.
 *
 * Run from worktree root:
 *   npx tsx scripts/probe-flw-invite.ts
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { PlaywrightSession } from '../mcp/connect/auth/playwright-session.js';
import { PlaywrightBackend } from '../mcp/connect/backends/playwright.js';

const BASE_URL = process.env.CONNECT_BASE_URL ?? 'https://connect.dimagi.com';
const ORG = 'ai-demo-space';
const OPP_IDS = [
  'f574922a-86bc-4c96-95e5-9d736774e43f', // Turmeric Survey — fresh autobuild e2e
  '249ad8fe-fd4f-49c5-8808-93b1cb016860', // Turmeric Market Survey — turmeric (2026-04-29)
  'feea0155-eee1-4ba9-b485-4da024dd7566', // Turmeric Market Survey 2026-04-28
];
const PHONE = '+74260000100';

// Load .env from plugin data dir if not already in env
if (!process.env.ACE_HQ_USERNAME) {
  const envPath = path.join(os.homedir(), '.claude/plugins/data/ace-ace/.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
    }
  }
}

async function setOppBudget(ctx: { request: import('playwright').APIRequestContext }, csrf: string, oppId: string, addUsers: number, totalBudget: number): Promise<boolean> {
  const path = `/a/${ORG}/opportunity/${oppId}/add_budget_new_users`;
  const getRes = await ctx.request.get(path);
  // Get fresh CSRF from the form page
  const m = (await getRes.text()).match(/name=["']csrfmiddlewaretoken["']\s+value=["']([^"']+)["']/);
  const formCsrf = m?.[1] ?? csrf;
  const postRes = await ctx.request.post(path, {
    form: {
      csrfmiddlewaretoken: formCsrf,
      add_users: String(addUsers),
      total_budget: String(totalBudget),
    },
    maxRedirects: 0,
    headers: {
      Referer: `${BASE_URL}${path}`,
      'X-CSRFToken': formCsrf,
      'HX-Request': 'true',
    },
  });
  console.log(`set_budget(${oppId}, +${addUsers} users, $${totalBudget}) → ${postRes.status()}`);
  if (postRes.status() >= 400 && postRes.status() < 600) {
    console.log('body:', (await postRes.text()).slice(0, 500));
    return false;
  }
  return true;
}

async function tryInvite(backend: PlaywrightBackend, oppId: string): Promise<boolean> {
  console.log(`\n--- ${oppId} ---`);
  try {
    const result = await backend.sendFlwInvite({
      organization_slug: ORG,
      opportunity_id: oppId,
      phone_numbers: [PHONE],
    });
    console.log('SUCCESS:', JSON.stringify(result));
    return true;
  } catch (err) {
    if (err instanceof Error) {
      console.log('rejected:', err.message);
      const fe = (err as { fieldErrors?: Record<string, string[]> }).fieldErrors;
      if (fe) console.log('field errors:', JSON.stringify(fe));
    } else {
      console.log('rejected:', err);
    }
    return false;
  }
}

async function main() {
  const session = new PlaywrightSession({
    baseUrl: BASE_URL,
    hqUsername: process.env.ACE_HQ_USERNAME,
    hqPassword: process.env.ACE_HQ_PASSWORD,
  });
  const ctx = await session.getContext();
  const backend = new PlaywrightBackend({
    baseUrl: BASE_URL,
    csrfToken: session.getCsrfToken(),
    request: ctx.request,
  });

  // First, attempt to make 249ad8fe setup-complete by setting its budget.
  // (end_date already set via connect_update_opportunity earlier; PU at id=1
  // has max_total=20.)
  const TARGET = '249ad8fe-fd4f-49c5-8808-93b1cb016860';
  console.log('\n--- setting budget on target opp ---');
  await setOppBudget({ request: ctx.request }, session.getCsrfToken(), TARGET, 5, 50000);

  let successOpp: string | null = null;
  for (const oppId of [TARGET, ...OPP_IDS.filter((o) => o !== TARGET)]) {
    const ok = await tryInvite(backend, oppId);
    if (ok) { successOpp = oppId; break; }
  }

  if (successOpp) {
    console.log(`\nSUCCESS — ${PHONE} invited to ${successOpp}`);
  } else {
    console.log(`\nNO setup-complete opp found in ai-demo-space; ${PHONE} could not be invited.`);
  }

  await session.close?.();
  process.exit(successOpp ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });

// Old per-opp diagnostic kept below for reference; unused.
async function _legacyDiagnose() {
  const session = new PlaywrightSession({
    baseUrl: BASE_URL,
    hqUsername: process.env.ACE_HQ_USERNAME,
    hqPassword: process.env.ACE_HQ_PASSWORD,
  });
  const ctx = await session.getContext();
  const backend = new PlaywrightBackend({
    baseUrl: BASE_URL,
    csrfToken: session.getCsrfToken(),
    request: ctx.request,
  });
  const invitePath = `/a/${ORG}/opportunity/${OPP_IDS[0]}/user_invite/`;
  const getRes = await ctx.request.get(invitePath);
  console.log(`GET ${invitePath} → ${getRes.status()}`);
  const getBody = await getRes.text();
  const csrfMatch = getBody.match(/name=["']csrfmiddlewaretoken["']\s+value=["']([^"']+)["']/);
  const csrf = csrfMatch?.[1] ?? session.getCsrfToken();
  console.log(`csrf: ${csrf?.slice(0, 16)}...`);

  // Log form fields from GET response so we know the expected shape
  const inputs = Array.from(getBody.matchAll(/<(?:input|textarea)[^>]*name=["']([^"']+)["'][^>]*>/g)).map((m) => m[1]);
  console.log('form fields on GET page:', inputs);

  const postRes = await ctx.request.post(invitePath, {
    form: {
      csrfmiddlewaretoken: csrf,
      users: PHONE,
    },
    maxRedirects: 0,
    headers: {
      Referer: `${BASE_URL}${invitePath}`,
      'X-CSRFToken': csrf,
    },
  });
  console.log(`POST ${invitePath} → ${postRes.status()}`);
  if (postRes.status() === 200) {
    const body = await postRes.text();
    // Look for typical Django form error markers
    const errorlist = body.match(/<ul[^>]*class=["'][^"']*errorlist[^"']*["'][^>]*>([\s\S]*?)<\/ul>/g);
    console.log('errorlist matches:', errorlist?.length ?? 0);
    if (errorlist) errorlist.forEach((e) => console.log('  ', e.replace(/\s+/g, ' ').slice(0, 300)));
    // Look for any error/alert/message divs
    const alerts = body.match(/class=["'][^"']*(error|alert|invalid)[^"']*["']/gi);
    console.log('error-class hits:', alerts?.slice(0, 10));
    // Save full body for inspection
    fs.writeFileSync('/tmp/flw-invite-resp.html', body);
    console.log('full body → /tmp/flw-invite-resp.html');
  } else if (postRes.status() === 302) {
    console.log('SUCCESS: 302 redirect (server queued add_connect_users)');
    console.log('Location:', postRes.headers()['location']);
  } else {
    console.log('UNEXPECTED:', postRes.status());
    console.log((await postRes.text()).slice(0, 500));
  }

}
