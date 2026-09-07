/**
 * ace#2175 — `scripts/land-pr-classify.ts` end to end, through its `--fixture`
 * classify-only mode.
 *
 * `test/lib/land-pr-classify.test.ts` pins the DECISION rule against a verdict
 * handed to it. This file pins the half that produces that verdict: the real
 * script, importing the real `lib/version-uniqueness.ts` — the same functions
 * `check-version-unique` runs inside `clean-install` — over recorded evidence.
 *
 * That is the point of re-deriving rather than scraping CI's log text. The
 * collision verdict here is computed by the authority, so it cannot drift from
 * what CI decides, and no other kind of CI failure can manufacture it. The two
 * cases that matter are the first two: identical VERSIONs on two open PRs
 * recovers, a red unit test with a perfectly good VERSION does not.
 *
 * `--fixture` reads JSON and touches neither the network nor git, so these are
 * hermetic.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(REPO_ROOT, 'scripts/land-pr-classify.ts');

let work: string;
beforeEach(() => { work = fs.mkdtempSync(path.join(os.tmpdir(), 'land-pr-classify-')); });
afterEach(() => { fs.rmSync(work, { recursive: true, force: true }); });

/** Run the real script in `--fixture` mode and parse its key=value block. */
function classify(fixture: unknown): Record<string, string> {
  const file = path.join(work, 'fixture.json');
  fs.writeFileSync(file, JSON.stringify(fixture));
  const r = spawnSync('npx', ['tsx', SCRIPT, '--fixture', file], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    timeout: 60_000,
  });
  expect(r.status, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`).toBe(0);
  const out: Record<string, string> = {};
  for (const line of r.stdout.trim().split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

/** The rollup shape `gh pr view --json statusCheckRollup` actually returns. */
const rollup = (entries: Array<[string, string | null, string]>) =>
  entries.map(([name, conclusion, status]) => ({
    __typename: 'CheckRun', name, status, conclusion, detailsUrl: 'https://example/x',
  }));

describe('land-pr-classify --fixture', () => {
  it('RECOVERS the #2166 shape: an older open PR already claims this VERSION', () => {
    // Verbatim from the live failure, 2026-09-07. #2166 bumped to 0.13.1325
    // past main's 0.13.1324 — so it ADVANCES, and the only thing wrong with it
    // is that #2165 got there first. Nothing conflicts; `clean-install` goes red
    // and the PR sits at BLOCKED. This is the case the DIRTY-only trigger missed.
    const d = classify({
      mergeStateStatus: 'BLOCKED',
      pr: 2166,
      candidateVersion: '0.13.1325',
      baselineVersion: '0.13.1324',
      claims: [{ number: 2165, version: '0.13.1325' }],
      statusCheckRollup: rollup([
        ['clean-install', 'FAILURE', 'COMPLETED'],
        ['check-version', 'SUCCESS', 'COMPLETED'],
      ]),
    });
    expect(d.action).toBe('recover');
    expect(d.cause).toBe('version-collision');
    expect(d.failing).toBe('clean-install');
    // The verdict text comes from lib/version-uniqueness.ts, not from a paraphrase.
    expect(d.detail).toMatch(/ALREADY CLAIMED by an older open PR \(#2165\)/);
  });

  it('does NOT recover a red unit test — the other direction, same BLOCKED state', () => {
    // Identical merge state, identical "a required check failed". The ONLY
    // difference is that the VERSION property still holds. If this recovered,
    // `land-pr.sh` would force-push and restart CI on a failure a rebase cannot
    // fix — strictly worse than the hang ace#2175 is about.
    const d = classify({
      mergeStateStatus: 'BLOCKED',
      pr: 2166,
      candidateVersion: '0.13.1325',
      baselineVersion: '0.13.1324',
      claims: [{ number: 2165, version: '0.13.1300' }],
      statusCheckRollup: rollup([
        ['clean-install', 'SUCCESS', 'COMPLETED'],
        ['unit-tests', 'FAILURE', 'COMPLETED'],
      ]),
    });
    expect(d.action).toBe('wait');
    expect(d.cause).toBe('checks-failed');
    expect(d.failing).toBe('unit-tests');
  });

  it('RECOVERS when main merged this exact VERSION under us', () => {
    // The ace#1593 half: `checkVersionAdvances` says `equal`. Still no git
    // conflict — the two VERSION files are byte-identical.
    const d = classify({
      mergeStateStatus: 'BLOCKED',
      pr: 2166,
      candidateVersion: '0.13.1325',
      baselineVersion: '0.13.1325',
      claims: [],
      statusCheckRollup: rollup([['clean-install', 'FAILURE', 'COMPLETED']]),
    });
    expect(d.action).toBe('recover');
    expect(d.detail).toMatch(/ALREADY on origin\/main/);
  });

  it('does NOT treat a NEWER open PR claiming the same version as our problem', () => {
    // The tiebreak in lib/version-uniqueness.ts: the PR that opened FIRST keeps
    // the number. Recovering on a newer claimant would have both PRs rebase off
    // each other forever.
    const d = classify({
      mergeStateStatus: 'BLOCKED',
      pr: 2165,
      candidateVersion: '0.13.1325',
      baselineVersion: '0.13.1324',
      claims: [{ number: 2166, version: '0.13.1325' }],
      statusCheckRollup: rollup([['clean-install', null, 'IN_PROGRESS']]),
    });
    expect(d.action).toBe('wait');
    expect(d.cause).toBe('checks-pending');
  });

  it('reports UNKNOWN, not "unique", when the open-PR listing was unavailable', () => {
    // `claims: null` is what the live path returns when `gh pr list` fails. The
    // origin/main assertion passed, but the ace#1776 claim check did NOT run —
    // and "we did not check" must never render as "we checked and it is fine".
    const d = classify({
      mergeStateStatus: 'BLOCKED',
      pr: 2166,
      candidateVersion: '0.13.1325',
      baselineVersion: '0.13.1324',
      claims: null,
      statusCheckRollup: rollup([['clean-install', 'FAILURE', 'COMPLETED']]),
    });
    expect(d.action).toBe('wait');
    expect(d.cause).toBe('version-verdict-unavailable');
  });

  it('reports UNKNOWN on an unreadable VERSION rather than calling it a collision', () => {
    // `unparseable` fails `checkVersionAdvances` exactly as `equal` does. Only
    // one of the two is a reason to rebase; the other is a reason to stop.
    const d = classify({
      mergeStateStatus: 'BLOCKED',
      pr: 2166,
      candidateVersion: 'not-a-version',
      baselineVersion: '0.13.1324',
      claims: [],
      statusCheckRollup: rollup([['clean-install', 'FAILURE', 'COMPLETED']]),
    });
    expect(d.action).toBe('wait');
    expect(d.cause).toBe('version-verdict-unavailable');
  });

  it('leaves a DIRTY PR to the DIRTY path, collision or not', () => {
    const d = classify({
      mergeStateStatus: 'DIRTY',
      pr: 2166,
      candidateVersion: '0.13.1325',
      baselineVersion: '0.13.1325',
      claims: [],
      statusCheckRollup: [],
    });
    expect(d.action).toBe('none');
    expect(d.cause).toBe('not-blocked');
  });
});
