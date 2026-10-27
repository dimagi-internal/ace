/**
 * bin/ace-setup must not stop at an instance canopy cannot resolve when this
 * run does not need one. ACE's env comes from its Canopy vault
 * (`canopy agent env --plugin ace`, no template); there is no 1Password step and
 * no service-account key any more (Google is ace@'s canopy token, ace#3310).
 *
 * The incident (cloud-ec2-2, 2026-10-18): `canopy agent prepare --runner` runs
 * `bin/ace-setup --skip-doctor`, but `canopy agent env --print` takes a PERSON's
 * canopy-web token, which a runner does not have, so every run ended at
 * "FAIL instance: … not signed in to canopy-web" — and deps, ~/.ace/env.sh,
 * the user-scope nova entry and the ace-web token never got set up.
 *
 * Now: canopy hands over the .env it already filled (AGENT_ENV_FILE), and the
 * instance is a FAIL only when $DATA_DIR/.env must be filled and none is there
 * to keep.
 *
 * CLASSIFICATION: unit-test truth. The real script against stub `canopy`,
 * `gh`, `gog` and a `node` shim that stands in for the two networked helpers
 * (doctor-nova-header --heal, ace-web-bot-token-mint); no network.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..');
const SETUP = join(REPO_ROOT, 'bin', 'ace-setup');

const VAULT_KEYS = ['ACE_HQ_USERNAME', 'NOVA_API_KEY', 'OCS_TEAM_SLUG'];

/** A fully-resolved .env, as the vault fills it. */
function filledEnv(tag: string): string {
  return VAULT_KEYS.map((k) => (k === 'NOVA_API_KEY' ? `${k}=nova-${tag}` : `${k}=${tag}`)).join('\n') + '\n';
}

let dir: string;
let bin: string;
let data: string;

function stub(name: string, body: string) {
  writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
}

function run(args: string[], extraEnv: Record<string, string> = {}) {
  const r = spawnSync('bash', [SETUP, '--skip-doctor', ...args], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: dir,
      SHELL: '/bin/bash',
      CLAUDE_PLUGIN_ROOT: REPO_ROOT,
      CLAUDE_PLUGIN_DATA: data,
      ACE_PLUGIN_REGISTRY: join(dir, 'none.json'),
      ...extraEnv,
    },
  });
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ace-setup-opneed-'));
  bin = join(dir, 'bin');
  data = join(dir, 'data');
  mkdirSync(bin);
  mkdirSync(data);
  const realNode = process.execPath;
  // node shim: the two networked helpers answer canned lines; all else is real node.
  stub(
    'node',
    `case "$*" in\n` +
      `  *doctor-nova-header.ts*) echo "PASS nova_header_readiness: stub"; exit 0 ;;\n` +
      `  *ace-web-bot-token-mint.ts*) echo "PASS ace_web_token: stub"; exit 0 ;;\n` +
      `  *doctor-env-freshness.ts*) exit 0 ;;\n` +
      `esac\nexec "${realNode}" "$@"`,
  );
  symlinkSync(realpathSync(join(dirname(realNode), 'npm')), join(bin, 'npm'));
  // What a runner sees: canopy is installed, but `agent env` needs a person token.
  stub(
    'canopy',
    `[ "$1" = --version ] && { echo "canopy 0.2.729"; exit 0; }\n` +
      `echo "Error: not signed in to canopy-web — run /canopy:canopy-web-pat-mint, then re-run." >&2\nexit 1`,
  );
  stub('gh', 'exit 1');
  stub('gog', 'exit 1');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('on a runner (canopy prepare: no person token, AGENT_ENV_FILE)', () => {
  it('syncs the canopy-filled env and runs to completion', () => {
    const supplied = join(dir, 'supplied.env');
    writeFileSync(supplied, filledEnv('fresh'));
    // An older data-dir .env with a local-only secret this machine minted.
    writeFileSync(join(data, '.env'), filledEnv('stale') + 'ACE_WEB_TOKEN_LOCAL_ONLY=keep-me\n');

    const { status, out } = run([], { AGENT_ENV_FILE: supplied });

    expect(out).not.toMatch(/^FAIL /m);
    expect(status).toBe(0);
    expect(out).toMatch(/WARN instance: not resolved — not needed this run/);
    expect(out).toMatch(/PASS env: synced .* \(filled by canopy; preserved 1 local-only secret/);
    const env = readFileSync(join(data, '.env'), 'utf8');
    expect(env).toContain('NOVA_API_KEY=nova-fresh');
    expect(env).not.toContain('=stale');
    expect(env).toContain('ACE_WEB_TOKEN_LOCAL_ONLY=keep-me');
    // Everything after the env step still ran.
    expect(readFileSync(join(dir, '.ace', 'env.sh'), 'utf8')).toContain('NOVA_API_KEY="nova-fresh"');
    expect(out).toMatch(/PASS nova_mcp_entry:/);
    expect(out).toMatch(/PASS ace_web_token: stub/);
    expect(out).toMatch(/STATUS: COMPLETE/);
  });

  it('is a no-op on the env when the data-dir copy already matches', () => {
    const supplied = join(dir, 'supplied.env');
    writeFileSync(supplied, filledEnv('same'));
    writeFileSync(join(data, '.env'), filledEnv('same'));
    const { status, out } = run([], { AGENT_ENV_FILE: supplied });
    expect(status).toBe(0);
    expect(out).toMatch(/PASS env: .* already matches .* \(filled by canopy\)/);
    expect(out).not.toMatch(/RESTART REQUIRED/);
  });

  it('ignores an unresolved supplied env and still needs canopy to fill', () => {
    const supplied = join(dir, 'supplied.env');
    writeFileSync(supplied, 'NOVA_API_KEY=op://Agent-Stub/ACE - Nova/api_key\n');
    const { status, out } = run([], { AGENT_ENV_FILE: supplied });
    expect(out).toMatch(/WARN env: AGENT_ENV_FILE=.* has unresolved op:\/\/ refs/);
    expect(status).toBe(1);
    expect(out).toMatch(/FAIL instance: canopy could not resolve/);
    expect(out).not.toMatch(/running npm install/);
  });
});

describe('when nothing this run reads the vault', () => {
  it('--skip-env: WARN that the instance is unresolved, then the rest runs', () => {
    writeFileSync(join(data, '.env'), filledEnv('have'));
    const { status, out } = run(['--skip-env', '--no-shell-edit']);
    expect(out).not.toMatch(/^FAIL /m);
    expect(status).toBe(0);
    expect(out).toMatch(/WARN instance: not resolved — not needed this run/);
    expect(existsSync(join(dir, '.ace', 'env.sh'))).toBe(true);
    expect(out).toMatch(/STATUS: COMPLETE/);
  });

  it('an existing env and no instance: WARNs, keeps the env, runs on', () => {
    writeFileSync(join(data, '.env'), filledEnv('have'));
    const { status, out } = run(['--no-shell-edit']);
    expect(status).toBe(0);
    expect(out).toMatch(/WARN env: kept the existing/);
    expect(readFileSync(join(data, '.env'), 'utf8')).toBe(filledEnv('have'));
  });
});

describe('filling from the Canopy vault', () => {
  /** canopy: --print names the instance; a real fill writes --out (and the binding beside it). */
  function stubCanopyVault(tag: string) {
    stub(
      'canopy',
      `[ "$1" = --version ] && { echo "canopy 0.2.756"; exit 0; }\n` +
        `out=""; print=0; tpl=0\n` +
        `while [ $# -gt 0 ]; do case "$1" in --out) out="$2"; shift ;; --print) print=1 ;; --template) tpl=1 ;; esac; shift; done\n` +
        `[ "$tpl" = 1 ] && { echo "unexpected --template" >&2; exit 9; }\n` +
        `if [ "$print" = 1 ]; then echo '{"plugin":"ace","agent":"ace","vault":"","vault_source":"canopy vault"}'; exit 0; fi\n` +
        `printf '${filledEnv(tag).replace(/\n/g, '\\n')}' > "$out"\n` +
        `echo '{"agent":"ace"}' > "$(dirname "$out")/canopy-instance.json"\n` +
        `echo "env: $out (3 vars) from canopy vault"`,
    );
  }

  it('writes .env from the vault with no template, keeping local-only secrets', () => {
    stubCanopyVault('vault');
    writeFileSync(join(data, '.env'), filledEnv('stale') + 'ACE_WEB_PAT_TOKEN=keep-me\nACE_GMAIL_CLIENT=ace\n');
    const { status, out } = run(['--no-shell-edit']);
    expect(out).not.toMatch(/^FAIL /m);
    expect(status).toBe(0);
    expect(out).toMatch(/PASS instance: ace/);
    expect(out).toMatch(/PASS env: wrote .* from ACE's Canopy vault \(3 vars; preserved 1 local-only secret/);
    expect(out).toMatch(/RESTART REQUIRED/);
    const env = readFileSync(join(data, '.env'), 'utf8');
    expect(env).toContain('NOVA_API_KEY=nova-vault');
    expect(env).not.toContain('=stale');
    expect(env).toContain('ACE_WEB_PAT_TOKEN=keep-me');
    expect(env).not.toContain('ACE_GMAIL_CLIENT');
    expect(existsSync(join(data, 'canopy-instance.json'))).toBe(true);

    // A second run against an unchanged vault rewrites nothing.
    const again = run(['--no-shell-edit']);
    expect(again.status).toBe(0);
    expect(again.out).toMatch(/PASS env: .* already matches ACE's Canopy vault/);
    expect(again.out).not.toMatch(/RESTART REQUIRED/);
  });
});

describe('when this run needs what it cannot get', () => {
  it('no .env to keep and canopy cannot resolve the instance: FAIL instance', () => {
    const { status, out } = run([]);
    expect(status).toBe(1);
    expect(out).toMatch(/FAIL instance: canopy could not resolve this install's ACE instance/);
    expect(out).not.toMatch(/running npm install/);
  });
});
