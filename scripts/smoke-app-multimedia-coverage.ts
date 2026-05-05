// scripts/smoke-app-multimedia-coverage.ts
//
// End-to-end live smoke for the new app-multimedia-coverage pipeline.
// Generates one image via Dimagi's Content Generator API, patches one
// form's XForm to add a `<value form="image">jr://...</value>` itext entry,
// uploads the PNG to CCHQ, makes + releases a build, then re-downloads the
// released CCZ and confirms the asset is bundled AND the form references it.
//
// Why bypass the MCP atom: the smoke is run from a feature branch where
// the new `commcare_upload_multimedia` MCP atom isn't yet plugged into the
// installed plugin (the cached plugin is older than this worktree). We
// instantiate `CommCareBackend` directly here — same code path the atom
// will invoke once plugged in — so the smoke exercises the live HTTP
// contract end-to-end without waiting for `/ace:update`.
//
// Run:
//   # ENV (CONNECT/CCHQ/HQ-USERNAME/PASSWORD live in plugin-data .env;
//   # the dotenv import below loads them from the canonical path)
//   export CONTENT_GENERATOR_URL=https://content-generator-gateway-...uc.gateway.dev/
//   export CONTENT_GENERATOR_API_KEY=AIzaSy...
//   npx tsx scripts/smoke-app-multimedia-coverage.ts <domain> <app_id> <module> <form> <field_id>
//
// Default args (LEEP smoke target — see scripts/probe-multimedia-upload.ts
// for prior live-probe history on this app):
//   domain=connect-ace-prod app_id=4e20ddf5beca42278c4d2c20383eb943
//   module=0 form=0 field_id=health_context
//
// Verifies the asset under BOTH CCZ path candidates documented in
// scripts/probe-multimedia-upload.ts:
//   - commcare/image/<filename>           (live-confirmed CCHQ shape)
//   - commcare/multimedia/image/<filename> (task-brief expectation)

import { config as dotenvConfig } from 'dotenv';
import * as path from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';

import { ContentGeneratorClient } from '../lib/content-generator-client.js';
import { addImageItext } from '../lib/multimedia-xform-patch.js';
import { PlaywrightSession } from '../mcp/connect/auth/playwright-session.js';
import { CommCareBackend } from '../mcp/connect/backends/commcare.js';

// Load plugin-data .env (CONNECT_BASE_URL, ACE_HQ_USERNAME/PASSWORD, etc.)
const PLUGIN_DATA_ENV = '/Users/acedimagi/.claude/plugins/data/ace-ace/.env';
dotenvConfig({ path: PLUGIN_DATA_ENV });

const [
  domain = 'connect-ace-prod',
  appId = '4e20ddf5beca42278c4d2c20383eb943',
  moduleStr = '0',
  formStr = '0',
  fieldId = 'health_context',
] = process.argv.slice(2);
const moduleIdx = parseInt(moduleStr, 10);
const formIdx = parseInt(formStr, 10);

const cgUrl = process.env.CONTENT_GENERATOR_URL;
const cgKey = process.env.CONTENT_GENERATOR_API_KEY;
if (!cgUrl || !cgKey) {
  console.error('Set CONTENT_GENERATOR_URL and CONTENT_GENERATOR_API_KEY (1Password: AI-Agents > Content Generator API).');
  process.exit(1);
}

console.log('=== Smoke: app-multimedia-coverage ===');
console.log({ domain, appId, moduleIdx, formIdx, fieldId });

const session = new PlaywrightSession({
  baseUrl: process.env.CONNECT_BASE_URL!,
  hqUsername: process.env.ACE_HQ_USERNAME,
  hqPassword: process.env.ACE_HQ_PASSWORD,
});
await session.getContext();
const cchqBaseUrl = process.env.ACE_HQ_BASE_URL ?? 'https://www.commcarehq.org';
const c = new CommCareBackend({ baseUrl: cchqBaseUrl, session });

const stepStart = (n: number, label: string) => {
  const t = Date.now();
  console.log(`\n[${n}/6] ${label}...`);
  return () => {
    const dur = ((Date.now() - t) / 1000).toFixed(1);
    console.log(`       (${dur}s)`);
    return Number(dur);
  };
};

try {
  // Step 1: Download the current CCZ to find the form XML and form unique_id.
  let end = stepStart(1, 'Downloading current CCZ');
  const ccz1 = await c.downloadCcz({ domain, app_id: appId });
  const t1 = end();
  if (ccz1.status !== 200 || !ccz1.ccz_base64) {
    throw new Error(`download_ccz #1 status=${ccz1.status} size=${ccz1.size_bytes}`);
  }
  const buf1 = Buffer.from(ccz1.ccz_base64, 'base64');
  const entries1 = unzipSync(new Uint8Array(buf1));
  const formPath = `modules-${moduleIdx}/forms-${formIdx}.xml`;
  if (!entries1[formPath]) {
    const formPaths = Object.keys(entries1).filter(p => /modules-\d+\/forms-\d+\.xml$/.test(p));
    console.error(`Form ${formPath} not in CCZ. Available:`, formPaths);
    process.exit(1);
  }
  const xml = strFromU8(entries1[formPath]);
  const suiteXml = strFromU8(entries1['suite.xml']);
  // Pull every <resource id="..."> in suite.xml and pair with its form ref.
  const resourceRe = /<resource id="([0-9a-f]{32})"[^>]*>[\s\S]*?(modules-\d+\/forms-\d+\.xml)/g;
  const formMap: Record<string, string> = {};
  let m: RegExpExecArray | null;
  while ((m = resourceRe.exec(suiteXml))) {
    formMap[m[2]] = m[1];
  }
  const formUniqueId = formMap[formPath];
  if (!formUniqueId) {
    console.error(`Could not derive form unique_id for ${formPath}; suite.xml mappings:`, formMap);
    process.exit(1);
  }
  console.log(`       form_unique_id=${formUniqueId}`);

  // Step 2: Generate one image via the Content Generator API.
  let end2 = stepStart(2, 'Calling Content Generator (low-res, ~70s)');
  const cg = new ContentGeneratorClient({ url: cgUrl, apiKey: cgKey });
  const { image, promptUsed } = await cg.generateImage({
    applicationContext:
      'A frontline-worker training app for low-resource settings. Modestly dressed, representative of context. No real people; subjects neutral or environmental.',
    formText:
      'Lead in decorative paints is a major source of childhood lead exposure in low- and middle-income countries.',
    imageDirectives:
      'Simple, clear, neutral subject. Used for live smoke validation of the app-multimedia-coverage pipeline.',
  });
  const t2 = end2();
  console.log(`       image_bytes=${image.length}, prompt_used[:120]="${promptUsed.slice(0, 120)}..."`);

  // Step 3: Patch the form XML (pure transform, no network).
  //
  // Pre-clean: strip any existing `<value form="image">…</value>` children
  // from the target field's `<text id="<fieldId>-label">` nodes. Without
  // this, repeat smoke runs against the same field would accumulate
  // multiple image values across the form's translations and CCHQ's
  // build-time XForm validator rejects the build with "duplicate
  // definition for text ID … and form 'image'" (verified live
  // 2026-05-05). Production skill code patches greenfield forms so this
  // sanitizer isn't needed there, but the smoke is re-run idempotently.
  let end3 = stepStart(3, 'Patching form XML');
  const stripExistingImageValues = (formXml: string, fid: string): string => {
    // Find each <text id="<fid>-label"> ... </text> block and drop any
    // `<value form="image">...</value>` children. Multi-translation forms
    // have one block per <translation lang=...>; the regex matches all.
    const blockRe = new RegExp(
      `(<text id="${fid.replace(/[.*+?^${}()|[\\\\]\\\\]/g, '\\\\$&')}-label">)([\\s\\S]*?)(</text>)`,
      'g',
    );
    return formXml.replace(blockRe, (_match, open, body, close) => {
      const cleanedBody = body.replace(/<value form="image">[\s\S]*?<\/value>\s*/g, '');
      return `${open}${cleanedBody}${close}`;
    });
  };
  const cleanXml = stripExistingImageValues(xml, fieldId);
  if (cleanXml !== xml) {
    console.log('       (stripped existing <value form="image"> from prior smoke runs)');
  }
  const cczFilename = `smoke_${fieldId}_${Date.now()}.png`;
  const patch = addImageItext(cleanXml, [{ fieldId, cczFilename }]);
  const t3 = end3();
  if (!patch.patched) {
    console.error(
      `addImageItext returned patched=false. notFound=${JSON.stringify(patch.notFound)} skipped=${JSON.stringify(patch.skipped)}`,
    );
    process.exit(1);
  }
  console.log(`       applied=${JSON.stringify(patch.applied)} ccz_filename=${cczFilename}`);

  // Step 4: POST patched XML to CCHQ.
  let end4 = stepStart(4, 'POSTing patched XForm to CCHQ');
  const patchRes = await c.patchXform({
    domain,
    app_id: appId,
    form_unique_id: formUniqueId,
    new_xform_xml: patch.xml,
  });
  const t4 = end4();
  console.log(`       status=${patchRes.status} app_version=${patchRes.app_version}`);

  // Step 5: Upload the PNG.
  let end5 = stepStart(5, 'Uploading multimedia binary');
  const upload = await c.uploadMultimedia({
    domain,
    app_id: appId,
    media_path: `jr://file/commcare/image/${cczFilename}`,
    file_bytes: image,
    content_type: 'image/png',
  });
  const t5 = end5();
  console.log(`       multimedia_id=${upload.multimedia_id} file_hash_md5=${upload.file_hash_md5}`);

  // Step 6: Build + release + verify.
  //
  // FINDING (2026-05-05 live smoke): the default `download_ccz` endpoint
  // returns the *manifest-only* CCZ — media_suite.xml registers each
  // resource with two locations (./commcare/image/<f> + the remote
  // /hq/multimedia/file/CommCareImage/<m_id>/ URL), but the binary itself
  // is NOT inlined. The Android client lazy-fetches it from the remote
  // URL on demand. To get a fully self-contained CCZ (binary inlined
  // under commcare/image/<filename>), append `&include_multimedia=true`.
  //
  // Without this flag the multimedia verify step is misleading — the
  // form references the jr:// path correctly, the upload landed in
  // CouchDB correctly, and devices CAN fetch it at runtime — but the
  // binary won't appear in the lite CCZ. The skill's step 10 verify
  // and the `commcare_download_ccz` atom both default to the lite shape
  // today; if downstream consumers need the bytes inlined they need a
  // future atom enhancement (DownloadCczArgs.include_multimedia: boolean).
  let end6 = stepStart(6, 'Building + releasing + verifying CCZ');
  const build = await c.makeBuild({
    domain,
    app_id: appId,
    comment: `smoke-app-multimedia-coverage ${cczFilename}`,
  });
  console.log(`       build_id=${build.build_id} version=${build.version}`);
  const release = await c.releaseBuild({ domain, app_id: appId, build_id: build.build_id });
  console.log(`       released=${release.is_released}`);

  // Verify with include_multimedia=true (direct request — atom doesn't
  // yet expose this flag, see comment above).
  const ctx = await session.getContext();
  const verifyUrl =
    `${cchqBaseUrl}/a/${domain}/apps/api/download_ccz/?app_id=${build.build_id}&include_multimedia=true`;
  const verifyRes = await ctx.request.get(verifyUrl);
  const t6 = end6();
  if (verifyRes.status() !== 200) {
    console.error(`verify GET ${verifyUrl} -> status=${verifyRes.status()}`);
    process.exit(2);
  }
  const buf2 = await verifyRes.body();
  const entries2 = unzipSync(new Uint8Array(buf2));
  console.log(`       full CCZ size=${buf2.byteLength} entries=${Object.keys(entries2).length}`);

  // Verify asset bundled. Live-probed CCHQ uses commcare/image/<filename>;
  // the task brief mentioned commcare/multimedia/image/<filename>. Accept
  // either, report which one CCHQ actually used.
  const candidates = [
    `commcare/image/${cczFilename}`,
    `commcare/multimedia/image/${cczFilename}`,
  ];
  const matched = candidates.find((p) => entries2[p]);
  if (!matched) {
    console.error(`\nVERIFY FAILED — asset not found at either candidate path.`);
    console.error('Candidates checked:', candidates);
    const allMedia = Object.keys(entries2).filter((n) => /multimedia|image|audio|video|text/i.test(n));
    console.error('Media-shaped CCZ entries:', allMedia.slice(0, 20));
    const matchingFilename = Object.keys(entries2).filter((n) => n.includes(cczFilename));
    console.error('Entries containing the filename:', matchingFilename);
    process.exit(2);
  }
  console.log(`       asset bundled at: ${matched} (${entries2[matched].length} bytes)`);

  // Verify form references the asset.
  const formEntry2 = entries2[formPath];
  if (!formEntry2) {
    console.error(`VERIFY FAILED — form ${formPath} missing from released CCZ.`);
    process.exit(2);
  }
  const xml2 = strFromU8(formEntry2);
  const jrUrl = `jr://file/commcare/image/${cczFilename}`;
  const refsAsset = xml2.includes(jrUrl);
  console.log(`       form references ${jrUrl}: ${refsAsset}`);
  if (!refsAsset) {
    console.error('VERIFY FAILED — form does not reference the asset; orphan-pruning may have stripped the upload.');
    process.exit(2);
  }

  console.log('\n=== SMOKE PASS ===');
  console.log({
    target: { domain, appId, formPath, formUniqueId, fieldId },
    build: { build_id: build.build_id, version: build.version, released: release.is_released },
    upload: { multimedia_id: upload.multimedia_id, file_hash_md5: upload.file_hash_md5 },
    ccz_path_used: matched,
    timings_seconds: { download1: t1, generate: t2, patch_xml: t3, post_patch: t4, upload: t5, build_release_verify: t6 },
  });
} finally {
  await session.close();
}
