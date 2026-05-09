import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeTokenToEnv } from '../../scripts/ace-web-pat-mint.js';

const ENV_KEY = 'ACE_WEB_PAT_TOKEN';
const MARKER_HEADER = '# --- ACE local-only secrets (preserved across op inject) ---';

let dir: string;
let envPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ace-web-pat-mint-test-'));
  envPath = join(dir, '.env');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('writeTokenToEnv', () => {
  it('creates .env with marker block when file does not exist', async () => {
    await writeTokenToEnv(envPath, ENV_KEY, 'token-1');
    const content = await readFile(envPath, 'utf8');
    expect(content).toContain(MARKER_HEADER);
    expect(content).toContain(`${ENV_KEY}=token-1`);
  });

  it('appends marker block when .env exists without one', async () => {
    await writeFile(envPath, 'OCS_BASE_URL=https://www.openchatstudio.com\nACE_HQ_USERNAME=ace@dimagi-ai.com\n');
    await writeTokenToEnv(envPath, ENV_KEY, 'token-2');
    const content = await readFile(envPath, 'utf8');

    // Pre-existing keys preserved.
    expect(content).toMatch(/^OCS_BASE_URL=/m);
    expect(content).toMatch(/^ACE_HQ_USERNAME=/m);

    // Marker block + new key appended.
    expect(content).toContain(MARKER_HEADER);
    expect(content).toContain(`${ENV_KEY}=token-2`);
    // Marker comes before our key.
    expect(content.indexOf(MARKER_HEADER)).toBeLessThan(content.indexOf(`${ENV_KEY}=`));
  });

  it('replaces existing token line in-place when key already present in marker block', async () => {
    const initial = `OCS_BASE_URL=foo\n\n${MARKER_HEADER}\n# Set by operator...\n${ENV_KEY}=old-token\n`;
    await writeFile(envPath, initial);

    await writeTokenToEnv(envPath, ENV_KEY, 'new-token');
    const content = await readFile(envPath, 'utf8');

    expect(content).toContain(`${ENV_KEY}=new-token`);
    expect(content).not.toContain('old-token');
    // Should still have only ONE occurrence of the key.
    const matches = content.match(new RegExp(`^${ENV_KEY}=`, 'gm')) || [];
    expect(matches.length).toBe(1);
    // Marker block still present (not duplicated).
    expect(content.split(MARKER_HEADER).length - 1).toBe(1);
  });

  it('appends key inside existing marker block when key missing from it', async () => {
    const initial = `OCS_BASE_URL=foo\n\n${MARKER_HEADER}\n# Set by operator...\nOTHER_LOCAL=value\n`;
    await writeFile(envPath, initial);

    await writeTokenToEnv(envPath, ENV_KEY, 'token-3');
    const content = await readFile(envPath, 'utf8');

    // Both the pre-existing local secret and the new one are present.
    expect(content).toContain('OTHER_LOCAL=value');
    expect(content).toContain(`${ENV_KEY}=token-3`);
    // Marker not duplicated.
    expect(content.split(MARKER_HEADER).length - 1).toBe(1);
  });

  it('handles file without trailing newline', async () => {
    await writeFile(envPath, 'OCS_BASE_URL=foo'); // no trailing \n
    await writeTokenToEnv(envPath, ENV_KEY, 'token-4');
    const content = await readFile(envPath, 'utf8');

    // Pre-existing key intact.
    expect(content).toMatch(/^OCS_BASE_URL=foo$/m);
    expect(content).toContain(`${ENV_KEY}=token-4`);
  });

  it('preserves other lines when replacing in-place', async () => {
    const initial = [
      'OCS_BASE_URL=https://www.openchatstudio.com',
      'OCS_TEAM_SLUG=connect-ace',
      '',
      MARKER_HEADER,
      '# Set by operator, NOT 1Password-backed.',
      `${ENV_KEY}=initial`,
      'OTHER_LOCAL=keep-me',
      '',
    ].join('\n');
    await writeFile(envPath, initial);

    await writeTokenToEnv(envPath, ENV_KEY, 'updated');
    const content = await readFile(envPath, 'utf8');

    expect(content).toMatch(/^OCS_BASE_URL=/m);
    expect(content).toMatch(/^OCS_TEAM_SLUG=/m);
    expect(content).toMatch(/^OTHER_LOCAL=keep-me$/m);
    expect(content).toContain(`${ENV_KEY}=updated`);
    expect(content).not.toContain(`${ENV_KEY}=initial`);
  });

  it('writes file with mode 600', async () => {
    await writeTokenToEnv(envPath, ENV_KEY, 'token-mode');
    const { stat } = await import('node:fs/promises');
    const s = await stat(envPath);
    // Mask off file-type bits, just check the permission bits.
    const mode = s.mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
