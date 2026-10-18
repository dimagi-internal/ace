/**
 * bin/ace-setup must not stop at 1Password, or at an instance canopy cannot
 * resolve, when this run does not read the vault.
 *
 * The incident (cloud-ec2-2, 2026-10-18): `canopy agent prepare --runner` runs
 * `bin/ace-setup --skip-doctor` with the agent's own op service-account key.
 * op was authenticated, but `canopy agent env --print` takes a PERSON's
 * canopy-web token, which a runner does not have, so every run ended at
 * "FAIL instance: … not signed in to canopy-web" — and deps, ~/.ace/env.sh,
 * the user-scope nova entry and the ace-web token never got set up. By hand
 * with --skip-env and no op key it stopped one step earlier, at "FAIL op: not
 * authenticated", though --skip-env reads nothing from the vault.
 *
 * Now: canopy hands over the .env it already filled (AGENT_ENV_FILE) and the
 * vault (AGENT_VAULT); op / instance are a FAIL only when a missing SA key
 * must be fetched or $DATA_DIR/.env must be rendered.
 *
 * CLASSIFICATION: unit-test truth. The real script against stub `canopy`,
 * `op`, `gh`, `gog` and a `node` shim that stands in for the two networked
 * helpers (doctor-nova-header --heal, ace-web-bot-token-mint); no network,
 * no 1Password session.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..');
const SETUP = join(REPO_ROOT, 'bin', 'ace-setup');

const TPL_KEYS = readFileSync(join(REPO_ROOT, '.env.tpl'), 'utf8')
  .split('\n')
  .map((l) => /^\s*([A-Z_][A-Z0-9_]*)=/.exec(l)?.[1])
  .filter((k): k is string => Boolean(k));

/** A fully-resolved .env covering every .env.tpl key. */
function filledEnv(tag: string): string {
  return TPL_KEYS.map((k) => (k === 'NOVA_API_KEY' ? `${k}=nova-${tag}` : `${k}=${tag}`)).join('\n') + '\n';
}

let dir: string;
let bin: string;
let data: string;

function stub(name: string, body: string) {
  writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
}

/** op: --version always; signed in → whoami / vault list succeed. */
function stubOp(signedIn: boolean) {
  stub('op', `[ "$1" = --version ] && { echo 2.40.0; exit 0; }\nexit ${signedIn ? 0 : 1}`);
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
  // The service-account key is already in place.
  writeFileSync(join(data, 'gws-sa-key.json'), JSON.stringify({ client_email: 'sa@example.iam' }));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('on a runner (canopy prepare: op key set, no person token, AGENT_ENV_FILE)', () => {
  it('syncs the canopy-filled env and runs to completion', () => {
    stubOp(true);
    const supplied = join(dir, 'supplied.env');
    writeFileSync(supplied, filledEnv('fresh'));
    // An older data-dir .env with a local-only secret this machine minted.
    writeFileSync(join(data, '.env'), filledEnv('stale') + 'ACE_WEB_TOKEN_LOCAL_ONLY=keep-me\n');

    const { status, out } = run([], {
      OP_SERVICE_ACCOUNT_TOKEN: 'ops_stub',
      AGENT_ENV_FILE: supplied,
      AGENT_VAULT: 'Agent-Stub',
    });

    expect(out).not.toMatch(/^FAIL /m);
    expect(status).toBe(0);
    expect(out).toMatch(/PASS op: authenticated as service-account/);
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
    stubOp(true);
    const supplied = join(dir, 'supplied.env');
    writeFileSync(supplied, filledEnv('same'));
    writeFileSync(join(data, '.env'), filledEnv('same'));
    const { status, out } = run([], { OP_SERVICE_ACCOUNT_TOKEN: 'ops_stub', AGENT_ENV_FILE: supplied });
    expect(status).toBe(0);
    expect(out).toMatch(/PASS env: .* already matches .* \(filled by canopy\)/);
    expect(out).not.toMatch(/RESTART REQUIRED/);
  });

  it('ignores an incomplete supplied env and still needs canopy to render', () => {
    stubOp(true);
    const supplied = join(dir, 'supplied.env');
    writeFileSync(supplied, 'NOVA_API_KEY=x\n');
    const { status, out } = run([], { OP_SERVICE_ACCOUNT_TOKEN: 'ops_stub', AGENT_ENV_FILE: supplied });
    expect(out).toMatch(/WARN env: AGENT_ENV_FILE=.* lacks \.env\.tpl keys/);
    expect(status).toBe(1);
    expect(out).toMatch(/FAIL instance: canopy could not resolve/);
    expect(out).not.toMatch(/running npm install/);
  });
});

describe('when nothing this run reads the vault', () => {
  it('--skip-env with op signed out and the key present: WARN, then the rest runs', () => {
    stubOp(false);
    writeFileSync(join(data, '.env'), filledEnv('have'));
    const { status, out } = run(['--skip-env', '--no-shell-edit']);
    expect(out).not.toMatch(/^FAIL /m);
    expect(status).toBe(0);
    expect(out).toMatch(/WARN op: not authenticated to 1Password — not needed this run \(key present, env skipped/);
    expect(out).toMatch(/WARN instance: not resolved — not needed this run/);
    expect(existsSync(join(dir, '.ace', 'env.sh'))).toBe(true);
    expect(out).toMatch(/STATUS: COMPLETE/);
  });

  it('a complete env and the key present: op signed out is a WARN', () => {
    stubOp(false);
    writeFileSync(join(data, '.env'), filledEnv('have'));
    const { status, out } = run(['--no-shell-edit']);
    expect(status).toBe(0);
    expect(out).toMatch(/WARN op: not authenticated to 1Password — not needed this run \(key present, .* already complete\)/);
    expect(out).toMatch(/PASS env: .* already has every \.env\.tpl key/);
  });
});

describe('when this run DOES read the vault', () => {
  it('op signed out and no .env to keep: FAIL op, naming why it is needed', () => {
    stubOp(false);
    const { status, out } = run([]);
    expect(status).toBe(1);
    expect(out).toMatch(/FAIL op: not authenticated to 1Password \(needed: .*\.env must be rendered/);
    expect(out).not.toMatch(/running npm install/);
  });

  it('op signed out and the SA key missing, even with --skip-env: FAIL op', () => {
    stubOp(false);
    rmSync(join(data, 'gws-sa-key.json'));
    const { status, out } = run(['--skip-env']);
    expect(status).toBe(1);
    expect(out).toMatch(/FAIL op: not authenticated to 1Password \(needed: the Google service-account key is missing\)/);
  });

  it('a missing key is fetched from AGENT_VAULT when canopy cannot resolve the instance', () => {
    rmSync(join(data, 'gws-sa-key.json'));
    // op document get writes the key to --output; everything else succeeds.
    stub(
      'op',
      `[ "$1" = --version ] && { echo 2.40.0; exit 0; }\n` +
        `if [ "$1" = document ]; then\n` +
        `  while [ $# -gt 0 ]; do [ "$1" = --vault ] && echo "$2" > "${dir}/vault-used"; [ "$1" = --output ] && out="$2"; shift; done\n` +
        `  echo '{"client_email":"sa@example.iam"}' > "$out"; exit 0\nfi\nexit 0`,
    );
    writeFileSync(join(data, '.env'), filledEnv('have'));
    const { status, out } = run(['--no-shell-edit'], { OP_SERVICE_ACCOUNT_TOKEN: 'ops_stub', AGENT_VAULT: 'Agent-Stub' });
    expect(out).toMatch(/INFO vault=Agent-Stub \(from AGENT_VAULT/);
    expect(out).toMatch(/PASS gws_key: fetched sa@example\.iam/);
    expect(readFileSync(join(dir, 'vault-used'), 'utf8').trim()).toBe('Agent-Stub');
    expect(status).toBe(0);
  });
});
