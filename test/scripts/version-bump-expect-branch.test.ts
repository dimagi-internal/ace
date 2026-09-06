import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

/**
 * `version-bump.sh --expect-branch` — the executable backstop for ace#2001.
 *
 * `isolation: "worktree"` on the `Agent` call is the fix. This is what catches
 * a dispatch path that forgot it, and it is placed at the very top of the ship
 * loop's first command so it fires BEFORE `git add -A` — the step that does the
 * damage, and the one that cannot tell whose file it is staging.
 *
 * `test/agents/fix-and-ship-isolation.test.ts` asserts the four documents and
 * this script agree that the flag exists. This file proves the flag WORKS,
 * by running the real script both ways.
 */

const REPO = resolve(__dirname, '..', '..');
const SCRIPT = resolve(REPO, 'scripts/version-bump.sh');

function run(args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('bash', [SCRIPT, ...args], {
      cwd: REPO,
      encoding: 'utf8',
      // `none` skips the open-PR claim scan; this test is about the guard, and
      // a `gh` round trip would make it slow and network-dependent.
      env: { ...process.env, ACE_VERSION_CLAIMS: 'none' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (e: any) {
    return { code: e.status ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

const currentBranch = () =>
  execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();

describe('version-bump.sh --expect-branch (ace#2001)', () => {
  /**
   * NEGATIVE CONTROL — the whole point. A branch that is not ours must stop
   * the bump dead, before any repo state is read, with a distinct exit code
   * so a caller can tell it apart from a real bump failure (exit 1) or a bad
   * argument (exit 2).
   */
  it('refuses, exit 4, when HEAD is not the branch the caller started on', () => {
    const r = run(['--expect-branch', 'no-such-branch-ace2001']);
    expect(r.code).toBe(4);
    expect(r.stderr).toContain('REFUSING to bump');
    expect(r.stderr).toContain('no-such-branch-ace2001');
    expect(r.stderr).toContain(currentBranch());
    // The message must name the CAUSE and the real fix, not just the symptom —
    // an agent that reads "branch mismatch" retries; one that reads this
    // dispatches with the isolation flag.
    expect(r.stderr).toContain('ace#2001');
    expect(r.stderr).toContain('isolation: "worktree"');
    expect(r.stderr).toContain('git add -A');
    // Nothing was written.
    expect(r.stdout).toBe('');
  });

  /**
   * POSITIVE CONTROL — proves the guard is not simply always-refusing, which
   * a negative-only test cannot distinguish. Pointed at the branch we are
   * actually on it must fall through and do its normal work.
   */
  it('proceeds when HEAD is still the caller\'s branch', () => {
    const r = run(['--expect-branch', currentBranch(), '--dry-run']);
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain('REFUSING');
    expect(r.stdout.trim().split('\n').pop()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  /**
   * CONTROL — the flag is opt-in, so no existing caller changed behaviour.
   * A bare `--dry-run` must be untouched by any of this.
   */
  it('a bare run is unaffected — the guard is opt-in', () => {
    const r = run(['--dry-run']);
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain('REFUSING');
    expect(r.stdout.trim().split('\n').pop()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  /**
   * CONTROL — a flag that silently accepts an empty value is worse than no
   * flag: `--expect-branch "$BRANCH"` with an unset BRANCH would compare
   * against "" and pass, giving false assurance at exactly the moment the
   * caller's bookkeeping already broke.
   */
  it('rejects an empty or missing branch name rather than passing vacuously', () => {
    for (const args of [['--expect-branch'], ['--expect-branch', '']]) {
      const r = run(args);
      expect(r.code, `args=${JSON.stringify(args)}`).toBe(2);
      expect(r.stderr).toContain('needs a branch name');
    }
  });
});
