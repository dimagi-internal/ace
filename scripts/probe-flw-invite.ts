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
import { RestBackend } from '../mcp/connect/backends/rest.js';

const BASE_URL = process.env.CONNECT_BASE_URL ?? 'https://connect.dimagi.com';
const ORG = 'ai-demo-space';
const OPP_IDS = [
  'f574922a-86bc-4c96-95e5-9d736774e43f', // Turmeric Survey — fresh autobuild e2e
  '249ad8fe-fd4f-49c5-8808-93b1cb016860', // Turmeric Market Survey — turmeric (2026-04-29)
  'feea0155-eee1-4ba9-b485-4da024dd7566', // Turmeric Market Survey 2026-04-28
];
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

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`${name} env var required (set in $CLAUDE_PLUGIN_DATA/.env via op inject).`);
    process.exit(2);
  }
  return v;
}
const PHONE = requireEnv('ACE_E2E_PHONE');

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

async function tryInvite(backend: RestBackend, oppId: string): Promise<boolean> {
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
  const backend = new RestBackend({
    baseUrl: BASE_URL,
    csrfToken: session.getCsrfToken(),
    request: ctx.request,
  });
  // Note: pre-0.10.46 this script also exercised `finalizeOpportunity`.
  // Connect's automation API (PR #1135) folds that into `createOpportunity`,
  // so finalize is gone — opps now have start_date/end_date/total_budget at
  // create time and only need to be activated before they accept FLW invites.

  let successOpp: string | null = null;
  for (const oppId of OPP_IDS) {
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

// Pre-0.10.46 this script also drove the legacy `/a/<org>/opportunity/<uuid>/user_invite/`
// HTML form directly. The REST endpoint `POST /api/opportunities/<id>/invite_users/`
// supersedes it; both use the same `add_connect_users.delay()` task on the server.
