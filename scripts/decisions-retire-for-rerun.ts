#!/usr/bin/env node
/**
 * Retire a run's inherited decision rows for the phases it is about to re-run
 * (`retireForRerun`, lib/decisions-rerun.ts) — so the re-run producer's
 * appends land under the canonical ids and a row it does not re-emit stays
 * history instead of silently beating the re-run.
 *
 *   node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/decisions-retire-for-rerun.ts" \
 *     --decisions <decisions.yaml> (--phase-tags 4-connect[,5-ocs] | --from-ordinal 3) \
 *     --label <id suffix, e.g. the source run id or workspace> [--inherited-from <ws>/<run>] \
 *     --out <decisions.yaml>
 *
 * Used by `clone-to-new-workspace` Step 4b (before Phase 4 re-runs in the
 * target) and `fork-run` (a fork whose decisions.yaml came from an ace-web
 * deploy older than ace#2582). Local files only: read with `drive_read_file
 * writeToPath`, write back with `drive_update_file localFilePath`.
 *
 * Exit 0 = written; 2 = usage.
 */
import * as fs from 'node:fs';

import { retireForRerun } from '../lib/decisions-rerun.js';
import { parseDecisionsYaml, serializeDecisionsLog } from '../lib/decisions-schema.js';

const a: Record<string, string> = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) {
  if (!argv[i].startsWith('--') || argv[i + 1] === undefined) {
    process.stderr.write(`decisions-retire-for-rerun: bad argument ${argv[i]}\n`);
    process.exit(2);
  }
  a[argv[i].slice(2)] = argv[i + 1];
}
if (!a.decisions || !a.out || !a.label || (!a['phase-tags'] && !a['from-ordinal'])) {
  process.stderr.write('decisions-retire-for-rerun: need --decisions, --label, --out and --phase-tags or --from-ordinal\n');
  process.exit(2);
}
if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(a.label)) {
  process.stderr.write('decisions-retire-for-rerun: --label must be kebab-case (it becomes part of row ids)\n');
  process.exit(2);
}

const { log, report } = retireForRerun(
  parseDecisionsYaml(fs.readFileSync(a.decisions, 'utf8').replace(/^﻿/, '').replace(/\r/g, '')),
  {
    label: a.label,
    inheritedFrom: a['inherited-from'],
    phaseTags: a['phase-tags'] ? a['phase-tags'].split(',').map((s) => s.trim()) : undefined,
    fromOrdinal: a['from-ordinal'] ? Number(a['from-ordinal']) : undefined,
  },
);
fs.writeFileSync(a.out, serializeDecisionsLog(log));
process.stdout.write(`retired ${report.retired.length} row(s); kept ${report.keptLive.length} human ruling(s) live\n`);
for (const [from, to] of report.retired) process.stdout.write(`  ${from} -> ${to}\n`);
