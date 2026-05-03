// Live end-to-end test of commcare_patch_xform against leep-paint-collection.
// Emulates the `commcare-form-patch` skill flow:
//   1. Download CCZ for current Learn release
//   2. Resolve all 6 quiz form unique_ids
//   3. Apply applyUserScorePatch to each
//   4. POST to /apps/edit_form_attr/.../xform/ via the saved Playwright session
//   5. Make new build, release it
//   6. Re-download CCZ, verify 0 empty <user_score/>, 6 populated
//   7. Try connect_create_opportunity — if 201, success. If 500, capture body.

import { chromium } from 'playwright';
import * as fs from 'fs';
import { unzipSync, strFromU8 } from 'fflate';
import {
  applyUserScorePatch,
} from '../mcp/connect/backends/commcare.ts';

const HQ = 'https://www.commcarehq.org';
const DOMAIN = 'connect-ace-prod';
const APP_ID = '4e20ddf5beca42278c4d2c20383eb943';
const BUILD_ID = '9f9932a3bd104129ad5b73e07e6f7bb8';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  storageState: '/Users/acedimagi/.ace/connect-session.json',
});

async function csrf() {
  const cookies = await ctx.cookies();
  return cookies.find((c) => c.name === 'csrftoken' && c.domain.includes('commcarehq'))?.value ?? '';
}

// 1. Download current released CCZ
console.log('## 1. Downloading current released Learn CCZ');
const cczRes = await ctx.request.get(
  `${HQ}/a/${DOMAIN}/apps/api/download_ccz/?app_id=${APP_ID}&latest=release`,
);
console.log(`  status=${cczRes.status()} size=${(await cczRes.body()).byteLength}`);
const cczBuf = await cczRes.body();
const entries = unzipSync(new Uint8Array(cczBuf));

// 2. Parse suite.xml for form unique_ids on quiz forms
const suite = strFromU8(entries['suite.xml']);
const xformRe = /<xform>\s*<resource id="([0-9a-f]{32})" version="\d+" descriptor="([^"]+)">\s*<location authority="local">\.\/(modules-\d+\/forms-\d+\.xml)<\/location>/g;
const allForms = [];
let m;
while ((m = xformRe.exec(suite))) {
  allForms.push({ unique_id: m[1], descriptor: m[2], path: m[3] });
}
console.log(`## 2. Discovered ${allForms.length} forms total`);

// Quiz forms = forms-1.xml in each module (per Nova LEEP shape)
const quizForms = allForms.filter((f) => f.path.endsWith('/forms-1.xml'));
console.log(`     ${quizForms.length} quiz forms`);
for (const q of quizForms) console.log(`       ${q.path}  uniq=${q.unique_id}`);

// 3. Apply patch to each quiz form
console.log('## 3. Applying applyUserScorePatch to each quiz form');
const patches = [];
for (const q of quizForms) {
  const before = strFromU8(entries[q.path]);
  const { patched, xml } = applyUserScorePatch(before);
  console.log(`     ${q.path}  patched=${patched}`);
  patches.push({ ...q, before, after: xml, patched });
}

const toPost = patches.filter((p) => p.patched);
console.log(`     -> ${toPost.length} forms need a patch POST`);

// 4. POST each patch
console.log('## 4. POSTing patched XML to edit_form_attr/.../xform/');
// Refresh CSRF cookie via apps/view
await ctx.request.get(`${HQ}/a/${DOMAIN}/apps/view/${APP_ID}/`);
const tok = await csrf();
console.log(`     csrf=${tok.slice(0, 8)}...`);

for (const p of toPost) {
  const url = `${HQ}/a/${DOMAIN}/apps/edit_form_attr/${APP_ID}/${p.unique_id}/xform/`;
  const form = new URLSearchParams();
  form.set('xform', p.after);
  const res = await ctx.request.post(url, {
    data: form.toString(),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-CSRFToken': tok,
      Referer: `${HQ}/a/${DOMAIN}/apps/view/${APP_ID}/`,
    },
    maxRedirects: 0,
  });
  const body = await res.text();
  if (res.status() !== 200) {
    console.log(`     ${p.path} status=${res.status()} body=${body.slice(0, 400)}`);
    process.exit(2);
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    console.log(`     ${p.path} 200 BUT non-JSON body=${body.slice(0, 400)}`);
    process.exit(2);
  }
  console.log(`     ${p.path} ok  new_sha1=${(parsed.sha1 ?? '').slice(0, 8)}...`);
}

// 5. Make new build + release
console.log('## 5. Make new build + release');
const refreshUrl = `${HQ}/a/${DOMAIN}/apps/view/${APP_ID}/releases/`;
await ctx.request.get(refreshUrl);
const tok2 = await csrf();
const buildRes = await ctx.request.post(
  `${HQ}/a/${DOMAIN}/apps/save/${APP_ID}/`,
  {
    data: 'comment=' + encodeURIComponent('user_score patch via commcare-form-patch skill (nova-plugin#5 workaround)'),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-CSRFToken': tok2,
      Referer: refreshUrl,
    },
    maxRedirects: 0,
  },
);
console.log(`     build status=${buildRes.status()}`);
const buildBody = await buildRes.text();
const buildParsed = JSON.parse(buildBody);
const newBuildId = buildParsed.saved_app?._id ?? buildParsed._id ?? buildParsed.id;
const newVersion = buildParsed.saved_app?.version ?? buildParsed.version;
console.log(`     new build_id=${newBuildId}  version=${newVersion}`);

const releaseRes = await ctx.request.post(
  `${HQ}/a/${DOMAIN}/apps/view/${APP_ID}/releases/release/${newBuildId}/`,
  {
    data: 'ajax=true&is_released=true',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-CSRFToken': tok2,
      Referer: refreshUrl,
    },
    maxRedirects: 0,
  },
);
console.log(`     release status=${releaseRes.status()} body=${(await releaseRes.text()).slice(0, 200)}`);

// 6. Verify
console.log('## 6. Re-download released CCZ and verify');
const verifyRes = await ctx.request.get(
  `${HQ}/a/${DOMAIN}/apps/api/download_ccz/?app_id=${APP_ID}&latest=release`,
);
const verifyBuf = await verifyRes.body();
const verifyEntries = unzipSync(new Uint8Array(verifyBuf));
let totalEmpty = 0;
let totalPopulated = 0;
for (const [name, bytes] of Object.entries(verifyEntries)) {
  if (!name.endsWith('/forms-1.xml')) continue;
  const txt = strFromU8(bytes);
  const empties = (txt.match(/<user_score\s*\/>/g) ?? []).length;
  const pops = (txt.match(/<user_score>\/data\/total_score<\/user_score>/g) ?? []).length;
  console.log(`     ${name}  empty=${empties}  populated=${pops}`);
  totalEmpty += empties;
  totalPopulated += pops;
}
console.log(`     TOTAL empty=${totalEmpty}  populated=${totalPopulated}`);

if (totalEmpty !== 0 || totalPopulated < 6) {
  console.log('!!! VERIFICATION FAILED');
  process.exit(3);
}
console.log('     ✅ verification passed');
console.log(`\n## NEW LEARN BUILD: ${newBuildId}  version=${newVersion}`);

await browser.close();
