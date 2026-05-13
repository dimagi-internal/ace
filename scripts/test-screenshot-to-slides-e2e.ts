/**
 * The actual end-to-end demo:
 *   1. Run a tiny Maestro recipe against the AVD that captures a screenshot
 *      of CommCare's home screen
 *   2. Upload the PNG to Drive (the per-opp screenshot folder shape)
 *   3. Build a deck-outline.md that references the screenshot via drive:fileId
 *   4. Run training-deck-build (parse → copy template → batchUpdate +
 *      createImage with the real screenshot)
 *   5. Verify the resulting Slides deck contains a slide with the real PNG
 *
 * This is the missing demo — proves the Phase 6 chain
 *   AVD → Maestro → screenshot PNG → Drive upload → deck-outline.md →
 *   Slides deck with real per-opp screenshots
 * actually works on real device output, not synthetic content.
 *
 * Prerequisites:
 *   - AVD ACE_Pixel_API_34 booted (mobile_ensure_avd_running)
 *   - CommCare 2.62.0 installed (mobile-bootstrap step 5)
 *   - ACE_TRAINING_DECK_TEMPLATE_ID set (Slides template exists)
 */
import { google } from '../lib/google-shim.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  parseDeckOutline,
  buildSlidesRequests,
  buildSpeakerNotesRequests,
  STENCIL_TITLE_OBJECT_ID,
  STENCIL_CONTENT_OBJECT_ID,
} from '../lib/training-deck-spec.js';

const KEY_FILE = `${process.env.HOME}/.claude/plugins/data/ace-ace/gws-sa-key.json`;

function loadEnvFile(envPath: string): void {
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

function shell(cmd: string, args: string[], opts: { env?: Record<string, string>; cwd?: string } = {}): { stdout: string; stderr: string; code: number } {
  const r = spawnSync(cmd, args, {
    env: { ...process.env, ...(opts.env ?? {}) },
    cwd: opts.cwd,
    encoding: 'utf8',
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? -1 };
}

async function main() {
  loadEnvFile(`${process.env.HOME}/.claude/plugins/data/ace-ace/.env`);
  const parentFolderId = process.env.ACE_DRIVE_ROOT_FOLDER_ID!;
  const templateId = process.env.ACE_TRAINING_DECK_TEMPLATE_ID;
  if (!templateId) throw new Error('ACE_TRAINING_DECK_TEMPLATE_ID not set');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const oppName = `screenshot-e2e-${stamp}`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `ace-e2e-${stamp}-`));
  console.log(`tmp dir: ${tmpDir}`);
  console.log(`opp: ${oppName}`);

  // ── PHASE 1: capture a real screenshot from the AVD via Maestro ──
  console.log('\n[1/5] Run Maestro recipe to capture CommCare home-screen PNG');

  // Minimal recipe: launch CommCare and take a screenshot. The
  // takeScreenshot step writes to <cwd>/<name>.png; MaestroBackend
  // sets cwd to screenshotDir, so this lands at $tmpDir/commcare-home.png.
  const recipePath = path.join(tmpDir, 'home-screenshot.yaml');
  fs.writeFileSync(
    recipePath,
    `appId: org.commcare.dalvik
---
- launchApp:
    appId: org.commcare.dalvik
    clearState: false
- waitForAnimationToEnd:
    timeout: 5000
- takeScreenshot: commcare-home
`,
  );

  // Use the patched dadb-direct path — same code path mobile_run_recipe takes
  // when avdName is set. Hardcoding emulator-5558 + adbd port 5559 since this
  // smoke is on a known machine.
  const javaHome = '/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home';
  const androidHome = '/opt/homebrew/share/android-commandlinetools';
  const maestroBin = `${process.env.HOME}/.maestro/bin/maestro`;
  const recipeRun = shell(maestroBin, [
    '--host=localhost',
    '--port=5559',
    'test',
    '--no-ansi',
    recipePath,
  ], {
    env: {
      JAVA_HOME: javaHome,
      ANDROID_HOME: androidHome,
      PATH: `${javaHome}/bin:${androidHome}/platform-tools:${androidHome}/emulator:${process.env.PATH}`,
    },
    cwd: tmpDir,
  });

  if (recipeRun.code !== 0) {
    console.error('Maestro recipe failed:');
    console.error(recipeRun.stdout);
    console.error(recipeRun.stderr);
    throw new Error(`maestro test exit code ${recipeRun.code}`);
  }
  const screenshotPath = path.join(tmpDir, 'commcare-home.png');
  if (!fs.existsSync(screenshotPath)) {
    console.error('Maestro reported success but PNG missing at:', screenshotPath);
    console.error('tmp dir contents:', fs.readdirSync(tmpDir));
    throw new Error('screenshot file missing after Maestro run');
  }
  console.log(`  ✓ PNG captured: ${screenshotPath} (${fs.statSync(screenshotPath).size} bytes)`);

  // ── PHASE 2: upload PNG to Drive in the per-opp screenshot folder shape ──
  console.log('\n[2/5] Upload screenshot to Drive');
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes: [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/presentations',
    ],
  });
  const drive = google.drive({ version: 'v3', auth });
  const slides = google.slides({ version: 'v1', auth });

  // Create per-opp folder + per-opp screenshots subfolder
  const oppFolder = await drive.files.create({
    requestBody: {
      name: oppName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentFolderId],
    },
    fields: 'id',
    supportsAllDrives: true,
  });
  const screenshotFolder = await drive.files.create({
    requestBody: {
      name: 'screenshots',
      mimeType: 'application/vnd.google-apps.folder',
      parents: [oppFolder.data.id!],
    },
    fields: 'id',
    supportsAllDrives: true,
  });
  const upload = await drive.files.create({
    requestBody: {
      name: 'commcare-home.png',
      parents: [screenshotFolder.data.id!],
    },
    media: { mimeType: 'image/png', body: fs.createReadStream(screenshotPath) },
    fields: 'id, name, webViewLink',
    supportsAllDrives: true,
  });
  const screenshotFileId = upload.data.id!;
  console.log(`  ✓ uploaded: ${screenshotFileId} (${upload.data.webViewLink})`);

  // The created PNG needs to be readable by anyone-with-link so Slides
  // can fetch it during createImage. Anyone-with-link is the Slides
  // contract — without it, createImage returns "image cannot be reached".
  await drive.permissions.create({
    fileId: screenshotFileId,
    requestBody: { role: 'reader', type: 'anyone' },
    supportsAllDrives: true,
  });
  console.log('  ✓ screenshot shared anyone-with-link (for Slides createImage)');

  // ── PHASE 3: write a deck-outline.md that references the real PNG ──
  console.log('\n[3/5] Compose deck-outline.md referencing the real fileId');
  const deckOutline = `# Screenshot E2E Smoke (${stamp})

Proves screenshot → Slides loop end-to-end on real device output.

---

## Slide: CommCare home screen

This is a real screenshot captured from the ACE AVD via Maestro. It
proves the full pipeline:

- AVD → Maestro recipe → PNG file
- Drive upload via service account
- Anyone-with-link permission so Slides can embed it
- training-deck-spec parses drive:<fileId> and emits createImage

![CommCare home](drive:${screenshotFileId})

> Speaker notes: If you see a real screenshot above this, the pipeline works end-to-end on real device output, not synthetic content.
`;

  // ── PHASE 4: parse + build Slides batch + render ──
  console.log('\n[4/5] parseDeckOutline + buildSlidesRequests + Slides API');
  const spec = parseDeckOutline(deckOutline);
  console.log(`  parsed: title="${spec.title}" slides=${spec.slides.length} (image refs: ${spec.slides.flatMap(s => s.body.filter(b => b.kind === 'image')).length})`);

  const { mainRequests, speakerNotes } = buildSlidesRequests(spec, {
    stencils: { title: STENCIL_TITLE_OBJECT_ID, content: STENCIL_CONTENT_OBJECT_ID },
  });
  console.log(`  built: mainRequests=${mainRequests.length} speakerNotes=${speakerNotes.length}`);

  const deckCopy = await drive.files.copy({
    fileId: templateId,
    requestBody: { name: `Screenshot E2E Deck (${stamp})`, parents: [oppFolder.data.id!] },
    fields: 'id, webViewLink',
    supportsAllDrives: true,
  });
  const presentationId = deckCopy.data.id!;
  console.log(`  copied template → ${presentationId}`);

  const mainResp = await slides.presentations.batchUpdate({
    presentationId,
    requestBody: { requests: mainRequests as any[] },
  });
  console.log(`  main batchUpdate replies: ${mainResp.data.replies?.length}`);

  const getResp = await slides.presentations.get({ presentationId });
  const notesByObjectId: Record<string, string> = {};
  for (const slide of getResp.data.slides ?? []) {
    const id = slide.objectId!;
    const notesId = slide.slideProperties?.notesPage?.notesProperties?.speakerNotesObjectId;
    if (notesId) notesByObjectId[id] = notesId;
  }
  if (speakerNotes.length > 0) {
    const notesRequests = buildSpeakerNotesRequests(speakerNotes, notesByObjectId);
    await slides.presentations.batchUpdate({
      presentationId,
      requestBody: { requests: notesRequests as any[] },
    });
    console.log(`  speaker-notes batchUpdate: ${notesRequests.length}`);
  }

  // ── PHASE 5: verify the deck contains a slide with the embedded image ──
  console.log('\n[5/5] Verify the deck has a slide containing an embedded image');
  const verifyResp = await slides.presentations.get({ presentationId });
  let imageCount = 0;
  for (const slide of verifyResp.data.slides ?? []) {
    for (const el of slide.pageElements ?? []) {
      if (el.image) imageCount++;
    }
  }
  if (imageCount === 0) {
    throw new Error('Deck has zero embedded images — createImage didn\'t take');
  }
  console.log(`  ✓ deck contains ${imageCount} embedded image(s)`);

  console.log(`\n✓ Screenshot → Slides end-to-end PROVEN on real device output.`);
  console.log(`  Open: ${deckCopy.data.webViewLink}`);
  console.log(`  Per-opp folder: https://drive.google.com/drive/folders/${oppFolder.data.id}`);
}

main().catch((e: any) => {
  console.error('\n✗ FAILED:', e.message);
  if (e.response?.data) console.error('  response:', JSON.stringify(e.response.data, null, 2));
  process.exit(1);
});
