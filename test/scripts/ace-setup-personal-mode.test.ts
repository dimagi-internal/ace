/**
 * `bin/ace-setup` personal mode (owner decision 2026-10-14).
 *
 * A person who installs ACE uses it in THEIR OWN Claude Code with THEIR OWN
 * credentials. Until this change `/ace:setup` only supported the operator who
 * hosts ACE: it failed fast without the 1Password CLI and rendered ~40 of ACE's
 * own secrets from its vault, so for a newcomer "installed" never became
 * "works" (2026-10-14: a new user ended up routed through the owner's runner).
 *
 * Pinned here:
 *   - mode selection — flags, then: no `op` -> personal; `op` reads ACE's vault
 *     -> operator; `op` can't but the .env is already an operator's -> operator;
 *     else personal.
 *   - personal mode NEVER invokes `op` (a recording stub on PATH proves it),
 *     even when 1Password could read the vault.
 *   - the personal .env carries the template's literals and no 1Password
 *     reference or shared secret, keeps the person's own values across re-runs,
 *     and refuses to replace an operator .env without --force-env.
 *   - `bin/ace-doctor` reports per area on a personal .env instead of failing on
 *     ACE's missing secrets.
 *
 * CLASSIFICATION: unit-test truth over a fixture filesystem and stubbed CLIs;
 * no network, no 1Password session (the Labs live check only runs when a token
 * is present, and the doctor test passes --no-live).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..');
const SETUP = join(REPO_ROOT, 'bin', 'ace-setup');
const DOCTOR = join(REPO_ROOT, 'bin', 'ace-doctor');
const STATUS = join(REPO_ROOT, 'bin', 'ace-personal-status');
const TPL = readFileSync(join(REPO_ROOT, '.env.tpl'), 'utf8');

/** KEY=value lines of .env.tpl, split into literal keys and op://-referenced keys. */
function templateKeys(): { literal: string[]; secret: string[] } {
  const literal: string[] = [];
  const secret: string[] = [];
  for (const raw of TPL.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    (m[2].includes('op://') ? secret : literal).push(m[1]);
  }
  return { literal, secret };
}

let dir: string;
let bin: string;
let opLog: string;
let dataDir: string;

/** A bin dir with node + npm (and optionally a recording `op` stub) — nothing else from the host. */
function makeBin(op: 'none' | 'readable' | 'unreadable'): string {
  const b = join(dir, `bin-${op}`);
  if (existsSync(b)) return b;
  mkdirSync(b, { recursive: true });
  // node is this process's own binary; npm ships beside it.
  symlinkSync(process.execPath, join(b, 'node'));
  symlinkSync(realpathSync(join(dirname(process.execPath), 'npm')), join(b, 'npm'));
  if (op !== 'none') {
    const rc = op === 'readable' ? 0 : 1;
    writeFileSync(
      join(b, 'op'),
      `#!/bin/sh\necho "op $*" >> "${opLog}"\nexit ${rc}\n`,
    );
    chmodSync(join(b, 'op'), 0o755);
  }
  return b;
}

function run(
  script: string,
  args: string[],
  opts: { op?: 'none' | 'readable' | 'unreadable'; env?: NodeJS.ProcessEnv } = {},
) {
  bin = makeBin(opts.op ?? 'none');
  const r = spawnSync('bash', [script, ...args], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: join(dir, 'home'),
      CLAUDE_PLUGIN_ROOT: REPO_ROOT,
      CLAUDE_PLUGIN_DATA: dataDir,
      ACE_PLUGIN_REGISTRY: join(dir, 'no-registry.json'),
      ...opts.env,
    },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function kv(out: string): Record<string, string> {
  const o: Record<string, string> = {};
  for (const line of out.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0 && /^[a-z_]+$/.test(line.slice(0, i))) o[line.slice(0, i)] = line.slice(i + 1);
  }
  return o;
}

const opCalls = () => (existsSync(opLog) ? readFileSync(opLog, 'utf8') : '');

const OPERATOR_ENV = 'ACE_HQ_USERNAME=ace@dimagi-ai.com\nACE_HQ_PASSWORD=real-secret-value\nOCS_PASSWORD=another-secret\n';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ace-setup-personal-'));
  mkdirSync(join(dir, 'home'), { recursive: true });
  dataDir = join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  opLog = join(dir, 'op-calls.log');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('mode selection (--print-mode: no writes)', () => {
  it('--personal is personal and never runs op, even when op could read the vault', () => {
    const { code, out } = run(SETUP, ['--print-mode', '--personal'], { op: 'readable' });
    expect(code).toBe(0);
    expect(kv(out).mode).toBe('personal');
    expect(kv(out).mode_reason).toMatch(/--personal/);
    expect(opCalls()).toBe('');
  });

  it('chooses personal when the 1Password CLI is not installed', () => {
    const { out } = run(SETUP, ['--print-mode'], { op: 'none' });
    expect(kv(out).mode).toBe('personal');
    expect(kv(out).mode_reason).toMatch(/not installed/);
  });

  it("chooses operator when op can read ACE's vault", () => {
    const { out } = run(SETUP, ['--print-mode'], { op: 'readable' });
    expect(kv(out).mode).toBe('operator');
    expect(kv(out).mode_reason).toMatch(/can read ACE's vault/);
    expect(opCalls()).toMatch(/op vault get Agent-Ace/);
  });

  it("chooses personal when op can't read ACE's vault and there is no operator .env", () => {
    const { out } = run(SETUP, ['--print-mode'], { op: 'unreadable' });
    expect(kv(out).mode).toBe('personal');
    expect(kv(out).mode_reason).toMatch(/can't read ACE's vault/);
  });

  it("stays operator when op can't read the vault but the .env is already an operator's", () => {
    // An operator who is merely signed out must get the old "sign in" failure,
    // not a personal .env written over ACE's settings.
    writeFileSync(join(dataDir, '.env'), OPERATOR_ENV);
    const { out } = run(SETUP, ['--print-mode'], { op: 'unreadable' });
    expect(kv(out).mode).toBe('operator');
    expect(kv(out).mode_reason).toMatch(/already holds ACE's operator settings/);
  });

  it('--operator forces operator', () => {
    const { out } = run(SETUP, ['--print-mode', '--operator'], { op: 'none' });
    expect(kv(out).mode).toBe('operator');
  });

  it('rejects --personal together with --operator', () => {
    const { code, out } = run(SETUP, ['--personal', '--operator', '--print-mode']);
    expect(code).toBe(2);
    expect(out).toMatch(/mutually exclusive/);
  });

  it('derives the data dir <plugin>-<marketplace> for ace@canopy-<ws> (where the MCP servers look)', () => {
    const root = join(dir, 'home', '.claude', 'plugins', 'cache', 'canopy-acme', 'ace', '1.0.0');
    mkdirSync(join(root, '.claude-plugin'), { recursive: true });
    writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'ace' }));
    const { out } = run(SETUP, ['--print-mode', '--personal'], {
      env: { CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: '' },
    });
    expect(kv(out).data_dir).toBe(join(dir, 'home', '.claude', 'plugins', 'data', 'ace-canopy-acme'));
  });

  it('finds ACE in the registry under any marketplace, not only ace@ace', () => {
    const installed = join(dir, 'installed-ace');
    mkdirSync(join(installed, '.claude-plugin'), { recursive: true });
    writeFileSync(join(installed, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'ace' }));
    const reg = join(dir, 'registry.json');
    writeFileSync(
      reg,
      JSON.stringify({ version: 2, plugins: { 'ace@canopy-acme': [{ installPath: installed, version: '1' }] } }),
    );
    bin = makeBin('none');
    const r = spawnSync('bash', [SETUP, '--print-root'], {
      cwd: dir,
      encoding: 'utf8',
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: join(dir, 'home'), ACE_PLUGIN_REGISTRY: reg },
    });
    expect(kv(r.stdout).plugin_root).toBe(installed);
    expect(kv(r.stdout).plugin_root_source).toBe('installed_plugins.json');
  });
});

describe('personal setup run', () => {
  it('never invokes op, writes only shared config, and reports per area', () => {
    const { code, out } = run(SETUP, ['--personal'], { op: 'readable' });
    expect(code).toBe(0);
    expect(opCalls()).toBe('');
    expect(out).toMatch(/MODE personal/);
    expect(out).toMatch(/STATUS: COMPLETE \(personal\)/);
    expect(out).not.toMatch(/^FAIL /m);

    const env = readFileSync(join(dataDir, '.env'), 'utf8');
    const { literal, secret } = templateKeys();
    expect(literal.length).toBeGreaterThan(5);
    for (const k of literal) expect(env).toMatch(new RegExp(`^${k}=`, 'm'));
    for (const k of secret) expect(env).not.toMatch(new RegExp(`^${k}=`, 'm'));
    expect(env).not.toMatch(/op:\/\//);
    expect(env).toMatch(/^ACE_SETUP_MODE=personal$/m);
    // No service-account key was fetched.
    expect(existsSync(join(dataDir, 'gws-sa-key.json'))).toBe(false);

    // The doctor ran in personal mode: one line per area, honest statuses.
    expect(out).toMatch(/what works for you \(personal mode\)/);
    expect(out).toMatch(/READY\s+Reading & explaining/);
    expect(out).toMatch(/NEEDS YOU\s+Connect Labs\s+.*labs\.connect\.dimagi\.com\/labs\/mcp\/tokens/);
    expect(out).toMatch(/OPERATOR-ONLY\s+Connect\s/);
    expect(out).toMatch(/OPERATOR-ONLY\s+OCS chatbots/);
    expect(out).toMatch(/OPERATOR-ONLY\s+Google Drive \/ Docs/);
  });

  it('keeps credentials of your own across a re-run', () => {
    writeFileSync(
      join(dataDir, '.env'),
      'ACE_SETUP_MODE=personal\nOCS_BASE_URL=https://stale.example\nLABS_MCP_TOKEN=my-own-token\nNOVA_API_KEY=op://Agent-Ace/x/y\n',
    );
    const { code } = run(SETUP, ['--personal', '--skip-doctor']);
    expect(code).toBe(0);
    const env = readFileSync(join(dataDir, '.env'), 'utf8');
    expect(env).toMatch(/^LABS_MCP_TOKEN=my-own-token$/m);
    // Template literals win over stale values; unresolved refs are dropped.
    expect(env).toMatch(/^OCS_BASE_URL=https:\/\/www\.openchatstudio\.com$/m);
    expect(env).not.toMatch(/stale\.example/);
    expect(env).not.toMatch(/op:\/\//);
    expect(env.match(/^ACE_SETUP_MODE=/gm)).toHaveLength(1);
  });

  it("refuses to replace an operator .env unless --force-env, then backs it up", () => {
    writeFileSync(join(dataDir, '.env'), OPERATOR_ENV);
    const refused = run(SETUP, ['--personal', '--skip-doctor']);
    expect(refused.code).toBe(1);
    expect(refused.out).toMatch(/holds ACE's operator settings/);
    expect(readFileSync(join(dataDir, '.env'), 'utf8')).toBe(OPERATOR_ENV);

    const forced = run(SETUP, ['--personal', '--force-env', '--skip-doctor']);
    expect(forced.code).toBe(0);
    const backups = readdirSync(dataDir).filter((f) => f.startsWith('.env.operator-backup-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(dataDir, backups[0]), 'utf8')).toBe(OPERATOR_ENV);
    const env = readFileSync(join(dataDir, '.env'), 'utf8');
    expect(env).toMatch(/^ACE_SETUP_MODE=personal$/m);
    expect(env).not.toMatch(/real-secret-value|another-secret/);
  });
});

describe('doctor on a personal install', () => {
  it('reports per area instead of failing on ACE’s missing shared secrets', () => {
    writeFileSync(join(dataDir, '.env'), 'ACE_SETUP_MODE=personal\nLABS_MCP_TOKEN=mine\n');
    const { out } = run(DOCTOR, ['--no-live']);
    expect(out).toMatch(/what works for you \(personal mode\)/);
    expect(out).toMatch(/READY\s+Connect Labs\s+your Labs token is set/);
    expect(out).not.toMatch(/^FAIL /m);
    expect(opCalls()).toBe('');
  });

  it('runs the operator checks with --operator', () => {
    writeFileSync(join(dataDir, '.env'), 'ACE_SETUP_MODE=personal\n');
    const { out } = run(DOCTOR, ['--operator', '--preflight', '--no-live']);
    expect(out).not.toMatch(/what works for you/);
  });

  it('the personal report itself never calls op and always exits 0', () => {
    const { code } = run(STATUS, ['--data-dir', join(dir, 'missing'), '--no-live'], { op: 'readable' });
    expect(code).toBe(0);
    expect(opCalls()).toBe('');
  });
});

describe('switching a machine back to operator', () => {
  it('operator re-inject drops the personal marker instead of preserving it as a local-only key', () => {
    const setup = readFileSync(SETUP, 'utf8');
    expect(setup).toMatch(/RETIRED_KEYS="[^"]*\bACE_SETUP_MODE\b/);
  });
});
