/**
 * `nova-app-review` — the code-decidable half of the Phase 3 post-build app
 * review (`skills/app-review`, P12 / T71), read from the Step 1.4 snapshots.
 *
 *   npx tsx "$ACE_ROOT/scripts/nova-app-review.ts" \
 *     --learn <nova-app-snapshot_learn.json> --deliver <nova-app-snapshot_deliver.json> \
 *     --out <app-review.json> [--md <app-review_structural.md>]
 *
 * Makes NO Nova calls. Freshness is the caller's job: one
 * `nova-app-snapshot.ts --check` per app first, and a non-FRESH snapshot is
 * re-read (`nova-app-lint --snapshot-out`) before it is reviewed.
 *
 * Exit 0 = reviewed (report-only: findings never fail the step). Exit 1 =
 * usage. Exit 3 = a snapshot could not be read or is partial — NOT a clean
 * review.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { NovaAppBundle } from '../lib/nova-app-bundle.js';
import { renderReview, reviewApps } from '../lib/nova-app-review.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function load(path: string | undefined, kind: string): NovaAppBundle | undefined {
  if (!path) return undefined;
  const b: NovaAppBundle = JSON.parse(readFileSync(path, 'utf8'));
  if (b.readErrors?.length) throw new Error(`${kind} snapshot ${path} is partial: ${b.readErrors[0]}`);
  return b;
}

function main(): number {
  const out = arg('out');
  if (!out || (!arg('learn') && !arg('deliver'))) {
    process.stderr.write('usage: nova-app-review.ts [--learn <snapshot>] [--deliver <snapshot>] --out <json> [--md <md>]\n');
    return 1;
  }
  let review;
  try {
    review = reviewApps({ learn: load(arg('learn'), 'learn'), deliver: load(arg('deliver'), 'deliver') });
  } catch (e) {
    process.stderr.write(`UNABLE: ${(e as Error).message}\n`);
    return 3;
  }
  writeFileSync(out, JSON.stringify(review, null, 1) + '\n');
  const md = arg('md');
  if (md) writeFileSync(md, renderReview(review));
  const by = (l: string) => review.findings.filter((f) => f.layer === l).length;
  process.stdout.write(`REVIEWED ${review.findings.length} findings — builder ${by('builder')} (for hal: ${review.forVerification.length}), brief ${by('brief')}, platform ${by('platform')}\n`);
  return 0;
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!);
if (invokedDirectly) process.exit(main());
