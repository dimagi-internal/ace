import { describe, it, expect, vi } from 'vitest';
import { MobileClient } from '../../../mcp/mobile/client.js';
import { MaestroBackend } from '../../../mcp/mobile/backends/maestro.js';
import { TEST_PHONE, TEST_PHONE_LOCAL } from '../../fixtures/test-phone.js';

/**
 * dimagi-internal/ace#1818 — bednet-check-2-visit/20260828-0629.
 *
 * Two defects, one root cause. `mobile_probe_maestro_driver` reported
 * `healthy: true` on a serial whose `pm list packages` had no
 * `dev.mobile.maestro` at all; because `assertMaestroDriverHealthy`
 * early-returns on a healthy stage-1 probe, that verdict SKIPPED the only
 * driver-install path in the heal funnel. The bootstrap then drove
 * `connect-register-to-otp.yaml` at a device with no gRPC server, wedged
 * for the full 600s chunk budget, and named the RECIPE as the fault —
 * four wrong diagnoses before the truth.
 *
 * The invariants pinned here:
 *   1. `healthy` requires the driver PACKAGES on THIS serial, not just a
 *      zero exit from `maestro hierarchy` (which runs over a host-keyed
 *      direct-TCP port and cannot distinguish devices).
 *   2. A driver-package absence must NOT be short-circuited by a passing
 *      liveness probe — install runs anyway.
 *   3. ace#1155 still holds: a FAILED package query is not an absence.
 *   4. `runLocalBootstrap` verifies the CommCare install rather than
 *      assuming it, and refuses to reach the registration recipe without it.
 *   5. The reported port is labelled: it is the emulator's own adbd port,
 *      not the adb SERVER port `mobile_diagnose` reports.
 */

const PRESENT = { app: true, test: true, queryOk: true };
const ABSENT = { app: false, test: false, queryOk: true };
const UNANSWERABLE = { app: false, test: false, queryOk: false };

function makeDriverClient(opts: {
  packages: { app: boolean; test: boolean; queryOk: boolean };
  probeReturns: Array<{ healthy: boolean; reason?: string }>;
}) {
  const maestro = {
    driverPackagesInstalled: vi.fn(async () => opts.packages),
    probeDriver: vi.fn(async () => {
      const next = opts.probeReturns.shift();
      if (!next) throw new Error('probeDriver called more times than scripted');
      return next;
    }),
    ensureDriverInstalled: vi.fn(async () => ['installed:app', 'installed:test']),
    repairDriver: vi.fn(async () => ['force-stop', 'uninstall', 'installed:app']),
  } as any;
  const client = new MobileClient({ avd: {} as any, maestro });
  return { client, maestro };
}

describe('probeMaestroDriver — health is an observation, not a guess (ace#1818)', () => {
  it('reports UNHEALTHY when the driver packages are absent, even though `maestro hierarchy` exits 0', async () => {
    // The exact live shape: the liveness probe would say healthy.
    const { client, maestro } = makeDriverClient({
      packages: ABSENT,
      probeReturns: [{ healthy: true }],
    });
    const r = await client.probeMaestroDriver('emulator-5558', 90_000);
    expect(r.healthy).toBe(false);
    expect(r.reason).toMatch(/dev\.mobile\.maestro/);
    expect(r.driverPackages).toEqual(ABSENT);
    // And it must not have paid for the liveness probe at all — the
    // package answer already settles it.
    expect(maestro.probeDriver).not.toHaveBeenCalled();
  });

  it('reports healthy when the packages are present AND the liveness probe passes', async () => {
    const { client } = makeDriverClient({ packages: PRESENT, probeReturns: [{ healthy: true }] });
    const r = await client.probeMaestroDriver('emulator-5558');
    expect(r.healthy).toBe(true);
    expect(r.driverPackages).toEqual(PRESENT);
  });

  it('does NOT manufacture an absence when the package query itself fails (ace#1155)', async () => {
    const { client, maestro } = makeDriverClient({
      packages: UNANSWERABLE,
      probeReturns: [{ healthy: true }],
    });
    const r = await client.probeMaestroDriver('emulator-5558');
    // The liveness verdict still stands...
    expect(r.healthy).toBe(true);
    expect(maestro.probeDriver).toHaveBeenCalledTimes(1);
    // ...but it is flagged as unverified rather than presented as fact.
    expect(r.reason).toMatch(/UNVERIFIED/);
    expect(r.driverPackages?.queryOk).toBe(false);
  });

  it('labels the port it reports as the emulator adbd port, not the adb SERVER port', async () => {
    const { client } = makeDriverClient({ packages: PRESENT, probeReturns: [{ healthy: true }] });
    const r = await client.probeMaestroDriver('emulator-5558');
    // emulator-5558 -> 5559 is the emulator's own adbd port (the direct-TCP
    // channel Maestro dials); mobile_diagnose's adb_server_port is a
    // different, separately allocated number. Both are correct; the label
    // is what stops the two being read as a contradiction.
    expect(r.adbPort).toBe(5559);
    expect(r.portKind).toBe('emulator-adbd-direct-tcp');
  });

  it('carries the port label through the non-emulator (real device) refusal', async () => {
    const { client } = makeDriverClient({ packages: PRESENT, probeReturns: [] });
    const r = await client.probeMaestroDriver('abc123def');
    expect(r.healthy).toBe(false);
    expect(r.adbPort).toBeNull();
    expect(r.portKind).toBeNull();
    expect(r.driverPackages).toBeNull();
  });
});

describe('assertMaestroDriverHealthy — a passing probe must not skip a missing install (ace#1818)', () => {
  it('installs the driver when the packages are absent, even if the liveness probe would pass', async () => {
    const { client, maestro } = makeDriverClient({
      packages: ABSENT,
      // Stage 1 is skipped entirely; this is the post-install re-probe.
      probeReturns: [{ healthy: true }],
    });
    await expect(client.assertMaestroDriverHealthy('emulator-5558')).resolves.toBeUndefined();
    expect(maestro.ensureDriverInstalled).toHaveBeenCalledWith('emulator-5558');
    // Exactly one probe, and it is the 90s post-install one — the 20s
    // stage-1 probe never ran, because the package answer made it moot.
    expect(maestro.probeDriver).toHaveBeenCalledTimes(1);
    expect(maestro.probeDriver).toHaveBeenCalledWith(5559, 90_000);
  });

  it('still early-returns without installing when the packages are present and the probe is healthy', async () => {
    const { client, maestro } = makeDriverClient({
      packages: PRESENT,
      probeReturns: [{ healthy: true }],
    });
    await expect(client.assertMaestroDriverHealthy('emulator-5558')).resolves.toBeUndefined();
    expect(maestro.probeDriver).toHaveBeenCalledWith(5559, 20_000);
    expect(maestro.ensureDriverInstalled).not.toHaveBeenCalled();
    expect(maestro.repairDriver).not.toHaveBeenCalled();
  });

  it('falls back to probe-first when the package query cannot be answered (ace#1155)', async () => {
    const { client, maestro } = makeDriverClient({
      packages: UNANSWERABLE,
      probeReturns: [{ healthy: true }],
    });
    await expect(client.assertMaestroDriverHealthy('emulator-5558')).resolves.toBeUndefined();
    expect(maestro.probeDriver).toHaveBeenCalledWith(5559, 20_000);
    expect(maestro.ensureDriverInstalled).not.toHaveBeenCalled();
  });
});

describe('MaestroBackend.driverPackagesInstalled — tri-state query', () => {
  function backend(shell: any) {
    return new MaestroBackend({ shell } as any);
  }

  it('reports both halves present', async () => {
    const shell = vi.fn(async (_c: string, args: string[]) => ({
      stdout: `package:${args[args.length - 1]}\n`,
      stderr: '',
      exitCode: 0,
    }));
    expect(await backend(shell).driverPackagesInstalled('emulator-5554')).toEqual({
      app: true,
      test: true,
      queryOk: true,
    });
  });

  it('reports a successful query that found nothing as a real absence', async () => {
    const shell = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
    expect(await backend(shell).driverPackagesInstalled('emulator-5554')).toEqual({
      app: false,
      test: false,
      queryOk: true,
    });
  });

  it('reports queryOk:false — NOT an absence — when adb itself fails', async () => {
    const shell = vi.fn(async () => ({
      stdout: '',
      stderr: 'error: device offline',
      exitCode: 1,
    }));
    const r = await backend(shell).driverPackagesInstalled('emulator-5554');
    expect(r.queryOk).toBe(false);
  });
});

describe('runLocalBootstrap — verify the CommCare install, do not assume it (ace#1818)', () => {
  function makeBootstrapClient(listPackagesSequence: string[][]) {
    const shell = vi.fn(async (_cmd: string, args: string[]) => {
      if (args.includes('connectivity')) {
        return {
          stdout: 'NetworkAgentInfo{ ... Capabilities: INTERNET VALIDATED ... }',
          stderr: '',
          code: 0,
        };
      }
      return { stdout: '', stderr: '', code: 0 };
    });
    const queue = [...listPackagesSequence];
    const avd: any = {
      getAdbShell: () => shell,
      listPackages: vi.fn(async () => queue.shift() ?? []),
      installApk: vi.fn(async () => ({ package: 'org.commcare.dalvik' })),
      clearConnectAppData: vi.fn(async () => true),
      applyEnvironmentBaseline: vi.fn(async () => 'fp'),
    };
    const client = new MobileClient({
      avd,
      maestro: {} as any,
      bootstrapConfig: {
        apkVersion: '2.63.2',
        testUser: {
          phone: TEST_PHONE,
          phoneLocal: TEST_PHONE_LOCAL,
          countryCode: '+7',
          pin: '1234',
          backupCode: '123456789012',
          name: 'ACE Test',
        },
      } as any,
    });
    (client as any).ensureCommCareApkCached = vi.fn(async () => '/tmp/commcare.apk');
    const registerTestUser = vi.fn(async () => ({ alreadyRegistered: false }));
    (client as any).registerTestUser = registerTestUser;
    return { client, avd, registerTestUser };
  }

  const AVD = { name: 'AVD', serial: 'emulator-5554', status: 'booted' as const };

  it('throws commcare-not-installed instead of driving a recipe at a bare AVD', async () => {
    // Pre-install list empty; post-install list STILL empty — exactly the
    // 20260828-0629 device (221 system packages, zero third-party).
    const { client, registerTestUser } = makeBootstrapClient([[], []]);
    await expect((client as any).runLocalBootstrap(AVD)).rejects.toThrow(
      /commcare-not-installed/,
    );
    // The whole point: the registration recipe never runs, so nothing
    // burns the 600s chunk budget and nothing blames the recipe.
    expect(registerTestUser).not.toHaveBeenCalled();
  });

  it('names the install call as unverified rather than reporting it as done', async () => {
    const { client } = makeBootstrapClient([[], []]);
    await expect((client as any).runLocalBootstrap(AVD)).rejects.toThrow(
      /reported-success/,
    );
  });

  it('proceeds normally when the post-install verification finds the package', async () => {
    const { client, registerTestUser } = makeBootstrapClient([[], ['org.commcare.dalvik']]);
    const steps = await (client as any).runLocalBootstrap(AVD);
    expect(steps).toContain('apk-installed');
    expect(registerTestUser).toHaveBeenCalledTimes(1);
  });
});
