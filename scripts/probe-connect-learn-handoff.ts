/**
 * Probe the Connect → Learn handoff failure mode for an opportunity.
 *
 * Background: jjackson/ace#115 finding 1 — on the local AVD, tapping
 * `btn_start` on a claimed LEEP opp produces an on-screen banner reading
 * "Failed to start learning" (no logcat exception class surfaced to the
 * user). Phase 6's `app-screenshot-capture` halts; both Learn and
 * Deliver smoke journeys depend on entering the Learn app first.
 *
 * Hypotheses (ranked by likelihood when issue was filed):
 *   1. CCHQ App-Editor permission gap on Connect's API-key user.
 *   2. Released CCZ format/version mismatch.
 *   3. Connect cached stale Learn-app metadata from earlier run.
 *   4. Multi-app upload race (cc_app_id stale in opp record).
 *
 * 2026-05-07 probe results against leep-paint-collection
 * (f14d8c5d-8859-4d0c-8952-8a6a30d06c43):
 *   - hypothesis 1 RULED OUT: CCHQ API auth works, app metadata fetches
 *     200, CCZ download fetches 200 (49KB Learn, 19KB Deliver). The
 *     `/apps/api/download_ccz/?app_id=<id>&latest=release` endpoint is
 *     even publicly accessible (anonymous request returns 200).
 *   - hypothesis 2 PARTIALLY RULED OUT: CCZ structure is valid (8
 *     modules, 16 forms, profile.ccpr + suite.xml present, requires
 *     CommCare 2.62.0 which the AVD has). Learn forms have
 *     `<module xmlns="http://commcareconnect.com/data/v1/learn">`
 *     correctly. **HOWEVER**: Deliver forms have
 *     `<deliver xmlns="http://commcareconnect.com/data/v1/learn">`
 *     — the namespace says "learn" on what should be deliver elements.
 *     Possible Nova autobuild bug; file separately if it reproduces
 *     across other opps' Deliver apps.
 *   - hypothesis 3 RULED OUT: Connect's PM-side learn_module_table view
 *     shows all 8 modules correctly with the right names + descriptions.
 *     Connect's database has the freshly-released metadata, not stale.
 *   - hypothesis 4 RULED OUT: opp record's cc_app_ids match the just-
 *     released build's source-app id, and the build's `built_on`
 *     timestamp matches Phase 3's release time.
 *
 * What that leaves: the failure is in either (a) Connect's mobile API
 * when the AVD calls "start learning", or (b) the CommCare Android
 * runtime trying to launch the app.
 *
 * 2026-05-07 follow-up: ROOT CAUSE FOUND. The released Learn CCZ has
 * Nova-emitted `<module xmlns="…connect…">` + `<assessment xmlns="…connect…">`
 * wrapper elements in form XML — 16 wrapper references across 16 forms
 * for LEEP Learn vs ZERO references in the canonical-working Turmeric
 * Learn CCZ (`76fd5f0e2834454bb946bdf9ae9bff71`). The wrappers used to
 * break Connect's `/opportunity/init/` (HTTP 500) until Connect was
 * patched server-side; they still break the AVD's CommCare runtime at
 * Learn-app launch time. ACE has a workaround skill `commcare-form-patch`
 * (`assessment-removal` patch class) that strips them, but it was a
 * MANUAL skill not part of `/ace:run`. As of 0.13.66 Phase 3's Step 2.8
 * invokes it automatically. Tracking: voidcraft-labs/nova-plugin#7,
 * jjackson/ace#115 finding 1.
 *
 * The probe still has diagnostic value when the wrapper-bearing app
 * isn't the cause — adb logcat will confirm whether you're hitting the
 * wrapper class or something else.
 *
 * Usage:
 *
 *   npx tsx scripts/probe-connect-learn-handoff.ts <opp_uuid> [<organization_slug>]
 *
 * Default `organization_slug` is `ai-demo-space`.
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
  console.log(`\n=== Connect → Learn handoff probe — opp ${OPP_ID} (org ${ORG_SLUG}) ===\n`);

  // Step 1: scrape cc_app_ids from the Connect opp detail page. The IDs
  // live in `apps/view/<id>` URLs inside Alpine x-tooltip attrs on the
  // Learn/Deliver tabs (NOT in the form fields, which is the edit-page
  // path).
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ storageState: sessionFile });
  const oppUrl = `${connectBaseUrl}/a/${ORG_SLUG}/opportunity/${OPP_ID}/`;
  const page = await ctx.newPage();
  const oppRes = await page.goto(oppUrl);
  console.log(`[1] Connect opp page: HTTP ${oppRes?.status()}`);
  const html = await page.content();
  const ccDomain = html.match(/commcarehq\.org\/a\/([a-z0-9_-]+)\/apps\/view\//)?.[1] ?? 'connect-ace-prod';
  const appIds = [...html.matchAll(/commcarehq\.org\/a\/[a-z0-9_-]+\/apps\/view\/([0-9a-f]{32})/g)].map(m => m[1]);
  const learnId = appIds[0];
  const deliverId = appIds[1];
  console.log(`    cc_domain                  = ${ccDomain}`);
  console.log(`    learn_app.cc_app_id        = ${learnId ?? '(NOT FOUND)'}`);
  console.log(`    deliver_app.cc_app_id      = ${deliverId ?? '(NOT FOUND)'}`);
  await browser.close();

  if (!learnId) {
    console.error('\n[BLOCKER] Could not scrape cc_app_id from Connect opp page. Run /ace:connect-login if the session looks stale.');
    process.exit(1);
  }

  const apiUser = process.env.ACE_HQ_USERNAME;
  const apiKey = process.env.ACE_HQ_API_KEY;
  if (!apiUser || !apiKey) {
    console.error('\n[skipped] CCHQ checks need ACE_HQ_USERNAME/ACE_HQ_API_KEY in $CLAUDE_PLUGIN_DATA/.env.');
    return;
  }

  // Step 2: app metadata (auth health + release state).
  console.log(`\n[2] HQ app metadata for both apps (auth + release state):`);
  for (const [label, ccAppId] of [['learn', learnId], ['deliver', deliverId]] as const) {
    if (!ccAppId) continue;
    const r = await fetch(
      `${cchqBaseUrl}/a/${ccDomain}/api/application/v1/${ccAppId}/`,
      { headers: { Authorization: `ApiKey ${apiUser}:${apiKey}` } },
    );
    if (r.status === 401 || r.status === 403) {
      console.log(`    ${label.padEnd(7)}: HTTP ${r.status} — HYPOTHESIS 1 LIKELY (CCHQ permission gap on ${apiUser})`);
      continue;
    }
    if (r.status !== 200) {
      console.log(`    ${label.padEnd(7)}: HTTP ${r.status} — unexpected; investigate`);
      continue;
    }
    const j = (await r.json()) as any;
    console.log(`    ${label.padEnd(7)}: HTTP 200  modules=${j.modules?.length ?? 0}  version=${j.version}  is_released=${j.is_released}`);
  }

  // Step 3: CCZ download (the actual runtime path Connect's mobile client uses).
  console.log(`\n[3] CCZ download (?app_id=<id>&latest=release):`);
  for (const [label, ccAppId] of [['learn', learnId], ['deliver', deliverId]] as const) {
    if (!ccAppId) continue;
    const url = `${cchqBaseUrl}/a/${ccDomain}/apps/api/download_ccz/?app_id=${ccAppId}&latest=release`;
    const r = await fetch(url, { headers: { Authorization: `ApiKey ${apiUser}:${apiKey}` }, redirect: 'follow' });
    const buf = await r.arrayBuffer();
    const ct = r.headers.get('content-type') ?? '';
    const looksZip = ct.includes('zip') && buf.byteLength > 100;
    console.log(`    ${label.padEnd(7)}: HTTP ${r.status}  ${buf.byteLength} bytes  ${ct}  ${looksZip ? '✓ valid zip' : '✗ NOT a zip — see body for clue'}`);
  }

  // Step 4: Connect's PM-side learn_module_table — what the SERVER thinks the apps look like.
  const browser2 = await chromium.launch({ headless: true });
  const ctx2 = await browser2.newContext({ storageState: sessionFile });
  const page2 = await ctx2.newPage();
  const lmtUrl = `${connectBaseUrl}/a/${ORG_SLUG}/opportunity/${OPP_ID}/learn_module_table`;
  const lmtRes = await page2.goto(lmtUrl);
  const lmtHtml = await page2.content();
  await browser2.close();
  const moduleRows = (lmtHtml.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) ?? []).filter(r => /<td/.test(r)).length;
  console.log(`\n[4] Connect learn_module_table (PM-side view): HTTP ${lmtRes?.status()}  ${moduleRows} module rows`);

  console.log(`\n=== Diagnosis ===\n`);
  console.log('If CCZ download succeeded (HTTP 200 + valid zip) and module count > 0,');
  console.log('the failure is NOT in Connect/CCHQ permissions, the build state, or stale');
  console.log('metadata. The remaining suspects are:');
  console.log('  (a) Connect mobile-API endpoint that the AVD calls on Start tap');
  console.log('  (b) CommCare Android runtime parse error');
  console.log('  (c) AVD-side device/account state issue\n');
  console.log('Capture adb logcat to disambiguate:');
  console.log('  adb logcat -c && \\');
  console.log('    # tap Start on the opp detail screen on the AVD, then within ~30s:');
  console.log('  adb logcat -d > /tmp/connect-learn-handoff.log');
  console.log('  grep -iE "exception|failed to start|ccapp|ccz|http/[12]" /tmp/connect-learn-handoff.log');
  console.log();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
