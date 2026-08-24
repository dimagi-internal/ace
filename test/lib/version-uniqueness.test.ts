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
