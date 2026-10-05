#!/usr/bin/env -S npx tsx
/**
 * Print the ordered `benchmarks_publish` calls to make after a history rebuild
 * (dimagi-internal/ace#2717). Pure planning — makes no labs call.
 *
 *   plan-benchmark-republish.ts --cohort 41 --workflow 7187 --program 10097 \
 *     --before before.json --after after.json [--cadence weekly|daily]
 *
 * before/after are the programme report's `workflow_history_runs(...,
 * generated_only: false)` runs as `[{run_id, period_end}]`. Exits 1 (and
 * publishes nothing) when a period is missing — see lib/benchmark-republish.ts.
 */
import { readFileSync } from 'node:fs';
import { planBenchmarkRepublish, type HistoryRun } from '../lib/benchmark-republish.js';

function arg(name: string, required = true): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (required && !v) {
    console.error(`missing --${name}`);
    process.exit(2);
  }
  return v;
}

function runs(path: string): HistoryRun[] {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  const list = Array.isArray(raw) ? raw : (raw as { runs?: unknown }).runs;
  if (!Array.isArray(list)) throw new Error(`${path}: expected an array of {run_id, period_end} (or {runs: [...]})`);
  return list.map((r: { run_id: number; period_end: string }) => ({ run_id: Number(r.run_id), period_end: String(r.period_end) }));
}

try {
  const cadence = arg('cadence', false);
  const plan = planBenchmarkRepublish({
    cohortId: Number(arg('cohort')),
    workflowId: Number(arg('workflow')),
    programId: Number(arg('program')),
    before: runs(arg('before')!),
    after: runs(arg('after')!),
    cadence: cadence === 'daily' ? 'daily' : 'weekly',
  });
  console.log(JSON.stringify(plan, null, 2));
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
