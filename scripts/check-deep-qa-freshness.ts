/**
 * check-deep-qa-freshness.ts — advisory freshness check for the Phase 6
 * deep-QA gate. Mirrors (a subset of) the gate enforced by
 * `skills/llo-launch/SKILL.md` § Step 4.
 *
 * Usage:
 *   npx tsx scripts/check-deep-qa-freshness.ts <opp-name>
 *
 * Drives the doctor's `deep-qa-freshness <opp>` sub-command. Reads the opp's
 * newest run folder and verifies:
 *
 *   1. `verdicts/ocs-chatbot-eval-deep.yaml` exists and `verdict: pass`.
 *   2. `verdicts/app-ux-eval-deep.yaml` exists and `verdict: pass`.
 *   3. The app verdict's `artifact_refs.{learn_build_id, deliver_build_id}`
 *      match the latest entries in `deployment-summary.md`'s `releases:`
 *      block. If either app has been re-released since the verdict was
 *      written, the screenshots that grounded the eval are stale.
 *
 * What this does NOT check (deferred to the live gate):
 *   - OCS chatbot `version_number` freshness — requires a live OCS API
 *     call (`ocs_get_chatbot`); the verdict's recorded `version_number`
 *     is reported as INFO so the operator sees what the gate will compare.
 *
 * Exit codes:
 *   0 — both verdicts present + pass + app build IDs match deployment-summary
 *   1 — at least one WARN (missing, fail, or stale)
 *   2 — harness error (no opp, no Drive root, no run found, etc.)
 *
 * The doctor surfaces output as WARN-level (advisory). The actual
 * blocker lives in `llo-launch`'s Step 4 — this script is the
 * preventer that gives operators a heads-up before they hit the gate.
 */

import { google } from 'googleapis';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import yaml from 'yaml';
import { resolvePluginDataDir } from '../lib/plugin-data-dir.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEGACY_KEY_PATH = path.join(PROJECT_ROOT, '.gws-sa-key.json');

function resolveKeyPath(): string {
  const envPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (envPath && fs.existsSync(envPath)) return envPath;
  const dataDir = resolvePluginDataDir(import.meta.url);
  if (dataDir) {
    const dataKey = path.join(dataDir, 'gws-sa-key.json');
    if (fs.existsSync(dataKey)) return dataKey;
  }
  const homeDataKey = path.join(
    process.env.HOME || '',
    '.claude', 'plugins', 'data', 'ace-ace', 'gws-sa-key.json',
  );
  if (fs.existsSync(homeDataKey)) return homeDataKey;
  if (fs.existsSync(LEGACY_KEY_PATH)) return LEGACY_KEY_PATH;
  throw new Error('No Google service-account key found.');
}

function loadEnv() {
  const dataDir = resolvePluginDataDir(import.meta.url);
  if (dataDir) {
    const p = path.join(dataDir, '.env');
    if (fs.existsSync(p)) dotenv.config({ path: p, override: false });
  }
  const homeDataEnv = path.join(
    process.env.HOME || '',
    '.claude', 'plugins', 'data', 'ace-ace', '.env',
  );
  if (fs.existsSync(homeDataEnv)) dotenv.config({ path: homeDataEnv, override: false });
  const legacy = path.join(PROJECT_ROOT, '.env');
  if (fs.existsSync(legacy)) dotenv.config({ path: legacy, override: false });
}

async function findChild(
  drive: ReturnType<typeof google.drive>,
  parentId: string,
  name: string,
): Promise<{ id: string; mimeType: string } | null> {
  const resp = await drive.files.list({
    q: `'${parentId}' in parents and name = '${name.replace(/'/g, "\\'")}' and trashed = false`,
    fields: 'files(id, name, mimeType)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  const files = resp.data.files || [];
  if (!files.length) return null;
  const f = files[0];
  return { id: f.id!, mimeType: f.mimeType! };
}

async function listFolder(drive: ReturnType<typeof google.drive>, folderId: string) {
  const resp = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false`,
    fields: 'files(id, name, mimeType)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    pageSize: 100,
  });
  return resp.data.files || [];
}

async function readDocText(
  drive: ReturnType<typeof google.drive>,
  file: { id: string; mimeType: string },
): Promise<string> {
  if (file.mimeType === 'application/vnd.google-apps.document') {
    const resp = await drive.files.export(
      { fileId: file.id, mimeType: 'text/plain' },
      { responseType: 'text' },
    );
    return resp.data as unknown as string;
  }
  const resp = await drive.files.get(
    { fileId: file.id, alt: 'media', supportsAllDrives: true },
    { responseType: 'text' },
  );
  return resp.data as unknown as string;
}

async function findNewestRunFolder(
  drive: ReturnType<typeof google.drive>,
  oppFolderId: string,
): Promise<{ id: string; name: string } | null> {
  const runs = await findChild(drive, oppFolderId, 'runs');
  if (!runs || runs.mimeType !== 'application/vnd.google-apps.folder') return null;
  const runFolders = (await listFolder(drive, runs.id))
    .filter((f) => f.mimeType === 'application/vnd.google-apps.folder')
    .sort((a, b) => (b.name || '').localeCompare(a.name || ''));
  if (runFolders.length === 0) return null;
  return { id: runFolders[0].id!, name: runFolders[0].name! };
}

interface VerdictReport {
  present: boolean;
  passed: boolean;
  fresh?: boolean;
  staleDetail?: string;
  raw?: any;
  via?: string;
}

async function readVerdict(
  drive: ReturnType<typeof google.drive>,
  verdictsFolderId: string,
  filename: string,
): Promise<VerdictReport> {
  const f = await findChild(drive, verdictsFolderId, filename);
  if (!f) return { present: false, passed: false };
  const text = await readDocText(drive, f);
  let parsed: any = null;
  try {
    parsed = yaml.parse(text);
  } catch {
    return { present: true, passed: false };
  }
  const passed = parsed && parsed.verdict === 'pass';
  return { present: true, passed: !!passed, raw: parsed, via: filename };
}

function parseDeploymentSummary(text: string): {
  learnBuildId?: string;
  deliverBuildId?: string;
} {
  // deployment-summary.md is markdown with an embedded `releases:` block.
  // The block can be in YAML frontmatter or a fenced YAML block. Be permissive:
  // pull every `build_id:` near `learn_app:` or `deliver_app:` keys.
  const out: { learnBuildId?: string; deliverBuildId?: string } = {};
  // Try to find the `releases:` block — it lives either at the top of the
  // file or inside a fenced ```yaml block. Match either.
  const releasesBlockRe =
    /releases:\s*\n([\s\S]+?)(?=\n[a-z_]+:\s*$|\n```|\n## |$)/im;
  const m = text.match(releasesBlockRe);
  const block = m ? m[1] : text;
  // learn_app first
  const learnRe = /learn_app:\s*(?:\n\s+)?\{?[^}]*build_id:\s*([0-9a-fA-F-]+)/m;
  const deliverRe =
    /deliver_app:\s*(?:\n\s+)?\{?[^}]*build_id:\s*([0-9a-fA-F-]+)/m;
  const lm = block.match(learnRe);
  if (lm) out.learnBuildId = lm[1];
  const dm = block.match(deliverRe);
  if (dm) out.deliverBuildId = dm[1];
  return out;
}

async function main() {
  loadEnv();

  const opp = process.argv[2];
  if (!opp) {
    console.error('usage: check-deep-qa-freshness.ts <opp-name>');
    process.exit(2);
  }

  const aceRootId = process.env.ACE_DRIVE_ROOT_FOLDER_ID;
  if (!aceRootId) {
    console.error('FAIL: ACE_DRIVE_ROOT_FOLDER_ID env var not set.');
    process.exit(2);
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: resolveKeyPath(),
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  const drive = google.drive({ version: 'v3', auth });

  console.log(`INFO opp=${opp} ace_root=${aceRootId}`);

  const oppFolder = await findChild(drive, aceRootId, opp);
  if (!oppFolder || oppFolder.mimeType !== 'application/vnd.google-apps.folder') {
    console.error(`FAIL: opp folder "${opp}" not found under ACE/`);
    process.exit(2);
  }

  const run = await findNewestRunFolder(drive, oppFolder.id);
  if (!run) {
    console.log(`INFO no runs/<run-id>/ folder under ACE/${opp}/ — deep QA gate not yet reachable`);
    process.exit(0);
  }
  console.log(`INFO newest_run=runs/${run.name}`);

  const verdictsFolder = await findChild(drive, run.id, 'verdicts');
  let issues = 0;

  if (!verdictsFolder) {
    console.log(`WARN runs/${run.name}/verdicts/ folder missing — neither deep verdict has been written`);
    console.log(`  fix: run /ace:qa-deep ${opp} before /ace:step llo-launch ${opp}`);
    process.exit(1);
  }

  // OCS verdict
  const ocs = await readVerdict(drive, verdictsFolder.id, 'ocs-chatbot-eval-deep.yaml');
  if (!ocs.present) {
    console.log('WARN ocs-chatbot-eval-deep.yaml missing');
    console.log(`  fix: /ace:qa-deep ${opp} (or /ace:qa-deep ${opp} --ocs-only)`);
    issues++;
  } else if (!ocs.passed) {
    const status = ocs.raw && ocs.raw.verdict ? `verdict=${ocs.raw.verdict}` : 'unparseable';
    console.log(`WARN ocs-chatbot-eval-deep.yaml ${status}`);
    console.log(`  fix: re-publish chatbot, then /ace:qa-deep ${opp} --ocs-only`);
    issues++;
  } else {
    const v = ocs.raw?.artifact_refs?.version_number;
    const target = ocs.raw?.target;
    const meta = [
      target ? `target=${target}` : '',
      v != null ? `version_number=${v}` : 'version_number=<missing>',
    ].filter(Boolean).join(' ');
    console.log(`PASS ocs-chatbot-eval-deep.yaml ${meta} (live freshness vs OCS chatbot is checked at the gate)`);
  }

  // App verdict + freshness vs deployment-summary.md
  const app = await readVerdict(drive, verdictsFolder.id, 'app-ux-eval-deep.yaml');
  if (!app.present) {
    console.log('WARN app-ux-eval-deep.yaml missing');
    console.log(`  fix: /ace:qa-deep ${opp} (or /ace:qa-deep ${opp} --apps-only)`);
    issues++;
  } else if (!app.passed) {
    const status = app.raw && app.raw.verdict ? `verdict=${app.raw.verdict}` : 'unparseable';
    console.log(`WARN app-ux-eval-deep.yaml ${status}`);
    console.log(`  fix: address per_item failures and re-run /ace:qa-deep ${opp} --apps-only`);
    issues++;
  } else {
    // Compare verdict.artifact_refs.{learn,deliver}_build_id against
    // deployment-summary.md's latest releases block.
    const verdictLearn = app.raw?.artifact_refs?.learn_build_id;
    const verdictDeliver = app.raw?.artifact_refs?.deliver_build_id;

    let summary: { learnBuildId?: string; deliverBuildId?: string } = {};
    const summaryFile = await findChild(drive, oppFolder.id, 'deployment-summary.md');
    if (!summaryFile) {
      console.log('WARN app-ux-eval-deep.yaml: deployment-summary.md not found — cannot verify build-ID freshness');
      console.log('  fix: ensure Phase 2 deployment-summary.md is present; the gate will require it too');
      issues++;
    } else {
      const text = await readDocText(drive, summaryFile);
      summary = parseDeploymentSummary(text);
      const stale: string[] = [];
      if (verdictLearn && summary.learnBuildId && verdictLearn !== summary.learnBuildId) {
        stale.push(`learn (verdict=${verdictLearn}, current=${summary.learnBuildId})`);
      }
      if (verdictDeliver && summary.deliverBuildId && verdictDeliver !== summary.deliverBuildId) {
        stale.push(`deliver (verdict=${verdictDeliver}, current=${summary.deliverBuildId})`);
      }
      if (stale.length) {
        console.log(`WARN app-ux-eval-deep.yaml stale: ${stale.join('; ')}`);
        console.log(`  fix: /ace:qa-deep ${opp} --apps-only`);
        issues++;
      } else {
        const meta = [
          verdictLearn ? `learn=${verdictLearn}` : '',
          verdictDeliver ? `deliver=${verdictDeliver}` : '',
        ].filter(Boolean).join(' ');
        console.log(`PASS app-ux-eval-deep.yaml ${meta}`);
      }
    }
  }

  console.log('');
  if (issues === 0) {
    console.log('STATUS: deep-qa-freshness OK (Phase 6 gate will pass)');
    process.exit(0);
  } else {
    console.log(`STATUS: deep-qa-freshness has ${issues} WARN(s) (Phase 6 gate will halt — run /ace:qa-deep)`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('HARNESS ERROR:', e);
  process.exit(2);
});
