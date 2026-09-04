// Smoke tests for scripts/version-bump.sh.
//
// We can't easily exercise the live git-fetch path inside an isolated
// fixture repo, but we CAN verify:
//   1. The script computes the next version semver-aware (0.10.9 → 0.10.10,
//      not lex 0.10.10 → 0.10.11 vs 0.10.9 → 0.10.91).
//   2. After running --dry-run, no files are mutated.
//   3. After running for real (without --dry-run) in a fixture repo, all
//      four files end up at the same new version.
//
// We build a throwaway git repo in a tempdir that has the four version-
// tracking files plus scripts/sync-version.sh and scripts/version-bump.sh
// copied in, then drive it via execFileSync.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

function makeFixtureRepo(version: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-version-bump-'));

  // Copy the two scripts under test.
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.copyFileSync(
    path.join(REPO_ROOT, 'scripts', 'version-bump.sh'),
    path.join(dir, 'scripts', 'version-bump.sh')
  );
  fs.copyFileSync(
    path.join(REPO_ROOT, 'scripts', 'sync-version.sh'),
    path.join(dir, 'scripts', 'sync-version.sh')
  );
  fs.chmodSync(path.join(dir, 'scripts', 'version-bump.sh'), 0o755);
  fs.chmodSync(path.join(dir, 'scripts', 'sync-version.sh'), 0o755);

  // Seed the four version-tracked files.
  fs.writeFileSync(path.join(dir, 'VERSION'), `${version}\n`);
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'fake', version }, null, 2) + '\n'
  );

  fs.mkdirSync(path.join(dir, '.claude-plugin'));
  fs.writeFileSync(
    path.join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'fake', version, description: 'x' }, null, 2) + '\n'
  );
  fs.writeFileSync(
    path.join(dir, '.claude-plugin', 'marketplace.json'),
    JSON.stringify(
      {
        name: 'fake',
        metadata: { version },
        plugins: [{ name: 'fake', source: './', version }],
      },
      null,
      2
    ) + '\n'
  );

  // Make it a git repo so `git rev-parse --show-toplevel` works.
  // No remote → origin fetch will silently fail and we fall back to local.
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email test@example.com', { cwd: dir });
  execSync('git config user.name test', { cwd: dir });
  execSync('git add -A', { cwd: dir });
  execSync('git commit -q -m init', { cwd: dir });

  return dir;
}

function readAllVersions(dir: string): Record<string, string> {
  const ver = fs.readFileSync(path.join(dir, 'VERSION'), 'utf8').trim();
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const plug = JSON.parse(
    fs.readFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), 'utf8')
  );
  const market = JSON.parse(
    fs.readFileSync(path.join(dir, '.claude-plugin', 'marketplace.json'), 'utf8')
  );
  return {
    VERSION: ver,
    'package.json': pkg.version,
    'plugin.json': plug.version,
    'marketplace.metadata': market.metadata.version,
    'marketplace.plugins[0]': market.plugins[0].version,
  };
}

describe('scripts/version-bump.sh', () => {
  // These exercise --force / --ci, which is where the bump arithmetic lives now.
  // A BARE invocation is a deliberate no-op since the post-merge auto-bump
  // landed — asserted separately below rather than by omission.
  let fixtureDir = '';

  afterEach(() => {
    if (fixtureDir && fs.existsSync(fixtureDir)) {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
    fixtureDir = '';
  });

  it('computes patch+1 from local VERSION when origin is unreachable', () => {
    fixtureDir = makeFixtureRepo('0.10.14');
    const out = execFileSync('./scripts/version-bump.sh', ['--force'], {
      cwd: fixtureDir,
      encoding: 'utf8',
    });
    const last = out.trim().split('\n').pop();
    expect(last).toBe('0.10.15');

    const versions = readAllVersions(fixtureDir);
    for (const [_, v] of Object.entries(versions)) {
      expect(v).toBe('0.10.15');
    }
  });

  it('handles double-digit minor and patch correctly (semver, not lex)', () => {
    // Lex sort would put 0.10.9 > 0.10.10. Verify we don't get bitten.
    fixtureDir = makeFixtureRepo('0.10.9');
    const out = execFileSync('./scripts/version-bump.sh', ['--force'], {
      cwd: fixtureDir,
      encoding: 'utf8',
    });
    const last = out.trim().split('\n').pop();
    expect(last).toBe('0.10.10');
  });

  // ── ace#1914: claim awareness ──────────────────────────────────────────────
  //
  // `max(local, origin/main) + 1` is computed at COMMIT time and a sibling
  // worktree's bump is invisible until its PR MERGES, so two branches bumping
  // in the same window pick the SAME number. Measured on the 60 clean-install
  // runs ending 2026-09-04: 12 failures, 11 of them VERSION contention, and 9
  // of those 11 were exactly this — `VERSION <n> is ALREADY on origin/main`,
  // twice with two branches literally on one number (0.13.1115 x2,
  // 0.13.1122 x2).
  //
  // These drive the claim set through ACE_VERSION_CLAIMS so they are hermetic;
  // the live path (`gh pr list` -> each head's VERSION) resolves the same list
  // and folds it in at the same point.

  it('bumps PAST a version an open PR has already claimed (ace#1914)', () => {
    fixtureDir = makeFixtureRepo('0.10.14');
    const out = execFileSync('./scripts/version-bump.sh', ['--force'], {
      cwd: fixtureDir,
      encoding: 'utf8',
      env: { ...process.env, ACE_VERSION_CLAIMS: '0.10.15' },
    });
    expect(
      out.trim().split('\n').pop(),
      'a sibling worktree already claimed 0.10.15; picking it again is the\n' +
        'collision that fails clean-install with "ALREADY on origin/main".',
    ).toBe('0.10.16');
    expect(fs.readFileSync(path.join(fixtureDir, 'VERSION'), 'utf8').trim()).toBe('0.10.16');
  });

  it('takes the HIGHEST claim, not the first or the last', () => {
    fixtureDir = makeFixtureRepo('0.10.14');
    const out = execFileSync('./scripts/version-bump.sh', ['--force'], {
      cwd: fixtureDir,
      encoding: 'utf8',
      env: { ...process.env, ACE_VERSION_CLAIMS: '0.10.31 0.10.15 0.10.9' },
    });
    // Semver-aware, not lexical: 0.10.31 beats 0.10.9.
    expect(out.trim().split('\n').pop()).toBe('0.10.32');
  });

  it('ignores an implausible claim, so one typo cannot poison every later bump', () => {
    // Without a sanity bound, a single mistyped VERSION on any open PR would
    // drag the whole repo's numbering with it until that PR closed.
    for (const bad of ['9.9.9', '0.11.0', '0.10.99999', 'not-a-version', '']) {
      fixtureDir = makeFixtureRepo('0.10.14');
      const out = execFileSync('./scripts/version-bump.sh', ['--force'], {
        cwd: fixtureDir,
        encoding: 'utf8',
        env: { ...process.env, ACE_VERSION_CLAIMS: bad },
      });
      expect(out.trim().split('\n').pop(), `claim ${JSON.stringify(bad)} was honoured`).toBe(
        '0.10.15',
      );
      fs.rmSync(fixtureDir, { recursive: true, force: true });
      fixtureDir = '';
    }
  });

  it('ACE_VERSION_CLAIMS=none restores the pre-ace#1914 arithmetic exactly', () => {
    fixtureDir = makeFixtureRepo('0.10.14');
    const out = execFileSync('./scripts/version-bump.sh', ['--force'], {
      cwd: fixtureDir,
      encoding: 'utf8',
      env: { ...process.env, ACE_VERSION_CLAIMS: 'none' },
    });
    expect(out.trim().split('\n').pop()).toBe('0.10.15');
  });

  it('--ci ignores claims — it runs ON main, where open PRs are not its question', () => {
    fixtureDir = makeFixtureRepo('0.10.14');
    const out = execFileSync('./scripts/version-bump.sh', ['--ci'], {
      cwd: fixtureDir,
      encoding: 'utf8',
      env: { ...process.env, ACE_VERSION_CLAIMS: '0.10.50' },
    });
    expect(out.trim().split('\n').pop()).toBe('0.10.15');
  });

  it('--dry-run reports the claim it bumped past', () => {
    fixtureDir = makeFixtureRepo('0.10.14');
    const out = execFileSync('./scripts/version-bump.sh', ['--dry-run'], {
      cwd: fixtureDir,
      encoding: 'utf8',
      env: { ...process.env, ACE_VERSION_CLAIMS: '0.10.20' },
    });
    expect(out, 'the operator must be able to see WHY the number jumped').toMatch(
      /claimed by an open PR=v0\.10\.20/,
    );
    expect(out.trim().split('\n').pop()).toBe('0.10.21');
  });

  // The two tests below drive the LIVE scan path (`gh pr list` -> each head's
  // VERSION) rather than the ACE_VERSION_CLAIMS seam, via a stub `gh` on PATH.
  // The seam tests prove the arithmetic; these prove the thing that actually
  // runs in a real ship.

  function stubGh(dir: string, rows: Array<{ branch: string; oid: string; version: string }>): string {
    const binDir = path.join(dir, 'stub-bin');
    fs.mkdirSync(binDir, { recursive: true });
    const list = rows.map((r) => `${r.branch}\\t${r.oid}`).join('\\n');
    const cases = rows
      .map((r) => `    *${r.oid}*) echo "${r.version}"; exit 0;;`)
      .join('\n');
    fs.writeFileSync(
      path.join(binDir, 'gh'),
      [
        '#!/usr/bin/env bash',
        'if [ "$1" = "repo" ] && [ "$2" = "view" ]; then echo "fake/repo"; exit 0; fi',
        `if [ "$1" = "pr" ] && [ "$2" = "list" ]; then printf '${list}\\n'; exit 0; fi`,
        'if [ "$1" = "api" ]; then',
        '  case "$*" in',
        cases,
        '  esac',
        '  exit 1',
        'fi',
        'exit 1',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    return binDir;
  }

  it('reads claims off OPEN PRs through gh, not just the env seam (ace#1914)', () => {
    fixtureDir = makeFixtureRepo('0.10.14');
    // A remote must exist — no remote means no GitHub, and the scan short-circuits.
    execSync('git remote add origin https://github.com/fake/repo.git', { cwd: fixtureDir });
    execSync('git checkout -q -b mine', { cwd: fixtureDir });
    const binDir = stubGh(fixtureDir, [
      { branch: 'other', oid: 'oid-other', version: '0.10.20' },
    ]);
    const out = execFileSync('./scripts/version-bump.sh', ['--dry-run'], {
      cwd: fixtureDir,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, ACE_VERSION_CLAIMS: '' },
    });
    expect(out).toMatch(/claimed by an open PR=v0\.10\.20 \(source: open-prs\)/);
    expect(out.trim().split('\n').pop()).toBe('0.10.21');
  });

  it('does NOT count its OWN open PR as a competing claim', () => {
    // Counting it inflates the bump by one on every --rebase-first recovery of
    // the same PR. Observed 2026-09-04 shipping ace#1776: origin/main was
    // 0.13.1151, PR #1938's own head already read 0.13.1152, and the recovery
    // "bumped past v0.13.1152, already claimed by an open PR" to 0.13.1153 —
    // then would have gone to 1154, 1155, … on each further rebase.
    fixtureDir = makeFixtureRepo('0.10.14');
    execSync('git remote add origin https://github.com/fake/repo.git', { cwd: fixtureDir });
    execSync('git checkout -q -b mine', { cwd: fixtureDir });
    const binDir = stubGh(fixtureDir, [
      { branch: 'mine', oid: 'oid-mine', version: '0.10.99' },
      { branch: 'other', oid: 'oid-other', version: '0.10.20' },
    ]);
    const out = execFileSync('./scripts/version-bump.sh', ['--dry-run'], {
      cwd: fixtureDir,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, ACE_VERSION_CLAIMS: '' },
    });
    expect(
      out.trim().split('\n').pop(),
      'our own branch claimed 0.10.99; counting it would give 0.10.100 and burn a\n' +
        'version on every rebase of the same PR.',
    ).toBe('0.10.21');
    expect(out, 'the reported claim must be the OTHER PR, not ours').toMatch(
      /claimed by an open PR=v0\.10\.20/,
    );
  });

  it('--dry-run prints next version but does not mutate any file', () => {
    fixtureDir = makeFixtureRepo('0.10.14');
    const before = readAllVersions(fixtureDir);
    const out = execFileSync(
      './scripts/version-bump.sh',
      ['--dry-run'],
      { cwd: fixtureDir, encoding: 'utf8' }
    );
    const last = out.trim().split('\n').pop();
    expect(last).toBe('0.10.15');

    const after = readAllVersions(fixtureDir);
    expect(after).toEqual(before);
  });

  it('rejects a malformed VERSION', () => {
    fixtureDir = makeFixtureRepo('0.10.14');
    fs.writeFileSync(path.join(fixtureDir, 'VERSION'), 'not-a-version\n');
    expect(() =>
      execFileSync('./scripts/version-bump.sh', ['--force'], {
        cwd: fixtureDir,
        encoding: 'utf8',
        stdio: 'pipe',
      })
    ).toThrow();
  });

  it('--ci bumps without consulting origin', () => {
    // The workflow runs ON main, so local IS origin; fetching there would race
    // the very push that triggered the run.
    fixtureDir = makeFixtureRepo('0.10.14');
    const out = execFileSync('./scripts/version-bump.sh', ['--ci'], {
      cwd: fixtureDir,
      encoding: 'utf8',
    });
    expect(out.trim().split('\n').pop()).toBe('0.10.15');
    expect(fs.readFileSync(path.join(fixtureDir, 'VERSION'), 'utf8').trim()).toBe('0.10.15');
  });

  it('--ci stamps a `## Unreleased` CHANGELOG heading with the new version', () => {
    // A PR cannot know its own number any more, so it writes under Unreleased
    // and the bump commit resolves it. Without this the heading would sit at
    // "Unreleased" forever and the changelog would stop being a version history.
    fixtureDir = makeFixtureRepo('0.10.14');
    fs.writeFileSync(
      path.join(fixtureDir, 'CHANGELOG.md'),
      '# Changelog\n\n## Unreleased\n\nsomething shipped\n\n## 0.10.14 — 2026-01-01\n',
    );
    execFileSync('./scripts/version-bump.sh', ['--ci'], { cwd: fixtureDir, encoding: 'utf8' });
    const log = fs.readFileSync(path.join(fixtureDir, 'CHANGELOG.md'), 'utf8');
    expect(log, 'the Unreleased heading must become the new version').toMatch(
      /^## 0\.10\.15 — \d{4}-\d{2}-\d{2}$/m,
    );
    expect(log, 'no Unreleased heading may survive the stamp').not.toMatch(/^## Unreleased/m);
    expect(log, 'the entry body must be untouched').toMatch(/something shipped/);
    expect(log, 'older entries must be untouched').toMatch(/^## 0\.10\.14 — 2026-01-01$/m);
  });

  it('--ci leaves a hand-written version heading alone', () => {
    fixtureDir = makeFixtureRepo('0.10.14');
    fs.writeFileSync(
      path.join(fixtureDir, 'CHANGELOG.md'),
      '# Changelog\n\n## 0.10.99 — 2026-01-02\n\nhand-written\n',
    );
    execFileSync('./scripts/version-bump.sh', ['--ci'], { cwd: fixtureDir, encoding: 'utf8' });
    expect(fs.readFileSync(path.join(fixtureDir, 'CHANGELOG.md'), 'utf8')).toMatch(
      /^## 0\.10\.99 — 2026-01-02$/m,
    );
  });

  it('a BARE run bumps, for as long as the PR gate requires a bump', () => {
    // This pairing broke for real on 2026-08-27 (0.13.1042 -> 0.13.1046).
    //
    // A bare `scripts/version-bump.sh` is line 1 of the ship loop in
    // skills/shipping. It was made a no-op on the assumption that the
    // post-merge auto-bump was about to take over — and the auto-bump could
    // NOT take over, because github-actions[bot] cannot push to a protected
    // main (GH006). Meanwhile check-version-unique.ts, which runs inside
    // clean-install (main's ONE required check), still fails a PR whose
    // VERSION origin/main already has.
    //
    // No-op bump + gate demanding a bump = nothing in the repo can merge. The
    // two are a pair, and neither may move without the other. That is what
    // this test holds; it is not about the arithmetic.
    fixtureDir = makeFixtureRepo('0.10.14');
    execFileSync('./scripts/version-bump.sh', { cwd: fixtureDir, encoding: 'utf8' });
    expect(
      fs.readFileSync(path.join(fixtureDir, 'VERSION'), 'utf8').trim(),
      'A bare run must BUMP while check-version-unique.ts requires it. If you are\n' +
        'making it a no-op again, the post-merge auto-bump must be LIVE and the gate\n' +
        'relaxed in the SAME change — verify the bot can actually push to main first\n' +
        '(see .github/workflows/auto-version-bump.yml, which records that it cannot).',
    ).toBe('0.10.15');
  });

  it('check-version-unique.ts still requires the PR to advance VERSION', () => {
    // The other half of the pair, asserted from the gate's side so that
    // relaxing it without reviving the bump also fails here.
    const gate = fs.readFileSync(
      path.join(__dirname, '..', '..', 'scripts', 'check-version-unique.ts'),
      'utf8',
    );
    expect(
      gate,
      'the PR arm must still compare against origin/main and fail on equal/behind',
    ).toMatch(/checkVersionAdvances/);
    expect(
      /touchesVersion/.test(gate),
      'check-version-unique.ts has been relaxed to skip PRs that do not touch\n' +
        'VERSION. That is only safe once the post-merge auto-bump is LIVE — and as\n' +
        'of 0.13.1046 it is not (it cannot push to a protected main). If you have\n' +
        'fixed that, delete this assertion and the bare-run one above together.',
    ).toBe(false);
  });

  it('--rebase-first folds the bump into the rebased tip (HEAD, not just the worktree)', () => {
    // 0.13.1046 deleted the VERSION_FILES array declaration. `set -u` turned
    // every reference into an unbound-variable error, so --rebase-first stopped
    // `git add`-ing the bump AND stopped running the guard that exists to catch
    // exactly that (jjackson/ace#578). The result: a branch whose code is new
    // and whose VERSION still equals main's — the failure mode the plugin cache
    // turns into "merged and unreachable by /ace:update".
    //
    // `bash -n` passes on that bug; only running the path finds it. So this
    // test runs it, against a real origin, and asserts on HEAD rather than the
    // working tree — checking the worktree is what hid it the first time.
    fixtureDir = makeFixtureRepo('0.10.14');

    // Give the fixture a real `origin` with a `main` to rebase onto.
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-version-remote-'));
    execSync('git init -q --bare', { cwd: remote });
    execSync(`git remote add origin ${remote}`, { cwd: fixtureDir });
    execSync('git branch -M main', { cwd: fixtureDir });
    execSync('git push -q origin main', { cwd: fixtureDir });

    // A feature commit on a branch, so the rebase has something to replay.
    execSync('git checkout -q -b feature', { cwd: fixtureDir });
    fs.writeFileSync(path.join(fixtureDir, 'feature.txt'), 'work\n');
    execSync('git add -A && git commit -q -m feature', { cwd: fixtureDir });

    const out = execFileSync('./scripts/version-bump.sh', ['--rebase-first'], {
      cwd: fixtureDir,
      encoding: 'utf8',
    });
    expect(out, 'no unbound-variable or other shell error').not.toMatch(/unbound variable/);

    // HEAD, not the worktree. This is the assertion that matters.
    const headVersion = execSync('git show HEAD:VERSION', {
      cwd: fixtureDir,
      encoding: 'utf8',
    }).trim();
    expect(
      headVersion,
      'the bump must be COMMITTED by --rebase-first. If it is only in the working\n' +
        'tree, the branch pushes with main\'s version and the change lands\n' +
        'unreachable by /ace:update (jjackson/ace#578).',
    ).toBe('0.10.15');

    // And every version file must be clean afterwards — the state the in-script
    // guard asserts, verified here independently of it.
    const dirty = execSync(
      'git status --porcelain -- VERSION package.json .claude-plugin/',
      { cwd: fixtureDir, encoding: 'utf8' },
    ).trim();
    expect(dirty, `version files still dirty after --rebase-first:\n${dirty}`).toBe('');

    fs.rmSync(remote, { recursive: true, force: true });
  });

  it('--rebase-first auto-resolves a package-lock.json conflict instead of aborting (ace#1778)', () => {
    // package-lock.json was deliberately EXCLUDED from VERSION_FILES on the
    // premise that "sync-version.sh rewrites it from VERSION rather than
    // merging it, so it does not take a rebase conflict." That reasoning is
    // backwards: being rewritten from VERSION is precisely what makes it
    // conflict, since two parallel branches rewrite the same two lines to
    // different values — the identical mechanism as the other four files.
    //
    // So a REAL parallel collision conflicted in five files while the allowlist
    // covered four, the all-conflicts-are-version-files test failed, and
    // --rebase-first aborted on the exact scenario it exists to handle. That is
    // the documented version-collision recipe in CLAUDE.md, so the flag failed
    // at its only job. Observed shipping ace#1777.
    //
    // This test forces the five-file conflict and asserts the rebase completes.
    fixtureDir = makeFixtureRepo('0.10.14');

    const lockPath = path.join(fixtureDir, 'package-lock.json');
    const setAll = (v: string) => {
      fs.writeFileSync(path.join(fixtureDir, 'VERSION'), `${v}\n`);
      fs.writeFileSync(
        path.join(fixtureDir, 'package.json'),
        JSON.stringify({ name: 'fake', version: v }, null, 2) + '\n'
      );
      fs.writeFileSync(
        path.join(fixtureDir, '.claude-plugin', 'plugin.json'),
        JSON.stringify({ name: 'fake', version: v, description: 'x' }, null, 2) + '\n'
      );
      fs.writeFileSync(
        path.join(fixtureDir, '.claude-plugin', 'marketplace.json'),
        JSON.stringify(
          {
            name: 'fake',
            metadata: { version: v },
            plugins: [{ name: 'fake', source: './', version: v }],
          },
          null,
          2
        ) + '\n'
      );
      fs.writeFileSync(
        lockPath,
        JSON.stringify(
          {
            name: 'fake',
            version: v,
            lockfileVersion: 3,
            packages: { '': { name: 'fake', version: v } },
          },
          null,
          2
        ) + '\n'
      );
    };

    // Seed the lockfile into the base commit so both sides can diverge on it.
    setAll('0.10.14');
    execSync('git add -A && git commit -q -m lockfile', { cwd: fixtureDir });

    const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-version-remote-'));
    execSync('git init -q --bare', { cwd: remote });
    execSync(`git remote add origin ${remote}`, { cwd: fixtureDir });
    execSync('git branch -M main', { cwd: fixtureDir });
    execSync('git push -q origin main', { cwd: fixtureDir });

    // Our branch bumps to 0.10.50 and carries a real code change.
    execSync('git checkout -q -b feature', { cwd: fixtureDir });
    setAll('0.10.50');
    fs.writeFileSync(path.join(fixtureDir, 'feature.txt'), 'work\n');
    execSync('git add -A && git commit -q -m feature', { cwd: fixtureDir });

    // Meanwhile another worktree bumped main to 0.10.99 — the parallel bump.
    execSync('git checkout -q main', { cwd: fixtureDir });
    setAll('0.10.99');
    execSync('git add -A && git commit -q -m "parallel bump"', { cwd: fixtureDir });
    execSync('git push -q origin main', { cwd: fixtureDir });
    execSync('git checkout -q feature', { cwd: fixtureDir });

    let out = '';
    try {
      out = execFileSync('./scripts/version-bump.sh', ['--rebase-first'], {
        cwd: fixtureDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err: any) {
      const stderr = String(err?.stderr ?? '');
      throw new Error(
        '--rebase-first aborted on a parallel bump instead of auto-resolving.\n' +
          'If stderr names package-lock.json as a conflict "outside version files",\n' +
          'it is missing from VERSION_FILES in scripts/version-bump.sh (ace#1778).\n' +
          `stderr:\n${stderr}`
      );
    }

    expect(out, 'no unbound-variable or other shell error').not.toMatch(/unbound variable/);

    // The rebase must have landed, keeping our feature commit.
    const files = execSync('git show --pretty= --name-only HEAD~1..HEAD || true', {
      cwd: fixtureDir,
      encoding: 'utf8',
    });
    expect(files, 'the feature commit must survive the rebase').toContain('feature.txt');

    // Every version file agrees at HEAD, lockfile included — the point of the fix.
    const headVersion = execSync('git show HEAD:VERSION', {
      cwd: fixtureDir,
      encoding: 'utf8',
    }).trim();
    const headLock = JSON.parse(
      execSync('git show HEAD:package-lock.json', { cwd: fixtureDir, encoding: 'utf8' })
    );
    expect(headLock.version, 'package-lock top-level version must match VERSION').toBe(
      headVersion
    );
    expect(
      headLock.packages[''].version,
      'package-lock packages[""] version must match VERSION'
    ).toBe(headVersion);

    // And it must have advanced past main's parallel bump, not re-used it.
    expect(
      headVersion.startsWith('0.10.') && Number(headVersion.split('.')[2]) > 99,
      `expected a version above main's 0.10.99, got ${headVersion}`
    ).toBe(true);

    fs.rmSync(remote, { recursive: true, force: true });
  });

  it('--rebase-first never REWRITES origin/main\'s own tip when the branch has no unmerged commits (ace#1852)', () => {
    // The amend added by jjackson/ace#578 asks "did the bump land?" and never
    // "which commit did it land IN?". It assumes the rebased tip is one of
    // YOUR commits. When the branch has ZERO unmerged commits — its previous
    // PR already merged and you are starting fresh work on the same branch
    // name — the rebased tip IS origin/main's own commit, so the amend
    // rewrites it. HEAD becomes a new-sha copy of somebody else's merge
    // commit, carrying your bump, under their authorship, and the script
    // prints its success line and exits 0.
    //
    // Observed live on emdash/spark-iyg5w while shipping ace#1851. The
    // assertion that catches it is ANCESTRY, not cleanliness: the upstream tip
    // must still be reachable from HEAD afterwards.
    fixtureDir = makeFixtureRepo('0.10.14');

    const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-version-remote-'));
    execSync('git init -q --bare', { cwd: remote });
    execSync(`git remote add origin ${remote}`, { cwd: fixtureDir });
    execSync('git branch -M main', { cwd: fixtureDir });
    execSync('git push -q origin main', { cwd: fixtureDir });

    // Put SOMEBODY ELSE's merge commit on origin/main — the thing that must
    // not be rewritten.
    execSync('git checkout -q -b other', { cwd: fixtureDir });
    fs.writeFileSync(path.join(fixtureDir, 'their.txt'), 'their work\n');
    execSync('git add -A', { cwd: fixtureDir });
    execSync('git commit -q -m "their work"', {
      cwd: fixtureDir,
      env: { ...process.env, GIT_AUTHOR_NAME: 'Someone Else', GIT_AUTHOR_EMAIL: 'other@example.com' },
    });
    execSync('git checkout -q main', { cwd: fixtureDir });
    execSync('git merge -q --no-ff other -m "Merge pull request #1849 from dimagi-internal/other"', {
      cwd: fixtureDir,
      env: { ...process.env, GIT_AUTHOR_NAME: 'Someone Else', GIT_AUTHOR_EMAIL: 'other@example.com' },
    });
    execSync('git push -q origin main', { cwd: fixtureDir });
    execSync('git branch -q -D other', { cwd: fixtureDir });

    // The branch under test: sitting exactly on main, zero unmerged commits,
    // with uncommitted working-tree edits — the state the ship loop hits when
    // a previous PR on this branch name has merged.
    execSync('git checkout -q -B feature main', { cwd: fixtureDir });
    fs.writeFileSync(path.join(fixtureDir, 'mywork.txt'), 'my edit\n');

    const upstreamTip = execSync('git rev-parse origin/main', {
      cwd: fixtureDir,
      encoding: 'utf8',
    }).trim();

    execFileSync('./scripts/version-bump.sh', ['--rebase-first'], {
      cwd: fixtureDir,
      encoding: 'utf8',
    });

    // THE assertion. Before ace#1852's fix, HEAD was a rewritten copy of
    // `upstreamTip` with a different sha, and this is false.
    const isAncestor = (() => {
      try {
        execSync(`git merge-base --is-ancestor ${upstreamTip} HEAD`, { cwd: fixtureDir });
        return true;
      } catch {
        return false;
      }
    })();
    const headSubject = execSync("git log -1 --format=%s HEAD", {
      cwd: fixtureDir,
      encoding: 'utf8',
    }).trim();
    expect(
      isAncestor,
      "--rebase-first REWROTE origin/main's own tip. HEAD is now a new-sha copy of\n" +
        `an upstream commit (subject: ${headSubject}) instead of a commit of ours.\n` +
        'Guard the amend on ancestry — see scripts/version-bump.sh (ace#1852).',
    ).toBe(true);

    // And the bump must still have landed in HEAD (ace#578's invariant).
    expect(
      execSync('git show HEAD:VERSION', { cwd: fixtureDir, encoding: 'utf8' }).trim(),
      'the bump must still be committed, just in a commit of our own',
    ).toBe('0.10.15');

    const dirty = execSync(
      'git status --porcelain -- VERSION package.json .claude-plugin/',
      { cwd: fixtureDir, encoding: 'utf8' },
    ).trim();
    expect(dirty, `version files still dirty:\n${dirty}`).toBe('');

    fs.rmSync(remote, { recursive: true, force: true });
  });
});
