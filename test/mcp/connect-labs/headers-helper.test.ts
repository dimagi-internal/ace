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
  isLabsPageTurn,
  headersFor,
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

  it('derives plugins/data/ace-canopy-agents for an ace@canopy-agents install', () => {
    expect(
      derivePluginDataDir('/Users/x/.claude/plugins/cache/canopy-agents/ace/0.13.2000/scripts/labs-auth-headers.mjs'),
    ).toBe('/Users/x/.claude/plugins/data/ace-canopy-agents');
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

  it("reads a runner's per-turn env file ($CANOPY_AGENT_ENV_FILE) before any .env on disk", () => {
    // A cloud runner keeps agent secrets off disk: the turn's values are in a tmpfs
    // file named by CANOPY_AGENT_ENV_FILE, and no ~/.ace/.env or plugin-data .env
    // exists in the unit's home (cloud-ec2-2, 2026-10-25).
    const dir = mkdtempSync(path.join(tmpdir(), 'labs-auth-turn-'));
    const data = mkdtempSync(path.join(tmpdir(), 'labs-auth-'));
    try {
      writeFileSync(path.join(dir, 'turn.env'), 'OTHER=x\nLABS_MCP_TOKEN=from-turn-file\n');
      writeFileSync(path.join(data, '.env'), 'LABS_MCP_TOKEN=stale-on-disk\n');
      expect(
        resolveToken('/irrelevant/path.mjs', {
          CANOPY_AGENT_ENV_FILE: path.join(dir, 'turn.env'),
          CLAUDE_PLUGIN_DATA: data,
        }),
      ).toBe('from-turn-file');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(data, { recursive: true, force: true });
    }
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
    // HOME points at a token-free sandbox so the ~/.claude default candidate
    // can't accidentally resolve a real token on a developer machine.
    const emptyHome = mkdtempSync(path.join(tmpdir(), 'labs-auth-home-'));
    try {
      expect(
        resolveToken('/nope/cache-miss/path.mjs', {
          CLAUDE_PLUGIN_DATA: '${CLAUDE_PLUGIN_DATA}',
          HOME: emptyHome,
        }),
      ).toBeNull();
    } finally {
      rmSync(emptyHome, { recursive: true, force: true });
    }
  });

  it('recovers the token from ~/.claude/plugins/data/ace-ace/.env from a worktree checkout with CLAUDE_PLUGIN_DATA unset (jjackson/ace#620)', () => {
    // Emulates the worktree-resume failure: caller path is NOT under
    // plugins/cache (derive => null), no dev-root .env, CLAUDE_PLUGIN_DATA
    // unset — only the installed default under HOME carries the token.
    const home = mkdtempSync(path.join(tmpdir(), 'labs-auth-home-'));
    try {
      const dataDir = path.join(home, '.claude', 'plugins', 'data', 'ace-ace');
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(path.join(dataDir, '.env'), 'LABS_MCP_TOKEN=from-home-default\n');
      const worktreeCaller =
        '/Users/x/emdash/worktrees/ace/emdash/some-branch/scripts/labs-auth-headers.mjs';
      expect(resolveToken(worktreeCaller, { HOME: home })).toBe('from-home-default');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
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
      // Sandbox HOME too so the ~/.claude default candidate (jjackson/ace#620)
      // can't resolve the developer machine's real token.
      env.HOME = path.join(root, 'no-such-home');
      const out = execFileSync('node', [copyReal], { env, encoding: 'utf8' });
      expect(JSON.parse(out)).toEqual({});
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// A canopy turn held on a connect-labs PAGE reaches labs only as the person who sent
// (canopy's site_tools / site_call, their act-as-you permission) — ACE's owner
// included. ACE's own labs token must not authenticate the native MCP there, even
// when one is on disk.
describe('labs-auth-headers: a turn on a connect-labs page sends no token of ACE\'s', () => {
  it('emits {} on a cloud page turn (CANOPY_PAGE_SITE) even with a token in env and on disk', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'labs-auth-page-'));
    try {
      const dataDir = path.join(home, '.claude', 'plugins', 'data', 'ace-ace');
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(path.join(dataDir, '.env'), 'LABS_MCP_TOKEN=on-disk\n');
      const env = { HOME: home, LABS_MCP_TOKEN: 'in-env', CANOPY_PAGE_SITE: 'connect-labs' };
      expect(isLabsPageTurn(env)).toBe(true);
      expect(headersFor('/nowhere/scripts/labs-auth-headers.mjs', env)).toEqual({});
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('still authenticates on a page of ANOTHER site, and off any page', () => {
    const env = { HOME: '/nonexistent', LABS_MCP_TOKEN: 'tok' };
    expect(headersFor('/x/scripts/h.mjs', { ...env, CANOPY_PAGE_SITE: 'ace-web' })).toEqual({
      Authorization: 'Bearer tok',
    });
    expect(headersFor('/x/scripts/h.mjs', env)).toEqual({ Authorization: 'Bearer tok' });
  });

  it("emits {} on a laptop page turn (the runner's ~/.canopy/page/task/<task>.json marker)", () => {
    const home = mkdtempSync(path.join(tmpdir(), 'labs-auth-laptop-'));
    try {
      const dir = path.join(home, '.canopy', 'page', 'task');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, 'ace-chat-1.json'),
        JSON.stringify({ site: 'connect-labs', withheld: ['LABS_MCP_TOKEN'] }),
      );
      const env = { HOME: home, LABS_MCP_TOKEN: 'tok', EMDASH_TASK_NAME: 'ace-chat-1' };
      expect(isLabsPageTurn(env)).toBe(true);
      expect(headersFor('/x/scripts/h.mjs', env)).toEqual({});
      // Another task (no marker) is an ordinary session.
      expect(isLabsPageTurn({ ...env, EMDASH_TASK_NAME: 'ace-other' })).toBe(false);
      // A task name that is not a plain name is never joined onto a path.
      expect(isLabsPageTurn({ ...env, EMDASH_TASK_NAME: '../page/task/ace-chat-1' })).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('the executable prints {} on a page turn', () => {
    const env = { ...process.env, LABS_MCP_TOKEN: 'exec-tok', CANOPY_PAGE_SITE: 'connect-labs' };
    const out = execFileSync('node', [HELPER], { env, encoding: 'utf8' });
    expect(JSON.parse(out)).toEqual({});
  });
});
