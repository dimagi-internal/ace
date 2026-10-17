/**
 * Print whether Phase 7 applies to a PDD (ace#2806).
 *
 *   npx tsx scripts/phase7-applicability.ts <path-to-pdd.md>
 *
 * Prints the `phase7Applicability` result as JSON. Exit 0 = applicable (run the
 * phase); exit 3 = skip (write the skip block from the printed `skip_reason`,
 * `reasons` and `detail`); exit 64 = usage. Logic: lib/phase7-applicability.ts.
 * Run by agents/synthetic-data-and-workflows.md § Scale.
 */
import { readFileSync } from 'node:fs';
import { phase7Applicability } from '../lib/phase7-applicability.js';

const path = process.argv[2];
if (!path) {
  process.stderr.write('usage: phase7-applicability.ts <path-to-pdd.md>\n');
  process.exit(64);
}
const result = phase7Applicability(readFileSync(path, 'utf8'));
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
process.exit(result.applicable ? 0 : 3);
