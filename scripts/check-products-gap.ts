/**
 * check-products-gap.ts — dimagi-internal/ace#1888.
 *
 * Reports upstream phases that assert completion without writing the typed
 * `products` handoff downstream phases dereference. That is what a forked or
 * otherwise seeded run looks like: ace-web's fork copies phase artifacts and
 * phase STATUSES, but no `products` block.
 *
 * Usage:
 *   npx tsx scripts/check-products-gap.ts <path-to-run_state.yaml> [--label <run-id>]
 *
 * The path is LOCAL. Fetch the run_state first — e.g.
 * `drive_read_file(fileId, writeToPath: '/tmp/run_state.yaml')`, which costs
 * zero context — then point this at it.
 *
 * Reads no credentials, so it needs no `loadPluginEnv` (see
 * `lib/bash-reachable-scripts.ts` for the rule this is exempt from).
 *
 * Exit codes:
 *   0 — no gaps
 *   1 — gaps found AND phases remain pending (the resume-blocking case)
 *   2 — gaps found but nothing left to dispatch (advisory), or a harness error
 *       (bad path, unparseable YAML). Distinguish by the printed STATUS line.
 */

import fs from 'node:fs';
import yaml from 'yaml';
import {
  classifyUpstreamProductsGaps,
  formatUpstreamProductsGapReport,
} from '../lib/upstream-products-gap.js';

function main(): void {
  const argv = process.argv.slice(2);
  const labelIdx = argv.indexOf('--label');
  const runLabel = labelIdx >= 0 ? argv[labelIdx + 1] : undefined;
  const filePath = argv.find((a, i) => !a.startsWith('--') && i !== labelIdx + 1);

  if (!filePath) {
    console.error('usage: npx tsx scripts/check-products-gap.ts <run_state.yaml> [--label <run-id>]');
    process.exit(2);
  }
  if (!fs.existsSync(filePath)) {
    console.error(`HARNESS ERROR: no such file: ${filePath}`);
    process.exit(2);
  }

  let parsed: unknown;
  try {
    parsed = yaml.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    console.error(`HARNESS ERROR: could not parse YAML at ${filePath}: ${e}`);
    process.exit(2);
  }

  const report = classifyUpstreamProductsGaps(parsed);

  if (report.ok) {
    console.log('STATUS: products-gap OK — every terminal phase carries its typed handoff.');
    process.exit(0);
  }

  console.log(formatUpstreamProductsGapReport(report, { runLabel }));
  console.log('');
  console.log(
    report.blocking
      ? `STATUS: products-gap BLOCKING (${report.gaps.length} gap(s), ${report.pendingPhases.length} phase(s) still pending)`
      : `STATUS: products-gap ADVISORY (${report.gaps.length} gap(s), nothing left to dispatch)`,
  );
  process.exit(report.blocking ? 1 : 2);
}

main();
