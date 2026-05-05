/**
 * scripts/migrate-fixture-layout.ts
 *
 * Local-filesystem mirror of `scripts/migrate-drive-layout.ts` (Task 14
 * of docs/superpowers/plans/2026-05-03-run-folder-readability.md). Reuses
 * the same OLD_TO_NEW table + computeNewPath logic to rewrite test
 * fixtures in place under the new phase-prefixed
 * `<N>-<phase>/<skill>[_<role>].<ext>` layout.
 *
 * One-shot tool. No --dry-run flag — git is the safety net (re-run with
 * `git checkout -- <fixture-dir>` if a mapping was wrong, fix the
 * mapping, re-run).
 *
 * Usage:
 *   npx tsx scripts/migrate-fixture-layout.ts <fixture-dir>
 *
 * `<fixture-dir>` may either be the run-root directly (flat tree of
 * artifacts) OR a directory containing `runs/<run-id>/...` subfolders.
 * Each detected run-root is migrated independently.
 *
 * Behavior per file:
 *   - Compute newPath via computeNewPath(relPath).
 *   - If null → leave file in place (identity skip; covers run_state.yaml,
 *     already-prefixed paths, and dropped artifacts that have no target).
 *   - Else → mkdirSync({recursive:true}) the destination and renameSync.
 * After all moves, walk the tree bottom-up and rmdirSync any empty dir.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { computeNewPath } from './migrate-drive-layout.js';

interface MoveRecord {
  from: string;
  to: string;
}

/** Recursively list every file path under `dir`, returned as absolute paths. */
function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

/** Recursively remove empty directories under `dir`, bottom-up. Skips `dir` itself. */
function pruneEmptyDirs(dir: string): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const child = path.join(dir, entry.name);
    pruneEmptyDirs(child);
    try {
      const remaining = fs.readdirSync(child);
      if (remaining.length === 0) {
        fs.rmdirSync(child);
        console.log(`  pruned empty dir: ${path.relative(process.cwd(), child)}`);
      }
    } catch {
      // ignore — race conditions or permission errors aren't fatal here
    }
  }
}

/**
 * Migrate one run-root: compute new paths, rename, then prune empty dirs.
 * Returns the list of executed moves for logging.
 */
function migrateRunRoot(runRoot: string): MoveRecord[] {
  const moves: MoveRecord[] = [];
  const files = listFilesRecursive(runRoot);

  for (const fullPath of files) {
    const rel = path.relative(runRoot, fullPath);
    // Normalize Windows-style separators to POSIX for OLD_TO_NEW lookups.
    const relPosix = rel.split(path.sep).join('/');
    const newRel = computeNewPath(relPosix);
    if (!newRel) continue;
    if (newRel === relPosix) continue;
    const newFullPath = path.join(runRoot, ...newRel.split('/'));
    if (newFullPath === fullPath) continue;
    fs.mkdirSync(path.dirname(newFullPath), { recursive: true });
    fs.renameSync(fullPath, newFullPath);
    moves.push({ from: relPosix, to: newRel });
    console.log(`  ${relPosix} → ${newRel}`);
  }

  pruneEmptyDirs(runRoot);
  return moves;
}

function main(): void {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: npx tsx scripts/migrate-fixture-layout.ts <fixture-dir>');
    process.exit(1);
  }
  const fixtureDir = path.resolve(arg);
  if (!fs.existsSync(fixtureDir)) {
    console.error(`migrate-fixture-layout: ${fixtureDir} does not exist`);
    process.exit(1);
  }
  if (!fs.statSync(fixtureDir).isDirectory()) {
    console.error(`migrate-fixture-layout: ${fixtureDir} is not a directory`);
    process.exit(1);
  }

  // Detect runs/<run-id>/ layout vs flat run-root.
  const runsDir = path.join(fixtureDir, 'runs');
  const runRoots: string[] = [];
  if (fs.existsSync(runsDir) && fs.statSync(runsDir).isDirectory()) {
    for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) runRoots.push(path.join(runsDir, entry.name));
    }
    if (runRoots.length === 0) {
      console.log(`migrate-fixture-layout: no run subfolders under ${runsDir}; nothing to do`);
      return;
    }
  } else {
    runRoots.push(fixtureDir);
  }

  let total = 0;
  for (const root of runRoots) {
    console.log(`Migrating ${path.relative(process.cwd(), root)}…`);
    const moves = migrateRunRoot(root);
    console.log(`  ${moves.length} file${moves.length === 1 ? '' : 's'} moved`);
    total += moves.length;
  }
  console.log('');
  console.log(`Done. ${total} total move${total === 1 ? '' : 's'} across ${runRoots.length} run root${runRoots.length === 1 ? '' : 's'}.`);
}

main();
