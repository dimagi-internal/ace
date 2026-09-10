/**
 * `bin/ace-reset-labs-run` — the self-resolving shim over
 * `scripts/reset-labs-run-state.ts` (dimagi-internal/ace#2351).
 *
 * The registered `source.render_reset.command` used to carry an absolute path
 * into ONE user's VERSIONED plugin cache. The cache keeps every prior version
 * directory, so after `/ace:update` the pinned path kept RESOLVING — to stale
 * code — and from another macOS account it named a home that was not that
 * account's installed tree. The shim's entire job is to resolve the INSTALLED
 * root at run time, through `installed_plugins.json`, and exec the reset there.
 *
 * Two properties are load-bearing and each has a control below:
 *
 *   1. The root comes from the registry, NOT from `dirname($0)`. The shim may
 *      itself be invoked via a pinned path (a stale version directory that
 *      still exists); if it trusted its own location it would recreate the
 *      defect one hop later. So a copy of the shim living in a "stale" root
 *      must still exec the REGISTRY root's script.
 *   2. It execs `node <root>/node_modules/tsx/dist/cli.mjs`, never `npx tsx`
 *      — the plugin cache's `.bin/tsx` is a dereferenced copy that cannot
 *      find its chunks (ace#2252, `test/scripts/tsx-invocation.test.ts`).
 *
 * CLASSIFICATION: unit-test truth. Path resolution over a fixture filesystem
 * plus a fixture registry; nothing touches labs, a device, or the network.
 * `ACE_PLUGIN_REGISTRY` is the same override `bin/ace-setup` honours.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..');
const SHIM = join(REPO_ROOT, 'bin', 'ace-reset-labs-run');

let dir: string;

/** A directory that looks like an installed ACE plugin root to the shim. */
function makeAceRoot(at: string, version: string): string {
  mkdirSync(join(at, '.claude-plugin'), { recursive: true });
  mkdirSync(join(at, 'scripts'), { recursive: true });
  mkdirSync(join(at, 'node_modules', 'tsx', 'dist'), { recursive: true });
  writeFileSync(
    join(at, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'ace', version }, null, 2),
  );
  writeFileSync(join(at, 'VERSION'), `${version}\n`);
  // A stand-in for the reset script: its PATH is what the fake tsx echoes.
  writeFileSync(join(at, 'scripts', 'reset-labs-run-state.ts'), `// ${version}\n`);
  // A fake tsx CLI that prints what it was asked to run, so the exec line is
  // observable without a real TypeScript run.
  writeFileSync(
    join(at, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    'console.log(JSON.stringify({ tsx: import.meta.url, argv: process.argv.slice(2) }));\n',
  );
  return at;
}

function makeRegistry(installPath: string | null, version = '0.13.9999'): string {
  const p = join(dir, 'installed_plugins.json');
  const body =
    installPath === null
      ? { version: 2, plugins: {} }
      : { version: 2, plugins: { 'ace@ace': [{ scope: 'user', installPath, version }] } };
  writeFileSync(p, JSON.stringify(body, null, 2));
  return p;
}

function envFor(opts: { registry?: string; pluginRoot?: string }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: join(dir, 'empty-home'), // no real plugin cache reachable
    ACE_PLUGIN_REGISTRY: opts.registry ?? join(dir, 'no-such-registry.json'),
  };
  if (opts.pluginRoot) env.CLAUDE_PLUGIN_ROOT = opts.pluginRoot;
  else delete env.CLAUDE_PLUGIN_ROOT;
  return env;
}

function printRoot(shim: string, opts: { registry?: string; pluginRoot?: string }): Record<string, string> {
  const raw = execFileSync('bash', [shim, '--print-root'], { cwd: dir, env: envFor(opts), encoding: 'utf8' });
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

function runShim(shim: string, args: string[], opts: { registry?: string; pluginRoot?: string }) {
  return spawnSync('bash', [shim, ...args], { cwd: dir, env: envFor(opts), encoding: 'utf8' });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ace-reset-shim-'));
  mkdirSync(join(dir, 'empty-home'), { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('bin/ace-reset-labs-run root resolution (ace#2351)', () => {
  it('resolves the INSTALLED root from installed_plugins.json', () => {
    const installed = makeAceRoot(join(dir, 'cache', 'ace', 'ace', '0.13.1427'), '0.13.1427');
    const registry = makeRegistry(installed, '0.13.1427');
    const out = printRoot(SHIM, { registry });
    expect(out.plugin_root).toBe(installed);
    expect(out.plugin_root_source).toBe('installed_plugins.json');
  });

  it('does NOT trust its own location: a copy in a stale version dir still execs the registry root', () => {
    // The regression. The shim invoked via a pinned path must not become the
    // pin one hop later.
    const stale = makeAceRoot(join(dir, 'cache', 'ace', 'ace', '0.13.1413'), '0.13.1413');
    const installed = makeAceRoot(join(dir, 'cache', 'ace', 'ace', '0.13.1427'), '0.13.1427');
    mkdirSync(join(stale, 'bin'), { recursive: true });
    const staleShim = join(stale, 'bin', 'ace-reset-labs-run');
    copyFileSync(SHIM, staleShim);
    chmodSync(staleShim, 0o755);
    const registry = makeRegistry(installed, '0.13.1427');

    const out = printRoot(staleShim, { registry });
    expect(out.plugin_root).toBe(installed);
    expect(out.plugin_root).not.toBe(stale);

    const res = runShim(staleShim, ['--run-id', '5590', '--workflow-id', '5502', '--keys', 'record_reviews'], { registry });
    expect(res.status, res.stderr).toBe(0);
    const echoed = JSON.parse(res.stdout.trim()) as { tsx: string; argv: string[] };
    expect(echoed.tsx).toContain('0.13.1427/node_modules/tsx/dist/cli.mjs');
    expect(echoed.argv[0]).toBe(join(installed, 'scripts', 'reset-labs-run-state.ts'));
    expect(echoed.argv.slice(1)).toEqual(['--run-id', '5590', '--workflow-id', '5502', '--keys', 'record_reviews']);
  });

  it('prefers CLAUDE_PLUGIN_ROOT when it IS an ACE root, and ignores it when it is not', () => {
    const installed = makeAceRoot(join(dir, 'cache', 'ace', 'ace', '0.13.1427'), '0.13.1427');
    const registry = makeRegistry(installed, '0.13.1427');
    const harnessRoot = makeAceRoot(join(dir, 'harness-root'), '0.13.1428');
    expect(printRoot(SHIM, { registry, pluginRoot: harnessRoot }).plugin_root).toBe(harnessRoot);

    // A canopy root — plugin.json names a different plugin — must not win.
    const canopy = join(dir, 'canopy-root');
    mkdirSync(join(canopy, '.claude-plugin'), { recursive: true });
    writeFileSync(join(canopy, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'canopy' }));
    expect(printRoot(SHIM, { registry, pluginRoot: canopy }).plugin_root).toBe(installed);
  });

  it('falls back to the shim\'s own checkout only when no installed root is reachable', () => {
    // From a dev worktree with no registry entry the repo itself is the root —
    // the same last-resort ordering as bin/ace-setup.
    const out = printRoot(SHIM, { registry: makeRegistry(null) });
    expect(out.plugin_root).toBe(REPO_ROOT);
    expect(out.plugin_root_source).toBe('script-self-dir');
  });

  it('fails loud, not silently, when the resolved root has no reset script', () => {
    const broken = join(dir, 'broken-root');
    mkdirSync(join(broken, '.claude-plugin'), { recursive: true });
    writeFileSync(join(broken, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'ace' }));
    const res = runShim(SHIM, ['--run-id', '1', '--workflow-id', '2', '--keys', 'k'], { registry: makeRegistry(broken) });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('reset-labs-run-state.ts');
  });

  it('never resolves tsx through the broken plugin-cache .bin shim (ace#2252)', () => {
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const src = readFileSync(SHIM, 'utf8');
    expect(src).toContain('node_modules/tsx/dist/cli.mjs');
    expect(src).not.toMatch(/^\s*(exec\s+)?npx\s+tsx/m);
  });
});
