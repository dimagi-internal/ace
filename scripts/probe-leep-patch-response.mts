// One-shot: re-fetch the live form, patch, post once, dump full JSON body
// so we know the exact response shape.
import { chromium } from 'playwright';
import { unzipSync, strFromU8 } from 'fflate';
import { applyUserScorePatch } from '../mcp/connect/backends/commcare.ts';

const HQ = 'https://www.commcarehq.org';
const DOMAIN = 'connect-ace-prod';
const APP_ID = '4e20ddf5beca42278c4d2c20383eb943';
const FORM_UID = '6f3d3ad3ed9d44e5b4107c0a1210dd10';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ storageState: '/Users/acedimagi/.ace/connect-session.json' });

const cczRes = await ctx.request.get(`${HQ}/a/${DOMAIN}/apps/api/download_ccz/?app_id=${APP_ID}&latest=release`);
const entries = unzipSync(new Uint8Array(await cczRes.body()));
const before = strFromU8(entries['modules-0/forms-1.xml']);
const { xml } = applyUserScorePatch(before);

await ctx.request.get(`${HQ}/a/${DOMAIN}/apps/view/${APP_ID}/`);
const cookies = await ctx.cookies();
const tok = cookies.find((c) => c.name === 'csrftoken' && c.domain.includes('commcarehq'))?.value ?? '';

const form = new URLSearchParams();
form.set('xform', xml);

const res = await ctx.request.post(
  `${HQ}/a/${DOMAIN}/apps/edit_form_attr/${APP_ID}/${FORM_UID}/xform/`,
  {
    data: form.toString(),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-CSRFToken': tok,
      Referer: `${HQ}/a/${DOMAIN}/apps/view/${APP_ID}/`,
    },
    maxRedirects: 0,
  },
);
console.log('status', res.status());
console.log('headers', JSON.stringify(res.headers(), null, 2));
const body = await res.text();
console.log('body=', body);
await browser.close();
