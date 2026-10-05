#!/usr/bin/env npx tsx
/**
 * Relink an artifact after `workflow_rebuild_history` minted new run ids (ace#2700).
 *
 *   npx tsx scripts/relink-rebuilt-history.ts --before BEFORE.json --after AFTER.json \
 *     [--in FILE --out FILE [--bare]] [--map-out MAP.json]
 *
 * BEFORE / AFTER: `[{ "workflowId": <id>, "runs": [{ "run_id", "period_end" }, …] }, …]` —
 * one entry per workflow (the programme report and every opp report it hands
 * down to), copied from `workflow_history_runs(generated_only: false)` before
 * and after the rebuild. Prints the old→new map as JSON. With --in/--out,
 * rewrites that file (URL params and run_id fields; --bare also rewrites prose
 * ids) and exits 1 if any old id is still present in the output.
 */
import fs from 'node:fs';
import { buildRunIdMap, relinkText, type HistoryListing } from '../lib/history-relink';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function need(name: string): string {
  const v = arg(name);
  if (!v) {
    console.error(`relink-rebuilt-history: --${name} is required`);
    process.exit(2);
  }
  return v;
}

const before = JSON.parse(fs.readFileSync(need('before'), 'utf8')) as HistoryListing[];
const after = JSON.parse(fs.readFileSync(need('after'), 'utf8')) as HistoryListing[];
const map = buildRunIdMap(before, after);
const mapObj = Object.fromEntries([...map.entries()].map(([k, v]) => [String(k), v]));
const mapOut = arg('map-out');
if (mapOut) fs.writeFileSync(mapOut, JSON.stringify(mapObj, null, 2) + '\n');

const input = arg('in');
if (!input) {
  console.log(JSON.stringify({ map: mapObj }));
  process.exit(0);
}
const r = relinkText(fs.readFileSync(input, 'utf8'), map, { bare: process.argv.includes('--bare') });
fs.writeFileSync(need('out'), r.text);
console.log(JSON.stringify({ map: mapObj, file: input, replaced: r.replaced, leftovers: r.leftovers }));
process.exit(r.leftovers.length ? 1 : 0);
