import { describe, it, expect, vi } from 'vitest';
import { MobileClient } from '../../../mcp/mobile/client.js';
import { TEST_PHONE, TEST_PHONE_LOCAL } from '../../fixtures/test-phone.js';

// dimagi-internal/ace#1067 — the heal funnel reported a restore step it had
// not verified, and had no network precondition, so a connectivity fault
// surfaced as a selector-not-found deep inside a registration recipe.

const AVD = { name: 'AVD', serial: 'emulator-5554', status: 'booted' as const };

function makeClient(opts: {
  connectivityOut: string;
  probeClassifiesAs: 'ready' | 'unknown';
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
  (client as any).registerTestUser = vi.fn().mockResolvedValue({ alreadyRegistered: false });
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
