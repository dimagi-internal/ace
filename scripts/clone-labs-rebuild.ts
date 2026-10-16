#!/usr/bin/env npx tsx
/**
 * The local arithmetic of `clone-to-new-workspace` § 4c (ace#3020) — rebuild
 * the source run's Phase 7 Labs assets in the clone's own labs program.
 * Makes no labs call itself; logic in lib/clone-labs-rebuild.ts.
 *
 *   npx tsx scripts/clone-labs-rebuild.ts inspect --run-state <source run_state.yaml>
 *     → what to rebuild: {program_id, partners[{label, source_opportunity_id}], registry_id, …}
 *   npx tsx scripts/clone-labs-rebuild.ts remap --run-state <source run_state.yaml> --id-map <map.json> --out <synthetic.json>
 *     → products.synthetic rewritten to the new ids; exit 1 naming every source id left behind
 *   npx tsx scripts/clone-labs-rebuild.ts remap-json --in <registry.json> --id-map <map.json> --out <file>
 *     → the same rewrite on any JSON doc (a registry's deployment.llo_map is keyed by opp id)
 *
 * `map.json` is `{"<source id>": <new id>, …}` for every opp, the program,
 * registry, workflows, runs, pipelines, cohort and benchmark publications.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parse } from 'yaml';
import { labsRebuildSource, remapSyntheticProducts } from '../lib/clone-labs-rebuild.js';

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (!v) throw new Error(`--${name} is required`);
  return v;
}

function main(): number {
  const cmd = process.argv[2];
  if (cmd === 'inspect') {
    console.log(JSON.stringify(labsRebuildSource(parse(readFileSync(arg('run-state'), 'utf8'))), null, 1));
    return 0;
  }
  if (cmd === 'remap') {
    const rs = parse(readFileSync(arg('run-state'), 'utf8')) as { phases?: Record<string, { products?: { synthetic?: unknown } }> };
    const synthetic = rs.phases?.['synthetic-data-and-workflows']?.products?.synthetic;
    if (!synthetic) throw new Error('the run state has no phases.synthetic-data-and-workflows.products.synthetic');
    const map = JSON.parse(readFileSync(arg('id-map'), 'utf8')) as Record<string, number>;
    const { products, leftover } = remapSyntheticProducts(synthetic, Object.fromEntries(Object.entries(map).map(([k, v]) => [Number(k), Number(v)])));
    writeFileSync(arg('out'), JSON.stringify(products, null, 1));
    console.log(JSON.stringify({ leftover }));
    return leftover.length ? 1 : 0;
  }
  if (cmd === 'remap-json') {
    // A registry (semantic_registry_get) keys deployment.llo_map by partner opp id — the same rewrite.
    const doc = JSON.parse(readFileSync(arg('in'), 'utf8'));
    const map = JSON.parse(readFileSync(arg('id-map'), 'utf8')) as Record<string, number>;
    const { products, leftover } = remapSyntheticProducts(doc, Object.fromEntries(Object.entries(map).map(([k, v]) => [Number(k), Number(v)])));
    writeFileSync(arg('out'), JSON.stringify(products, null, 1));
    console.log(JSON.stringify({ leftover }));
    return leftover.length ? 1 : 0;
  }
  console.error('usage: clone-labs-rebuild.ts inspect|remap|remap-json … (see the header)');
  return 2;
}

try {
  process.exit(main());
} catch (e) {
  console.error((e as Error).message);
  process.exit(2);
}
