import { chromium } from 'playwright';
import fs from 'node:fs'; import os from 'node:os';
const S = '/private/tmp/claude-501/-Users-jjackson-emdash-worktrees-ace-1476c35d-emdash-ace-coach-4uc37/cf3b1ca5-4bf2-4a15-bd37-5bac88ce5a52/scratchpad/ui';
const labs = JSON.parse(fs.readFileSync(os.homedir() + '/.ace/labs-session.json', 'utf8'));
const ocs = JSON.parse(fs.readFileSync(os.homedir() + '/.ace/ocs-session-connect-ace.json', 'utf8'));
const b = await chromium.launch();
const ctx = await b.newContext({ storageState: { cookies: [...labs.cookies, ...ocs.cookies], origins: [] } });
const p = await ctx.newPage();
await p.goto('https://labs.connect.dimagi.com/labs/ocs/initiate/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await p.waitForTimeout(5000);
console.log('at', p.url());
await p.screenshot({ path: S + '/07-ocs-oauth.png' });
const btn = p.locator('input[type=submit][value*=uthori], button:has-text("Authorize"), input[name=allow]').first();
if (await btn.count()) { await btn.click(); await p.waitForTimeout(8000); }
console.log('after', p.url());
console.log((await p.locator('body').innerText()).slice(0, 600));
await p.screenshot({ path: S + '/08-ocs-after.png' });
await b.close();
