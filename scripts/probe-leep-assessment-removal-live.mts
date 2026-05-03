// Live end-to-end test of assessment-removal patch class against
// leep-paint-collection. Mirrors probe-leep-patch-live.mts but uses
// the new applyAssessmentRemovalPatch helper.
//
// Flow:
//   1. Download CCZ for current Learn release
//   2. Resolve all quiz form unique_ids via suite.xml
//   3. Apply applyAssessmentRemovalPatch to each (strip wrapper + binds)
//   4. POST patched XML to /apps/edit_form_attr/.../xform/
//   5. Make new build, release it
//   6. Re-download CCZ, verify ZERO commcareconnect references in any form
//   7. Try connect_create_opportunity — expect 201 (or capture 5xx body)

import { chromium } from 'playwright';
import { unzipSync, strFromU8 } from 'fflate';
import { applyAssessmentRemovalPatch } from '../mcp/connect/backends/commcare.ts';

const HQ = 'https://www.commcarehq.org';
const DOMAIN = 'connect-ace-prod';
const APP_ID = '4e20ddf5beca42278c4d2c20383eb943'; // LEEP Learn

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  storageState: '/Users/acedimagi/.ace/connect-session.json',
});

async function csrf(domainContains: string) {
  const cookies = await ctx.cookies();
  return (
    cookies.find((c) => c.name === 'csrftoken' && c.domain.includes(domainContains))?.value ?? ''
  );
}

// 1. Download current released CCZ
console.log('## 1. Downloading current released Learn CCZ');
const cczRes = await ctx.request.get(
  `${HQ}/a/${DOMAIN}/apps/api/download_ccz/?app_id=${APP_ID}&latest=release`,
);
console.log(`  status=${cczRes.status()} size=${(await cczRes.body()).byteLength}`);
const cczBuf = await cczRes.body();
const entries = unzipSync(new Uint8Array(cczBuf));

// 2. Parse suite.xml for all forms
const suite = strFromU8(entries['suite.xml']);
const xformRe =
  /<xform>\s*<resource id="([0-9a-f]{32})" version="\d+" descriptor="([^"]+)">\s*<location authority="local">\.\/(modules-\d+\/forms-\d+\.xml)<\/location>/g;
const allForms = [];
let m;
while ((m = xformRe.exec(suite))) {
  allForms.push({ unique_id: m[1], descriptor: m[2], path: m[3] });
}
console.log(`## 2. Discovered ${allForms.length} forms total`);

// Auto-target: any form with a commcareconnect-namespaced inner element
// (assessment OR module OR deliver OR task — Nova emits all four shapes
// across learn/quiz/deliver forms with the same wrapper pattern).
const candidates = allForms
  .map((f) => ({ ...f, body: strFromU8(entries[f.path]) }))
  .filter((f) => /xmlns="http:\/\/commcareconnect\.com/.test(f.body));
console.log(`     ${candidates.length} forms contain commcareconnect markup`);
for (const q of candidates) console.log(`       ${q.path}  uniq=${q.unique_id}`);

// 3. Apply patch
console.log('## 3. Applying applyAssessmentRemovalPatch to each candidate');
const patches = [];
for (const q of candidates) {
  const { patched, xml, removedWrappers } = applyAssessmentRemovalPatch(q.body);
  console.log(
    `     ${q.path}  patched=${patched}  removedWrappers=${JSON.stringify(removedWrappers)}`,
  );
  patches.push({ ...q, after: xml, patched, removedWrappers });
}
const toPost = patches.filter((p) => p.patched);
console.log(`     -> ${toPost.length} forms need a patch POST`);

if (toPost.length === 0) {
  console.log('## NOTHING TO PATCH — exiting');
  await browser.close();
  process.exit(0);
}

// 4. POST each patch
console.log('## 4. POSTing patched XML to edit_form_attr/.../xform/');
await ctx.request.get(`${HQ}/a/${DOMAIN}/apps/view/${APP_ID}/`);
const tok = await csrf('commcarehq');
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
  const ver = parsed?.update?.['app-version'] ?? '?';
  console.log(`     ${p.path} ok  app-version=${ver}`);
}

// 5. Make new build + release
console.log('## 5. Make new build + release');
const refreshUrl = `${HQ}/a/${DOMAIN}/apps/view/${APP_ID}/releases/`;
await ctx.request.get(refreshUrl);
const tok2 = await csrf('commcarehq');
const buildRes = await ctx.request.post(`${HQ}/a/${DOMAIN}/apps/save/${APP_ID}/`, {
  data:
    'comment=' +
    encodeURIComponent(
      'assessment-removal patch via commcare-form-patch skill (nova-plugin#7 workaround)',
    ),
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    'X-CSRFToken': tok2,
    Referer: refreshUrl,
  },
  maxRedirects: 0,
});
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
console.log(
  `     release status=${releaseRes.status()} body=${(await releaseRes.text()).slice(0, 200)}`,
);

// 6. Verify
console.log('## 6. Re-download released CCZ and verify');
const verifyRes = await ctx.request.get(
  `${HQ}/a/${DOMAIN}/apps/api/download_ccz/?app_id=${APP_ID}&latest=release`,
);
const verifyBuf = await verifyRes.body();
const verifyEntries = unzipSync(new Uint8Array(verifyBuf));
let totalConnect = 0;
let totalAssessment = 0;
for (const [name, bytes] of Object.entries(verifyEntries)) {
  if (!name.match(/^modules-\d+\/forms-\d+\.xml$/)) continue;
  const txt = strFromU8(bytes);
  const connect = (txt.match(/commcareconnect/g) ?? []).length;
  const assessment = (txt.match(/<assessment\b/g) ?? []).length;
  if (connect || assessment) {
    console.log(`     ${name}  commcareconnect=${connect}  assessment-tags=${assessment}`);
  }
  totalConnect += connect;
  totalAssessment += assessment;
}
console.log(`     TOTAL commcareconnect=${totalConnect}  assessment-tags=${totalAssessment}`);
if (totalConnect !== 0) {
  console.log('!!! VERIFICATION FAILED — commcareconnect references still present');
  process.exit(3);
}
console.log('     ✅ verification passed');
console.log(`\n## NEW LEARN BUILD: ${newBuildId}  version=${newVersion}`);

await browser.close();
