/**
 * End-to-end probe that drives the FIXED createOpportunity Playwright
 * backend against live connect.dimagi.com — verifies the 0.10.82 fix
 * actually creates a working opportunity.
 *
 * Uses Turmeric Survey Learn / Deliver as the app pair (the LEEP Paint
 * Learn app `4e20ddf5...` triggers a Connect server-side 500 unrelated
 * to our code path; that's a Connect-side bug filed separately).
 *
 * Run: npx tsx scripts/probe-fixed-create-opp.ts
 */
import { config as dotenvConfig } from 'dotenv';
import { chromium } from 'playwright';
import * as path from 'node:path';
import * as os from 'node:os';
import { PlaywrightBackend } from '../mcp/connect/backends/playwright.js';

dotenvConfig({ path: path.join(os.homedir(), '.claude/plugins/data/ace-ace/.env') });

const baseUrl = process.env.CONNECT_BASE_URL ?? 'https://connect.dimagi.com';
const PM_ORG = 'ai-demo-space';
const HQ_API_KEY = process.env.ACE_HQ_API_KEY!;
const HQ_DOMAIN = process.env.ACE_HQ_DOMAIN ?? 'connect-ace-prod';

const stateFile = path.join(os.homedir(), '.ace', 'connect-session.json');
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ storageState: stateFile, baseURL: baseUrl });

// Find an existing program UUID for currency/country lookup (the
// createOpportunity atom's contract requires program_id even though
// the form doesn't send it).
const progRes = await ctx.request.get(`/a/${PM_ORG}/program/`);
const progHtml = await progRes.text();
const programId = progHtml.match(/\/program\/([a-f0-9-]{36})\/edit/)?.[1];
if (!programId) {
  console.error('no program found for currency/country lookup');
  process.exit(1);
}
console.log(`using program_id=${programId}`);

const ts = Date.now();
const oppName = `DELETE-ME-fix-${ts}`;

const backend = new PlaywrightBackend({
  baseUrl,
  csrfToken: '', // Backend extracts CSRF from form responses; this is just a fallback
  request: ctx.request,
});

try {
  const opp = await backend.createOpportunity({
    organization_slug: PM_ORG,
    program_id: programId,
    name: oppName,
    short_description: 'fix probe',
    description: 'fix probe — DELETE',
    target_organization_slug: PM_ORG,
    start_date: '2026-06-01',
    end_date: '2026-07-31',
    total_budget: 3600,
    learn_app: {
      hq_server_url: 'https://www.commcarehq.org',
      api_key: HQ_API_KEY,
      cc_domain: HQ_DOMAIN,
      cc_app_id: '76fd5f0e2834454bb946bdf9ae9bff71', // Turmeric Survey Learn
      description: 'fix probe learn',
      passing_score: 80,
    },
    deliver_app: {
      hq_server_url: 'https://www.commcarehq.org',
      api_key: HQ_API_KEY,
      cc_domain: HQ_DOMAIN,
      cc_app_id: '0c96435881b0437083a6e5091e3cc01f', // Turmeric Survey Deliver
    },
  });
  console.log('SUCCESS — created opportunity:');
  console.log({
    id: opp.id,
    name: opp.name,
    organization_slug: opp.organization_slug,
    short_description: opp.short_description,
    learn_app: opp.learn_app,
    deliver_app: opp.deliver_app,
  });
  console.log(`\nView at: ${baseUrl}/a/${PM_ORG}/opportunity/${opp.id}/`);
  console.log(`Cleanup: opp is named ${oppName}; visit Connect UI to delete.`);
} catch (err: any) {
  console.error('FAILED:', err?.message ?? err);
  if (err?.fieldErrors) console.error('field errors:', err.fieldErrors);
  if (err?.errors) console.error('errors:', err.errors);
  process.exit(2);
}

await browser.close();
