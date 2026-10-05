#!/usr/bin/env -S npx tsx
/**
 * Bind a real frame to every screen slide of a training-deck spec — READ-ONLY
 * against Drive; writes local files only.
 *
 *   npx tsx scripts/bind-deck-frames.ts \
 *     --spec <local training-deck-spec.yaml> \
 *     --run-folder <Drive folder id of ACE/<opp>/runs/<run-id>> \
 *     --out <bound-spec.yaml> --report <report.json> \
 *     [--stats-out <frame-stats.json>] [--stats-cache <frame-stats.json>] \
 *     [--reject <step>[,<step>…]] [--crops-dir <dir>] [--key <sa-key.json>]
 *
 * What it reads, all through the Drive service account:
 *   1. `run_state.yaml` of the run, then of each run up its `forked_from`
 *      chain (`walkForkLineage`) — a fork's frames live in its source run;
 *   2. each run's `6-qa-and-training/app-screenshot-capture_manifest.yaml`
 *      and every `3-commcare/previews/<app>/_previews.yaml`;
 *   3. the PNG of every frame in a product surface, measured with
 *      `lib/frame-pixels.ts` (pass `--stats-cache` to skip re-downloading).
 *
 *   4. the PNG of every frame that shows the Phase 4 opportunity's run-id
 *      title at the top (`oppTitleExposure`, lib/opp-title-frames.ts), to find
 *      the row below that title (`belowTitleCropTop`) — ace#2660.
 *
 * Then `bindDeckFrames` + `checkDeckScreenBacking` (lib/training-deck-frames.ts).
 * Each crop the binder chose (`report.crops`) is written as a PNG under
 * `--crops-dir` (default: `<dir of --out>/crops/`): the source frame's rows
 * from the cut down, copied unchanged — nothing else about the pixels changes.
 * training-deck-generate step 9b uploads them and sets `manifest.opp`.
 * Exit 0 = bound spec written and the gate passes; 1 = the gate still fails
 * (the report names each slide); 2 = usage / read error.
 *
 * It never writes to Drive: `training-deck-generate` uploads the bound spec
 * with its normal `drive_create_file` step.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import yaml from 'js-yaml';
import { google } from '../lib/google-shim.js';
import { resolvePluginDataDir } from '../lib/plugin-data-dir.js';
import { loadPluginEnv } from '../lib/load-plugin-env.js';
import { parseTrainingSpec, type TrainingDeckSpec } from '../lib/training-deck-spec.js';
import { decodePng, measureFrame, type FrameStats, type Raster } from '../lib/frame-pixels.js';
import { belowTitleCropTop, cropRasterTop, encodePng, oppTitleExposure } from '../lib/opp-title-frames.js';
import {
  bindDeckFrames,
  buildFramePool,
  checkDeckScreenBacking,
  walkForkLineage,
  type FrameSource,
  type PreviewsIndexLike,
} from '../lib/training-deck-frames.js';
import type { CaptureManifestLike } from '../lib/capture-manifest.js';

loadPluginEnv(import.meta.url);

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

function keyFile(): string {
  const cli = arg('key');
  if (cli && fs.existsSync(cli)) return cli;
  const env = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (env && fs.existsSync(env)) return env;
  const data = resolvePluginDataDir(import.meta.url);
  const p = data ? path.join(data, 'gws-sa-key.json') : '';
  if (p && fs.existsSync(p)) return p;
  const conventional = path.join(os.homedir(), '.claude', 'plugins', 'data', 'ace-ace', 'gws-sa-key.json');
  if (fs.existsSync(conventional)) return conventional;
  throw new Error('no Drive service-account key (gws-sa-key.json) — run /ace:setup or pass --key');
}

async function main(): Promise<number> {
  const specPath = arg('spec');
  const runFolder = arg('run-folder');
  const out = arg('out');
  const reportPath = arg('report');
  if (!specPath || !runFolder || !out || !reportPath) {
    process.stderr.write('bind-deck-frames: --spec, --run-folder, --out and --report are required\n');
    return 2;
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: keyFile(),
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
  const drive = google.drive({ version: 'v3', auth });

  const children = async (folderId: string) => {
    const files: Array<{ id: string; name: string; mimeType: string }> = [];
    let pageToken: string | undefined;
    do {
      const r: any = await drive.files.list({
        q: `'${folderId}' in parents and trashed=false`,
        fields: 'nextPageToken, files(id,name,mimeType)',
        pageSize: 1000,
        pageToken,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      files.push(...r.data.files);
      pageToken = r.data.nextPageToken ?? undefined;
    } while (pageToken);
    return files;
  };
  const child = async (folderId: string, name: string) => (await children(folderId)).find((f) => f.name === name);
  const readText = async (fileId: string, mimeType: string): Promise<string> => {
    const res: any = mimeType.startsWith('application/vnd.google-apps')
      ? await drive.files.export({ fileId, mimeType: 'text/plain' }, { responseType: 'arraybuffer' })
      : await drive.files.get({ fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' });
    return Buffer.from(res.data).toString('utf8');
  };
  const readYaml = async (folderId: string, ...segments: string[]): Promise<unknown | null> => {
    let cursor = folderId;
    for (let i = 0; i < segments.length; i++) {
      const hit = await child(cursor, segments[i]);
      if (!hit) return null;
      if (i === segments.length - 1) return yaml.load(await readText(hit.id, hit.mimeType));
      cursor = hit.id;
    }
    return null;
  };

  // The run folder's parent is `runs/`; every run of the lineage is a sibling.
  const meta: any = await drive.files.get({ fileId: runFolder, fields: 'name,parents', supportsAllDrives: true });
  const runId: string = meta.data.name;
  const runsFolder: string | undefined = meta.data.parents?.[0];
  const runFolderOf = new Map<string, string>([[runId, runFolder]]);
  const folderFor = async (id: string): Promise<string | undefined> => {
    if (runFolderOf.has(id)) return runFolderOf.get(id);
    if (!runsFolder) return undefined;
    const hit = await child(runsFolder, id);
    if (hit) runFolderOf.set(id, hit.id);
    return hit?.id;
  };

  const lineage = await walkForkLineage(runId, async (id) => {
    const folder = await folderFor(id);
    return folder ? readYaml(folder, 'run_state.yaml') : null;
  });

  const sources: FrameSource[] = [];
  for (const id of lineage) {
    const folder = await folderFor(id);
    if (!folder) continue;
    const manifest = (await readYaml(folder, '6-qa-and-training', 'app-screenshot-capture_manifest.yaml')) as CaptureManifestLike | null;
    const previews: PreviewsIndexLike[] = [];
    const previewsRoot = await (async () => {
      const commcare = await child(folder, '3-commcare');
      return commcare ? child(commcare.id, 'previews') : undefined;
    })();
    if (previewsRoot) {
      for (const out of await children(previewsRoot.id)) {
        if (!out.mimeType.endsWith('folder')) continue;
        const idx = await readYaml(out.id, '_previews.yaml');
        if (idx && typeof idx === 'object') previews.push(idx as PreviewsIndexLike);
      }
    }
    sources.push({ run_id: id, manifest, previews });
  }

  const spec: TrainingDeckSpec = parseTrainingSpec(fs.readFileSync(specPath, 'utf8'));
  const pool = buildFramePool({ specManifest: spec.manifest, sources });

  const statsCachePath = arg('stats-cache');
  const stats = new Map<string, FrameStats>(
    statsCachePath && fs.existsSync(statsCachePath)
      ? Object.entries(JSON.parse(fs.readFileSync(statsCachePath, 'utf8')) as Record<string, FrameStats>)
      : [],
  );
  for (const f of pool) {
    if (f.surface === 'other' || stats.has(f.file_id) || f.duplicate_of) continue;
    try {
      const res: any = await drive.files.get({ fileId: f.file_id, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' });
      stats.set(f.file_id, measureFrame(decodePng(new Uint8Array(res.data))));
    } catch (e) {
      // An unreadable frame is judged on its step name and shows: alone.
      process.stderr.write(`  could not measure ${f.alias} (${f.file_id}): ${(e as Error).message}\n`);
    }
  }
  // ace#2660: where to cut a frame that shows the run-id-prefixed title.
  const rasters = new Map<string, Raster>();
  const cropTops = new Map<string, number | null>();
  for (const f of pool) {
    if (oppTitleExposure(f) !== 'top' || f.duplicate_of) continue;
    try {
      const res: any = await drive.files.get({ fileId: f.file_id, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' });
      const r = decodePng(new Uint8Array(res.data));
      rasters.set(f.file_id, r);
      cropTops.set(f.file_id, belowTitleCropTop(r));
    } catch (e) {
      process.stderr.write(`  could not read ${f.alias} for a crop (${f.file_id}): ${(e as Error).message}\n`);
    }
  }

  const statsOut = arg('stats-out');
  if (statsOut) fs.writeFileSync(statsOut, JSON.stringify(Object.fromEntries(stats), null, 1));

  const reject = new Set((arg('reject') ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  const { spec: bound, report } = bindDeckFrames(spec, { pool, stats, reject, cropTops });

  const cropsDir = arg('crops-dir') ?? path.join(path.dirname(path.resolve(out)), 'crops');
  const cropFiles: Record<string, string> = {};
  for (const c of report.crops) {
    const r = rasters.get(c.from_file_id);
    if (!r) continue;
    fs.mkdirSync(cropsDir, { recursive: true });
    const file = path.join(cropsDir, `${c.alias}.png`);
    fs.writeFileSync(file, encodePng(cropRasterTop(r, c.top)));
    cropFiles[c.alias] = file;
  }
  const gate = checkDeckScreenBacking(bound, { pool, stats });

  fs.writeFileSync(out, yaml.dump(bound, { lineWidth: -1, noRefs: true }));
  // Round-trip: what we wrote must still be a valid spec.
  parseTrainingSpec(fs.readFileSync(out, 'utf8'));
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        run: runId, lineage, pool_frames: pool.length, measured: stats.size, ...report,
        crops: report.crops.map((c) => ({ ...c, local_file: cropFiles[c.alias] })),
        gate,
      },
      null,
      2,
    ),
  );

  process.stdout.write(
    `lineage: ${lineage.join(' <- ')}\npool: ${pool.length} frames (${stats.size} measured)\n` +
      `actions: ${report.actions.length}; needs_shows: ${report.needs_shows.join(', ') || 'none'}\n` +
      `crops to upload: ${report.crops.map((c) => cropFiles[c.alias] ?? c.alias).join(', ') || 'none'}\n` +
      `run-id title still visible on: ${report.opp_title_visible.join(', ') || 'none'}\n` +
      `gate: ${gate.pass ? 'PASS' : 'FAIL — ' + gate.detail}\n`,
  );
  return gate.pass ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`bind-deck-frames: ${(e as Error).message}\n`);
    process.exit(2);
  },
);
