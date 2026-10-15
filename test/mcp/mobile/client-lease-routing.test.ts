// MobileClient routes to the lease backend when ACE_MOBILE_BACKEND=lease (or
// the deprecated `cloud` alias): the lease registers live every time (its
// machine is fresh from the image), honours a per-run test-user override, and
// supports set_location.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MobileClient } from '../../../mcp/mobile/client.js';
import { TEST_PHONE, TEST_PHONE_LOCAL } from '../../fixtures/test-phone.js';
import { fakeLeaseForHeal } from '../../fixtures/lease-screens.js';
import { getConfiguredApkVersion } from '../../../mcp/mobile/client.js';
import { listLiveSessionLocks } from '../../../mcp/mobile/session-lock.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ENV_TEST_USER = {
  phone: TEST_PHONE,
  phoneLocal: TEST_PHONE_LOCAL,
  countryCode: '+7',
  pin: '1234',
  backupCode: '123456789012',
  name: 'ACE Test',
};

function fakeLease(opts: Parameters<typeof fakeLeaseForHeal>[0] = {}) {
  return fakeLeaseForHeal(opts);
}

function makeClient(lease: ReturnType<typeof fakeLease> | null = fakeLease()) {
  const avd: any = { ensureAvdRunning: vi.fn(), setLocation: vi.fn(), diagnose: vi.fn() };
  const client = new MobileClient({
    avd,
    lease: lease as any,
    bootstrapConfig: { apkVersion: '2.63.2', testUser: ENV_TEST_USER } as any,
  });
  return { client, avd, lease };
}

describe('MobileClient on the lease backend', () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.ACE_MOBILE_BACKEND;
    process.env.ACE_MOBILE_BACKEND = 'lease';
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.ACE_MOBILE_BACKEND;
    else process.env.ACE_MOBILE_BACKEND = prev;
  });

  it('useLease is true; nothing reaches local', async () => {
    const { client, avd, lease } = makeClient();
    expect(client.useLease).toBe(true);
    await client.stopAvd('x');
    expect(await client.listAvds()).toEqual(['cc-2.64.0']);
    expect(lease!.stopAvd).toHaveBeenCalled();
    expect(avd.ensureAvdRunning).not.toHaveBeenCalled();
  });

  it('ensureAvdRunning acquires a fresh machine, registers live, and verifies it', async () => {
    const { client, lease } = makeClient();
    const info = await client.ensureAvdRunning('cc-2.64.0');
    expect(lease!.ensureAvdRunning).toHaveBeenCalledWith('cc-2.64.0');
    expect(lease!.clearAppData).not.toHaveBeenCalled();
    expect(lease!.registerTestUser).toHaveBeenCalledTimes(1);
    const reg = lease!.registerTestUser.mock.calls[0][0];
    expect(reg.phone).toBe(TEST_PHONE);
    expect(reg.toOtpRecipe).toBe('connect-register-to-otp.yaml');
    expect(reg.paletteTarB64.length).toBeGreaterThan(0);
    expect(reg.paletteKey).toMatch(/^[0-9a-f]{64}$/);
    expect(info.heal?.deviceUserState).toMatchObject({
      healed_via: 'lease-bootstrap',
      verified_as: 'ready',
      bootstrap_steps: ['app-data-clear-skipped-fresh-machine', 'registered', 'first-screen-settled'],
    });
    // The ensure result carries the lease facts, plus the heal's duration.
    expect(info.lease).toMatchObject({ lease_id: 'lease-1', idle_release_s: 900, state: 'cc-2.64.0' });
    expect(info.heal?.deviceUserState?.duration_s).toBeTypeOf('number');
  });

  it('a reused, already-ready lease is classified, not re-healed', async () => {
    const lease = fakeLease({ reused: true });
    const { client } = makeClient(lease);
    const info = await client.ensureAvdRunning('cc-2.64.0');
    expect(lease.registerTestUser).not.toHaveBeenCalled();
    expect(info.heal?.deviceUserState).toMatchObject({ healed_via: 'none', verified_as: 'ready' });
  });

  it('records the lease session in the session lock, so the same-opp warning can see it', async () => {
    const { client } = makeClient();
    await client.ensureAvdRunning('cc-2.64.0', { oppSlug: 'kmc-pilot', runId: '20261014-1200' });
    const mine = listLiveSessionLocks().find((l) => l.mcp_pid === process.pid);
    expect(mine).toMatchObject({ backend: 'lease', opp_slug: 'kmc-pilot', run_id: '20261014-1200', avd_name: 'lease:lease-1' });
    expect(mine?.adb_port).toBeUndefined();
  });

  function withParity(lease: ReturnType<typeof fakeLease>, extra: Record<string, unknown>) {
    const base = { name: 'cc-2.64.0', serial: 'lease:i-1', status: 'booted' };
    return lease.ensureAvdRunning.mockResolvedValue({
      ...base,
      lease: {
        lease_id: 'lease-1', instance_id: 'i-1', expires_at: null, idle_release_s: 900, state: 'cc-2.64.0',
        selector_map_version: '2.64.0', reused: false, cli_version: '1.1.0', image_baseline_fingerprint: null,
        expected_baseline_fingerprint: 'x', baseline_parity: 'unreported', long_poll: 'unknown', ...extra,
      },
    });
  }

  it('a baseline that is not `match` is re-applied over ace-mobile apply-baseline (no GPS fallback needed)', async () => {
    const lease = fakeLease();
    withParity(lease, { baseline_parity: 'mismatch', image_baseline_fingerprint: 'deadbeef0000' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { client } = makeClient(lease);
      const info = await client.ensureAvdRunning('cc-2.64.0');
      expect(lease.applyBaseline).toHaveBeenCalledTimes(1);
      expect(lease.setLocation).not.toHaveBeenCalled();
      expect(info.lease?.baseline_actions).toEqual(['baseline-mismatch', 'baseline-applied']);
      expect(warn.mock.calls.flat().join(' ')).toMatch(/baseline mismatch.*deadbeef0000/);
      // Applied BEFORE registration, as the local funnel orders it.
      expect(lease.applyBaseline.mock.invocationCallOrder[0]).toBeLessThan(lease.registerTestUser.mock.invocationCallOrder[0]);
    } finally {
      warn.mockRestore();
    }
  });

  it('a CLI without apply-baseline falls back to the default mock GPS fix', async () => {
    const lease = fakeLease();
    withParity(lease, { baseline_parity: 'unreported' });
    lease.applyBaseline.mockResolvedValue({ supported: false, ok: false, fingerprint: null, failed: [], clockSynced: null });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { client } = makeClient(lease);
      const info = await client.ensureAvdRunning('cc-2.64.0');
      expect(lease.setLocation).toHaveBeenCalledWith('cc-2.64.0', 8.5167, 12.0022, 480, 12);
      expect(info.lease?.baseline_actions).toEqual(['baseline-unreported', 'apply-baseline-unsupported', 'mock-location-set']);
    } finally {
      warn.mockRestore();
    }
  });

  it('a partial re-apply names the failed keys, and a failed GPS step still gets the GPS fallback', async () => {
    const lease = fakeLease();
    withParity(lease, { baseline_parity: 'incomplete', image_baseline_fingerprint: 'x', baseline_failed: ['mock_location_fix'] });
    lease.applyBaseline.mockResolvedValue({ supported: true, ok: false, fingerprint: 'x', failed: ['mock_location_fix'], clockSynced: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { client } = makeClient(lease);
      const info = await client.ensureAvdRunning('cc-2.64.0');
      expect(info.lease?.baseline_actions).toEqual(['baseline-incomplete', 'baseline-partial:mock_location_fix', 'mock-location-set']);
    } finally {
      warn.mockRestore();
    }
  });

  it('a reused machine the client already re-applied the baseline to is not re-applied', async () => {
    const lease = fakeLease({ reused: true });
    withParity(lease, { baseline_parity: 'mismatch', reused: true });
    lease.baselineAppliedFingerprint = 'x';
    const { client } = makeClient(lease);
    const info = await client.ensureAvdRunning('cc-2.64.0');
    expect(lease.applyBaseline).not.toHaveBeenCalled();
    expect(info.lease?.baseline_actions).toEqual(['baseline-mismatch', 'baseline-already-applied']);
  });

  it('prewarm starts the lease acquire and returns at once — no heal, no registration', async () => {
    const { client, lease } = makeClient();
    const r = await client.prewarmAvd('ACE_Pixel_API_34');
    expect(r).toMatchObject({ backend: 'lease', prewarm: 'started' });
    expect(r.note).toMatch(/900 s/);
    expect(lease!.prewarm).toHaveBeenCalledWith('ACE_Pixel_API_34');
    expect(lease!.ensureAvdRunning).not.toHaveBeenCalled();
    expect(lease!.registerTestUser).not.toHaveBeenCalled();
  });

  it('records the lease walk: record opts go to the lease, the video is normalized, returned and spooled', async () => {
    const lease = fakeLease();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-rec-'));
    const recipe = path.join(dir, 'journey-learn.yaml');
    fs.writeFileSync(recipe, 'appId: org.commcare.dalvik\n---\n- launchApp\n');
    lease.runRecipe.mockImplementation(async (_p: string, _e: unknown, outDir: string, o: any) => {
      if (!o.record) return { status: 'pass', exitCode: 0, stdout: '', stderr: '', screenshotsDir: outDir, screenshots: [] };
      const mp4 = path.join(outDir, `${o.record.recipeId}.mp4`);
      fs.writeFileSync(mp4, 'MP4');
      o.videoSink.push({ path: mp4, bytes: 3, recipeId: o.record.recipeId, dispatchId: o.record.dispatchId, attempt: 1 });
      return { status: 'pass', exitCode: 0, stdout: '', stderr: '', screenshotsDir: outDir, screenshots: [] };
    });
    const spooled: string[] = [];
    const normalize = vi.fn().mockResolvedValue(false);
    const client = new MobileClient({
      avd: {} as any,
      lease: lease as any,
      bootstrapConfig: null,
      recorder: { start: vi.fn(), stop: vi.fn(), normalize } as any,
      spool: { video: (v: any) => { spooled.push(v.path); }, list: () => [], dir: () => dir, clear: () => 0, count: () => 0 } as any,
    } as any);
    const saved = process.env.ACE_MOBILE_RECORD;
    const savedRoot = process.env.ACE_SCREENSHOT_ROOT;
    process.env.ACE_SCREENSHOT_ROOT = os.tmpdir();
    delete process.env.ACE_MOBILE_RECORD;
    try {
      const r = await client.runRecipe(recipe, {}, path.join(dir, 'out'), 'cc-2.64.0');
      const o = lease.runRecipe.mock.calls[0][3];
      expect(o.record).toMatchObject({ recipeId: 'journey-learn', bitRate: '1M', size: '540x1140' });
      expect(o.record.dispatchId).toBeTruthy();
      expect(normalize).toHaveBeenCalledTimes(1);
      expect(r.videos).toHaveLength(1);
      expect(r.videos![0]).toMatchObject({ recipeId: 'journey-learn', attempt: 1 });
      expect(r.videos![0].path).toBe(path.join(dir, 'out', 'journey-learn', 'journey-learn.mp4'));
      expect(r.videos![0].provenance?.recipe_id).toBe('journey-learn');
      expect(spooled).toEqual([r.videos![0].path]);

      process.env.ACE_MOBILE_RECORD = 'off';
      await client.runRecipe(recipe, {}, path.join(dir, 'out2'), 'cc-2.64.0');
      expect(lease.runRecipe.mock.calls[1][3].record).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.ACE_MOBILE_RECORD;
      else process.env.ACE_MOBILE_RECORD = saved;
      if (savedRoot === undefined) delete process.env.ACE_SCREENSHOT_ROOT;
      else process.env.ACE_SCREENSHOT_ROOT = savedRoot;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('state ↔ selector-map parity: the client leases the CommCare its selector map is for', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-parity-'));
    const saved = process.env.ACE_ENV_FILE;
    process.env.ACE_ENV_FILE = path.join(dir, '.env');
    fs.writeFileSync(process.env.ACE_ENV_FILE, 'CANOPY_WEB_PAT=test-pat\n');
    try {
      const client = new MobileClient({ avd: {} as any, maestro: {} as any, bootstrapConfig: null });
      const v = getConfiguredApkVersion();
      expect(client.lease!.resolveState('ACE_Pixel_API_34')).toBe(`cc-${v}`);
      expect(fs.existsSync(path.resolve(__dirname, `../../../mcp/mobile/selectors/connect-${v}.yaml`))).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.ACE_ENV_FILE;
      else process.env.ACE_ENV_FILE = saved;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('honours a per-run test-user override', async () => {
    const { client, lease } = makeClient();
    await client.ensureAvdRunning('cc-2.64.0', { testUser: { phone: '+74269990001', name: 'Run User' } });
    const reg = lease!.registerTestUser.mock.calls[0][0];
    expect(reg.phone).toBe('+74269990001');
    expect(reg.name).toBe('Run User');
    expect(reg.pin).toBe(ENV_TEST_USER.pin);
  });

  it('set_location routes to the lease', async () => {
    const { client, lease } = makeClient();
    await client.setLocation('x', 36.8, -1.3);
    expect(lease!.setLocation).toHaveBeenCalledWith('x', 36.8, -1.3, undefined, undefined);
  });

  it('diagnose is tagged backend: lease', async () => {
    const { client } = makeClient();
    expect(await client.diagnose()).toMatchObject({ backend: 'lease', lease: null });
  });

  it('a missing PAT fails loud with LEASE_NOT_CONFIGURED before any boot', async () => {
    const { client, avd } = makeClient(null);
    await expect(client.ensureAvdRunning('cc-2.63.0')).rejects.toMatchObject({ code: 'LEASE_NOT_CONFIGURED' });
    expect(avd.ensureAvdRunning).not.toHaveBeenCalled();
  });
});

describe('MobileClient on the deprecated cloud alias routes to the lease', () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.ACE_MOBILE_BACKEND;
    process.env.ACE_MOBILE_BACKEND = 'cloud';
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.ACE_MOBILE_BACKEND;
    else process.env.ACE_MOBILE_BACKEND = prev;
  });

  it('useLease is true and set_location reaches the lease', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { client, lease } = makeClient();
      expect(client.useLease).toBe(true);
      await client.setLocation('x', 1, 2);
      expect(lease!.setLocation).toHaveBeenCalledWith('x', 1, 2, undefined, undefined);
    } finally {
      warn.mockRestore();
    }
  });
});
