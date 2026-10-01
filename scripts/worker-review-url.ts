#!/usr/bin/env node
/**
 * Build (or repair) the `*worker_review_url` entries of a Phase 7 realized.json
 * — the only sanctioned way to write one (`lib/worker-review-url.ts`,
 * dimagi-internal/ace#2521). Called from `skills/demo-data-setup` § C7.
 *
 *   # build: prints a JSON object of <key>: <url>, ready to merge into realized.json
 *   node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/worker-review-url.ts" \
 *     --run-state <local run_state.yaml> --carriers <carriers.json>
 *
 *   # repair in place: rebuilds every *worker_review_url already in the file
 *   node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/worker-review-url.ts" \
 *     --fix <local realized.json>
 *
 * carriers.json: `[{"keyPrefix": "", "opportunityId": 10084, "username": "cbf_c11"},
 *                  {"keyPrefix": "standout_worker", "opportunityId": 10083, "username": "cbf_b03"}]`
 * (`""` → `worker_review_url`; `standout_worker` → `standout_worker_review_url`).
 *
 * Exit 0 ok, 1 a URL could not be built, 2 usage.
 */
import * as fs from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { rescopeWorkerReviewUrl, workerReviewUrls, type WorkerCarrier } from '../lib/worker-review-url.js';

let runStatePath: string | undefined;
let carriersPath: string | undefined;
let fixPath: string | undefined;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--run-state') runStatePath = argv[++i];
  else if (a === '--carriers') carriersPath = argv[++i];
  else if (a === '--fix') fixPath = argv[++i];
  else {
    process.stderr.write(`worker-review-url: unknown argument ${a}\n`);
    process.exit(2);
  }
}

const read = (p: string) => fs.readFileSync(p, 'utf8').replace(/^﻿/, '');

try {
  if (fixPath) {
    const realized = JSON.parse(read(fixPath)) as Record<string, unknown>;
    const changed: string[] = [];
    for (const key of Object.keys(realized)) {
      if (!/(^|_)worker_review_url$/.test(key)) continue;
      const next = rescopeWorkerReviewUrl(String(realized[key]));
      if (next !== realized[key]) changed.push(key);
      realized[key] = next;
    }
    fs.writeFileSync(fixPath, JSON.stringify(realized, null, 2) + '\n');
    process.stdout.write(`rebuilt ${changed.length} worker_review_url(s)${changed.length ? `: ${changed.join(', ')}` : ''}\n`);
  } else if (runStatePath && carriersPath) {
    const rs = parseYaml(read(runStatePath)) as Record<string, any>;
    const cascade = rs?.phases?.['synthetic-data-and-workflows']?.products?.synthetic?.cascade;
    if (!cascade?.worker_review?.workflow_id || !cascade?.program_id) {
      throw new Error('run_state has no products.synthetic.cascade.{program_id, worker_review} — write § C7 cascade first');
    }
    const carriers = JSON.parse(read(carriersPath)) as WorkerCarrier[];
    process.stdout.write(JSON.stringify(workerReviewUrls(cascade, carriers), null, 2) + '\n');
  } else {
    process.stderr.write('worker-review-url: need --fix <realized.json>, or --run-state <yaml> --carriers <json>\n');
    process.exit(2);
  }
} catch (e) {
  process.stderr.write(`worker-review-url: ${(e as Error).message}\n`);
  process.exit(1);
}
