/**
 * scripts/migrate-drive-layout.ts
 *
 * Pure planner + read-only CLI dispatcher for the Drive layout migration
 * (Tasks 9-10 of docs/superpowers/plans/2026-05-03-run-folder-readability.md).
 *
 * Walks ACE_DRIVE_ROOT_FOLDER_ID, lists every opp folder and every run
 * under each opp's `runs/` subfolder, computes planned moves per the
 * phase-prefixed `<N>-<phase>/<skill>[_<role>].<ext>` layout, and prints
 * them. Dry-run by default (`--check`); `--apply` is a hard error in
 * this commit (lands in 0.12.0 Tasks 11-12).
 *
 * The planner half (`planMoves`) is unit-testable against a `vi.fn()`-
 * mocked `DriveLike`; the CLI half pulls authenticated Drive credentials
 * from the same chain as `scripts/doctor-drive-layout.ts`.
 *
 * Exit status:
 *   0   — dry-run completed successfully
 *   1   — env / key missing, or live probe failed
 *   2   — `--apply` passed (not yet implemented)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { google } from 'googleapis';
import { resolvePluginDataDir } from '../lib/plugin-data-dir.js';
import { isOppFolder } from '../lib/doctor-drive-layout.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEGACY_KEY_PATH = path.join(PROJECT_ROOT, '.gws-sa-key.json');
const FOLDER_MIME = 'application/vnd.google-apps.folder';

// ── Types ──────────────────────────────────────────────────────────

export interface DriveEntry {
  id: string;
  name: string;
  mimeType: string;
}

export interface DriveLike {
  list: (folderId: string) => Promise<DriveEntry[]>;
}

export type MoveAction = 'move' | 'coalesce-folder' | 'create-shortcut' | 'delete-empty';

export interface PlannedMove {
  fileId: string;
  from: string;
  to: string;
  action: MoveAction;
  runFolderId: string;
}

// ── OLD_TO_NEW mapping ─────────────────────────────────────────────

/**
 * Explicit old-path → new-path table. Keys are paths relative to a run
 * folder root (e.g. `pdd.md`, `verdicts/idea-to-pdd.yaml`); values are
 * the phase-prefixed targets per `lib/artifact-manifest.ts`.
 *
 * Folder-prefix rules (qa-plan/, mobile-recipes/, screenshots/, qa-captures/,
 * monitoring/, data-reviews/, scorecards/) are handled in `computeNewPath`
 * separately — the table here covers exact-match leaves only.
 */
export const OLD_TO_NEW: Record<string, string> = {
  // Design (Phase 1)
  'idea.md': '1-design/idea.md',
  'pdd.md': '1-design/idea-to-pdd.md',
  'test-prompts.md': '1-design/pdd-to-test-prompts.md',
  'gate-briefs/idea-to-pdd.md': '1-design/idea-to-pdd_gate-brief.md',
  'verdicts/idea-to-pdd.yaml': '1-design/idea-to-pdd-eval_verdict.yaml',
  'design-review-summary.md': '1-design/design-review_summary.md',
  // CommCare (Phase 2)
  'app-summaries/learn-app-summary.md': '2-commcare/pdd-to-learn-app_summary.md',
  'app-summaries/deliver-app-summary.md': '2-commcare/pdd-to-deliver-app_summary.md',
  'apps/learn-app.json': '2-commcare/pdd-to-learn-app_snapshot.json',
  'apps/deliver-app.json': '2-commcare/pdd-to-deliver-app_snapshot.json',
  'app-coverage/learn-connect-coverage.md': '2-commcare/app-connect-coverage_learn.md',
  'app-coverage/deliver-connect-coverage.md': '2-commcare/app-connect-coverage_deliver.md',
  'deployment-summary.md': '2-commcare/app-deploy_summary.md',
  'gate-briefs/app-deploy.md': '2-commcare/app-deploy_gate-brief.md',
  'verdicts/pdd-to-learn-app.yaml': '2-commcare/pdd-to-learn-app-eval_verdict.yaml',
  'verdicts/pdd-to-deliver-app.yaml': '2-commcare/pdd-to-deliver-app-eval_verdict.yaml',
  'verdicts/app-release.yaml': '2-commcare/app-release-eval_verdict.yaml',
  'commcare-setup-summary.md': '2-commcare/commcare-setup_summary.md',
  // Connect (Phase 3) — connect-program-setup.md and connect-opp-setup.md ARE
  // run-scoped (one per run), unlike connect-state.yaml (opp-level identity).
  'connect-setup/program.md': '3-connect/connect-program-setup.md',
  'connect-setup/opportunity.md': '3-connect/connect-opp-setup.md',
  'verdicts/connect-program-setup.yaml': '3-connect/connect-program-setup-eval_verdict.yaml',
  'connect-setup-summary.md': '3-connect/connect-setup_summary.md',
  // OCS (Phase 4)
  'ocs-agent-config.md': '4-ocs/ocs-agent-setup.md',
  'ocs-setup/widget-handoff.md': '4-ocs/ocs-setup_widget-handoff.md',
  'verdicts/ocs-chatbot-eval-quick.yaml': '4-ocs/ocs-chatbot-eval_verdict-quick.yaml',
  'verdicts/ocs-chatbot-eval-deep.yaml': '4-ocs/ocs-chatbot-eval_verdict-deep.yaml',
  'verdicts/ocs-agent-setup.yaml': '4-ocs/ocs-widget-handoff-eval_verdict.yaml',
  'gate-briefs/ocs-chatbot-eval-deep.md': '4-ocs/ocs-chatbot-eval_gate-brief-deep.md',
  'comms-log/dry-run-ocs-agent-setup.md': '4-ocs/ocs-agent-setup_dry-run-log.md',
  'ocs-setup-summary.md': '4-ocs/ocs-setup_summary.md',
  // QA + Training (Phase 5)
  'training-materials/llo-manager-guide.md': '5-qa-and-training/training-llo-guide.md',
  'training-materials/flw-training-guide.md': '5-qa-and-training/training-flw-guide.md',
  'training-materials/quick-reference.md': '5-qa-and-training/training-quick-reference.md',
  'training-materials/faq.md': '5-qa-and-training/training-faq.md',
  'training-materials/onboarding-email-body.md': '5-qa-and-training/training-onboarding-email.md',
  'training-materials/training-deck-outline.md': '5-qa-and-training/training-deck-outline.md',
  'screenshots/manifest.yaml': '5-qa-and-training/app-screenshot-capture_manifest.yaml',
  // Self-emitted Phase 5 verdicts (Option β) — verdicts named after producer
  'verdicts/qa-plan.yaml': '5-qa-and-training/qa-plan_verdict.yaml',
  'verdicts/training-deck-build.yaml': '5-qa-and-training/training-deck-build_verdict.yaml',
  'verdicts/training-deck-outline.yaml': '5-qa-and-training/training-deck-outline_verdict.yaml',
  'verdicts/training-faq.yaml': '5-qa-and-training/training-faq_verdict.yaml',
  'verdicts/training-flw-guide.yaml': '5-qa-and-training/training-flw-guide_verdict.yaml',
  'verdicts/training-llo-guide.yaml': '5-qa-and-training/training-llo-guide_verdict.yaml',
  'verdicts/training-onboarding-email.yaml': '5-qa-and-training/training-onboarding-email_verdict.yaml',
  'verdicts/training-quick-reference.yaml': '5-qa-and-training/training-quick-reference_verdict.yaml',
  // LLO Manager (Phase 6) — connect-setup/invites.md goes HERE because llo-invite is now Phase 6
  'connect-setup/invites.md': '6-llo-manager/llo-invite_list.md',
  'gate-briefs/llo-invite.md': '6-llo-manager/llo-invite_gate-brief.md',
  'comms-log/onboarding-emails.md': '6-llo-manager/llo-onboarding_comms-log.md',
  'uat/uat-results.md': '6-llo-manager/llo-uat_results.md',
  'launch/launch-record.md': '6-llo-manager/llo-launch_record.md',
  'gate-briefs/llo-launch.md': '6-llo-manager/llo-launch_gate-brief.md',
  'verdicts/llo-launch.yaml': '6-llo-manager/llo-launch-eval_verdict.yaml',
  'verdicts/flw-data-review-monitor.yaml': '6-llo-manager/flw-data-review-eval_verdict-monitor.yaml',
  'verdicts/ocs-chatbot-eval-monitor.yaml': '6-llo-manager/ocs-chatbot-eval_verdict-monitor.yaml',
  'eval-reports/trend.md': '6-llo-manager/ocs-chatbot-eval_trend.md',
  // app-test outputs (Phase 2). Old shape was a sibling test-results/ folder
  // per skills/app-test/SKILL.md; new shape is nested under 2-commcare/app-test/.
  'test-results/test-plan.md': '2-commcare/app-test/test-plan.md',
  'test-results/test-results.md': '2-commcare/app-test/test-results.md',
  'test-results/bugs.md': '2-commcare/app-test/bugs.md',
  // qa-plan flat outputs (single-level leaves coalesce into _-joined names;
  // walkthrough-recipes/ stays nested via the folder-prefix rule).
  'qa-plan/screenshot-manifest.yaml': '5-qa-and-training/qa-plan_screenshot-manifest.yaml',
  'qa-plan/test-matrix.md': '5-qa-and-training/qa-plan_test-matrix.md',
  'qa-plan/uat-checklist.md': '5-qa-and-training/qa-plan_uat-checklist.md',
  // Closeout (Phase 7)
  'closeout/invoices.md': '7-closeout/opp-closeout_invoices.md',
  'closeout/llo-feedback.md': '7-closeout/llo-feedback.md',
  'closeout/learnings.md': '7-closeout/learnings-summary.md',
  'closeout/new-pdd.md': '7-closeout/learnings-summary_new-pdd.md',
  'closeout/cycle-grade.md': '7-closeout/cycle-grade.md',
  'closeout/final-summary.md': '7-closeout/closeout_summary.md',
  'verdicts/cycle-grade.yaml': '7-closeout/cycle-grade-eval_verdict.yaml',
  'verdicts/opp-eval-deep.yaml': '7-closeout/opp-eval/opp-eval_verdict-deep.yaml',
  'verdicts/opp-eval-monitor.yaml': '7-closeout/opp-eval/opp-eval_verdict-monitor.yaml',
  'gate-briefs/opp-eval-deep.md': '7-closeout/opp-eval/opp-eval_gate-brief-deep.md',
  'scorecards/trend.md': '7-closeout/opp-eval/trend.md',
};

// Run-scoped paths that should NOT move (already in new shape, or
// special-case identity).
const RUN_LEVEL_IDENTITY = new Set<string>([
  'run_state.yaml',
]);

// Files that are dropped wholesale in the new layout — no migration target.
// Detected via prefix match; the planner skips them silently.
const DROPPED_PREFIXES = [
  // Folded into 4-ocs/ocs-chatbot-eval_report-deep.md
  'eval-reports/',
];

// ── Path computation ───────────────────────────────────────────────

/**
 * Compute the new path for a file living at `oldPath` (relative to the
 * run folder root). Returns null when no migration is needed (identity
 * skip OR already-prefixed path) or when the file is a dropped artifact.
 */
function computeNewPath(oldPath: string): string | null {
  // Already in new phase-prefixed shape — `<N>-<phase>/...`
  if (/^\d-[a-z][a-z0-9-]*\//.test(oldPath)) return null;

  // Run-level identity (e.g. run_state.yaml stays at run root)
  if (RUN_LEVEL_IDENTITY.has(oldPath)) return null;

  // Dropped prefixes — no migration target
  for (const drop of DROPPED_PREFIXES) {
    if (oldPath === drop || oldPath.startsWith(drop)) {
      // eval-reports/trend.md is mapped explicitly above; everything else under
      // eval-reports/ is dated YYYY-MM-DD-ocs-eval.md and gets dropped.
      if (OLD_TO_NEW[oldPath]) return OLD_TO_NEW[oldPath];
      return null;
    }
  }

  // Exact-match leaf
  if (OLD_TO_NEW[oldPath]) return OLD_TO_NEW[oldPath];

  // Folder-prefix rules. The order matters; longest/most-specific first.

  // qa-plan/walkthrough-recipes/<rest> → 5-qa-and-training/qa-plan/walkthrough-recipes/<rest>
  // (also covers any other unmapped file under qa-plan/)
  if (oldPath.startsWith('qa-plan/')) {
    return `5-qa-and-training/${oldPath}`;
  }

  // mobile-recipes/<rest> → 5-qa-and-training/mobile-recipes/<rest>
  if (oldPath.startsWith('mobile-recipes/')) {
    return `5-qa-and-training/${oldPath}`;
  }

  // screenshots/<rest> (binary screenshots, not the manifest.yaml which is
  // mapped above) → 5-qa-and-training/screenshots/<rest>
  if (oldPath.startsWith('screenshots/')) {
    return `5-qa-and-training/${oldPath}`;
  }

  // qa-captures/<YYYY-MM-DD>-<...>-<mode>.md →
  //   - quick/deep → 4-ocs/ocs-chatbot-qa_transcript-<mode>.md  (Phase 4 gate)
  //   - monitor    → 6-llo-manager/ocs-chatbot-qa_transcript-monitor.md  (Phase 6 recurring)
  if (oldPath.startsWith('qa-captures/')) {
    const leaf = oldPath.slice('qa-captures/'.length);
    const m = leaf.match(/-(quick|deep|monitor)\.md$/);
    if (m) {
      const mode = m[1];
      if (mode === 'monitor') return `6-llo-manager/ocs-chatbot-qa_transcript-monitor.md`;
      return `4-ocs/ocs-chatbot-qa_transcript-${mode}.md`;
    }
    // Unparseable date pattern — skip with WARN signal (caller decides);
    // returning null tells the planner to omit silently.
    return null;
  }

  // monitoring/<rest> → 6-llo-manager/timeline-monitor/<rest>
  if (oldPath.startsWith('monitoring/')) {
    const leaf = oldPath.slice('monitoring/'.length);
    return `6-llo-manager/timeline-monitor/${leaf}`;
  }

  // data-reviews/<rest> → 6-llo-manager/flw-data-review/<rest>
  if (oldPath.startsWith('data-reviews/')) {
    const leaf = oldPath.slice('data-reviews/'.length);
    return `6-llo-manager/flw-data-review/${leaf}`;
  }

  // scorecards/<YYYY-MM-DD>-<...>-<mode>.md → 7-closeout/opp-eval/opp-eval_scorecard-<mode>.md
  if (oldPath.startsWith('scorecards/')) {
    const leaf = oldPath.slice('scorecards/'.length);
    if (leaf === 'trend.md') return '7-closeout/opp-eval/trend.md'; // already in OLD_TO_NEW
    const m = leaf.match(/-(quick|deep|monitor)\.md$/);
    if (m) {
      return `7-closeout/opp-eval/opp-eval_scorecard-${m[1]}.md`;
    }
    // Best-effort: skip unparseable scorecard names; operator can move by hand.
    return null;
  }

  // No mapping found — return null (planner drops it silently; caller
  // can surface as "unmapped" in the printout if it wants to).
  return null;
}

// ── Recursive walker ───────────────────────────────────────────────

/**
 * Recursively walk a run folder, emitting a PlannedMove for every file
 * whose path differs from its computed new path. Also emits one
 * `coalesce-folder` action per duplicate sibling-folder name found at
 * any level (the executor — Task 11 — does the actual merge).
 */
async function walkAndPlan(
  folderId: string,
  pathPrefix: string,
  runFolderId: string,
  drive: DriveLike,
  out: PlannedMove[],
): Promise<void> {
  const children = await drive.list(folderId);

  // Detect duplicate sibling folders at THIS level, emit one coalesce action
  // per duplicated name. We only emit once (using the first instance's id)
  // because the executor needs to know "merge B into A" and pick the canonical
  // one — for the dry-run printout, just signaling "duplicate exists" is enough.
  const folderNameCounts = new Map<string, DriveEntry[]>();
  for (const c of children) {
    if (c.mimeType !== FOLDER_MIME) continue;
    if (!folderNameCounts.has(c.name)) folderNameCounts.set(c.name, []);
    folderNameCounts.get(c.name)!.push(c);
  }
  for (const [name, entries] of folderNameCounts) {
    if (entries.length > 1) {
      out.push({
        fileId: entries[0]!.id,
        from: `${pathPrefix}${name}/`,
        to: `${pathPrefix}${name}/`,
        action: 'coalesce-folder',
        runFolderId,
      });
    }
  }

  for (const child of children) {
    const childPath = `${pathPrefix}${child.name}`;
    if (child.mimeType === FOLDER_MIME) {
      // Recurse into folders. The folder itself doesn't get a move action —
      // its files do.
      await walkAndPlan(child.id, `${childPath}/`, runFolderId, drive, out);
    } else {
      const newPath = computeNewPath(childPath);
      if (newPath && newPath !== childPath) {
        out.push({
          fileId: child.id,
          from: childPath,
          to: newPath,
          action: 'move',
          runFolderId,
        });
      }
    }
  }
}

/**
 * Plan moves for every run folder under one opp folder. Walks `opp/runs/`
 * and recurses into each `run-<id>/` subfolder.
 */
export async function planMoves(oppFolderId: string, drive: DriveLike): Promise<PlannedMove[]> {
  const out: PlannedMove[] = [];
  const oppChildren = await drive.list(oppFolderId);
  const runsFolder = oppChildren.find((c) => c.name === 'runs' && c.mimeType === FOLDER_MIME);
  if (!runsFolder) return out;
  const runs = (await drive.list(runsFolder.id)).filter((c) => c.mimeType === FOLDER_MIME);
  for (const run of runs) {
    await walkAndPlan(run.id, '', run.id, drive, out);
  }
  return out;
}

// ── CLI dispatcher ─────────────────────────────────────────────────

function pass(msg: string) { console.log(`PASS ${msg}`); }
function info(msg: string) { console.log(`INFO ${msg}`); }
function warn(msg: string) { console.log(`WARN ${msg}`); }

function resolveKeyPath(): string | null {
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
  return null;
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

async function listFolder(driveClient: any, folderId: string): Promise<DriveEntry[]> {
  const out: DriveEntry[] = [];
  let pageToken: string | undefined;
  do {
    const r = await driveClient.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'nextPageToken, files(id,name,mimeType)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      pageToken,
    });
    out.push(...((r.data.files ?? []) as DriveEntry[]));
    pageToken = r.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

function parseArgs(argv: string[]): { check: boolean; apply: boolean; oppFilter: string | null } {
  let apply = false;
  let oppFilter: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') apply = true;
    else if (a === '--check') {/* default */}
    else if (a === '--opp') { oppFilter = argv[++i] ?? null; }
  }
  return { check: !apply, apply, oppFilter };
}

function printOppPlan(oppName: string, moves: PlannedMove[]): void {
  console.log('');
  console.log(`── ${oppName} (${moves.length} planned action${moves.length === 1 ? '' : 's'}) ──`);
  if (moves.length === 0) {
    console.log('  (no moves needed; layout already migrated)');
    return;
  }
  // Group by run folder for readability.
  const byRun = new Map<string, PlannedMove[]>();
  for (const m of moves) {
    if (!byRun.has(m.runFolderId)) byRun.set(m.runFolderId, []);
    byRun.get(m.runFolderId)!.push(m);
  }
  for (const [runId, runMoves] of byRun) {
    console.log(`  run ${runId} (${runMoves.length}):`);
    for (const m of runMoves) {
      const tag = m.action === 'move' ? 'MOVE      '
        : m.action === 'coalesce-folder' ? 'COALESCE  '
        : m.action === 'create-shortcut' ? 'SHORTCUT  '
        : 'DELETE    ';
      console.log(`    ${tag} ${m.from} → ${m.to}`);
    }
  }
}

async function main() {
  const { apply, oppFilter } = parseArgs(process.argv.slice(2));

  if (apply) {
    console.log('ERROR: --apply not yet wired (lands in 0.12.0 Tasks 11-12)');
    process.exit(2);
  }

  loadEnv();

  const rootId = process.env.ACE_DRIVE_ROOT_FOLDER_ID;
  if (!rootId) {
    info('migrate-drive-layout: ACE_DRIVE_ROOT_FOLDER_ID not set — skipping');
    process.exit(1);
  }
  const keyPath = resolveKeyPath();
  if (!keyPath) {
    info('migrate-drive-layout: GWS service-account key not found — skipping');
    process.exit(1);
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: keyPath,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  const driveClient = google.drive({ version: 'v3', auth });
  const drive: DriveLike = { list: (id) => listFolder(driveClient, id) };

  const candidateFolders = (await drive.list(rootId)).filter(
    (c) => c.mimeType === FOLDER_MIME,
  );
  const oppFolders: typeof candidateFolders = [];
  for (const c of candidateFolders) {
    if (oppFilter && c.name !== oppFilter) continue;
    if (await isOppFolder(c.id, drive)) {
      oppFolders.push(c);
    } else if (oppFilter) {
      warn(`migrate-drive-layout: '${c.name}' matched --opp filter but isn't an opp folder (no inputs/ or opp.yaml)`);
    }
  }

  if (oppFolders.length === 0) {
    info(`migrate-drive-layout: no opp folders found${oppFilter ? ` matching --opp ${oppFilter}` : ''}`);
    return;
  }

  console.log(`Planning Drive layout migration (dry-run, --check)`);
  console.log(`Root folder: ${rootId}`);
  console.log(`Found ${oppFolders.length} opp folder${oppFolders.length === 1 ? '' : 's'}`);

  let totalMoves = 0;
  const perOppCounts: Array<{ name: string; count: number }> = [];
  for (const opp of oppFolders) {
    const moves = await planMoves(opp.id, drive);
    totalMoves += moves.length;
    perOppCounts.push({ name: opp.name, count: moves.length });
    printOppPlan(opp.name, moves);
  }

  console.log('');
  console.log('── Summary ──');
  for (const { name, count } of perOppCounts) {
    console.log(`  ${name}: ${count} planned action${count === 1 ? '' : 's'}`);
  }
  console.log(`  total: ${totalMoves} planned action${totalMoves === 1 ? '' : 's'} across ${oppFolders.length} opp${oppFolders.length === 1 ? '' : 's'}`);
  console.log('');
  pass('Dry-run mode (--check). Re-run with --apply to execute.');
}

// CLI guard: only run main() when invoked directly, not when imported by tests.
const isDirect = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
})();

if (isDirect) {
  main().catch((e) => {
    console.log(`WARN migrate-drive-layout: probe failed: ${e.message}`);
    process.exit(1);
  });
}
