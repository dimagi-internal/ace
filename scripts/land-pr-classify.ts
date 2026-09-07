/**
 * Classify a BLOCKED PR for `scripts/land-pr.sh` (ace#2175).
 *
 * Read-only. It answers ONE question — *may `land-pr.sh` rebase this PR?* — and
 * prints the answer as `key=value` lines on stdout. It mutates nothing, ever.
 *
 * The decision rule and the reasoning behind it live in `lib/land-pr-classify.ts`.
 * This file is the IO half: it gathers the three inputs that rule needs.
 *
 *   1. `mergeStateStatus` and the status-check rollup, from `gh pr view`.
 *   2. This branch's VERSION against `origin/main`'s, read LIVE — the merge-base
 *      is exactly the wrong reference, since a concurrent merge is the only way
 *      it fails.
 *   3. The VERSIONs claimed by OLDER open PRs.
 *
 * (2) and (3) are handed to `checkVersionAdvances` / `checkVersionUnclaimed` in
 * `lib/version-uniqueness.ts` — the SAME functions `scripts/check-version-unique.ts`
 * runs inside `clean-install`. That is deliberate and is the whole safety
 * argument: the collision verdict is re-derived from the authority rather than
 * scraped out of CI's log prose, so it cannot drift from what CI decides and
 * cannot be faked by any other kind of CI failure.
 *
 * ## Usage
 *
 *   npx tsx scripts/land-pr-classify.ts --pr <n> [--repo owner/name]
 *   npx tsx scripts/land-pr-classify.ts --fixture <recorded.json>   # dry run
 *
 * `--fixture` is the classify-only mode: it takes recorded `gh` output plus
 * recorded version evidence and runs the identical decision path with no
 * network and no git. It exists so both directions of the rule — a version
 * collision recovers, a plain failing test does NOT — are asserted against the
 * real script rather than a paraphrase of it.
 *
 * Exit 0 whenever a decision was produced (the decision is on stdout, not in the
 * exit code); 64 on a usage error.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  checkVersionAdvances,
  checkVersionUnclaimed,
  type OpenPrClaim,
} from '../lib/version-uniqueness.js';
import {
  classifyLanding,
  renderDecision,
  type CheckRunSummary,
  type VersionVerdict,
} from '../lib/land-pr-classify.js';

interface Evidence {
  mergeStateStatus: string;
  checks: CheckRunSummary[];
  versionVerdict: VersionVerdict;
  versionDetail: string;
}

/** A recorded `gh`/git snapshot, for `--fixture`. */
interface Fixture {
  mergeStateStatus: string;
  statusCheckRollup?: unknown[];
  checks?: CheckRunSummary[];
  /** VERSION on this branch. */
  candidateVersion?: string;
  /** VERSION on origin/main at check time. */
  baselineVersion?: string;
  /** Versions claimed by other open PRs. */
  claims?: OpenPrClaim[];
  pr?: number;
  /** Force the verdict outright — for the degraded-read case. */
  versionVerdict?: VersionVerdict;
  versionDetail?: string;
}

function run(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

/**
 * Normalise the two shapes `statusCheckRollup` returns. A `CheckRun` carries
 * `name`/`status`/`conclusion`; a `StatusContext` carries `context`/`state`.
 * Neither shape is optional in practice, but a rollup entry we cannot read must
 * not crash a classifier whose failure mode would be a hung ship.
 */
export function normaliseRollup(rollup: unknown[] | undefined): CheckRunSummary[] {
  if (!Array.isArray(rollup)) return [];
  const out: CheckRunSummary[] = [];
  for (const raw of rollup) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as Record<string, unknown>;
    const name = typeof e.name === 'string' ? e.name
      : typeof e.context === 'string' ? e.context
      : '';
    if (!name) continue;
    out.push({
      name,
      status: typeof e.status === 'string' ? e.status : undefined,
      conclusion: typeof e.conclusion === 'string' ? e.conclusion
        : typeof e.state === 'string' ? e.state
        : undefined,
    });
  }
  return out;
}

/**
 * The VERSION verdict, from the authority. `unknown` on ANY evidence we could
 * not read — see `lib/land-pr-classify.ts` for why a degraded read must never
 * collapse to `unique`.
 */
export function versionVerdict(
  candidate: string,
  baseline: string,
  selfPr: number,
  claims: OpenPrClaim[] | null,
): { verdict: VersionVerdict; detail: string } {
  const advances = checkVersionAdvances(candidate, baseline);
  if (!advances.ok) {
    // `unparseable` is not a collision — it is an unreadable VERSION, and
    // rebasing on it would be a guess.
    if (advances.comparison === 'unparseable') {
      return { verdict: 'unknown', detail: advances.message.split('\n')[0] };
    }
    return { verdict: 'collision', detail: advances.message.split('\n')[0] };
  }
  if (claims === null) {
    return {
      verdict: 'unknown',
      detail:
        'could not list the open PRs, so the older-PR claim check (ace#1776) did not run; ' +
        `the origin/main assertion passed (${advances.message})`,
    };
  }
  const unclaimed = checkVersionUnclaimed(candidate, selfPr, claims);
  if (!unclaimed.ok) {
    return { verdict: 'collision', detail: unclaimed.message.split('\n')[0] };
  }
  return { verdict: 'unique', detail: unclaimed.message };
}

function gatherLive(pr: number, repo: string): Evidence {
  let mergeStateStatus = 'UNKNOWN';
  let checks: CheckRunSummary[] = [];
  try {
    const view = JSON.parse(
      run('gh', ['pr', 'view', String(pr), '--repo', repo,
        '--json', 'mergeStateStatus,statusCheckRollup']),
    ) as { mergeStateStatus?: string; statusCheckRollup?: unknown[] };
    mergeStateStatus = view.mergeStateStatus ?? 'UNKNOWN';
    checks = normaliseRollup(view.statusCheckRollup);
  } catch {
    return {
      mergeStateStatus,
      checks,
      versionVerdict: 'unknown',
      versionDetail: `could not read PR #${pr} from ${repo}`,
    };
  }

  // Live `origin/main`, exactly as `check-version-unique` reads it. A fetch we
  // cannot perform is an unknown verdict, never a pass.
  let baseline: string;
  let candidate: string;
  try {
    run('git', ['fetch', '--quiet', 'origin', 'main']);
    baseline = run('git', ['show', 'origin/main:VERSION']);
    candidate = readFileSync('VERSION', 'utf8');
  } catch {
    return {
      mergeStateStatus,
      checks,
      versionVerdict: 'unknown',
      versionDetail: 'could not read origin/main:VERSION or ./VERSION',
    };
  }

  const { verdict, detail } = versionVerdict(candidate, baseline, pr, openPrClaims(repo, pr));
  return { mergeStateStatus, checks, versionVerdict: verdict, versionDetail: detail };
}

/**
 * VERSIONs claimed by other OPEN PRs (ace#1776). `null` when the listing itself
 * failed — that is an unknown verdict, not a clean bill of health.
 *
 * One unreadable head is skipped rather than fatal, matching
 * `scripts/check-version-unique.ts`. The residual is the same as CI's: if the
 * ONE colliding PR is the unreadable one, this reads `unique` and `land-pr.sh`
 * waits instead of rebasing — the safe direction of that trade.
 */
function openPrClaims(repo: string, selfPr: number): OpenPrClaim[] | null {
  let listed: Array<{ number: number; headRefOid: string }>;
  try {
    listed = JSON.parse(
      run('gh', ['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '100',
        '--json', 'number,headRefOid']),
    );
  } catch {
    return null;
  }
  const claims: OpenPrClaim[] = [];
  for (const pr of listed) {
    // Only OLDER PRs can take the number off us, so only they are worth an API
    // call — this is a hot path on a ship, not a CI job with time to spare.
    if (!Number.isFinite(pr.number) || pr.number >= selfPr) continue;
    try {
      const version = run('gh', [
        'api', `repos/${repo}/contents/VERSION?ref=${pr.headRefOid}`,
        '-H', 'Accept: application/vnd.github.raw',
      ]);
      if (version) claims.push({ number: pr.number, version });
    } catch {
      // Skipped, as above.
    }
  }
  return claims;
}

function fromFixture(f: Fixture): Evidence {
  const checks = f.checks ?? normaliseRollup(f.statusCheckRollup);
  if (f.versionVerdict) {
    return {
      mergeStateStatus: f.mergeStateStatus,
      checks,
      versionVerdict: f.versionVerdict,
      versionDetail: f.versionDetail ?? '',
    };
  }
  const { verdict, detail } = versionVerdict(
    f.candidateVersion ?? '',
    f.baselineVersion ?? '',
    f.pr ?? 0,
    f.claims ?? null,
  );
  return { mergeStateStatus: f.mergeStateStatus, checks, versionVerdict: verdict, versionDetail: detail };
}

function main(): void {
  const argv = process.argv.slice(2);
  const opt = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const fixture = opt('--fixture');
  const evidence = fixture
    ? fromFixture(JSON.parse(readFileSync(fixture, 'utf8')) as Fixture)
    : (() => {
        const pr = Number(opt('--pr'));
        if (!Number.isFinite(pr) || pr <= 0) {
          console.error('usage: land-pr-classify.ts --pr <n> [--repo owner/name] | --fixture <file>');
          process.exit(64);
        }
        return gatherLive(pr, opt('--repo') || process.env.ACE_REPO || 'dimagi-internal/ace');
      })();

  console.log(renderDecision(classifyLanding(evidence)));
}

main();
