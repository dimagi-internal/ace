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
import {
  checkVersionAdvances,
  checkVersionUnclaimed,
  type OpenPrClaim,
} from '../lib/version-uniqueness.js';

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

/**
 * The versions currently claimed by OTHER open PRs (ace#1776).
 *
 * BEST-EFFORT ON PURPOSE, and the asymmetry is deliberate: the baseline
 * `checkVersionAdvances` gate above refuses to pass when it cannot fetch,
 * because a silent pass there loses the invariant ace#1593 exists for. This is
 * an ADDITIONAL guard layered on top of an assertion that already ran, so a
 * degraded answer here can only fail to catch something extra — it can never
 * weaken what was already proved. Failing the one REQUIRED check on `main`
 * because the GitHub API blipped would be strictly worse.
 */
function openPrClaims(): OpenPrClaim[] | null {
  const slug = process.env.GITHUB_REPOSITORY;
  if (!slug) return null;
  let listed: Array<{ number: number; headRefOid: string }>;
  try {
    listed = JSON.parse(
      execFileSync(
        'gh',
        ['pr', 'list', '--repo', slug, '--state', 'open', '--limit', '100',
         '--json', 'number,headRefOid'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      ),
    );
  } catch {
    return null;
  }
  const claims: OpenPrClaim[] = [];
  for (const pr of listed) {
    try {
      const version = execFileSync(
        'gh',
        ['api', `repos/${slug}/contents/VERSION?ref=${pr.headRefOid}`,
         '-H', 'Accept: application/vnd.github.raw'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim();
      if (version) claims.push({ number: pr.number, version });
    } catch {
      // One unreadable head is not a reason to drop the other claims.
    }
  }
  return claims;
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

  if (!res.ok) {
    console.error(`::error::${res.message}`);
    process.exit(1);
  }
  console.log(`check-version-unique: ${res.message}`);

  // Second assertion (ace#1776): unique against `main` is not the same as
  // unique against every other PR that is ALSO about to merge. `main`'s branch
  // protection has strict=false, so this check is never re-run at merge time —
  // two PRs off one base both bump to N, both go green while N is unique, and
  // both merge with no conflict, because two identical VERSION files merge
  // cleanly. Three such pairs landed on main in the 40 merges to 2026-09-04.
  const selfPr = Number(process.env.PR_NUMBER);
  if (!Number.isFinite(selfPr) || selfPr <= 0) {
    console.log(
      'check-version-unique: PR_NUMBER not set — skipping the open-PR claim check. ' +
        'Wire it in the workflow (ace#1776); the origin/main assertion above still ran.',
    );
    return;
  }
  const claims = openPrClaims();
  if (claims === null) {
    console.log(
      'check-version-unique: could not list open PRs — skipping the claim check. ' +
        'The origin/main assertion above still ran and passed.',
    );
    return;
  }
  const claimRes = checkVersionUnclaimed(candidate, selfPr, claims);
  if (!claimRes.ok) {
    console.error(`::error::${claimRes.message}`);
    process.exit(1);
  }
  console.log(`check-version-unique: ${claimRes.message}`);
}

main();
