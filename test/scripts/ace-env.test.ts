import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `bin/ace-env` carries gog's file-keyring credentials into a child process.
 *
 * ## The failure it exists for (dimagi-internal/ace#2844)
 *
 * gog keeps its OAuth client secret in a FILE keyring — deliberate, because the
 * macOS Keychain blocks forever on a GUI prompt in a non-interactive agent
 * shell (jjackson/ace#827). Opening it needs `GOG_KEYRING_PASSWORD`, which
 * lives in the plugin-data `.env` and in no shell profile.
 *
 * A session the operator starts by hand gets it from the `/ace:*` skills' own
 * env loading. A session a canopy RUNNER spawns does not, and every Gmail call
 * in it dies with `no TTY available for keyring file backend password prompt`
 * — so ACE's whole email surface, read AND send, is dead for that turn. Two
 * `/ace:ask` turns stalled this way without answering anyone.
 *
 * ## Why not the obvious routes
 *
 * `launchctl setenv` reaches a GUI-spawned emdash but publishes the password
 * to every process of this user, which `canopy email preflight` forbids. The
 * runner's LaunchAgent plist reaches the runner DAEMON only — turns are
 * spawned by the Emdash GUI app, which is not a child of that launchd job
 * (measured 2026-10-12: plist populated, daemon restarted, zero children,
 * session still dead).
 */

const ROOT = join(__dirname, '..', '..');
const SHIM = join(ROOT, 'bin', 'ace-env');

function runShim(args: string[], env: NodeJS.ProcessEnv, dataDir: string) {
  return execFileSync(SHIM, args, {
    encoding: 'utf8',
    env: { ...env, CLAUDE_PLUGIN_DATA: dataDir },
  }).trim();
}

function envDirWith(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ace-env-test-'));
  writeFileSync(join(dir, '.env'), contents);
  return dir;
}

describe('bin/ace-env', () => {
  it('is executable — a non-executable shim silently breaks every email call', () => {
    // eslint-disable-next-line no-bitwise
    expect(statSync(SHIM).mode & 0o111).toBeGreaterThan(0);
  });

  it('loads GOG_KEYRING_PASSWORD from the plugin-data .env into the child', () => {
    const dir = envDirWith('GOG_KEYRING_PASSWORD=s3cret-from-env\n');
    const out = runShim(['printenv', 'GOG_KEYRING_PASSWORD'], {}, dir);
    expect(out).toBe('s3cret-from-env');
  });

  it('loads GOG_KEYRING_BACKEND too — gog needs both to pick the file keyring', () => {
    const dir = envDirWith(
      'GOG_KEYRING_BACKEND=file\nGOG_KEYRING_PASSWORD=pw\n',
    );
    expect(runShim(['printenv', 'GOG_KEYRING_BACKEND'], {}, dir)).toBe('file');
  });

  it('lets an existing environment value win — dotenv never overrides', () => {
    // Same precedence as the MCP servers and hooks/tenancy_guard.plugin_env.
    // An operator who exported a value deliberately must not have it replaced.
    const dir = envDirWith('GOG_KEYRING_PASSWORD=from-file\n');
    const out = runShim(
      ['printenv', 'GOG_KEYRING_PASSWORD'],
      { GOG_KEYRING_PASSWORD: 'from-process' },
      dir,
    );
    expect(out).toBe('from-process');
  });

  it('strips surrounding quotes, which .env files routinely carry', () => {
    const dir = envDirWith('GOG_KEYRING_PASSWORD="quoted-value"\n');
    expect(runShim(['printenv', 'GOG_KEYRING_PASSWORD'], {}, dir)).toBe(
      'quoted-value',
    );
  });

  it('handles an `export ` prefix', () => {
    const dir = envDirWith('export GOG_KEYRING_PASSWORD=exported\n');
    expect(runShim(['printenv', 'GOG_KEYRING_PASSWORD'], {}, dir)).toBe(
      'exported',
    );
  });

  it('carries ONLY the keyring pair, never the whole .env', () => {
    // Sourcing the entire file would hand every ACE secret to an arbitrary
    // child — the wide-exposure problem this shim exists to avoid, just moved
    // somewhere less visible.
    const dir = envDirWith(
      'GOG_KEYRING_PASSWORD=pw\nACE_WEB_PAT_TOKEN=should-not-leak\n',
    );
    const out = execFileSync(SHIM, ['printenv'], {
      encoding: 'utf8',
      env: { CLAUDE_PLUGIN_DATA: dir, PATH: process.env.PATH ?? '' },
    });
    expect(out).toMatch(/GOG_KEYRING_PASSWORD=pw/);
    expect(out).not.toMatch(/should-not-leak/);
  });

  it('passes the command through and preserves its exit code', () => {
    const dir = envDirWith('GOG_KEYRING_PASSWORD=pw\n');
    expect(runShim(['echo', 'hello'], {}, dir)).toBe('hello');
    expect(() =>
      execFileSync(SHIM, ['false'], { env: { CLAUDE_PLUGIN_DATA: dir, PATH: process.env.PATH ?? '' } }),
    ).toThrow();
  });

  it('runs the command even when no .env exists — it is a wrapper, not a gate', () => {
    // A box on the macOS Keychain backend has no password to propagate. The
    // shim must still exec, or prefixing every call would break those boxes.
    const dir = mkdtempSync(join(tmpdir(), 'ace-env-empty-'));
    expect(runShim(['echo', 'ok'], {}, dir)).toBe('ok');
  });

  it('exits 2 with usage when given no command', () => {
    let code = 0;
    try {
      execFileSync(SHIM, [], { stdio: 'pipe' });
    } catch (err: any) {
      code = err.status;
    }
    expect(code).toBe(2);
  });
});
