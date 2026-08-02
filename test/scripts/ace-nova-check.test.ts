/**
 * Tests for `bin/ace-nova-check` — the Nova plugin freshness probe (ace#1165).
 *
 * ACE drives Nova through the `nova@nova-marketplace` Claude Code plugin.
 * `/ace:doctor` checks it is installed; this probe checks it is CURRENT, and
 * Phase 3 Step 0a reads its verdict before dispatching the architect.
 *
 * The probe is a one-line-output shell script, so these tests drive the real
 * binary and assert on that line. Remote access is stubbed via
 * ACE_NOVA_REMOTE_VER / ACE_NOVA_SKIP_REMOTE so the suite never hits the
 * network — a version check that made CI depend on github.com would be a worse
 * flake source than the drift it detects.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SCRIPT = join(__dirname, '..', '..', 'bin', 'ace-nova-check');

let dir: string;

/** Write a fake installed_plugins.json + the cache dir its entry points at. */
async function fakeRegistry(opts: {
  /** Version in the registry entry (metadata). */
  regVersion?: string;
  /** Version in the installed cache dir's own plugin.json (ground truth). */
  installedVersion?: string;
  /** Use the legacy flat `{<id>:{…}}` schema instead of v2. */
  legacyShape?: boolean;
  /** Omit the nova entry entirely. */
  noNova?: boolean;
}): Promise<string> {
  const installPath = join(dir, 'cache', 'nova', opts.regVersion ?? '1.0.0');

  if (opts.installedVersion) {
    await mkdir(join(installPath, '.claude-plugin'), { recursive: true });
    await writeFile(
      join(installPath, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'nova', version: opts.installedVersion }),
    );
  }

  const entry = { scope: 'user', installPath, version: opts.regVersion ?? '1.0.0' };
  const plugins: Record<string, unknown> = { 'ace@ace': [{ version: '0.13.0' }] };
  if (!opts.noNova) {
    plugins['nova@nova-marketplace'] = opts.legacyShape ? entry : [entry];
  }

  const regPath = join(dir, 'installed_plugins.json');
  await writeFile(
    regPath,
    JSON.stringify(opts.legacyShape ? plugins : { version: 2, plugins }),
  );
  return regPath;
}

async function run(env: Record<string, string>): Promise<string> {
  const { stdout } = await execFileAsync(SCRIPT, [], {
    env: { ...process.env, ...env },
  });
  return stdout.trim();
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ace-nova-check-test-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('bin/ace-nova-check', () => {
  it('reports UP_TO_DATE when installed version matches the release', async () => {
    const reg = await fakeRegistry({ regVersion: '1.14.0', installedVersion: '1.14.0' });
    const out = await run({ ACE_NOVA_PLUGIN_REG: reg, ACE_NOVA_REMOTE_VER: '1.14.0' });
    expect(out).toBe('UP_TO_DATE 1.14.0');
  });

  it('reports UPGRADE_AVAILABLE when a newer release exists', async () => {
    const reg = await fakeRegistry({ regVersion: '1.13.0', installedVersion: '1.13.0' });
    const out = await run({ ACE_NOVA_PLUGIN_REG: reg, ACE_NOVA_REMOTE_VER: '1.14.0' });
    expect(out).toBe('UPGRADE_AVAILABLE 1.13.0 1.14.0');
  });

  /**
   * Regression guard for the design that was tried FIRST and rejected.
   *
   * The obvious implementation compares the `gitCommitSha` recorded in
   * installed_plugins.json against nova-plugin's `main`. Measured 2026-08-02:
   * the plugin auto-updated 1.13.0 → 1.14.0 and `gitCommitSha` was NOT
   * refreshed — it still named 1.13.0's commit while the cache dir held real
   * 1.14.0 code. A SHA compare therefore reports "stale" on a current install,
   * permanently, with nothing the operator can do to clear it.
   *
   * So the probe must read the version from the INSTALLED CACHE DIR's own
   * plugin.json, and a stale/desynced registry `version` must not win.
   */
  it('trusts the installed cache dir over stale registry metadata', async () => {
    const reg = await fakeRegistry({ regVersion: '1.13.0', installedVersion: '1.14.0' });
    const out = await run({ ACE_NOVA_PLUGIN_REG: reg, ACE_NOVA_REMOTE_VER: '1.14.0' });
    expect(out).toBe('UP_TO_DATE 1.14.0');
  });

  it('falls back to the registry version when the cache dir has no manifest', async () => {
    const reg = await fakeRegistry({ regVersion: '1.13.0' });
    const out = await run({ ACE_NOVA_PLUGIN_REG: reg, ACE_NOVA_REMOTE_VER: '1.14.0' });
    expect(out).toBe('UPGRADE_AVAILABLE 1.13.0 1.14.0');
  });

  it('does not nag when the local build is AHEAD of the published release', async () => {
    const reg = await fakeRegistry({ regVersion: '1.15.0', installedVersion: '1.15.0' });
    const out = await run({ ACE_NOVA_PLUGIN_REG: reg, ACE_NOVA_REMOTE_VER: '1.14.0' });
    expect(out).toBe('UP_TO_DATE 1.15.0');
  });

  it('orders versions numerically, not lexically (1.9.0 < 1.14.0)', async () => {
    const reg = await fakeRegistry({ regVersion: '1.9.0', installedVersion: '1.9.0' });
    const out = await run({ ACE_NOVA_PLUGIN_REG: reg, ACE_NOVA_REMOTE_VER: '1.14.0' });
    expect(out).toBe('UPGRADE_AVAILABLE 1.9.0 1.14.0');
  });

  it('reads the legacy flat registry schema', async () => {
    const reg = await fakeRegistry({
      regVersion: '1.13.0',
      installedVersion: '1.13.0',
      legacyShape: true,
    });
    const out = await run({ ACE_NOVA_PLUGIN_REG: reg, ACE_NOVA_REMOTE_VER: '1.14.0' });
    expect(out).toBe('UPGRADE_AVAILABLE 1.13.0 1.14.0');
  });

  it('reports NOT_INSTALLED when no nova entry is present', async () => {
    const reg = await fakeRegistry({ noNova: true });
    const out = await run({ ACE_NOVA_PLUGIN_REG: reg, ACE_NOVA_REMOTE_VER: '1.14.0' });
    expect(out).toBe('NOT_INSTALLED');
  });

  it('reports ERROR registry_missing when the registry file is absent', async () => {
    const out = await run({
      ACE_NOVA_PLUGIN_REG: join(dir, 'nope.json'),
      ACE_NOVA_REMOTE_VER: '1.14.0',
    });
    expect(out).toBe('ERROR registry_missing');
  });

  it('reports ERROR fetch_failed on a non-version remote payload', async () => {
    const reg = await fakeRegistry({ regVersion: '1.13.0', installedVersion: '1.13.0' });
    const out = await run({ ACE_NOVA_PLUGIN_REG: reg, ACE_NOVA_REMOTE_VER: '<!DOCTYPE html>' });
    expect(out).toBe('ERROR fetch_failed');
  });

  /**
   * The probe informs a gate; it must never BE one. Every branch exits 0 so a
   * network blip cannot halt Phase 3 or fail the doctor.
   */
  it('always exits 0, including on the error paths', async () => {
    const reg = await fakeRegistry({ regVersion: '1.13.0', installedVersion: '1.13.0' });
    const cases: Record<string, string>[] = [
      { ACE_NOVA_PLUGIN_REG: reg, ACE_NOVA_REMOTE_VER: '1.14.0' },
      { ACE_NOVA_PLUGIN_REG: reg, ACE_NOVA_SKIP_REMOTE: '1' },
      { ACE_NOVA_PLUGIN_REG: join(dir, 'nope.json') },
    ];
    for (const env of cases) {
      // execFile rejects on a non-zero exit, so completing without a throw
      // IS the assertion.
      await expect(run(env)).resolves.toBeTruthy();
    }
  });
});
