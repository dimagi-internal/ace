import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * ace-doctor's gog_auth fix line follows how this machine runs ace (2026-10-28,
 * failure investigation 17, turn c10c9748): a licence holder on Windows was told to
 * press the admin-only "Connect Google mailbox" button or to `gog login` as ace@.
 */
const ROOT = join(__dirname, '..', '..');
const HINT = join(ROOT, 'bin', 'ace-gog-hint');

function hint(mode: string | null, ...args: string[]): string {
  const bin = mkdtempSync(join(tmpdir(), 'fake-canopy-'));
  if (mode !== null) {
    const fake = join(bin, 'canopy');
    writeFileSync(fake, `#!/bin/sh\n[ "$1 $2" = "agent runs-as" ] && echo ${mode}\n`);
    chmodSync(fake, 0o755);
  }
  return execFileSync('bash', [HINT, '--mailbox', 'ace@dimagi-ai.com', ...args], {
    env: { PATH: `${bin}:/usr/bin:/bin` },
    encoding: 'utf8',
  });
}

describe('bin/ace-gog-hint', () => {
  it('sends a licence holder to canopy, never to gog login or the admin button', () => {
    const out = hint('license');
    expect(out).toContain('canopy agent google-login --slug ace');
    expect(out).not.toMatch(/gog login/);
    expect(out).not.toMatch(/Connect Google mailbox/);
  });

  it('tells a runner to Refresh', () => {
    expect(hint('runner')).toMatch(/^Refresh this runner/);
  });

  it('gives an admin bootstrap first, then the re-connect paths', () => {
    const out = hint('admin');
    expect(out).toContain('canopy agent bootstrap --slug ace');
    expect(out).toContain('gog login ace@dimagi-ai.com --client canopy');
  });

  it('keeps the admin remedy when canopy is missing or too old to answer', () => {
    expect(hint(null)).toContain('canopy agent bootstrap --slug ace');
    expect(hint('')).toContain('canopy agent bootstrap --slug ace');
  });

  it('prefixes the gog install line when gog is missing', () => {
    expect(hint('license', '--no-gog')).toMatch(/^(brew install|install gog from)/);
  });

  it('is what ace-doctor prints for gog_auth', () => {
    const doctor = readFileSync(join(ROOT, 'bin', 'ace-doctor'), 'utf8');
    expect(doctor).toMatch(/GOG_LOGIN_HINT="\$\(bash "\$ROOT\/bin\/ace-gog-hint"/);
    expect(doctor).not.toMatch(/GOG_LOGIN_HINT="connect via/);
  });
});
