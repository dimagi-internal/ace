// Probes CCHQ's multimedia upload endpoint to document the live contract.
// Uses the same authenticated Playwright session as commcare_patch_xform.
//
// Run: npx tsx scripts/probe-multimedia-upload.ts <hq_domain> <app_id>
//
// Source-tree narrowing (corehq/apps/hqmedia/urls.py + app_manager/urls.py):
//   `/a/<domain>/apps/<app_id>/multimedia/uploaded/image/` is mounted on
//   ProcessImageFileUploadView (subclasses BaseProcessFileUploadView).
//   `BaseProcessUploadedView.upload_filename = 'Filedata'` is the file field;
//   `BaseProcessFileUploadView.form_path = request.POST.get('path', '')` is
//   the jr://-style path under which the media is mapped on the app.
//   `validate_file` requires `file_ext == possible_extensions(self.form_path)`
//   so `path` must end in `.png` for a PNG upload.
//
// LIVE CONTRACT (probed 2026-05-05 against connect-ace-prod, app=4e20ddf5beca42278c4d2c20383eb943):
//   Method:  POST
//   Path:    /a/<domain>/apps/<app_id>/multimedia/uploaded/image/
//            (also /uploaded/audio/, /uploaded/video/, /uploaded/text/ for those
//            mime base-types — same view shape, different `media_class`. See
//            corehq/apps/hqmedia/urls.py § application_urls.)
//   Content-Type request:  multipart/form-data
//   Required form fields:
//     Filedata = <bytes>              file field; name fixed by
//                                     BaseProcessUploadedView.upload_filename = 'Filedata'
//     path     = jr://file/commcare/image/<basename>.<ext>
//                                     CCHQ uses this as the key under
//                                     app.multimedia_map. The file extension
//                                     MUST match the uploaded file, otherwise
//                                     BaseProcessFileUploadView.validate_file
//                                     raises BadMediaFileException and the
//                                     response is 400 with errors[]={"File ...
//                                     has an incorrect file type ..."}.
//   Optional form fields:
//     originalPath        — re-upload of an existing media path
//     shared              — 't' to mark license-shared
//     license, author, attribution-notes — license metadata when shared='t'
//   Auth:    same Playwright session as patchXform; both the `csrftoken`
//            cookie AND the `X-CSRFToken` header are required. The view is
//            decorated `@require_permission(HqPermissions.edit_apps,
//            login_decorator=login_and_domain_required)`; the session must
//            have edit-apps perm on the target domain.
//   CSRF refresh: GET /a/<domain>/apps/view/<app_id>/ first, then read
//            `csrftoken` from the cookie jar — same pattern as patchXform.
//
//   Response (success):
//     200 OK, **Content-Type: text/html; charset=utf-8** (NOT application/json
//     — Django HttpResponse(json.dumps(response)) defaults to text/html, but
//     the body IS valid JSON).
//     {
//       "ref": {
//         "path": "jr://file/commcare/image/<basename>.<ext>",   # echo of input `path`
//         "uid":  "<32-hex md5>",                                # CommCareMultimedia.file_hash — **md5(data)**, NOT sha1
//         "m_id": "<32-hex couchdb _id>",                        # the multimedia document id; this is what `commcare_upload_multimedia` should return as `multimedia_id`
//         "url":  "/hq/multimedia/file/CommCareImage/<m_id>/",   # public download URL
//         "updated": false,                                      # true if `path` already had a different multimedia mapped
//         "original_path": null,                                 # echo of input `originalPath`
//         "icon_class": "fa-regular fa-image",
//         "media_type": "Image",                                 # nice-name of the CommCareMultimedia subclass
//         "humanized_content_length": "68 bytes",
//         "image_size": "1 x 1 px"                               # image-only; absent for audio/video
//       },
//       "errors": []                                             # always present; success iff []
//     }
//
//   Response (failure):
//     400 Bad Request, body shape `{ "ref": {...}, "errors": ["msg", ...] }`
//     or `{ "errors": [...] }` if validate_file raised before process_upload.
//     The caller should check **both** `status === 200` AND `body.errors.length === 0`.
//     302 -> /accounts/login/?next=... when session is expired.
//     403 when CSRF token is missing/wrong.
//
//   Idempotency:  Re-uploading the same file content (same md5) returns the
//     same `m_id` and `uid` — CommCareMultimedia.get_by_data dedupes on
//     md5(data), so no duplicate couch docs are created. `updated` flips to
//     true if the same `path` was already mapped to a *different* media id.
//
//   ⚠️  CCZ-DELIVERY GOTCHA — discovered live 2026-05-05:
//     A successful upload (200, valid `m_id`) is NOT sufficient to make the
//     PNG appear in the released CCZ. CCHQ's build pipeline filters
//     `multimedia_map` to paths that are actually referenced by a form/module
//     — see `multimedia_map_for_build` + `remove_unused_mappings` +
//     `all_media_paths()` in corehq/apps/hqmedia/models.py. Verified live:
//     uploaded probe-<ts>.png, made build #23, released, downloaded CCZ —
//     17 entries total, **zero** under commcare/image/* or commcare/multimedia/*,
//     and `multimedia_ajax` reports our filename/uid not in the map. CCZ
//     contained only XMLs + profile.ccpr + app_strings.txt, no media payloads.
//
//     Implication for the `app-multimedia-coverage` skill (Task 9 + 10):
//     the `commcare_upload_multimedia` atom by itself produces a couch doc
//     accessible at /hq/multimedia/file/CommCareImage/<m_id>/, but to land
//     in the CCZ at `commcare/image/<basename>.<ext>` (the post-jr-prefix
//     suffix), at least one form/module's XForm or display-media setting
//     must reference the `jr://file/commcare/image/<basename>.<ext>` path.
//     Otherwise the build pipeline silently prunes the orphan path. The
//     skill must therefore: (1) upload the binary, (2) patch the form XML
//     (via `commcare_patch_xform`) to add an `<output value="jr://..."/>`
//     or set the module's `<media>` ref, (3) make+release the build.
//     Documenting this here so the atom itself stays narrow (just the upload
//     primitive) and the skill owns the orchestration.
//
//   Smoke target used:  domain=connect-ace-prod, app_id=4e20ddf5beca42278c4d2c20383eb943 (LEEP Learn)
//   Side effects on the test app:
//     - One CommCareImage couch doc (1×1 transparent PNG, 67 bytes; md5
//       91e42db1c66c0b276abf6234dc50b2eb). Re-runs are idempotent (same md5
//       → same m_id), so no doc-spam from repeat probes.
//     - Two new released app builds (versions 22 and 23) from the CCZ-verify
//       step. Builds are cheap and the LEEP Learn app already has many
//       prior throwaway builds from probe-leep-* scripts — no real-world
//       impact. Set SKIP_CCZ_VERIFY=1 to skip this on future runs.
//     - The orphan multimedia path is auto-pruned by `clean_paths()` so
//       there's no lingering map pollution.
//
// NOTE for Task 9 (`commcare_upload_multimedia` atom):
//   - Return field `multimedia_id` should be sourced from `ref.m_id`.
//   - The "checksum" returned by CCHQ is **md5**, not sha1. Either expose
//     it as `file_hash_md5` to avoid the spec's misleading name, or compute
//     sha1 client-side from `args.file_bytes` if a sha1 is genuinely needed.
//   - Caller must check `status === 200 && body.errors.length === 0` —
//     status alone is insufficient because validate_file errors return 400
//     with the same JSON shape.
//   - Content-Type lies (text/html). Parse body as JSON regardless.

import { chromium } from 'playwright';
import { unzipSync } from 'fflate';

const [, , domainArg, appIdArg] = process.argv;
const DOMAIN = domainArg ?? 'connect-ace-prod';
const APP_ID = appIdArg ?? '4e20ddf5beca42278c4d2c20383eb943';

const HQ = 'https://www.commcarehq.org';
const SESSION_PATH = `${process.env.HOME}/.ace/connect-session.json`;

// 1x1 transparent PNG (smallest valid PNG, ~67 bytes).
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ storageState: SESSION_PATH });

async function csrf(): Promise<string> {
  const cookies = await ctx.cookies();
  return (
    cookies.find((c) => c.name === 'csrftoken' && c.domain.includes('commcarehq'))
      ?.value ?? ''
  );
}

const candidatePaths = [
  // Source-tree-confirmed mount: /a/<domain>/apps/<app_id>/multimedia/uploaded/image/
  `/a/${DOMAIN}/apps/${APP_ID}/multimedia/uploaded/image/`,
  // Backup candidates from the task brief, kept so the script also documents
  // 404s from the wrong-path family. Iterating these costs <1s each.
  `/a/${DOMAIN}/apps/${APP_ID}/multimedia_upload/`,
  `/a/${DOMAIN}/multimedia/upload_multimedia/${APP_ID}/`,
  `/a/${DOMAIN}/apps/multimedia/${APP_ID}/uploaded/`,
];

// Refresh CSRF + session via the app-view page (same pattern as patchXform).
const refreshUrl = `${HQ}/a/${DOMAIN}/apps/view/${APP_ID}/`;
const refreshRes = await ctx.request.get(refreshUrl);
console.log(`refresh ${refreshUrl} -> status=${refreshRes.status()}`);
const tok = await csrf();
console.log(`csrf=${tok.slice(0, 8)}...`);
if (!tok) {
  console.error('No csrftoken cookie — session likely expired. Run /ace:connect-login.');
  await browser.close();
  process.exit(2);
}

let foundJrPath: string | null = null;
let foundFilename: string | null = null;
let foundMId: string | null = null;
let foundUid: string | null = null;

for (const path of candidatePaths) {
  const url = `${HQ}${path}`;
  const filename = `probe-${Date.now()}.png`;
  // jr:// path; BaseProcessFileUploadView.validate_file requires ext match.
  const jrPath = `jr://file/commcare/image/${filename}`;

  const form = new FormData();
  form.set('Filedata', new Blob([TINY_PNG], { type: 'image/png' }), filename);
  form.set('path', jrPath);

  try {
    const res = await ctx.request.post(url, {
      multipart: form as any,
      headers: { 'X-CSRFToken': tok, Referer: refreshUrl },
      maxRedirects: 0,
    });
    const status = res.status();
    const body = await res.text();
    console.log({
      path,
      status,
      contentType: res.headers()['content-type'],
      bodySlice: body.slice(0, 600),
    });
    if (status === 200 || status === 201) {
      console.log('FOUND working endpoint:', path);
      console.log('Full body:', body);
      try {
        const parsed = JSON.parse(body);
        console.log('Parsed JSON keys:', Object.keys(parsed));
        if (parsed.ref) console.log('ref keys:', Object.keys(parsed.ref));
        console.log('ref.m_id:', parsed.ref?.m_id);
        console.log('ref.uid (md5):', parsed.ref?.uid);
        console.log('ref.path:', parsed.ref?.path);
        console.log('errors:', parsed.errors);
        foundJrPath = parsed.ref?.path ?? null;
        foundFilename = filename;
        foundMId = parsed.ref?.m_id ?? null;
        foundUid = parsed.ref?.uid ?? null;
      } catch (e) {
        console.log('200 but JSON parse failed:', e);
      }
      break;
    }
  } catch (e: any) {
    console.log({ path, error: e?.message ?? String(e) });
  }
}

// Step 6: verify the upload landed in the CCZ.
//
// Build → release → download → unzip → look for the file. Side-effects on
// the test app are limited to (1) one new released build version (cheap, no
// real-world impact on `connect-ace-prod` LEEP — every form-patch probe also
// minted builds) and (2) one tiny 67-byte PNG in multimedia_map at a unique
// timestamped path, which is purely additive.
if (foundJrPath && foundFilename && process.env.SKIP_CCZ_VERIFY !== '1') {
  console.log('\n## Step 6: Verifying upload landed in CCZ');
  const releasesUrl = `${HQ}/a/${DOMAIN}/apps/view/${APP_ID}/releases/`;
  await ctx.request.get(releasesUrl);
  const tok2 = await csrf();

  console.log('  Making build...');
  const buildRes = await ctx.request.post(
    `${HQ}/a/${DOMAIN}/apps/save/${APP_ID}/`,
    {
      data: 'comment=' + encodeURIComponent('probe-multimedia-upload verification build'),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-CSRFToken': tok2,
        Referer: releasesUrl,
      },
      maxRedirects: 0,
    },
  );
  console.log(`  build status=${buildRes.status()}`);
  const buildBody = await buildRes.text();
  let newBuildId: string | undefined;
  try {
    const buildParsed = JSON.parse(buildBody);
    newBuildId =
      buildParsed.saved_app?._id ?? buildParsed._id ?? buildParsed.id;
    console.log(`  new build_id=${newBuildId}  version=${buildParsed.saved_app?.version ?? buildParsed.version}`);
  } catch {
    console.log(`  build body non-JSON: ${buildBody.slice(0, 300)}`);
  }

  if (newBuildId) {
    console.log('  Releasing build...');
    const relRes = await ctx.request.post(
      `${HQ}/a/${DOMAIN}/apps/view/${APP_ID}/releases/release/${newBuildId}/`,
      {
        data: 'ajax=true&is_released=true',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-CSRFToken': tok2,
          Referer: releasesUrl,
        },
        maxRedirects: 0,
      },
    );
    console.log(`  release status=${relRes.status()}`);

    console.log('  Downloading CCZ...');
    const cczRes = await ctx.request.get(
      `${HQ}/a/${DOMAIN}/apps/api/download_ccz/?app_id=${APP_ID}&latest=release`,
    );
    console.log(`  ccz status=${cczRes.status()}`);
    const cczBuf = await cczRes.body();
    console.log(`  ccz size=${cczBuf.byteLength}`);

    const entries = unzipSync(new Uint8Array(cczBuf));
    const candidateCczPaths = [
      `commcare/image/${foundFilename}`,                          // expected: jr://file/commcare/image/<f> -> commcare/image/<f>
      `commcare/multimedia/image/${foundFilename}`,               // task-brief expectation
      foundJrPath.replace(/^jr:\/\/file\//, ''),                  // generic translation
    ];
    let matched: string | null = null;
    for (const cand of candidateCczPaths) {
      if (entries[cand]) {
        matched = cand;
        break;
      }
    }
    if (matched) {
      console.log(`  ✅ FILE FOUND IN CCZ at: ${matched}  size=${entries[matched].length}`);
    } else {
      console.log(`  ❌ Filename '${foundFilename}' NOT found at expected paths.`);
      const allMatching = Object.keys(entries).filter((n) => n.includes(foundFilename!));
      console.log(`  Other CCZ entries containing the filename: ${JSON.stringify(allMatching)}`);
      // Dump all non-XML entries (media payloads) to characterize the CCZ shape
      const nonXml = Object.keys(entries).filter((n) => !n.endsWith('.xml') && !n.endsWith('.txt'));
      console.log(`  All non-XML/non-TXT CCZ entries (potential media): ${JSON.stringify(nonXml.slice(0, 50))}`);
      const allEntries = Object.keys(entries);
      console.log(`  Total CCZ entries: ${allEntries.length}`);
      console.log(`  First 30 entries: ${JSON.stringify(allEntries.slice(0, 30))}`);

      // Hypothesis: CCHQ only bundles multimedia that's REFERENCED by a form
      // (i.e. present in app.multimedia_map AND consumed by some XForm
      // <output value="jr://file/commcare/image/x.png"/> or similar). An
      // unreferenced upload sits in the multimedia map but is NOT pruned
      // into the CCZ. Check the raw multimedia_map via the suite/profile.
      console.log('\n  Checking multimedia_map for the uploaded path...');
      const ajaxRes = await ctx.request.get(
        `${HQ}/a/${DOMAIN}/apps/view/${APP_ID}/multimedia_ajax/`,
      );
      const ajaxBody = await ajaxRes.text();
      const inMap = ajaxBody.includes(foundFilename!) || ajaxBody.includes(foundUid!);
      console.log(`  multimedia_ajax mentions our filename/uid? ${inMap}`);
      if (inMap) {
        const idx = ajaxBody.indexOf(foundFilename!);
        const start = Math.max(0, idx - 100);
        console.log(`  context: ${ajaxBody.slice(start, idx + 200)}`);
      }
    }
  }
}

console.log('\n## SUMMARY');
console.log(`  endpoint: /a/${DOMAIN}/apps/${APP_ID}/multimedia/uploaded/image/`);
console.log(`  m_id (multimedia_id): ${foundMId}`);
console.log(`  uid (md5 hex):        ${foundUid}`);
console.log(`  jr:// path:           ${foundJrPath}`);

await browser.close();
