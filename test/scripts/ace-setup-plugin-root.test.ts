/**
 * `bin/ace-setup` plugin-root resolution (ace#2091).
 *
 * The script's most consequential side effect is
 * `op inject -i $ROOT/.env.tpl -o $CLAUDE_PLUGIN_DATA/.env` — it writes the
 * INSTALLED plugin's machine-wide runtime config, which every MCP subprocess
 * reads once at startup. Until 0.13.1283 the resolution walked UP FROM `$PWD`
 * before falling back to the script's own directory, so a `--force-env` run
 * from an ACE worktree rendered THAT branch's `.env.tpl`.
 *
 * Measured on the ACE workstation 2026-09-06 15:05:30: plugin_root resolved to
 * a worktree at 0.13.1173, and the installed `.env` came out with
 * `ACE_CONNECT_APK_VERSION=2.63.2` while the installed `.env.tpl` said
 * `2.64.0` — silently reverting PR #2038 for the whole machine. Nothing
 * surfaced it: `/ace:doctor`'s `env_freshness` probe compares the `.env` MTIME
 * against MCP start times, so a stale-CONTENT `.env` that is newer than every
 * subprocess passes clean.
 *
 * CLASSIFICATION: unit-test truth. This is path resolution over a fixture
 * filesystem plus a fixture registry — nothing is sent to or matched against a
 * device, and no network or 1Password session is involved. `--print-root`
 * exists so the ordering is drivable without the rest of the installer.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(__dirname, '..', '..', 'bin', 'ace-setup');
const REPO_ROOT = join(__dirname, '..', '..');

let dir: string;

/** A directory that looks like an ACE plugin root to the resolver. */
function makeAceRoot(at: string, version: string): string {
  mkdirSync(join(at, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(at, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'ace', version }, null, 2),
  );
  writeFileSync(join(at, 'VERSION'), `${version}\n`);
  writeFileSync(join(at, '.env.tpl'), `ACE_MARKER=${version}\n`);
  return at;
}

function makeRegistry(installPath: string | null, version = '0.13.9999'): string {
  const p = join(dir, 'installed_plugins.json');
  const body =
    installPath === null
      ? { version: 2, plugins: {} }
      : {
          version: 2,
          plugins: {
            'ace@ace': [{ scope: 'user', installPath, version }],
          },
        };
  writeFileSync(p, JSON.stringify(body, null, 2));
  return p;
}

/** Run `bin/ace-setup --print-root` and parse its key=value output. */
function printRoot(opts: {
  cwd: string;
  registry?: string;
  pluginRoot?: string;
  home?: string;
}): Record<string, string> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Isolate from the real machine: an empty HOME means the
    // "newest plugin cache dir" candidate finds nothing.
    HOME: opts.home ?? join(dir, 'empty-home'),
    ACE_PLUGIN_REGISTRY: opts.registry ?? join(dir, 'no-such-registry.json'),
  };
  if (opts.pluginRoot) env.CLAUDE_PLUGIN_ROOT = opts.pluginRoot;
  else delete env.CLAUDE_PLUGIN_ROOT;

  const raw = execFileSync('bash', [SCRIPT, '--print-root'], {
    cwd: opts.cwd,
    env,
    encoding: 'utf8',
  });
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ace-setup-root-'));
  mkdirSync(join(dir, 'empty-home'), { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('bin/ace-setup --print-root', () => {
  it('prefers the registry installPath over an ACE worktree at $PWD (ace#2091)', () => {
    // This is the regression. Both are valid ACE roots; the worktree is the
    // one $PWD walks up to, and the installed plugin is the one whose .env
    // is about to be written.
    const worktree = makeAceRoot(join(dir, 'worktrees', 'stale-branch'), '0.13.1173');
    const installed = makeAceRoot(join(dir, 'cache', 'ace', 'ace', '0.13.1282'), '0.13.1282');
    const registry = makeRegistry(installed, '0.13.1282');

    const out = printRoot({ cwd: worktree, registry });

    expect(out.plugin_root).toBe(installed);
    expect(out.plugin_root_source).toBe('installed_plugins.json');
    expect(out.plugin_root_version).toBe('0.13.1282');
    // Named explicitly: the pre-fix behaviour was to return the worktree.
    expect(out.plugin_root).not.toBe(worktree);
  });

  it('still prefers the registry when $PWD is a DEEP subdirectory of a worktree', () => {
    const worktree = makeAceRoot(join(dir, 'worktrees', 'stale-branch'), '0.13.1173');
    const deep = join(worktree, 'skills', 'app-release', 'nested');
    mkdirSync(deep, { recursive: true });
    const installed = makeAceRoot(join(dir, 'cache', 'ace', 'ace', '0.13.1282'), '0.13.1282');
    const registry = makeRegistry(installed, '0.13.1282');

    expect(printRoot({ cwd: deep, registry }).plugin_root).toBe(installed);
  });

  it('honours CLAUDE_PLUGIN_ROOT above the registry', () => {
    const explicit = makeAceRoot(join(dir, 'explicit'), '0.13.7777');
    const installed = makeAceRoot(join(dir, 'cache', 'ace', 'ace', '0.13.1282'), '0.13.1282');
    const registry = makeRegistry(installed, '0.13.1282');

    const out = printRoot({ cwd: dir, registry, pluginRoot: explicit });
    expect(out.plugin_root).toBe(explicit);
    expect(out.plugin_root_source).toBe('CLAUDE_PLUGIN_ROOT');
  });

  it('ignores a CLAUDE_PLUGIN_ROOT that is not an ACE root, and falls through', () => {
    const notARoot = join(dir, 'not-a-plugin');
    mkdirSync(notARoot, { recursive: true });
    const installed = makeAceRoot(join(dir, 'cache', 'ace', 'ace', '0.13.1282'), '0.13.1282');
    const registry = makeRegistry(installed, '0.13.1282');

    const out = printRoot({ cwd: dir, registry, pluginRoot: notARoot });
    expect(out.plugin_root).toBe(installed);
    expect(out.plugin_root_source).toBe('installed_plugins.json');
  });

  it('falls back to the newest plugin cache dir when the registry has no ace@ace entry', () => {
    const home = join(dir, 'home-with-cache');
    makeAceRoot(join(home, '.claude', 'plugins', 'cache', 'ace', 'ace', '0.13.900'), '0.13.900');
    const newest = makeAceRoot(
      join(home, '.claude', 'plugins', 'cache', 'ace', 'ace', '0.13.1282'),
      '0.13.1282',
    );
    const worktree = makeAceRoot(join(dir, 'worktrees', 'stale'), '0.13.1173');
    const registry = makeRegistry(null);

    const out = printRoot({ cwd: worktree, registry, home });
    expect(out.plugin_root).toBe(newest);
    expect(out.plugin_root_source).toBe('plugin-cache-newest');
  });

  it('sorts cache dirs by VERSION, not lexically (0.13.900 < 0.13.1282)', () => {
    // Lexical sort puts "0.13.900" after "0.13.1282". `sort -V` is what makes
    // this right, and it is the difference between installing from a
    // 382-release-old directory and the current one.
    const home = join(dir, 'home-version-sort');
    makeAceRoot(join(home, '.claude', 'plugins', 'cache', 'ace', 'ace', '0.13.900'), '0.13.900');
    makeAceRoot(join(home, '.claude', 'plugins', 'cache', 'ace', 'ace', '0.13.1282'), '0.13.1282');
    const out = printRoot({ cwd: dir, registry: makeRegistry(null), home });
    expect(out.plugin_root_version).toBe('0.13.1282');
  });

  it('falls back to the script own plugin root last, never to $PWD', () => {
    // No CLAUDE_PLUGIN_ROOT, no registry entry, no cache. The remaining
    // candidate is $SELF_DIR — the repo this script lives in — and NOT the
    // fixture worktree we are standing in.
    const worktree = makeAceRoot(join(dir, 'worktrees', 'stale'), '0.13.1173');
    const out = printRoot({ cwd: worktree, registry: makeRegistry(null) });

    expect(out.plugin_root_source).toBe('script-self-dir');
    expect(out.plugin_root).toBe(REPO_ROOT);
    expect(out.plugin_root).not.toBe(worktree);
  });

  it('--print-root has no side effects: it writes no .env and needs no `op`', () => {
    // The whole point of the flag is that the ordering is testable without a
    // 1Password session. If this ever starts shelling out to `op`, CI on a
    // machine with no 1Password CLI would go red here first.
    const installed = makeAceRoot(join(dir, 'cache', 'ace', 'ace', '0.13.1282'), '0.13.1282');
    const dataDir = join(dir, 'plugin-data');
    mkdirSync(dataDir, { recursive: true });

    execFileSync('bash', [SCRIPT, '--print-root'], {
      cwd: dir,
      env: {
        ...process.env,
        HOME: join(dir, 'empty-home'),
        ACE_PLUGIN_REGISTRY: makeRegistry(installed, '0.13.1282'),
        CLAUDE_PLUGIN_DATA: dataDir,
        // A PATH with no `op`, no `npm`: --print-root must not need them.
        PATH: '/usr/bin:/bin',
      },
      encoding: 'utf8',
    });

    expect(() => rmSync(join(dataDir, '.env'))).toThrow();
  });
});

describe('bin/ace-setup source ordering is declared, not implied', () => {
  it('does not use $PWD as a resolution candidate at all', () => {
    // Guard against a well-meaning re-introduction. `$PWD` may only feed the
    // informational `cwd_is_ace_checkout` line and the helper that produces
    // it — never a ROOT_SOURCE assignment.
    const src = execFileSync('cat', [SCRIPT], { encoding: 'utf8' });
    expect(src).not.toMatch(/ROOT_SOURCE="pwd/);
    // The pre-fix shape, named literally so a revert cannot pass this file:
    // a `D="$PWD"` walk whose loop body assigns ROOT.
    expect(src).not.toMatch(/D="\$PWD"[\s\S]{0,400}\bROOT="\$D"/);
  });

  it('refuses to render .env from a root that is not the installed plugin', () => {
    const src = execFileSync('cat', [SCRIPT], { encoding: 'utf8' });
    expect(src).toContain('ENV_ROOT_REFUSED');
    expect(src).toContain('ACE_SETUP_ALLOW_TEMPLATE_MISMATCH');
    // The refusal must be a FAIL (exit non-zero via mark_fail), not a WARN:
    // the failure it prevents is silent and machine-wide.
    expect(src).toMatch(/fail "env: refusing to render \.env from a non-installed plugin root/);
  });
});
