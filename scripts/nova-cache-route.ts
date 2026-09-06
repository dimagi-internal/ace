#!/usr/bin/env npx tsx
/**
 * The correlation `bin/ace-doctor --preflight` could not do in bash: relate the
 * session handoff to the `nova_needs_auth_cache` verdict and print ONE
 * remediation branch instead of two.
 *
 * ace#1769. Both facts were already on the operator's screen — the handoff
 * proving a restart had happened and failed, and a remediation whose FIRST
 * listed branch is "restart". Nothing joined them, so the cheapest wrong branch
 * was the one read.
 *
 * The logic is pure and lives in `lib/nova-cache-routing.ts`; this is the thin
 * shell boundary. It prints a two-line, shell-safe result:
 *
 *   recurrence=<confirmed-by-handoff|not-established>
 *   remediation=<one line, no newlines>
 *
 * Usage:
 *   npx tsx scripts/nova-cache-route.ts --cleared <true|false> \
 *     --cache-file <path> --clear-result <string>
 *
 * Never throws and never exits non-zero: a doctor that dies on its own routing
 * helper is worse than one that prints both branches, so any failure falls
 * through to the unrouted string — the exact text ACE shipped before this
 * existed.
 */
import { readHandoff } from '../lib/session-handoff.js';
import { routeNovaCacheRemediation } from '../lib/nova-cache-routing.js';

function arg(name: string, fallback = ''): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const cleared = arg('cleared') === 'true';
const cacheFile = arg('cache-file');
const clearResult = arg('clear-result');

let handoff = null;
let handoffAgeMs = 0;
try {
  const r = readHandoff();
  // ONLY a fresh handoff is evidence about THIS session. A stale one routing a
  // genuine first occurrence away from the restart that would have fixed it is
  // the inverse of the bug being fixed.
  if (r.status === 'fresh') {
    handoff = r.handoff;
    handoffAgeMs = r.ageMs;
  }
} catch {
  // Fall through unrouted.
}

const route = routeNovaCacheRemediation({ cleared, cacheFile, clearResult, handoff, handoffAgeMs });
process.stdout.write(`recurrence=${route.recurrence}\n`);
process.stdout.write(`remediation=${route.remediation.replace(/[\r\n]+/g, ' ')}\n`);
