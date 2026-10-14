import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { derivePluginDataDir, resolvePluginDataDir } from '../../lib/plugin-data-dir.js';

describe('plugin-data-dir', () => {
  const originalEnv = process.env.CLAUDE_PLUGIN_DATA;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = originalEnv;
    }
  });

  describe('derivePluginDataDir', () => {
    it('derives the data dir from a cache-install module URL', () => {
      const fakeUrl =
        'file:///Users/jjackson/.claude/plugins/cache/ace/ace/0.5.17/mcp/google-drive-server.ts';
      expect(derivePluginDataDir(fakeUrl)).toEqual({
        path: '/Users/jjackson/.claude/plugins/data/ace-ace',
        marketplace: 'ace',
        plugin: 'ace',
        version: '0.5.17',
      });
    });

    it('handles a different marketplace + plugin naming correctly', () => {
      const fakeUrl =
        'file:///Users/me/.claude/plugins/cache/claude-plugins-official/frontend-design/1.2.3/mcp/server.js';
      expect(derivePluginDataDir(fakeUrl)).toEqual({
        path: '/Users/me/.claude/plugins/data/claude-plugins-official-frontend-design',
        marketplace: 'claude-plugins-official',
        plugin: 'frontend-design',
        version: '1.2.3',
      });
    });

    it('returns null for a dev-checkout path with no plugins/cache segment', () => {
      const fakeUrl = 'file:///Users/jjackson/emdash-projects/ace/mcp/google-drive-server.ts';
      expect(derivePluginDataDir(fakeUrl)).toBeNull();
    });

    it('returns null when there are not enough segments after plugins/cache', () => {
      const fakeUrl = 'file:///home/user/.claude/plugins/cache/';
      expect(derivePluginDataDir(fakeUrl)).toBeNull();
    });
  });

  describe('resolvePluginDataDir', () => {
    // Set up a tempdir so the existence checks have something to succeed
    // against without leaning on the real ~/.claude hierarchy.
    let tmp: string;
    let fakeUrl: string;
    let expectedDataDir: string;

    beforeEach(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-plugin-data-test-'));
      const versionDir = path.join(tmp, 'plugins', 'cache', 'ace', 'ace', '9.9.9');
      const mcpDir = path.join(versionDir, 'mcp');
      fs.mkdirSync(mcpDir, { recursive: true });
      expectedDataDir = path.join(tmp, 'plugins', 'data', 'ace-ace');
      fs.mkdirSync(expectedDataDir, { recursive: true });
      fakeUrl = 'file://' + path.join(mcpDir, 'google-drive-server.ts');
    });

    afterEach(() => {
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('prefers $CLAUDE_PLUGIN_DATA when it points at an existing dir', () => {
      process.env.CLAUDE_PLUGIN_DATA = expectedDataDir;
      expect(resolvePluginDataDir(fakeUrl)).toBe(expectedDataDir);
    });

    it('falls through to derivation when env is unset', () => {
      delete process.env.CLAUDE_PLUGIN_DATA;
      expect(resolvePluginDataDir(fakeUrl)).toBe(expectedDataDir);
    });

    it('falls through to derivation when env is the literal unexpanded placeholder', () => {
      process.env.CLAUDE_PLUGIN_DATA = '${CLAUDE_PLUGIN_DATA}';
      expect(resolvePluginDataDir(fakeUrl)).toBe(expectedDataDir);
    });

    it('falls through to derivation when env is empty', () => {
      process.env.CLAUDE_PLUGIN_DATA = '';
      expect(resolvePluginDataDir(fakeUrl)).toBe(expectedDataDir);
    });

    it('falls through to derivation when env points at a non-existent path', () => {
      process.env.CLAUDE_PLUGIN_DATA = path.join(tmp, 'does-not-exist');
      expect(resolvePluginDataDir(fakeUrl)).toBe(expectedDataDir);
    });

    it('returns null from a dev-checkout path when nothing resolves', () => {
      delete process.env.CLAUDE_PLUGIN_DATA;
      const devUrl = 'file:///home/dev/ace/mcp/google-drive-server.ts';
      expect(resolvePluginDataDir(devUrl)).toBeNull();
    });
  });
});
