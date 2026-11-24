import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

/**
 * A merge-queue dequeue must say so ON THE PR.
 *
 * ## The failure this guards
 *
 * `unit-tests` is skipped on `pull_request` by design — running the full suite
 * on every PR would tax every merge to catch a rare failure, and this repo
 * merges constantly. The consequence is that the full suite first runs in the
 * merge GROUP, after the PR is already green. When it fails there GitHub
 * dequeues the PR and writes nothing back: the PR's checks still read pass,
 * and the failing run lives on a `gh-readonly-queue/...` ref that is DELETED
 * on dequeue, so the evidence disappears with it.
 *
 * Measured on PR #3438: dequeued five times across six days while reading
 * CLEAN the whole way. Two sessions independently concluded it was a
 * permissions or merge-queue-config problem and escalated on that; both were
 * wrong, and the actual cause each time was a plain test failure nobody could
 * see. The bugs cost minutes; the silence cost six days.
 *
 * So the reporting job is the invariant, and these are the properties that
 * make it work. Each assertion below corresponds to a way it could be present
 * but useless.
 */

const WORKFLOW = join(__dirname, '../../.github/workflows/clean-install.yml');
const JOB = 'report-merge-group-failure';

function jobs(): Record<string, any> {
  return parse(readFileSync(WORKFLOW, 'utf8')).jobs;
}

describe('merge-group failures are reported back on the PR', () => {
  it('the reporting job exists', () => {
    expect(Object.keys(jobs())).toContain(JOB);
  });

  it('fires only when the merge-group run actually failed', () => {
    const cond = jobs()[JOB].if as string;
    // `always()` is required or the job is skipped on failure; the other two
    // clauses are what keep it free on a green run and off non-queue events.
    expect(cond).toContain('always()');
    expect(cond).toContain("github.event_name == 'merge_group'");
    expect(cond).toMatch(/needs\.clean-install\.result\s*==\s*'failure'/);
  });

  it('costs nothing on a passing run — it is never unconditional', () => {
    // The whole justification for this over "run unit tests on every PR" is
    // that a green run pays zero. A job without a failure guard breaks that.
    const cond = jobs()[JOB].if as string;
    expect(cond).not.toBe('always()');
    expect(cond).toMatch(/failure/);
  });

  it('can actually write to the PR', () => {
    // Without this the job runs, the gh call 403s, and the dequeue stays
    // silent — the exact failure, now with a green job next to it.
    expect(jobs()[JOB].permissions).toMatchObject({ 'pull-requests': 'write' });
  });

  it('declares every job whose result it reads', () => {
    // `needs.<job>.result` resolves ONLY for jobs listed in `needs`. Reading an
    // undeclared one yields empty, which silently mislabels what failed.
    const job = jobs()[JOB];
    const needs: string[] = job.needs;
    const script = JSON.stringify(job.steps);
    for (const referenced of ['static-checks', 'unit-tests', 'clean-install']) {
      if (script.includes(`needs.${referenced}.result`)) {
        expect(needs, `${referenced} is read but not in needs`).toContain(referenced);
      }
    }
  });

  it('passes the ref through env rather than inlining it into the shell', () => {
    // A ref is attacker-shaped input; `${{ github.ref }}` inside a run: block
    // is a shell-injection sink.
    const step = jobs()[JOB].steps[0];
    expect(step.env.REF).toContain('github.ref');
    expect(step.run).not.toContain('${{ github.ref }}');
  });

  it('links the failing run, so the comment is actionable', () => {
    const step = jobs()[JOB].steps[0];
    expect(JSON.stringify(step.env)).toContain('github.run_id');
    expect(step.run).toContain('RUN_URL');
  });

  it('explains why the PR looks green, which is the whole point', () => {
    const run = jobs()[JOB].steps[0].run as string;
    expect(run).toContain('pull_request');
    expect(run.toLowerCase()).toMatch(/merge group/);
  });

  it('exits quietly when no PR number can be parsed', () => {
    // A merge group ref without pr-<n> must not fail the run: this job reports,
    // it never becomes a new way for things to break.
    const run = jobs()[JOB].steps[0].run as string;
    expect(run).toMatch(/exit 0/);
  });
});
