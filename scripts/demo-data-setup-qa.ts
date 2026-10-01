#!/usr/bin/env npx tsx
/**
 * demo-data-setup-qa — run the static checks and WRITE THE RESULT, always.
 *
 *   npx tsx scripts/demo-data-setup-qa.ts \
 *     --run-state <local run_state.yaml> --realized <local realized.json> \
 *     [--story <local cascade-story.yaml>] [--history <workflow_history_runs JSON>] \
 *     [--outcomes <JSON: [{check, result:{pass,detail,auto_fix_hint}} | {check, not_judged}]>] \
 *     --target <opp>/<run> --out <local demo-data-setup-qa_result.yaml>
 *
 * Why a script (ace QA gaps, 2026-10-01): on bednet-check-2-visit/20260908-1544
 * the gate ran 19 checks and wrote them in a hand-rolled shape (`checks_total`,
 * `checks[]`) that no reader parses — ace-web showed "Passed (0/0 checks)". On
 * spark-facilitator/20260926-1800 (ace-run provider) the gate was never run and
 * no result was written. This script:
 *
 *   - computes every check it can from local files (the realized handoff, the
 *     run_state synthetic block, the cascade story + saved-run history);
 *   - merges in the outcomes of checks the skill ran itself against live labs
 *     (`--outcomes`);
 *   - FAILS every check that applies to the provider (`checksForProvider`) but
 *     was neither computed nor supplied — a missing input is a failed check,
 *     not a skipped one;
 *   - writes the canonical `lib/qa-types.ts` shape via `aggregateQAResult`,
 *     which fails a result that evaluated nothing.
 *
 * Prints `{verdict, stats, out}` on the last stdout line. Exit 0 whatever the
 * verdict — the skill reads the verdict; a non-zero exit means the script
 * itself could not run.
 */

import * as fs from 'node:fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { aggregateQAResult, type QACheckOutcome, type QACheckResult } from '../lib/qa-types.js';
import {
  cascadeDashboards,
  checkCascadeHandoff,
  checkCascadeStory,
  checkParUrlScope,
  checkRealizedFlat,
  checksForProvider,
  checkWorkerReviewUrlScope,
  periodsFromHistoryRuns,
  type SyntheticProducts,
} from '../skills/demo-data-setup-qa/checks.js';
import type { CascadeStoryPlan } from '../lib/cascade-story.js';

const args = process.argv.slice(2);
function arg(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}
function need(name: string): string {
  const v = arg(name);
  if (!v) {
    process.stderr.write(`demo-data-setup-qa: missing --${name}\n`);
    process.exit(2);
  }
  return v as string;
}
function readText(path: string | undefined): string | null {
  if (!path) return null;
  try {
    return fs.readFileSync(path, 'utf8').replace(/^﻿/, '');
  } catch {
    return null;
  }
}

const runState = parseYaml(readText(need('run-state')) ?? '') as Record<string, unknown> | null;
const synthetic = ((((runState?.phases as Record<string, unknown> | undefined)?.['synthetic-data-and-workflows'] as
  | Record<string, unknown>
  | undefined)?.products as Record<string, unknown> | undefined)?.synthetic ?? null) as SyntheticProducts | null;
const provider = synthetic?.provider ?? null;

const realizedText = readText(arg('realized'));
let realized: Record<string, unknown> | null = null;
let realizedError = '';
try {
  realized = realizedText ? (JSON.parse(realizedText) as Record<string, unknown>) : null;
} catch (e) {
  realizedError = (e as Error).message;
}

const computed = new Map<string, QACheckResult>();
computed.set(
  'realized_json_parses',
  realizedError ? { pass: false, detail: `realized.json does not parse: ${realizedError}`, auto_fix_hint: 're-write the flat handoff' } : checkRealizedFlat(realized),
);
if (provider === 'ace-run') {
  const dashboards = cascadeDashboards(synthetic);
  computed.set(
    'every_par_url_is_run_deeplink',
    dashboards.length ? checkParUrlScope(dashboards) : { pass: false, detail: 'the cascade records no report URLs', auto_fix_hint: 'record programme_report.url and each opp_reports[].url' },
  );
  if (realized) computed.set('worker_review_url_scoped', checkWorkerReviewUrlScope(realized));
  computed.set('cascade_handoff_complete', checkCascadeHandoff(synthetic));
  const storyText = readText(arg('story'));
  const historyText = readText(arg('history'));
  if (storyText && historyText) {
    const plan = parseYaml(storyText) as CascadeStoryPlan;
    const periods = periodsFromHistoryRuns(JSON.parse(historyText));
    computed.set('cascade_story_landed', checkCascadeStory(plan, synthetic?.cascade?.registry?.indicators ?? [], periods));
  }
}

const supplied = new Map<string, QACheckOutcome>();
const outcomesText = readText(arg('outcomes'));
if (outcomesText) for (const o of JSON.parse(outcomesText) as QACheckOutcome[]) supplied.set(o.check, o);

const outcomes: QACheckOutcome[] = [];
const applicable = checksForProvider(provider);
if (!provider || applicable.length === 0) {
  outcomes.push({
    check: 'provider_is_known',
    result: {
      pass: false,
      detail: `products.synthetic.provider is ${JSON.stringify(provider)} — not ace-run / denovo / clone, so no check set applies`,
      auto_fix_hint: 'write products.synthetic.provider (demo-data-setup) before running the gate',
    },
  });
}
for (const id of applicable) {
  const mine = computed.get(id);
  const theirs = supplied.get(id);
  if (mine) outcomes.push({ check: id, result: mine });
  else if (theirs) outcomes.push(theirs);
  else {
    outcomes.push({
      check: id,
      result: {
        pass: false,
        detail: `applies to the ${provider} provider but was not evaluated (no input / no outcome supplied)`,
        auto_fix_hint: `run check ${id} (skills/demo-data-setup-qa § Checks) and pass its outcome via --outcomes, or supply the input it needs`,
      },
    });
  }
}
// Outcomes for checks outside the provider set (e.g. spec-dependent rows) are kept as reported.
for (const [id, o] of supplied) if (!applicable.includes(id)) outcomes.push(o);

const result = aggregateQAResult({
  skill: 'demo-data-setup-qa',
  target: need('target'),
  capture_path: '7-synthetic/realized.json',
  outcomes,
});
const out = need('out');
fs.writeFileSync(out, stringifyYaml(result, { lineWidth: 0 }));
process.stdout.write(JSON.stringify({ verdict: result.verdict, stats: result.stats, provider, out }) + '\n');
