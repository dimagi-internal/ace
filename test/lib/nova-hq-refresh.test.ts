import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  classifyGoogleChallenge,
  ensureNovaHqDomain,
  exitCodeFor,
  extractDomainNames,
} from '../../lib/nova-hq-refresh.js';

const ROOT = join(__dirname, '..', '..');

describe('ensureNovaHqDomain — missing → refresh once → recheck → halt only if still missing', () => {
  it('present: never opens the browser', async () => {
    const refresh = vi.fn();
    const r = await ensureNovaHqDomain({
      domain: 'connect-ace-spark',
      readDomains: async () => ['connect-ace-prod', 'connect-ace-spark'],
      refresh,
    });
    expect(r).toMatchObject({ ok: true, status: 'present', refreshed: false, before_count: 2 });
    expect(refresh).not.toHaveBeenCalled();
    expect(exitCodeFor(r.status)).toBe(0);
  });

  it('missing then present after one refresh: ok, no operator remediation', async () => {
    const reads = [['connect-ace-prod'], ['connect-ace-prod', 'connect-ace-spark']];
    const readDomains = vi.fn(async () => reads.shift()!);
    const refresh = vi.fn(async () => ({ ok: true, card_text: 'Connected to production' }));
    const r = await ensureNovaHqDomain({ domain: 'connect-ace-spark', readDomains, refresh });
    expect(r).toMatchObject({ ok: true, status: 'refreshed', refreshed: true, before_count: 1, after_count: 2 });
    expect(r.remediation).toBe('');
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(readDomains).toHaveBeenCalledTimes(2);
  });

  it('still missing after refresh: halts with the membership remediation, does not refresh again', async () => {
    const refresh = vi.fn(async () => ({ ok: true }));
    const r = await ensureNovaHqDomain({
      domain: 'connect-ace-spark',
      readDomains: async () => ['connect-ace-prod'],
      refresh,
    });
    expect(r).toMatchObject({ ok: false, status: 'still-missing', refreshed: true });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(r.remediation).toMatch(/add that user .* to "connect-ace-spark" on CommCare HQ/);
    expect(exitCodeFor(r.status)).toBe(3);
  });

  it('Google challenge: named halt telling the operator to press Refresh, no re-read', async () => {
    const readDomains = vi.fn(async () => ['connect-ace-prod']);
    const r = await ensureNovaHqDomain({
      domain: 'connect-ace-spark',
      readDomains,
      refresh: async () => ({ ok: false, stopped_reason: 'google-2fa', detail: '2-Step Verification' }),
    });
    expect(r).toMatchObject({ ok: false, status: 'refresh-blocked', stopped_reason: 'google-2fa' });
    expect(r.remediation).toMatch(/google-2fa/);
    expect(r.remediation).toMatch(/press Refresh on the CommCare HQ card/);
    expect(readDomains).toHaveBeenCalledTimes(1);
    expect(exitCodeFor(r.status)).toBe(2);
  });

  it('a failed Nova read is its own status, and never triggers a browser', async () => {
    const refresh = vi.fn();
    const r = await ensureNovaHqDomain({
      domain: 'x',
      readDomains: async () => {
        throw new Error('Nova tools/call → HTTP 401');
      },
      refresh,
    });
    expect(r.status).toBe('read-failed');
    expect(refresh).not.toHaveBeenCalled();
    expect(exitCodeFor(r.status)).toBe(1);
  });
});

describe('classifyGoogleChallenge names the screen', () => {
  it.each([
    ["Couldn't sign you in. This browser or app may not be secure.", 'google-browser-not-secure'],
    ['2-Step Verification. Check your phone', 'google-2fa'],
    ["Verify it's you. To help keep your account safe", 'google-verify-identity'],
    ['Wrong password. Try again', 'google-wrong-password'],
    ['Type the text you hear or see', 'google-captcha'],
    ['Something else entirely', 'google-unknown-challenge'],
  ])('%s → %s', (text, reason) => {
    expect(classifyGoogleChallenge(text)).toBe(reason);
  });
});

describe('extractDomainNames', () => {
  it('reads object and string entries', () => {
    expect(
      extractDomainNames({ configured: true, available_domains: [{ name: 'a', displayName: 'A' }, 'b', {}] }),
    ).toEqual(['a', 'b']);
    expect(extractDomainNames({ configured: false })).toEqual([]);
  });
});

describe('scripts/nova-refresh-hq-domains.ts contract (owner directive 2026-10-08)', () => {
  const src = readFileSync(join(ROOT, 'scripts', 'nova-refresh-hq-domains.ts'), 'utf8');

  it('is headless, hard-coded, with no way to turn it off', () => {
    const settings = [...src.matchAll(/headless:\s*([^,\s}]+)/g)].map((m) => m[1]);
    expect(settings.length).toBeGreaterThan(0);
    expect(settings.every((v) => v === 'true')).toBe(true);
    expect(src).not.toMatch(/--headed|--no-headless|HEADLESS\s*=|process\.env\.[A-Z_]*HEAD/);
  });

  it('reads Google credentials from 1Password at runtime, never from .env', () => {
    expect(src).toContain("'op://Agent-Ace/Ace - gmail/username'");
    expect(src).toContain("'op://Agent-Ace/Ace - gmail/password'");
    expect(src).not.toMatch(/process\.env\.[A-Z_]*(GOOGLE|GMAIL)[A-Z_]*/);
  });

  it('never prints the password', () => {
    expect(src).not.toMatch(/console\.(log|error)\([^)]*\bpass\b/);
  });
});
