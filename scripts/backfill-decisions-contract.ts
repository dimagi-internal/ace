#!/usr/bin/env node
/**
 * Upgrade an existing run's decisions.yaml to the v6 review contract
 * (docs/decisions-contract.md) — `lib/decisions-backfill.ts`.
 *
 *   node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/backfill-decisions-contract.ts" \
 *     --decisions <decisions.yaml> --run-state <run_state.yaml> \
 *     [--source-decisions <fork source run's decisions.yaml>] \
 *     [--memo <build memo exported as text/markdown>] \
 *     [--overlay <overlay.json>] \
 *     --out <upgraded decisions.yaml> [--report <report.json>]
 *
 * Local files only: read them with `drive_read_file writeToPath` (the YAML
 * with the default text/plain export, the memo with `exportAs: text/markdown`)
 * and write the result back with `drive_update_file localFilePath`, after
 * binding the session to the opp (`bin/ace-bind <ws>/<opp>`). Then re-render
 * the Doc with `render_decisions_log`.
 *
 * The overlay is JSON: `{ rows: { <id>: { plain?, check_at?,
 * correct_looks_like?, audience? } }, successors: { <inherited id>: <re-run
 * id> }, reaffirmed: [<inherited id>] }` — hand-written plain wording for rows
 * the memo never covered, and inherited-row calls the memo does not make.
 *
 * Exit 0 = written; 1 = the result still has live partner rows without
 * `plain` or with jargon (written anyway; the report names them); 2 = usage.
 */
import * as fs from 'node:fs';
import { parse as parseYaml } from 'yaml';

import { backfillDecisionsLog, harvestMemo, type BackfillOverlay } from '../lib/decisions-backfill.js';
import { reviewAskRows } from '../lib/decisions-enrich.js';
import { parseDecisionsYaml, serializeDecisionsLog } from '../lib/decisions-schema.js';

const args: Record<string, string> = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--') || argv[i + 1] === undefined) {
    process.stderr.write(`backfill-decisions-contract: bad argument ${a}\n`);
    process.exit(2);
  }
  args[a.slice(2)] = argv[++i];
}
for (const k of ['decisions', 'run-state', 'out']) {
  if (!args[k]) {
    process.stderr.write(`backfill-decisions-contract: --${k} is required\n`);
    process.exit(2);
  }
}

const read = (p: string) => fs.readFileSync(p, 'utf8').replace(/^﻿/, '').replace(/\r/g, '');

const { log, report } = backfillDecisionsLog({
  log: parseDecisionsYaml(read(args.decisions)),
  runState: parseYaml(read(args['run-state'])),
  sourceLog: args['source-decisions'] ? parseDecisionsYaml(read(args['source-decisions'])) : undefined,
  memo: args.memo ? harvestMemo(read(args.memo)) : undefined,
  overlay: args.overlay ? (JSON.parse(read(args.overlay)) as BackfillOverlay) : undefined,
});

fs.writeFileSync(args.out, serializeDecisionsLog(log));
const summary = {
  ...report,
  reviewAsks: reviewAskRows(log).map((r) => ({ id: r.id, plain: r.plain, confirm_reason: r.confirm_reason })),
  live: log.decisions.filter((d) => d.superseded_by === undefined).length,
  total: log.decisions.length,
};
if (args.report) fs.writeFileSync(args.report, JSON.stringify(summary, null, 2));
process.stdout.write(
  `backfill: ${summary.total} rows (${summary.live} live); ` +
    `retired ${(report.retire?.supersededBy.length ?? 0) + (report.retire?.retired.length ?? 0)} inherited; ` +
    `memo filled ${report.fromMemo.length}; overlay filled ${report.fromOverlay.length}; ` +
    `${summary.reviewAsks.length} review ask(s); ` +
    `${report.enrich.missingPlain.length} live partner row(s) without plain; ${report.enrich.jargon.length} jargon finding(s)\n`,
);
for (const a of summary.reviewAsks) process.stdout.write(`  ASK ${a.id}: ${a.plain} — ${a.confirm_reason}\n`);
if (report.unknownIds.length) process.stdout.write(`  unknown ids: ${report.unknownIds.join(', ')}\n`);
if (report.enrich.missingPlain.length) process.stdout.write(`  missing plain: ${report.enrich.missingPlain.join(', ')}\n`);
for (const j of report.enrich.jargon) process.stdout.write(`  jargon: ${j}\n`);
process.exit(report.enrich.missingPlain.length || report.enrich.jargon.length ? 1 : 0);
