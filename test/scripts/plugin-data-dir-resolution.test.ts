/**
 * Where setup, doctor and the slash-command launchers find the INSTALLED ACE
 * and its data dir, for every name ACE is installed under.
 *
 * ACE ships as `ace@ace` and, since canopy#895, as `ace@canopy-agents` (the
 * personal catalog `canopy agents connect` registers). Claude Code records
 * `<plugin>@<marketplace>` in installed_plugins.json (current format:
 * `{version: 2, plugins: {...}}`) and names the data dir
 * `plugins/data/<plugin>-<marketplace>`. Every resolver used to look up only
 * `ace@ace` (setup.md's launcher not even in the current format) and composed
 * `<marketplace>-<plugin>`, so an `ace@canopy-agents` install could not be
 * found by /ace:setup and its servers read a different .env than setup wrote.
 *
 * CLASSIFICATION: unit-test truth over fixture registries; no network.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..');
const SETUP = join(REPO_ROOT, 'bin', 'ace-setup');

let home: string;
let plugins: string;

/** A cached ACE root at plugins/cache/<mp>/ace/<ver> plus a v2 registry naming it ace@<mp>. */
function install(marketplace: string): { root: string; registry: string } {
  const root = join(plugins, 'cache', marketplace, 'ace', '0.13.2000');
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'ace', version: '0.13.2000' }));
  writeFileSync(join(root, 'VERSION'), '0.13.2000\n');
  const registry = join(plugins, 'installed_plugins.json');
  writeFileSync(
    registry,
    JSON.stringify({
      version: 2,
      plugins: {
        'nova@nova-marketplace': [{ scope: 'user', installPath: '/elsewhere/nova', version: '2' }],
        [`ace@${marketplace}`]: [{ scope: 'user', installPath: root, version: '0.13.2000' }],
      },
    }),
  );
  return { root, registry };
}

function printRoot(registry: string, extraEnv: NodeJS.ProcessEnv = {}): Record<string, string> {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, ACE_PLUGIN_REGISTRY: registry, ...extraEnv };
  delete env.CLAUDE_PLUGIN_ROOT;
  if (!('CLAUDE_PLUGIN_DATA' in extraEnv)) delete env.CLAUDE_PLUGIN_DATA;
  const raw = execFileSync('bash', [SETUP, '--print-root'], { cwd: home, env, encoding: 'utf8' });
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

/** Run the registry lookup the given slash command's launcher embeds, against `registry`. */
function launcherLookup(command: 'setup' | 'doctor', registry: string): string {
  const md = readFileSync(join(REPO_ROOT, 'commands', `${command}.md`), 'utf8');
  const line = md.split('\n').find((l) => l.includes('INSTALL_PATH="$(node -e'));
  expect(line, `${command}.md launcher registry lookup`).toBeTruthy();
  const script = `REG='${registry}'\n${line!.trim()}\nprintf '%s' "$INSTALL_PATH"`;
  return execFileSync('bash', ['-c', script], { encoding: 'utf8' });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ace-data-dir-'));
  plugins = join(home, '.claude', 'plugins');
  mkdirSync(plugins, { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('bin/ace-setup resolves the installed ACE and its data dir', () => {
  it('ace@ace keeps working: data dir plugins/data/ace-ace', () => {
    const { root, registry } = install('ace');
    const out = printRoot(registry);
    expect(out.plugin_root).toBe(root);
    expect(out.registry_key).toBe('ace@ace');
    expect(out.data_dir).toBe(join(plugins, 'data', 'ace-ace'));
  });

  it('ace@canopy-agents: found in the registry, data dir plugins/data/ace-canopy-agents', () => {
    const { root, registry } = install('canopy-agents');
    const out = printRoot(registry);
    expect(out.plugin_root).toBe(root);
    expect(out.plugin_root_source).toBe('installed_plugins.json');
    expect(out.registry_key).toBe('ace@canopy-agents');
    expect(out.data_dir).toBe(join(plugins, 'data', 'ace-canopy-agents'));
  });

  it('$CLAUDE_PLUGIN_DATA wins when set', () => {
    const { registry } = install('canopy-agents');
    const explicit = join(home, 'explicit-data');
    expect(printRoot(registry, { CLAUDE_PLUGIN_DATA: explicit }).data_dir).toBe(explicit);
  });

  it('an unexpanded ${CLAUDE_PLUGIN_DATA} literal is ignored (anthropics/claude-code#9427)', () => {
    const { registry } = install('canopy-agents');
    expect(printRoot(registry, { CLAUDE_PLUGIN_DATA: '${CLAUDE_PLUGIN_DATA}' }).data_dir).toBe(
      join(plugins, 'data', 'ace-canopy-agents'),
    );
  });

  it('with no registry, falls back to the newest cached ACE under any marketplace', () => {
    const { root } = install('canopy-agents');
    const out = printRoot(join(home, 'no-registry.json'));
    // HOME-relative cache glob: plugins/cache/*/ace/*
    expect(out.plugin_root).toBe(root);
    expect(out.plugin_root_source).toBe('plugin-cache-newest');
    expect(out.data_dir).toBe(join(plugins, 'data', 'ace-canopy-agents'));
  });
});

describe('the /ace:setup and /ace:doctor launchers find ACE under any marketplace', () => {
  it.each(['setup', 'doctor'] as const)('%s.md: ace@canopy-agents (current registry format)', (cmd) => {
    const { root, registry } = install('canopy-agents');
    expect(launcherLookup(cmd, registry)).toBe(root);
  });

  it.each(['setup', 'doctor'] as const)('%s.md: ace@ace (current registry format)', (cmd) => {
    const { root, registry } = install('ace');
    expect(launcherLookup(cmd, registry)).toBe(root);
  });

  it.each(['setup', 'doctor'] as const)('%s.md: cache fallback globs every marketplace', (cmd) => {
    const md = readFileSync(join(REPO_ROOT, 'commands', `${cmd}.md`), 'utf8');
    expect(md).toContain('"$HOME"/.claude/plugins/cache/*/ace/*/');
  });
});
