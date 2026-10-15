// What a leased CommCare shows, for tests of the lease heal's verification.
//
// UNREGISTERED is the screen a fresh lease (cc-2.63.0) showed on 2026-10-14
// before registration — its exact texts, live: "Welcome to CommCare!",
// "Please choose an installation method below", "Scan Application Barcode",
// "Enter Code", and no GO TO CONNECT MENU. REGISTERED is the post-registration
// setup screen the selector map records (connect-2.64.0
// `personalid-login-button`, 34-post-registration-setup.xml).
import { vi } from 'vitest';

const node = (attrs: string) => `<node package="org.commcare.dalvik" ${attrs}/>`;

export const UNREGISTERED_XML =
  '<hierarchy rotation="0">' +
  node('text="CommCare" resource-id=""') +
  node('text="Welcome to CommCare!" resource-id="org.commcare.dalvik:id/str_setup_message"') +
  node('text="Please choose an installation method below" resource-id=""') +
  node('text="Scan Application Barcode" resource-id=""') +
  node('text="Enter Code" resource-id="org.commcare.dalvik:id/enter_app_location"') +
  '</hierarchy>';

export const REGISTERED_XML =
  '<hierarchy rotation="0">' +
  node('text="Welcome to CommCare!" resource-id="org.commcare.dalvik:id/str_setup_message"') +
  node('text="GO TO CONNECT MENU" resource-id="org.commcare.dalvik:id/connect_login_button"') +
  node('text="Scan Application Barcode" resource-id=""') +
  node('text="Enter Code" resource-id="org.commcare.dalvik:id/enter_app_location"') +
  '</hierarchy>';

export const CONNECT_HOME_XML =
  '<hierarchy rotation="0">' +
  node('text="Opportunities" resource-id="org.commcare.dalvik:id/connect_fragment_jobs_list"') +
  '</hierarchy>';

/** A fake LeaseBackend surface for the heal: dumps play back `screens` in order (last repeats). */
export function fakeLeaseForHeal(opts: {
  screens?: string[];
  alreadyRegistered?: boolean;
  cleared?: boolean;
  reused?: boolean;
} = {}) {
  const screens = opts.screens ?? [REGISTERED_XML];
  let i = 0;
  return {
    ensureAvdRunning: vi.fn().mockResolvedValue({
      name: 'cc-2.64.0',
      serial: 'lease:i-1',
      status: 'booted',
      lease: {
        lease_id: 'lease-1', instance_id: 'i-1', expires_at: null, idle_release_s: 900, state: 'cc-2.64.0',
        selector_map_version: '2.64.0', reused: opts.reused === true, cli_version: '1.1.0',
        image_baseline_fingerprint: null, expected_baseline_fingerprint: 'x', baseline_parity: 'match', long_poll: 'unknown',
      },
    }),
    clearAppData: vi.fn().mockResolvedValue(opts.cleared ?? true),
    registerTestUser: vi.fn().mockResolvedValue({ alreadyRegistered: opts.alreadyRegistered ?? false, phone: '+7426' }),
    runRecipe: vi.fn().mockResolvedValue({ status: 'pass', exitCode: 0, stdout: '', stderr: '', screenshotsDir: '', screenshots: [] }),
    captureUiDump: vi.fn(async () => {
      const xml = screens[Math.min(i++, screens.length - 1)];
      return { xml, elements: [] };
    }),
    setLocation: vi.fn().mockResolvedValue({ applied: true }),
    diagnose: vi.fn().mockResolvedValue({ lease: null }),
    stopAvd: vi.fn().mockResolvedValue(undefined),
    listAvds: vi.fn().mockResolvedValue(['cc-2.64.0']),
  };
}
