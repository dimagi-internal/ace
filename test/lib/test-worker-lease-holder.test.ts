// ace#3033 — a test-worker lease must name who holds it.
//
// 2026-10-16: ~18 leases with turn_id null were each acquired, never called
// again and idle-released 900 s later, starving the pool; canopy-web's rows
// could not say which process took them (one PAT for all of ACE). These pin
// (1) the acquire body canopy-web accepts — a `params.holder` would 422 every
// checkout, which is why the identity travels as a header + a local ledger —
// (2) that header and ledger, (3) the synchronous signal-path release, and
// (4) one checkout per MCP process, never one per call.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import {
  HOLDER_HEADER,
  TestWorkerCheckout,
  holderHeader,
  leaseHolder,
  type TestWorkerCheckoutOpts,
} from '../../lib/test-worker-lease.js';
import { brokerRequest } from '../../mcp/mobile/backends/broker-http.js';
import { canopyToken } from '../../lib/ace-canopy-pat.js';
import { resolveRetry } from '../../mcp/mobile/backends/remote-io.js';
import { MobileError } from '../../mcp/mobile/errors.js';
import { FakeCanopyPool, legacyEnv } from '../fixtures/fake-canopy-pool.js';

const REPO = path.resolve(__dirname, '../..');

function make(pool: FakeCanopyPool, opts: TestWorkerCheckoutOpts = {}) {
  const ledger = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tw-ledger-')), 'leases.jsonl');
  const sync = vi.fn();
  const co = new TestWorkerCheckout({
    baseUrl: 'https://canopy.test',
    token: 'pat',
    fetchImpl: pool.fetch,
    env: { ...legacyEnv(), CLAUDE_CODE_SESSION_ID: 'sess-abc' },
    pollIntervalMs: 1_000,
    waitMs: 60_000,
    sleepImpl: async () => {},
    warn: vi.fn(),
    syncReleaseImpl: sync,
    backgroundHeartbeat: false,
    releaseOnExit: false,
    retry: { retries: 0, sleepImpl: async () => {} },
    ledgerPath: ledger,
    ...opts,
  });
  const lines = () =>
    fs.existsSync(ledger)
      ? fs.readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : [];
  return { co, sync, lines, ledger };
}

describe('the acquire body canopy-web accepts', () => {
  it('is exactly {agent, capability} (+ turn_id) — no params a pool would refuse', async () => {
    const pool = new FakeCanopyPool();
    await make(pool).co.ensure(1);
    expect(pool.acquires).toEqual([{ agent: 'ace', capability: 'test-worker' }]);

    const pool2 = new FakeCanopyPool();
    await make(pool2, { env: { ...legacyEnv(), CANOPY_TURN_ID: 't-1' } }).co.ensure(1);
    expect(pool2.acquires).toEqual([{ agent: 'ace', capability: 'test-worker', turn_id: 't-1' }]);
  });

  it('control: a params.holder acquire is refused 422 (why the holder is NOT a param)', async () => {
    const pool = new FakeCanopyPool();
    const cfg = {
      baseUrl: 'https://canopy.test',
      token: 'pat',
      fetchImpl: pool.fetch,
      requestTimeoutMs: 5_000,
      retry: resolveRetry({ retries: 0, sleepImpl: async () => {} }),
      capability: 'test-worker',
    };
    const err = await brokerRequest(cfg, 'POST', '/api/capabilities/leases', {
      agent: 'ace',
      capability: 'test-worker',
      params: { holder: { pid: 1 } },
    }, { retry: false }).catch((e) => e);
    expect(err).toBeInstanceOf(MobileError);
    expect((err as MobileError).code).toBe('LEASE_INVALID_REQUEST');
    expect((err as MobileError).message).toMatch(/takes only 'slot'/);
  });
});

describe('the holder identity', () => {
  it('names host, pid, ppid, Claude session, turn and caller', () => {
    const h = leaseHolder({ CLAUDE_CODE_SESSION_ID: 's1', CANOPY_TURN_ID: 't1' });
    expect(h).toMatchObject({ host: os.hostname(), pid: process.pid, ppid: process.ppid, session_id: 's1', turn_id: 't1' });
    expect(h.caller).toBeTruthy();
    expect(holderHeader(h)).toMatch(new RegExp(`^host=\\S+ pid=${process.pid} ppid=${process.ppid} session=s1 turn=t1 caller=\\S+`));
    expect(holderHeader({ ...h, host: 'héllo\nx' })).not.toMatch(/[^\x20-\x7e]/);
  });

  it(`rides on EVERY broker call as ${HOLDER_HEADER}`, async () => {
    const pool = new FakeCanopyPool();
    const { co } = make(pool);
    await co.ensure(2);
    await co.heartbeatNow();
    await co.release();
    expect(pool.holderHeaders.length).toBeGreaterThan(4);
    for (const v of pool.holderHeaders) {
      expect(v).toContain(`pid=${process.pid}`);
      expect(v).toContain('session=sess-abc');
    }
  });
});

describe('the local lease ledger', () => {
  it('records acquire → held → release per lease, each with the holder', async () => {
    const pool = new FakeCanopyPool();
    const { co, lines } = make(pool);
    await co.ensure(1);
    await co.release();
    const l = lines();
    expect(l.map((x) => [x.event, x.lease_id])).toEqual([
      ['acquire', 'L1'],
      ['held', 'L1'],
      ['release', 'L1'],
    ]);
    for (const x of l) expect(x.holder).toMatchObject({ pid: process.pid, session_id: 'sess-abc' });
    expect(l[1].slot).toBe('worker-1');
    // Never a secret on disk.
    expect(JSON.stringify(l)).not.toMatch(/SECRETBACKUP|9001/);
  });

  it('an acquire with no release line is what a hard-killed holder leaves (the leak signature)', async () => {
    const pool = new FakeCanopyPool();
    const { co, lines } = make(pool);
    await co.ensure(1);
    expect(lines().map((x) => x.event)).toEqual(['acquire', 'held']);
  });

  it('a cleanup DELETE that fails after a failed checkout is ledgered, not swallowed', async () => {
    const pool = new FakeCanopyPool();
    pool.slotData.delete('worker-1'); // → TEST_WORKER_NO_CREDENTIALS → cleanup DELETE
    const base = pool.fetch;
    pool.fetch = async (input, init) =>
      (init?.method ?? 'GET').toUpperCase() === 'DELETE'
        ? new Response(JSON.stringify({ title: 'boom' }), { status: 500, headers: { 'content-type': 'application/json' } })
        : base(input, init);
    const { co, lines } = make(pool);
    await expect(co.ensure(1)).rejects.toMatchObject({ code: 'TEST_WORKER_NO_CREDENTIALS' });
    expect(lines().map((x) => x.event)).toEqual(['acquire', 'release-failed']);
  });

  it('ledger failures never fail a checkout', async () => {
    const pool = new FakeCanopyPool();
    const { co } = make(pool, { ledgerPath: '/dev/null/not-a-dir/leases.jsonl' });
    expect(await co.ensure(1)).toHaveLength(1);
  });
});

describe('releaseHeldSync — the signal-path release', () => {
  it('DELETEs every held lease synchronously, forgets them, and is idempotent', async () => {
    const pool = new FakeCanopyPool();
    const { co, sync, lines } = make(pool);
    await co.ensure(2);
    expect(co.releaseHeldSync('SIGTERM')).toEqual(['worker-1', 'worker-2']);
    expect(sync.mock.calls.map((c) => c[0])).toEqual([
      'https://canopy.test/api/capabilities/leases/L1',
      'https://canopy.test/api/capabilities/leases/L2',
    ]);
    expect(co.heldWorkers()).toEqual([]);
    expect(co.releaseHeldSync('exit')).toEqual([]);
    expect(sync).toHaveBeenCalledTimes(2);
    expect(lines().filter((x) => x.event === 'exit-release').map((x) => x.why)).toEqual(['SIGTERM', 'SIGTERM']);
  });

  it('mobile-server calls it FIRST in its signal handler, before the async daemon cleanup', () => {
    const src = fs.readFileSync(path.join(REPO, 'mcp/mobile-server.ts'), 'utf8');
    const handler = src.slice(src.indexOf("for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']"));
    const sync = handler.indexOf('releaseHeldSync(');
    const asyncCleanup = handler.indexOf('void release()');
    expect(sync).toBeGreaterThan(0);
    expect(sync).toBeLessThan(asyncCleanup);
  });
});

describe('the test suite never takes a real lease', () => {
  it('no canopy-web PAT is visible to tests (setup/isolate-ace-home-state.ts)', () => {
    expect(canopyToken()).toBeNull();
    expect(process.env.ACE_ENV_FILE).toContain('no-ace.env');
  });

  it('a default-built checkout under test falls back with zero HTTP', async () => {
    const fetchImpl = vi.fn();
    const co = new TestWorkerCheckout({ fetchImpl: fetchImpl as never, env: legacyEnv(), warn: vi.fn(), releaseOnExit: false });
    expect((await co.ensure(1))[0].mode).toBe('unlocked-fallback');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('one checkout per MCP process, never one per call', () => {
  // A checkout built per tool call would acquire a fresh lease every call and
  // drop the old one unreleased — the one-call-then-silence shape of ace#3033.
  function sources(dir: string): string[] {
    const out: string[] = [];
    for (const e of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'node_modules') out.push(...sources(rel));
      } else if (/\.(ts|mjs|js)$/.test(e.name) && !e.name.endsWith('.test.ts')) out.push(rel);
    }
    return out;
  }
  const files = ['lib', 'mcp', 'scripts', 'bin'].filter((d) => fs.existsSync(path.join(REPO, d))).flatMap(sources);
  // Code only: a comment that mentions `new MobileClient()` is not a construction.
  const code = (f: string) =>
    fs.readFileSync(path.join(REPO, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const hits = (re: RegExp) => files.filter((f) => re.test(code(f)));

  it('only MobileClient constructs a TestWorkerCheckout, once, in its constructor', () => {
    expect(hits(/new TestWorkerCheckout\(/)).toEqual(['mcp/mobile/client.ts']);
    const src = code('mcp/mobile/client.ts');
    expect(src.match(/new TestWorkerCheckout\(/g)).toHaveLength(1);
    // `readonly` → tsc only lets the constructor assign it: one per client.
    expect(src).toMatch(/^  readonly workers: TestWorkerCheckout \| null;$/m);
  });

  it('only mobile-server constructs a MobileClient, once, at module scope', () => {
    expect(hits(/new MobileClient\(/)).toEqual(['mcp/mobile-server.ts']);
    const src = code('mcp/mobile-server.ts');
    expect(src.match(/new MobileClient\(/g)).toHaveLength(1);
    expect(src).toMatch(/^let client: MobileClient;$/m);
  });
});
