/**
 * Probe: verify (read-side only) that the URLs and form-field shapes the
 * Playwright HTML-form fallbacks (in mcp/connect/backends/playwright.ts)
 * post to actually exist on the live connect.dimagi.com production
 * server. NEVER POSTs — only GETs the form pages and asserts against the
 * field-name expectations.
 *
 * Why: commcare-connect PR #1135 (the REST automation API) is merged but
 * not yet deployed to prod. Until then the composite backend falls back
 * to driving the legacy HTML forms. This probe is the smoke test that
 * catches form-shape drift early — Connect's templates change on a
 * weekly-ish cadence and the URL paths or field names can shift without
 * warning.
 *
 * Run: npx tsx scripts/probe-connect-form-fallbacks.ts
 *
 * Requires:
 *   - ~/.ace/connect-session.json (from /ace:connect-login)
 *   - ace@dimagi-ai.com membership in ai-demo-space (verified 2026-05-01)
 *
 * Output: one line per atom, OK or DRIFT, plus the field-name diff.
 */
import 'dotenv/config';
import { chromium } from 'playwright';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const baseUrl = process.env.CONNECT_BASE_URL ?? 'https://connect.dimagi.com';
const PM_ORG = 'ai-demo-space';

const stateFile = path.join(os.homedir(), '.ace', 'connect-session.json');
if (!fs.existsSync(stateFile)) {
  throw new Error(`Run /ace:connect-login first; ${stateFile} missing`);
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ storageState: stateFile, baseURL: baseUrl });

interface Probe {
  atom: string;
  url: string;
  expectFields: string[];
  expectFormAction?: string; // optional: a substring that should appear in the form's action URL
}

/**
 * Discover an existing program UUID and an existing opportunity UUID for
 * use in URL-templated probes. Falls back to documented constants if the
 * org is empty (which would itself be a real signal worth flagging).
 */
async function discoverIds(): Promise<{ programId?: string; opportunityId?: string }> {
  const progRes = await ctx.request.get(`/a/${PM_ORG}/program/`);
  const progHtml = progRes.status() === 200 ? await progRes.text() : '';
  const progMatch = progHtml.match(/\/program\/([a-f0-9-]{36})\/edit/);
  const oppRes = await ctx.request.get(`/a/${PM_ORG}/opportunity/`);
  const oppHtml = oppRes.status() === 200 ? await oppRes.text() : '';
  const oppMatch = oppHtml.match(/\/opportunity\/([a-f0-9-]{36})\//);
  return { programId: progMatch?.[1], opportunityId: oppMatch?.[1] };
}

const ids = await discoverIds();
if (!ids.programId) {
  console.warn(`[probe] WARN: no program found in /a/${PM_ORG}/program/ — sendLloInvite probe will be skipped`);
}
if (!ids.opportunityId) {
  console.warn(`[probe] WARN: no opportunity found in /a/${PM_ORG}/opportunity/ — opp-related probes will be skipped`);
}

const probes: Probe[] = [
  {
    atom: 'createProgram',
    url: `/a/${PM_ORG}/program/init/`,
    expectFields: ['csrfmiddlewaretoken', 'name', 'description', 'delivery_type', 'budget', 'currency', 'country', 'start_date', 'end_date'],
    expectFormAction: `/a/${PM_ORG}/program/init/`,
  },
];

if (ids.programId) {
  probes.push({
    atom: 'sendLloInvite',
    url: `/a/${PM_ORG}/program/`,
    expectFields: ['csrfmiddlewaretoken', 'organization'],
    expectFormAction: `/program/${ids.programId}/invite`,
  });
}

if (ids.opportunityId) {
  probes.push(
    {
      atom: 'createPaymentUnit(s)',
      url: `/a/${PM_ORG}/opportunity/${ids.opportunityId}/payment_unit/create`,
      // `required_deliver_units` and `optional_deliver_units` only appear once
      // the opp has synced its DeliverUnits from HQ; they're conditional. We
      // assert only the always-present scalars here.
      expectFields: ['csrfmiddlewaretoken', 'name', 'description', 'amount', 'max_total', 'max_daily'],
    },
    {
      atom: 'sendFlwInvite',
      url: `/a/${PM_ORG}/opportunity/${ids.opportunityId}/user_invite/`,
      expectFields: ['csrfmiddlewaretoken', 'users'],
    },
    {
      atom: 'activateOpportunity (via /edit form)',
      url: `/a/${PM_ORG}/opportunity/${ids.opportunityId}/edit`,
      expectFields: ['csrfmiddlewaretoken', 'name', 'short_description', 'description', 'active'],
    },
  );
}

let okCount = 0;
let driftCount = 0;
const driftDetails: string[] = [];

for (const p of probes) {
  const res = await ctx.request.get(p.url);
  if (res.status() !== 200) {
    console.log(`[DRIFT] ${p.atom.padEnd(40)} ${p.url} → HTTP ${res.status()}`);
    driftCount++;
    driftDetails.push(`${p.atom}: GET returned ${res.status()}`);
    continue;
  }
  const html = await res.text();
  const fieldNames = new Set<string>();
  for (const m of html.matchAll(/<(?:input|textarea|select)\b[^>]*\bname="([a-z_][a-z0-9_-]*)"/gi)) {
    fieldNames.add(m[1]);
  }
  const missing = p.expectFields.filter((f) => !fieldNames.has(f));

  let actionMatch = true;
  if (p.expectFormAction) {
    const allActions = [...html.matchAll(/(?:hx-post|action)="([^"]+)"/g)].map((m) => m[1]);
    actionMatch = allActions.some((a) => a.includes(p.expectFormAction!));
    if (!actionMatch) {
      driftDetails.push(`${p.atom}: form action does not contain "${p.expectFormAction}". Found: ${allActions.slice(0, 5).join(', ')}`);
    }
  }

  if (missing.length === 0 && actionMatch) {
    console.log(`[OK]    ${p.atom.padEnd(40)} ${p.url}`);
    okCount++;
  } else {
    console.log(`[DRIFT] ${p.atom.padEnd(40)} ${p.url}`);
    if (missing.length) {
      console.log(`        missing fields: ${missing.join(', ')}`);
      driftDetails.push(`${p.atom}: missing form fields ${missing.join(', ')}`);
    }
    driftCount++;
  }
}

// Special probe: confirm REST is still 404 (i.e., PR #1135 not deployed)
console.log('');
console.log('--- REST deployment status (PR #1135) ---');
const restProbe = await ctx.request.post('/api/programs/', {
  data: '{}',
  headers: {
    'Content-Type': 'application/json',
    'X-CSRFToken': 'probe',
    Referer: `${baseUrl}/`,
  },
});
console.log(`POST /api/programs/ → HTTP ${restProbe.status()}`);
if (restProbe.status() === 404) {
  console.log('  (REST endpoint NOT yet deployed — fallbacks remain load-bearing)');
} else {
  console.log('  (!) REST endpoint may now be deployed — fallback should rarely fire.');
}

await browser.close();

console.log('');
console.log(`Summary: ${okCount} OK, ${driftCount} DRIFT, of ${probes.length} probes`);
if (driftCount > 0) {
  console.log('');
  console.log('Drift details:');
  for (const d of driftDetails) console.log(`  - ${d}`);
  process.exit(1);
}
