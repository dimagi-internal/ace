/**
 * bin/ace-install-deps — one runtime-only dep store per lockfile, linked into each
 * installed version, and old versions pruned once they have been orphaned long enough.
 *
 * Every version used to get its own full `npm install` (dev deps too) and Claude Code's
 * sweep of orphaned versions did not run: one machine held 93 versions, 16GB
 * (2026-10-19). A fake `npm` stands in for the registry so the test is offline.
 *
 * CLASSIFICATION: unit-test truth over a fixture plugins dir; no network.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..');
const SCRIPT = join(REPO_ROOT, 'bin', 'ace-install-deps');

let home: string;
let plugins: string;
let fakeNpm: string;
let npmLog: string;

function version(v: string, lock = 'lock-a'): string {
  const root = join(plugins, 'cache', 'ace', 'ace', v);
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'ace', version: v }));
  writeFileSync(join(root, 'package.json'), '{"name":"ace"}');
  writeFileSync(join(root, 'package-lock.json'), lock);
  return root;
}

function registry(current: string): string {
  const reg = join(plugins, 'installed_plugins.json');
  writeFileSync(reg, JSON.stringify({ version: 2, plugins: { 'ace@ace': [{ installPath: current, version: 'x' }] } }));
  return reg;
}

function run(root: string, env: NodeJS.ProcessEnv = {}): string {
  return execFileSync('bash', [SCRIPT, root], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      ACE_NPM: fakeNpm,
      ACE_PLUGIN_REGISTRY: join(plugins, 'installed_plugins.json'),
      ...env,
    },
  });
}

const npmCalls = () => (existsSync(npmLog) ? readFileSync(npmLog, 'utf8').trim().split('\n') : []);

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ace-install-deps-'));
  plugins = join(home, '.claude', 'plugins');
  mkdirSync(plugins, { recursive: true });
  npmLog = join(home, 'npm.log');
  fakeNpm = join(home, 'fake-npm');
  writeFileSync(
    fakeNpm,
    `#!/usr/bin/env bash\necho "$PWD $*" >> "${npmLog}"\nmkdir -p node_modules/.bin && printf '#!/bin/sh\\n' > node_modules/.bin/tsx && chmod +x node_modules/.bin/tsx\n`,
  );
  chmodSync(fakeNpm, 0o755);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('bin/ace-install-deps', () => {
  it('installs runtime-only deps once per lockfile and links them into each version', () => {
    const a = version('0.13.1');
    const b = version('0.13.2');
    registry(b);
    run(a);
    run(b);
    const calls = npmCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('ci --omit=dev');
    expect(lstatSync(join(a, 'node_modules')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(a, 'node_modules'))).toBe(readlinkSync(join(b, 'node_modules')));
    expect(readlinkSync(join(b, 'node_modules'))).toContain(join(plugins, 'data', 'ace-ace', 'node-deps'));
  });

  it('reinstalls when the lockfile changes', () => {
    const a = version('0.13.1', 'lock-a');
    const b = version('0.13.2', 'lock-b');
    registry(b);
    run(a);
    run(b);
    expect(npmCalls()).toHaveLength(2);
    expect(readlinkSync(join(a, 'node_modules'))).not.toBe(readlinkSync(join(b, 'node_modules')));
  });

  it('replaces a pre-store node_modules dir with the link', () => {
    const a = version('0.13.1');
    registry(a);
    mkdirSync(join(a, 'node_modules', 'big'), { recursive: true });
    run(a);
    expect(lstatSync(join(a, 'node_modules')).isSymbolicLink()).toBe(true);
  });

  it('marks superseded versions, deletes them only after the keep window, never the current one', () => {
    const old = version('0.13.1');
    const recent = version('0.13.2');
    const cur = version('0.13.3');
    registry(cur);
    const fourDaysAgo = Date.now() - 96 * 3600 * 1000;
    writeFileSync(join(old, '.orphaned_at'), String(fourDaysAgo));
    run(cur);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(recent)).toBe(true);
    expect(Number(readFileSync(join(recent, '.orphaned_at'), 'utf8'))).toBeGreaterThan(fourDaysAgo);
    expect(existsSync(join(cur, '.orphaned_at'))).toBe(false);
  });

  it('drops a dep store no remaining version links to', () => {
    const old = version('0.13.1', 'lock-a');
    const cur = version('0.13.2', 'lock-b');
    registry(cur);
    run(old);
    const oldStore = readlinkSync(join(old, 'node_modules')).replace(/\/node_modules$/, '');
    writeFileSync(join(old, '.orphaned_at'), String(Date.now() - 96 * 3600 * 1000));
    run(cur);
    expect(existsSync(oldStore)).toBe(false);
    expect(existsSync(readlinkSync(join(cur, 'node_modules')))).toBe(true);
  });

  it('installs in place, without a link, when links are off (Windows)', () => {
    const a = version('0.13.1');
    registry(a);
    run(a, { ACE_DEPS_NO_LINK: '1' });
    expect(lstatSync(join(a, 'node_modules')).isDirectory()).toBe(true);
    expect(npmCalls()[0]).toContain(`${a} ci --omit=dev`);
  });

  it('does a plain npm install in a dev checkout and prunes nothing', () => {
    const checkout = join(home, 'src', 'ace');
    mkdirSync(checkout, { recursive: true });
    writeFileSync(join(checkout, 'package.json'), '{}');
    run(checkout);
    expect(npmCalls()[0]).toBe(`${checkout} install --silent`);
  });
});
