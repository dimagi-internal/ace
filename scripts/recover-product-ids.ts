/**
 * CLI over `lib/products-id-recovery.ts` (ace#2412): rebuild a phase's
 * external-resource ids in `products` from its declared artifact frontmatter.
 *
 *   npx tsx scripts/recover-product-ids.ts <phase> --list
 *       print the ONLY artifact paths to fetch (run-folder relative)
 *   npx tsx scripts/recover-product-ids.ts <phase> --run-state <local run_state.yaml> \
 *       --artifact <run-path>=<local-file> [--artifact …]
 *       reconcile; an --artifact not given is treated as ABSENT in Drive
 *
 * Exit 0 = ok (prints `{recovered, patch, …}`; deep-merge `patch` into
 * `phases.<phase>.products`); 1 = HALT (a declared source exists but cannot
 * answer, or conflicts with products — do not guess, do not re-dispatch);
 * 2 = UNABLE (no declared sources for this phase) — NOT a pass.
 */
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { declaredSourcePaths, recoverProductIds } from '../lib/products-id-recovery.js';

const args = process.argv.slice(2);
const phase = args[0] && !args[0].startsWith('--') ? args[0] : undefined;
if (!phase) {
  console.error('usage: recover-product-ids.ts <phase> (--list | --run-state <file> --artifact <path>=<file> …)');
  process.exit(2);
}

if (args.includes('--list')) {
  const paths = declaredSourcePaths(phase);
  console.log(JSON.stringify({ phase, artifacts: paths }, null, 2));
  process.exit(paths.length ? 0 : 2);
}

const valuesOf = (flag: string) => args.flatMap((a, i) => (a === flag && args[i + 1] ? [args[i + 1]] : []));
const runStateFile = valuesOf('--run-state')[0];
const runState = runStateFile ? (parseYaml(readFileSync(runStateFile, 'utf8')) as Record<string, any>) : {};
const artifacts: Record<string, string | undefined> = {};
for (const spec of valuesOf('--artifact')) {
  const eq = spec.indexOf('=');
  if (eq < 1) {
    console.error(`--artifact expects <run-path>=<local-file>, got "${spec}"`);
    process.exit(2);
  }
  artifacts[spec.slice(0, eq)] = readFileSync(spec.slice(eq + 1), 'utf8');
}

const r = recoverProductIds({ phase, products: runState?.phases?.[phase]?.products, artifacts });
console.log(JSON.stringify(r, null, 2));
process.exit(r.status === 'ok' ? 0 : r.status === 'halt' ? 1 : 2);
