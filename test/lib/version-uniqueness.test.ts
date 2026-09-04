/**
 * ace#1593 — a PR's VERSION must advance past origin/main's live tip.
 *
 * The regression this pins is not "a version got skipped". It is that two
 * different trees shipped behind ONE version, and because the plugin cache is
 * keyed by version, the second one was on `main` and unreachable by
 * `/ace:update` simultaneously — with VERSION, plugin.json and
 * installed_plugins.json all reading correct. Nothing was red.
 *
 * Measured 2026-08-24, one sweep of ~20 PRs: 4 collided (0.13.953, .954, .961,
 * .962, .963, .964 each carried multiple merges); 3 needed a follow-up bump PR
 * purely to become reachable (#1597, #1598, #1588).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseSemVer,
  compareSemVer,
  checkVersionAdvances,
  checkVersionUnclaimed,
} from '../../lib/version-uniqueness.js';

describe('parseSemVer', () => {
  it('accepts MAJOR.MINOR.PATCH and tolerates surrounding whitespace', () => {
    expect(parseSemVer('0.13.972')).toEqual({ major: 0, minor: 13, patch: 972 });
    expect(parseSemVer('  0.13.972\n')).toEqual({ major: 0, minor: 13, patch: 972 });
  });

  it('rejects anything that is not exactly three numeric components', () => {
    for (const bad of ['', '0.13', '0.13.972.1', 'v0.13.972', '0.13.x', 'main']) {
      expect(parseSemVer(bad), `should reject ${JSON.stringify(bad)}`).toBeNull();
    }
  });
});

describe('compareSemVer', () => {
  it('orders by major, then minor, then patch', () => {
    const v = (s: string) => parseSemVer(s)!;
    expect(compareSemVer(v('1.0.0'), v('0.99.99'))).toBe(1);
    expect(compareSemVer(v('0.14.0'), v('0.13.999'))).toBe(1);
    expect(compareSemVer(v('0.13.973'), v('0.13.972'))).toBe(1);
    expect(compareSemVer(v('0.13.972'), v('0.13.972'))).toBe(0);
    expect(compareSemVer(v('0.13.971'), v('0.13.972'))).toBe(-1);
  });

  it('compares patch numerically, not lexically', () => {
    // '9' > '10' as strings; the whole gate would invert on a string compare.
    const v = (s: string) => parseSemVer(s)!;
    expect(compareSemVer(v('0.13.10'), v('0.13.9'))).toBe(1);
  });
});

describe('checkVersionAdvances', () => {
  it('passes when the branch is strictly ahead', () => {
    const r = checkVersionAdvances('0.13.973', '0.13.972');
    expect(r.ok).toBe(true);
    expect(r.comparison).toBe('ahead');
  });

  it('FAILS on the exact collision shape that shipped unreachable code', () => {
    const r = checkVersionAdvances('0.13.964', '0.13.964');
    expect(r.ok).toBe(false);
    expect(r.comparison).toBe('equal');
    // The message has to explain the consequence, not just say "duplicate" —
    // an agent that does not understand WHY will force past it.
    expect(r.message).toMatch(/ALREADY on origin\/main/);
    expect(r.message).toMatch(/keyed by version/);
    expect(r.message).toMatch(/ace#1593/);
  });

  it('names the race-free recovery, not the naive one', () => {
    // The documented recipe without --disable-auto loses the race: auto-merge
    // fires on the pre-rebase head and the force-push no-ops.
    const r = checkVersionAdvances('0.13.964', '0.13.964');
    expect(r.message).toMatch(/--disable-auto/);
    expect(r.message).toMatch(/--rebase-first/);
    expect(r.message.indexOf('--disable-auto')).toBeLessThan(
      r.message.indexOf('--rebase-first'),
    );
  });

  it('FAILS a stale branch that is behind main', () => {
    const r = checkVersionAdvances('0.13.960', '0.13.972');
    expect(r.ok).toBe(false);
    expect(r.comparison).toBe('behind');
  });

  it('FAILS closed on unparseable input rather than passing by accident', () => {
    for (const [c, b] of [
      ['', '0.13.972'],
      ['0.13.972', ''],
      ['not-a-version', '0.13.972'],
    ] as const) {
      const r = checkVersionAdvances(c, b);
      expect(r.ok, `${JSON.stringify(c)} vs ${JSON.stringify(b)} must not pass`).toBe(false);
      expect(r.comparison).toBe('unparseable');
    }
  });

  it('does not leak raw whitespace into the operator-facing message', () => {
    const r = checkVersionAdvances('0.13.972\n', '0.13.972\n');
    expect(r.message).toMatch(/VERSION 0\.13\.972 is ALREADY/);
  });
});

describe('the gate is wired into the REQUIRED check', () => {
  const wf = readFileSync(
    join(__dirname, '..', '..', '.github', 'workflows', 'clean-install.yml'),
    'utf8',
  );

  it('runs in clean-install, not only in the advisory version-check workflow', () => {
    // version-check.yml is NOT in main's required_status_checks, so an
    // assertion placed only there blocks nothing. This is the whole reason
    // ace#1593 escaped.
    expect(
      wf,
      'the version gate must live in clean-install — the only REQUIRED check on main',
    ).toMatch(/scripts\/check-version-unique\.ts/);
  });

  it('gates pull requests AND backstops pushes to main', () => {
    expect(wf).toMatch(/if: github\.event_name == 'pull_request'/);
    expect(wf).toMatch(/--post-merge/);
    expect(wf).toMatch(/if: github\.event_name == 'push'/);
  });
});

describe('checkVersionUnclaimed — the merge-time half of ace#1593 (ace#1776)', () => {
  // Reading origin/main LIVE closed "already on main at check time". It cannot
  // close "became non-unique between check time and merge time", because
  // `main`'s protection has required_status_checks.strict = false:
  //
  //   $ gh api repos/dimagi-internal/ace/branches/main/protection \
  //       --jq '{strict_up_to_date: .required_status_checks.strict}'
  //   {"strict_up_to_date":false}
  //
  // So the check runs once, against main as it was. Two PRs off one base both
  // bump to N, both pass, and both merge — with NO conflict, because the two
  // VERSION files are byte-identical and GitHub reports mergeState=CLEAN.
  //
  // Three duplicate pairs landed on main in the 40 first-parent merges to
  // 2026-09-04, every one of them AFTER ace#1593 closed, and in every pair both
  // PRs were open at the same time:
  //
  //   0.13.1114  #1898 @ 14:29:23  and  #1899 @ 14:29:12   (11 seconds apart)
  //   0.13.1134  #1916 @ 13:06:40  and  #1915 @ 13:05:44
  //   0.13.1103  #1874 @ 06:54:00  and  #1873 @ 06:49:12
  //
  // Which is the point: the distinguishing fact WAS available at check time —
  // just not from `main`.

  it('FAILS when an older open PR has already claimed the same version', () => {
    // The real #1898 / #1899 pair. #1898 is the lower number, so it opened
    // first and keeps 0.13.1114; #1899 is the one asked to move.
    const res = checkVersionUnclaimed('0.13.1114', 1899, [
      { number: 1898, version: '0.13.1114' },
      { number: 1897, version: '0.13.1110' },
    ]);
    expect(res.ok).toBe(false);
    expect(res.comparison).toBe('equal');
    expect(res.message).toMatch(/ALREADY CLAIMED by an older open PR \(#1898\)/);
    expect(res.message, 'the remedy must be the race-free one').toMatch(/--disable-auto/);
  });

  it('does NOT fail the older PR of a colliding pair — the tiebreak is one-sided', () => {
    // If both PRs failed on seeing each other, two concurrent checks would both
    // go red and neither could proceed without a human. Exactly one moves.
    const res = checkVersionUnclaimed('0.13.1114', 1898, [
      { number: 1899, version: '0.13.1114' },
    ]);
    expect(res.ok, 'the PR that opened FIRST keeps the number').toBe(true);
  });

  it('ignores its own claim', () => {
    const res = checkVersionUnclaimed('0.13.1150', 1937, [
      { number: 1937, version: '0.13.1150' },
    ]);
    expect(res.ok).toBe(true);
  });

  it('passes when every other open PR is on a different version', () => {
    const res = checkVersionUnclaimed('0.13.1150', 1937, [
      { number: 1926, version: '0.13.1141' },
      { number: 1709, version: '0.13.1017' },
    ]);
    expect(res.ok).toBe(true);
    expect(res.message).toMatch(/not claimed by any older open PR \(2 checked\)/);
  });

  it('passes on an empty claim set rather than throwing', () => {
    expect(checkVersionUnclaimed('0.13.1150', 1937, []).ok).toBe(true);
  });

  it('skips an unparseable claim instead of letting it decide anything', () => {
    const res = checkVersionUnclaimed('0.13.1150', 1937, [
      { number: 1900, version: 'not-a-version' },
      { number: 1901, version: '' },
    ]);
    expect(res.ok).toBe(true);
  });

  it('FAILS closed on its own unparseable VERSION', () => {
    const res = checkVersionUnclaimed('nonsense', 1937, []);
    expect(res.ok).toBe(false);
    expect(res.comparison).toBe('unparseable');
  });
});

describe('the claim half is actually WIRED, not silently inert (ace#1776)', () => {
  const root = join(__dirname, '..', '..');
  const workflow = readFileSync(join(root, '.github', 'workflows', 'clean-install.yml'), 'utf8');
  const gate = readFileSync(join(root, 'scripts', 'check-version-unique.ts'), 'utf8');

  it('the gate calls the claim check at all', () => {
    expect(gate).toMatch(/checkVersionUnclaimed/);
  });

  it('clean-install passes PR_NUMBER and GH_TOKEN to the gate step', () => {
    // Without either one the claim half no-ops with a log line nobody reads,
    // and the duplicate-merge class is quietly back. This is the same
    // silent-inert failure shape as ace#1593's advisory-workflow gate.
    expect(
      workflow,
      'clean-install.yml must set PR_NUMBER on the VERSION step or the open-PR\n' +
        'claim check silently skips itself (ace#1776).',
    ).toMatch(/PR_NUMBER:\s*\$\{\{\s*github\.event\.pull_request\.number\s*\}\}/);
    expect(
      workflow,
      'clean-install.yml must set GH_TOKEN on the VERSION step or `gh` cannot list\n' +
        'the open PRs and the claim check silently skips itself (ace#1776).',
    ).toMatch(/GH_TOKEN:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/);
  });
});
