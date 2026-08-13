import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// dimagi-internal/ace#880 — gates the IMPURE half of the env-freshness probe.
//
// lib/env-freshness.ts is unit-tested on numbers. What this file covers is the
// part that can only break in the real world: parsing `ps -o lstart=` output
// and deciding which rows belong to ACE. Driven by a canned `ps` fixture so CI
// never depends on a live process tree — the same stub pattern as
// test/scripts/ace-nova-check.test.ts.
//
// The rows in the fixture are the shape actually observed on darwin 25.5:
//   pid ppid "Thu Aug 13 14:35:15 2026" command
// ---------------------------------------------------------------------------

const SCRIPT = fileURLToPath(new URL('../../scripts/doctor-env-freshness.ts', import.meta.url));
const FIXTURE = fileURLToPath(new URL('../fixtures/ps-mcp-children.txt', import.meta.url));

/** All fixture processes start 2026-08-13 14:35:15–19 local time. */
const PROC_START = new Date('2026-08-13T14:35:15');

function envFileWithMtime(offsetSeconds: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'ace-envfresh-'));
  const p = join(dir, '.env');
  writeFileSync(p, 'ACE_X=1\n');
  const when = new Date(PROC_START.getTime() + offsetSeconds * 1000);
  utimesSync(p, when, when);
  return p;
}

function run(envPath: string): string {
  return execFileSync('npx', ['tsx', SCRIPT], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      ACE_ENV_FRESHNESS_PS_FIXTURE: FIXTURE,
      ACE_ENV_FRESHNESS_ENV_PATH: envPath,
    },
  });
}

describe('doctor-env-freshness — the WARN path (#880 repro)', () => {
  it('warns when .env was written after the MCP subprocesses started', () => {
    // The measured repro: connect MCP up at 21:17:09, .env written 45s later.
    const out = run(envFileWithMtime(45));
    expect(out).toMatch(/^WARN env_freshness:/m);
    expect(out).toMatch(/started BEFORE the current \.env was written/);
  });

  it('names the servers and tells the operator to quit, not reload', () => {
    const out = run(envFileWithMtime(45));
    expect(out).toMatch(/connect\(pid 39733\)/);
    expect(out).toMatch(/quit and reopen Claude Code/i);
    // The trap: /reload-plugins reloads agents+skills+hooks and does NOT
    // respawn MCP subprocesses. Recommending it would loop the operator.
    expect(out).toMatch(/\/reload-plugins does NOT respawn/);
  });

  it('ignores a sibling plugin’s identically-named MCP server', () => {
    // chrome-sales ships its own google-drive-server.ts. It is not bound to
    // ACE's .env, so counting it would produce a warn about an unrelated
    // process — and the operator would restart for nothing.
    const out = run(envFileWithMtime(45));
    expect(out).not.toMatch(/39900/);
  });

  it('ignores non-MCP children entirely', () => {
    const out = run(envFileWithMtime(45));
    expect(out).not.toMatch(/39901/);
  });
});

describe('doctor-env-freshness — the PASS path', () => {
  it('passes when .env predates every subprocess', () => {
    const out = run(envFileWithMtime(-600));
    expect(out).toMatch(/^PASS env_freshness:/m);
    expect(out).toMatch(/started after \.env was written/);
  });
});

describe('doctor-env-freshness — never breaks the diagnostic', () => {
  it('reports SKIP rather than throwing when .env does not exist', () => {
    const out = run(join(tmpdir(), 'ace-envfresh-nonexistent', '.env'));
    expect(out).toMatch(/^SKIP env_freshness:/m);
  });

  it('exits 0 on every path so bin/ace-doctor is never broken by its own probe', () => {
    // execFileSync throws on a non-zero exit, so reaching the assertion IS
    // the assertion.
    expect(() => run(envFileWithMtime(45))).not.toThrow();
    expect(() => run(join(tmpdir(), 'nope', '.env'))).not.toThrow();
  });
});
