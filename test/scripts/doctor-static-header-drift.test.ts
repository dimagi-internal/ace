/**
 * dimagi-internal/ace#2159 — the probe must actually RUN, and it must read the
 * real `~/.claude.json`.
 *
 * `test/lib/static-header-drift.test.ts` proves the logic on pure inputs. This
 * file covers the two halves that a pure test structurally cannot:
 *
 *  1. the IMPURE half — parsing `~/.claude.json` and the `.env`, driven here
 *     by a throwaway `$HOME` so CI never touches the developer's config;
 *  2. the WIRING — `bin/ace-doctor` invoking it on both surfaces, with the
 *     preflight fallback block, and `agents/ace-orchestrator.md` listing it as
 *     a halt block. Emitting `status: fail` does nothing on its own: the
 *     orchestrator halts on a HARDCODED list of block names, so a probe absent
 *     from that list fails silently. A classifier with no caller is the same
 *     defect as an atom with no caller (PR #2055).
 *
 * `--heal` is deliberately never passed here — it shells out to `claude mcp add`.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPT = join(REPO_ROOT, 'scripts/doctor-static-header-drift.ts');

const CURRENT = 'fw4n2b3RTlrTxYcurrenttoken';
const ROTATED_AWAY = '-XymInnOldTokenValue';

/**
 * A throwaway HOME carrying `~/.claude.json` plus the installed-plugin `.env`
 * the script's own candidate list reaches (`$HOME/.claude/plugins/data/ace-ace/.env`).
 */
function fakeHome(opts: { pinned?: string | null; labsToken?: string | null }): string {
  const home = mkdtempSync(join(tmpdir(), 'ace-hdrdrift-'));
  const mcpServers: Record<string, unknown> = {
    atlassian: { type: 'sse', url: 'https://mcp.atlassian.com/v1/sse' },
  };
  if (opts.pinned) {
    mcpServers.connect_labs = {
      type: 'http',
      url: 'https://labs.connect.dimagi.com/mcp/',
      headers: { Authorization: `Bearer ${opts.pinned}` },
    };
  }
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers }, null, 2));

  const dataDir = join(home, '.claude/plugins/data/ace-ace');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(dataDir, '.env'),
    opts.labsToken === null ? 'ACE_HQ_DOMAIN=x\n' : `ACE_HQ_DOMAIN=x\nLABS_MCP_TOKEN=${opts.labsToken ?? CURRENT}\n`,
  );
  return home;
}

function run(home: string, format: 'lines' | 'yaml'): string {
  return execFileSync('npx', ['tsx', SCRIPT, `--format=${format}`], {
    encoding: 'utf8',
    timeout: 60_000,
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: home,
      // The script prefers $CLAUDE_PLUGIN_DATA-derived paths; clear it so the
      // fake HOME candidate is the one that resolves.
      CLAUDE_PLUGIN_DATA: '',
      LABS_MCP_TOKEN: '',
    },
  });
}

describe('doctor-static-header-drift — the ace#2159 repro', () => {
  it('names a rotated connect_labs bearer as a FAIL', () => {
    // The measured case: the pinned token returned HTTP 401 and the .env token
    // returned HTTP 200 against the same endpoint, while every credential on
    // disk read green (issue body, bednet-2-visit preflight halt 2026-09-07).
    const out = run(fakeHome({ pinned: ROTATED_AWAY, labsToken: CURRENT }), 'lines');
    expect(out).toMatch(/^WARN static_header_drift:/m);
    expect(out).toMatch(/connect_labs/);
    expect(out).toMatch(/LABS_MCP_TOKEN/);
  });

  it('never prints either token', () => {
    const out = run(fakeHome({ pinned: ROTATED_AWAY, labsToken: CURRENT }), 'lines');
    expect(out).not.toContain(ROTATED_AWAY);
    expect(out).not.toContain(CURRENT);
  });

  it('tells the operator to fully restart — the header binds at connection time', () => {
    const out = run(fakeHome({ pinned: ROTATED_AWAY, labsToken: CURRENT }), 'lines');
    expect(out).toMatch(/Cmd-Q/);
  });

  it('passes when the pinned bearer IS the configured token', () => {
    const out = run(fakeHome({ pinned: CURRENT, labsToken: CURRENT }), 'lines');
    expect(out).toMatch(/^PASS static_header_drift:/m);
  });

  it('skips — never passes — when nothing is pinned', () => {
    const out = run(fakeHome({ pinned: null, labsToken: CURRENT }), 'lines');
    expect(out).toMatch(/^INFO static_header_drift: skipped/m);
    expect(out).not.toMatch(/^PASS /m);
  });

  it('skips — never passes — when an override exists with no key to compare', () => {
    const out = run(fakeHome({ pinned: ROTATED_AWAY, labsToken: null }), 'lines');
    expect(out).toMatch(/^INFO static_header_drift: skipped/m);
    expect(out).not.toMatch(/^WARN /m);
  });

  it('emits a parseable preflight block with the fields the orchestrator reads', () => {
    const out = run(fakeHome({ pinned: ROTATED_AWAY, labsToken: CURRENT }), 'yaml');
    expect(out).toMatch(/^static_header_drift:$/m);
    expect(out).toMatch(/^ {2}status: fail$/m);
    expect(out).toMatch(/^ {2}drifted: \[connect_labs\]$/m);
    expect(out).toMatch(/^ {2}config_readable: true$/m);
    expect(out).toMatch(/^ {2}remediation: "/m);
    expect(out).toMatch(/^ {4}matches: false$/m);
  });

  it('never takes doctor down', () => {
    const script = readFileSync(SCRIPT, 'utf8');
    expect(script).toMatch(/process\.exit\(0\)/);
    expect(script).toMatch(/catch \{/);
  });
});

describe('static_header_drift is WIRED (a classifier with no caller is the defect)', () => {
  const doctor = readFileSync(join(REPO_ROOT, 'bin/ace-doctor'), 'utf8');

  it('the backing script exists', () => {
    expect(existsSync(SCRIPT)).toBe(true);
  });

  it('runs in --preflight, in --format=yaml, and is spliced into the snapshot', () => {
    expect(doctor).toMatch(/doctor-static-header-drift\.ts --format=yaml/);
    expect(doctor).toMatch(/\$\{PF_STATIC_HDR_YAML\}/);
  });

  it('runs in the human [Auth liveness] block, in --format=lines', () => {
    expect(doctor).toMatch(/doctor-static-header-drift\.ts --format=lines/);
  });

  it('has a preflight fallback block, so a missing script cannot break the YAML parse', () => {
    expect(doctor.indexOf('PF_STATIC_HDR_YAML="static_header_drift:')).toBeGreaterThan(-1);
  });

  it('runs AFTER nova_header_readiness, which owns nova’s entry', () => {
    const novaAt = doctor.indexOf('doctor-nova-header.ts --format=lines');
    const driftAt = doctor.indexOf('doctor-static-header-drift.ts --format=lines');
    expect(novaAt).toBeGreaterThan(-1);
    expect(driftAt).toBeGreaterThan(novaAt);
  });

  it('is in the orchestrator’s halt list — `fail` alone does not halt anything', () => {
    const orch = readFileSync(join(REPO_ROOT, 'agents/ace-orchestrator.md'), 'utf8');
    const halt = orch.slice(orch.indexOf('blocks the preflight DOES emit'));
    expect(halt.slice(0, 400)).toContain('static_header_drift');
  });
});
