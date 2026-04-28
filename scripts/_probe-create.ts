import 'dotenv/config';
import { chromium } from 'playwright';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

const stateFile = path.join(os.homedir(), '.ace', 'connect-session.json');
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ storageState: stateFile, baseURL: 'https://connect.dimagi.com' });

// 1. GET the init page to grab CSRF
const initRes = await ctx.request.get('/a/ai-demo-space/program/init/');
const initHtml = await initRes.text();
const csrfMatch = initHtml.match(/name="csrfmiddlewaretoken"\s+value="([^"]+)"/);
const csrf = csrfMatch![1];
console.log('CSRF:', csrf.slice(0, 12), '...');

// 2. POST a test program creation
const stamp = Date.now();
const formData = {
  csrfmiddlewaretoken: csrf,
  name: `ACE-Probe-${stamp}`,
  description: 'Created by ace-connect probe script',
  delivery_type: '13',  // Nutrition
  budget: '1000',
  currency: 'USD',
  country: 'USA',
  start_date: '2026-05-01',
  end_date: '2026-08-01',
};

const postRes = await ctx.request.post('/a/ai-demo-space/program/init/', {
  form: formData,
  maxRedirects: 0,
  headers: {
    Referer: 'https://connect.dimagi.com/a/ai-demo-space/program/',
    'X-CSRFToken': csrf,
  },
});

console.log('POST status:', postRes.status());
console.log('POST Location:', postRes.headers()['location']);
console.log('POST HX-Redirect:', postRes.headers()['hx-redirect']);
console.log('POST HX-Trigger:', postRes.headers()['hx-trigger']);
const headers = postRes.headers();
console.log('All headers:', Object.keys(headers).filter(h => /^(hx-|location|content-type)/.test(h)).map(h => `${h}=${headers[h]}`));

const body = await postRes.text();
console.log('Body length:', body.length);
console.log('Body first 500 chars:', body.slice(0, 500));

// 3. List programs to confirm and capture row format
const listRes = await ctx.request.get('/a/ai-demo-space/program/');
const listHtml = await listRes.text();
fs.writeFileSync('test/fixtures/connect-html/programs-list-with-data.html', listHtml);
console.log('Programs list saved (', listHtml.length, ' bytes)');

// Look for the new program in the listing
const myProgRegex = new RegExp(`ACE-Probe-${stamp}`);
const found = listHtml.match(myProgRegex);
console.log('Found in list:', !!found);

// Extract any UUID-flavored references on the list
const uuidRefs = [...listHtml.matchAll(/\/program\/([a-f0-9-]{36})\//g)].map(m => m[1]);
console.log('UUIDs on list:', [...new Set(uuidRefs)]);

await browser.close();
