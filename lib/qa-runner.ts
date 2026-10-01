/**
 * Test-side runner for QA checks.
 *
 * Lets tests call `runChecks(...)` directly with an artifact + a list of
 * `QACheck`s and get back a fully-shaped `QAResult` without dispatching
 * the actual skill. Used by per-skill integration tests under
 * `test/skills/<skill>/`.
 *
 * Production skills use the same check functions but orchestrate them
 * via the skill body (read artifact → call each check → aggregate →
 * write YAML). The shape comes out identical because both paths use
 * this same helper.
 */

import { aggregateQAResult, QACheck, QACheckContext, QACheckOutcome, QAResult } from './qa-types';

export interface RunChecksOptions {
  /** This skill's name (matches the QA skill's frontmatter `name:`). */
  skill: string;
  /** Identifier for what was checked. */
  target: string;
  /** Path to the artifact under review (relative to runs/<run-id>/). */
  capture_path: string;
  /** The artifact text. Pass via fixtureLoader or read directly. */
  artifact: string;
  /** Ordered list of checks to run. Each contributes to stats + failures. */
  checks: QACheck[];
  /** Optional context passed to each check. */
  context?: QACheckContext;
  /** Override the timestamp (defaults to now). Useful for snapshot tests. */
  ran_at?: string;
  /** Include passing checks in the output (default: false). */
  include_passed?: boolean;
}

export async function runChecks(opts: RunChecksOptions): Promise<QAResult> {
  const outcomes: QACheckOutcome[] = [];
  for (const check of opts.checks) {
    const result = await check.run(opts.artifact, opts.context);
    outcomes.push({
      check: check.id,
      type: check.type,
      result: result.pass
        ? result
        : {
            ...result,
            detail: result.detail ?? `check '${check.id}' failed`,
            auto_fix_hint:
              result.auto_fix_hint ??
              `re-run the producer with explicit instruction to address: ${result.detail ?? check.description}`,
          },
    });
  }
  // One aggregation for tests and production: zero checks is a FAIL there too.
  return aggregateQAResult({
    skill: opts.skill,
    target: opts.target,
    capture_path: opts.capture_path,
    ran_at: opts.ran_at,
    outcomes,
    include_passed: opts.include_passed ?? false,
  });
}
