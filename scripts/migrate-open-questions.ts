#!/usr/bin/env node
/**
 * Fold an opp's legacy open-questions ledger into decision rows — once per
 * opp. This tool (with lib/open-questions-migrate.ts) is the ONLY code in ACE
 * that reads a ledger; no run does (ace#2757). `lib/open-questions-migrate.ts`; spec § 6
 * (docs/superpowers/specs/2026-10-04-open-questions-into-decisions-design.md).
 *
 * DRY-RUN (default) — propose a category per open row, with evidence:
 *
 *   node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/migrate-open-questions.ts" \
 *     --ledger <open-questions.md, read with exportAs text/markdown> \
 *     --decisions <the latest run's decisions.yaml> --opp <opp> --run <run-id> \
 *     [--write-template <classification.json>] [--json]
 *
 * The proposal is DETERMINISTIC (same id → text similarity → keyword cues on
 * the row's own owner / blocking fields) and is never an LLM's call. A human
 * confirms or corrects every row in the template — A needs `decision_id`; B, C
 * and E need the default the build took (`row["ai-default"]`, quoted from
 * `row.source`) and plain wording; D needs a `route`.
 *
 * APPLY — build the rows from the reviewed classification:
 *
 *   ... --apply --classification <reviewed.json> \
 *     --out-rows <rows.json> --out-archive <open-questions.archived.md>
 *
 * Writes the two local files only when every row validates (strict write
 * schema + the outsider plain-language check) and every open row is
 * classified; otherwise prints each refusal and writes nothing (exit 1). Then,
 * in a session bound to the opp (`bin/ace-bind <ws>/<opp>`):
 *   1. `decisions_append_rows(runFolderId, opportunity, run_id, rows: <rows.json>)`
 *      — the sanctioned writer; saved rulings bind there as usual;
 *   2. `decisions_enrich` + `render_decisions_log`. Nothing else is written
 *      for open asks: they are a filter over decisions.yaml, never a file
 *      (operator decision 2026-10-07, ace#2757);
 *   3. replace the ledger's body with <open-questions.archived.md>
 *      (`drive_update_file`) and rename it `open-questions.archived.md`
 *      (`drive_rename_file`);
 *   4. create what each printed D action names (a task, a residual, an issue,
 *      a solicitation question) — nothing D is written to decisions.
 *
 * Local files only, like scripts/backfill-decisions-contract.ts: read them
 * with `drive_read_file writeToPath`.
 *
 * Exit 0 = ok; 1 = refused (nothing written); 2 = usage.
 */
import * as fs from 'node:fs';

import { parseDecisionsYaml } from '../lib/decisions-schema.js';
import {
  buildMigration,
  classificationTemplate,
  proposeClassification,
  readLedgerOpenRows,
  renderArchivedLedger,
  renderProposals,
  type Classification,
  type OpenQuestionsReadExport,
} from '../lib/open-questions-migrate.js';

const args: Record<string, string> = {};
const flags = new Set<string>();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--apply' || a === '--json') {
    flags.add(a.slice(2));
    continue;
  }
  if (!a.startsWith('--') || argv[i + 1] === undefined) {
    process.stderr.write(`migrate-open-questions: bad argument ${a}\n`);
    process.exit(2);
  }
  args[a.slice(2)] = argv[++i];
}
const need = (k: string) => {
  if (!args[k]) {
    process.stderr.write(`migrate-open-questions: --${k} is required\n`);
    process.exit(2);
  }
  return args[k];
};

const read = (p: string) => fs.readFileSync(p, 'utf8').replace(/^﻿/, '');
const ledgerText = read(need('ledger'));
const ledger = readLedgerOpenRows(ledgerText, (args.export as OpenQuestionsReadExport | undefined) ?? 'text/markdown');
const log = parseDecisionsYaml(read(need('decisions')).replace(/\r/g, ''));
const opp = args.opp ?? log.opportunity;
const runId = args.run ?? log.run_id;
const proposals = proposeClassification(ledger, log);

if (!flags.has('apply')) {
  process.stdout.write(flags.has('json') ? `${JSON.stringify(proposals, null, 2)}\n` : `${renderProposals(proposals)}\n`);
  if (args['write-template']) {
    fs.writeFileSync(args['write-template'], `${JSON.stringify(classificationTemplate({ opp, runId, proposals, ledger }), null, 2)}\n`);
    process.stdout.write(`\ntemplate: ${args['write-template']} — confirm every row, fill every TODO, then re-run with --apply --classification.\n`);
  }
  process.stdout.write('\nDRY RUN — nothing written.\n');
  process.exit(0);
}

const classification = JSON.parse(read(need('classification'))) as Classification;
if (classification.opp !== opp) {
  process.stderr.write(`migrate-open-questions: classification is for ${classification.opp}, the decisions log for ${opp}\n`);
  process.exit(1);
}
const migratedOn = new Date().toISOString().slice(0, 10);
const result = buildMigration({ classification, ledger, log, migratedOn });
const todo = JSON.stringify(classification).includes('TODO');
if (todo) result.errors.push('the classification still contains TODO placeholders');
if (result.errors.length) {
  process.stderr.write(`REFUSED — ${result.errors.length} problem(s); nothing written:\n`);
  for (const e of result.errors) process.stderr.write(`  ${e}\n`);
  process.exit(1);
}
fs.writeFileSync(need('out-rows'), `${JSON.stringify(result.rows, null, 2)}\n`);
fs.writeFileSync(need('out-archive'), renderArchivedLedger({ original: ledgerText, mapping: result.mapping, migratedOn, runId }));
process.stdout.write(`apply: ${result.rows.length} decision row(s) → ${args['out-rows']}; archive → ${args['out-archive']}\n`);
for (const m of result.mapping) process.stdout.write(`  ${m.category} ${m.id} → ${m.to}\n`);
for (const a of result.actions) process.stdout.write(`  ACTION (${a.route}) ${a.id}: ${a.note}\n`);
process.exit(0);
