import { describe, it, expect } from 'vitest';

import { classifyEnvFreshness, serverNameFromCommand } from '../../lib/env-freshness.js';

// ---------------------------------------------------------------------------
// dimagi-internal/ace#880 — /ace:setup env changes need a restart AFTER setup.
//
// Every MCP server calls dotenvConfig() at module top level (see
// mcp/connect-server.ts:13,18) and reads .env exactly once, at subprocess
// spawn. So a subprocess that started BEFORE `/ace:setup --force-env` rewrote
// .env holds the old values forever, and nothing surfaces it.
//
// Measured on the reporting run: the connect MCP started 21:17:09; .env was
// written 21:17:54, 45s later. The HQ cluster registry therefore read [us]
// while buildHqClusterRegistry(current .env) yields [eu, us]. The parser was
// correct the whole time; the process was stale. `/ace:doctor` reported
// healthy, because session_freshness compares two ON-DISK facts and
// structurally cannot see a running subprocess.
//
// This is the pure half: given .env's mtime and the MCP children's start
// times, decide whether a restart is owed.
// ---------------------------------------------------------------------------

const T = (s: string) => new Date(`2026-08-13T${s}Z`).getTime();

const proc = (pid: number, name: string, started: string) => ({
  pid,
  command: `npm exec tsx /Users/x/.claude/plugins/cache/ace/ace/0.13.770/mcp/${name}-server.ts`,
  startedMs: T(started),
});

describe('classifyEnvFreshness — the warn case (#880 repro)', () => {
  it('warns when a subprocess started before .env was written', () => {
    const r = classifyEnvFreshness({
      envMtimeMs: T('21:17:54'),
      procs: [proc(101, 'connect', '21:17:09')],
    });
    expect(r.verdict).toBe('warn');
    expect(r.stale).toHaveLength(1);
    expect(r.stale[0]).toMatchObject({ pid: 101, server: 'connect' });
  });

  it('lists ONLY the stale processes, not the fresh ones', () => {
    const r = classifyEnvFreshness({
      envMtimeMs: T('21:17:54'),
      procs: [
        proc(101, 'connect', '21:17:09'), // stale
        proc(102, 'mobile', '21:18:30'), // fresh
        proc(103, 'ocs', '21:17:10'), // stale
      ],
    });
    expect(r.verdict).toBe('warn');
    expect(r.stale.map((s) => s.server).sort()).toEqual(['connect', 'ocs']);
  });

  it('the reason names the remedy, not just the symptom', () => {
    const r = classifyEnvFreshness({
      envMtimeMs: T('21:17:54'),
      procs: [proc(101, 'connect', '21:17:09')],
    });
    // /reload-plugins does NOT respawn MCP subprocesses — telling the operator
    // to run it would send them round the loop again. Only a full quit works.
    expect(r.reason).toMatch(/quit and reopen|restart Claude Code/i);
    expect(r.reason).not.toMatch(/reload-plugins(?![^.]*does not)/i);
  });
});

describe('classifyEnvFreshness — the pass case', () => {
  it('passes when every subprocess started after .env was written', () => {
    const r = classifyEnvFreshness({
      envMtimeMs: T('21:17:54'),
      procs: [proc(101, 'connect', '21:18:00'), proc(102, 'mobile', '21:18:01')],
    });
    expect(r.verdict).toBe('pass');
    expect(r.stale).toHaveLength(0);
  });

  it('an exact timestamp tie is NOT stale', () => {
    // ps -o lstart= has 1-second resolution while .env's mtime is
    // sub-second, so equality is a rounding artifact and warning on it would
    // produce a false positive on a perfectly healthy setup->restart.
    const r = classifyEnvFreshness({
      envMtimeMs: T('21:17:54'),
      procs: [proc(101, 'connect', '21:17:54')],
    });
    expect(r.verdict).toBe('pass');
  });
});

describe('classifyEnvFreshness — the skip cases (a probe that cannot see must not judge)', () => {
  it('skips when no MCP children were found', () => {
    // Running `bin/ace-doctor` from a plain terminal is the normal case, and
    // it has no MCP children. Warning there would train operators to ignore
    // the check — the exact failure #1189 is about, in miniature.
    const r = classifyEnvFreshness({ envMtimeMs: T('21:17:54'), procs: [] });
    expect(r.verdict).toBe('skip');
    expect(r.stale).toHaveLength(0);
  });

  it('skips when .env has no readable mtime', () => {
    const r = classifyEnvFreshness({ envMtimeMs: null, procs: [proc(101, 'connect', '21:17:09')] });
    expect(r.verdict).toBe('skip');
  });

  it('skips when the claude ancestor could not be resolved', () => {
    // Without a claude pid we cannot bind the process list to THIS session,
    // and a sibling session's MCP children would produce a meaningless warn.
    const r = classifyEnvFreshness({
      envMtimeMs: T('21:17:54'),
      procs: [proc(101, 'connect', '21:17:09')],
      claudeAncestorFound: false,
    });
    expect(r.verdict).toBe('skip');
  });

  it('every verdict carries a non-empty reason', () => {
    const cases = [
      { envMtimeMs: T('21:17:54'), procs: [proc(101, 'connect', '21:17:09')] },
      { envMtimeMs: T('21:17:54'), procs: [proc(101, 'connect', '21:18:09')] },
      { envMtimeMs: T('21:17:54'), procs: [] },
      { envMtimeMs: null, procs: [] },
    ];
    for (const c of cases) {
      const r = classifyEnvFreshness(c);
      expect(r.reason.length, `verdict ${r.verdict} must explain itself`).toBeGreaterThan(0);
    }
  });
});

describe('serverNameFromCommand', () => {
  it('extracts the server name from a plugin-cache tsx command line', () => {
    expect(
      serverNameFromCommand(
        'npm exec tsx /Users/x/.claude/plugins/cache/ace/ace/0.13.770/mcp/connect-server.ts',
      ),
    ).toBe('connect');
  });

  it('handles the hyphenated server names', () => {
    expect(serverNameFromCommand('node /x/mcp/google-drive-server.ts')).toBe('google-drive');
  });

  it('returns null for a command that is not an MCP server', () => {
    expect(serverNameFromCommand('/bin/zsh -l')).toBeNull();
  });
});
