import { describe, it, expect } from 'vitest';

import {
  classifyPluginCacheFreshness,
  isStaleCacheModuleError,
  pluginRootFromCommand,
} from '../../lib/plugin-cache-freshness.js';

// ---------------------------------------------------------------------------
// dimagi-internal/ace#970
//
// An MCP subprocess spawned from ~/.claude/plugins/cache/ace/ace/<version>/
// keeps running after that directory is pruned by a newer install. The next
// lazy require inside a dependency fails with "Cannot find module", surfacing
// as an unrelated-looking playwright error.
//
// The reason a check is worth building: session_freshness does not merely miss
// this case, it reports PASS. The doctor launcher can't find bin/ace-doctor
// under the deleted root, falls through to the new installPath, and there
// VERSION and the registry agree.
// ---------------------------------------------------------------------------

const cmd = (version: string, server = 'connect') =>
  `npm exec tsx /Users/x/.claude/plugins/cache/ace/ace/${version}/mcp/${server}-server.ts`;

describe('pluginRootFromCommand', () => {
  it('extracts the root and version from a cache-run command', () => {
    expect(pluginRootFromCommand(cmd('0.13.770'))).toEqual({
      root: '/Users/x/.claude/plugins/cache/ace/ace/0.13.770',
      version: '0.13.770',
    });
  });

  it('handles hyphenated server names', () => {
    expect(pluginRootFromCommand(cmd('0.13.770', 'google-drive'))?.version).toBe('0.13.770');
  });

  it('returns null for a dev-checkout command', () => {
    // Running from a worktree is legitimate and must never be judged.
    expect(pluginRootFromCommand('npx tsx /Users/x/emdash/ace/mcp/connect-server.ts')).toBeNull();
    expect(pluginRootFromCommand('/bin/zsh -l')).toBeNull();
  });
});

describe('classifyPluginCacheFreshness — the warn case (#970 repro)', () => {
  it('warns when a subprocess runs from a directory that no longer exists', () => {
    const r = classifyPluginCacheFreshness({
      procs: [{ pid: 101, command: cmd('0.13.641'), rootExists: false }],
      installedVersion: '0.13.770',
    });
    expect(r.verdict).toBe('warn');
    expect(r.stale).toHaveLength(1);
    expect(r.stale[0]).toMatchObject({ pid: 101, server: 'connect', version: '0.13.641' });
  });

  it('the reason names the symptom the operator will actually see', () => {
    // The whole point: the failure surfaces as a playwright/browser error, so
    // an operator who is not told to connect the two will chase the wrong
    // system entirely.
    const r = classifyPluginCacheFreshness({
      procs: [{ pid: 101, command: cmd('0.13.641'), rootExists: false }],
    });
    expect(r.reason).toMatch(/Cannot find module/);
    expect(r.reason).toMatch(/quit and reopen Claude Code/i);
    // /reload-plugins does NOT respawn MCP subprocesses — recommending it
    // would loop the operator through the failure again.
    expect(r.reason).toMatch(/does\s+NOT\s+respawn/i);
  });

  it('lists only the stale processes, and includes the installed version for contrast', () => {
    const r = classifyPluginCacheFreshness({
      procs: [
        { pid: 101, command: cmd('0.13.641'), rootExists: false },
        { pid: 102, command: cmd('0.13.770', 'mobile'), rootExists: true },
        { pid: 103, command: cmd('0.13.641', 'ocs'), rootExists: false },
      ],
      installedVersion: '0.13.770',
    });
    expect(r.stale.map((s) => s.server).sort()).toEqual(['connect', 'ocs']);
    expect(r.reason).toMatch(/Installed is v0\.13\.770/);
  });
});

describe('classifyPluginCacheFreshness — pass and skip', () => {
  it('passes when every cache root still exists', () => {
    const r = classifyPluginCacheFreshness({
      procs: [{ pid: 101, command: cmd('0.13.770'), rootExists: true }],
    });
    expect(r.verdict).toBe('pass');
    expect(r.stale).toHaveLength(0);
  });

  it('SKIPS a dev checkout rather than warning about it', () => {
    // A developer running `npm run mcp:connect` from a worktree has no cache
    // root by design. Warning here would be a false positive on every dev
    // machine, which is how a check gets ignored.
    const r = classifyPluginCacheFreshness({
      procs: [
        { pid: 101, command: 'npx tsx /Users/x/emdash/ace/mcp/connect-server.ts', rootExists: false },
      ],
    });
    expect(r.verdict).toBe('skip');
    expect(r.stale).toHaveLength(0);
  });

  it('skips an empty process list', () => {
    expect(classifyPluginCacheFreshness({ procs: [] }).verdict).toBe('skip');
  });

  it('judges only the cache-run processes in a mixed list', () => {
    const r = classifyPluginCacheFreshness({
      procs: [
        { pid: 101, command: 'npx tsx /Users/x/emdash/ace/mcp/connect-server.ts', rootExists: false },
        { pid: 102, command: cmd('0.13.641', 'ocs'), rootExists: false },
      ],
    });
    expect(r.verdict).toBe('warn');
    expect(r.stale.map((s) => s.pid)).toEqual([102]);
  });

  it('every verdict carries a non-empty reason', () => {
    for (const procs of [
      [{ pid: 1, command: cmd('0.13.641'), rootExists: false }],
      [{ pid: 1, command: cmd('0.13.770'), rootExists: true }],
      [],
    ]) {
      expect(classifyPluginCacheFreshness({ procs }).reason.length).toBeGreaterThan(0);
    }
  });
});

describe('isStaleCacheModuleError', () => {
  it('fires on the verbatim message from the issue', () => {
    expect(
      isStaleCacheModuleError(
        "browser.newContext: Cannot find module './../../../package.json'",
      ),
    ).toBe(true);
  });

  it('fires on node error codes too', () => {
    expect(isStaleCacheModuleError('MODULE_NOT_FOUND')).toBe(true);
    expect(isStaleCacheModuleError('ERR_MODULE_NOT_FOUND')).toBe(true);
  });

  it('does not fire on an ordinary HTTP failure', () => {
    // Message-matching alone is not the test — the caller must also have
    // confirmed the plugin root is gone. This guards the narrow half.
    expect(isStaleCacheModuleError('HTTP 502 /a/x/opportunity/: bad gateway')).toBe(false);
  });
});
