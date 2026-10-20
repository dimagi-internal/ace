#!/usr/bin/env -S npx tsx
/**
 * How to share a design document (the PDD, the Work Order) for this opp.
 *
 *   npx tsx scripts/design-doc-share-plan.ts <local copy of inputs/confidentiality.yaml | none>
 *
 * Prints the `DesignDocSharePlan` (lib/opp-confidentiality.ts) as JSON:
 *   {confidential, mode: anyone-with-link | named-reviewers | unshared, role, reviewers, reason}
 * Pass `none` only when the opp's inputs/ folder has NO confidentiality.yaml.
 * Exit 0 on a plan, 2 on usage error or an unreadable/malformed file.
 * (ace#3191)
 */
import { readFileSync } from 'node:fs';
import { designDocSharePlan } from '../lib/opp-confidentiality.js';

const arg = process.argv[2];
if (!arg) {
  console.error('usage: design-doc-share-plan.ts <confidentiality.yaml path | none>');
  process.exit(2);
}
try {
  const text = arg === 'none' ? null : readFileSync(arg, 'utf8');
  console.log(JSON.stringify(designDocSharePlan(text), null, 2));
} catch (err) {
  console.error(`design-doc-share-plan: ${(err as Error).message}`);
  process.exit(2);
}
