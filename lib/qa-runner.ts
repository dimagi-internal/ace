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

import {
  QACheck,
  QACheckContext,
  QAFailure,
  QAPassedSchema,
  QAResult,
} from './qa-types';
import { z } from 'zod';

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
  const failures: QAFailure[] = [];
  const passed: z.infer<typeof QAPassedSchema>[] = [];

  for (const check of opts.checks) {
    const result = await check.run(opts.artifact, opts.context);
    if (result.pass) {
      passed.push({ check: check.id, detail: result.detail });
    } else {
      failures.push({
        check: check.id,
        type: check.type,
        detail: result.detail ?? `check '${check.id}' failed`,
        auto_fix_hint:
          result.auto_fix_hint ??
          `re-run the producer with explicit instruction to address: ${result.detail ?? check.description}`,
        severity: 'blocker',
      });
    }
  }

  const result: QAResult = {
    skill: opts.skill,
    target: opts.target,
    ran_at: opts.ran_at ?? new Date().toISOString(),
    capture_path: opts.capture_path,
    schema_version: 1,
    verdict: failures.length === 0 ? 'pass' : 'fail',
    stats: {
      checks_run: opts.checks.length,
      checks_passed: passed.length,
      checks_failed: failures.length,
    },
    failures,
  };

  if (opts.include_passed) {
    result.passed = passed;
  }

  return result;
}
