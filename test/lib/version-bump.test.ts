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
});
