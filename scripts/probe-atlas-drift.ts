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
 *   npx tsx scripts/probe-atlas-drift.ts <dump-dir> [--apk 2.63.2] [--out report.md] [--yaml-out atlas-report.yaml]
 *
 *   <dump-dir>         Directory containing .xml ui-dump files (and
 *                      optionally subdirectories — the script walks
 *                      recursively). The Phase 6 layout produces
 *                      `6-qa-and-training/screenshots/<journey-id>/
 *                      <step-name>.xml` so pointing at any ancestor
 *                      of those XMLs works.
 *   --apk <version>    Connect APK version to compare against. Defaults
 *                      to `$ACE_CONNECT_APK_VERSION` (the pin in
 *                      `.env.tpl`), falling back to 2.63.2 if unset.
 *                      Loads `mcp/mobile/selectors/connect-<version>.yaml`.
 *   --out <path>       Write the markdown report to this file. Defaults
 *                      to stdout.
 *   --yaml-out <path>  Also classify a `*-FAILURE.xml` dump (via
 *                      `classifyScreenCoverage`) and write the
 *                      machine-readable verdict to this path. No-op
 *                      when no failure dump is present.
 *
 *                      The dump is the NEWEST one that still means
 *                      something (ace#1571): dumps that a later passing
 *                      dispatch superseded, and dumps that caught the
 *                      home screen / system chrome rather than an app
 *                      screen, are skipped — because `unmapped-surface`
 *                      routes a HUMAN to `skills/selector-map-heal`, and
 *                      a false positive there costs a device session.
 *                      When nothing is eligible the newest dump is still
 *                      reported, honestly labelled `superseded` /
 *                      `non-app-surface`, with a `skipped:` ledger.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  extractResourceIdsFromDump,
  loadSelectorMapIds,
  diffResourceIds,
  renderReportMarkdown,
  isFailureDumpFile,
  failureScreenDriftSuspects,
  classifyScreenCoverage,
  extractWantedMatchers,
  renderReportYaml,
  selectFailureDumpForClassification,
  isSupersededFailureDump,
  isNonAppSurfaceDump,
  type ArtifactFileMeta,
  type FailureDumpSkipReason,
} from '../lib/atlas-drift.js';

import { loadPluginEnv } from '../lib/load-plugin-env.js';

// ace#1964 — a script reached from a Bash tool call inherits NONE of ACE's
// secrets, so it has to load `<plugin-data>/.env` itself. Module top, before
// any credential read: ESM runs this body top-down, so "before main()" is
// already too late for a read at module level.
loadPluginEnv(import.meta.url);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELECTORS_DIR = path.join(REPO_ROOT, 'mcp/mobile/selectors');
const DEFAULT_APK = process.env.ACE_CONNECT_APK_VERSION || '2.63.2';

interface CliArgs {
  dumpDir: string;
  apkVersion: string;
  outPath: string | null;
  yamlOutPath: string | null;
}

function parseArgs(argv: string[]): CliArgs {
  const positional: string[] = [];
  let apkVersion = DEFAULT_APK;
  let outPath: string | null = null;
  let yamlOutPath: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apk') {
      apkVersion = argv[++i] ?? '';
      if (!apkVersion) throw new Error('--apk requires a version (e.g. 2.62.0)');
    } else if (a === '--out') {
      outPath = argv[++i] ?? null;
      if (!outPath) throw new Error('--out requires a file path');
    } else if (a === '--yaml-out') {
      yamlOutPath = argv[++i] ?? null;
      if (!yamlOutPath) throw new Error('--yaml-out requires a path');
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
  return { dumpDir: positional[0], apkVersion, outPath, yamlOutPath };
}

function printUsage(): void {
  process.stderr.write(
    'Usage: npx tsx scripts/probe-atlas-drift.ts <dump-dir> [--apk 2.63.2] [--out report.md] [--yaml-out atlas-report.yaml]\n',
  );
}

/** Every file under `root`, not just the XMLs. The supersession test
 *  (ace#1571) needs to see a passing dispatch's PNGs, and on the cloud
 *  backend PNGs are the ONLY ordinary captures — no sibling .xml dumps are
 *  written at all — so an xml-only walk would be blind to exactly the
 *  evidence that proves a FAILURE dump stale. */
function findAllFiles(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(p);
      else if (entry.isFile()) out.push(p);
    }
  }
  return out.sort();
}

/** Stat every path once into a lookup. Never inside a comparator: a naive
 *  `sort((a, b) => statSync(a)... - statSync(b)...)` re-stats on every
 *  comparison, and this dir is a live TOCTOU target — another process can
 *  delete a dump between the readdir above and the stat, so an unguarded
 *  statSync can throw ENOENT and crash the whole probe run. A file that
 *  vanished falls back to mtime 0 rather than aborting. */
function statAll(files: string[]): ArtifactFileMeta[] {
  return files.map((p) => {
    try {
      return { path: p, mtimeMs: fs.statSync(p).mtimeMs };
    } catch {
      return { path: p, mtimeMs: 0 };
    }
  });
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

  const allFiles = statAll(findAllFiles(args.dumpDir));
  const dumpFiles = allFiles.filter((f) => f.path.toLowerCase().endsWith('.xml'));
  if (dumpFiles.length === 0) {
    process.stderr.write(`no .xml dump files found under ${args.dumpDir}\n`);
    process.exit(2);
  }

  // Aggregate observed ids across every dump in the directory tree, tracking
  // which ids appeared specifically on a `*-FAILURE.xml` screen — those are
  // the priority drift suspects (a candidate root cause for a recipe failure
  // in this run, not just untapped coverage).
  //
  // A FAILURE dump only earns that priority treatment if it is still live
  // evidence about an app screen (ace#1571). A superseded dump's ids and a
  // launcher dump's ids are noise in the section whose header says "review
  // FIRST" — on hh-poverty-targeting/20260819-1435 that was 50 suspects,
  // essentially all of them launcher chrome from a retry that then passed.
  // The dumps still feed the ordinary coverage aggregate below: this is a
  // filter on what gets ESCALATED, not on what gets harvested.
  const failureXmlCache = new Map<string, string>();
  const excludedFailureDumps: Array<{ file: string; reason: FailureDumpSkipReason }> = [];
  const observed = new Set<string>();
  const observedOnFailure = new Set<string>();
  for (const f of dumpFiles) {
    const xml = fs.readFileSync(f.path, 'utf8');
    const ids = extractResourceIdsFromDump(xml);
    let fromLiveFailureScreen = false;
    if (isFailureDumpFile(f.path)) {
      failureXmlCache.set(f.path, xml);
      const superseded = isSupersededFailureDump(f, allFiles);
      const nonApp = isNonAppSurfaceDump(xml);
      if (superseded || nonApp) {
        excludedFailureDumps.push({
          file: path.relative(args.dumpDir, f.path),
          reason: superseded ? 'superseded' : 'non-app-surface',
        });
      } else {
        fromLiveFailureScreen = true;
      }
    }
    for (const id of ids) {
      observed.add(id);
      if (fromLiveFailureScreen) observedOnFailure.add(id);
    }
  }

  const mapped = loadSelectorMapIds(fs.readFileSync(mapPath, 'utf8'));
  const diff = diffResourceIds(observed, mapped);
  const failureScreenCandidates = failureScreenDriftSuspects(observedOnFailure, mapped);

  // Make dump-file paths relative to the dump dir so the report stays
  // readable when the absolute path is deep.
  const relativeDumpFiles = dumpFiles.map((f) => path.relative(args.dumpDir, f.path));

  const report = renderReportMarkdown({
    apkVersion: args.apkVersion,
    dumpFiles: relativeDumpFiles,
    onlyInDumps: diff.onlyInDumps,
    onlyInMap: diff.onlyInMap,
    inBoth: diff.inBoth,
    failureScreenCandidates,
    excludedFailureDumps,
  });

  if (args.outPath) {
    fs.writeFileSync(args.outPath, report);
    process.stderr.write(
      `wrote report to ${args.outPath} (${diff.onlyInDumps.length} new, ${diff.onlyInMap.length} orphan, ${diff.inBoth.length} matched, ${failureScreenCandidates.length} failure-screen suspect(s))\n`,
    );
  } else {
    process.stdout.write(report);
  }

  if (args.yamlOutPath) {
    const failureDumps = dumpFiles.filter((f) => isFailureDumpFile(f.path));
    if (failureDumps.length === 0) {
      process.stderr.write('no *-FAILURE.xml under the dump dir; skipping yaml report\n');
    } else {
      // Which failure dump describes the walk we actually care about?
      //
      // Newest-by-mtime is the right tiebreak (several FAILURE dumps can sit
      // under one root, one per recipe dir, and alphabetical order has no
      // relation to recency) — but it is applied only among dumps that still
      // MEAN something. `selectFailureDumpForClassification` drops the two
      // classes of noise that make the verdict lie (ace#1571): a dump a later
      // passing dispatch superseded, and a dump of the home screen / system
      // chrome rather than an app screen. Both used to come out as
      // `unmapped-surface`, which the skills route straight to
      // `skills/selector-map-heal`.
      const selection = selectFailureDumpForClassification(
        failureDumps.map((f) => ({
          path: f.path,
          mtimeMs: f.mtimeMs,
          xml: failureXmlCache.get(f.path) ?? '',
          siblings: allFiles,
        })),
      );
      const selected = selection.selected!;
      const dumpPath = selected.path;
      const stderrPath = dumpPath.replace(/\.xml$/, '.txt');
      const stderrExcerpt = fs.existsSync(stderrPath)
        ? fs.readFileSync(stderrPath, 'utf8')
        : '';
      const result = classifyScreenCoverage({
        dumpXml: failureXmlCache.get(dumpPath) ?? fs.readFileSync(dumpPath, 'utf8'),
        selectorMapYaml: fs.readFileSync(mapPath, 'utf8'),
        wanted: extractWantedMatchers(stderrExcerpt),
        superseded: selected.superseded,
      });
      fs.writeFileSync(
        args.yamlOutPath,
        renderReportYaml({
          apkVersion: args.apkVersion,
          dumpFile: path.basename(dumpPath),
          result,
          skipped: selection.skipped.map((s) => ({
            path: path.relative(args.dumpDir, s.path),
            reason: s.reason,
          })),
        }),
        'utf8',
      );
      // Print it too: a caller that never opens the file still sees the verdict.
      process.stdout.write(
        `atlas: ${result.classification} on ${path.basename(dumpPath)}` +
          (result.classification === 'unmapped-surface' ? ' — tier 2 warranted\n' : '\n'),
      );
      if (selection.skipped.length > 0) {
        process.stderr.write(
          `atlas: skipped ${selection.skipped.length} failure dump(s): ` +
            selection.skipped
              .map((s) => `${path.relative(args.dumpDir, s.path)} (${s.reason})`)
              .join(', ') +
            '\n',
        );
      }
    }
  }
}

main();
