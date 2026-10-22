/**
 * ACE's env now comes from its Canopy vault on canopy-web; 1Password holds only
 * the Google service-account key, read when that key is missing. Every
 * 1Password failure must still say, in two lines, what access is needed and who
 * grants it. The vault is ACE_OP_VAULT / AGENT_VAULT, or the one a legacy
 * canopy record names (`canopy agent env --print`) — the note names it when
 * known, and says what to set when not, never a hardcoded vault name.
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
    expect(out).toMatch(/ACCESS: .*the 1Password vault holding "ACE - Google Service Account" \(set ACE_OP_VAULT to it\)/);
    expect(out).not.toMatch(/Agent-Ace/);
  });

  it('prints it at every 1Password failure site', () => {
    const setup = readFileSync(SETUP, 'utf8');
    // CLI missing, not signed in, no vault named for the key, SA-key fetch failed.
    expect(setup.match(/^\s*access_note$/gm)).toHaveLength(4);
  });

  it('no setup doc still names the retired AI-Agents vault as the source', () => {
    const setupMd = readFileSync(join(REPO_ROOT, 'commands', 'setup.md'), 'utf8');
    expect(setupMd).not.toMatch(/vault `AI-Agents`/);
  });
});
