// LeaseBackend against a fake canopy-web broker (mocked fetch). Covers the
// lease lifecycle (acquire → queued → provisioning → ready → release), reuse,
// state ↔ selector-map parity, the typed failure codes, every CLI op's argv,
// recipe chunking + per-chunk timeouts, exec-POST single-shot, the 404 grace,
// long-poll vs short-poll fallback, poll backoff timing, network-outage
// tolerance, idle loss + recovery, and the on-disk artifact layout.
//
// The fake broker hands out PER-INSTANCE S3 prefixes
// (`leases/<id>/<instance>/out/`), so any test that passes is a test that the
// client used the URIs the broker returned and never built a path itself.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LEASE_RESTORE_HINT, LeaseBackend } from '../../../../mcp/mobile/backends/lease.js';
import { MobileError, AvdBootError } from '../../../../mcp/mobile/errors.js';
import { ENVIRONMENT_BASELINE_FINGERPRINT } from '../../../../mcp/mobile/environment-baseline.js';

const BASE = 'https://canopy.test';
const TOKEN = 'ace-canopy-pat';
const BUCKET = 'cap-bucket';
const INSTANCE = 'i-0abc';

type Json = Record<string, unknown>;
interface Call {
  method: string;
  url: string;
  path: string;
  query: Record<string, string>;
  body?: unknown;
  auth?: string | null;
  at: number;
}

function json(status: number, body: unknown): Response {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A fake clock: `sleep` advances it, and the broker can advance it to simulate a held GET. */
class Clock {
  t = 1_000_000;
  sleeps: number[] = [];
  now = () => this.t;
  sleep = async (ms: number) => {
    this.sleeps.push(ms);
    this.t += ms;
  };
}

/** Per-instance S3 layout, as the broker states it. */
const outPrefix = (id: string) => `s3://${BUCKET}/leases/${id}/${INSTANCE}/out/`;
const inUri = (id: string, n: string) => `s3://${BUCKET}/leases/${id}/${INSTANCE}/in/${n}`;

/**
 * A scriptable fake broker. `leaseStates` is the sequence of lease statuses
 * successive GETs return (the last one repeats). `cli` maps a subcommand to
 * the JSON line the in-VM CLI prints; `execPlan` to the non-terminal statuses
 * (or `404`) successive status GETs return before the terminal one.
 */
class FakeBroker {
  calls: Call[] = [];
  clock = new Clock();
  leaseStates: Json[] = [{ status: 'ready' }];
  acquireResponse: { status: number; body: unknown } | null = null;
  onAcquire: (() => void) | null = null;
  cli: Record<string, Json | ((argv: string[]) => Json)> = {};
  execPlan: Record<string, Array<string | 404>> = {};
  /** Simulate the broker holding a long-poll GET (advances the clock by min(wait_s, holdS)). */
  honorWait = false;
  holdS = 20;
  /** Respond to the exec POST with this instead of an exec id. */
  execPost: ((n: number) => Response | Promise<Response>) | null = null;
  states = ['cc-2.62.0', 'cc-2.63.0', 'cc-2.64.0'];
  /** The S3 layout the broker states (override for the dimagi-canopy v0.9.0 shape). */
  prefixFor: (id: string) => string = outPrefix;
  inFor: (id: string, n: string) => string = inUri;
  readyInfo: Json = { ok: true, cli_version: '1.1.0' };
  artifactKeys: Record<string, Array<{ key: string }>> = {};
  objectsByKey = new Map<string, Buffer>();
  puts = new Map<string, Buffer>();
  released: string[] = [];
  private leaseSeq = 0;
  private getCount = 0;
  private execSeq = 0;
  execs = new Map<string, { argv: string[]; polls: number; sub: string }>();
  posts = 0;

  currentLeaseStatus(): string {
    return String(this.leaseStates[Math.min(Math.max(this.getCount - 1, 0), this.leaseStates.length - 1)].status);
  }

  fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const u = new URL(url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    let body: unknown;
    if (typeof init?.body === 'string') body = JSON.parse(init.body);
    else if (init?.body) body = init.body;
    this.calls.push({
      method, url, path: u.pathname, query: Object.fromEntries(u.searchParams), body,
      auth: headers.get('authorization'), at: this.clock.t,
    });

    // Presigned S3 traffic.
    if (u.host === 's3.test') {
      if (method === 'PUT') {
        this.puts.set(u.pathname, Buffer.from(init!.body as Uint8Array));
        return new Response('', { status: 200 });
      }
      const rest = u.pathname.replace(/^\/out\//, '');
      const bytes = this.objectsByKey.get(rest);
      return bytes ? new Response(new Uint8Array(bytes), { status: 200 }) : new Response('missing', { status: 404 });
    }

    const p = u.pathname;
    const wait = Number(u.searchParams.get('wait_s') ?? 0);
    if (method === 'POST' && p === '/api/capabilities/leases') {
      if (this.acquireResponse) return json(this.acquireResponse.status, this.acquireResponse.body);
      const id = `lease-${++this.leaseSeq}`;
      this.getCount = 0;
      this.onAcquire?.();
      return json(200, {
        lease_id: id, status: 'provisioning', ready: false, position: null, reason: '', ready_info: {},
        out_prefix: this.prefixFor(id), idle_release_s: 900, expires_at: '2026-10-14T20:00:00Z',
      });
    }
    let m = p.match(/^\/api\/capabilities\/leases\/([^/]+)$/);
    if (m && method === 'GET') {
      const st = this.leaseStates[Math.min(this.getCount++, this.leaseStates.length - 1)];
      if (st.status === 404) return json(404, { title: 'not found', status: 404 });
      if (this.honorWait && wait && st.status !== 'ready') this.clock.t += Math.min(wait, this.holdS) * 1000;
      // canopy-web CapabilityLeaseOut: `ready` is a bool, ready.json is `ready_info`.
      return json(200, {
        lease_id: m[1], instance_id: INSTANCE, expires_at: '2026-10-14T20:00:00Z', position: null,
        reason: '', idle_release_s: 900, out_prefix: this.prefixFor(m[1]),
        ready_info: st.status === 'ready' ? this.readyInfo : {},
        ...st, ready: st.status === 'ready',
      });
    }
    if (m && method === 'DELETE') {
      this.released.push(m[1]);
      return json(200, { lease_id: m[1], status: 'released' });
    }
    m = p.match(/^\/api\/capabilities\/leases\/([^/]+)\/uploads$/);
    if (m && method === 'POST') {
      const names = (body as { names: string[] }).names;
      return json(200, {
        lease_id: m[1],
        expires_in_s: 3600,
        uploads: names.map((n) => ({ name: n, put_url: `https://s3.test/in/${n}`, s3_uri: this.inFor(m![1], n) })),
      });
    }
    m = p.match(/^\/api\/capabilities\/leases\/([^/]+)\/exec$/);
    if (m && method === 'POST') {
      this.posts++;
      if (this.execPost) return this.execPost(this.posts);
      if (this.currentLeaseStatus() !== 'ready') {
        const t = `lease ${m[1]} is ${this.currentLeaseStatus()}; exec needs a ready lease`;
        return json(409, { title: t, detail: t, status: 409 });
      }
      const id = `cmd-${++this.execSeq}`;
      const argv = (body as { argv: string[] }).argv;
      this.execs.set(id, { argv, polls: 0, sub: argv[1] });
      return json(200, { lease_id: m[1], exec_id: id, timeout_s: (body as { timeout_s: number }).timeout_s });
    }
    m = p.match(/^\/api\/capabilities\/leases\/([^/]+)\/exec\/([^/]+)$/);
    if (m && method === 'GET') {
      const ex = this.execs.get(m[2])!;
      const plan = this.execPlan[ex.sub] ?? [];
      const step = plan[ex.polls++];
      if (step === 404) return json(404, { title: `no exec ${m[2]} on lease ${m[1]}`, status: 404 });
      if (typeof step === 'string') {
        if (this.honorWait && wait) this.clock.t += Math.min(wait, this.holdS) * 1000;
        return json(200, { exec_id: m[2], status: step, done: false, exit_code: null, stdout_tail: '', stderr_tail: '' });
      }
      const spec = this.cli[ex.sub];
      const line = typeof spec === 'function' ? spec(ex.argv) : (spec ?? { ok: true });
      return json(200, {
        exec_id: m[2],
        status: line.ok === false ? 'Failed' : 'Success',
        done: true,
        exit_code: line.ok === false ? 1 : 0,
        stdout_tail: JSON.stringify(line) + '\n',
        stderr_tail: '',
        stdout_url: null,
        stderr_url: null,
      });
    }
    m = p.match(/^\/api\/capabilities\/leases\/([^/]+)\/artifacts$/);
    if (m && method === 'GET') {
      const prefix = u.searchParams.get('prefix') ?? '';
      const sub = prefix.replace(/-[a-z0-9]+\/$/, '');
      const rows = (this.artifactKeys[sub] ?? []).map((a) => {
        // canopy-web CapabilityArtifactOut: `path` is relative to the out prefix; no content type.
        this.objectsByKey.set(`${prefix}${a.key}`, this.objectsByKey.get(`${sub}|${a.key}`) ?? Buffer.from(''));
        return { path: `${prefix}${a.key}`, size: 1, url: `https://s3.test/out/${prefix}${a.key}` };
      });
      return json(200, { lease_id: m[1], prefix, artifacts: rows, expires_in_s: 3600 });
    }
    if (method === 'GET' && p === '/api/agents/ace/capabilities') {
      return json(200, {
        capabilities: [
          {
            name: 'android-emulator',
            manifest: {
              name: 'android-emulator',
              limits: { ready_timeout_s: 900, max_concurrent: 4 },
              params: { state: { type: 'string', default: this.states[0], enum: this.states } },
            },
            grant: { max_concurrent: 2 },
            live_leases: [{ lease_id: 'x' }],
          },
        ],
      });
    }
    return json(404, { title: 'Not found', status: 404 });
  };

  execArgv(sub: string): string[] {
    const argvs = [...this.execs.values()].filter((a) => a.sub === sub).map((a) => a.argv);
    return argvs[argvs.length - 1];
  }
  allExecArgv(sub: string): string[][] {
    return [...this.execs.values()].filter((a) => a.sub === sub).map((a) => a.argv);
  }
  execBodies(): Array<{ argv: string[]; timeout_s: number }> {
    return this.calls.filter((c) => c.method === 'POST' && /\/exec$/.test(c.path)).map((c) => c.body as never);
  }
  callsTo(method: string, re: RegExp): Call[] {
    return this.calls.filter((c) => c.method === method && re.test(c.path));
  }
  /** Serve an object at the presigned URL the artifacts route will hand out for `<sub>-<slug>/key`. */
  putArtifact(sub: string, key: string, bytes: Buffer) {
    (this.artifactKeys[sub] ??= []).push({ key });
    this.objectsByKey.set(`${sub}|${key}`, bytes);
  }
}

function backend(b: FakeBroker, extra: Partial<ConstructorParameters<typeof LeaseBackend>[0]> = {}) {
  return new LeaseBackend({
    baseUrl: BASE,
    token: TOKEN,
    fetchImpl: b.fetch,
    apkVersion: () => '',
    pollIntervalMs: 0,
    longPollS: 0,
    pollOutageMs: 0,
    retry: { retries: 0 },
    releaseOnExit: false,
    sleepImpl: b.clock.sleep,
    now: b.clock.now,
    ...extra,
  });
}

let tmp: string;
const savedTurn = process.env.CANOPY_TURN_ID;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-test-'));
  delete process.env.CANOPY_TURN_ID;
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (savedTurn === undefined) delete process.env.CANOPY_TURN_ID;
  else process.env.CANOPY_TURN_ID = savedTurn;
});

describe('LeaseBackend construction', () => {
  it('throws LEASE_NOT_CONFIGURED with no PAT', () => {
    const saved = process.env.ACE_ENV_FILE;
    process.env.ACE_ENV_FILE = path.join(tmp, 'absent.env');
    try {
      expect(() => new LeaseBackend({ baseUrl: BASE })).toThrow(
        expect.objectContaining({ code: 'LEASE_NOT_CONFIGURED' }),
      );
    } finally {
      if (saved === undefined) delete process.env.ACE_ENV_FILE;
      else process.env.ACE_ENV_FILE = saved;
    }
  });

  it("reads ACE's own PAT from ACE's .env, not an inherited CANOPY_WEB_PAT", async () => {
    const env = path.join(tmp, 'ace.env');
    fs.writeFileSync(env, 'CANOPY_WEB_PAT=from-ace-env\n');
    const saved = { f: process.env.ACE_ENV_FILE, p: process.env.CANOPY_WEB_PAT };
    process.env.ACE_ENV_FILE = env;
    process.env.CANOPY_WEB_PAT = 'inherited-human';
    try {
      const b = new FakeBroker();
      const lb = new LeaseBackend({
        baseUrl: BASE, fetchImpl: b.fetch, apkVersion: () => '', pollIntervalMs: 0, releaseOnExit: false,
        sleepImpl: async () => {},
      });
      await lb.ensureAvdRunning('cc-2.63.0');
      expect(b.calls[0].auth).toBe('Bearer from-ace-env');
    } finally {
      if (saved.f === undefined) delete process.env.ACE_ENV_FILE;
      else process.env.ACE_ENV_FILE = saved.f;
      if (saved.p === undefined) delete process.env.CANOPY_WEB_PAT;
      else process.env.CANOPY_WEB_PAT = saved.p;
    }
  });
});

describe('LeaseBackend lifecycle', () => {
  it('acquires with agent/capability/params/turn_id, polls to ready, reports timings', async () => {
    process.env.CANOPY_TURN_ID = 'turn-42';
    const b = new FakeBroker();
    b.readyInfo = { ok: true, timings: { emulator_boot_s: 70 }, accel: 'kvm', cli_version: '1.0.0' };
    b.leaseStates = [{ status: 'provisioning' }, { status: 'provisioning' }, { status: 'ready' }];
    const lb = backend(b);
    const info = await lb.ensureAvdRunning('cc-2.62.0');

    const acquire = b.callsTo('POST', /^\/api\/capabilities\/leases$/)[0];
    expect(acquire.body).toEqual({
      agent: 'ace',
      capability: 'android-emulator',
      params: { state: 'cc-2.62.0' },
      turn_id: 'turn-42',
    });
    expect(acquire.auth).toBe(`Bearer ${TOKEN}`);
    expect(info.status).toBe('booted');
    expect(info.serial).toBe(`lease:${INSTANCE}`);
    expect(info.name).toBe('cc-2.62.0');
    expect(info.accel).toBe('kvm');
    expect(info.timings).toMatchObject({ emulator_boot_s: 70, lease_queue_s: 0 });
    expect(lb.leaseId).toBe('lease-1');
  });

  it('the ensure result carries the lease facts a caller needs to keep the machine', async () => {
    const b = new FakeBroker();
    b.readyInfo = { ok: true, cli_version: '1.1.0', state: 'cc-2.63.0', baseline_fingerprint: ENVIRONMENT_BASELINE_FINGERPRINT };
    const info = await backend(b).ensureAvdRunning('cc-2.63.0');
    expect(info.lease).toEqual({
      lease_id: 'lease-1',
      instance_id: INSTANCE,
      expires_at: '2026-10-14T20:00:00Z',
      idle_release_s: 900,
      state: 'cc-2.63.0',
      selector_map_version: null,
      reused: false,
      cli_version: '1.1.0',
      image_baseline_fingerprint: ENVIRONMENT_BASELINE_FINGERPRINT,
      expected_baseline_fingerprint: ENVIRONMENT_BASELINE_FINGERPRINT,
      baseline_parity: 'match',
      baseline_failed: [],
      boot_path: null,
      long_poll: 'unknown',
    });
  });

  it('baseline parity: a different fingerprint is mismatch, none is unreported', async () => {
    const b = new FakeBroker();
    b.readyInfo = { ok: true, baseline: { fingerprint: 'deadbeef0000' } };
    expect((await backend(b).ensureAvdRunning('cc-2.63.0')).lease?.baseline_parity).toBe('mismatch');
    const b2 = new FakeBroker();
    expect((await backend(b2).ensureAvdRunning('cc-2.63.0')).lease?.baseline_parity).toBe('unreported');
  });

  it('omits params when no selector-map version is configured (manifest default applies)', async () => {
    const b = new FakeBroker();
    await backend(b).ensureAvdRunning('ACE_Pixel_API_34');
    expect(b.callsTo('POST', /leases$/)[0].body).toEqual({ agent: 'ace', capability: 'android-emulator' });
  });

  it('reuses a live ready lease for the same state, and says so', async () => {
    const b = new FakeBroker();
    const lb = backend(b);
    await lb.ensureAvdRunning('cc-2.63.0');
    const again = await lb.ensureAvdRunning('cc-2.63.0');
    expect(b.callsTo('POST', /leases$/)).toHaveLength(1);
    expect(b.released).toEqual([]);
    expect(again.lease?.reused).toBe(true);
  });

  it('replaces the lease when the state changes (restore, never adapt)', async () => {
    const b = new FakeBroker();
    const lb = backend(b);
    await lb.ensureAvdRunning('cc-2.63.0');
    await lb.ensureAvdRunning('cc-2.62.0');
    expect(b.callsTo('POST', /leases$/)).toHaveLength(2);
    expect(b.released).toEqual(['lease-1']);
    expect(lb.leaseId).toBe('lease-2');
  });

  it('replaces a held lease that is no longer ready', async () => {
    const b = new FakeBroker();
    const lb = backend(b);
    await lb.ensureAvdRunning('cc-2.63.0');
    b.leaseStates = [{ status: 'expired' }];
    (b as unknown as { getCount: number }).getCount = 0;
    b.onAcquire = () => { b.leaseStates = [{ status: 'ready' }]; };
    await lb.ensureAvdRunning('cc-2.63.0');
    expect(b.released).toEqual(['lease-1']);
    expect(lb.leaseId).toBe('lease-2');
  });

  it('collapses concurrent ensure calls onto one acquire', async () => {
    const b = new FakeBroker();
    const lb = backend(b);
    await Promise.all([lb.ensureAvdRunning('cc-2.63.0'), lb.ensureAvdRunning('cc-2.63.0')]);
    expect(b.callsTo('POST', /leases$/)).toHaveLength(1);
  });

  it('stopAvd releases (DELETE) and forgets the lease; a second stop is a no-op', async () => {
    const b = new FakeBroker();
    const lb = backend(b);
    await lb.ensureAvdRunning('cc-2.63.0');
    await lb.stopAvd('x');
    await lb.stopAvd('x');
    expect(b.released).toEqual(['lease-1']);
    expect(lb.leaseId).toBeNull();
  });

  it('releases synchronously on process exit while a lease is held', async () => {
    const b = new FakeBroker();
    const released: string[] = [];
    const lb = backend(b, { releaseOnExit: true, syncReleaseImpl: (url, tok) => released.push(`${tok} ${url}`) });
    const before = process.listeners('exit').length;
    await lb.ensureAvdRunning('cc-2.63.0');
    const added = process.listeners('exit').slice(before);
    expect(added).toHaveLength(1);
    (added[0] as () => void)();
    process.removeListener('exit', added[0] as () => void);
    expect(released).toEqual([`${TOKEN} ${BASE}/api/capabilities/leases/lease-1`]);
  });
});

describe('LeaseBackend state ↔ selector-map parity', () => {
  it('a non-cc-* AVD name leases cc-<the configured selector-map version>', async () => {
    const b = new FakeBroker();
    const lb = backend(b, { apkVersion: () => '2.64.0' });
    expect(lb.resolveState('ACE_Pixel_API_34')).toBe('cc-2.64.0');
    const info = await lb.ensureAvdRunning('ACE_Pixel_API_34');
    expect(b.callsTo('POST', /leases$/)[0].body).toMatchObject({ params: { state: 'cc-2.64.0' } });
    expect(info.lease).toMatchObject({ state: 'cc-2.64.0', selector_map_version: '2.64.0' });
  });

  it('LEASE_STATE_UNAVAILABLE, naming the bake, when the manifest does not bake that state — and no machine is acquired', async () => {
    const b = new FakeBroker();
    b.states = ['cc-2.62.0', 'cc-2.63.0'];
    const err = await backend(b, { apkVersion: () => '2.64.0' }).ensureAvdRunning('ACE_Pixel_API_34').catch((e) => e);
    expect(err).toBeInstanceOf(MobileError);
    expect(err.code).toBe('LEASE_STATE_UNAVAILABLE');
    expect(err.message).toContain('cc-2.64.0');
    expect(err.message).toContain('cc-2.62.0, cc-2.63.0');
    expect(err.remediation).toContain('variables.pkr.hcl');
    expect(err.remediation).toContain('bake.sh');
    expect(b.callsTo('POST', /leases$/)).toHaveLength(0);
  });

  it('an explicit cc-* that differs from the selector map is refused before any acquire', async () => {
    const b = new FakeBroker();
    await expect(backend(b, { apkVersion: () => '2.64.0' }).ensureAvdRunning('cc-2.63.0')).rejects.toMatchObject({
      code: 'LEASE_STATE_SELECTOR_MISMATCH',
    });
    expect(b.callsTo('POST', /leases$/)).toHaveLength(0);
  });

  it('a machine that booted a different state than requested is released, never used', async () => {
    const b = new FakeBroker();
    b.readyInfo = { ok: true, state: 'cc-2.63.0' };
    const lb = backend(b, { apkVersion: () => '2.64.0' });
    await expect(lb.ensureAvdRunning('ACE_Pixel_API_34')).rejects.toMatchObject({ code: 'LEASE_STATE_MISMATCH' });
    expect(b.released).toEqual(['lease-1']);
    expect(lb.leaseId).toBeNull();
  });

  it('an unreadable manifest is not a refusal (the acquire itself would 422)', async () => {
    const b = new FakeBroker();
    const lb = backend(b, {
      apkVersion: () => '2.64.0',
      fetchImpl: async (input, init) =>
        new URL(String(input)).pathname === '/api/agents/ace/capabilities' ? json(500, { title: 'boom' }) : b.fetch(input, init),
    });
    await expect(lb.ensureAvdRunning('ACE_Pixel_API_34')).resolves.toMatchObject({ status: 'booted' });
  });
});

describe('LeaseBackend queueing and failure codes', () => {
  it('waits while queued, logging the position, then proceeds', async () => {
    const b = new FakeBroker();
    b.acquireResponse = { status: 200, body: { lease_id: 'lease-q', status: 'queued', position: 3, ready: false, ready_info: {}, out_prefix: outPrefix('lease-q') } };
    b.leaseStates = [{ status: 'queued', position: 2 }, { status: 'queued', position: 1 }, { status: 'provisioning' }, { status: 'ready' }];
    const info = await backend(b).ensureAvdRunning('cc-2.63.0');
    expect(info.status).toBe('booted');
  });

  it('gives up queueing after the bound with LEASE_QUEUE_TIMEOUT and releases the queue slot', async () => {
    const b = new FakeBroker();
    b.acquireResponse = { status: 200, body: { lease_id: 'lease-q', status: 'queued', position: 5, ready: false, ready_info: {} } };
    b.leaseStates = [{ status: 'queued', position: 4 }];
    let t = 0;
    const lb = backend(b, { queueWaitMs: 1000, now: () => (t += 400) });
    await expect(lb.ensureAvdRunning('cc-2.63.0')).rejects.toMatchObject({
      code: 'LEASE_QUEUE_TIMEOUT',
      message: expect.stringContaining('queued at position'),
    });
    expect(b.released).toEqual(['lease-q']);
    expect(lb.leaseId).toBeNull();
  });

  it('maps 403 to LEASE_NO_GRANT naming the grant to ask for', async () => {
    const b = new FakeBroker();
    const msg = "ace has no grant for capability 'android-emulator' in workspace connect. A workspace admin must grant it: PUT /api/capabilities/grants {\"agent\": \"ace\", \"capability\": \"android-emulator\"}.";
    b.acquireResponse = { status: 403, body: { type: 'about:blank', title: msg, detail: msg, status: 403 } };
    const err = await backend(b).ensureAvdRunning('cc-2.63.0').catch((e) => e);
    expect(err).toBeInstanceOf(MobileError);
    expect(err.code).toBe('LEASE_NO_GRANT');
    expect(err.message).toContain('workspace connect');
    expect(err.remediation).toContain('/api/capabilities/grants');
  });

  it('maps 422 (no validation errors) to LEASE_UNDECLARED, and 422 with errors to LEASE_INVALID_REQUEST', async () => {
    const b = new FakeBroker();
    const und = "ace declares no capability 'android-emulator' (declared: none). Declare it in runtime.yaml and run `canopy-runtime publish-capabilities`.";
    b.acquireResponse = { status: 422, body: { title: und, detail: und, status: 422 } };
    await expect(backend(b).ensureAvdRunning('cc-2.63.0')).rejects.toMatchObject({ code: 'LEASE_UNDECLARED' });
    b.acquireResponse = { status: 422, body: { title: 'Request validation failed', status: 422, extras: { errors: [{ loc: ['params', 'state'] }] } } };
    await expect(backend(b).ensureAvdRunning('cc-2.63.0')).rejects.toMatchObject({ code: 'LEASE_INVALID_REQUEST' });
  });

  it('maps 401 to LEASE_AUTH', async () => {
    const b = new FakeBroker();
    b.acquireResponse = { status: 401, body: { title: 'Authentication required', status: 401 } };
    await expect(backend(b).ensureAvdRunning('cc-2.63.0')).rejects.toMatchObject({ code: 'LEASE_AUTH' });
  });

  it("surfaces ready.json's reason on failed readiness and releases", async () => {
    const b = new FakeBroker();
    b.leaseStates = [
      { status: 'provisioning' },
      {
        status: 'failed',
        reason: 'the machine reported it is not ready: emulator never reached boot_completed (tcg)',
        ready_info: { ok: false, reason: 'emulator never reached boot_completed (tcg)' },
      },
    ];
    const lb = backend(b);
    const err = await lb.ensureAvdRunning('cc-2.63.0').catch((e) => e);
    expect(err.code).toBe('LEASE_READINESS_FAILED');
    expect(err.message).toContain('emulator never reached boot_completed (tcg)');
    expect(b.released).toEqual(['lease-1']);
  });

  it('treats status ready with ready_info.ok=false as a readiness failure', async () => {
    const b = new FakeBroker();
    b.readyInfo = { ok: false, reason: 'emulator-crashed' };
    await expect(backend(b).ensureAvdRunning('cc-2.63.0')).rejects.toMatchObject({
      code: 'LEASE_READINESS_FAILED',
      message: expect.stringContaining('emulator-crashed'),
    });
  });

  it("times out provisioning past the manifest's ready_timeout_s with AvdBootError", async () => {
    const b = new FakeBroker();
    b.leaseStates = [{ status: 'provisioning' }];
    let t = 0;
    const lb = backend(b, { now: () => (t += 100_000) });
    const err = await lb.ensureAvdRunning('cc-2.63.0').catch((e) => e);
    expect(err).toBeInstanceOf(AvdBootError);
    expect(err.message).toContain('960s'); // 900 from the manifest + 60 s slack
    expect(b.released).toEqual(['lease-1']);
  });

  it('LEASE_LOST when the lease expires before ready, with the full restore', async () => {
    const b = new FakeBroker();
    b.leaseStates = [{ status: 'expired', reason: 'swept' }];
    const err = await backend(b).ensureAvdRunning('cc-2.63.0').catch((e) => e);
    expect(err.code).toBe('LEASE_LOST');
    expect(err.remediation).toBe(LEASE_RESTORE_HINT);
  });

  it('every op before ensure throws LEASE_NOT_ACQUIRED', async () => {
    const lb = backend(new FakeBroker());
    await expect(lb.captureUiDump('x')).rejects.toMatchObject({ code: 'LEASE_NOT_ACQUIRED' });
    await expect(lb.clearAppData()).rejects.toMatchObject({ code: 'LEASE_NOT_ACQUIRED' });
  });

  it('a CLI failure becomes LEASE_CLI_<CODE> with its message', async () => {
    const b = new FakeBroker();
    b.cli['install-driver'] = { ok: false, error: 'maestro-jar-missing', message: 'no Maestro client jar at /opt/…' };
    const lb = backend(b);
    await lb.ensureAvdRunning('cc-2.63.0');
    await expect(lb.installDriver()).rejects.toMatchObject({
      code: 'LEASE_CLI_MAESTRO_JAR_MISSING',
      message: expect.stringContaining('no Maestro client jar'),
    });
  });

  it('emulator-crashed is LEASE_EMULATOR_CRASHED, and the next ensure replaces the sick machine', async () => {
    const b = new FakeBroker();
    b.cli['clear-app-data'] = { ok: false, error: 'emulator-crashed', message: 'qemu exited' };
    const lb = backend(b);
    await lb.ensureAvdRunning('cc-2.63.0');
    const err = await lb.clearAppData().catch((e) => e);
    expect(err.code).toBe('LEASE_EMULATOR_CRASHED');
    expect(err.remediation).toContain('connect-login');
    await lb.ensureAvdRunning('cc-2.63.0');
    expect(b.released).toEqual(['lease-1']);
    expect(lb.leaseId).toBe('lease-2');
  });

  it('a CLI usage error names contract drift', async () => {
    const b = new FakeBroker();
    b.cli['repair-driver'] = { ok: false, error: 'usage', message: 'unrecognized arguments: --out', cli_version: '1.0.0' };
    const lb = backend(b);
    await lb.ensureAvdRunning('cc-2.63.0');
    const err = await lb.repairDriver().catch((e) => e);
    expect(err.code).toBe('LEASE_CLI_USAGE');
    expect(err.remediation).toContain('lease-contract.ts');
  });

  it('LEASE_EXEC_FAILED when the exec printed no JSON', async () => {
    const b = new FakeBroker();
    const lb = backend(b, {
      fetchImpl: async (input, init) => {
        const u = new URL(String(input));
        if (/\/exec\/[^/]+$/.test(u.pathname)) {
          return json(200, { exec_id: 'c', status: 'Failed', done: true, exit_code: 127, stdout_tail: '', stderr_tail: 'ace-mobile: command not found\n' });
        }
        return b.fetch(input, init);
      },
    });
    await lb.ensureAvdRunning('cc-2.63.0');
    await expect(lb.clearAppData()).rejects.toMatchObject({ code: 'LEASE_EXEC_FAILED' });
  });

  it('LEASE_LOST mid-exec when the heartbeat finds the lease gone', async () => {
    const b = new FakeBroker();
    b.execPlan['repair-driver'] = Array(50).fill('InProgress');
    const lb = backend(b, { heartbeatMs: 1, pollIntervalMs: 1_000 });
    await lb.ensureAvdRunning('cc-2.63.0');
    b.leaseStates = [{ status: 'ready' }, { status: 'expired', reason: 'idle: no heartbeat for 900s' }];
    (b as unknown as { getCount: number }).getCount = 0;
    const err = await lb.repairDriver().catch((e) => e);
    expect(err.code).toBe('LEASE_LOST');
    expect(err.message).toContain('idle release');
  });
});

describe('LeaseBackend idle loss and recovery', () => {
  it('a gap past idle_release_s loses the machine: the next op fails LEASE_LOST naming the full restore, ensure gets a fresh one', async () => {
    const b = new FakeBroker();
    const lb = backend(b);
    await lb.ensureAvdRunning('cc-2.63.0');
    // The session goes quiet for 16 minutes; the broker idles the lease out.
    b.clock.t += 16 * 60_000;
    b.leaseStates = [{ status: 'released', reason: 'idle: no heartbeat for 900s' }];
    (b as unknown as { getCount: number }).getCount = 0;
    await lb.diagnose().catch(() => {}); // a GET sees it released
    const err = await lb.clearAppData().catch((e) => e);
    expect(err.code).toBe('LEASE_LOST');
    expect(err.remediation).toContain('mobile_ensure_avd_running');
    expect(err.remediation).toContain('connect-login');
    expect(err.remediation).toContain('connect-claim-opp');
    expect(err.remediation).toContain('900 s');

    b.onAcquire = () => { b.leaseStates = [{ status: 'ready' }]; };
    const info = await lb.ensureAvdRunning('cc-2.63.0');
    expect(lb.leaseId).toBe('lease-2');
    expect(info.lease?.reused).toBe(false);
  });

  it('a lease the broker forgot (404) reads as LEASE_LOST with the restore, not a bare not-found', async () => {
    const b = new FakeBroker();
    const lb = backend(b);
    await lb.ensureAvdRunning('cc-2.63.0');
    b.leaseStates = [{ status: 404 }];
    (b as unknown as { getCount: number }).getCount = 0;
    const err = await lb.diagnose().catch((e) => e);
    expect(err.code).toBe('LEASE_LOST');
    expect(err.remediation).toBe(LEASE_RESTORE_HINT);
  });
});

describe('LeaseBackend exec POST is never retried', () => {
  async function ready(b: FakeBroker, extra = {}) {
    const lb = backend(b, { retry: { retries: 2, sleepImpl: async () => {} }, ...extra });
    await lb.ensureAvdRunning('cc-2.63.0');
    return lb;
  }

  it('a gateway 504 after the POST is LEASE_EXEC_AMBIGUOUS, sent exactly once', async () => {
    const b = new FakeBroker();
    b.execPost = () => new Response('<html>504 Gateway Time-out</html>', { status: 504 });
    const lb = await ready(b);
    const err = await lb.repairDriver().catch((e) => e);
    expect(err.code).toBe('LEASE_EXEC_AMBIGUOUS');
    expect(err.remediation).toMatch(/NOT retried/);
    expect(err.remediation).toContain('connect_get_learn_progress');
    expect(b.posts).toBe(1);
  });

  it('a transport failure on the POST is ambiguous too, and sent once', async () => {
    const b = new FakeBroker();
    b.execPost = () => {
      throw new TypeError('fetch failed');
    };
    const lb = await ready(b);
    await expect(lb.repairDriver()).rejects.toMatchObject({ code: 'LEASE_EXEC_AMBIGUOUS' });
    expect(b.posts).toBe(1);
  });

  it("canopy-web's own 502 (SendCommand failed) is not ambiguous — nothing was sent", async () => {
    const b = new FakeBroker();
    const t = 'could not send the command: InvalidInstanceId';
    b.execPost = () => json(502, { title: t, detail: t, status: 502 });
    const lb = await ready(b);
    await expect(lb.repairDriver()).rejects.toMatchObject({ code: 'LEASE_HTTP_502' });
    expect(b.posts).toBe(1);
  });

  it('idempotent reads still retry a gateway 5xx', async () => {
    const b = new FakeBroker();
    let failed = 0;
    const lb = await ready(b, {
      fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
        if (/\/exec\/[^/]+$/.test(new URL(String(input)).pathname) && failed++ === 0) return new Response('', { status: 503 });
        return b.fetch(input, init);
      },
    });
    await expect(lb.repairDriver()).resolves.toEqual([]);
  });
});

describe('LeaseBackend exec polling', () => {
  it('a 404 on the first polls after send is SSM lag, read as pending', async () => {
    const b = new FakeBroker();
    b.execPlan['repair-driver'] = [404, 404, 'Pending'];
    const lb = backend(b);
    await lb.ensureAvdRunning('cc-2.63.0');
    await expect(lb.repairDriver()).resolves.toEqual([]);
  });

  it('a 404 past the grace is LEASE_EXEC_LOST (the lease is fine; the exec is unknown)', async () => {
    const b = new FakeBroker();
    b.execPlan['repair-driver'] = Array(100).fill(404);
    const lb = backend(b, { pollIntervalMs: 5_000 });
    await lb.ensureAvdRunning('cc-2.63.0');
    const err = await lb.repairDriver().catch((e) => e);
    expect(err.code).toBe('LEASE_EXEC_LOST');
    expect(err.remediation).toContain('before repeating a one-way step');
  });

  it('backs off 1 s for the first 10 s, 2 s to 30 s, then the ceiling, against a slow SSM — and times each phase', async () => {
    const b = new FakeBroker();
    // 12 Pending polls, then 30 InProgress, then done.
    b.execPlan['repair-driver'] = [...Array(12).fill('Pending'), ...Array(30).fill('InProgress')];
    const lb = backend(b, { pollIntervalMs: 5_000, heartbeatMs: 10 * 60_000 });
    await lb.ensureAvdRunning('cc-2.63.0');
    b.clock.sleeps = [];
    await lb.repairDriver();
    const s = b.clock.sleeps;
    expect(s.slice(0, 10)).toEqual(Array(10).fill(1_000));
    expect(s[10]).toBe(2_000);
    expect(s.filter((x) => x === 5_000).length).toBeGreaterThan(20);
    expect(Math.max(...s)).toBe(5_000);
  });

  it('long-poll: a broker that holds the GET is detected, and the client stops sleeping', async () => {
    const b = new FakeBroker();
    b.honorWait = true;
    b.holdS = 20;
    b.execPlan['repair-driver'] = ['InProgress', 'InProgress', 'InProgress'];
    const lb = backend(b, { longPollS: 20, pollIntervalMs: 5_000 });
    await lb.ensureAvdRunning('cc-2.63.0');
    b.clock.sleeps = [];
    await lb.repairDriver();
    const gets = b.callsTo('GET', /\/exec\/[^/]+$/);
    expect(gets.every((c) => c.query.wait_s === '20')).toBe(true);
    expect(b.clock.sleeps).toEqual([]);
    expect(lb.longPoll).toBe('yes');
  });

  it('long-poll fallback: a broker that ignores wait_s is detected, wait_s is dropped, and the client short-polls', async () => {
    const b = new FakeBroker();
    b.honorWait = false;
    b.execPlan['repair-driver'] = Array(6).fill('InProgress');
    const lb = backend(b, { longPollS: 20, pollIntervalMs: 5_000 });
    await lb.ensureAvdRunning('cc-2.63.0');
    b.clock.sleeps = [];
    await lb.repairDriver();
    const gets = b.callsTo('GET', /\/exec\/[^/]+$/);
    expect(gets[0].query.wait_s).toBe('20');
    expect(gets[gets.length - 1].query.wait_s).toBeUndefined();
    expect(lb.longPoll).toBe('no');
    expect(b.clock.sleeps.length).toBeGreaterThan(0);
  });

  it('rides out a network outage during the poll instead of losing the result', async () => {
    const b = new FakeBroker();
    let fails = 3;
    const lb = backend(b, {
      pollOutageMs: 120_000,
      fetchImpl: async (input, init) => {
        if (/\/exec\/[^/]+$/.test(new URL(String(input)).pathname) && fails-- > 0) throw new TypeError('fetch failed');
        return b.fetch(input, init);
      },
    });
    await lb.ensureAvdRunning('cc-2.63.0');
    await expect(lb.repairDriver()).resolves.toEqual([]);
  });

  it('gives up on an outage longer than the tolerance', async () => {
    const b = new FakeBroker();
    const lb = backend(b, {
      pollOutageMs: 10_000,
      fetchImpl: async (input, init) => {
        if (/\/exec\/[^/]+$/.test(new URL(String(input)).pathname)) throw new TypeError('fetch failed');
        return b.fetch(input, init);
      },
    });
    await lb.ensureAvdRunning('cc-2.63.0');
    await expect(lb.repairDriver()).rejects.toMatchObject({ code: 'LEASE_FETCH_FAILED' });
  });
});

describe('LeaseBackend CLI ops', () => {
  async function ready(b = new FakeBroker()) {
    const lb = backend(b);
    await lb.ensureAvdRunning('cc-2.63.0');
    return { b, lb };
  }

  it('set_location execs set-location with --lon/--lat/--alt/--sats (longitude first)', async () => {
    const { b, lb } = await ready();
    b.cli['set-location'] = { ok: true, applied: true, output: 'OK' };
    const r = await lb.setLocation('cc-2.63.0', 36.82, -1.29, 1700, 8);
    expect(b.execArgv('set-location')).toEqual(['ace-mobile', 'set-location', '--lon', '36.82', '--lat', '-1.29', '--alt', '1700', '--sats', '8']);
    expect(r).toMatchObject({ applied: true, longitude: 36.82, latitude: -1.29, altitude: 1700, satellites: 8 });
  });

  it('a KO geo fix is data (applied:false), not a throw', async () => {
    const { b, lb } = await ready();
    b.cli['set-location'] = { ok: false, applied: false, error: 'geo-fix-failed', message: 'KO' };
    expect((await lb.setLocation('x', 1, 2)).applied).toBe(false);
  });

  it('installApk uploads a local path to the URI the broker names, and is a no-op on a repeat', async () => {
    const { b, lb } = await ready();
    const apk = path.join(tmp, 'commcare-2.63.0.apk');
    fs.writeFileSync(apk, Buffer.from('PK\x03\x04apk-bytes'));
    b.cli['install-apk'] = { ok: true, package_name: 'org.commcare.dalvik', version: '2.63.0', version_code: 263 };
    const info = await lb.installApk('x', apk);
    const names = (b.callsTo('POST', /\/uploads$/)[0].body as { names: string[] }).names;
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^apk-[0-9a-f]{16}\.apk$/);
    expect(b.puts.get(`/in/${names[0]}`)?.toString()).toBe('PK\x03\x04apk-bytes');
    expect(b.execArgv('install-apk')).toEqual(['ace-mobile', 'install-apk', '--apk', inUri('lease-1', names[0])]);
    expect(info).toEqual({ packageId: 'org.commcare.dalvik', versionName: '2.63.0', versionCode: 263, path: apk });

    await lb.installApk('x', apk);
    expect(b.callsTo('POST', /\/uploads$/)).toHaveLength(1);
    expect(b.allExecArgv('install-apk')).toHaveLength(1);
  });

  it('installApk passes an https URL straight through (no upload)', async () => {
    const { b, lb } = await ready();
    b.cli['install-apk'] = { ok: true, package_name: 'p', version: '1', version_code: 1 };
    await lb.installApk('x', 'https://github.test/commcare.apk');
    expect(b.callsTo('POST', /\/uploads$/)).toHaveLength(0);
    expect(b.execArgv('install-apk')).toEqual(['ace-mobile', 'install-apk', '--apk', 'https://github.test/commcare.apk']);
  });

  it('ops without --out on the CLI get none (argparse would refuse it)', async () => {
    const { b, lb } = await ready();
    b.cli['clear-app-data'] = { ok: true, package: 'org.commcare.dalvik', cleared: true };
    b.cli['snapshot'] = { ok: true, name: 'pre', saved_at: '2026-10-14T00:00:00Z', output: 'OK' };
    expect(await lb.clearAppData()).toBe(true);
    await lb.saveSnapshot('x', 'pre');
    await lb.repairDriver();
    await lb.installDriver();
    expect(b.execArgv('clear-app-data')).toEqual(['ace-mobile', 'clear-app-data', '--package', 'org.commcare.dalvik']);
    expect(b.execArgv('snapshot')).toEqual(['ace-mobile', 'snapshot', 'save', '--name', 'pre']);
    expect(b.execArgv('repair-driver')).toEqual(['ace-mobile', 'repair-driver']);
    expect(b.execArgv('install-driver')).toEqual(['ace-mobile', 'install-driver']);
  });

  it('registerTestUser ships creds in an uploaded --creds JSON, never argv; --out is the broker prefix', async () => {
    const { b, lb } = await ready();
    b.cli['register-test-user'] = { ok: true, already_registered: false, phone: '+74260000001', backup_code: '12345678' };
    const r = await lb.registerTestUser({
      phone: '+74260000001', phoneLocal: '4260000001', countryCode: '+7', pin: '135790', backupCode: '12345678', name: 'ACE Test',
      paletteTarB64: Buffer.from('tar').toString('base64'), toOtpRecipe: 'connect-register-to-otp.yaml', fromOtpRecipe: 'connect-register-from-otp.yaml',
    });
    const argv = b.execArgv('register-test-user');
    expect(argv.join(' ')).not.toContain('135790');
    expect(argv).toEqual(expect.arrayContaining(['--to-otp-recipe', 'connect-register-to-otp.yaml', '--from-otp-recipe', 'connect-register-from-otp.yaml', '--creds', '--palette', '--out']));
    expect(argv[argv.indexOf('--out') + 1].startsWith(outPrefix('lease-1'))).toBe(true);
    const credsPut = [...b.puts.entries()].find(([k]) => k.endsWith('--creds.json'))!;
    expect(JSON.parse(credsPut[1].toString())).toEqual({
      phone: '+74260000001', phone_local: '4260000001', country_code: '+7', pin: '135790', backup_code: '12345678', name: 'ACE Test',
    });
    expect(r).toEqual({ alreadyRegistered: false, phone: '+74260000001', backupCode: '12345678' });
  });

  it('registerTestUser reads the redacted backup_code_set, reporting the code it set (as local does)', async () => {
    const { b, lb } = await ready();
    b.cli['register-test-user'] = { ok: true, already_registered: false, phone: '+74260000001', backup_code_set: true };
    const r = await lb.registerTestUser({
      phone: '+74260000001', phoneLocal: '4260000001', countryCode: '+7', pin: '1', backupCode: '87654321', name: 'n',
      paletteTarB64: '', toOtpRecipe: 'a.yaml', fromOtpRecipe: 'b.yaml',
    });
    expect(r.backupCode).toBe('87654321');
  });

  it('captureUiDump returns the inline xml + elements; a failed dump is data', async () => {
    const { b, lb } = await ready();
    b.cli['ui-dump'] = { ok: true, xml: '<hierarchy><node resource-id="a:id/x" text="Hi" class="T" bounds="[0,0][1,1]"/></hierarchy>', elements: [{ id: 'a:id/x', text: 'Hi' }], failed: false };
    const d = await lb.captureUiDump('x');
    expect(d.elements).toEqual([{ id: 'a:id/x', text: 'Hi' }]);
    expect(d.failed).toBeUndefined();
    b.cli['ui-dump'] = { ok: false, xml: '', elements: [], failed: true, error: 'ui-dump-failed', message: 'null root node' };
    expect((await lb.captureUiDump('x')).failed).toBe(true);
  });

  it('screenshot writes under its own forensics/ prefix and downloads just the PNG', async () => {
    const { b, lb } = await ready();
    b.cli['screenshot'] = (argv) => ({ ok: true, name: argv[argv.indexOf('--name') + 1], content_type: 'image/png' });
    b.putArtifact('forensics/shot', 'r-FAILURE.png', Buffer.from('\x89PNG'));
    const p = await lb.screenshot(tmp, 'r-FAILURE.png', 'forensics/shot-abc123/');
    const argv = b.execArgv('screenshot');
    expect(argv[argv.indexOf('--out') + 1]).toBe(`${outPrefix('lease-1')}forensics/shot-abc123/`);
    expect(p).toBe(path.join(tmp, 'r-FAILURE.png'));
    expect(fs.readFileSync(p).toString()).toBe('\x89PNG');
  });

  it('failureEvidence runs diagnose, ui-dump and screenshot concurrently and survives one failing', async () => {
    const { b, lb } = await ready();
    b.cli['diagnose'] = { ok: true, healthy: true };
    b.cli['ui-dump'] = { ok: true, xml: '<hierarchy/>', elements: [] };
    b.cli['screenshot'] = { ok: false, error: 'screenshot-failed', message: 'screencap died' };
    const ev = await lb.failureEvidence({ destDir: tmp, screenshotName: 'r-FAILURE.png' });
    expect(ev.diagnostics).toMatchObject({ healthy: true });
    expect(ev.dump?.xml).toBe('<hierarchy/>');
    expect(ev.screenshotPath).toBeUndefined();
    // All three were POSTed before any was polled to completion.
    const posts = b.calls.filter((c) => c.method === 'POST' && /\/exec$/.test(c.path)).map((c) => b.calls.indexOf(c));
    const firstPoll = b.calls.findIndex((c) => c.method === 'GET' && /\/exec\/[^/]+$/.test(c.path));
    expect(posts).toHaveLength(3);
    expect(Math.max(...posts)).toBeLessThan(firstPoll + 3);
  });

  it('diagnose never acquires: no lease → a note, not a machine', async () => {
    const b = new FakeBroker();
    const d = await backend(b).diagnose();
    expect(d.lease).toBeNull();
    expect(b.callsTo('POST', /leases$/)).toHaveLength(0);
  });

  it('diagnose with a lease returns the CLI snapshot plus the lease view (incl. idle_release_s)', async () => {
    const { b, lb } = await ready();
    b.cli['diagnose'] = { ok: true, healthy: true, adb_devices: [{ serial: 'emulator-5554', state: 'device' }], adb_visible_count: 1 };
    const d = await lb.diagnose();
    expect(d).toMatchObject({ healthy: true, adb_visible_count: 1, lease: { lease_id: 'lease-1', status: 'ready', instance_id: INSTANCE, idle_release_s: 900 } });
    expect(b.execArgv('diagnose')).toEqual(['ace-mobile', 'diagnose']);
  });

  it('listAvds reads the manifest state enum (read-only)', async () => {
    const b = new FakeBroker();
    expect(await backend(b).listAvds()).toEqual(['cc-2.62.0', 'cc-2.63.0', 'cc-2.64.0']);
    expect(b.callsTo('POST', /leases$/)).toHaveLength(0);
  });

  it('uninstallApk is typed LEASE_UNSUPPORTED', async () => {
    const { lb } = await ready();
    await expect(lb.uninstallApk('x', 'p')).rejects.toMatchObject({ code: 'LEASE_UNSUPPORTED' });
  });
});

describe('LeaseBackend per-instance prefixes come only from the broker', () => {
  it('--out is exactly the broker out_prefix + a relative dir; inputs are the s3_uri it returned', async () => {
    const b = new FakeBroker();
    const lb = backend(b);
    await lb.ensureAvdRunning('cc-2.63.0');
    b.cli['run-recipe'] = { ok: true, exit_code: 0, stdout: '', stderr: '' };
    const recipe = path.join(tmp, 'r.yaml');
    fs.writeFileSync(recipe, 'appId: x\n---\n- launchApp\n');
    await lb.runRecipe(recipe, {}, path.join(tmp, 'o'), { paletteTarB64: Buffer.from('p').toString('base64') });
    const argv = b.execArgv('run-recipe');
    expect(argv[argv.indexOf('--out') + 1]).toMatch(new RegExp(`^${outPrefix('lease-1').replace(/[/.]/g, '\\$&')}run-recipe-[a-z0-9]+/$`));
    for (const flag of ['--recipe', '--palette']) {
      expect(argv[argv.indexOf(flag) + 1].startsWith(`s3://${BUCKET}/leases/lease-1/${INSTANCE}/in/`)).toBe(true);
    }
  });

  it('refuses to invent an --out when the broker states no out_prefix', async () => {
    const b = new FakeBroker();
    const lb = backend(b, {
      fetchImpl: async (input, init) => {
        const r = await b.fetch(input, init);
        if (/\/api\/capabilities\/leases(\/[^/]+)?$/.test(new URL(String(input)).pathname) && r.ok) {
          const body = (await r.json()) as Json;
          delete body.out_prefix;
          return json(200, body);
        }
        return r;
      },
    });
    await lb.ensureAvdRunning('cc-2.63.0');
    await expect(
      lb.registerTestUser({ phone: '+7426', phoneLocal: '1', countryCode: '+7', pin: '1', backupCode: '2', name: 'n', paletteTarB64: '', toOtpRecipe: 'a.yaml', fromOtpRecipe: 'b.yaml' }),
    ).rejects.toMatchObject({ code: 'LEASE_BAD_RESPONSE', message: expect.stringContaining('out_prefix') });
  });

  it('no client code builds a leases/<id>/ S3 path', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../../../mcp/mobile/backends/lease.ts'), 'utf8');
    expect(src).not.toMatch(/`s3:\/\/\$\{[^}]+\}\/leases\//);
    expect(src).not.toMatch(/\/leases\/\[\^\/\]\+\/\)in\//);
  });
});

describe('LeaseBackend.runRecipe', () => {
  const PNG = Buffer.from('\x89PNG fake');

  async function run(b: FakeBroker, recipeLine: Json | ((argv: string[]) => Json), body = 'appId: org.commcare.dalvik\n---\n- launchApp\n', extra = {}) {
    const lb = backend(b, extra);
    await lb.ensureAvdRunning('cc-2.63.0');
    b.cli['run-recipe'] = recipeLine;
    const recipe = path.join(tmp, 'learn-smoke.yaml');
    fs.writeFileSync(recipe, body);
    const out = path.join(tmp, 'shots');
    const r = await lb.runRecipe(recipe, { PIN: '1234', NAME: 'A B' }, out, {
      paletteTarB64: Buffer.from('palette-tar').toString('base64'),
    });
    return { lb, r, out, recipe };
  }

  it('uploads recipe + palette in one presign, execs run-recipe with --env, --out and a sized --timeout-s, downloads artifacts', async () => {
    const b = new FakeBroker();
    b.putArtifact('run-recipe', '01-home.png', PNG);
    b.putArtifact('run-recipe', 'maestro-stdout.log', Buffer.from('log'));
    b.putArtifact('run-recipe', 'result.json', Buffer.from('{}'));
    const { r, out } = await run(b, {
      ok: true, exit_code: 0, stdout: 'Flow passed', stderr: '',
      steps: [{ index: 0, name: 'launchApp', status: 'pass', duration_ms: 1200 }],
    });

    const uploads = b.callsTo('POST', /\/uploads$/);
    expect(uploads).toHaveLength(1);
    const names = (uploads[0].body as { names: string[] }).names;
    expect(names).toHaveLength(2);
    expect(names[0]).toMatch(/^palette-[0-9a-f]{16}\.tar\.gz$/);
    expect(names[1]).toMatch(/--learn-smoke\.yaml$/);
    expect([...b.puts.values()].map((v) => v.toString())).toContain('palette-tar');

    const argv = b.execArgv('run-recipe');
    expect(argv.slice(0, 2)).toEqual(['ace-mobile', 'run-recipe']);
    expect(argv.filter((a, i) => argv[i - 1] === '--env')).toEqual(['PIN=1234', 'NAME=A B']);
    expect(argv[argv.indexOf('--timeout-s') + 1]).toBe('600'); // the 10-min floor, as local
    expect(b.execBodies().find((e) => e.argv[1] === 'run-recipe')!.timeout_s).toBe(600 + 180);

    expect(r.status).toBe('pass');
    expect(r.stdout).toBe('Flow passed');
    expect(r.steps).toEqual([{ index: 0, name: 'launchApp', status: 'pass', screenshot: undefined, error: undefined, durationMs: 1200 }]);
    expect(fs.readdirSync(out).sort()).toEqual(['01-home.png', 'maestro-stdout.log', 'result.json']);
    expect(r.screenshots).toHaveLength(1);
    expect(r.screenshots[0]).toMatchObject({ stepName: '01-home', path: path.join(out, '01-home.png'), bytes: PNG.length });
    expect(r.remoteTimings?.[0]).toMatchObject({ op: 'run-recipe', polls: 1 });
    expect(r.remoteTimings?.[0].download_ms).toBeTypeOf('number');
    expect(r.remoteTimings?.[0].upload_ms).toBeTypeOf('number');
  });

  it('the palette uploads once per lease (cached by content), not once per recipe', async () => {
    const b = new FakeBroker();
    const { lb, recipe } = await run(b, { ok: true, exit_code: 0, stdout: '', stderr: '' });
    await lb.runRecipe(recipe, {}, path.join(tmp, 'two'), { paletteTarB64: Buffer.from('palette-tar').toString('base64') });
    const allNames = b.callsTo('POST', /\/uploads$/).flatMap((c) => (c.body as { names: string[] }).names);
    expect(allNames.filter((n) => n.startsWith('palette-'))).toHaveLength(1);
    const palettes = b.allExecArgv('run-recipe').map((a) => a[a.indexOf('--palette') + 1]);
    expect(new Set(palettes).size).toBe(1);
  });

  it('chunks at screenshots like local: one exec per chunk, each with its own sized timeout, a UI dump after each screenshot', async () => {
    const b = new FakeBroker();
    b.cli['ui-dump'] = { ok: true, xml: '<hierarchy><node text="x"/></hierarchy>', elements: [] };
    b.putArtifact('run-recipe', 'maestro-stdout.log', Buffer.from('log'));
    const long = Array.from({ length: 40 }, () => '- tapOn: "Next"').join('\n');
    const body = `appId: org.commcare.dalvik\n---\n- launchApp\n- takeScreenshot: a\n${long}\n- takeScreenshot: b\n- back\n`;
    const progress: string[] = [];
    const lb = backend(b);
    await lb.ensureAvdRunning('cc-2.63.0');
    b.cli['run-recipe'] = { ok: true, exit_code: 0, stdout: 'ok', stderr: '' };
    const recipe = path.join(tmp, 'journey-learn.yaml');
    fs.writeFileSync(recipe, body);
    const out = path.join(tmp, 'shots');
    const r = await lb.runRecipe(recipe, {}, out, { onProgress: (e) => progress.push(e.kind) });

    const runs = b.allExecArgv('run-recipe');
    expect(runs).toHaveLength(3);
    const timeouts = runs.map((a) => Number(a[a.indexOf('--timeout-s') + 1]));
    expect(timeouts[0]).toBe(600); // 2 steps → floor
    expect(timeouts[1]).toBe(Math.ceil((41 * 20_000) / 1000)); // 41 steps × 20 s
    const execTimeouts = b.execBodies().filter((e) => e.argv[1] === 'run-recipe').map((e) => e.timeout_s);
    expect(execTimeouts).toEqual(timeouts.map((t) => t + 180));
    // One dump per screenshot-ending chunk, written beside the PNG it pairs with.
    expect(b.allExecArgv('ui-dump')).toHaveLength(2);
    expect(fs.existsSync(path.join(out, 'a.xml'))).toBe(true);
    expect(fs.existsSync(path.join(out, 'b.xml'))).toBe(true);
    // Each chunk's logs survive the next chunk's.
    expect(fs.readdirSync(path.join(out, 'chunks')).sort()).toEqual(['01', '02', '03']);
    expect(progress.filter((k) => k === 'chunk-done')).toHaveLength(3);
    expect(r.status).toBe('pass');
  });

  it('a failing chunk stops the walk: later chunks never run, and the verdict is fail', async () => {
    const b = new FakeBroker();
    let n = 0;
    const body = 'appId: x\n---\n- launchApp\n- takeScreenshot: a\n- tapOn: "Go"\n- takeScreenshot: b\n- back\n';
    const { r } = await run(b, () => (++n === 2
      ? { ok: false, exit_code: 1, error: 'recipe-failed', message: 'maestro exited 1', stdout: '', stderr: 'Element not found: Text matching regex: Go' }
      : { ok: true, exit_code: 0, stdout: '', stderr: '' }), body);
    expect(b.allExecArgv('run-recipe')).toHaveLength(2);
    expect(r.status).toBe('fail');
    expect(r.failure?.failureClass).toBe('selector-not-found');
  });

  it('a recipe-timeout is MAESTRO_STALL, as local raises it, after downloading what the chunk wrote', async () => {
    const b = new FakeBroker();
    b.putArtifact('run-recipe', 'q1.png', PNG);
    const err = await run(b, { ok: false, exit_code: 124, error: 'recipe-timeout', message: 'maestro exceeded --timeout-s 600' }).catch((e) => e);
    expect(err.code).toBe('MAESTRO_STALL');
    expect(err.diagnostics).toMatchObject({ chunks_completed: 0, chunks_total: 1, timeout_ms: 600_000 });
    expect(fs.existsSync(path.join(tmp, 'shots', 'q1.png'))).toBe(true);
  });

  it('a Maestro failure (ok:false, error recipe-failed) is a fail RESULT, not a throw', async () => {
    const b = new FakeBroker();
    const { r } = await run(b, { ok: false, exit_code: 1, error: 'recipe-failed', message: 'maestro exited 1', stdout: '', stderr: 'Element not found: Id matching regex: next' });
    expect(r.status).toBe('fail');
    expect(r.exitCode).toBe(1);
    expect(r.failure?.failureClass).toBe('selector-not-found');
  });

  it("surfaces the machine's upload_error as a warning", async () => {
    const b = new FakeBroker();
    const { r } = await run(b, { ok: true, exit_code: 0, stdout: '', stderr: '', upload_error: 'AccessDenied on debug/' });
    expect(r.warnings?.join(' ')).toContain('AccessDenied on debug/');
  });

  it('flattens nested keys to basenames, and keeps debug/ captures out of screenshots[]', async () => {
    const b = new FakeBroker();
    b.putArtifact('run-recipe', '.maestro/tests/2026/commands-x.json', Buffer.from('[]'));
    b.putArtifact('run-recipe', 'debug/screenshot-fail.png', PNG);
    b.putArtifact('run-recipe', 'ok.png', PNG);
    const { out, r } = await run(b, { ok: true, exit_code: 0, stdout: '', stderr: '' });
    expect(fs.readdirSync(out).sort()).toEqual(['commands-x.json', 'debug', 'ok.png']);
    expect(fs.readdirSync(path.join(out, 'debug'))).toEqual(['screenshot-fail.png']);
    expect(r.screenshots.map((s) => s.stepName)).toEqual(['ok']);
  });

  it('artifact download shape: files land by basename, images become ScreenshotEntry', async () => {
    const b = new FakeBroker();
    b.putArtifact('run-recipe', '01-home.png', PNG);
    b.putArtifact('run-recipe', '02-learn.png', PNG);
    b.putArtifact('run-recipe', 'maestro-stderr.log', Buffer.from(''));
    const { r: lease, out: leaseOut } = await run(b, { ok: true, exit_code: 0, stdout: '', stderr: '' });

    expect(fs.readdirSync(leaseOut).sort()).toEqual(['01-home.png', '02-learn.png', 'maestro-stderr.log']);
    const shape = lease.screenshots
      .map((x) => ({ stepName: x.stepName, rel: path.relative(leaseOut, x.path), bytes: x.bytes }))
      .sort((a, z) => a.stepName.localeCompare(z.stepName));
    expect(shape).toEqual([
      { stepName: '01-home', rel: '01-home.png', bytes: PNG.length },
      { stepName: '02-learn', rel: '02-learn.png', bytes: PNG.length },
    ]);
    expect(Object.keys(lease.screenshots[0]).sort()).toEqual(['bytes', 'path', 'stepName', 'takenAt']);
  });

  it('downloads artifacts in parallel, bounded', async () => {
    const b = new FakeBroker();
    for (let i = 0; i < 20; i++) b.putArtifact('run-recipe', `s${String(i).padStart(2, '0')}.png`, PNG);
    let inFlight = 0;
    let peak = 0;
    const slowFetch: typeof fetch = async (input, init) => {
      if (new URL(String(input)).host === 's3.test' && (init?.method ?? 'GET') === 'GET') {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
      }
      return b.fetch(input, init);
    };
    const { r } = await run(b, { ok: true, exit_code: 0, stdout: '', stderr: '' }, undefined, { fetchImpl: slowFetch, downloadConcurrency: 6 });
    expect(r.screenshots).toHaveLength(20);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(6);
  });

  it('reads the full stdout when the inline tail was cut (the broker keeps only the last 4,000 chars)', async () => {
    const b = new FakeBroker();
    const full = { ok: true, exit_code: 0, stdout: 'from stdout_url', stderr: '' };
    const lb = backend(b, {
      fetchImpl: async (input, init) => {
        const u = new URL(String(input));
        if (/\/exec\/[^/]+$/.test(u.pathname)) {
          return json(200, { exec_id: 'c', status: 'Success', done: true, exit_code: 0, stdout_tail: 'cut","stderr":""}', stderr_tail: '', stdout_url: 'https://s3.test/stdout' });
        }
        if (u.host === 's3.test' && u.pathname === '/stdout') return new Response(JSON.stringify(full) + '\n');
        return b.fetch(input, init);
      },
    });
    await lb.ensureAvdRunning('cc-2.63.0');
    const recipe = path.join(tmp, 'r.yaml');
    fs.writeFileSync(recipe, 'appId: x\n---\n- launchApp\n');
    const r = await lb.runRecipe(recipe, {}, path.join(tmp, 'o'));
    expect(r.stdout).toBe('from stdout_url');
  });

  it('reads result.json when the inline stdout line was truncated and there is no stdout_url', async () => {
    const b = new FakeBroker();
    const full = { ok: true, exit_code: 0, stdout: 'from result.json', stderr: '' };
    b.putArtifact('run-recipe', 'result.json', Buffer.from(JSON.stringify(full)));
    const lb = backend(b, {
      fetchImpl: async (input, init) => {
        const u = new URL(String(input));
        if (/\/exec\/[^/]+$/.test(u.pathname)) {
          return json(200, { exec_id: 'c', status: 'Success', done: true, exit_code: 0, stdout_tail: '{"ok":true,"exit_code":0,"stdout":"cut', stderr_tail: '', stdout_url: null });
        }
        return b.fetch(input, init);
      },
    });
    await lb.ensureAvdRunning('cc-2.63.0');
    const recipe = path.join(tmp, 'r.yaml');
    fs.writeFileSync(recipe, 'appId: x\n---\n- launchApp\n');
    const r = await lb.runRecipe(recipe, {}, path.join(tmp, 'o'));
    expect(r.stdout).toBe('from result.json');
  });

  it('an unsafe artifact name is skipped, never written outside screenshotDir (ace#1110)', async () => {
    const b = new FakeBroker();
    b.putArtifact('run-recipe', '..', Buffer.from('x'));
    b.putArtifact('run-recipe', 'ok.png', PNG);
    const { out } = await run(b, { ok: true, exit_code: 0, stdout: '', stderr: '' });
    expect(fs.readdirSync(out)).toEqual(['ok.png']);
  });
});

describe('LeaseBackend against canopy-web refusal texts', () => {
  it('403 for a caller below editor is LEASE_FORBIDDEN, not a missing grant', async () => {
    const b = new FakeBroker();
    const t = "leasing ace's capabilities needs the editor role or above, or the agent's own login";
    b.acquireResponse = { status: 403, body: { title: t, detail: t, status: 403 } };
    await expect(backend(b).ensureAvdRunning('cc-2.63.0')).rejects.toMatchObject({ code: 'LEASE_FORBIDDEN' });
  });

  it('a stale CANOPY_TURN_ID 422 is LEASE_INVALID_REQUEST, not LEASE_UNDECLARED', async () => {
    const b = new FakeBroker();
    const t = 'turn 9 has already ended (completed)';
    b.acquireResponse = { status: 422, body: { title: t, detail: t, status: 422 } };
    await expect(backend(b).ensureAvdRunning('cc-2.63.0')).rejects.toMatchObject({
      code: 'LEASE_INVALID_REQUEST',
      message: expect.stringContaining('has already ended'),
    });
  });

  it('404 on the agent route is LEASE_AGENT_NOT_VISIBLE', async () => {
    const b = new FakeBroker();
    b.acquireResponse = { status: 404, body: { title: "agent 'ace' not found", detail: "agent 'ace' not found", status: 404 } };
    await expect(backend(b).ensureAvdRunning('cc-2.63.0')).rejects.toMatchObject({ code: 'LEASE_AGENT_NOT_VISIBLE' });
  });

  it('409 (exec on a lease that is no longer ready) is LEASE_LOST with the full restore', async () => {
    const b = new FakeBroker();
    const lb = backend(b);
    await lb.ensureAvdRunning('cc-2.63.0');
    b.leaseStates = [{ status: 'expired' }];
    (b as unknown as { getCount: number }).getCount = 1;
    const err = await lb.repairDriver().catch((e) => e);
    expect(err.code).toBe('LEASE_LOST');
    expect(err.remediation).toBe(LEASE_RESTORE_HINT);
  });
});

describe('LeaseBackend prewarm', () => {
  it('starts the acquire and returns at once; the blocking ensure joins it and reports a FRESH machine', async () => {
    const b = new FakeBroker();
    b.leaseStates = [{ status: 'provisioning' }, { status: 'provisioning' }, { status: 'ready' }];
    b.readyInfo = { ok: true, state: 'cc-2.63.0' };
    const lb = backend(b);
    const p = await lb.prewarm('cc-2.63.0');
    expect(p).toMatchObject({ prewarm: 'started', state: 'cc-2.63.0' });
    const info = await lb.ensureAvdRunning('cc-2.63.0');
    expect(b.callsTo('POST', /^\/api\/capabilities\/leases$/)).toHaveLength(1);
    expect(info.lease?.reused).toBe(false);
    // Handed out once: the next ensure is a reuse.
    expect((await lb.ensureAvdRunning('cc-2.63.0')).lease?.reused).toBe(true);
    expect(await lb.prewarm('cc-2.63.0')).toMatchObject({ prewarm: 'held', lease_id: 'lease-1' });
  });

  it('a prewarm that completed before the blocking ensure still reports the machine fresh (no wasted pm clear)', async () => {
    const b = new FakeBroker();
    b.readyInfo = { ok: true, state: 'cc-2.63.0' };
    const lb = backend(b);
    await lb.prewarm('cc-2.63.0');
    for (let i = 0; i < 20 && lb.leaseId === null; i++) await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 10));
    expect((await lb.ensureAvdRunning('cc-2.63.0')).lease?.reused).toBe(false);
    expect(b.callsTo('POST', /^\/api\/capabilities\/leases$/)).toHaveLength(1);
  });

  it('refuses a state/selector-map mismatch at once, before any machine is acquired', async () => {
    const b = new FakeBroker();
    const lb = backend(b, { apkVersion: () => '2.64.0' });
    await expect(lb.prewarm('cc-2.63.0')).rejects.toMatchObject({ code: 'LEASE_STATE_SELECTOR_MISMATCH' });
    expect(b.callsTo('POST', /^\/api\/capabilities\/leases$/)).toHaveLength(0);
  });

  it('a background failure is not thrown from prewarm; the blocking ensure surfaces it typed', async () => {
    const b = new FakeBroker();
    b.leaseStates = [{ status: 'failed', reason: 'boot hook died' }];
    const lb = backend(b);
    expect((await lb.prewarm('cc-2.63.0')).prewarm).toBe('started');
    await expect(lb.ensureAvdRunning('cc-2.63.0')).rejects.toMatchObject({ code: 'LEASE_READINESS_FAILED' });
  });
});

describe('LeaseBackend ready.json readers', () => {
  it('a matching fingerprint whose boot step failed is `incomplete`, naming the key; boot_path and loose timings are read', async () => {
    const b = new FakeBroker();
    b.readyInfo = {
      ok: true, state: 'cc-2.63.0', boot_path: { path: 'snapshot', detail: 'cc-2.63.0 quickboot' }, hook_s: 41.5,
      baseline: { fingerprint: ENVIRONMENT_BASELINE_FINGERPRINT, complete: false, failed: ['mock_location_fix'] },
      timings: { emulator_boot_s: 30 },
    };
    const info = await backend(b).ensureAvdRunning('cc-2.63.0');
    expect(info.lease).toMatchObject({ baseline_parity: 'incomplete', baseline_failed: ['mock_location_fix'], boot_path: 'snapshot' });
    expect(info.timings).toMatchObject({ emulator_boot_s: 30, hook_s: 41.5 });
  });

  it('accepts a top-level baseline_fingerprint and a bare-string boot_path', async () => {
    const b = new FakeBroker();
    b.readyInfo = { ok: true, baseline_fingerprint: ENVIRONMENT_BASELINE_FINGERPRINT, boot_path: 'cold-fallback' };
    const info = await backend(b).ensureAvdRunning('cc-2.63.0');
    expect(info.lease).toMatchObject({ baseline_parity: 'match', boot_path: 'cold-fallback' });
  });
});

describe('LeaseBackend apply-baseline', () => {
  it('execs ace-mobile apply-baseline and reports the fingerprint it applied', async () => {
    const b = new FakeBroker();
    const lb = backend(b);
    await lb.ensureAvdRunning('cc-2.63.0');
    b.cli['apply-baseline'] = { ok: true, fingerprint: ENVIRONMENT_BASELINE_FINGERPRINT, complete: true, failed: [], clock_synced: true };
    expect(await lb.applyBaseline()).toEqual({
      supported: true, ok: true, fingerprint: ENVIRONMENT_BASELINE_FINGERPRINT, failed: [], clockSynced: true,
    });
    expect(b.execArgv('apply-baseline')).toEqual(['ace-mobile', 'apply-baseline']);
    expect(lb.baselineAppliedFingerprint).toBe(ENVIRONMENT_BASELINE_FINGERPRINT);
  });

  it('a failed step is data (baseline-failed), naming the keys', async () => {
    const b = new FakeBroker();
    const lb = backend(b);
    await lb.ensureAvdRunning('cc-2.63.0');
    b.cli['apply-baseline'] = { ok: false, error: 'baseline-failed', message: 'x', fingerprint: 'abc', failed: ['screen_off_timeout'] };
    expect(await lb.applyBaseline()).toMatchObject({ supported: true, ok: false, failed: ['screen_off_timeout'] });
  });

  it('a CLI without the subcommand (usage) is supported:false, not a throw', async () => {
    const b = new FakeBroker();
    const lb = backend(b);
    await lb.ensureAvdRunning('cc-2.63.0');
    b.cli['apply-baseline'] = { ok: false, error: 'usage', message: "argument cmd: invalid choice: 'apply-baseline'" };
    expect(await lb.applyBaseline()).toMatchObject({ supported: false, ok: false });
  });
});

describe('LeaseBackend crash detection through diagnose', () => {
  it('diagnose reporting emulator-crashed marks the machine sick: the next ensure replaces it', async () => {
    const b = new FakeBroker();
    const lb = backend(b);
    await lb.ensureAvdRunning('cc-2.63.0');
    b.cli.diagnose = { ok: true, healthy: false, crashed: true, error: 'emulator-crashed', message: 'the emulator died after ready' };
    const d = await lb.diagnose();
    expect(d.crashed).toBe(true);
    await lb.ensureAvdRunning('cc-2.63.0');
    expect(b.released).toEqual(['lease-1']);
    expect(lb.leaseId).toBe('lease-2');
  });
});

describe('LeaseBackend result.json when the inline line was shortened', () => {
  it('inline_truncated → the full result.json under --out wins', async () => {
    const b = new FakeBroker();
    const lb = backend(b);
    await lb.ensureAvdRunning('cc-2.63.0');
    const steps = [0, 1, 2].map((i) => ({ index: i, name: `s${i}`, status: 'pass' }));
    b.cli['run-recipe'] = { ok: true, exit_code: 0, stdout: 'cut', steps: [], inline_truncated: ['steps', 'stdout'] };
    b.putArtifact('run-recipe', 'result.json', Buffer.from(JSON.stringify({ ok: true, exit_code: 0, stdout: 'Flow passed', steps })));
    const recipe = path.join(tmp, 'r.yaml');
    fs.writeFileSync(recipe, 'appId: x\n---\n- launchApp\n');
    const r = await lb.runRecipe(recipe, {}, path.join(tmp, 'o'));
    expect(r.steps).toHaveLength(3);
    expect(r.stdout).toBe('Flow passed');
  });

  it('an unreadable result.json leaves the inline copy in force', async () => {
    const b = new FakeBroker();
    const lb = backend(b);
    await lb.ensureAvdRunning('cc-2.63.0');
    b.cli['run-recipe'] = { ok: true, exit_code: 0, stdout: 'inline', steps: [], inline_truncated: ['steps'] };
    const recipe = path.join(tmp, 'r.yaml');
    fs.writeFileSync(recipe, 'appId: x\n---\n- launchApp\n');
    const r = await lb.runRecipe(recipe, {}, path.join(tmp, 'o'));
    expect(r.status).toBe('pass');
    expect(r.stdout).toBe('inline');
  });
});

describe('LeaseBackend recording', () => {
  const MP4 = Buffer.from('\0\0\0\x18ftypisom fake mp4');
  const rec = { recipeId: 'learn-smoke', dispatchId: 'd-1', bitRate: '2M', size: '720x1520' };

  function recordCli(b: FakeBroker, start: Json = { ok: true, name: 'learn-smoke.mp4' }, stop: Json = { ok: true, name: 'learn-smoke.mp4', bytes: MP4.length }) {
    b.cli.record = (argv) => (argv[2] === 'start' ? start : stop);
  }
  async function walk(b: FakeBroker, lb: LeaseBackend, line: Json = { ok: true, exit_code: 0, stdout: '', stderr: '' }) {
    b.cli['run-recipe'] = line;
    const recipe = path.join(tmp, 'learn-smoke.yaml');
    fs.writeFileSync(recipe, 'appId: x\n---\n- launchApp\n- takeScreenshot: a\n- back\n');
    const sink: import('../../../../mcp/mobile/types.js').VideoArtifact[] = [];
    const out = path.join(tmp, 'shots');
    const r = await lb.runRecipe(recipe, {}, out, { record: rec, videoSink: sink }).catch((e) => e);
    return { r, sink, out };
  }

  it('record start before the first chunk, record stop after the last; the mp4 lands as <recipeId>.mp4', async () => {
    const b = new FakeBroker();
    const lb = backend(b);
    await lb.ensureAvdRunning('cc-2.63.0');
    recordCli(b);
    b.putArtifact('record-learn-smoke', 'learn-smoke.mp4', MP4);
    const { r, sink, out } = await walk(b, lb);
    const order = [...b.execs.values()].map((e) => e.argv.slice(1, 3).join(' ').replace(/ --.*/, ''));
    expect(order[0]).toBe('record start');
    expect(order[order.length - 1]).toBe('record stop');
    expect(order.filter((o) => o.startsWith('run-recipe'))).toHaveLength(2);
    const start = b.allExecArgv('record').find((a) => a[2] === 'start')!;
    expect(start).toEqual(['ace-mobile', 'record', 'start', '--name', 'learn-smoke.mp4', '--bit-rate', '2M', '--size', '720x1520']);
    const stop = b.allExecArgv('record').find((a) => a[2] === 'stop')!;
    expect(stop[stop.indexOf('--out') + 1]).toMatch(/^s3:\/\/cap-bucket\/leases\/lease-1\/i-0abc\/out\/record-learn-smoke-/);
    expect(sink).toEqual([{ path: path.join(out, 'learn-smoke.mp4'), bytes: MP4.length, recipeId: 'learn-smoke', dispatchId: 'd-1', attempt: 1 }]);
    expect(fs.readFileSync(path.join(out, 'learn-smoke.mp4'))).toEqual(MP4);
    expect(r.screenshots.map((s: { path: string }) => path.basename(s.path))).not.toContain('learn-smoke.mp4');
    expect(r.remoteTimings.map((t: { op: string }) => t.op)).toEqual(expect.arrayContaining(['record start', 'record stop']));
  });

  it('a stalled walk still stops the recording and yields its footage', async () => {
    const b = new FakeBroker();
    const lb = backend(b);
    await lb.ensureAvdRunning('cc-2.63.0');
    recordCli(b);
    b.putArtifact('record-learn-smoke', 'learn-smoke.mp4', MP4);
    const { r, sink } = await walk(b, lb, { ok: false, exit_code: 124, error: 'recipe-timeout', message: 'x' });
    expect(r.code).toBe('MAESTRO_STALL');
    expect(sink).toHaveLength(1);
  });

  it('a CLI without `record` (usage) walks unrecorded, and is asked only once per machine', async () => {
    const b = new FakeBroker();
    const lb = backend(b);
    await lb.ensureAvdRunning('cc-2.63.0');
    recordCli(b, { ok: false, error: 'usage', message: "argument cmd: invalid choice: 'record'" });
    const first = await walk(b, lb);
    expect(first.r.status).toBe('pass');
    expect(first.sink).toEqual([]);
    await walk(b, lb);
    expect(b.allExecArgv('record')).toHaveLength(1);
  });

  it('a failing stop, or an empty file, is no video — never a changed verdict', async () => {
    const b = new FakeBroker();
    const lb = backend(b);
    await lb.ensureAvdRunning('cc-2.63.0');
    recordCli(b, undefined, { ok: false, error: 'no-recording', message: 'none running' });
    const a = await walk(b, lb);
    expect(a.r.status).toBe('pass');
    expect(a.sink).toEqual([]);

    const b2 = new FakeBroker();
    const lb2 = backend(b2);
    await lb2.ensureAvdRunning('cc-2.63.0');
    recordCli(b2);
    b2.putArtifact('record-learn-smoke', 'learn-smoke.mp4', Buffer.alloc(0));
    const c = await walk(b2, lb2);
    expect(c.sink).toEqual([]);
    expect(fs.existsSync(path.join(c.out, 'learn-smoke.mp4'))).toBe(false);
  });

  it('no record opts → no record exec at all', async () => {
    const b = new FakeBroker();
    const lb = backend(b);
    await lb.ensureAvdRunning('cc-2.63.0');
    recordCli(b);
    b.cli['run-recipe'] = { ok: true, exit_code: 0 };
    const recipe = path.join(tmp, 'x.yaml');
    fs.writeFileSync(recipe, 'appId: x\n---\n- launchApp\n');
    await lb.runRecipe(recipe, {}, path.join(tmp, 'o'));
    expect(b.allExecArgv('record')).toHaveLength(0);
  });
});

describe('LeaseBackend against CLI 1.1.0 / dimagi-canopy v0.9.0', () => {
  it('a known boot-hook reason is a typed readiness error with its fix; detail is carried', async () => {
    const b = new FakeBroker();
    b.readyInfo = { ok: false, reason: 'no-kvm', detail: '/dev/kvm is absent' };
    const err = await backend(b).ensureAvdRunning('cc-2.63.0').catch((e) => e);
    expect(err.code).toBe('LEASE_READINESS_NO_KVM');
    expect(err.message).toMatch(/nested virtualization|accelerated/);
    expect(err.remediation).toMatch(/launch template/);
    expect(err.diagnostics).toMatchObject({ readiness_reason: 'no-kvm', detail: '/dev/kvm is absent' });
    expect(b.released).toEqual(['lease-1']);
  });

  it.each([
    'bad-user-data', 'unknown-state', 'no-states', 'no-kvm', 'halt-not-armed',
    'runner-start-failed', 'emulator-boot-failed', 'emulator-ready-timeout', 'hook-crashed',
  ])('%s has its own code', async (reason) => {
    const b = new FakeBroker();
    b.leaseStates = [{ status: 'failed', reason: `the machine reported it is not ready: ${reason}`, ready_info: { ok: false, reason } }];
    const err = await backend(b).ensureAvdRunning('cc-2.63.0').catch((e) => e);
    expect(err.code).toBe(`LEASE_READINESS_${reason.toUpperCase().replace(/-/g, '_')}`);
  });

  it('only broker-stated prefixes and URIs are used under the v0.9.0 per-instance layout', async () => {
    const b = new FakeBroker();
    b.prefixFor = (id) => `s3://cap-bucket/vm/AROAEXAMPLE:i-0abc/lease/${id}/out/`;
    b.inFor = (id, n) => `s3://cap-bucket/vm/AROAEXAMPLE:i-0abc/lease/${id}/in/${n}`;
    const lb = backend(b);
    await lb.ensureAvdRunning('cc-2.63.0');
    b.cli['run-recipe'] = { ok: true, exit_code: 0 };
    b.putArtifact('run-recipe', '01-home.png', Buffer.from('png'));
    const recipe = path.join(tmp, 'r.yaml');
    fs.writeFileSync(recipe, 'appId: x\n---\n- launchApp\n');
    const out = path.join(tmp, 'o');
    const r = await lb.runRecipe(recipe, {}, out, { paletteTarB64: Buffer.from('p').toString('base64') });
    const argv = b.execArgv('run-recipe');
    expect(argv[0]).toBe('ace-mobile');
    expect(argv[argv.indexOf('--out') + 1]).toMatch(/^s3:\/\/cap-bucket\/vm\/AROAEXAMPLE:i-0abc\/lease\/lease-1\/out\/run-recipe-/);
    expect(argv[argv.indexOf('--recipe') + 1]).toMatch(/^s3:\/\/cap-bucket\/vm\/AROAEXAMPLE:i-0abc\/lease\/lease-1\/in\//);
    expect(argv[argv.indexOf('--palette') + 1]).toMatch(/^s3:\/\/cap-bucket\/vm\/AROAEXAMPLE:i-0abc\/lease\/lease-1\/in\/palette-/);
    expect(fs.existsSync(path.join(out, '01-home.png'))).toBe(true);
    expect(r.status).toBe('pass');
    // Every exec is argv[0] = the one allow-listed binary.
    for (const e of b.execs.values()) expect(e.argv[0]).toBe('ace-mobile');
  });

  it('record-busy (a stale recording left by a lost walk) is stopped and discarded, then ours starts', async () => {
    const b = new FakeBroker();
    const lb = backend(b);
    await lb.ensureAvdRunning('cc-2.63.0');
    let starts = 0;
    b.cli.record = (argv) =>
      argv[2] === 'start'
        ? ++starts === 1
          ? { ok: false, error: 'record-busy', message: 'busy', recording: { name: 'old.mp4' } }
          : { ok: true, name: 'r.mp4', device_path: '/sdcard/r.mp4', started_at: 'x', bit_rate: '1M', size: '540x1140' }
        : { ok: true, name: argv[argv.indexOf('--name') + 1] ?? 'x', key: 'x.mp4', uri: 's3://x', content_type: 'video/mp4', bytes: 3, duration_s: 1 };
    b.cli['run-recipe'] = { ok: true, exit_code: 0 };
    b.putArtifact('record-r', 'r.mp4', Buffer.from('MP4'));
    const recipe = path.join(tmp, 'r.yaml');
    fs.writeFileSync(recipe, 'appId: x\n---\n- launchApp\n');
    const sink: import('../../../../mcp/mobile/types.js').VideoArtifact[] = [];
    await lb.runRecipe(recipe, {}, path.join(tmp, 'o'), { record: { recipeId: 'r', dispatchId: 'd' }, videoSink: sink });
    const rec = b.allExecArgv('record').map((a) => `${a[2]} ${a[a.indexOf('--name') + 1]}`);
    expect(rec).toEqual(['start r.mp4', 'stop old.mp4', 'start r.mp4', 'stop r.mp4']);
    expect(sink).toHaveLength(1);
  });

  it('record stop reporting s3-upload-failed is no video, not a throw', async () => {
    const b = new FakeBroker();
    const lb = backend(b);
    await lb.ensureAvdRunning('cc-2.63.0');
    b.cli.record = (argv) => (argv[2] === 'start'
      ? { ok: true, name: 'r.mp4' }
      : { ok: false, error: 's3-upload-failed', message: 'AccessDenied', upload_error: 'AccessDenied', name: 'r.mp4', key: 'r.mp4' });
    b.cli['run-recipe'] = { ok: true, exit_code: 0 };
    const recipe = path.join(tmp, 'r.yaml');
    fs.writeFileSync(recipe, 'appId: x\n---\n- launchApp\n');
    const sink: import('../../../../mcp/mobile/types.js').VideoArtifact[] = [];
    const r = await lb.runRecipe(recipe, {}, path.join(tmp, 'o'), { record: { recipeId: 'r', dispatchId: 'd' }, videoSink: sink });
    expect(r.status).toBe('pass');
    expect(sink).toEqual([]);
  });

  it('s3-download-failed names the instance-role / LeaseObjectScope cause', async () => {
    const b = new FakeBroker();
    const lb = backend(b);
    await lb.ensureAvdRunning('cc-2.63.0');
    b.cli['install-apk'] = { ok: false, error: 's3-download-failed', message: 'AccessDenied' };
    const err = await lb.installApk('x', 's3://cap-bucket/x.apk').catch((e) => e);
    expect(err.code).toBe('LEASE_CLI_S3_DOWNLOAD_FAILED');
    expect(err.remediation).toMatch(/LeaseObjectScope/);
  });
});
