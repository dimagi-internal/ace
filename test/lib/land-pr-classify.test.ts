/**
 * ace#2175 — `land-pr.sh` recovered a VERSION collision only on
 * `mergeStateStatus: DIRTY`, which is the ONE shape the common collision never
 * produces (two identical VERSION files merge cleanly, so the collision lands as
 * a failed `check-version-unique` inside `clean-install` → `BLOCKED`).
 *
 * The fix is not "add BLOCKED to the condition". `BLOCKED` also covers a red
 * unit test, a pending check and a missing review, and rebasing + force-pushing
 * any of those is worse than the hang it replaces. So the rule under test here
 * is a CONJUNCTION, and both directions matter:
 *
 *   - a version-collision BLOCKED **recovers**
 *   - a plain failing-test BLOCKED **does not**
 *
 * Everything else in this file exists to pin the edges of that conjunction —
 * most importantly that an UNKNOWN verdict never recovers, because a degraded
 * read is the only way a wrong recovery could ever be reached.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyLanding,
  renderDecision,
  failingChecks,
  pendingChecks,
  type CheckRunSummary,
} from '../../lib/land-pr-classify.js';

const CLEAN_INSTALL_FAILED: CheckRunSummary[] = [
  { name: 'clean-install', status: 'COMPLETED', conclusion: 'FAILURE' },
  { name: 'check-version', status: 'COMPLETED', conclusion: 'SUCCESS' },
];

const UNIT_TESTS_FAILED: CheckRunSummary[] = [
  { name: 'clean-install', status: 'COMPLETED', conclusion: 'SUCCESS' },
  { name: 'unit-tests', status: 'COMPLETED', conclusion: 'FAILURE' },
];

const RUNNING: CheckRunSummary[] = [
  { name: 'clean-install', status: 'IN_PROGRESS' },
  { name: 'check-version', status: 'QUEUED' },
];

describe('classifyLanding', () => {
  //
  // The two directions the whole issue turns on.
  //
  it('RECOVERS a BLOCKED PR whose VERSION the authority says collides', () => {
    // The #2166 shape, verbatim: `clean-install` red carrying
    // check-version-unique's "ALREADY CLAIMED by an older open PR (#2165)".
    const d = classifyLanding({
      mergeStateStatus: 'BLOCKED',
      checks: CLEAN_INSTALL_FAILED,
      versionVerdict: 'collision',
      versionDetail: 'VERSION 0.13.1325 is ALREADY CLAIMED by an older open PR (#2165).',
    });
    expect(d.action).toBe('recover');
    expect(d.cause).toBe('version-collision');
    expect(d.failing).toEqual(['clean-install']);
    expect(d.message).toMatch(/#2165/);
  });

  it('does NOT recover a BLOCKED PR whose only problem is a failing test', () => {
    // The reason widening the DIRTY test to `DIRTY || BLOCKED` would have been
    // worse than the bug: a rebase restarts CI on a failure it cannot fix, and
    // force-pushes a PR nobody asked it to rewrite.
    const d = classifyLanding({
      mergeStateStatus: 'BLOCKED',
      checks: UNIT_TESTS_FAILED,
      versionVerdict: 'unique',
      versionDetail: 'VERSION 0.13.1400 is not claimed by any older open PR (2 checked).',
    });
    expect(d.action).toBe('wait');
    expect(d.cause).toBe('checks-failed');
    expect(d.failing).toEqual(['unit-tests']);
    // And it must SAY so — the silence was the other half of ace#2175.
    expect(d.message).toMatch(/unit-tests/);
    expect(d.message).toMatch(/NOT a version collision/);
  });

  //
  // The edges of the conjunction.
  //
  it('never recovers on an UNKNOWN verdict — a degraded read is not a licence', () => {
    // The only path by which a wrong recovery could be reached. `unknown` is
    // what the classifier returns when it could not fetch, could not list the
    // open PRs, or could not read VERSION. It must fall on the wait side even
    // when every check is red and the PR looks exactly like a collision.
    const d = classifyLanding({
      mergeStateStatus: 'BLOCKED',
      checks: CLEAN_INSTALL_FAILED,
      versionVerdict: 'unknown',
      versionDetail: 'could not list the open PRs',
    });
    expect(d.action).toBe('wait');
    expect(d.cause).toBe('version-verdict-unavailable');
    expect(d.message).toMatch(/Refusing to rebase on an unknown/);
  });

  it('waits on pending checks — BLOCKED-because-CI-is-running is auto-merge working', () => {
    const d = classifyLanding({
      mergeStateStatus: 'BLOCKED',
      checks: RUNNING,
      versionVerdict: 'unique',
    });
    expect(d.action).toBe('wait');
    expect(d.cause).toBe('checks-pending');
    expect(d.pending).toEqual(['clean-install', 'check-version']);
  });

  it('names the review/protection case rather than pretending it understands it', () => {
    const d = classifyLanding({
      mergeStateStatus: 'BLOCKED',
      checks: [{ name: 'clean-install', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      versionVerdict: 'unique',
    });
    expect(d.action).toBe('wait');
    expect(d.cause).toBe('blocked-other');
    expect(d.message).toMatch(/review/i);
  });

  it('says nothing about a PR that is not BLOCKED — DIRTY stays the DIRTY path', () => {
    // The DIRTY branch in land-pr.sh is unchanged and still necessary (a merge
    // queue ejects on a real conflict). This classifier must not annex it.
    for (const state of ['DIRTY', 'CLEAN', 'UNKNOWN', 'BEHIND']) {
      const d = classifyLanding({
        mergeStateStatus: state,
        checks: CLEAN_INSTALL_FAILED,
        versionVerdict: 'collision',
      });
      expect(d.action, state).toBe('none');
      expect(d.cause, state).toBe('not-blocked');
    }
  });

  it('reads the collision ahead of the checks — the red check IS the collision', () => {
    // Ordering matters: on a real collision `clean-install` is red BECAUSE of
    // it, so a checks-first rule would report the symptom as the cause and
    // decline to fix the thing it just diagnosed.
    const d = classifyLanding({
      mergeStateStatus: 'BLOCKED',
      checks: CLEAN_INSTALL_FAILED,
      versionVerdict: 'collision',
      versionDetail: 'VERSION 0.13.1325 is ALREADY on origin/main.',
    });
    expect(d.cause).toBe('version-collision');
  });

  it('is case-insensitive about GitHub state spellings', () => {
    const d = classifyLanding({
      mergeStateStatus: 'blocked',
      checks: [{ name: 'x', status: 'completed', conclusion: 'failure' }],
      versionVerdict: 'unique',
    });
    expect(d.action).toBe('wait');
    expect(d.cause).toBe('checks-failed');
    expect(d.failing).toEqual(['x']);
  });
});

describe('check bucketing', () => {
  it('counts every completed-not-passing conclusion as failing, not just FAILURE', () => {
    // A cancelled or timed-out required check blocks the merge exactly as hard
    // as a failed one, and reporting it as "pending" would be a lie the reader
    // acts on.
    const checks: CheckRunSummary[] = [
      { name: 'a', status: 'COMPLETED', conclusion: 'FAILURE' },
      { name: 'b', status: 'COMPLETED', conclusion: 'TIMED_OUT' },
      { name: 'c', status: 'COMPLETED', conclusion: 'CANCELLED' },
      { name: 'd', status: 'COMPLETED', conclusion: 'ACTION_REQUIRED' },
      { name: 'e', status: 'COMPLETED', conclusion: 'STARTUP_FAILURE' },
      { name: 'f', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'g', status: 'COMPLETED', conclusion: 'NEUTRAL' },
      { name: 'h', status: 'COMPLETED', conclusion: 'SKIPPED' },
    ];
    expect(failingChecks(checks)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(pendingChecks(checks)).toEqual([]);
  });

  it('treats a legacy StatusContext (state, no status) as completed', () => {
    // `statusCheckRollup` mixes CheckRun and StatusContext; the script maps
    // `state` onto `conclusion`, so a green StatusContext must not read as
    // forever-pending and hold the report open.
    const checks: CheckRunSummary[] = [
      { name: 'legacy-ok', conclusion: 'SUCCESS' },
      { name: 'legacy-bad', conclusion: 'ERROR' },
      { name: 'legacy-waiting', conclusion: 'PENDING' },
    ];
    expect(failingChecks(checks)).toEqual(['legacy-bad']);
    expect(pendingChecks(checks)).toEqual(['legacy-waiting']);
  });
});

describe('renderDecision', () => {
  it('emits one key per line, values on a single line, for a bash `case` to read', () => {
    // land-pr.sh has no JSON parser. A `detail` that wrapped would be silently
    // truncated to its first line, which is how a report starts lying.
    const out = renderDecision(
      classifyLanding({
        mergeStateStatus: 'BLOCKED',
        checks: CLEAN_INSTALL_FAILED,
        versionVerdict: 'collision',
        versionDetail: 'VERSION 0.13.1325 is ALREADY CLAIMED\nby an older open PR (#2165).',
      }),
    );
    const lines = out.split('\n');
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe('action=recover');
    expect(lines[1]).toBe('cause=version-collision');
    expect(lines[2]).toBe('failing=clean-install');
    expect(lines[3]).toBe('pending=');
    expect(lines[4]).toMatch(/^detail=.*#2165/);
  });
});
