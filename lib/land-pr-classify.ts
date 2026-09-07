/**
 * Why a PR is `BLOCKED`, and whether `land-pr.sh` may rebase it (ace#2175).
 *
 * ## The bug this exists to close
 *
 * `land-pr.sh` entered its version-collision recovery on ONE signal:
 * `mergeStateStatus: DIRTY`. That is correct for a merge CONFLICT and wrong for
 * the common shape of a version collision, which produces no conflict at all.
 *
 * Two PRs that bump to the SAME version write byte-identical VERSION files, so
 * git merges them cleanly — `lib/version-uniqueness.ts` says so in the error it
 * raises: *"Nothing will conflict — two identical VERSION files merge cleanly"*.
 * The collision is caught instead by `check-version-unique` failing inside
 * `clean-install`, `main`'s only REQUIRED check, which leaves the PR at
 * `BLOCKED`. Observed live 2026-09-07 on PR #2166 (collided with #2165 on
 * `0.13.1325`): `state=OPEN mergeState=BLOCKED auto=MERGE`, stable, for the ten
 * minutes `land-pr.sh` polled it before a human recovered it by hand.
 *
 * ## Why `BLOCKED` alone must NEVER be the trigger
 *
 * `BLOCKED` is GitHub's general "not mergeable yet" state. It covers checks
 * still running, a check that FAILED for any reason at all, and a missing
 * review. Widening the DIRTY test to `DIRTY || BLOCKED` would make the script
 * answer an ordinary red unit test by rebasing and force-pushing — restarting CI
 * on a failure a rebase cannot fix, and burning the attempt budget doing it.
 * That is worse than the hang it replaces.
 *
 * ## The signal, and why it cannot fire on an unrelated failure
 *
 * The trigger is `BLOCKED` **and** a positive VERSION-collision verdict, where
 * the verdict is re-derived from the same authority CI uses —
 * `checkVersionAdvances` / `checkVersionUnclaimed` in `lib/version-uniqueness.ts`
 * — over evidence read live (this branch's VERSION, `origin/main`'s VERSION, and
 * the VERSIONs claimed by older open PRs). See `scripts/land-pr-classify.ts`.
 *
 * That verdict does not look at CI at all, so no CI failure can produce it: a
 * red test, a lint error, an unapproved PR and a pending check leave this
 * branch's VERSION exactly as strictly-greater-than-`origin/main` and exactly as
 * unclaimed as it was. The only way to reach `collision` is for the VERSION
 * property itself to be false, which is precisely the state a rebase fixes.
 *
 * The converse guard is `'unknown'`: when the evidence cannot be gathered (no
 * network, `gh` unavailable, unreadable VERSION) the verdict is NOT `unique` and
 * NOT `collision`, and the decision is to wait. A degraded read can only lose a
 * recovery, never invent one.
 *
 * Checks are read too, but only to NAME what is holding the PR — that is the
 * other half of ace#2175 (ten minutes of no output read as a hang rather than a
 * wait). They never authorise the rebase.
 */

/** GitHub conclusions that mean a check is done and did not pass. */
const FAILED_CONCLUSIONS = new Set([
  'FAILURE',
  'TIMED_OUT',
  'CANCELLED',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
  'STALE',
  'ERROR',
]);

/**
 * One entry of `gh pr view --json statusCheckRollup`, normalised across its two
 * shapes: a `CheckRun` carries `name` + `status` + `conclusion`, a
 * `StatusContext` carries `context` + `state`.
 */
export interface CheckRunSummary {
  name: string;
  /** QUEUED | IN_PROGRESS | COMPLETED | PENDING — absent on a StatusContext. */
  status?: string;
  /** SUCCESS | FAILURE | ... — a StatusContext's `state` maps here. */
  conclusion?: string;
}

/**
 * What `lib/version-uniqueness.ts` says about this branch's VERSION, re-derived
 * live. `unknown` means the evidence could not be gathered — never a guess.
 */
export type VersionVerdict = 'collision' | 'unique' | 'unknown';

export type LandingCause =
  | 'version-collision'
  | 'checks-failed'
  | 'checks-pending'
  | 'blocked-other'
  | 'version-verdict-unavailable'
  | 'not-blocked';

/**
 * `recover` — disarm, rebase the version files, force-push, re-arm.
 * `wait`    — leave the PR alone; auto-merge is holding it legitimately.
 * `none`    — not BLOCKED; this classifier has nothing to say.
 */
export type LandingAction = 'recover' | 'wait' | 'none';

export interface LandingInput {
  mergeStateStatus: string;
  checks: CheckRunSummary[];
  versionVerdict: VersionVerdict;
  /** One-line human explanation of the verdict, from the authority's message. */
  versionDetail?: string;
}

export interface LandingDecision {
  action: LandingAction;
  cause: LandingCause;
  /** Names of checks that completed and did not pass. */
  failing: string[];
  /** Names of checks still running. */
  pending: string[];
  /** Operator-facing single line. Always set; says what and why. */
  message: string;
}

const upper = (v: string | undefined): string => (v ?? '').trim().toUpperCase();

export function failingChecks(checks: CheckRunSummary[]): string[] {
  return checks.filter((c) => FAILED_CONCLUSIONS.has(upper(c.conclusion))).map((c) => c.name);
}

export function pendingChecks(checks: CheckRunSummary[]): string[] {
  return checks
    .filter((c) => {
      const conclusion = upper(c.conclusion);
      if (conclusion) return conclusion === 'PENDING';
      const status = upper(c.status);
      return status !== 'COMPLETED';
    })
    .map((c) => c.name);
}

const list = (names: string[]): string => (names.length ? names.join(', ') : 'none');

export function classifyLanding(input: LandingInput): LandingDecision {
  const checks = input.checks ?? [];
  const failing = failingChecks(checks);
  const pending = pendingChecks(checks);
  const detail = (input.versionDetail ?? '').trim();

  if (upper(input.mergeStateStatus) !== 'BLOCKED') {
    return {
      action: 'none',
      cause: 'not-blocked',
      failing,
      pending,
      message: `mergeStateStatus is ${input.mergeStateStatus} — not the BLOCKED case this classifies.`,
    };
  }

  // The ONLY path to a rebase. Ordered first deliberately: when the collision is
  // real, `clean-install` is red BECAUSE of it, so a checks-first rule would
  // classify the cause as its own symptom.
  if (input.versionVerdict === 'collision') {
    return {
      action: 'recover',
      cause: 'version-collision',
      failing,
      pending,
      message:
        `BLOCKED by a VERSION collision — ${detail || 'this branch’s VERSION is not viable against origin/main.'} ` +
        `Failing checks: ${list(failing)}. Rebasing the version files is the remedy.`,
    };
  }

  // A degraded read must never be read as "no collision" OR as "collision".
  if (input.versionVerdict === 'unknown') {
    return {
      action: 'wait',
      cause: 'version-verdict-unavailable',
      failing,
      pending,
      message:
        `BLOCKED, and the VERSION verdict could NOT be determined${detail ? ` (${detail})` : ''}. ` +
        `Refusing to rebase on an unknown: a force-push here could restart CI on a PR that never needed it. ` +
        `Failing checks: ${list(failing)}; pending: ${list(pending)}.`,
    };
  }

  if (failing.length > 0) {
    return {
      action: 'wait',
      cause: 'checks-failed',
      failing,
      pending,
      message:
        `BLOCKED by FAILING checks (${list(failing)}), and this branch’s VERSION is fine — ` +
        `so this is NOT a version collision and a rebase would not fix it. Not touching the PR; ` +
        `fix the check, or re-run it.`,
    };
  }

  if (pending.length > 0) {
    return {
      action: 'wait',
      cause: 'checks-pending',
      failing,
      pending,
      message: `BLOCKED with checks still running (${list(pending)}) — auto-merge will land it when they pass.`,
    };
  }

  return {
    action: 'wait',
    cause: 'blocked-other',
    failing,
    pending,
    message:
      'BLOCKED with no failing and no pending checks and no VERSION collision — most likely a ' +
      'required review or a branch-protection rule. Nothing this script can do; a human decides.',
  };
}

/**
 * The `key=value` block `land-pr.sh` parses. One key per line, values on a
 * single line, so `read`/`case` in bash needs no JSON parser.
 */
export function renderDecision(d: LandingDecision): string {
  return [
    `action=${d.action}`,
    `cause=${d.cause}`,
    `failing=${d.failing.join(',')}`,
    `pending=${d.pending.join(',')}`,
    `detail=${d.message.replace(/\s+/g, ' ').trim()}`,
  ].join('\n');
}
