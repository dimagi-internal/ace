/**
 * Probe live deliver_unit_table and payment_unit_table HTML for the
 * Connect MCP `listDeliverUnits` / `listPaymentUnits` atoms.
 *
 * Background: jjackson/ace#106 finding 5 reported that both list
 * scrapers return display indices (1, 2, 3) instead of server IDs
 * (5355/5356/5357 etc.). This script captures the live HTML so we can
 * (a) confirm the server-side surface area available to the parser,
 * (b) refresh the test fixtures, and (c) document what's reachable
 * via HTML vs. what needs a server-side ID-exposing change.
 *
 * Findings (2026-05-06, leep-paint-collection opp f14d8c5d-…):
 *   - deliver_unit_table HTML has only display index, slug, name. No
 *     data-* attrs, no hrefs, no hidden inputs. Server integer IDs are
 *     not reachable from this page — server-side change in
 *     commcare-connect needed to expose them.
 *   - payment_unit_table HTML has the payment-unit UUID embedded in
 *     each row's edit href (`/payment_unit/<UUID>/edit`). Scrape that
 *     for a stable identifier even though the integer server ID still
 *     isn't rendered. (We populate `PaymentUnit.payment_unit_uuid`.)
 *
 * Usage:
 *   npx tsx scripts/probe-deliver-payment-tables.ts [opp-uuid]
 *
 * Default opp UUID is the leep-paint-collection opp from #106. Pass
 * any opp UUID accessible via the existing Connect Playwright session
 * to refresh against a different opp.
 *
 * Output: writes captured HTML to /tmp/live-<opp-prefix>-<table>.html
 * for inspection. Promote them into test/fixtures/connect-html/ if
 * you find a new pattern worth pinning.
 */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const ENV_FILE = path.join(process.env.HOME!, '.claude/plugins/data/ace-ace/.env');
for (const line of fs.readFileSync(ENV_FILE, 'utf-8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
}

const baseUrl = process.env.CONNECT_BASE_URL ?? 'https://connect.dimagi.com';
const sessionFile = path.join(process.env.HOME!, '.ace', 'connect-session.json');

const ORG_SLUG = process.env.PROBE_ORG_SLUG ?? 'ai-demo-space';
const OPP_ID = process.argv[2] ?? 'f14d8c5d-8859-4d0c-8952-8a6a30d06c43';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ storageState: sessionFile });
  const page = await ctx.newPage();

  for (const which of ['deliver_unit_table', 'payment_unit_table/']) {
    const url = `${baseUrl}/a/${ORG_SLUG}/opportunity/${OPP_ID}/${which}`;
    const res = await page.goto(url);
    const status = res?.status() ?? 0;
    const html = await page.content();
    const fname = `live-${OPP_ID.slice(0, 8)}-${which.replace(/\//g, '')}.html`;
    fs.writeFileSync(`/tmp/${fname}`, html);
    console.log(`${which} → ${status} → /tmp/${fname} (${html.length} bytes)`);

    // Quick sniff: any data-* attrs or hrefs on table rows?
    const trs = html.match(/<tr [^>]*>/g) ?? [];
    const sniffs = trs.slice(0, 6).map((t) => t.replace(/\s+/g, ' ').slice(0, 200));
    console.log('  Top <tr> tags:', JSON.stringify(sniffs, null, 2));

    const editLinks = [...html.matchAll(/payment_unit\/([0-9a-f-]{36})\//g)].map((m) => m[1]);
    console.log(`  payment_unit UUIDs found: ${editLinks.length} unique`);

    const duIds = [...html.matchAll(/deliver_unit[s]?\/([0-9]+|[0-9a-f-]{36})/g)].map((m) => m[1]);
    console.log(`  deliver_unit IDs found: ${duIds.length} (${duIds.slice(0, 4).join(', ')})`);
  }

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
