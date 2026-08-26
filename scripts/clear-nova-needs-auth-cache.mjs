#!/usr/bin/env node
/**
 * Remove a stuck `plugin:nova:nova` entry from Claude Code's needs-auth cache.
 *
 * dimagi-internal/ace#1579. #582 taught `bin/ace-doctor` to DETECT the stuck
 * entry; it could only ever print a remediation. That is not enough, because
 * Claude Code rewrites the entry's timestamp at every session startup without
 * re-attempting auth (nova-plugin#11) — so restarting does not clear it, and
 * the halt repeats on every restart until a human deletes the key by hand.
 *
 * Measured on spark-facilitator/20260820-0817: a session halted on this, the
 * operator restarted, Claude Code re-wrote the entry 3 minutes before preflight
 * ran, and the second session halted on exactly the same block. Two restarts,
 * zero progress.
 *
 * Clearing is only correct when we hold a valid NOVA_API_KEY — that is the
 * caller's gate (`--if-key-present`), not this script's guess. With no key the
 * cached entry may be perfectly accurate.
 *
 * Idempotent: a missing file or a missing key is `absent`, not an error, so the
 * doctor can call it unconditionally inside its fail branch.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const KEY = 'plugin:nova:nova';

function parseArgs(argv) {
  const args = { file: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--file') args.file = argv[++i];
  }
  return args;
}

/**
 * @returns {'cleared'|'absent'|'unparseable'} what happened, for the caller to report.
 */
export function clearNovaNeedsAuthEntry(file) {
  if (!file || !existsSync(file)) return 'absent';

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    // A cache we cannot parse is one we must not rewrite — truncating Claude
    // Code's state would be a worse failure than the one we came to fix.
    return 'unparseable';
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 'unparseable';
  if (!(KEY in parsed)) return 'absent';

  delete parsed[KEY];
  // Match Claude Code's own formatting so the file does not churn in diffs.
  writeFileSync(file, JSON.stringify(parsed, null, 2) + '\n');
  return 'cleared';
}

// Only run as a CLI when invoked directly, so the test can import the function.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const { file } = parseArgs(process.argv.slice(2));
  process.stdout.write(clearNovaNeedsAuthEntry(file) + '\n');
}
