#!/usr/bin/env npx tsx
/** Fail if a commit mutates or deletes a `Live-verified` selector row.
 *  Usage: check-selector-map-diff.ts [--staged | --base <ref>] */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { findLiveVerifiedViolations } from '../lib/selector-map-guard.js';

const argv = process.argv.slice(2);
const staged = argv.includes('--staged');
const base = staged ? 'HEAD' : (argv[argv.indexOf('--base') + 1] ?? 'origin/main');

const git = (args: string[]): string =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

const changed = git(['diff', '--name-only', staged ? '--cached' : base])
  .split('\n')
  .filter((p) => /^mcp\/mobile\/selectors\/.*\.yaml$/.test(p));

let failed = false;
for (const file of changed) {
  let oldText = '';
  try {
    oldText = git(['show', `${base}:${file}`]);
  } catch {
    continue; // new file — nothing to protect yet
  }
  let newText: string;
  try {
    newText = staged ? git(['show', `:${file}`]) : fs.readFileSync(file, 'utf8');
  } catch {
    // Staged/working-tree version is unreadable — most likely the file was
    // deleted. Fail closed and say why, rather than letting the stack trace
    // stand in for a message: a deleted selector map silently drops every
    // Live-verified row it carried, and that's exactly the kind of change
    // this guard exists to stop and explain.
    failed = true;
    process.stderr.write(`${file}: could not read the staged/working-tree version (deleted?)\n`);
    continue;
  }
  for (const v of findLiveVerifiedViolations(oldText, newText)) {
    failed = true;
    const detail =
      v.kind === 'deleted'
        ? 'row deleted'
        : `${v.field}: ${JSON.stringify(v.before)} -> ${JSON.stringify(v.after)}`;
    process.stderr.write(`${file}: Live-verified row '${v.selector}' ${detail}\n`);
  }
}

if (failed) {
  process.stderr.write(
    '\nA Live-verified row records a live-device observation. Re-verify on a ' +
      'device and update the purpose note in the same commit, or add a NEW row ' +
      'instead of overwriting this one. See jjackson/ace#893.\n',
  );
  process.exit(1);
}
