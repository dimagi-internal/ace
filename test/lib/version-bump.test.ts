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
  let fixtureDir = '';

  afterEach(() => {
    if (fixtureDir && fs.existsSync(fixtureDir)) {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
    fixtureDir = '';
  });

  it('computes patch+1 from local VERSION when origin is unreachable', () => {
    fixtureDir = makeFixtureRepo('0.10.14');
    const out = execFileSync('./scripts/version-bump.sh', {
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
    const out = execFileSync('./scripts/version-bump.sh', {
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
      execFileSync('./scripts/version-bump.sh', {
        cwd: fixtureDir,
        encoding: 'utf8',
        stdio: 'pipe',
      })
    ).toThrow();
  });
});
