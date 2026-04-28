/**
 * Probe: capture the HTML of the programs list page and program-create form.
 * Requires a valid ~/.ace/connect-session.json from probe-connect-login.ts.
 *
 * Run: npx tsx scripts/probe-connect-programs.ts
 *
 * Observations from 2026-04-28:
 * - Connect uses /a/<org>/... URL pattern.
 * - Post-login landing was /a/jjackson/opportunity/, so org slug = "jjackson"
 *   for the ACE service account on this run.
 */
import 'dotenv/config';
import { chromium } from 'playwright';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const baseUrl = process.env.CONNECT_BASE_URL ?? 'https://connect.dimagi.com';
const stateFile = path.join(os.homedir(), '.ace', 'connect-session.json');
if (!fs.existsSync(stateFile)) {
  throw new Error(`Run probe-connect-login.ts first; ${stateFile} missing`);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(__dirname, '../test/fixtures/connect-html');
fs.mkdirSync(fixturesDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ storageState: stateFile, baseURL: baseUrl });

// 1. Find the org slug by following the post-login redirect.
const homeRes = await ctx.request.get('/', { maxRedirects: 5 });
console.log(`[probe] / → ${homeRes.status()} ${homeRes.url()}`);

// Then try the most likely program URLs.
const candidates = [
  '/a/jjackson/program/',
  '/a/jjackson/programs/',
  '/program/',
  '/programs/',
  '/a/jjackson/opportunity/',  // likely the landing list
];

for (const p of candidates) {
  const r = await ctx.request.get(p, { maxRedirects: 0 });
  console.log(`[probe] ${p} → ${r.status()}`);
  if (r.status() === 200) {
    const html = await r.text();
    const fname = p.replace(/^\//, '').replace(/\/$/, '').replace(/\//g, '-') || 'root';
    fs.writeFileSync(path.join(fixturesDir, `${fname}.html`), html);
    console.log(`[probe]   saved ${fname}.html (${html.length} bytes)`);
  } else if ([301, 302].includes(r.status())) {
    console.log(`[probe]   → ${r.headers()['location']}`);
  }
}

// 2. Try the program-create endpoints.
const formCandidates = [
  '/a/jjackson/program/new/',
  '/a/jjackson/program/create/',
  '/a/jjackson/programs/new/',
];
for (const p of formCandidates) {
  const r = await ctx.request.get(p, { maxRedirects: 0 });
  console.log(`[probe] ${p} → ${r.status()}`);
  if (r.status() === 200) {
    const html = await r.text();
    const fname = p.replace(/^\//, '').replace(/\/$/, '').replace(/\//g, '-');
    fs.writeFileSync(path.join(fixturesDir, `${fname}.html`), html);
    console.log(`[probe]   saved ${fname}.html (${html.length} bytes)`);
  } else if ([301, 302].includes(r.status())) {
    console.log(`[probe]   → ${r.headers()['location']}`);
  }
}

await browser.close();
