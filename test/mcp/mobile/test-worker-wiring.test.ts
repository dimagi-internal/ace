// ace#2955 — the mobile client signs the device in as a pool worker it checked
// out, never a shared one; an explicit identity takes no lock; stop releases.
import { describe, it, expect, vi } from 'vitest';
import { MobileClient, withDeviceIdentity } from '../../../mcp/mobile/client.js';
import { TestWorkerCheckout } from '../../../lib/test-worker-lease.js';
import { FakeCanopyPool, legacyEnv, slotDataFor } from '../../fixtures/fake-canopy-pool.js';
import { derivePerRunTestUser } from '../../../lib/per-run-test-user.js';

const AVD = { name: 'AVD', serial: 'emulator-5554', status: 'booted' as const };
const VALIDATED = 'NetworkAgentInfo{ Capabilities: INTERNET VALIDATED NOT_METERED }';
const ENV = legacyEnv();
/** A slot's credentials as canopy-web's slot data holds them (what the lease hands over). */
const creds = (slot: string) => {
  const d = slotDataFor(slot);
  return { ...d.public, ...d.secret } as {
    phone: string; phoneLocal: string; countryCode: string; name: string; pin: string; backupCode: string;
  };
};

function makeClient(pool: FakeCanopyPool, opts: { lease?: boolean } = {}) {
  const shell = vi.fn(async (_cmd: string, args: string[]) => {
    if (args.includes('connectivity')) return { stdout: VALIDATED, stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 0 };
  });
  const avd: any = {
    getAdbShell: () => shell,
    listPackages: vi.fn().mockResolvedValue(['org.commcare.dalvik']),
    clearConnectAppData: vi.fn().mockResolvedValue(true),
    applyEnvironmentBaseline: vi.fn().mockResolvedValue('fp'),
    getFocusedActivity: vi.fn().mockResolvedValue(''),
    captureUiDump: vi.fn().mockResolvedValue(''),
    stopAvd: vi.fn().mockResolvedValue(undefined),
  };
  const workers = new TestWorkerCheckout({
    baseUrl: 'https://canopy.test',
    token: 'pat',
    fetchImpl: pool.fetch,
    env: ENV,
    backgroundHeartbeat: false,
    releaseOnExit: false,
    warn: () => {},
    retry: { retries: 0, sleepImpl: async () => {} },
  });
  const leaseFake: any = { clearAppData: vi.fn().mockResolvedValue(true), stopAvd: vi.fn().mockResolvedValue(undefined) };
  const client = new MobileClient({
    avd,
    lease: leaseFake,
    workers,
    bootstrapConfig: { apkVersion: '2.64.0', testUser: creds('worker-1') } as any,
  });
  Object.defineProperty(client, 'useLease', { get: () => opts.lease === true });
  const registerTestUser = vi.fn().mockResolvedValue({ alreadyRegistered: false });
  (client as any).registerTestUser = registerTestUser;
  const leaseRegisterTestUser = vi.fn().mockResolvedValue({ alreadyRegistered: false });
  (client as any).leaseRegisterTestUser = leaseRegisterTestUser;
  (client as any).settleAndClassifyLease = vi.fn().mockResolvedValue({ classified_as: 'ready' });
  (client as any).probeDeviceUserState = vi.fn().mockResolvedValue({ classified_as: 'ready', focused_activity: '' });
  return { client, registerTestUser, leaseRegisterTestUser, avd, leaseFake };
}

describe('local bootstrap', () => {
  it('no override: checks out a worker BEFORE registering, and registers as that worker', async () => {
    const pool = new FakeCanopyPool();
    pool.holdElsewhere('worker-1'); // another machine has worker-1
    const { client, registerTestUser } = makeClient(pool);
    await (client as any).runLocalBootstrap(AVD);
    expect(pool.calls[0]).toBe('POST /api/capabilities/leases');
    expect(registerTestUser).toHaveBeenCalledWith({ avdName: 'AVD', ...creds('worker-2') });
    expect(client.testWorkerReport()).toMatchObject({ lock: 'locked', signed_in: 'worker-2' });
  });

  it('a second bootstrap in the same session reuses the held worker (no second checkout)', async () => {
    const pool = new FakeCanopyPool();
    const { client, registerTestUser } = makeClient(pool);
    await (client as any).runLocalBootstrap(AVD);
    await (client as any).runLocalBootstrap(AVD);
    expect(pool.calls.filter((c) => c.startsWith('POST'))).toHaveLength(1);
    expect(registerTestUser.mock.calls[1][0].phone).toBe(creds('worker-1').phone);
  });

  it('an explicit testUser override takes NO lock and registers that identity', async () => {
    const pool = new FakeCanopyPool();
    const { client, registerTestUser } = makeClient(pool);
    const perRun = derivePerRunTestUser('20261015-0900');
    await (client as any).runLocalBootstrap(AVD, { testUser: perRun });
    expect(pool.calls).toEqual([]);
    expect(registerTestUser.mock.calls[0][0].phone).toBe(perRun.phone);
  });

  it('stopAvd releases every held worker, even when the stop throws', async () => {
    const pool = new FakeCanopyPool();
    const { client, avd } = makeClient(pool);
    await client.checkoutTestWorkers(3);
    expect(pool.heldSlots()).toHaveLength(3);
    avd.stopAvd.mockRejectedValueOnce(new Error('adb gone'));
    await expect(client.stopAvd('AVD')).rejects.toThrow('adb gone');
    expect(pool.heldSlots()).toEqual([]);
    expect(client.testWorkerReport().held).toEqual([]);
  });
});

describe('lease bootstrap', () => {
  it('no override: checks out a worker and registers the lease device as it', async () => {
    const pool = new FakeCanopyPool();
    pool.holdElsewhere('worker-1');
    const { client, leaseRegisterTestUser } = makeClient(pool, { lease: true });
    await (client as any).leaseBootstrapHeal(AVD, undefined);
    // The slot's own PIN from canopy-web — not the shared ACE_E2E_PIN.
    expect(leaseRegisterTestUser.mock.calls[0][0]).toMatchObject({ phone: creds('worker-2').phone, pin: creds('worker-2').pin });
    expect(creds('worker-2').pin).not.toBe(ENV.ACE_E2E_PIN);
  });

  it('override: no lock', async () => {
    const pool = new FakeCanopyPool();
    const { client, leaseRegisterTestUser } = makeClient(pool, { lease: true });
    const perRun = derivePerRunTestUser('20261015-0901');
    await (client as any).leaseBootstrapHeal(AVD, { testUser: perRun });
    expect(pool.calls).toEqual([]);
    expect(leaseRegisterTestUser.mock.calls[0][0].phone).toBe(perRun.phone);
  });

  it('stopAvd on the lease releases the workers too', async () => {
    const pool = new FakeCanopyPool();
    const { client, leaseFake } = makeClient(pool, { lease: true });
    await (client as any).leaseBootstrapHeal(AVD, undefined);
    await client.stopAvd('AVD');
    expect(leaseFake.stopAvd).toHaveBeenCalled();
    expect(pool.heldSlots()).toEqual([]);
  });
});

describe('multi-worker atoms', () => {
  it('register_test_user({slot}) refuses a slot this session does not hold', async () => {
    const pool = new FakeCanopyPool();
    const { client } = makeClient(pool);
    await expect(client.registerTestUserForAtom({ avdName: 'AVD', slot: 'worker-3' })).rejects.toMatchObject({
      code: 'TEST_WORKER_NOT_HELD',
    });
  });

  it('checkout k → register as each held slot → release the extras, keeping the signed-in one', async () => {
    const pool = new FakeCanopyPool();
    const { client, registerTestUser } = makeClient(pool);
    const report = await client.checkoutTestWorkers(4);
    expect(report.held.map((h) => h.slot)).toEqual(['worker-1', 'worker-2', 'worker-3', 'worker-4']);
    // The stubbed registerTestUser does not record identity; record it as the real one does.
    registerTestUser.mockImplementation(async (a: { phone: string }) => {
      (client as any).deviceIdentity = { slot: (client as any).heldSlotForPhone(a.phone), user: a };
      return { alreadyRegistered: false };
    });
    const r = await client.registerTestUserForAtom({ avdName: 'AVD', slot: 'worker-3' });
    expect(registerTestUser.mock.calls[0][0]).toEqual({ avdName: 'AVD', ...creds('worker-3') });
    expect(r.test_worker.signed_in).toBe('worker-3');
    const rel = await client.releaseTestWorkers();
    expect(rel.released?.sort()).toEqual(['worker-1', 'worker-2', 'worker-4']);
    expect(pool.heldSlots()).toEqual(['worker-3']);
    const all = await client.releaseTestWorkers({ all: true });
    expect(all.released).toEqual(['worker-3']);
    expect(all.signed_in).toBeNull();
  });

  it('register_test_user with no slot and no phone signs in as the session worker (locked)', async () => {
    const pool = new FakeCanopyPool();
    pool.holdElsewhere('worker-1');
    const { client, registerTestUser } = makeClient(pool);
    await client.registerTestUserForAtom({ avdName: 'AVD' });
    expect(registerTestUser.mock.calls[0][0].phone).toBe(creds('worker-2').phone);
  });

  it('register_test_user with an explicit phone takes no lock (the add-worker walk)', async () => {
    const pool = new FakeCanopyPool();
    const { client, registerTestUser } = makeClient(pool);
    await client.registerTestUserForAtom({ avdName: 'AVD', phone: '+74260000299', phoneLocal: '4260000299', countryCode: '+7', pin: '1', backupCode: '2' });
    expect(pool.calls).toEqual([]);
    expect(registerTestUser.mock.calls[0][0].phone).toBe('+74260000299');
  });

  it('the atom result never carries a backup code back out', async () => {
    const pool = new FakeCanopyPool();
    const { client, registerTestUser } = makeClient(pool);
    registerTestUser.mockResolvedValue({ alreadyRegistered: false, phone: '+74260000201', backupCode: creds('worker-1').backupCode });
    const r = await client.registerTestUserForAtom({ avdName: 'AVD' });
    expect(r.backupCode).toBe('***');
    expect(JSON.stringify(r)).not.toContain(creds('worker-1').backupCode);
    expect(JSON.stringify(r)).not.toContain(creds('worker-1').pin);
  });

  it('mobile_diagnose reports declared slots lacking data, from the masked list, without secrets', async () => {
    const pool = new FakeCanopyPool(['worker-1', 'worker-2']);
    pool.slotData.delete('worker-2');
    const { client, avd } = makeClient(pool);
    avd.diagnose = vi.fn().mockResolvedValue({ backend: 'local' });
    await client.checkoutTestWorkers(1);
    const d = await client.diagnose();
    expect(d.test_worker_slots).toMatchObject({ ok: false });
    expect(d.test_worker_slots!.summary).toContain('worker-2: no data');
    const text = JSON.stringify(d);
    expect(text).not.toContain(creds('worker-1').pin);
    expect(text).not.toContain(creds('worker-1').backupCode);
  });
});

describe('recipe env follows the signed-in worker', () => {
  it('a bootstrap records the worker the device signed in as', async () => {
    const pool = new FakeCanopyPool();
    pool.holdElsewhere('worker-1');
    const { client } = makeClient(pool);
    await (client as any).runLocalBootstrap(AVD);
    const identity = (client as any).deviceIdentity;
    expect(identity.slot).toBe('worker-2');
    expect(identity.user.phone).toBe(creds('worker-2').phone);
  });

  it('withDeviceIdentity fills PHONE/PIN/… from the identity, caller values winning', () => {
    const w2 = creds('worker-2');
    expect(withDeviceIdentity(w2, { OPP: 'x', PIN: '9' })).toEqual({
      PHONE: w2.phone,
      PHONE_LOCAL: w2.phoneLocal,
      COUNTRY_CODE: '+7',
      PIN: '9',
      BACKUP_CODE: w2.backupCode,
      NAME: w2.name,
      OPP: 'x',
    });
    const env = { A: '1' };
    expect(withDeviceIdentity(null, env)).toBe(env);
  });
});
