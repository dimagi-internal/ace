/**
 * CI gate: this branch's VERSION must advance past origin/main's CURRENT VERSION.
 *
 * Wired into `clean-install.yml` — the ONE required check on `main` — because
 * `version-check.yml` is advisory and therefore never blocked anything (ace#1593).
 *
 * Two modes:
 *   (default, on pull_request) compare the working tree's VERSION against
 *       `origin/main`'s VERSION read at CHECK TIME.
 *   --post-merge (on push to main) compare HEAD's VERSION against HEAD~1's.
 *       This cannot block a merge, but it turns an escaped race into an
 *       immediately RED main instead of a silent unreachable release.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { checkVersionAdvances } from '../lib/version-uniqueness.js';

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function main(): void {
  const postMerge = process.argv.includes('--post-merge');

  if (postMerge) {
    // On a push to main, HEAD is the merge commit. Its first parent is the
    // previous state of main.
    let previous: string;
    try {
      previous = git(['show', 'HEAD~1:VERSION']);
    } catch {
      console.log('check-version-unique: no HEAD~1 (initial commit?) — skipping.');
      return;
    }
    const current = git(['show', 'HEAD:VERSION']);
    const res = checkVersionAdvances(current, previous);
    if (res.ok) {
      console.log(`check-version-unique: main advanced ${previous} -> ${current}.`);
      return;
    }
    console.error(
      '::error::main was pushed WITHOUT advancing VERSION. The change that just landed is ' +
        'unreachable by /ace:update until a follow-up bump ships (ace#1593).\n' +
        res.message,
    );
    process.exit(1);
  }

  // PR mode. Read origin/main's VERSION live — the merge-base is exactly the
  // wrong reference here, since a concurrent merge is the only way this fails.
  try {
    execFileSync('git', ['fetch', '--quiet', 'origin', 'main'], { stdio: 'ignore' });
  } catch {
    // A fetch failure must not silently pass the gate.
    console.error('::error::check-version-unique could not fetch origin/main; refusing to pass.');
    process.exit(1);
  }

  const baseline = git(['show', 'origin/main:VERSION']);
  const candidate = readFileSync('VERSION', 'utf8');
  const res = checkVersionAdvances(candidate, baseline);

  if (res.ok) {
    console.log(`check-version-unique: ${res.message}`);
    return;
  }
  console.error(`::error::${res.message}`);
  process.exit(1);
}

main();
