import 'dotenv/config';
import { PlaywrightSession } from '../mcp/connect/auth/playwright-session.js';
import * as fs from 'node:fs';

const session = new PlaywrightSession({
  baseUrl: process.env.CONNECT_BASE_URL!,
  hqUsername: process.env.ACE_HQ_USERNAME,
  hqPassword: process.env.ACE_HQ_PASSWORD,
});
const ctx = await session.getContext();

// 1. List existing opportunities to find a real one to probe
console.log('=== Existing opportunities in ai-demo-space ===');
const listRes = await ctx.request.get('/a/ai-demo-space/opportunity/');
const listHtml = await listRes.text();
fs.writeFileSync('test/fixtures/connect-html/ai-demo-space-opp-list-as-admin.html', listHtml);
const oppUuids = [...new Set([...listHtml.matchAll(/\/opportunity\/([a-f0-9-]{36})/g)].map((m) => m[1]))];
console.log(`Found ${oppUuids.length} opportunity UUIDs:`, oppUuids.slice(0, 5));

if (oppUuids.length === 0) {
  console.log('No opportunities exist; create one first via the Connect UI or our atom.');
  await session.close();
  process.exit(0);
}

const oppId = oppUuids[0];
console.log(`\n=== Probing /a/ai-demo-space/opportunity/${oppId}/* ===`);

const subPaths = [
  '',           // detail
  'edit',
  'edit/',
  'verification',
  'verification/',
  'verification-rules',
  'verification-rules/',
  'delivery',
  'delivery/',
  'delivery-units',
  'delivery-units/',
  'delivery_units',
  'delivery_units/',
  'payment',
  'payment/',
  'payment-units',
  'payment-units/',
  'payment_units',
  'payment_units/',
  'rules',
  'rules/',
  'units',
  'units/',
  'config',
  'config/',
  'configuration',
  'configuration/',
  'settings',
  'settings/',
  'flags',
  'flags/',
  'fraud',
  'fraud/',
];

for (const sub of subPaths) {
  const path = `/a/ai-demo-space/opportunity/${oppId}/${sub}`;
  const r = await ctx.request.get(path, { maxRedirects: 0 });
  const status = r.status();
  if (status === 200) {
    console.log(`200 ${path}`);
    const html = await r.text();
    // Save anything substantial
    if (html.length > 5000) {
      const fname = `opp-${sub.replace(/\/$/, '').replace(/\//g, '-') || 'detail'}.html`;
      fs.writeFileSync(`test/fixtures/connect-html/${fname}`, html);
      console.log(`  saved ${fname} (${html.length} bytes)`);
      // Look for form fields / interesting URLs
      const formActions = [...html.matchAll(/<form[^>]*action="([^"]*)"[^>]*>/g)].map((m) => m[1]);
      const hxPosts = [...html.matchAll(/hx-post="([^"]*)"/g)].map((m) => m[1]);
      const hxGets = [...html.matchAll(/hx-get="([^"]*)"/g)].map((m) => m[1]);
      const formNames = [...new Set([...html.matchAll(/<(?:input|select|textarea)[^>]*\sname="([^"]+)"/g)].map((m) => m[1]))];
      if (formActions.length) console.log(`  form actions: ${formActions.slice(0, 5).join(', ')}`);
      if (hxPosts.length) console.log(`  hx-post: ${[...new Set(hxPosts)].slice(0, 5).join(', ')}`);
      const hxGetRel = [...new Set(hxGets.filter(u => u.includes('opportunity') || u.includes('verification') || u.includes('delivery') || u.includes('payment')))];
      if (hxGetRel.length) console.log(`  hx-get (relevant): ${hxGetRel.slice(0, 8).join(', ')}`);
      if (formNames.length) console.log(`  form fields: ${formNames.slice(0, 15).join(', ')}`);
    }
  } else if ([301, 302].includes(status)) {
    console.log(`${status} ${path} → ${r.headers()['location']}`);
  }
}

await session.close();
