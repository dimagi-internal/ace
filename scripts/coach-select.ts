/**
 * Who a Coach starts with on a report whose design sets no targets (ace#3053).
 *
 *   npx tsx scripts/coach-select.ts --indicators <workflow_run_indicators JSON> \
 *     --measures <registry measures JSON array> --program "<programme>" --workers <plural noun> \
 *     [--named "Name One,kg_user2,..."] [--out <worker items JSON>]
 *
 * --indicators is a saved `workflow_run_indicators(run_id, scope: "worker", limit: 500)`
 * response; --measures is `indicators_doc.measures` from `semantic_registry_get`.
 *
 * Prints the selection mode (`band` | `peer_watch` | `named` | `none`) and why. For
 * `peer_watch` / `named` it writes the `workers` array for `workflow_run_action`
 * (`initiate_ai_coach`): `{key, indicators, prompt}` per worker, the prompt being a
 * Labs-shaped briefing Labs keeps as-is. Exits 2 on `none` — nobody to coach is a
 * stop, not a pass: ask the supervisor for names and re-run with --named.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { renderSelectionBriefing, selectCoachingWorkers } from '../lib/coach-peer-watch.js';

const { values } = parseArgs({
  options: {
    indicators: { type: 'string' },
    measures: { type: 'string' },
    program: { type: 'string' },
    workers: { type: 'string' },
    named: { type: 'string' },
    out: { type: 'string' },
  },
});
for (const k of ['indicators', 'measures', 'program', 'workers'] as const) {
  if (!values[k]) throw new Error(`--${k} is required`);
}

const run = JSON.parse(readFileSync(values.indicators!, 'utf8'));
if (run.truncated) throw new Error('--indicators is truncated: re-read with a higher limit, peers must be the whole run');
const measures = JSON.parse(readFileSync(values.measures!, 'utf8'));
const named = (values.named ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const sel = selectCoachingWorkers({ workers: run.workers ?? [], measures, named });
console.log(`mode: ${sel.mode} (${sel.workers.length} worker(s))`);
for (const r of sel.reasons) console.log(`  ${r}`);

if (sel.mode === 'peer_watch' || sel.mode === 'named') {
  const items = sel.workers.map((w) => ({
    key: w.key,
    indicators: w.topics.map((t) => t.key),
    prompt: renderSelectionBriefing({
      programName: values.program!,
      workerPlural: values.workers!,
      worker: w,
      mode: sel.mode as 'peer_watch' | 'named',
    }),
  }));
  for (const w of sel.workers) {
    console.log(`  ${w.name} (${w.key}): ${w.topics.map((t) => t.key).join(', ') || 'no comparable figure'}`);
  }
  if (values.out) writeFileSync(values.out, JSON.stringify(items, null, 2));
}
if (sel.mode === 'none') process.exit(2);
