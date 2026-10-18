/**
 * ace#3143 — `/ace:update` resolves the ACE marketplace from
 * `~/.claude/plugins/known_marketplaces.json`, not a hard-coded
 * `~/.claude/plugins/marketplaces/ace`.
 *
 * A canopy cloud runner registers ACE as a DIRECTORY source
 * (`{"source":{"source":"directory","path":"/opt/agents/ace"},"installLocation":"/opt/agents/ace"}`)
 * and `~/.claude/plugins/marketplaces/` holds only `canopy`, so Step 1 used to
 * report `marketplace_missing` and advise re-adding a marketplace the runner
 * already owns. These tests pin the resolution, and run the real Step 1 block
 * from `commands/update.md` against a fixture HOME for both source shapes —
 * including that the directory branch is read-only on the runner's checkout.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAceMarketplace, formatShell } from '../../scripts/ace-marketplace-location.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOME = '/home/u';

describe('resolveAceMarketplace', () => {
  it('canopy runner: directory source resolves to installLocation, mode directory', () => {
    const known = {
      ace: { source: { source: 'directory', path: '/opt/agents/ace' }, installLocation: '/opt/agents/ace' },
      canopy: { source: { source: 'git' }, installLocation: '/home/u/.claude/plugins/marketplaces/canopy' },
    };
    expect(resolveAceMarketplace({ known, home: HOME })).toEqual({
      path: '/opt/agents/ace',
      sourceType: 'directory',
      mode: 'directory',
    });
  });

  it('directory source without installLocation falls back to source.path', () => {
    const known = { ace: { source: { source: 'directory', path: '/srv/ace' } } };
    expect(resolveAceMarketplace({ known, home: HOME }).path).toBe('/srv/ace');
  });

  it('laptop: github clone resolves to its installLocation, mode clone', () => {
    const known = {
      ace: {
        source: { source: 'github', repo: 'dimagi-internal/ace' },
        installLocation: '/home/u/.claude/plugins/marketplaces/ace',
      },
    };
    expect(resolveAceMarketplace({ known, home: HOME })).toEqual({
      path: '/home/u/.claude/plugins/marketplaces/ace',
      sourceType: 'github',
      mode: 'clone',
    });
  });

  it('no registry entry falls back to the conventional clone path', () => {
    for (const known of [null, {}, { canopy: {} }]) {
      expect(resolveAceMarketplace({ known, home: HOME })).toEqual({
        path: '/home/u/.claude/plugins/marketplaces/ace',
        sourceType: 'unregistered',
        mode: 'clone',
      });
    }
  });

  it('formatShell quotes for eval', () => {
    const out = formatShell({ path: "/a b/it's", sourceType: 'directory', mode: 'directory' });
    const parsed = execFileSync('bash', ['-c', `${out}\nprintf '%s|%s|%s' "$MARKETPLACE" "$SOURCE_TYPE" "$MODE"`], {
      encoding: 'utf8',
    });
    expect(parsed).toBe("/a b/it's|directory|directory");
  });
});

// ── the real Step 1 block, against a fixture HOME ───────────────────────────

const GIT_ENV = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function step1Block(): string {
  const md = readFileSync(join(REPO_ROOT, 'commands', 'update.md'), 'utf8');
  const block = md.split('```bash\n')[1]?.split('\n```')[0];
  if (!block) throw new Error('Step 1 bash block not found in commands/update.md');
  return block;
}

/** Fixture: a "GitHub" bare repo at VERSION 0.0.1, a checkout of it, and a HOME registry. */
function fixture(sourceType: 'directory' | 'github') {
  const root = mkdtempSync(join(tmpdir(), 'ace-3143-'));
  const home = join(root, 'home');
  const remote = join(root, 'remote.git');
  const seed = join(root, 'seed');
  mkdirSync(seed);
  git(root, 'init', '--bare', '-b', 'main', remote);
  git(seed, 'init', '-b', 'main');
  writeFileSync(join(seed, 'VERSION'), '0.0.1\n');
  git(seed, 'add', 'VERSION');
  git(seed, 'commit', '-m', 'v1');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', 'origin', 'main');

  const checkout =
    sourceType === 'directory' ? join(root, 'opt-agents-ace') : join(home, '.claude', 'plugins', 'marketplaces', 'ace');
  mkdirSync(dirname(checkout), { recursive: true });
  git(root, 'clone', remote, checkout);
  const sha = git(checkout, 'rev-parse', 'HEAD');

  const plugins = join(home, '.claude', 'plugins');
  mkdirSync(plugins, { recursive: true });
  writeFileSync(
    join(plugins, 'installed_plugins.json'),
    JSON.stringify({ plugins: { 'ace@ace': [{ version: '0.0.1', gitCommitSha: sha, installPath: REPO_ROOT }] } }),
  );
  writeFileSync(
    join(plugins, 'known_marketplaces.json'),
    JSON.stringify({
      ace:
        sourceType === 'directory'
          ? { source: { source: 'directory', path: checkout }, installLocation: checkout }
          : { source: { source: 'github', repo: 'dimagi-internal/ace' }, installLocation: checkout },
    }),
  );
  const advanceRemote = () => {
    writeFileSync(join(seed, 'VERSION'), '0.0.2\n');
    git(seed, 'commit', '-am', 'v2');
    git(seed, 'push', 'origin', 'main');
  };
  return { home, checkout, advanceRemote };
}

function runStep1(home: string): string {
  return execFileSync('bash', ['-c', step1Block()], {
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV, HOME: home, CLAUDE_PLUGIN_ROOT: REPO_ROOT },
  });
}

describe('commands/update.md Step 1', () => {
  it('directory source (canopy runner): RUNNER_MANAGED, never marketplace_missing, and read-only', () => {
    const f = fixture('directory');
    const refsBefore = git(f.checkout, 'for-each-ref');
    const headBefore = git(f.checkout, 'rev-parse', 'HEAD');

    const current = runStep1(f.home);
    expect(current).toContain(`Marketplace: ${f.checkout} (source: directory)`);
    expect(current).toContain('STATUS: RUNNER_MANAGED CURRENT 0.0.1');
    expect(current).not.toContain('marketplace_missing');

    f.advanceRemote();
    const behind = runStep1(f.home);
    expect(behind).toMatch(/STATUS: RUNNER_MANAGED BEHIND 0\.0\.1 /);

    // Nothing was pulled, fetched into, or reset in the runner's checkout.
    expect(git(f.checkout, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(git(f.checkout, 'for-each-ref')).toBe(refsBefore);
  });

  it('github clone at the resolved installLocation: unchanged UP_TO_DATE / UPGRADE_AVAILABLE flow', () => {
    const f = fixture('github');
    expect(runStep1(f.home)).toContain('STATUS: UP_TO_DATE 0.0.1');
    f.advanceRemote();
    expect(runStep1(f.home)).toContain('STATUS: UPGRADE_AVAILABLE 0.0.1 0.0.2');
  });

  it('no Step block hard-codes the marketplace clone path as the only location', () => {
    const md = readFileSync(join(REPO_ROOT, 'commands', 'update.md'), 'utf8');
    const blocks = md.split('```bash\n').slice(1).map((b) => b.split('\n```')[0]);
    // Only the documented fallback (resolver script absent) may name the clone path.
    for (const b of blocks) {
      const hits = b.split('\n').filter((l) => l.includes('.claude/plugins/marketplaces/ace'));
      for (const h of hits) expect(h).toMatch(/SOURCE_TYPE=unresolved/);
    }
  });
});
