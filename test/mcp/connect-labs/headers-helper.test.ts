import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  derivePluginDataDir,
  extractTokenFromEnv,
  buildAuthHeaders,
  resolveToken,
} from '../../../scripts/labs-auth-headers.mjs';
import { derivePluginDataDir as libDerivePluginDataDir } from '../../../lib/plugin-data-dir.js';

const HELPER = fileURLToPath(new URL('../../../scripts/labs-auth-headers.mjs', import.meta.url));

describe('labs-auth-headers: buildAuthHeaders', () => {
  it('wraps a token as a Bearer Authorization header', () => {
    expect(buildAuthHeaders('abc123')).toEqual({ Authorization: 'Bearer abc123' });
  });

  it('emits an empty object (never "Bearer undefined") when there is no token', () => {
    expect(buildAuthHeaders(null)).toEqual({});
    expect(buildAuthHeaders(undefined)).toEqual({});
    expect(buildAuthHeaders('')).toEqual({});
  });
});

describe('labs-auth-headers: extractTokenFromEnv', () => {
  it('reads LABS_MCP_TOKEN, stripping surrounding quotes', () => {
    expect(extractTokenFromEnv('LABS_MCP_TOKEN="quoted-tok"')).toBe('quoted-tok');
    expect(extractTokenFromEnv('LABS_MCP_TOKEN=bare-tok')).toBe('bare-tok');
  });

  it('ignores comments, blanks, and unrelated keys', () => {
    const env = ['# header', '', 'OTHER=nope', 'LABS_MCP_TOKEN=the-token', 'TRAILING=x'].join('\n');
    expect(extractTokenFromEnv(env)).toBe('the-token');
  });

  it('does not match a key that merely shares a prefix', () => {
    expect(extractTokenFromEnv('LABS_MCP_TOKEN_BACKUP=other')).toBeNull();
  });

  it('returns null when the key is absent', () => {
    expect(extractTokenFromEnv('FOO=bar\nBAZ=qux')).toBeNull();
  });
});

describe('labs-auth-headers: derivePluginDataDir (mirrors lib/plugin-data-dir.ts)', () => {
  it('derives plugins/data/<mp>-<plugin> from an installed cache path', () => {
    const callerPath =
      '/Users/x/.claude/plugins/cache/ace/ace/0.13.458/scripts/labs-auth-headers.mjs';
    expect(derivePluginDataDir(callerPath)).toBe(
      '/Users/x/.claude/plugins/data/ace-ace',
    );
  });

  it('returns null for a dev-checkout path (not under plugins/cache)', () => {
    expect(
      derivePluginDataDir('/Users/x/emdash/worktrees/ace/scripts/labs-auth-headers.mjs'),
    ).toBeNull();
  });

  it('agrees with lib/plugin-data-dir.ts for the same path (drift guard)', () => {
    const metaUrl =
      'file:///Users/x/.claude/plugins/cache/ace/ace/0.13.458/scripts/labs-auth-headers.mjs';
    const fromLib = libDerivePluginDataDir(metaUrl);
    const fromHelper = derivePluginDataDir(fileURLToPath(metaUrl));
    expect(fromLib).not.toBeNull();
    expect(fromHelper).toBe(fromLib!.path);
  });
});

describe('labs-auth-headers: resolveToken', () => {
  it('prefers an existing LABS_MCP_TOKEN in the environment', () => {
    expect(
      resolveToken('/irrelevant/path.mjs', { LABS_MCP_TOKEN: 'env-wins' }),
    ).toBe('env-wins');
  });

  it('falls back to <CLAUDE_PLUGIN_DATA>/.env when no env token is set', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'labs-auth-'));
    try {
      writeFileSync(path.join(dir, '.env'), 'LABS_MCP_TOKEN=from-data-dir\n');
      expect(resolveToken('/irrelevant/path.mjs', { CLAUDE_PLUGIN_DATA: dir })).toBe(
        'from-data-dir',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores a literal unexpanded ${CLAUDE_PLUGIN_DATA} and returns null when nothing resolves', () => {
    expect(
      resolveToken('/nope/cache-miss/path.mjs', { CLAUDE_PLUGIN_DATA: '${CLAUDE_PLUGIN_DATA}' }),
    ).toBeNull();
  });
});

describe('labs-auth-headers: executable contract (stdout JSON, exit 0)', () => {
  it('prints a Bearer header to stdout when the env token is present', () => {
    const out = execFileSync('node', [HELPER], {
      env: { ...process.env, LABS_MCP_TOKEN: 'exec-tok' },
      encoding: 'utf8',
    });
    expect(JSON.parse(out)).toEqual({ Authorization: 'Bearer exec-tok' });
  });

  it('prints {} and still exits 0 when no token is resolvable', () => {
    // Run a copy from an isolated temp tree so the dev-checkout root-.env
    // fallback (dirname/../.env) can't accidentally resolve a real token on
    // a developer machine. CI clean-install has no root .env, but this keeps
    // the test green everywhere.
    const root = mkdtempSync(path.join(tmpdir(), 'labs-auth-exec-'));
    try {
      const scriptsDir = path.join(root, 'scripts');
      mkdirSync(scriptsDir);
      const copy = path.join(scriptsDir, 'labs-auth-headers.mjs');
      copyFileSync(HELPER, copy);
      // realpath so argv[1] matches the script's import.meta.url self-invocation
      // guard — macOS tmpdir lives behind the /var -> /private/var symlink.
      const copyReal = realpathSync(copy);
      const env = { ...process.env };
      delete env.LABS_MCP_TOKEN;
      env.CLAUDE_PLUGIN_DATA = path.join(root, 'no-such-data-dir');
      const out = execFileSync('node', [copyReal], { env, encoding: 'utf8' });
      expect(JSON.parse(out)).toEqual({});
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
