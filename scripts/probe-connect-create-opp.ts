/**
 * Probe: drive the full /opportunity/init/ HTMX cascade against live
 * connect.dimagi.com to characterize the response shapes for each step.
 *
 * Steps probed:
 *   1. GET /a/<org>/opportunity/init/ — capture form HTML, csrf, hq_server options.
 *   2. GET /a/<org>/users/api_keys/?hq_server=1 — capture api_key dropdown shape.
 *   3. POST /a/<org>/opportunity/add_api_key/ if our key isn't registered.
 *   4. GET /a/<org>/hq/domains/?hq_server=1&api_key=<id> — capture domain dropdown.
 *   5. GET /a/<org>/hq/applications/?hq_server=1&learn_app_domain=...&api_key=<id>
 *      — capture app dropdown shape (Released vs Unreleased).
 *   6. POST /a/<org>/opportunity/init/ with the assembled values; capture
 *      redirect Location → new opp UUID.
 *   7. GET /a/<org>/opportunity/<uuid>/edit and /finalize/ to characterize
 *      what comes next.
 *   8. (Optional) POST /finalize/ if --finalize is passed.
 *
 * The probe produces a standalone opportunity (no program field, since the
 * live HTML form doesn't have one). Test opp is named DELETE-ME-<timestamp>.
 *
 * Run: npx tsx scripts/probe-connect-create-opp.ts
 *      npx tsx scripts/probe-connect-create-opp.ts --commit   # actually POST init
 *      npx tsx scripts/probe-connect-create-opp.ts --commit --finalize
 */
import { config as dotenvConfig } from 'dotenv';
import { chromium } from 'playwright';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Load both the local .env (if any) and the ACE plugin-data .env where
// ACE_HQ_API_KEY actually lives in this environment.
dotenvConfig();
dotenvConfig({ path: path.join(os.homedir(), '.claude/plugins/data/ace-ace/.env'), override: false });

const baseUrl = process.env.CONNECT_BASE_URL ?? 'https://connect.dimagi.com';
const PM_ORG = 'ai-demo-space';
const HQ_API_KEY = process.env.ACE_HQ_API_KEY ?? '';
const HQ_DOMAIN = process.env.ACE_HQ_DOMAIN ?? 'connect-ace-prod';
const LEARN_APP_ID = process.env.PROBE_LEARN_APP_ID ?? '4e20ddf5beca42278c4d2c20383eb943';
const DELIVER_APP_ID = process.env.PROBE_DELIVER_APP_ID ?? 'f4b4cb06962441718081a6f9ab502262';
const COMMIT = process.argv.includes('--commit');
const FINALIZE = process.argv.includes('--finalize');

const stateFile = path.join(os.homedir(), '.ace', 'connect-session.json');
if (!fs.existsSync(stateFile)) {
  throw new Error(`Run /ace:connect-login first; ${stateFile} missing`);
}
if (!HQ_API_KEY) throw new Error('ACE_HQ_API_KEY missing in env');

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ storageState: stateFile, baseURL: baseUrl });

function extractCsrf(html: string): string | undefined {
  return html.match(/name=["']csrfmiddlewaretoken["']\s+value=["']([^"']+)["']/)?.[1];
}

function parseSelectOptions(html: string): Array<{ value: string; text: string }> {
  const opts: Array<{ value: string; text: string }> = [];
  for (const m of html.matchAll(/<option[^>]*value=["']([^"']*)["'][^>]*>([\s\S]*?)<\/option>/g)) {
    opts.push({ value: m[1], text: m[2].trim() });
  }
  return opts;
}

function htmlDecodeAttr(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
}

console.log(`\n=== Step 1: GET /a/${PM_ORG}/opportunity/init/ ===`);
const formRes = await ctx.request.get(`/a/${PM_ORG}/opportunity/init/`);
console.log(`status=${formRes.status()}`);
const formHtml = await formRes.text();
const csrf = extractCsrf(formHtml);
console.log(`csrf=${csrf?.slice(0, 16)}...`);

// hq_server options
const hqMatch = formHtml.match(/<select[^>]*name=["']hq_server["'][^>]*>([\s\S]*?)<\/select>/);
console.log(`hq_server options:`, hqMatch ? parseSelectOptions(hqMatch[1]) : 'NONE');

// Check if there's a `program` field
const hasProgram = /name=["']program["']/.test(formHtml);
console.log(`has program field: ${hasProgram}`);

// All form field names
const fieldNames = new Set<string>();
for (const m of formHtml.matchAll(/<(?:input|select|textarea)[^>]+name=["']([^"']+)["']/g)) {
  fieldNames.add(m[1]);
}
console.log(`form fields: ${[...fieldNames].sort().join(', ')}`);

// Discover the HTMX endpoints from the form HTML (hx-get attributes).
console.log(`\n=== HTMX endpoint discovery ===`);
for (const m of formHtml.matchAll(/hx-(?:get|post)=["']([^"']+)["']/g)) {
  console.log(`hx-endpoint: ${m[1]}`);
}
// Form action of the api-key modal
const addApiKeyMatch = formHtml.match(/(?:hx-post|action)=["']([^"']*add_api_key[^"']*)["']/);
console.log(`add_api_key URL: ${addApiKeyMatch?.[1] ?? '(not found)'}`);

// Discover the api-key dropdown's source URL
const apiKeySelectMatch = formHtml.match(/<select[^>]*name=["']api_key["'][^>]*>([\s\S]{0,500})/);
console.log(`api_key select snippet:`, apiKeySelectMatch?.[0]?.slice(0, 300));

console.log(`\n=== Step 2: GET /users/api_keys/?hq_server=1 (no org prefix) ===`);
const akRes = await ctx.request.get(`/users/api_keys/?hq_server=1`, {
  headers: { 'HX-Request': 'true' },
});
console.log(`status=${akRes.status()}`);
const akHtml = await akRes.text();
console.log(`length=${akHtml.length}`);
const akOptsRaw = parseSelectOptions(akHtml);
console.log(`api_key options:`, akOptsRaw.map((o) => ({ value: o.value, text: o.text.slice(0, 50) })));

const truncated = `${HQ_API_KEY.slice(0, 4)}...${HQ_API_KEY.slice(-4)}`;
console.log(`looking for truncated label "${truncated}"`);
let apiKeyId = akOptsRaw.find((o) => o.text === truncated && /^\d+$/.test(o.value))?.value;
console.log(`existing api_key int FK: ${apiKeyId ?? '(not registered)'}`);

if (!apiKeyId) {
  console.log(`\n=== Step 2b: POST /a/${PM_ORG}/opportunity/add_api_key/ ===`);
  const addRes = await ctx.request.post(`/a/${PM_ORG}/opportunity/add_api_key/`, {
    form: {
      csrfmiddlewaretoken: csrf!,
      hq_server: '1',
      api_key: HQ_API_KEY,
    },
    headers: {
      Referer: `${baseUrl}/a/${PM_ORG}/opportunity/init/`,
      'X-CSRFToken': csrf!,
      'HX-Request': 'true',
    },
  });
  console.log(`add_api_key status=${addRes.status()}`);
  // Re-query
  const ak2 = await ctx.request.get(`/users/api_keys/?hq_server=1`, {
    headers: { 'HX-Request': 'true' },
  });
  const ak2Opts = parseSelectOptions(await ak2.text());
  apiKeyId = ak2Opts.find((o) => o.text === truncated && /^\d+$/.test(o.value))?.value;
  console.log(`new api_key int FK: ${apiKeyId}`);
}

if (!apiKeyId) {
  await browser.close();
  throw new Error('Could not register or find api_key');
}

console.log(`\n=== Step 3: GET /hq/domains/?hq_server=1&api_key=${apiKeyId} ===`);
const domRes = await ctx.request.get(
  `/hq/domains/?hq_server=1&api_key=${apiKeyId}`,
  { headers: { 'HX-Request': 'true' } },
);
console.log(`status=${domRes.status()}`);
const domHtml = await domRes.text();
const domOpts = parseSelectOptions(domHtml);
console.log(`domain options (${domOpts.length}):`, domOpts.slice(0, 10));
const hasOurDomain = domOpts.find((o) => o.value === HQ_DOMAIN);
console.log(`has ${HQ_DOMAIN}: ${!!hasOurDomain}`);

console.log(`\n=== Step 4a: GET /hq/applications/?hq_server=1&learn_app_domain=${HQ_DOMAIN}&api_key=${apiKeyId} ===`);
const learnAppsRes = await ctx.request.get(
  `/hq/applications/?hq_server=1&learn_app_domain=${HQ_DOMAIN}&api_key=${apiKeyId}`,
  { headers: { 'HX-Request': 'true' } },
);
console.log(`status=${learnAppsRes.status()}`);
const learnAppsHtml = await learnAppsRes.text();
console.log(`---raw response (first 2000 chars)---`);
console.log(learnAppsHtml.slice(0, 2000));
console.log(`---end raw---`);
const learnOpts = parseSelectOptions(learnAppsHtml);
console.log(`learn_app options (${learnOpts.length}):`);
for (const o of learnOpts) {
  if (!o.value || o.value === 'None' || o.value === '') continue;
  let parsed: any = null;
  try {
    parsed = JSON.parse(htmlDecodeAttr(o.value));
  } catch {}
  console.log(`  text="${o.text}" value=${o.value.slice(0, 80)}${o.value.length > 80 ? '...' : ''} parsed_id=${parsed?.id} parsed_name=${parsed?.name}`);
}

const learnAppMatch = learnOpts.find((o) => {
  try {
    const p = JSON.parse(htmlDecodeAttr(o.value));
    return p?.id === LEARN_APP_ID;
  } catch {
    return false;
  }
});
console.log(`learn app match for ${LEARN_APP_ID}:`, learnAppMatch);

console.log(`\n=== Step 4b: GET /hq/applications/?hq_server=1&deliver_app_domain=${HQ_DOMAIN}&api_key=${apiKeyId} ===`);
const deliverAppsRes = await ctx.request.get(
  `/hq/applications/?hq_server=1&deliver_app_domain=${HQ_DOMAIN}&api_key=${apiKeyId}`,
  { headers: { 'HX-Request': 'true' } },
);
console.log(`status=${deliverAppsRes.status()}`);
const deliverAppsHtml = await deliverAppsRes.text();
const deliverOpts = parseSelectOptions(deliverAppsHtml);
console.log(`deliver_app options (${deliverOpts.length}):`);
for (const o of deliverOpts) {
  if (!o.value || o.value === 'None' || o.value === '') continue;
  let parsed: any = null;
  try {
    parsed = JSON.parse(htmlDecodeAttr(o.value));
  } catch {}
  console.log(`  text="${o.text}" parsed_id=${parsed?.id} parsed_name=${parsed?.name}`);
}
const deliverAppMatch = deliverOpts.find((o) => {
  try {
    const p = JSON.parse(htmlDecodeAttr(o.value));
    return p?.id === DELIVER_APP_ID;
  } catch {
    return false;
  }
});
console.log(`deliver app match for ${DELIVER_APP_ID}:`, deliverAppMatch);

if (!COMMIT) {
  console.log(`\n[probe] dry run — pass --commit to POST /opportunity/init/`);
  await browser.close();
  process.exit(0);
}

if (!learnAppMatch || !deliverAppMatch) {
  console.log(`\n[probe] cannot commit — apps not found in dropdown`);
  await browser.close();
  process.exit(2);
}

const ts = Date.now();
const oppName = `DELETE-ME-probe-${ts}`;

console.log(`\n=== Step 5: POST /a/${PM_ORG}/opportunity/init/ ===`);
// Refresh CSRF
const formRes2 = await ctx.request.get(`/a/${PM_ORG}/opportunity/init/`);
const csrf2 = extractCsrf(await formRes2.text())!;

const initBody = new URLSearchParams();
initBody.append('csrfmiddlewaretoken', csrf2);
initBody.append('name', oppName);
initBody.append('short_description', 'probe test opp');
initBody.append('description', 'probe test opp - DELETE');
initBody.append('currency', 'USD');
initBody.append('country', 'USA');
initBody.append('hq_server', '1');
initBody.append('api_key', apiKeyId);
initBody.append('learn_app_domain', HQ_DOMAIN);
initBody.append('learn_app', htmlDecodeAttr(learnAppMatch.value));
initBody.append('learn_app_passing_score', '13');
initBody.append('learn_app_description', 'probe learn app');
initBody.append('deliver_app_domain', HQ_DOMAIN);
initBody.append('deliver_app', htmlDecodeAttr(deliverAppMatch.value));

console.log(`POST body fields: ${[...new Set([...initBody.keys()])].join(', ')}`);

const initRes = await ctx.request.post(`/a/${PM_ORG}/opportunity/init/`, {
  data: initBody.toString(),
  maxRedirects: 0,
  headers: {
    Referer: `${baseUrl}/a/${PM_ORG}/opportunity/init/`,
    'X-CSRFToken': csrf2,
    'Content-Type': 'application/x-www-form-urlencoded',
  },
});

console.log(`init status=${initRes.status()}`);
console.log(`init Location=${initRes.headers()['location'] ?? '(none)'}`);

let createdOppId: string | undefined;
if (initRes.status() === 302) {
  const loc = initRes.headers()['location'] ?? '';
  const m = loc.match(/\/opportunity\/([a-f0-9-]{36})/);
  createdOppId = m?.[1];
  console.log(`created opp UUID: ${createdOppId}`);
} else {
  const body = await initRes.text();
  console.log(`---response body (first 4000 chars)---`);
  console.log(body.slice(0, 4000));
  console.log(`---end body---`);
}

if (!createdOppId) {
  await browser.close();
  process.exit(3);
}

console.log(`\n=== Step 6: GET /a/${PM_ORG}/opportunity/${createdOppId}/edit ===`);
const editRes = await ctx.request.get(`/a/${PM_ORG}/opportunity/${createdOppId}/edit`);
console.log(`status=${editRes.status()}`);
const editHtml = await editRes.text();
const editFields = new Set<string>();
for (const m of editHtml.matchAll(/<(?:input|select|textarea)[^>]+name=["']([^"']+)["']/g)) {
  editFields.add(m[1]);
}
console.log(`edit form fields: ${[...editFields].sort().join(', ')}`);

console.log(`\n=== Step 7: GET /a/${PM_ORG}/opportunity/${createdOppId}/finalize/ ===`);
const finRes = await ctx.request.get(`/a/${PM_ORG}/opportunity/${createdOppId}/finalize/`);
console.log(`status=${finRes.status()}`);
const finHtml = await finRes.text();
const finFields = new Set<string>();
for (const m of finHtml.matchAll(/<(?:input|select|textarea)[^>]+name=["']([^"']+)["']/g)) {
  finFields.add(m[1]);
}
console.log(`finalize form fields: ${[...finFields].sort().join(', ')}`);

if (FINALIZE) {
  console.log(`\n=== Step 8: POST finalize ===`);
  const csrf3 = extractCsrf(finHtml) ?? csrf2;
  const finPostRes = await ctx.request.post(`/a/${PM_ORG}/opportunity/${createdOppId}/finalize/`, {
    form: {
      csrfmiddlewaretoken: csrf3,
      start_date: '2026-06-01',
      end_date: '2026-07-31',
      max_users: '20',
      total_budget: '3600',
    },
    maxRedirects: 0,
    headers: {
      Referer: `${baseUrl}/a/${PM_ORG}/opportunity/${createdOppId}/finalize/`,
      'X-CSRFToken': csrf3,
    },
  });
  console.log(`finalize status=${finPostRes.status()}`);
  console.log(`finalize Location=${finPostRes.headers()['location']}`);
  if (finPostRes.status() === 200) {
    const body = await finPostRes.text();
    console.log(`finalize body first 2000:`);
    console.log(body.slice(0, 2000));
  }
}

console.log(`\n[probe] DONE. Created opp: ${createdOppId} (named "${oppName}")`);
console.log(`[probe] Cleanup: visit /a/${PM_ORG}/opportunity/${createdOppId}/ and delete from UI, or POST to /a/${PM_ORG}/opportunity/${createdOppId}/delete/`);

await browser.close();
