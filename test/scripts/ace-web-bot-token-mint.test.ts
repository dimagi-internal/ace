/**
 * scripts/ace-web-bot-token-mint.ts — ACE's own ace-web token, minted
 * headlessly as ace@dimagi-ai.com and provisioned from 1Password.
 *
 * Live-validated 2026-09-28: the full chain (hqOAuthLogin → ace-web "Sign in
 * with Connect" → Connect consent → /auth/cli/authorize/ → loopback) minted a
 * token that `GET /api/auth/me` answered as ace@dimagi-ai.com. Intercepting the
 * loopback redirect with Playwright's page.route did NOT work (the browser hit
 * the socket, ERR_CONNECTION_REFUSED, after the token was already minted), which
 * is why the script binds a real listener — pinned below.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { machineLabel, tokenFromCallback } from '../../scripts/ace-web-bot-token-mint.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');

describe('tokenFromCallback', () => {
  it('returns the token when the state matches', () => {
    expect(tokenFromCallback('http://127.0.0.1:50000/cb?token=abc123&state=S', 'S')).toBe('abc123');
  });

  it('refuses a state mismatch — a token for another mint is not ours to store', () => {
    expect(() => tokenFromCallback('http://127.0.0.1:50000/cb?token=abc&state=OTHER', 'S')).toThrow(/state mismatch/);
  });

  it('refuses a redirect with no token', () => {
    expect(() => tokenFromCallback('http://127.0.0.1:50000/cb?state=S', 'S')).toThrow(/no token/);
  });
});

describe('the mint is ACE-owned and uses only public surfaces', () => {
  const src = read('scripts/ace-web-bot-token-mint.ts');

  it('reuses ACE\'s maintained Connect login instead of re-deriving it', () => {
    expect(src).toMatch(/from '\.\.\/mcp\/connect\/auth\/hq-oauth-login\.js'/);
  });

  it('never shells into ace-web (no management command)', () => {
    // Strip comments: the header explains why the command is NOT used.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/manage\.py|mint_personal_token/);
  });

  it('refuses to mint under any identity other than ace@dimagi-ai.com, and verifies before returning', () => {
    expect(src).toMatch(/EXPECTED_EMAIL = 'ace@dimagi-ai\.com'/);
    expect(src).toMatch(/\/api\/auth\/me/);
  });

  it('binds a real loopback listener (page.route interception was observed not to fire)', () => {
    expect(src).toMatch(/createServer\(/);
    expect(src).toMatch(/listen\(LOOPBACK_PORT, '127\.0\.0\.1'/);
  });
});

describe('provisioning: automatic per machine — no 1Password, no browser, no separate step', () => {
  it('.env.tpl declares the name but does NOT ask op inject to resolve it', () => {
    const tpl = read('.env.tpl');
    expect(tpl).toMatch(/^# ACE_WEB_PAT_TOKEN=/m);
    expect(tpl).not.toMatch(/^ACE_WEB_PAT_TOKEN=op:/m);
  });

  it('bin/ace-setup obtains it with --ensure', () => {
    expect(read('bin/ace-setup')).toMatch(/scripts\/ace-web-bot-token-mint\.ts --ensure/);
  });

  it('the doctor points at /ace:setup, not a manual mint', () => {
    const line = read('bin/ace-doctor').split('\n').find((l) => l.includes('warn "ace_web_pat_token:'))!;
    expect(line).toMatch(/ace:setup/);
    expect(line).not.toMatch(/ace-web-pat-mint|ace-web-token-mint/);
  });
});

describe('machineLabel', () => {
  it('is stable per machine, so a re-mint can revoke its predecessors', () => {
    expect(machineLabel('Jonathans-MBP.localdomain')).toBe('ace-bot-jonathans-mbp');
    expect(machineLabel('Jonathans-MBP.localdomain')).toBe(machineLabel('Jonathans-MBP.localdomain'));
  });
});
