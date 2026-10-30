/**
 * `/ace:setup` binds this install to ONE ACE instance through canopy's shared
 * step (canopy#899, canopy 0.2.681): `canopy agent env --plugin ace` resolves
 * the instance (the only one you can see, the one already bound, or
 * `--agent`) and fills .env from that instance's Canopy vault — the ONLY
 * declaration of ACE's env names (canopy agent-runtime.md § One declaration).
 *
 * So bin/ace-setup must (1) fill `$DATA_DIR/.env` through that command with
 * NO `--template`, (2) name no vault in code, and (3) stop with canopy's
 * own message when canopy cannot resolve an instance and the fill is needed —
 * before npm install.
 *
 * CLASSIFICATION: unit-test truth. Structural pins over the script, plus one
 * run of the real script against stub `canopy` binaries; no network.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..');
const SETUP = join(REPO_ROOT, 'bin', 'ace-setup');
const setup = readFileSync(SETUP, 'utf8');
// Executable lines only.
const code = setup
  .split('\n')
  .filter((l) => !/^\s*#/.test(l))
  .join('\n');

describe('bin/ace-setup fills .env through canopy agent env', () => {
  it('invokes canopy agent env --plugin ace for the fill, with no template', () => {
    expect(code).toMatch(/canopy agent env --plugin ace --out "\$FILL_DIR\/\.env" --agent "\$BOUND_AGENT"/);
    expect(code).toMatch(/ENV_OUT="\$DATA_DIR\/\.env"/);
    expect(code).not.toMatch(/--template/);
  });

  it('shells out to no secret-store CLI of its own', () => {
    expect(code).not.toMatch(/(^|\$\(|;|&&|\|)\s*op\s+(inject|read|item|document|whoami)\b/m);
  });

  it('resolves the instance with --print before the fill', () => {
    const printAt = code.indexOf('canopy agent env --plugin ace --out "$ENV_OUT" --print');
    const fillAt = code.indexOf('canopy agent env --plugin ace --out "$FILL_DIR/.env"');
    expect(printAt).toBeGreaterThan(-1);
    expect(fillAt).toBeGreaterThan(printAt);
  });

  it('reads no secret-store CLI: no op CLI check, no vault, no SA-key fetch (ace#3310)', () => {
    expect(code).not.toMatch(/\bOP_VAULT\b|ACE_OP_VAULT|AGENT_VAULT|GWS_DOC_NAME|op document get|gws-sa-key/);
    expect(code).not.toMatch(/Agent-Ace/);
  });

  it('requires canopy 0.2.681 or newer', () => {
    expect(code).toMatch(/CANOPY_MIN="0\.2\.681"/);
  });

  it('passes --agent / --rebind through to canopy', () => {
    expect(code).toMatch(/--agent\)\s+BIND_AGENT=/);
    expect(code).toMatch(/REBIND" = "1" \] && CANOPY_ARGS="\$CANOPY_ARGS --force"/);
  });
});

describe('when canopy cannot resolve an instance', () => {
  it('stops with canopy\'s message verbatim, before npm install', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ace-setup-canopy-'));
    try {
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      symlinkSync(process.execPath, join(bin, 'node'));
      symlinkSync(realpathSync(join(dirname(process.execPath), 'npm')), join(bin, 'npm'));
      const several =
        "several instances of plugin 'ace' are visible — pick one:\n" +
        '  canopy agent env --plugin ace --agent ace-a\n' +
        '  canopy agent env --plugin ace --agent ace-b';
      writeFileSync(
        join(bin, 'canopy'),
        `#!/bin/bash\n[ "$1" = --version ] && { echo "canopy 0.2.681"; exit 0; }\n` +
          `cat >&2 <<'MSG'\nError: ${several}\nMSG\nexit 1\n`,
        { mode: 0o755 },
      );
      const r = spawnSync('bash', [SETUP], {
        cwd: dir,
        encoding: 'utf8',
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          HOME: dir,
          CLAUDE_PLUGIN_ROOT: REPO_ROOT,
          CLAUDE_PLUGIN_DATA: join(dir, 'data'),
          ACE_PLUGIN_REGISTRY: join(dir, 'none.json'),
        },
      });
      const out = r.stdout + r.stderr;
      expect(r.status).toBe(1);
      expect(out).not.toMatch(/\bop:/);
      expect(out).toMatch(/FAIL instance: canopy could not resolve this install's ACE instance/);
      expect(out).toContain(several);
      expect(out).toMatch(/re-run \/ace:setup --agent <instance>/);
      expect(out).not.toMatch(/running npm install/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
