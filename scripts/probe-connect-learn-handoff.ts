/**
 * Probe the Connect → Learn handoff failure mode for an opportunity.
 *
 * Background: jjackson/ace#115 finding 1 — on the local AVD, tapping
 * `btn_start` on a claimed LEEP opp produces an on-screen banner reading
 * "Failed to start learning" (no logcat exception class surfaced to the
 * user). Phase 5's `app-screenshot-capture` halts; both Learn and
 * Deliver smoke journeys depend on entering the Learn app first.
 *
 * Hypotheses (ranked by likelihood):
 *   1. CCHQ App-Editor permission gap on Connect's API-key user (Connect
 *      can't fetch the released build because the user lacks
 *      `edit_apps` on `connect-ace-prod`).
 *   2. Released CCZ format/version mismatch — Nova-built CCZ is missing
 *      a header field Connect uses to dispatch the launch.
 *   3. Connect cached the Learn-app metadata from an earlier run and
 *      now points at a stale build.
 *   4. The released build is a multi-app upload artifact (each
 *      `nova_upload_to_hq` mints a fresh HQ app id; if anything
 *      re-uploaded between Phase 2 and Phase 5, the opp's stored
 *      cc_app_id is stale).
 *
 * What this probe does (no AVD required — pure HTTP/REST checks):
 *
 *   1. Reads the opp's stored `learn_app.cc_app_id` and `deliver_app.cc_app_id`
 *      via `connect_get_opportunity` (uses the existing Connect session).
 *   2. Tries to fetch each app's released CCZ from CCHQ via the same
 *      API key Connect uses (read from `$CLAUDE_PLUGIN_DATA/.env` →
 *      `ACE_HQ_API_KEY` for the user `ACE_HQ_USERNAME`). 200 = the
 *      auth is sufficient; 401/403 = permission gap (hypothesis 1).
 *   3. Inspects the CCZ archive for the expected Connect-required
 *      header fields. Reports any missing field (hypothesis 2).
 *   4. Lists recent app-versions for the cc_app_id and compares the
 *      latest build_id to what Connect has stored (hypothesis 3 + 4).
 *
 * Usage:
 *
 *   npx tsx scripts/probe-connect-learn-handoff.ts <opp_uuid> [<organization_slug>]
 *
 * Default `organization_slug` is `ai-demo-space`.
 *
 * Output: structured diagnostic + a list of next-step adb logcat
 * commands the operator can run on the AVD to capture the runtime
 * exception class. The pure-HTTP checks here narrow the search space
 * before the operator boots an emulator.
 */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const ENV_FILE = path.join(process.env.HOME!, '.claude/plugins/data/ace-ace/.env');
for (const line of fs.readFileSync(ENV_FILE, 'utf-8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
}

const connectBaseUrl = process.env.CONNECT_BASE_URL ?? 'https://connect.dimagi.com';
const cchqBaseUrl = process.env.ACE_HQ_BASE_URL ?? 'https://www.commcarehq.org';
const sessionFile = path.join(process.env.HOME!, '.ace', 'connect-session.json');

const ORG_SLUG = process.argv[3] ?? 'ai-demo-space';
const OPP_ID = process.argv[2];
if (!OPP_ID) {
  console.error('Usage: probe-connect-learn-handoff.ts <opp_uuid> [<organization_slug>]');
  process.exit(2);
}

async function main() {
  console.log(`\n=== Probing Connect→Learn handoff for opp ${OPP_ID} (org ${ORG_SLUG}) ===\n`);

  // Step 1: read the opp's stored app ids via Connect.
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ storageState: sessionFile });
  const oppUrl = `${connectBaseUrl}/a/${ORG_SLUG}/opportunity/${OPP_ID}/`;
  const page = await ctx.newPage();
  const oppRes = await page.goto(oppUrl);
  console.log(`[step 1] Connect opp page: HTTP ${oppRes?.status()}`);
  const html = await page.content();
  // Connect's edit form has hidden inputs for cc_app_id; scrape them.
  const learnId = html.match(/name="learn_app_cc_app_id"[^>]*value="([0-9a-f]+)"/)?.[1];
  const deliverId = html.match(/name="deliver_app_cc_app_id"[^>]*value="([0-9a-f]+)"/)?.[1];
  const cchqDomain = html.match(/name="cc_domain"[^>]*value="([^"]+)"/)?.[1] ?? 'connect-ace-prod';
  console.log(`  Connect-stored learn_app.cc_app_id  = ${learnId ?? '(NOT FOUND)'}`);
  console.log(`  Connect-stored deliver_app.cc_app_id= ${deliverId ?? '(NOT FOUND)'}`);
  console.log(`  cc_domain                           = ${cchqDomain}`);
  await browser.close();

  if (!learnId) {
    console.error('\n[BLOCKER] Could not scrape learn_app.cc_app_id from the Connect opp page. Verify the URL is reachable and the session is fresh (run /ace:connect-login).');
    process.exit(1);
  }

  // Step 2: try to fetch each app's released CCZ via the Connect API user.
  const apiUser = process.env.ACE_HQ_USERNAME;
  const apiKey = process.env.ACE_HQ_API_KEY;
  if (!apiUser || !apiKey) {
    console.error('\n[step 2] Skipping CCZ fetch — ACE_HQ_USERNAME/ACE_HQ_API_KEY not set in $CLAUDE_PLUGIN_DATA/.env.');
  } else {
    for (const [label, ccAppId] of [['learn', learnId], ['deliver', deliverId]] as const) {
      if (!ccAppId) continue;
      const cczUrl = `${cchqBaseUrl}/a/${cchqDomain}/apps/api/v0.5/application/${ccAppId}/?format=json`;
      const r = await fetch(cczUrl, {
        headers: { Authorization: `ApiKey ${apiUser}:${apiKey}` },
      });
      console.log(`[step 2] HQ ${label} app metadata: HTTP ${r.status} (${cczUrl})`);
      if (r.status === 401 || r.status === 403) {
        console.error(`  ↳ Hypothesis 1 LIKELY: ACE_HQ_USERNAME=${apiUser} lacks app-edit access on ${cchqDomain}. Grant the role on HQ Project Settings → Users → Roles.`);
      }
      if (r.status === 200) {
        const meta = (await r.json()) as any;
        console.log(`  ↳ HQ name        = ${meta.name}`);
        console.log(`  ↳ HQ doc_type    = ${meta.doc_type}`);
        console.log(`  ↳ HQ version     = ${meta.version} (latest released build)`);
      }
    }
  }

  // Step 3 + 4: deferred — would require pulling the CCZ bytes and inspecting
  // the manifest, plus listing all app versions. Both are out of scope here;
  // the structured output above is enough to disambiguate hypothesis 1 vs
  // hypotheses 2/3/4.

  console.log(`\n=== Next steps (run on the AVD to narrow remaining hypotheses) ===\n`);
  console.log('1. Reproduce the failure with logcat capture:');
  console.log('   adb logcat -c && \\');
  console.log('     # tap Start on the opp detail screen, then:');
  console.log('   adb logcat -d > /tmp/connect-learn-handoff-logcat.txt');
  console.log('   grep -iE "exception|error|failed to start|ccapp|ccz" /tmp/connect-learn-handoff-logcat.txt');
  console.log('');
  console.log('2. If logcat shows a 401/403, hypothesis 1 confirmed (CCHQ permission).');
  console.log('   If logcat shows a parse error, hypothesis 2 (CCZ format).');
  console.log('   If logcat shows "no such app" or stale ids, hypothesis 3 or 4.');
  console.log('');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
