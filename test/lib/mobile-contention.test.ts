/**
 * Cross-session AVD contention detector (ace#1821).
 *
 * The fixture is a VERBATIM `ps -eo user=,pid=,ppid=,lstart=,command=` capture
 * from the affected host, taken while the contention was live: 27 rows, two
 * macOS accounts, four plugin versions, 9 logical MCPs. It is the ground truth
 * for the one thing this module can plausibly get wrong — that each logical MCP
 * is a three-process chain, so counting rows overstates contention 3x.
 *
 * CLAUDE.md § "close the loop to the source of truth": the authority for "what
 * does an ACE mobile MCP process tree look like" is the process table, and a
 * captured fixture states what it ALWAYS looks like where one device run would
 * only say what it looked like once.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classifyAvdContention,
  isMobileServerCommand,
  parseMobileSessions,
  parsePsRows,
  pluginVersionFromCommand,
  type PsRow,
} from '../../lib/mobile-contention.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, '..', 'fixtures', 'mobile-contention', 'ps-nine-sessions.txt');
const RAW = readFileSync(FIXTURE, 'utf8');

/** A pid that really is an innermost (grandchild) node in the fixture. */
const SELF_LEAF_PID = 54516;
/** ...whose chain root is this. */
const SELF_ROOT_PID = 54385;

function row(over: Partial<PsRow> = {}): PsRow {
  return {
    user: 'acedimagi',
    pid: 1,
    ppid: 0,
    startedMs: Date.parse('2026-09-01T13:26:23Z'),
    command: 'npm exec tsx /Users/x/.claude/plugins/cache/ace/ace/0.13.1109/mcp/mobile-server.ts',
    ...over,
  };
}

describe('parsePsRows', () => {
  it('parses the real capture — every row, both accounts', () => {
    const rows = parsePsRows(RAW);
    expect(rows).toHaveLength(27);
    expect([...new Set(rows.map((r) => r.user))].sort()).toEqual(['acedimagi', 'jjackson']);
    expect(rows.every((r) => Number.isFinite(r.startedMs))).toBe(true);
  });

  it('handles lstart\'s five tokens, including the double space before a single-digit day', () => {
    const [r] = parsePsRows('acedimagi 54385 53368 Tue Sep  1 13:26:23 2026 npm exec tsx /a/mcp/mobile-server.ts');
    expect(r.pid).toBe(54385);
    expect(r.ppid).toBe(53368);
    expect(r.command).toBe('npm exec tsx /a/mcp/mobile-server.ts');
    expect(new Date(r.startedMs).getFullYear()).toBe(2026);
  });

  it('skips junk instead of emitting NaN rows', () => {
    expect(parsePsRows('')).toEqual([]);
    expect(parsePsRows('garbage\n\n  \n')).toEqual([]);
  });
});

describe('command matchers', () => {
  it('recognises an ace-mobile MCP and ignores a sibling server', () => {
    expect(isMobileServerCommand('node /x/mcp/mobile-server.ts')).toBe(true);
    expect(isMobileServerCommand('node /x/mcp/ocs-server.ts')).toBe(false);
    expect(isMobileServerCommand('node /x/mcp/mobile-server.tsx')).toBe(false);
  });

  it('reads the plugin version out of the cache path', () => {
    expect(pluginVersionFromCommand('/u/.claude/plugins/cache/ace/ace/0.13.1109/mcp/mobile-server.ts'))
      .toBe('0.13.1109');
    expect(pluginVersionFromCommand('/some/dev/worktree/mcp/mobile-server.ts')).toBeNull();
  });
});

describe('parseMobileSessions — the 3-process chain is the trap', () => {
  it('collapses 27 rows to the 9 logical MCPs the issue measured by hand', () => {
    // This is the whole point of the module. A detector reporting 27 for a
    // 9-contender problem overstates 3x and gets dismissed.
    const sessions = parseMobileSessions(parsePsRows(RAW), SELF_LEAF_PID);
    expect(sessions).toHaveLength(9);
  });

  it('finds the cross-account peer — the case no lock-based scheme can see', () => {
    const sessions = parseMobileSessions(parsePsRows(RAW), SELF_LEAF_PID);
    const users = sessions.map((s) => s.user);
    expect(users.filter((u) => u === 'acedimagi')).toHaveLength(8);
    expect(users.filter((u) => u === 'jjackson')).toHaveLength(1);
    expect(sessions.find((s) => s.user === 'jjackson')!.sameUser).toBe(false);
  });

  it('resolves SELF by walking UP the chain, since process.pid is the innermost node', () => {
    const sessions = parseMobileSessions(parsePsRows(RAW), SELF_LEAF_PID);
    const self = sessions.filter((s) => s.isSelf);
    expect(self).toHaveLength(1);
    expect(self[0].pid).toBe(SELF_ROOT_PID);
  });

  it('reports the four distinct plugin versions actually running', () => {
    const sessions = parseMobileSessions(parsePsRows(RAW), SELF_LEAF_PID);
    const versions = [...new Set(sessions.map((s) => s.pluginVersion))].sort();
    expect(versions).toEqual(['0.13.1053', '0.13.1109', '0.13.1110', '0.13.1112']);
  });

  it('marks nothing as self when this process is not in the table', () => {
    const sessions = parseMobileSessions(parsePsRows(RAW), 999999);
    expect(sessions.filter((s) => s.isSelf)).toEqual([]);
  });

  it('does not loop forever on a cyclic ppid chain', () => {
    const rows = [row({ pid: 10, ppid: 11 }), row({ pid: 11, ppid: 10 })];
    expect(() => parseMobileSessions(rows, 10)).not.toThrow();
  });
});

describe('classifyAvdContention', () => {
  it('NEGATIVE — warns on the real capture, naming the count, the accounts and the versions', () => {
    const r = classifyAvdContention(parsePsRows(RAW), { selfPid: SELF_LEAF_PID, avdCount: 1 });
    expect(r.verdict).toBe('warn');
    expect(r.otherSessionCount).toBe(8);
    expect(r.crossAccount).toBe(true);
    expect(r.distinctPluginVersions).toHaveLength(4);
    expect(r.self!.pid).toBe(SELF_ROOT_PID);
    // The reason must name the CAUSE and the remedy, not just a number — the
    // artifact that misled four diagnoses was a correct number with no cause.
    expect(r.reason).toMatch(/-wipe-data/);
    expect(r.reason).toMatch(/adb_visible_count: 0/);
    expect(r.reason).toMatch(/ace#1821/);
  });

  it('POSITIVE — a lone session passes', () => {
    const rows = [row({ pid: 100, ppid: 1 }), row({ pid: 101, ppid: 100 })];
    const r = classifyAvdContention(rows, { selfPid: 101, avdCount: 1 });
    expect(r.verdict).toBe('pass');
    expect(r.otherSessionCount).toBe(0);
    expect(r.crossAccount).toBe(false);
    expect(r.reason).toMatch(/to itself/);
  });

  it('POSITIVE — peers with an AVD pool big enough for them all is not contention', () => {
    // Otherwise the check fires forever once a pool exists, and gets muted.
    const rows = [row({ pid: 100, ppid: 1 }), row({ pid: 200, ppid: 2 })];
    const r = classifyAvdContention(rows, { selfPid: 100, avdCount: 5 });
    expect(r.verdict).toBe('pass');
    expect(r.otherSessionCount).toBe(1);
    expect(r.reason).toMatch(/enough to go round/);
  });

  it('POSITIVE — a pool exactly the size of the peer count still warns', () => {
    // 2 peers + us = 3 sessions over 2 AVDs. Boundary belongs on the warn side.
    const rows = [row({ pid: 100, ppid: 1 }), row({ pid: 200, ppid: 2 }), row({ pid: 300, ppid: 3 })];
    expect(classifyAvdContention(rows, { selfPid: 100, avdCount: 2 }).verdict).toBe('warn');
  });

  it('SKIPS rather than warns when the question is unanswerable', () => {
    // Warning on an unanswerable question is how a check becomes noise.
    // A ps read that failed is not evidence that nothing is contending.
    const r = classifyAvdContention([], { selfPid: 1, avdCount: 1 });
    expect(r.verdict).toBe('skip');
    expect(r.reason).toMatch(/not a claim that none exists/);
  });

  it('ignores non-mobile MCPs entirely', () => {
    const rows = [
      row({ pid: 100, ppid: 1 }),
      row({ pid: 500, ppid: 1, command: 'node /x/mcp/ocs-server.ts' }),
      row({ pid: 501, ppid: 1, command: 'node /x/mcp/connect-server.ts' }),
    ];
    const r = classifyAvdContention(rows, { selfPid: 100, avdCount: 1 });
    expect(r.verdict).toBe('pass');
    expect(r.otherSessionCount).toBe(0);
  });

  it('a same-account-only crowd warns without claiming cross-account', () => {
    const rows = [row({ pid: 100, ppid: 1 }), row({ pid: 200, ppid: 2 })];
    const r = classifyAvdContention(rows, { selfPid: 100, avdCount: 1 });
    expect(r.verdict).toBe('warn');
    expect(r.crossAccount).toBe(false);
    expect(r.reason).not.toMatch(/macOS accounts/);
  });
});
