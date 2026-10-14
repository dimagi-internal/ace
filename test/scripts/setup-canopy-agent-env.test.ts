/**
 * `/ace:setup` binds this install to ONE ACE instance through canopy's shared
 * step (canopy#899, canopy 0.2.681): `canopy agent env --plugin ace` resolves
 * the instance (the only one you can see, the one already bound, or
 * `--agent`), takes the vault from that instance's canopy-web record, records
 * the binding beside the .env, and runs `op inject` with AGENT_VAULT set.
 *
 * So bin/ace-setup must (1) fill `$DATA_DIR/.env` through that command, never
 * a raw `op inject`, (2) read the Google service-account key from the vault it
 * resolved, never a hardcoded `Agent-Ace`, and (3) stop with canopy's own
 * message when canopy cannot resolve an instance — before npm install.
 *
 * CLASSIFICATION: unit-test truth. Structural pins over the script, plus one
 * run of the real script against stub `canopy` / `op` binaries; no network,
 * no 1Password session.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..');
const SETUP = join(REPO_ROOT, 'bin', 'ace-setup');
const setup = readFileSync(SETUP, 'utf8');
// Executable lines only — comments may describe op inject freely.
const code = setup
  .split('\n')
  .filter((l) => !/^\s*#/.test(l))
  .join('\n');

describe('bin/ace-setup fills .env through canopy agent env', () => {
  it('invokes canopy agent env --plugin ace for the fill, into $DATA_DIR/.env', () => {
    expect(code).toMatch(/canopy agent env --plugin ace --template "\$INJECT_TPL" --out "\$ENV_OUT"/);
    expect(code).toMatch(/ENV_OUT="\$DATA_DIR\/\.env"/);
  });

  it('runs no raw `op inject` of its own', () => {
    // No `op inject` in command position: a line start, `$(`, `;`, `&&` or `|`.
    expect(code).not.toMatch(/(^|\$\(|;|&&|\|)\s*op inject\b/m);
    // The only remaining mentions are prose inside printf/echo strings.
    for (const line of code.split('\n').filter((l) => /\bop inject\b/.test(l))) {
      expect(line).toMatch(/^\s*(printf|echo)\b/);
    }
  });

  it('resolves the instance and vault with --print before anything reads the vault', () => {
    const printAt = code.indexOf('canopy agent env --plugin ace --template "$ROOT/.env.tpl" --out "$DATA_DIR/.env" --print');
    const keyFetchAt = code.indexOf('op document get "$GWS_DOC_NAME" --vault "$OP_VAULT"');
    expect(printAt).toBeGreaterThan(-1);
    expect(keyFetchAt).toBeGreaterThan(printAt);
  });

  it('hardcodes no vault: OP_VAULT starts empty and ACE_OP_VAULT is only an override', () => {
    expect(code).toMatch(/^OP_VAULT=""$/m);
    expect(code).not.toMatch(/Agent-Ace/);
    expect(code).toMatch(/ACE_OP_VAULT.*--vault/);
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
  it('stops after the 1Password checks with canopy\'s message verbatim, before npm install', () => {
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
      // An authenticated op: --version and whoami succeed.
      writeFileSync(join(bin, 'op'), '#!/bin/bash\n[ "$1" = --version ] && echo 2.32.1\nexit 0\n', {
        mode: 0o755,
      });
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
      expect(out).toMatch(/PASS op: authenticated/);
      expect(out).toMatch(/FAIL instance: canopy could not resolve this install's ACE instance and vault/);
      expect(out).toContain(several);
      expect(out).toMatch(/re-run \/ace:setup --agent <instance>/);
      expect(out).not.toMatch(/running npm install/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
