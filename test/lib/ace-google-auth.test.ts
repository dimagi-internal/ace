/**
 * AceGoogleAuth signs requests with the canopy-minted token for ace@ and
 * renews it when under 5 minutes remain (ace#3310). CLASSIFICATION: unit-test
 * truth — a temp token file and a stub minter; no canopy CLI, no network.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AceGoogleAuth } from '../../lib/ace-google-auth.js';

let dir: string;
let file: string;
const NOW_MS = 1_800_000_000_000;
const write = (token: string, expiresInS: number) =>
  writeFileSync(file, JSON.stringify({ access_token: token, expires_at: NOW_MS / 1000 + expiresInS, account: 'ace@dimagi-ai.com' }));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ace-google-auth-'));
  file = join(dir, 'ace.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('AceGoogleAuth', () => {
  it('uses the file as-is while it has more than 5 minutes left', async () => {
    write('tok-live', 1800);
    let mints = 0;
    const a = new AceGoogleAuth({ tokenPath: file, now: () => NOW_MS, mint: async () => (mints++, file) });
    const h = await a.getRequestHeaders();
    expect(h.get('authorization')).toBe('Bearer tok-live');
    expect(mints).toBe(0);
  });

  it('mints a new token when under 5 minutes remain', async () => {
    write('tok-old', 120);
    let mints = 0;
    const a = new AceGoogleAuth({
      tokenPath: file,
      now: () => NOW_MS,
      mint: async () => (mints++, write('tok-new', 3000), file),
    });
    expect((await a.getRequestHeaders()).get('authorization')).toBe('Bearer tok-new');
    expect(mints).toBe(1);
  });

  it('mints when the file is missing, and shares one mint across concurrent calls', async () => {
    let mints = 0;
    const a = new AceGoogleAuth({
      tokenPath: file,
      now: () => NOW_MS,
      mint: async () => (mints++, write('tok-first', 3000), file),
    });
    const [x, y] = await Promise.all([a.getRequestHeaders(), a.getRequestHeaders()]);
    expect(x.get('authorization')).toBe('Bearer tok-first');
    expect(y.get('authorization')).toBe('Bearer tok-first');
    expect(mints).toBe(1);
  });

  it('fails loud when the minter produces no usable token (no service-account fallback)', async () => {
    write('tok-old', 10);
    const a = new AceGoogleAuth({ tokenPath: file, now: () => NOW_MS, mint: async () => file });
    await expect(a.getRequestHeaders()).rejects.toThrow(/holds no token/);
  });

  it('surfaces the minter error', async () => {
    const a = new AceGoogleAuth({ tokenPath: file, now: () => NOW_MS, mint: async () => { throw new Error('canopy not signed in'); } });
    await expect(a.getRequestHeaders()).rejects.toThrow(/canopy not signed in/);
  });
});

describe('no service-account key anywhere in the servers (ace#3310)', () => {
  it.each(['mcp/google-drive-server.ts', 'mcp/decisions-server.ts', 'bin/ace-setup'])('%s', async (rel) => {
    const { readFileSync } = await import('node:fs');
    const code = readFileSync(join(__dirname, '..', '..', rel), 'utf8');
    expect(code).not.toMatch(/gws-sa-key|GOOGLE_APPLICATION_CREDENTIALS|keyFile|google\.auth\.GoogleAuth/);
  });
  it.each(['mcp/google-drive-server.ts', 'mcp/decisions-server.ts'])('%s signs in with AceGoogleAuth', async (rel) => {
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(join(__dirname, '..', '..', rel), 'utf8')).toMatch(/new AceGoogleAuth\(\)/);
  });
});
