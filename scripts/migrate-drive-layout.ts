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
import { google } from '../lib/google-shim.js';
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
  'expected-journeys.md': '1-design/pdd-to-app-journeys.md',
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
  'app-test-cases.yaml': '2-commcare/app-test-cases.yaml',
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
  'gate-briefs/ocs-chatbot-eval-quick.md': '4-ocs/ocs-chatbot-eval_gate-brief-quick.md',
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
  'verdicts/app-screenshot-capture.yaml': '5-qa-and-training/app-screenshot-capture_verdict.yaml',
  'verdicts/app-screenshot-capture-shallow.yaml': '5-qa-and-training/app-screenshot-capture_verdict-shallow.yaml',
  'verdicts/app-ux-eval-deep.yaml': '5-qa-and-training/app-ux-eval_verdict-deep.yaml',
  // Self-emitted Phase 5 verdicts (Option β) — verdicts named after producer
  'verdicts/training-deck-build.yaml': '5-qa-and-training/training-deck-build_verdict.yaml',
  'verdicts/training-deck-outline.yaml': '5-qa-and-training/training-deck-outline_verdict.yaml',
  'verdicts/training-faq.yaml': '5-qa-and-training/training-faq_verdict.yaml',
  'verdicts/training-flw-guide.yaml': '5-qa-and-training/training-flw-guide_verdict.yaml',
  'verdicts/training-llo-guide.yaml': '5-qa-and-training/training-llo-guide_verdict.yaml',
  'verdicts/training-onboarding-email.yaml': '5-qa-and-training/training-onboarding-email_verdict.yaml',
  'verdicts/training-quick-reference.yaml': '5-qa-and-training/training-quick-reference_verdict.yaml',
  // Solicitation Management (Phase 6) — new in 0.12.0
  'solicitation/draft.md': '6-solicitation-management/solicitation-create_draft.md',
  'solicitation/published.md': '6-solicitation-management/solicitation-create_published.md',
  'solicitation/invitations.md': '6-solicitation-management/llo-invite_invitations.md',
  'solicitation/review/scoring-rubric.md': '6-solicitation-management/solicitation-review_scoring-rubric.md',
  'solicitation/review/recommendation.md': '6-solicitation-management/solicitation-review_recommendation.md',
  'solicitation/award-record.md': '6-solicitation-management/solicitation-review_award-record.md',
  'verdicts/solicitation-create.yaml': '6-solicitation-management/solicitation-create-eval_verdict.yaml',
  'verdicts/solicitation-review.yaml': '6-solicitation-management/solicitation-review-eval_verdict.yaml',
  // Execution Management (Phase 7) — was llo-manager (was Phase 6) renamed in 0.12.0
  // Renumbered from 6-llo-manager/ to 7-execution-manager/ in 0.13.0.
  'connect-setup/invites.md': '7-execution-manager/llo-invite_list.md', // legacy pre-0.12.0 invite-list path
  'gate-briefs/llo-invite.md': '7-execution-manager/llo-invite_gate-brief.md',
  'comms-log/onboarding-emails.md': '7-execution-manager/llo-onboarding_comms-log.md',
  'uat/uat-results.md': '7-execution-manager/llo-uat_results.md',
  'launch/launch-record.md': '7-execution-manager/llo-launch_record.md',
  'gate-briefs/llo-launch.md': '7-execution-manager/llo-launch_gate-brief.md',
  'verdicts/llo-launch.yaml': '7-execution-manager/llo-launch-eval_verdict.yaml',
  'verdicts/flw-data-review-monitor.yaml': '7-execution-manager/flw-data-review-eval_verdict-monitor.yaml',
  'verdicts/ocs-chatbot-eval-monitor.yaml': '7-execution-manager/ocs-chatbot-eval_verdict-monitor.yaml',
  'eval-reports/trend.md': '7-execution-manager/ocs-chatbot-eval_trend.md',
  // 0.12.0 → 0.13.0 in-place renames for files under previously-migrated
  // 6-llo-manager/ and 7-closeout/ folders are handled by the prefix block
  // in `computeNewPath` (no exact-match leaf entry possible).
  // Closeout (Phase 8) — was Phase 7 in 0.12.0; renumbered in 0.13.0.
  'closeout/invoices.md': '8-closeout/opp-closeout_invoices.md',
  'closeout/llo-feedback.md': '8-closeout/llo-feedback.md',
  'closeout/learnings.md': '8-closeout/learnings-summary.md',
  'closeout/new-pdd.md': '8-closeout/learnings-summary_new-pdd.md',
  'closeout/cycle-grade.md': '8-closeout/cycle-grade.md',
  'closeout/final-summary.md': '8-closeout/closeout_summary.md',
  'verdicts/cycle-grade.yaml': '8-closeout/cycle-grade-eval_verdict.yaml',
  'verdicts/opp-eval-deep.yaml': '8-closeout/opp-eval/opp-eval_verdict-deep.yaml',
  'verdicts/opp-eval-monitor.yaml': '8-closeout/opp-eval/opp-eval_verdict-monitor.yaml',
  'gate-briefs/opp-eval-deep.md': '8-closeout/opp-eval/opp-eval_gate-brief-deep.md',
  'scorecards/trend.md': '8-closeout/opp-eval/trend.md',
};

// Run-scoped paths that should NOT move (already in new shape, or
// special-case identity).
const RUN_LEVEL_IDENTITY = new Set<string>([
  'run_state.yaml',
]);

/**
 * `current/` shortcut targets — one shortcut per entry, parented at the opp
 * root, pointing into the latest run. Refreshed by the orchestrator (Task 28)
 * after each phase completes; the migration planner emits one-shot creates
 * here so existing opps land on the new layout in a single sweep.
 */
const CURRENT_TARGETS: Array<{ name: string; target: string }> = [
  { name: 'connect-opp-summary.md', target: '3-connect/connect-opp-setup.md' },
  { name: 'connect-program-summary.md', target: '3-connect/connect-program-setup.md' },
  { name: 'ocs-agent-config.md', target: '4-ocs/ocs-agent-setup.md' },
];

/**
 * Folder names that the new layout retires entirely. After all in-folder files
 * have been moved out, the folder itself is deleted (defensively re-listed
 * before deletion in case state changed mid-migration). Only top-level legacy
 * folders are listed here; nested folders inside `qa-plan/`, `screenshots/`,
 * etc. survive in the new layout.
 */
const LEGACY_DEAD_FOLDERS = new Set<string>([
  'gate-briefs',
  'verdicts',
  'app-summaries',
  'app-coverage',
  'test-results',
  'connect-setup',
  'comms-log',
  'uat',
  'launch',
  'eval-reports',
  'closeout',
  'qa-captures',
  'monitoring',
  'data-reviews',
  'scorecards',
  'training-materials',
  'ocs-setup',
  'apps',
  'solicitation',     // 0.12.0 flat solicitation/ → 6-solicitation-management/
  '6-llo-manager',    // 0.13.0 renumber: 6-llo-manager/ → 7-execution-manager/
  '7-closeout',       // 0.13.0 renumber: 7-closeout/   → 8-closeout/
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
export function computeNewPath(oldPath: string): string | null {
  // 0.12.0 → 0.13.0 in-place renames: file lives under one of the prefix
  // names that got renumbered. Handle BEFORE the "already-prefixed skip"
  // check below so the rename actually happens.
  if (oldPath.startsWith('6-llo-manager/')) {
    return `7-execution-manager/${oldPath.slice('6-llo-manager/'.length)}`;
  }
  if (oldPath.startsWith('7-closeout/')) {
    return `8-closeout/${oldPath.slice('7-closeout/'.length)}`;
  }

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

  // mobile-recipes/<rest> → 5-qa-and-training/mobile-recipes/<rest>
  if (oldPath.startsWith('mobile-recipes/')) {
    return `5-qa-and-training/${oldPath}`;
  }

  // screenshots/<rest> (binary screenshots, not the manifest.yaml which is
  // mapped above) → 5-qa-and-training/screenshots/<rest>
  if (oldPath.startsWith('screenshots/')) {
    return `5-qa-and-training/${oldPath}`;
  }

  // solicitation/responses/<rest> → 6-solicitation-management/solicitation-monitor_responses/<rest>
  if (oldPath.startsWith('solicitation/responses/')) {
    const leaf = oldPath.slice('solicitation/responses/'.length);
    return `6-solicitation-management/solicitation-monitor_responses/${leaf}`;
  }

  // qa-captures/<YYYY-MM-DD>-<...>-<mode>.md →
  //   - quick/deep → 4-ocs/ocs-chatbot-qa_transcript-<mode>.md  (Phase 4 gate)
  //   - monitor    → 7-execution-manager/ocs-chatbot-qa_transcript-monitor.md (Phase 7 recurring)
  if (oldPath.startsWith('qa-captures/')) {
    const leaf = oldPath.slice('qa-captures/'.length);
    const m = leaf.match(/-(quick|deep|monitor)\.md$/);
    if (m) {
      const mode = m[1];
      if (mode === 'monitor') return `7-execution-manager/ocs-chatbot-qa_transcript-monitor.md`;
      return `4-ocs/ocs-chatbot-qa_transcript-${mode}.md`;
    }
    // Unparseable date pattern — skip with WARN signal (caller decides);
    // returning null tells the planner to omit silently.
    return null;
  }

  // monitoring/<rest> → 7-execution-manager/timeline-monitor/<rest>
  if (oldPath.startsWith('monitoring/')) {
    const leaf = oldPath.slice('monitoring/'.length);
    return `7-execution-manager/timeline-monitor/${leaf}`;
  }

  // data-reviews/<rest> → 7-execution-manager/flw-data-review/<rest>
  if (oldPath.startsWith('data-reviews/')) {
    const leaf = oldPath.slice('data-reviews/'.length);
    return `7-execution-manager/flw-data-review/${leaf}`;
  }

  // scorecards/<YYYY-MM-DD>-<...>-<mode>.md → 8-closeout/opp-eval/opp-eval_scorecard-<mode>.md
  if (oldPath.startsWith('scorecards/')) {
    const leaf = oldPath.slice('scorecards/'.length);
    if (leaf === 'trend.md') return '8-closeout/opp-eval/trend.md'; // already in OLD_TO_NEW
    const m = leaf.match(/-(quick|deep|monitor)\.md$/);
    if (m) {
      return `8-closeout/opp-eval/opp-eval_scorecard-${m[1]}.md`;
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
 * Per-run side-effect collector for the second-pass emissions (delete-empty).
 * Keyed by relative folder path under the run; tracks total file count and
 * the move-out count so we can decide if the folder ends up empty.
 */
interface FolderStat {
  id: string;
  totalFiles: number;
  movedOutFiles: number;
  hasSubfolders: boolean;
}

/**
 * Recursively walk a run folder, emitting a PlannedMove for every file
 * whose path differs from its computed new path. Also emits one
 * `coalesce-folder` action per duplicate sibling-folder name found at
 * any level. The `topLevelFolderStats` map is populated as a side effect
 * so `planMoves` can later emit `delete-empty` actions for legacy folders
 * that end up with no children after all moves.
 */
async function walkAndPlan(
  folderId: string,
  pathPrefix: string,
  runFolderId: string,
  drive: DriveLike,
  out: PlannedMove[],
  topLevelFolderStats: Map<string, FolderStat>,
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
      // Track top-level folders for the post-move delete-empty pass.
      // Only direct children of the run folder count — nested folders
      // (e.g. screenshots/learn/) survive in the new layout under their
      // legacy parent's new home.
      if (pathPrefix === '') {
        topLevelFolderStats.set(child.name, {
          id: child.id,
          totalFiles: 0,
          movedOutFiles: 0,
          hasSubfolders: false,
        });
      }
      // Recurse into folders. The folder itself doesn't get a move action —
      // its files do.
      await walkAndPlan(child.id, `${childPath}/`, runFolderId, drive, out, topLevelFolderStats);
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
      // Track file counts for the top-level folder this file lives under.
      if (pathPrefix !== '') {
        const top = pathPrefix.split('/')[0]!;
        const stat = topLevelFolderStats.get(top);
        if (stat) {
          stat.totalFiles += 1;
          if (newPath && newPath !== childPath) stat.movedOutFiles += 1;
        }
      }
    }
  }

  // After processing children, if we recursed into a top-level legacy folder
  // and found subfolders (not just files), mark it so we don't emit delete-empty
  // for a folder whose children are themselves folders we'd have to delete first.
  if (pathPrefix !== '') {
    const top = pathPrefix.split('/')[0]!;
    const stat = topLevelFolderStats.get(top);
    if (stat) {
      const subFolders = children.filter((c) => c.mimeType === FOLDER_MIME);
      if (subFolders.length > 0 && pathPrefix.split('/').filter(Boolean).length === 1) {
        stat.hasSubfolders = true;
      }
    }
  }
}

/**
 * Plan moves for every run folder under one opp folder. Walks `opp/runs/`
 * and recurses into each `run-<id>/` subfolder. After all moves are planned,
 * a second pass emits two derived action types:
 *
 *  - `delete-empty` for any top-level legacy folder (LEGACY_DEAD_FOLDERS)
 *    whose files all moved out and that had no nested subfolders to keep.
 *
 *  - `create-shortcut` for each CURRENT_TARGETS entry, parented at the opp
 *    root, pointing into the lex-largest run (the "latest" run by the
 *    YYYYMMDD-HHMM naming convention). Emitted once per opp, not per run.
 */
export async function planMoves(oppFolderId: string, drive: DriveLike): Promise<PlannedMove[]> {
  const out: PlannedMove[] = [];
  const oppChildren = await drive.list(oppFolderId);
  const runsFolder = oppChildren.find((c) => c.name === 'runs' && c.mimeType === FOLDER_MIME);
  if (!runsFolder) return out;
  const runs = (await drive.list(runsFolder.id)).filter((c) => c.mimeType === FOLDER_MIME);
  for (const run of runs) {
    const stats = new Map<string, FolderStat>();
    await walkAndPlan(run.id, '', run.id, drive, out, stats);
    // Per-run delete-empty emissions.
    for (const [name, stat] of stats) {
      if (!LEGACY_DEAD_FOLDERS.has(name)) continue;
      if (stat.hasSubfolders) continue;
      if (stat.totalFiles === 0 || stat.movedOutFiles < stat.totalFiles) continue;
      out.push({
        fileId: stat.id,
        from: `${name}/`,
        to: `${name}/`,
        action: 'delete-empty',
        runFolderId: run.id,
      });
    }
  }

  // Per-opp create-shortcut emissions for the latest run.
  if (runs.length > 0) {
    const latest = [...runs].sort((a, b) => b.name.localeCompare(a.name))[0]!;
    for (const target of CURRENT_TARGETS) {
      out.push({
        fileId: latest.id,
        from: target.name,
        to: target.target,
        action: 'create-shortcut',
        runFolderId: latest.id,
      });
    }
  }

  return out;
}

// ── executeMoves ───────────────────────────────────────────────────

/**
 * Result shape for `executeMoves` — counts and per-action errors.
 */
export interface ExecuteResult {
  executed: number;
  errors: Array<{ move: PlannedMove; message: string }>;
}

/**
 * Find-or-create a folder by name under a parent. Inlined here (not pulled
 * from the MCP) so this script stays a plain `npx tsx` runnable without
 * importing MCP-server modules.
 */
async function findOrCreateFolder(
  driveClient: any,
  name: string,
  parentFolderId: string,
): Promise<string> {
  const escaped = name.replace(/'/g, "\\'");
  const list = await driveClient.files.list({
    q: `mimeType='${FOLDER_MIME}' and name='${escaped}' and '${parentFolderId}' in parents and trashed=false`,
    fields: 'files(id, name)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  const existing = list.data.files?.[0];
  if (existing?.id) return existing.id;
  const created = await driveClient.files.create({
    requestBody: {
      name,
      mimeType: FOLDER_MIME,
      parents: [parentFolderId],
    },
    fields: 'id, name',
    supportsAllDrives: true,
  });
  return created.data.id!;
}

/**
 * Walk segments of a target path under `runFolderId`, find-or-creating each
 * intermediate folder. Returns the leaf folder ID. Uses `cache` to avoid
 * repeat lookups; cache key is the path relative to runFolderId.
 */
async function ensureFolderPath(
  driveClient: any,
  runFolderId: string,
  segments: string[],
  cache: Map<string, string>,
): Promise<string> {
  let parentId = runFolderId;
  let acc = '';
  for (const seg of segments) {
    acc = acc ? `${acc}/${seg}` : seg;
    const cached = cache.get(acc);
    if (cached) {
      parentId = cached;
      continue;
    }
    const folderId = await findOrCreateFolder(driveClient, seg, parentId);
    cache.set(acc, folderId);
    parentId = folderId;
  }
  return parentId;
}

/**
 * Walk segments of `to` to find the existing file ID under `runFolderId`.
 * Used for `create-shortcut` to resolve the target the shortcut should point at.
 * Returns null if any segment doesn't exist.
 */
async function resolveTargetIdByPath(
  driveClient: any,
  runFolderId: string,
  segments: string[],
): Promise<string | null> {
  let parentId = runFolderId;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const escaped = seg.replace(/'/g, "\\'");
    const list = await driveClient.files.list({
      q: `name='${escaped}' and '${parentId}' in parents and trashed=false`,
      fields: 'files(id, name, mimeType)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    const match = list.data.files?.[0];
    if (!match?.id) return null;
    parentId = match.id;
  }
  return parentId;
}

/**
 * Execute a list of PlannedMove actions against the live Drive client.
 * Per-action errors are collected and returned (not thrown) — partial-success
 * is recoverable, so the caller can re-run after fixing whatever went wrong.
 *
 * Cache scope: per-call. Each opp's moves get a fresh cache so stale entries
 * from another opp can't poison the lookup.
 */
export async function executeMoves(
  oppFolderId: string,
  moves: PlannedMove[],
  driveClient: any,
): Promise<ExecuteResult> {
  void oppFolderId; // Reserved for future per-opp identity actions; unused today.
  const folderCache = new Map<string, string>();
  // Cache key prefix per run so two runs of the same name don't collide.
  // Format: `${runFolderId}::${relPath}`
  const runScopedCache = new Map<string, string>();
  const result: ExecuteResult = { executed: 0, errors: [] };

  for (const move of moves) {
    try {
      if (move.action === 'move') {
        const segments = move.to.split('/');
        const newName = segments.pop()!;
        // Build a cache facade scoped to this run.
        const runCache = new Map<string, string>();
        for (const [k, v] of runScopedCache) {
          if (k.startsWith(`${move.runFolderId}::`)) {
            runCache.set(k.slice(move.runFolderId.length + 2), v);
          }
        }
        const parentId = await ensureFolderPath(driveClient, move.runFolderId, segments, runCache);
        // Sync the run-scoped cache back.
        for (const [k, v] of runCache) {
          runScopedCache.set(`${move.runFolderId}::${k}`, v);
        }
        // Get current parents to remove.
        const meta = await driveClient.files.get({
          fileId: move.fileId,
          fields: 'parents',
          supportsAllDrives: true,
        });
        const previousParents = (meta.data.parents ?? []).join(',');
        await driveClient.files.update({
          fileId: move.fileId,
          addParents: parentId,
          removeParents: previousParents,
          requestBody: { name: newName },
          fields: 'id, name',
          supportsAllDrives: true,
        });
        console.log(`✓ move ${move.from} → ${move.to}`);
        result.executed += 1;
        void folderCache; // satisfy linter for the per-opp cache (kept for future use)
      } else if (move.action === 'coalesce-folder') {
        // Find both same-named siblings under the run.
        // The folder name is the segment between leading and trailing slashes.
        const folderName = move.from.replace(/\/$/, '').split('/').pop()!;
        const escaped = folderName.replace(/'/g, "\\'");
        const sibList = await driveClient.files.list({
          q: `mimeType='${FOLDER_MIME}' and name='${escaped}' and '${move.runFolderId}' in parents and trashed=false`,
          fields: 'files(id, name)',
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        });
        const siblings = (sibList.data.files ?? []) as Array<{ id: string; name: string }>;
        if (siblings.length < 2) {
          console.log(`✗ coalesce-folder ${move.from}: expected 2+ siblings, found ${siblings.length}`);
          continue;
        }
        // Canonical = lex-min file id (stable ordering rule).
        const sorted = [...siblings].sort((a, b) => a.id.localeCompare(b.id));
        const canonical = sorted[0]!;
        const dups = sorted.slice(1);
        for (const dup of dups) {
          // Move every child of dup into canonical.
          const childList = await driveClient.files.list({
            q: `'${dup.id}' in parents and trashed=false`,
            fields: 'files(id, name)',
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
          });
          for (const child of (childList.data.files ?? []) as Array<{ id: string; name: string }>) {
            const childMeta = await driveClient.files.get({
              fileId: child.id,
              fields: 'parents',
              supportsAllDrives: true,
            });
            const childPrev = (childMeta.data.parents ?? []).join(',');
            await driveClient.files.update({
              fileId: child.id,
              addParents: canonical.id,
              removeParents: childPrev,
              fields: 'id, name',
              supportsAllDrives: true,
            });
          }
          // Delete the now-empty dup.
          await driveClient.files.delete({
            fileId: dup.id,
            supportsAllDrives: true,
          });
        }
        console.log(`✓ coalesce-folder ${move.from} (canonical=${canonical.id})`);
        result.executed += 1;
      } else if (move.action === 'create-shortcut') {
        // Resolve the target file ID by walking `to` segments under runFolderId.
        const targetSegments = move.to.split('/');
        const targetId = await resolveTargetIdByPath(driveClient, move.runFolderId, targetSegments);
        if (!targetId) {
          console.log(`✗ create-shortcut ${move.from}: target ${move.to} not found under run`);
          result.errors.push({ move, message: `target path not found: ${move.to}` });
          continue;
        }
        // Ensure `<opp>/current/` exists.
        const currentFolderId = await findOrCreateFolder(driveClient, 'current', oppFolderId);
        // Delete any same-name child of current/ first (findOrReplace semantics).
        const escapedName = move.from.replace(/'/g, "\\'");
        const existingList = await driveClient.files.list({
          q: `name='${escapedName}' and '${currentFolderId}' in parents and trashed=false`,
          fields: 'files(id)',
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        });
        for (const existing of (existingList.data.files ?? []) as Array<{ id: string }>) {
          await driveClient.files.delete({
            fileId: existing.id,
            supportsAllDrives: true,
          });
        }
        await driveClient.files.create({
          requestBody: {
            name: move.from,
            mimeType: 'application/vnd.google-apps.shortcut',
            parents: [currentFolderId],
            shortcutDetails: { targetId },
          },
          fields: 'id, name',
          supportsAllDrives: true,
        });
        console.log(`✓ create-shortcut ${move.from} → ${move.to}`);
        result.executed += 1;
      } else if (move.action === 'delete-empty') {
        // Defensive re-list — only delete if confirmed empty.
        const childList = await driveClient.files.list({
          q: `'${move.fileId}' in parents and trashed=false`,
          fields: 'files(id)',
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        });
        const remaining = (childList.data.files ?? []).length;
        if (remaining > 0) {
          console.log(`✗ delete-empty ${move.from}: skipped (${remaining} children appeared after plan)`);
          continue;
        }
        await driveClient.files.delete({
          fileId: move.fileId,
          supportsAllDrives: true,
        });
        console.log(`✓ delete-empty ${move.from}`);
        result.executed += 1;
      }
    } catch (e: any) {
      console.log(`✗ ${move.action} ${move.from}: ${e.message}`);
      result.errors.push({ move, message: e.message });
    }
  }

  return result;
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

  const modeLabel = apply ? 'apply' : 'dry-run, --check';
  console.log(`Planning Drive layout migration (${modeLabel})`);
  console.log(`Root folder: ${rootId}`);
  console.log(`Found ${oppFolders.length} opp folder${oppFolders.length === 1 ? '' : 's'}`);

  let totalMoves = 0;
  let totalExecuted = 0;
  let totalErrors = 0;
  const perOppCounts: Array<{ name: string; count: number; executed?: number; errors?: number }> = [];
  for (const opp of oppFolders) {
    const moves = await planMoves(opp.id, drive);
    totalMoves += moves.length;
    const summary: { name: string; count: number; executed?: number; errors?: number } = { name: opp.name, count: moves.length };
    printOppPlan(opp.name, moves);
    if (apply && moves.length > 0) {
      console.log('');
      console.log(`  Applying ${moves.length} action${moves.length === 1 ? '' : 's'} for ${opp.name}…`);
      const r = await executeMoves(opp.id, moves, driveClient);
      summary.executed = r.executed;
      summary.errors = r.errors.length;
      totalExecuted += r.executed;
      totalErrors += r.errors.length;
    }
    perOppCounts.push(summary);
  }

  console.log('');
  console.log('── Summary ──');
  for (const { name, count, executed, errors } of perOppCounts) {
    if (apply) {
      console.log(`  ${name}: ${executed ?? 0}/${count} applied${errors ? ` (${errors} errors)` : ''}`);
    } else {
      console.log(`  ${name}: ${count} planned action${count === 1 ? '' : 's'}`);
    }
  }
  if (apply) {
    console.log(`  total: applied ${totalExecuted} moves across ${oppFolders.length} opp${oppFolders.length === 1 ? '' : 's'}; ${totalErrors} errors`);
    console.log('');
    if (totalErrors === 0) {
      pass(`Apply mode complete. ${totalExecuted} of ${totalMoves} planned actions executed.`);
    } else {
      warn(`Apply mode complete with errors. ${totalExecuted} executed, ${totalErrors} failed. Re-run after fixing root cause.`);
      process.exit(1);
    }
  } else {
    console.log(`  total: ${totalMoves} planned action${totalMoves === 1 ? '' : 's'} across ${oppFolders.length} opp${oppFolders.length === 1 ? '' : 's'}`);
    console.log('');
    pass('Dry-run mode (--check). Re-run with --apply to execute.');
  }
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
