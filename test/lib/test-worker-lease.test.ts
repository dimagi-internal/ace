// ace#2955 — exclusive checkout of Connect test workers against a fake
// canopy-web pool broker (the contract canopy-web is building; not yet live).
import { describe, it, expect, vi } from 'vitest';
import { TestWorkerCheckout, type TestWorkerCheckoutOpts } from '../../lib/test-worker-lease.js';
import { MobileError } from '../../mcp/mobile/errors.js';
import { FakeCanopyPool, legacyEnv, slotDataFor } from '../fixtures/fake-canopy-pool.js';

function make(pool: FakeCanopyPool, opts: TestWorkerCheckoutOpts = {}) {
  let clock = 0;
  const warn = vi.fn();
  const sync = vi.fn();
  const co = new TestWorkerCheckout({
    baseUrl: 'https://canopy.test',
    token: 'pat',
    fetchImpl: pool.fetch,
    env: legacyEnv(),
    pollIntervalMs: 1_000,
    waitMs: 60_000,
    now: () => clock,
    sleepImpl: async (ms) => {
      clock += ms;
    },
    warn,
    syncReleaseImpl: sync,
    backgroundHeartbeat: false,
    retry: { retries: 0, sleepImpl: async () => {} },
    ...opts,
  });
  return { co, warn, sync, tick: (ms: number) => (clock += ms) };
}

async function rejection(p: Promise<unknown>): Promise<MobileError> {
  try {
    await p;
  } catch (e) {
    return e as MobileError;
  }
  throw new Error('expected a rejection');
}

describe('TestWorkerCheckout — the lock', () => {
  it('checks out one free worker and takes its credentials from the lease slot_data', async () => {
    const pool = new FakeCanopyPool();
    const { co } = make(pool);
    const held = await co.ensure(1);
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ slot: 'worker-1', mode: 'locked', leaseId: 'L1' });
    // From canopy-web's slot data — not the legacy ACE_E2E_* worker in env.
    const d = slotDataFor('worker-1');
    expect(held[0].worker).toEqual({ slot: 'worker-1', ...d.public, ...d.secret });
    expect(held[0].worker.pin).not.toBe(legacyEnv().ACE_E2E_PIN);
    expect(co.mode).toBe('locked');
    expect(pool.calls[0]).toBe('POST /api/capabilities/leases');
  });

  it('ensure is idempotent: already holding enough acquires nothing', async () => {
    const pool = new FakeCanopyPool();
    const { co } = make(pool);
    await co.ensure(2);
    const before = pool.calls.length;
    await co.ensure(1);
    await co.ensure(2);
    expect(pool.calls.length).toBe(before);
  });

  it('k workers are k distinct slots, counting the one already held', async () => {
    const pool = new FakeCanopyPool();
    const { co } = make(pool);
    await co.ensure(1);
    const held = await co.ensure(4);
    expect(held.map((h) => h.slot)).toEqual(['worker-1', 'worker-2', 'worker-3', 'worker-4']);
    expect(new Set(held.map((h) => h.worker.phone)).size).toBe(4);
  });

  it('skips a slot held elsewhere', async () => {
    const pool = new FakeCanopyPool();
    pool.holdElsewhere('worker-1');
    const { co } = make(pool);
    expect((await co.ensure(1))[0].slot).toBe('worker-2');
  });

  it('waits in the queue and proceeds when a slot frees', async () => {
    const pool = new FakeCanopyPool(['worker-1']);
    pool.holdElsewhere('worker-1');
    const { co } = make(pool, {
      sleepImpl: async () => {
        pool.releaseElsewhere('worker-1');
      },
    });
    const held = await co.ensure(1);
    expect(held[0].slot).toBe('worker-1');
  });

  it('times out loud naming the holders, and releases its own queued leases', async () => {
    const pool = new FakeCanopyPool(['worker-1', 'worker-2']);
    pool.holdElsewhere('worker-1', 'session=laptop-a');
    pool.holdElsewhere('worker-2', 'turn_id=t-42');
    const { co } = make(pool);
    const e = await rejection(co.ensure(1));
    expect(e.code).toBe('TEST_WORKER_POOL_EXHAUSTED');
    expect(e.message).toContain('worker-1: lease ext-worker-1 (holder=session=laptop-a)');
    expect(e.message).toContain('worker-2: lease ext-worker-2 (holder=turn_id=t-42)');
    expect(e.remediation).toMatch(/Never share a worker/);
    expect(pool.leases.get('L1')!.status).toBe('released');
    expect(co.heldWorkers()).toEqual([]);
  });

  it('a partial multi-checkout that times out keeps nothing it got in this call', async () => {
    const pool = new FakeCanopyPool(['worker-1', 'worker-2']);
    pool.holdElsewhere('worker-2');
    const { co } = make(pool);
    const e = await rejection(co.ensure(2));
    expect(e.code).toBe('TEST_WORKER_POOL_EXHAUSTED');
    expect(pool.heldSlots()).toEqual(['worker-2']); // only the external holder
    expect(co.heldWorkers()).toEqual([]);
  });

  it('a slot with no data on canopy-web fails TEST_WORKER_NO_CREDENTIALS and releases the lease', async () => {
    const pool = new FakeCanopyPool(['worker-9']);
    pool.slotData.delete('worker-9');
    const { co } = make(pool);
    const e = await rejection(co.ensure(1));
    expect(e.code).toBe('TEST_WORKER_NO_CREDENTIALS');
    expect(e.message).toContain('worker-9');
    expect(e.remediation).toContain('scripts/test-worker-set.ts --slot worker-9');
    expect(pool.leases.get('L1')!.status).toBe('released');
    expect(co.heldWorkers()).toEqual([]);
  });

  it('a slot missing a required key names the slot and the keys, and releases', async () => {
    const pool = new FakeCanopyPool(['worker-2']);
    delete (pool.slotData.get('worker-2')!.secret as Record<string, string>).backupCode;
    const { co } = make(pool);
    const e = await rejection(co.ensure(1));
    expect(e.code).toBe('TEST_WORKER_NO_CREDENTIALS');
    expect(e.message).toMatch(/worker-2.*secret\.backupCode/);
    expect(pool.heldSlots()).toEqual([]);
  });

  it('a multi-checkout where one slot lacks data keeps none of the slots it took', async () => {
    const pool = new FakeCanopyPool(['worker-1', 'worker-2', 'worker-3']);
    pool.slotData.get('worker-3')!.public = {};
    const { co } = make(pool);
    expect((await rejection(co.ensure(3))).code).toBe('TEST_WORKER_NO_CREDENTIALS');
    expect(pool.heldSlots()).toEqual([]);
  });

  it('an acquire answer without slot_data is completed by the holder GET', async () => {
    const pool = new FakeCanopyPool(['worker-2']);
    pool.slotDataOnAcquire = false;
    const { co } = make(pool);
    const held = await co.ensure(1);
    expect(held[0].worker.backupCode).toBe(slotDataFor('worker-2').secret.backupCode);
    expect(pool.calls).toEqual(['POST /api/capabilities/leases', 'GET /api/capabilities/leases/L1']);
  });

  it('secrets never reach a log line, a warning, an error, or the status report', async () => {
    const pool = new FakeCanopyPool(['worker-1', 'worker-2']);
    const bad = pool.slotData.get('worker-2')!;
    bad.public.phoneLocal = '4260000999'; // invalid → throws after the secrets are in hand
    const secrets = [...pool.slotData.values()].flatMap((d) => Object.values(d.secret));
    const out: string[] = [];
    const w = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    }) as never);
    try {
      const { co, warn } = make(pool);
      await co.ensure(1);
      out.push(JSON.stringify(co.status()));
      const e = await rejection(co.ensure(2));
      out.push(e.message, e.remediation ?? '', JSON.stringify(e.diagnostics ?? {}));
      out.push(...warn.mock.calls.map((c) => String(c[0])));
      out.push((await co.slotDataReport())!.summary);
    } finally {
      w.mockRestore();
    }
    const all = out.join('\n');
    expect(all).toContain('worker-1'); // the capture did see output
    for (const sec of secrets) expect(all).not.toContain(sec);
  });

  it('slotDataReport reads the MASKED list and names slots that lack data', async () => {
    const pool = new FakeCanopyPool(['worker-1', 'worker-2', 'worker-3']);
    pool.slotData.delete('worker-2');
    delete (pool.slotData.get('worker-3')!.secret as Record<string, string>).pin;
    const { co } = make(pool);
    const r = (await co.slotDataReport())!;
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('worker-2: no data');
    expect(r.summary).toContain('worker-3: lacks secret.pin');
    expect(pool.calls).toEqual(['GET /api/agents/ace/capabilities/test-worker/slots']);
  });

  it('release DELETEs the leases and frees the slots', async () => {
    const pool = new FakeCanopyPool();
    const { co } = make(pool);
    await co.ensure(3);
    expect(await co.release(['worker-2'])).toEqual(['worker-2']);
    expect(pool.heldSlots().sort()).toEqual(['worker-1', 'worker-3']);
    expect(await co.release()).toEqual(['worker-1', 'worker-3']);
    expect(pool.heldSlots()).toEqual([]);
  });

  it('a heartbeat that finds the lease gone drops it and warns', async () => {
    const pool = new FakeCanopyPool();
    const { co, warn } = make(pool);
    await co.ensure(2);
    pool.leases.get('L1')!.status = 'expired';
    expect(await co.heartbeatNow()).toEqual(['worker-1']);
    expect(co.heldWorkers().map((h) => h.slot)).toEqual(['worker-2']);
    expect(warn.mock.calls[0][0]).toMatch(/worker-1 .* no longer holds the worker/);
  });

  it('a heartbeat GETs every held lease (that is what resets the idle clock)', async () => {
    const pool = new FakeCanopyPool();
    const { co } = make(pool);
    await co.ensure(2);
    pool.calls.length = 0;
    await co.heartbeatNow();
    expect(pool.calls).toEqual(['GET /api/capabilities/leases/L1', 'GET /api/capabilities/leases/L2']);
  });

  it('the exit hook releases every held lease synchronously', async () => {
    const pool = new FakeCanopyPool();
    const listeners: Array<() => void> = [];
    const once = vi.spyOn(process, 'once').mockImplementation(((ev: string, fn: () => void) => {
      if (ev === 'exit') listeners.push(fn);
      return process;
    }) as never);
    try {
      const { co, sync } = make(pool);
      await co.ensure(2);
      expect(listeners).toHaveLength(1);
      listeners[0]();
      expect(sync.mock.calls.map((c) => c[0])).toEqual([
        'https://canopy.test/api/capabilities/leases/L1',
        'https://canopy.test/api/capabilities/leases/L2',
      ]);
      expect(sync.mock.calls[0][1]).toBe('pat');
    } finally {
      once.mockRestore();
    }
  });
});

describe('TestWorkerCheckout — rollout fallback (capability not live)', () => {
  it('422 undeclared: one worker proceeds UNLOCKED as worker-1, warning loudly with the issue and publish step', async () => {
    const pool = new FakeCanopyPool();
    pool.mode = 'undeclared';
    const { co, warn } = make(pool);
    const held = await co.ensure(1);
    expect(held).toEqual([expect.objectContaining({ slot: 'worker-1', leaseId: null, mode: 'unlocked-fallback' })]);
    expect(co.mode).toBe('unlocked-fallback');
    const msg = warn.mock.calls[0][0] as string;
    expect(msg).toContain('ace#2955');
    expect(msg).toContain('canopy-runtime publish-capabilities --spec runtime.yaml --agent ace');
    expect(msg).toContain('UNLOCKED');
    expect(co.status().warning).toContain('ace#2955');
  });

  it('403 ungranted falls back the same way', async () => {
    const pool = new FakeCanopyPool();
    pool.mode = 'ungranted';
    const { co } = make(pool);
    expect((await co.ensure(1))[0].mode).toBe('unlocked-fallback');
  });

  it('no canopy-web PAT falls back without any HTTP', async () => {
    const pool = new FakeCanopyPool();
    const { co, warn } = make(pool, { token: null });
    const held = await co.ensure(1);
    expect(held[0].slot).toBe('worker-1');
    // The fallback is the legacy ACE_E2E_* worker, exactly as before the pool.
    expect(held[0].worker).toMatchObject({ phone: '+74260000101', pin: '1234', backupCode: 'LEGACYBACKUP0001' });
    expect(await co.slotDataReport()).toBeNull();
    expect(pool.calls).toEqual([]);
    expect(warn.mock.calls[0][0]).toMatch(/no canopy-web PAT/);
  });

  it('a multi-worker checkout NEVER falls back to sharing', async () => {
    const pool = new FakeCanopyPool();
    pool.mode = 'undeclared';
    const { co } = make(pool);
    const e = await rejection(co.ensure(2));
    expect(e.code).toBe('TEST_WORKER_POOL_UNAVAILABLE');
    expect(e.remediation).toContain('canopy-runtime publish-capabilities');
    // …and not after a single-worker fallback either.
    await co.ensure(1);
    expect((await rejection(co.ensure(3))).code).toBe('TEST_WORKER_POOL_UNAVAILABLE');
  });

  it('any other broker failure is NOT a fallback — it fails loud', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ title: 'boom' }), { status: 500, headers: { 'content-type': 'application/json' } });
    const co = new TestWorkerCheckout({
      baseUrl: 'https://canopy.test',
      token: 'pat',
      fetchImpl,
      env: legacyEnv(),
      backgroundHeartbeat: false,
      retry: { retries: 0, sleepImpl: async () => {} },
    });
    expect((await rejection(co.ensure(1))).code).toBe('LEASE_HTTP_500');
  });
});
