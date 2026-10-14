/**
 * A newcomer's first `/ace:setup` usually fails on 1Password. Owner decision
 * (2026-10-14): setup stays 1Password-backed, and access to the ACE instance's
 * vault IS how a person brings ACE's credentials. So every 1Password failure must
 * say, in two lines, what access is needed and who grants it. The vault is the
 * one canopy-web records for the instance (`canopy agent env --print`,
 * canopy#899) — the note names it when canopy resolved it, and says where to
 * look when it did not, never a hardcoded vault name.
 *
 * CLASSIFICATION: unit-test truth. The CLI-missing case runs the real script on
 * a PATH with node + npm and no `op`; the other sites are pinned structurally.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..');
const SETUP = join(REPO_ROOT, 'bin', 'ace-setup');

describe('setup names the access a newcomer needs', () => {
  // Runs the real script on a PATH with node + npm, no `op`, and optionally a
  // stub `canopy` that resolves the instance's vault the way 0.2.681 does.
  function runWithoutOp(canopyVault?: string) {
    const dir = mkdtempSync(join(tmpdir(), 'ace-setup-access-'));
    try {
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      symlinkSync(process.execPath, join(bin, 'node'));
      symlinkSync(realpathSync(join(dirname(process.execPath), 'npm')), join(bin, 'npm'));
      if (canopyVault) {
        writeFileSync(
          join(bin, 'canopy'),
          `#!/bin/bash\n[ "$1" = --version ] && { echo "canopy 0.2.681"; exit 0; }\n` +
            `echo '{"plugin":"ace","agent":"ace","vault":"${canopyVault}"}'\n`,
          { mode: 0o755 },
        );
      }
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
      return { status: r.status, out: r.stdout + r.stderr };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('names the vault canopy resolved for the instance, and the owner, when op is not installed', () => {
    const { status, out } = runWithoutOp('Agent-Fixture');
    expect(status).toBe(1);
    expect(out).toMatch(/FAIL op: 1Password CLI not installed/);
    expect(out).toMatch(/ACCESS: .*dimagi\.1password\.com.*"Agent-Fixture" vault/);
    const author = JSON.parse(readFileSync(join(REPO_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).author;
    expect(out).toContain(`Ask ACE's owner, ${author.name} (${author.email})`);
  });

  it('says where to find the vault — never a guessed name — when canopy could not resolve it', () => {
    const { status, out } = runWithoutOp();
    expect(status).toBe(1);
    expect(out).toMatch(/FAIL op: 1Password CLI not installed/);
    expect(out).toMatch(/ACCESS: .*your ACE instance's vault \(`canopy agent env --plugin ace --print` names it\)/);
    expect(out).not.toMatch(/Agent-Ace/);
  });

  it('prints it at every 1Password failure site', () => {
    const setup = readFileSync(SETUP, 'utf8');
    // CLI missing, not signed in, SA-key fetch failed, vault unreadable.
    expect(setup.match(/^\s*access_note$/gm)).toHaveLength(4);
  });

  it('no setup doc still names the retired AI-Agents vault as the source', () => {
    const setupMd = readFileSync(join(REPO_ROOT, 'commands', 'setup.md'), 'utf8');
    expect(setupMd).not.toMatch(/vault `AI-Agents`/);
  });
});
