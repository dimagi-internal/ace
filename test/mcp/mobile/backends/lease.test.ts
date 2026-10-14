// LeaseBackend against a fake canopy-web broker (mocked fetch). Covers the
// lease lifecycle (acquire → queued → provisioning → ready → release), reuse,
// the typed failure codes, every CLI op's argv, and the on-disk artifact
// layout (the same files and ScreenshotEntry shape the retired ace-web cloud
// backend produced, pinned here now that there is no second backend to diff).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LeaseBackend } from '../../../../mcp/mobile/backends/lease.js';
import { MobileError, AvdBootError } from '../../../../mcp/mobile/errors.js';

const BASE = 'https://canopy.test';
const TOKEN = 'ace-canopy-pat';
const BUCKET = 'cap-bucket';

type Json = Record<string, unknown>;
interface Call {
  method: string;
  url: string;
  path: string;
  body?: unknown;
  auth?: string | null;
}

function json(status: number, body: unknown): Response {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * A scriptable fake broker. `leaseStates` is the sequence of lease statuses
 * successive GETs return (the last one repeats). `cli` maps a subcommand to
 * the JSON line the in-VM CLI prints.
 */
class FakeBroker {
  calls: Call[] = [];
  leaseStates: Json[] = [{ status: 'ready' }];
  acquireResponse: { status: number; body: unknown } | null = null;
  onAcquire: (() => void) | null = null;
  cli: Record<string, Json> = {};
  execStatus = 'Success';
  artifactKeys: Record<string, Array<{ key: string; content_type?: string }>> = {};
  objects = new Map<string, Buffer>();
  puts = new Map<string, Buffer>();
  private leaseSeq = 0;
  private getCount = 0;
  private execSeq = 0;
  private execs = new Map<string, string[]>();
  released: string[] = [];

  fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const u = new URL(url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    let body: unknown;
    if (typeof init?.body === 'string') body = JSON.parse(init.body);
    else if (init?.body) body = init.body;
    this.calls.push({ method, url, path: u.pathname, body, auth: headers.get('authorization') });

    // Presigned S3 traffic.
    if (u.host === 's3.test') {
      if (method === 'PUT') {
        this.puts.set(u.pathname, Buffer.from(init!.body as Uint8Array));
        return new Response('', { status: 200 });
      }
      const b = this.objects.get(u.pathname);
      return b ? new Response(new Uint8Array(b), { status: 200 }) : new Response('nope', { status: 404 });
    }

    const p = u.pathname;
    if (method === 'POST' && p === '/api/capabilities/leases') {
      if (this.acquireResponse) return json(this.acquireResponse.status, this.acquireResponse.body);
      const id = `lease-${++this.leaseSeq}`;
      this.getCount = 0;
      this.onAcquire?.();
      return json(200, { lease_id: id, status: 'provisioning', ready: false, position: null, reason: '', ready_info: {} });
    }
    let m = p.match(/^\/api\/capabilities\/leases\/([^/]+)$/);
    if (m && method === 'GET') {
      const st = this.leaseStates[Math.min(this.getCount++, this.leaseStates.length - 1)];
      // canopy-web CapabilityLeaseOut: `ready` is a bool, ready.json is `ready_info`.
      return json(200, {
        lease_id: m[1], instance_id: 'i-0abc', expires_at: '2026-10-14T20:00:00Z', position: null,
        reason: '', ready_info: {}, idle_release_s: 900, ...st, ready: st.status === 'ready',
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
        uploads: names.map((n) => ({
          name: n,
          put_url: `https://s3.test/in/${n}`,
          s3_uri: `s3://${BUCKET}/leases/${m![1]}/in/${n}`,
        })),
      });
    }
    m = p.match(/^\/api\/capabilities\/leases\/([^/]+)\/exec$/);
    if (m && method === 'POST') {
      const id = `cmd-${++this.execSeq}`;
      this.execs.set(id, (body as { argv: string[] }).argv);
      return json(200, { lease_id: m[1], exec_id: id, timeout_s: (body as { timeout_s: number }).timeout_s });
    }
    m = p.match(/^\/api\/capabilities\/leases\/([^/]+)\/exec\/([^/]+)$/);
    if (m && method === 'GET') {
      const argv = this.execs.get(m[2])!;
      const sub = argv[1];
      const line = this.cli[sub] ?? { ok: true };
      return json(200, {
        exec_id: m[2],
        status: line.ok === false ? 'Failed' : this.execStatus,
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
        const s3path = `/out/${prefix}${a.key}`;
        // canopy-web CapabilityArtifactOut: `path` is relative to leases/<id>/out/; no content type.
        return { path: `${prefix}${a.key}`, size: 1, url: `https://s3.test${s3path}` };
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
              params: { state: { type: 'string', default: 'cc-2.63.0', enum: ['cc-2.62.0', 'cc-2.63.0'] } },
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
    const argvs = [...this.execs.values()].filter((a) => a[1] === sub);
    return argvs[argvs.length - 1];
  }
  callsTo(method: string, re: RegExp): Call[] {
    return this.calls.filter((c) => c.method === method && re.test(c.path));
  }
  /** Serve an object at the presigned URL the artifacts route will hand out. */
  putArtifact(sub: string, key: string, bytes: Buffer, contentType?: string) {
    (this.artifactKeys[sub] ??= []).push({ key, content_type: contentType });
    this.objectsByKey.set(`${sub}|${key}`, bytes);
  }
  objectsByKey = new Map<string, Buffer>();
}

/** Route artifact GETs (whose prefix carries a random slug) back to putArtifact bytes. */
function withArtifactBytes(b: FakeBroker): typeof fetch {
  return async (input, init) => {
    const u = new URL(String(input));
    if (u.host === 's3.test' && u.pathname.startsWith('/out/') && (init?.method ?? 'GET') === 'GET') {
      const rest = u.pathname.slice('/out/'.length);
      const slash = rest.indexOf('/');
      const sub = rest.slice(0, slash).replace(/-[a-z0-9]+$/, '');
      const key = rest.slice(slash + 1);
      const bytes = b.objectsByKey.get(`${sub}|${key}`);
      b.calls.push({ method: 'GET', url: String(input), path: u.pathname });
      return bytes ? new Response(new Uint8Array(bytes), { status: 200 }) : new Response('missing', { status: 404 });
    }
    return b.fetch(input, init);
  };
}

function backend(b: FakeBroker, extra: Partial<ConstructorParameters<typeof LeaseBackend>[0]> = {}) {
  return new LeaseBackend({
    baseUrl: BASE,
    token: TOKEN,
    fetchImpl: withArtifactBytes(b),
    pollIntervalMs: 0,
    retry: { retries: 0 },
    releaseOnExit: false,
    sleepImpl: async () => {},
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
      const lb = new LeaseBackend({ baseUrl: BASE, fetchImpl: b.fetch, pollIntervalMs: 0, releaseOnExit: false, sleepImpl: async () => {} });
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
    b.leaseStates = [
      { status: 'provisioning' },
      { status: 'provisioning' },
      { status: 'ready', ready_info: { ok: true, timings: { emulator_boot_s: 70 }, accel: 'kvm', cli_version: '1.0.0' } },
    ];
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
    expect(info.serial).toBe('lease:i-0abc');
    expect(info.name).toBe('cc-2.62.0');
    expect(info.accel).toBe('kvm');
    expect(info.timings).toMatchObject({ emulator_boot_s: 70, lease_queue_s: 0 });
    expect(lb.leaseId).toBe('lease-1');
  });

  it('omits params when the AVD name is not a cc-* state (manifest default applies)', async () => {
    const b = new FakeBroker();
    await backend(b).ensureAvdRunning('ACE_Pixel_API_34');
    expect(b.callsTo('POST', /leases$/)[0].body).toEqual({ agent: 'ace', capability: 'android-emulator' });
  });

  it('reuses a live ready lease for the same state', async () => {
    const b = new FakeBroker();
    const lb = backend(b);
    await lb.ensureAvdRunning('cc-2.63.0');
    await lb.ensureAvdRunning('cc-2.63.0');
    expect(b.callsTo('POST', /leases$/)).toHaveLength(1);
    expect(b.released).toEqual([]);
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

describe('LeaseBackend queueing and failure codes', () => {
  it('waits while queued, logging the position, then proceeds', async () => {
    const b = new FakeBroker();
    b.acquireResponse = { status: 200, body: { lease_id: 'lease-q', status: 'queued', position: 3, ready: false, ready_info: {} } };
    b.leaseStates = [
      { status: 'queued', position: 2 },
      { status: 'queued', position: 1 },
      { status: 'provisioning' },
      { status: 'ready', ready_info: { ok: true } },
    ];
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
    await expect(backend(b).ensureAvdRunning('cc-9.9.9')).rejects.toMatchObject({ code: 'LEASE_INVALID_REQUEST' });
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
    b.leaseStates = [{ status: 'ready', ready_info: { ok: false, reason: 'register-part-a-failed' } }];
    await expect(backend(b).ensureAvdRunning('cc-2.63.0')).rejects.toMatchObject({
      code: 'LEASE_READINESS_FAILED',
      message: expect.stringContaining('register-part-a-failed'),
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

  it('LEASE_LOST when the lease expires before ready', async () => {
    const b = new FakeBroker();
    b.leaseStates = [{ status: 'expired', reason: 'swept' }];
    await expect(backend(b).ensureAvdRunning('cc-2.63.0')).rejects.toMatchObject({ code: 'LEASE_LOST' });
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
    let t = 0;
    const lb = backend(b, {
      heartbeatMs: 1,
      now: () => (t += 10),
      fetchImpl: async (input, init) => {
        const u = new URL(String(input));
        if (/\/exec\/[^/]+$/.test(u.pathname)) return json(200, { exec_id: 'c', status: 'InProgress', done: false });
        return b.fetch(input, init);
      },
    });
    await lb.ensureAvdRunning('cc-2.63.0');
    b.leaseStates = [{ status: 'expired', reason: 'idle' }];
    (b as unknown as { getCount: number }).getCount = 0;
    await expect(lb.repairDriver()).rejects.toMatchObject({ code: 'LEASE_LOST' });
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

  it('installApk uploads a local path and passes the s3 URI', async () => {
    const { b, lb } = await ready();
    const apk = path.join(tmp, 'commcare-2.63.0.apk');
    fs.writeFileSync(apk, Buffer.from('PK\x03\x04apk-bytes'));
    b.cli['install-apk'] = { ok: true, package_name: 'org.commcare.dalvik', version: '2.63.0', version_code: 263 };
    const info = await lb.installApk('x', apk);
    expect(b.callsTo('POST', /\/uploads$/)[0].body).toEqual({ names: ['commcare-2.63.0.apk'] });
    expect(b.puts.get('/in/commcare-2.63.0.apk')?.toString()).toBe('PK\x03\x04apk-bytes');
    expect(b.execArgv('install-apk')).toEqual(['ace-mobile', 'install-apk', '--apk', `s3://${BUCKET}/leases/lease-1/in/commcare-2.63.0.apk`]);
    expect(info).toEqual({ packageId: 'org.commcare.dalvik', versionName: '2.63.0', versionCode: 263, path: apk });
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

  it('registerTestUser ships creds in an uploaded --creds JSON, never argv', async () => {
    const { b, lb } = await ready();
    b.cli['register-test-user'] = { ok: true, already_registered: false, phone: '+74260000001', backup_code: '12345678' };
    const r = await lb.registerTestUser({
      phone: '+74260000001', phoneLocal: '4260000001', countryCode: '+7', pin: '135790', backupCode: '12345678', name: 'ACE Test',
      paletteTarB64: Buffer.from('tar').toString('base64'), toOtpRecipe: 'connect-register-to-otp.yaml', fromOtpRecipe: 'connect-register-from-otp.yaml',
    });
    const argv = b.execArgv('register-test-user');
    expect(argv.join(' ')).not.toContain('135790');
    expect(argv).toEqual(expect.arrayContaining(['--to-otp-recipe', 'connect-register-to-otp.yaml', '--from-otp-recipe', 'connect-register-from-otp.yaml', '--creds', '--palette', '--out']));
    const credsPut = [...b.puts.entries()].find(([k]) => k.endsWith('--creds.json'))!;
    expect(JSON.parse(credsPut[1].toString())).toEqual({
      phone: '+74260000001', phone_local: '4260000001', country_code: '+7', pin: '135790', backup_code: '12345678', name: 'ACE Test',
    });
    expect(r).toEqual({ alreadyRegistered: false, phone: '+74260000001', backupCode: '12345678' });
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

  it('diagnose never acquires: no lease → a note, not a machine', async () => {
    const b = new FakeBroker();
    const d = await backend(b).diagnose();
    expect(d.lease).toBeNull();
    expect(b.callsTo('POST', /leases$/)).toHaveLength(0);
  });

  it('diagnose with a lease returns the CLI snapshot plus the lease view', async () => {
    const { b, lb } = await ready();
    b.cli['diagnose'] = { ok: true, healthy: true, adb_devices: [{ serial: 'emulator-5554', state: 'device' }], adb_visible_count: 1 };
    const d = await lb.diagnose();
    expect(d).toMatchObject({ healthy: true, adb_visible_count: 1, lease: { lease_id: 'lease-1', status: 'ready', instance_id: 'i-0abc' } });
    expect(b.execArgv('diagnose')).toEqual(['ace-mobile', 'diagnose']);
  });

  it('listAvds reads the manifest state enum (read-only)', async () => {
    const b = new FakeBroker();
    expect(await backend(b).listAvds()).toEqual(['cc-2.62.0', 'cc-2.63.0']);
    expect(b.callsTo('POST', /leases$/)).toHaveLength(0);
  });

  it('uninstallApk is typed LEASE_UNSUPPORTED', async () => {
    const { lb } = await ready();
    await expect(lb.uninstallApk('x', 'p')).rejects.toMatchObject({ code: 'LEASE_UNSUPPORTED' });
  });
});

describe('LeaseBackend.runRecipe', () => {
  const PNG = Buffer.from('\x89PNG fake');

  async function run(b: FakeBroker, recipeLine: Json) {
    const lb = backend(b);
    await lb.ensureAvdRunning('cc-2.63.0');
    b.cli['run-recipe'] = recipeLine;
    const recipe = path.join(tmp, 'learn-smoke.yaml');
    fs.writeFileSync(recipe, 'appId: org.commcare.dalvik\n---\n- launchApp\n');
    const out = path.join(tmp, 'shots');
    const r = await lb.runRecipe(recipe, { PIN: '1234', NAME: 'A B' }, out, {
      paletteTarB64: Buffer.from('palette-tar').toString('base64'),
    });
    return { lb, r, out };
  }

  it('uploads recipe + palette, execs run-recipe with --env and --out, downloads artifacts', async () => {
    const b = new FakeBroker();
    b.putArtifact('run-recipe', '01-home.png', PNG, 'image/png');
    b.putArtifact('run-recipe', 'maestro-stdout.log', Buffer.from('log'));
    b.putArtifact('run-recipe', 'result.json', Buffer.from('{}'));
    const { r, out } = await run(b, {
      ok: true, exit_code: 0, stdout: 'Flow passed', stderr: '',
      steps: [{ index: 0, name: 'launchApp', status: 'pass', duration_ms: 1200 }],
    });

    const uploads = b.callsTo('POST', /\/uploads$/);
    const names = (uploads[uploads.length - 1].body as { names: string[] }).names;
    expect(names).toHaveLength(2);
    expect(names[0]).toMatch(/--learn-smoke\.yaml$/);
    expect(names[1]).toMatch(/--palette\.tar\.gz$/);
    expect([...b.puts.values()].map((v) => v.toString())).toContain('palette-tar');

    const argv = b.execArgv('run-recipe');
    expect(argv.slice(0, 2)).toEqual(['ace-mobile', 'run-recipe']);
    expect(argv[argv.indexOf('--recipe') + 1]).toMatch(new RegExp(`^s3://${BUCKET}/leases/lease-1/in/.*learn-smoke\\.yaml$`));
    expect(argv.filter((a, i) => argv[i - 1] === '--env')).toEqual(['PIN=1234', 'NAME=A B']);
    expect(argv[argv.indexOf('--out') + 1]).toMatch(new RegExp(`^s3://${BUCKET}/leases/lease-1/out/run-recipe-[a-z0-9]+/$`));

    expect(r.status).toBe('pass');
    expect(r.stdout).toBe('Flow passed');
    expect(r.steps).toEqual([{ index: 0, name: 'launchApp', status: 'pass', screenshot: undefined, error: undefined, durationMs: 1200 }]);
    expect(fs.readdirSync(out).sort()).toEqual(['01-home.png', 'maestro-stdout.log', 'result.json']);
    expect(r.screenshots).toHaveLength(1);
    expect(r.screenshots[0]).toMatchObject({ stepName: '01-home', path: path.join(out, '01-home.png'), bytes: PNG.length });
  });

  it('a Maestro failure (ok:false, error recipe-failed) is a fail RESULT with diagnostics, not a throw', async () => {
    const b = new FakeBroker();
    b.cli['diagnose'] = { ok: true, healthy: true, adb_visible_count: 1 };
    const { r } = await run(b, { ok: false, exit_code: 1, error: 'recipe-failed', message: 'maestro exited 1', stdout: '', stderr: 'Element not found: Id matching regex: next' });
    expect(r.status).toBe('fail');
    expect(r.exitCode).toBe(1);
    expect(r.failure?.failureClass).toBe('selector-not-found');
    expect(r.diagnostics).toMatchObject({ healthy: true });
  });

  it('flattens nested keys to basenames, as ace-web named them', async () => {
    const b = new FakeBroker();
    b.putArtifact('run-recipe', '.maestro/tests/2026/commands-x.json', Buffer.from('[]'));
    const { out } = await run(b, { ok: true, exit_code: 0, stdout: '', stderr: '' });
    expect(fs.readdirSync(out)).toEqual(['commands-x.json']);
  });

  it('artifact download shape: files land by basename, images become ScreenshotEntry', async () => {
    const b = new FakeBroker();
    b.putArtifact('run-recipe', '01-home.png', PNG, 'image/png');
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

  it('reads result.json when the inline stdout line was truncated', async () => {
    const b = new FakeBroker();
    const full = { ok: true, exit_code: 0, stdout: 'from result.json', stderr: '' };
    b.putArtifact('run-recipe', 'result.json', Buffer.from(JSON.stringify(full)));
    const lb = backend(b, {
      fetchImpl: async (input, init) => {
        const u = new URL(String(input));
        if (/\/exec\/[^/]+$/.test(u.pathname)) {
          return json(200, { exec_id: 'c', status: 'Success', done: true, exit_code: 0, stdout_tail: '{"ok":true,"exit_code":0,"stdout":"cut', stderr_tail: '', stdout_url: null });
        }
        return withArtifactBytes(b)(input, init);
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
    b.putArtifact('run-recipe', 'ok.png', PNG, 'image/png');
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

  it('404 on the agent route is LEASE_AGENT_NOT_VISIBLE; 404 on a lease is LEASE_NOT_FOUND', async () => {
    const b = new FakeBroker();
    b.acquireResponse = { status: 404, body: { title: "agent 'ace' not found", detail: "agent 'ace' not found", status: 404 } };
    await expect(backend(b).ensureAvdRunning('cc-2.63.0')).rejects.toMatchObject({ code: 'LEASE_AGENT_NOT_VISIBLE' });
  });

  it('409 (exec on a lease that is no longer ready) is LEASE_LOST', async () => {
    const b = new FakeBroker();
    const lb = backend(b, {
      fetchImpl: async (input, init) => {
        if (/\/exec$/.test(new URL(String(input)).pathname)) {
          const t = 'lease x is expired; exec needs a ready lease';
          return json(409, { title: t, detail: t, status: 409 });
        }
        return b.fetch(input, init);
      },
    });
    await lb.ensureAvdRunning('cc-2.63.0');
    await expect(lb.repairDriver()).rejects.toMatchObject({ code: 'LEASE_LOST' });
  });

  it('derives the --out prefix from the upload s3_uri (the lease JSON carries none)', async () => {
    const b = new FakeBroker();
    const lb = backend(b);
    await lb.ensureAvdRunning('cc-2.63.0');
    b.cli['register-test-user'] = { ok: true, already_registered: true, phone: '+7426', backup_code: null };
    await lb.registerTestUser({
      phone: '+74260000001', phoneLocal: '4260000001', countryCode: '+7', pin: '1', backupCode: '2', name: 'n',
      paletteTarB64: '', toOtpRecipe: 'a.yaml', fromOtpRecipe: 'b.yaml',
    });
    const argv = b.execArgv('register-test-user');
    expect(argv[argv.indexOf('--out') + 1]).toMatch(new RegExp(`^s3://${BUCKET}/leases/lease-1/out/register-test-user-`));
    // No probe upload was needed: the real uploads supplied the prefix.
    expect(b.callsTo('POST', /\/uploads$/)).toHaveLength(1);
  });
});
