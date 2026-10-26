import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  acquireNovaLease,
  classifyNovaLease,
  novaLeasePath,
  NOVA_LEASE_TTL_MS,
  isClaudeComm,
  pidAlive,
  releaseNovaLease,
  tryAcquireNovaLease,
} from '../../lib/nova-account-lease';

const path = () => novaLeasePath('key-A', mkdtempSync(join(tmpdir(), 'novalease-')));

describe('nova account lease (ace#3301)', () => {
  it('classifies free / self / held / expired', () => {
    const l = { holder: 'a/1', acquired_at_ms: 1000 };
    expect(classifyNovaLease(null, 'b/2', 5000).verdict).toBe('free');
    expect(classifyNovaLease(l, 'a/1', 5000).verdict).toBe('self');
    expect(classifyNovaLease(l, 'b/2', 5000).verdict).toBe('held');
    expect(classifyNovaLease(l, 'b/2', 1000 + NOVA_LEASE_TTL_MS).verdict).toBe('expired');
  });

  it('a second build is refused with a reason, then gets in after release', () => {
    const p = path();
    expect(tryAcquireNovaLease(p, 'a/1').acquired).toBe(true);
    const second = tryAcquireNovaLease(p, 'b/2');
    expect(second.acquired).toBe(false);
    expect(second.detail).toMatch(/waiting/);
    expect(second.detail).toContain('a/1');
    expect(releaseNovaLease(p, 'b/2')).toBe(false); // not ours to release
    expect(releaseNovaLease(p, 'a/1')).toBe(true);
    expect(tryAcquireNovaLease(p, 'b/2').acquired).toBe(true);
  });

  it('takes over a pidless holder past the backstop TTL', () => {
    const p = path();
    tryAcquireNovaLease(p, 'a/1', 1000);
    expect(tryAcquireNovaLease(p, 'b/2', 1000 + NOVA_LEASE_TTL_MS).acquired).toBe(true);
  });

  // The T140 baseline builds ran 8-20h and the orchestrator cannot renew while
  // blocked in an architect Agent call: a live holder must keep the account.
  it('a live holder keeps the lease through a 20h build', () => {
    const p = path();
    const alive = () => true;
    tryAcquireNovaLease(p, 'a/1', 0, { holderPid: 4242, isAlive: alive });
    const r = tryAcquireNovaLease(p, 'b/2', 20 * 3_600_000, { holderPid: 5151, isAlive: alive });
    expect(r.acquired).toBe(false);
  });

  it('frees the lease as soon as the holding session exits', () => {
    const p = path();
    tryAcquireNovaLease(p, 'a/1', 0, { holderPid: 4242 });
    const r = tryAcquireNovaLease(p, 'b/2', 60_000, { holderPid: 5151, isAlive: (pid) => pid !== 4242 });
    expect(r.acquired).toBe(true);
    expect(r.detail).toMatch(/pid 4242\) has exited/);
  });

  it('isClaudeComm: macOS `claude` and the Linux runners\' `claude.exe`, nothing else', () => {
    expect(isClaudeComm('claude')).toBe(true);
    expect(isClaudeComm('/Users/x/.local/bin/claude')).toBe(true);
    expect(isClaudeComm('claude.exe')).toBe(true);
    expect(isClaudeComm('node')).toBe(false);
    expect(isClaudeComm('bash')).toBe(false);
    expect(isClaudeComm('claude-runner')).toBe(false);
  });

  it('pidAlive: this process is alive, an unused pid is not', () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(2 ** 22 - 3)).toBe(false);
  });

  it('acquire waits (does not fail), reports why, and succeeds on release', async () => {
    const p = path();
    tryAcquireNovaLease(p, 'a/1');
    const waits: string[] = [];
    let sleeps = 0;
    const r = await acquireNovaLease(p, 'b/2', {
      onWait: (d) => waits.push(d),
      sleep: async () => {
        if (++sleeps === 3) releaseNovaLease(p, 'a/1');
      },
    });
    expect(r.acquired).toBe(true);
    expect(sleeps).toBe(3);
    expect(waits.length).toBe(1);
    expect(waits[0]).toMatch(/holds this Nova account/);
  });

  it('keys by account: a different key does not contend', () => {
    const dir = mkdtempSync(join(tmpdir(), 'novalease-'));
    expect(tryAcquireNovaLease(novaLeasePath('key-A', dir), 'a/1').acquired).toBe(true);
    expect(tryAcquireNovaLease(novaLeasePath('key-B', dir), 'b/2').acquired).toBe(true);
  });
});
