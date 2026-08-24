/**
 * The version a PR ships must be strictly newer than what `main` already has
 * (ace#1593).
 *
 * WHY THIS IS NOT COSMETIC. The plugin cache is keyed by version
 * (`~/.claude/plugins/cache/ace/ace/<version>/`), and a session re-installs
 * only when the marketplace version differs from the installed one. So when two
 * PRs both land as `0.13.964`, a machine that installed after the first one
 * believes it is current and NEVER picks up the second. The change is on `main`
 * and unreachable by `/ace:update` at the same time — silently, with VERSION,
 * plugin.json and installed_plugins.json all reading correct.
 *
 * Measured 2026-08-24, one sweep of ~20 PRs: 4 collided; 3 merged carrying a
 * version `main` already had and each needed a follow-up bump PR purely to
 * become reachable.
 *
 * WHY THE EXISTING GATE MISSED IT, twice over:
 *   1. `version-check.yml` is advisory — `main`'s only REQUIRED check is
 *      `clean-install`, so its `exit 1` never blocked anything.
 *   2. It compares against the PR's captured BASE sha (deliberately, to dodge a
 *      spurious-failure race), which asserts "did I bump relative to where I
 *      branched" — NOT "is my version unique on main". Two PRs off the same
 *      base both bump to the same value and both pass legitimately. It is
 *      structurally blind to the only way this defect occurs.
 *
 * This module asserts the property that actually matters. Because VERSION only
 * ever increases on `main`, "strictly greater than main's tip" implies "not
 * already present in main's history" — an O(1) check rather than a history walk.
 */

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

export type VersionComparison = 'ahead' | 'equal' | 'behind' | 'unparseable';

export interface VersionCheckResult {
  comparison: VersionComparison;
  ok: boolean;
  /** Operator-facing explanation. Always set; names the remedy when not ok. */
  message: string;
  candidate?: SemVer;
  baseline?: SemVer;
}

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

export function parseSemVer(raw: string): SemVer | null {
  const m = SEMVER_RE.exec((raw ?? '').trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** -1 | 0 | 1, comparing a to b. */
export function compareSemVer(a: SemVer, b: SemVer): -1 | 0 | 1 {
  if (a.major !== b.major) return a.major > b.major ? 1 : -1;
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1;
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1;
  return 0;
}

/**
 * `candidateRaw` is this branch's VERSION; `baselineRaw` is the CURRENT VERSION
 * on `origin/main`, read at check time (NOT the PR's merge-base — reading the
 * live tip is the entire point).
 */
export function checkVersionAdvances(
  candidateRaw: string,
  baselineRaw: string,
): VersionCheckResult {
  const candidateText = (candidateRaw ?? '').trim();
  const baselineText = (baselineRaw ?? '').trim();
  const candidate = parseSemVer(candidateText);
  const baseline = parseSemVer(baselineText);

  if (!candidate || !baseline) {
    return {
      comparison: 'unparseable',
      ok: false,
      message:
        `VERSION is not valid semver — branch read ${JSON.stringify(candidateRaw)}, ` +
        `origin/main read ${JSON.stringify(baselineRaw)}. Expected MAJOR.MINOR.PATCH.`,
      candidate: candidate ?? undefined,
      baseline: baseline ?? undefined,
    };
  }

  const cmp = compareSemVer(candidate, baseline);
  if (cmp === 1) {
    return {
      comparison: 'ahead',
      ok: true,
      message: `VERSION ${candidateText} advances past origin/main ${baselineText}.`,
      candidate,
      baseline,
    };
  }

  const remedy =
    'Another PR merged this version while yours was open. Recover WITHOUT losing the race ' +
    '(skills/shipping § Version collision):\n' +
    '    gh pr merge <N> --disable-auto        # stop auto-merge racing the rebase\n' +
    '    bash scripts/version-bump.sh --rebase-first\n' +
    '    git push --force-with-lease\n' +
    '    gh pr merge <N> --auto --merge        # re-arm only after the new VERSION is pushed';

  if (cmp === 0) {
    return {
      comparison: 'equal',
      ok: false,
      message:
        `VERSION ${candidateText} is ALREADY on origin/main. Merging would put two different ` +
        'trees behind one version, and the plugin cache is keyed by version — so this change ' +
        `would be unreachable by /ace:update (ace#1593).\n${remedy}`,
      candidate,
      baseline,
    };
  }

  return {
    comparison: 'behind',
    ok: false,
    message:
      `VERSION ${candidateText} is BEHIND origin/main ${baselineText} — the branch is stale.\n${remedy}`,
    candidate,
    baseline,
  };
}
