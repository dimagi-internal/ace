import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MobileClient } from '../../../mcp/mobile/client.js';
import { TEST_PHONE, TEST_PHONE_LOCAL } from '../../fixtures/test-phone.js';

// dimagi-internal/ace#1067 — the heal funnel reported a restore step it had
// not verified, and had no network precondition, so a connectivity fault
// surfaced as a selector-not-found deep inside a registration recipe.

const AVD = { name: 'AVD', serial: 'emulator-5554', status: 'booted' as const };

function makeClient(opts: {
  connectivityOut: string;
  probeClassifiesAs: 'ready' | 'unknown';
  alreadyRegistered?: boolean;
}) {
  const shell = vi.fn(async (_cmd: string, args: string[]) => {
    if (args.includes('connectivity')) return { stdout: opts.connectivityOut, stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 0 };
  });
  const avd: any = {
    getAdbShell: () => shell,
    listPackages: vi.fn().mockResolvedValue(['org.commcare.dalvik']),
    clearConnectAppData: vi.fn().mockResolvedValue(true),
    applyEnvironmentBaseline: vi.fn().mockResolvedValue('fp'),
    getFocusedActivity: vi.fn().mockResolvedValue(''),
    captureUiDump: vi.fn().mockResolvedValue(''),
  };
  const client = new MobileClient({
    avd,
    bootstrapConfig: {
      apkVersion: '2.63.0',
      testUser: {
        phone: TEST_PHONE, phoneLocal: TEST_PHONE_LOCAL, countryCode: '+7',
        pin: '1234', backupCode: '123456789012', name: 'ACE Test',
      },
    } as any,
  });
  (client as any).registerTestUser = vi
    .fn()
    .mockResolvedValue({ alreadyRegistered: opts.alreadyRegistered ?? false });
  (client as any).probeDeviceUserState = vi.fn().mockResolvedValue({
    classified_as: opts.probeClassifiesAs,
    focused_activity: '',
    ui_dump_signal: undefined,
  });
  return { client, shell };
}

const VALIDATED = 'NetworkAgentInfo{ ... Capabilities: INTERNET VALIDATED NOT_METERED ... }';
const NO_NET = 'NetworkAgentInfo{ ... Capabilities: NOT_METERED ... }';

describe('bootstrap network precondition (#1067)', () => {
  it('throws a typed, named error when the device has no validated internet', async () => {
    const { client } = makeClient({ connectivityOut: NO_NET, probeClassifiesAs: 'ready' });
    await expect((client as any).runLocalBootstrap(AVD)).rejects.toThrow(
      /no VALIDATED internet connection/,
    );
  });

  it('proceeds when Android reports INTERNET + VALIDATED', async () => {
    const { client } = makeClient({ connectivityOut: VALIDATED, probeClassifiesAs: 'ready' });
    await expect((client as any).runLocalBootstrap(AVD)).resolves.toContain('registered');
  });

  it('does NOT use ping — ICMP is corrupt on QEMU user-mode NAT even when TCP works', async () => {
    // The issue is explicit: ping returned 83-100% loss with nonsense RTTs on a
    // device whose TCP/HTTPS worked fine (Connect rendered 5 server tiles). A
    // ping-based probe would block healthy bootstraps.
    const { client, shell } = makeClient({ connectivityOut: VALIDATED, probeClassifiesAs: 'ready' });
    await (client as any).runLocalBootstrap(AVD);
    const allArgs = shell.mock.calls.flatMap((c: any[]) => c[1] as string[]);
    expect(allArgs).not.toContain('ping');
  });

  it('fails OPEN when dumpsys is unreadable — a check must not invent a failure mode', async () => {
    const { client } = makeClient({ connectivityOut: '', probeClassifiesAs: 'ready' });
    await expect((client as any).runLocalBootstrap(AVD)).resolves.toBeTruthy();
  });
});

describe('bootstrap step honesty (#1067)', () => {
  it('reports "registered" only when the post-bootstrap probe CONFIRMS readiness', async () => {
    const { client } = makeClient({ connectivityOut: VALIDATED, probeClassifiesAs: 'ready' });
    const log = await client.restoreDeviceUserState(AVD as any);
    expect(log.bootstrap_steps).toContain('registered');
    expect(log.verified_as).toBe('ready');
  });

  it('downgrades to "registered-unverified" when the probe could not confirm', async () => {
    // The exact shape #1067 reported: bootstrap_steps claimed `registered`
    // while verified_as was `unknown` — asserting the thing it failed to verify.
    const { client } = makeClient({ connectivityOut: VALIDATED, probeClassifiesAs: 'unknown' });
    const log = await client.restoreDeviceUserState(AVD as any);
    expect(log.bootstrap_steps).toContain('registered-unverified');
    expect(log.bootstrap_steps).not.toContain('registered');
  });

  it('downgrades "register-already" too when the probe could not confirm', async () => {
    // The `alreadyRegistered` branch is the same claim by another name:
    // `registerTestUser` reported the user was already set up, and nothing
    // on-device confirmed it. #1085 downgraded only the literal
    // `registered`, so this arm still overclaimed.
    const { client } = makeClient({
      connectivityOut: VALIDATED,
      probeClassifiesAs: 'unknown',
      alreadyRegistered: true,
    });
    const log = await client.restoreDeviceUserState(AVD as any);
    expect(log.bootstrap_steps).toContain('register-already-unverified');
    expect(log.bootstrap_steps).not.toContain('register-already');
  });

  it('still SUCCEEDS on verified_as=unknown — #1067 ask #2 is deliberately not implemented', async () => {
    // Evidence against the issue's ask: `unknown` is the ORDINARY
    // post-bootstrap classification on a healthy device. The run that
    // live-validated #1058 (claim leg, STATUS: pass exit 0) logged
    // "restored to unknown via local-bootstrap" immediately before passing.
    // Making unknown fatal would have failed a demonstrably working run, so
    // the fix is to stop overclaiming in the log, not to start rejecting a
    // legitimate state. This test pins that decision so it is not "fixed"
    // later by someone reading only the issue.
    const { client } = makeClient({ connectivityOut: VALIDATED, probeClassifiesAs: 'unknown' });
    await expect(client.restoreDeviceUserState(AVD as any)).resolves.toMatchObject({
      verified_as: 'unknown',
      healed_via: 'local-bootstrap',
    });
  });
});

// The cloud twin of the same overclaim. `cloudBootstrapHeal` hardcoded
// `classified_as: 'ready'` AND `verified_as: 'ready'` while probing nothing
// at all — strictly worse than the local defect #1085 fixed, because local at
// least reported whatever its probe actually said. Flagged as still-open on
// #1067 after #1085 merged.
describe('cloud bootstrap step honesty (#1067, ask 1 cloud twin)', () => {
  const CLOUD_AVD = { name: 'cloud', serial: 'cloud:i-test', status: 'booted' as const };
  let savedFlag: string | undefined;
  let savedBackend: string | undefined;

  beforeEach(() => {
    savedFlag = process.env.ACE_MOBILE_CLOUD_LIVE_REGISTER;
    savedBackend = process.env.ACE_MOBILE_BACKEND;
    process.env.ACE_MOBILE_CLOUD_LIVE_REGISTER = 'true';
    process.env.ACE_MOBILE_BACKEND = 'cloud';
  });
  afterEach(() => {
    if (savedFlag === undefined) delete process.env.ACE_MOBILE_CLOUD_LIVE_REGISTER;
    else process.env.ACE_MOBILE_CLOUD_LIVE_REGISTER = savedFlag;
    if (savedBackend === undefined) delete process.env.ACE_MOBILE_BACKEND;
    else process.env.ACE_MOBILE_BACKEND = savedBackend;
  });

  function makeCloudClient(alreadyRegistered: boolean) {
    const cloud = {
      clearAppData: vi.fn().mockResolvedValue(true),
      registerTestUser: vi.fn().mockResolvedValue({
        alreadyRegistered,
        phone: TEST_PHONE,
        backupCode: '123456789012',
      }),
    } as any;
    const client = new MobileClient({
      avd: {} as any,
      maestro: {} as any,
      cloud,
      bootstrapConfig: {
        apkVersion: '2.63.0',
        testUser: {
          phone: TEST_PHONE, phoneLocal: TEST_PHONE_LOCAL, countryCode: '+7',
          pin: '1234', backupCode: '123456789012', name: 'ACE Test',
        },
      } as any,
    });
    return client;
  }

  it('never claims verified_as — the cloud heal runs no verification probe', async () => {
    const log = await makeCloudClient(false).restoreDeviceUserState(CLOUD_AVD as any);
    expect(log.verified_as).toBeUndefined();
  });

  it('does not classify the device as ready on the strength of an unprobed register call', async () => {
    const log = await makeCloudClient(false).restoreDeviceUserState(CLOUD_AVD as any);
    expect(log.classified_as).toBe('unknown');
    // Still a SUCCESS — same decision as the local path (ask 2 declined).
    expect(log).toMatchObject({ attempted: true, healed_via: 'cloud-bootstrap' });
  });

  it('reports the registration step as unverified in both register arms', async () => {
    const fresh = await makeCloudClient(false).restoreDeviceUserState(CLOUD_AVD as any);
    expect(fresh.bootstrap_steps).toEqual(['app-data-cleared', 'registered-unverified']);

    const already = await makeCloudClient(true).restoreDeviceUserState(CLOUD_AVD as any);
    expect(already.bootstrap_steps).toEqual(['app-data-cleared', 'register-already-unverified']);
  });
});
