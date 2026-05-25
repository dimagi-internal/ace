#!/usr/bin/env npx tsx
/**
 * Atlas drift harvester.
 *
 * Given a directory of ui-dump XML files from a Phase 6 run, report
 * which on-device resource-ids the active selector map does not yet
 * cover (candidates for new logical-selector rows) and which `id:`
 * matchers in the map were not seen in the dumps (possibly dead or
 * out-of-coverage rows).
 *
 * Read-only. Does NOT mutate `mcp/mobile/selectors/connect-*.yaml` —
 * adding rows is always a judgment call (stable id vs transient layout
 * id; text matcher might be better). The harvester surfaces candidates
 * + counts; a human decides whether and how to update the map.
 *
 * Closes the consume-half of 2026-05-14-atlas-side-channel-capture.md.
 * The capture-half (every Phase 6 dispatch leaves a .xml ui-dump next
 * to each PNG) has shipped since 0.13.229 — but until this script
 * landed, the dumps just accumulated. Now there is a one-command way
 * to harvest selector-drift signal from them.
 *
 * Usage:
 *   npx tsx scripts/probe-atlas-drift.ts <dump-dir> [--apk 2.62.0] [--out report.md]
 *
 *   <dump-dir>         Directory containing .xml ui-dump files (and
 *                      optionally subdirectories — the script walks
 *                      recursively). The Phase 6 layout produces
 *                      `6-qa-and-training/screenshots/<journey-id>/
 *                      <step-name>.xml` so pointing at any ancestor
 *                      of those XMLs works.
 *   --apk <version>    Connect APK version to compare against. Defaults
 *                      to 2.62.0 (the current default). Loads
 *                      `mcp/mobile/selectors/connect-<version>.yaml`.
 *   --out <path>       Write report to this file. Defaults to stdout.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  extractResourceIdsFromDump,
  loadSelectorMapIds,
  diffResourceIds,
  renderReportMarkdown,
} from '../lib/atlas-drift.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELECTORS_DIR = path.join(REPO_ROOT, 'mcp/mobile/selectors');
const DEFAULT_APK = '2.62.0';

interface CliArgs {
  dumpDir: string;
  apkVersion: string;
  outPath: string | null;
}

function parseArgs(argv: string[]): CliArgs {
  const positional: string[] = [];
  let apkVersion = DEFAULT_APK;
  let outPath: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apk') {
      apkVersion = argv[++i] ?? '';
      if (!apkVersion) throw new Error('--apk requires a version (e.g. 2.62.0)');
    } else if (a === '--out') {
      outPath = argv[++i] ?? null;
      if (!outPath) throw new Error('--out requires a file path');
    } else if (a === '--help' || a === '-h') {
      printUsage();
      process.exit(0);
    } else if (a.startsWith('-')) {
      throw new Error(`unknown flag: ${a}`);
    } else {
      positional.push(a);
    }
  }
  if (positional.length !== 1) {
    printUsage();
    process.exit(2);
  }
  return { dumpDir: positional[0], apkVersion, outPath };
}

function printUsage(): void {
  process.stderr.write(
    'Usage: npx tsx scripts/probe-atlas-drift.ts <dump-dir> [--apk 2.62.0] [--out report.md]\n',
  );
}

function findDumpFiles(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(p);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.xml')) {
        out.push(p);
      }
    }
  }
  return out.sort();
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(args.dumpDir) || !fs.statSync(args.dumpDir).isDirectory()) {
    process.stderr.write(`dump directory not found or not a directory: ${args.dumpDir}\n`);
    process.exit(2);
  }
  const mapPath = path.join(SELECTORS_DIR, `connect-${args.apkVersion}.yaml`);
  if (!fs.existsSync(mapPath)) {
    process.stderr.write(`selector map not found: ${mapPath}\n`);
    process.exit(2);
  }

  const dumpFiles = findDumpFiles(args.dumpDir);
  if (dumpFiles.length === 0) {
    process.stderr.write(`no .xml dump files found under ${args.dumpDir}\n`);
    process.exit(2);
  }

  // Aggregate observed ids across every dump in the directory tree.
  const observed = new Set<string>();
  for (const f of dumpFiles) {
    const xml = fs.readFileSync(f, 'utf8');
    for (const id of extractResourceIdsFromDump(xml)) observed.add(id);
  }

  const mapped = loadSelectorMapIds(fs.readFileSync(mapPath, 'utf8'));
  const diff = diffResourceIds(observed, mapped);

  // Make dump-file paths relative to the dump dir so the report stays
  // readable when the absolute path is deep.
  const relativeDumpFiles = dumpFiles.map((f) => path.relative(args.dumpDir, f));

  const report = renderReportMarkdown({
    apkVersion: args.apkVersion,
    dumpFiles: relativeDumpFiles,
    onlyInDumps: diff.onlyInDumps,
    onlyInMap: diff.onlyInMap,
    inBoth: diff.inBoth,
  });

  if (args.outPath) {
    fs.writeFileSync(args.outPath, report);
    process.stderr.write(
      `wrote report to ${args.outPath} (${diff.onlyInDumps.length} new, ${diff.onlyInMap.length} orphan, ${diff.inBoth.length} matched)\n`,
    );
  } else {
    process.stdout.write(report);
  }
}

main();
