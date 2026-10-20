#!/usr/bin/env node
/**
 * Write the two build-half products the Phase 7 cascade owes the artifact
 * manifest (ace#3251; `lib/cascade-build-artifacts.ts`). Called from
 * `skills/demo-data-setup` § C7, after `products.synthetic.cascade` and
 * `products.synthetic.workflows` are in run_state.
 *
 *   node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/cascade-build-artifacts.ts" \
 *     --run-state <local run_state.yaml> --registry <7-synthetic/semantic-registry-author_registry.json> \
 *     --out-dir <local dir>
 *
 * Writes `<out-dir>/demo-data-setup_manifest.yaml` (the index of the per-partner
 * manifests archived under 7-synthetic/cascade-build/) and
 * `<out-dir>/dashboard-terms.yaml` (step 3d, from the registry's labels, one
 * block per report in products.synthetic.workflows plus the worker review).
 * Upload both to 7-synthetic/. Prints `{index, terms, partners, dashboards}`.
 *
 * Exit 0 ok, 1 the run_state has no cascade block, 2 usage.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  buildCascadeDashboardTerms,
  buildCascadeManifestIndex,
  type CascadeArtifactsInput,
} from '../lib/cascade-build-artifacts.js';

let runStatePath: string | undefined;
let registryPath: string | undefined;
let outDir: string | undefined;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--run-state') runStatePath = argv[++i];
  else if (a === '--registry') registryPath = argv[++i];
  else if (a === '--out-dir') outDir = argv[++i];
  else {
    process.stderr.write(`cascade-build-artifacts: unknown argument ${a}\n`);
    process.exit(2);
  }
}
if (!runStatePath || !registryPath || !outDir) {
  process.stderr.write('usage: cascade-build-artifacts --run-state <yaml> --registry <json> --out-dir <dir>\n');
  process.exit(2);
}

const read = (p: string) => fs.readFileSync(p, 'utf8').replace(/^﻿/, '');
const runState = parseYaml(read(runStatePath)) as Record<string, any> | null;
const synthetic = runState?.phases?.['synthetic-data-and-workflows']?.products?.synthetic as
  | { cascade?: CascadeArtifactsInput & { worker_review?: unknown }; workflows?: Record<string, unknown> }
  | undefined;
const cascade = synthetic?.cascade;
if (!cascade) {
  process.stderr.write('cascade-build-artifacts: run_state has no products.synthetic.cascade (demo-data-setup § C7 writes it first)\n');
  process.exit(1);
}
const registry = JSON.parse(read(registryPath)) as unknown;

const keys = Object.keys(synthetic?.workflows ?? {});
if (cascade.worker_review && !keys.includes('worker_review')) keys.push('worker_review');
if (keys.length === 0) keys.push('programme_report');

const index = buildCascadeManifestIndex(cascade);
const terms = buildCascadeDashboardTerms(registry, keys);

fs.mkdirSync(outDir, { recursive: true });
const indexOut = path.join(outDir, 'demo-data-setup_manifest.yaml');
const termsOut = path.join(outDir, 'dashboard-terms.yaml');
fs.writeFileSync(indexOut, stringifyYaml(index, { lineWidth: 0 }));
fs.writeFileSync(termsOut, stringifyYaml(terms, { lineWidth: 0 }));
process.stdout.write(
  JSON.stringify({ index: indexOut, terms: termsOut, partners: index.partners.map((p) => p.manifest), dashboards: keys }) + '\n',
);
