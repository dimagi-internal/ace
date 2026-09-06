import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import {
  classifyDeviceUserState,
  detectAppCrashLoop,
  summarizeCrash,
  MobileClient,
  bootstrapConfigFromEnv,
  missingBootstrapEnvVars,
  getConfiguredApkVersion,
  DEFAULT_APK_VERSION,
} from '../../../mcp/mobile/client.js';
import { setSessionBackend, clearSessionBackend } from '../../../mcp/mobile/backend-toggle.js';
import { TEST_PHONE, TEST_PHONE_LOCAL } from '../../fixtures/test-phone.js';

// ace#1111 pinned screenshot dirs under an allow-listed root. These suites
// build scratch dirs with `mkdtemp` under the OS temp dir, which is outside
// the default roots — point the override at it so they exercise the
// production code path instead of the refusal.
process.env.ACE_SCREENSHOT_ROOT = os.tmpdir();




// The real static-recipe palette dir. registerTestUser now resolves
// `${SELECTOR:...}` placeholders via prepareRecipeForMaestro, which reads
// this palette off disk — so the register tests must point at the real
// recipes (a fake `/static` dir would make resolution throw on read).
const REAL_STATIC_DIR = new URL('../../../mcp/mobile/recipes/static/', import.meta.url).pathname;

function fakeMaestroAndAvd(opts: {
  registerToOtp: 'pass' | 'fail';
  registerFromOtp: 'pass' | 'fail' | 'already';
  otp: string;
}) {
  const avd = {
    ensureAvdRunning: vi.fn().mockResolvedValue({ name: 'AVD', serial: 'emulator-5554', status: 'booted' }),
    requireRunningAvd: vi.fn().mockResolvedValue({ name: 'AVD', serial: 'emulator-5554', status: 'booted' }),
    // ace#1357 fix 3: registerTestUser now proves the device answers.
    probeDeviceReachable: vi.fn().mockResolvedValue({ reachable: true }),
    findRunningAvd: vi.fn().mockResolvedValue({ name: 'AVD', serial: 'emulator-5554', status: 'booted' }),
    setGmsEnabled: vi.fn().mockResolvedValue(undefined),
    disableHeadsUpNotifications: vi.fn().mockResolvedValue(undefined),
    applyEnvironmentBaseline: vi.fn().mockResolvedValue('abc123def456'),
    grantRuntimePermissions: vi.fn().mockResolvedValue(undefined),
  } as any;
  const runRecipe = vi.fn().mockImplementation(async (recipePath: string) => {
    if (recipePath.endsWith('connect-register-to-otp.yaml')) {
      return { status: opts.registerToOtp, exitCode: opts.registerToOtp === 'pass' ? 0 : 1, screenshots: [], stdout: '', stderr: '', screenshotsDir: '/tmp' };
    }
    if (recipePath.endsWith('connect-register-from-otp.yaml')) {
      if (opts.registerFromOtp === 'already') {
        return { status: 'fail', exitCode: 2, screenshots: [], stdout: 'PHONE_ALREADY_REGISTERED', stderr: '', screenshotsDir: '/tmp' };
      }
      return { status: opts.registerFromOtp, exitCode: opts.registerFromOtp === 'pass' ? 0 : 1, screenshots: [], stdout: '', stderr: '', screenshotsDir: '/tmp' };
    }
    throw new Error(`unexpected recipe: ${recipePath}`);
  });
  const maestro = { runRecipe } as any;
  return { avd, maestro };
}


/**
 * `listPackages` fake modelling a device where the CommCare install
 * SUCCEEDS: absent on the pre-install read, present on every read after.
 *
 * Since ace#1818 `runLocalBootstrap` VERIFIES the install instead of
 * assuming it, so a fake that answers `[]` forever no longer models
 * "CommCare wasn't installed yet" — it models "the install silently
 * failed", which is a different test (and has its own coverage in
 * test/mcp/mobile/maestro-driver-install-gate.test.ts).
 */
function listPackagesInstallSucceeds() {
  let calls = 0;
  return vi.fn(async () => (calls++ === 0 ? [] : ['org.commcare.dalvik']));
}

describe('MobileClient.registerTestUser', () => {
  it('runs to-otp then from-otp recipes and returns success', async () => {
    const { avd, maestro } = fakeMaestroAndAvd({ registerToOtp: 'pass', registerFromOtp: 'pass', otp: '123456' });
    const client = new MobileClient({ avd, maestro, staticRecipesDir: REAL_STATIC_DIR });

    const r = await client.registerTestUser({
      avdName: 'AVD', phone: '+74260000001', phoneLocal: '4260000001', countryCode: '+7',
      pin: '111111', backupCode: '222222', name: 'ACE Test',
    });
    expect(r.alreadyRegistered).toBe(false);
    expect(r.phone).toBe('+74260000001');
    expect(avd.setGmsEnabled).toHaveBeenCalledWith('AVD', true);
    expect(avd.setGmsEnabled).toHaveBeenCalledWith('AVD', false);
  });

  // Regression guard for jjackson/ace#682: the heal-funnel / auto-bootstrap
  // register path MUST run the static recipes through the SAME
  // `${SELECTOR:...}` substitution pass `mobile_run_recipe` uses. PR #650
  // migrated connect-register-to-otp.yaml / connect-register-from-otp.yaml
  // off raw `org.commcare.dalvik:id/*` literals onto `${SELECTOR:...}`
  // tokens, but registerTestUser passed the RAW recipe paths straight to
  // maestro.runRecipe — so Maestro received literal `${SELECTOR:...}` text
  // and coerced it to `id: NaN`, failing the very first splash assertion.
  // This test reads the exact files handed to maestro and asserts the
  // placeholders are gone (substituted) and a real resolved resource-id is
  // present. It fails before the fix (raw recipe → placeholder survives).
  // ace#1357 fix 3. The observed run: three consecutive halts at
  // `register_test_user part B` with a dadb broken-pipe trace, against an AVD
  // that never really booted. requireRunningAvd only asserts adb LISTS the
  // serial. Without this guard the recipes run at a dead device and the real
  // cause — already on disk from #1047's stderr capture — is replaced by a
  // transport error.
  it('refuses to drive recipes at a listed-but-unreachable device', async () => {
    const avd = {
      requireRunningAvd: vi.fn().mockResolvedValue({ name: 'AVD', serial: 'emulator-5554', status: 'booted' }),
      probeDeviceReachable: vi.fn().mockResolvedValue({
        reachable: false, reason: 'adb reports the device offline',
      }),
      setGmsEnabled: vi.fn(),
      grantRuntimePermissions: vi.fn(),
    } as any;
    const maestro = { runRecipe: vi.fn() } as any;
    const client = new MobileClient({ avd, maestro });

    await expect(
      client.registerTestUser({
        avdName: 'ACE_Pixel_API_34', phone: '+74260000000', phoneLocal: '0000000',
        countryCode: '+7426', pin: '1234', backupCode: 'abcd', name: 'Test',
      }),
    ).rejects.toThrow(/does not respond/);

    // The point of the fix: fail BEFORE burning a recipe run at a dead device.
    expect(maestro.runRecipe).not.toHaveBeenCalled();
  });

  it('names the cause rather than the transport symptom', async () => {
    const avd = {
      requireRunningAvd: vi.fn().mockResolvedValue({ name: 'AVD', serial: 'emulator-5554', status: 'booted' }),
      probeDeviceReachable: vi.fn().mockResolvedValue({
        reachable: false, reason: 'adb reports the device offline',
      }),
      setGmsEnabled: vi.fn(),
      grantRuntimePermissions: vi.fn(),
    } as any;
    const client = new MobileClient({ avd, maestro: { runRecipe: vi.fn() } as any });

    const err = await client.registerTestUser({
      avdName: 'ACE_Pixel_API_34', phone: '+74260000000', phoneLocal: '0000000',
      countryCode: '+7426', pin: '1234', backupCode: 'abcd', name: 'Test',
    }).catch((e: Error) => e);

    expect((err as Error).message).toContain('Not a registration failure');
    expect((err as Error).message).toContain('/ace:mobile-bootstrap');
  });

  it('resolves ${SELECTOR:...} placeholders before handing recipes to maestro', async () => {
    const capturedRecipePaths: string[] = [];
    const avd = {
      ensureAvdRunning: vi.fn().mockResolvedValue({ name: 'AVD', serial: 'emulator-5554', status: 'booted' }),
      requireRunningAvd: vi.fn().mockResolvedValue({ name: 'AVD', serial: 'emulator-5554', status: 'booted' }),
      // ace#1357 fix 3: registerTestUser now proves the device answers.
      probeDeviceReachable: vi.fn().mockResolvedValue({ reachable: true }),
      findRunningAvd: vi.fn().mockResolvedValue({ name: 'AVD', serial: 'emulator-5554', status: 'booted' }),
      setGmsEnabled: vi.fn().mockResolvedValue(undefined),
      grantRuntimePermissions: vi.fn().mockResolvedValue(undefined),
    } as any;
    // Capture the recipe BODY at call time — registerTestUser cleans up the
    // temp dir on success, so we must read the file synchronously inside the
    // mock before the finally block deletes it.
    const capturedBodies: Record<string, string> = {};
    const maestro = {
      runRecipe: vi.fn().mockImplementation(async (recipePath: string) => {
        capturedRecipePaths.push(recipePath);
        capturedBodies[path.basename(recipePath)] = fs.readFileSync(recipePath, 'utf8');
        return { status: 'pass', exitCode: 0, screenshots: [], stdout: '', stderr: '', screenshotsDir: '/tmp' };
      }),
    } as any;
    const client = new MobileClient({ avd, maestro, staticRecipesDir: REAL_STATIC_DIR });

    await client.registerTestUser({
      avdName: 'AVD', phone: '+74260000001', phoneLocal: '4260000001', countryCode: '+7',
      pin: '111111', backupCode: '222222', name: 'ACE Test',
    });

    // Both register recipes were handed to maestro from a resolved temp dir,
    // NOT the raw static palette.
    const toBody = capturedBodies['connect-register-to-otp.yaml'];
    const fromBody = capturedBodies['connect-register-from-otp.yaml'];
    expect(toBody, 'to-otp recipe was handed to maestro').toBeTruthy();
    expect(fromBody, 'from-otp recipe was handed to maestro').toBeTruthy();
    // Placeholders must be GONE — substituted to real ids. A surviving
    // `${SELECTOR:` is exactly the #682 bug (Maestro coerces it to id: NaN).
    expect(toBody).not.toMatch(/\$\{SELECTOR:/);
    expect(fromBody).not.toMatch(/\$\{SELECTOR:/);
    // And the substitution actually injected the real resolved resource-id
    // for the splash assertion that failed live (app-splash-message →
    // org.commcare.dalvik:id/str_setup_message).
    expect(toBody).toContain('org.commcare.dalvik:id/str_setup_message');
    // The recipes maestro ran were the resolved copies, not the raw paths.
    for (const p of capturedRecipePaths) {
      expect(p.startsWith(REAL_STATIC_DIR), `maestro got a resolved (temp) path, not raw ${p}`).toBe(false);
    }
  });

  it('detects PHONE_ALREADY_REGISTERED and returns alreadyRegistered=true', async () => {
    const { avd, maestro } = fakeMaestroAndAvd({ registerToOtp: 'pass', registerFromOtp: 'already', otp: '123456' });
    const client = new MobileClient({ avd, maestro, staticRecipesDir: REAL_STATIC_DIR });

    const r = await client.registerTestUser({
      avdName: 'AVD', phone: '+74260000001', phoneLocal: '4260000001', countryCode: '+7',
      pin: '111111', backupCode: '222222', name: 'ACE Test',
    });
    expect(r.alreadyRegistered).toBe(true);
  });

  it('returns alreadyRegistered=true without invoking AVD/maestro on cloud backend', async () => {
    const prev = process.env.ACE_MOBILE_BACKEND;
    const prevFlag = process.env.ACE_MOBILE_CLOUD_LIVE_REGISTER;
    process.env.ACE_MOBILE_BACKEND = 'cloud';
    delete process.env.ACE_MOBILE_CLOUD_LIVE_REGISTER;
    try {
      const { avd, maestro } = fakeMaestroAndAvd({ registerToOtp: 'pass', registerFromOtp: 'pass', otp: '123456' });
      // Stub the cloud backend so the client constructor doesn't try to hit ace-web env.
      const cloud = {} as any;
      const client = new MobileClient({ avd, maestro, cloud, staticRecipesDir: '/static' });

      const r = await client.registerTestUser({
        avdName: 'AVD', phone: '+74260000001', phoneLocal: '4260000001', countryCode: '+7',
        pin: '111111', backupCode: '222222', name: 'ACE Test',
      });
      expect(r.alreadyRegistered).toBe(true);
      expect(r.phone).toBe('+74260000001');
      expect(avd.ensureAvdRunning).not.toHaveBeenCalled();
      expect(maestro.runRecipe).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.ACE_MOBILE_BACKEND;
      else process.env.ACE_MOBILE_BACKEND = prev;
      if (prevFlag === undefined) delete process.env.ACE_MOBILE_CLOUD_LIVE_REGISTER;
      else process.env.ACE_MOBILE_CLOUD_LIVE_REGISTER = prevFlag;
    }
  });

  it('cloud branch calls CloudBackend.registerTestUser when ACE_MOBILE_CLOUD_LIVE_REGISTER=true', async () => {
    const prev = process.env.ACE_MOBILE_BACKEND;
    const prevFlag = process.env.ACE_MOBILE_CLOUD_LIVE_REGISTER;
    process.env.ACE_MOBILE_BACKEND = 'cloud';
    process.env.ACE_MOBILE_CLOUD_LIVE_REGISTER = 'true';
    try {
      const { avd, maestro } = fakeMaestroAndAvd({ registerToOtp: 'pass', registerFromOtp: 'pass', otp: '123456' });
      const cloudRegister = vi.fn().mockResolvedValue({
        alreadyRegistered: false,
        phone: TEST_PHONE,
        backupCode: '222222',
      });
      const cloud = { registerTestUser: cloudRegister } as any;
      const client = new MobileClient({
        avd,
        maestro,
        cloud,
        // Use the real static recipes dir so prepareRecipeForMaestro
        // finds both register recipes and the rest of the palette.
        staticRecipesDir: new URL('../../../mcp/mobile/recipes/static/', import.meta.url).pathname,
      });

      const r = await client.registerTestUser({
        avdName: 'AVD',
        phone: TEST_PHONE,
        phoneLocal: TEST_PHONE_LOCAL,
        countryCode: '+7',
        pin: '111111',
        backupCode: '222222',
        name: 'ACE Test',
      });

      // Local AVD + maestro must NOT be touched on the cloud branch.
      expect(avd.ensureAvdRunning).not.toHaveBeenCalled();
      expect(maestro.runRecipe).not.toHaveBeenCalled();
      // Cloud register must be called exactly once with the camelCase
      // args + a non-empty paletteTarB64 + both recipe basenames.
      expect(cloudRegister).toHaveBeenCalledTimes(1);
      const callArgs = cloudRegister.mock.calls[0][0];
      expect(callArgs.phone).toBe(TEST_PHONE);
      expect(callArgs.phoneLocal).toBe(TEST_PHONE_LOCAL);
      expect(callArgs.countryCode).toBe('+7');
      expect(callArgs.pin).toBe('111111');
      expect(callArgs.backupCode).toBe('222222');
      expect(callArgs.name).toBe('ACE Test');
      expect(callArgs.toOtpRecipe).toBe('connect-register-to-otp.yaml');
      expect(callArgs.fromOtpRecipe).toBe('connect-register-from-otp.yaml');
      expect(typeof callArgs.paletteTarB64).toBe('string');
      expect(callArgs.paletteTarB64.length).toBeGreaterThan(100);
      // Result threaded through unchanged.
      expect(r.alreadyRegistered).toBe(false);
      expect(r.phone).toBe(TEST_PHONE);
      expect(r.backupCode).toBe('222222');
    } finally {
      if (prev === undefined) delete process.env.ACE_MOBILE_BACKEND;
      else process.env.ACE_MOBILE_BACKEND = prev;
      if (prevFlag === undefined) delete process.env.ACE_MOBILE_CLOUD_LIVE_REGISTER;
      else process.env.ACE_MOBILE_CLOUD_LIVE_REGISTER = prevFlag;
    }
  });

  it('cloud branch stays no-op when ACE_MOBILE_CLOUD_LIVE_REGISTER is anything other than "true"', async () => {
    const prev = process.env.ACE_MOBILE_BACKEND;
    const prevFlag = process.env.ACE_MOBILE_CLOUD_LIVE_REGISTER;
    process.env.ACE_MOBILE_BACKEND = 'cloud';
    process.env.ACE_MOBILE_CLOUD_LIVE_REGISTER = 'false';  // explicit off
    try {
      const cloudRegister = vi.fn();
      const cloud = { registerTestUser: cloudRegister } as any;
      const { avd, maestro } = fakeMaestroAndAvd({ registerToOtp: 'pass', registerFromOtp: 'pass', otp: '123456' });
      const client = new MobileClient({ avd, maestro, cloud, staticRecipesDir: '/static' });
      const r = await client.registerTestUser({
        avdName: 'AVD', phone: TEST_PHONE, phoneLocal: TEST_PHONE_LOCAL, countryCode: '+7',
        pin: '111111', backupCode: '222222', name: 'ACE Test',
      });
      expect(r.alreadyRegistered).toBe(true);  // legacy no-op success shape
      expect(cloudRegister).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.ACE_MOBILE_BACKEND;
      else process.env.ACE_MOBILE_BACKEND = prev;
      if (prevFlag === undefined) delete process.env.ACE_MOBILE_CLOUD_LIVE_REGISTER;
      else process.env.ACE_MOBILE_CLOUD_LIVE_REGISTER = prevFlag;
    }
  });
});

describe('MobileClient.runRecipe (cloud-path palette parity)', () => {
  let savedBackend: string | undefined;
  let tmpDir: string;
  beforeEach(async () => {
    savedBackend = process.env.ACE_MOBILE_BACKEND;
    process.env.ACE_MOBILE_BACKEND = 'cloud';
    clearSessionBackend();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palette-it-'));
  });
  afterEach(() => {
    if (savedBackend === undefined) delete process.env.ACE_MOBILE_BACKEND;
    else process.env.ACE_MOBILE_BACKEND = savedBackend;
    clearSessionBackend();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('resolves ${SELECTOR:...} and ships the resolved palette as paletteTarB64', async () => {
    // The pre-2026-05-16 bug: cloud branch bypassed
    // `prepareRecipeForMaestro`, so Maestro saw raw `${SELECTOR:...}`.
    // This test pins the new contract: cloud.runRecipe gets a resolved
    // top recipe (read from prep.resolvedPath) AND a paletteTarB64 of
    // the resolved temp dir, exactly mirroring what local's Maestro sees.
    const recipePath = path.join(tmpDir, 'use-selector.yaml');
    fs.writeFileSync(
      recipePath,
      'appId: org.commcare.dalvik\n---\n- tapOn:\n    ${SELECTOR:form-nav-next}\n',
      'utf8',
    );

    const cloudRunRecipe = vi.fn().mockResolvedValue({
      status: 'pass',
      exitCode: 0,
      stdout: '',
      stderr: '',
      screenshotsDir: tmpDir,
      screenshots: [],
    });
    const cloud = { runRecipe: cloudRunRecipe } as any;
    const client = new MobileClient({ avd: {} as any, maestro: {} as any, cloud });

    await client.runRecipe(recipePath, {}, tmpDir);

    expect(cloudRunRecipe).toHaveBeenCalledTimes(1);
    const [resolvedPath, , , opts] = cloudRunRecipe.mock.calls[0];

    // The path handed to cloud is the prep'd file (different from
    // the caller's recipePath). Its content has the placeholder
    // resolved.
    expect(resolvedPath).not.toBe(recipePath);
    const resolvedContent = fs.readFileSync(resolvedPath as string, 'utf8');
    expect(resolvedContent).toContain('id: "org.commcare.dalvik:id/nav_btn_next"');
    expect(resolvedContent).not.toContain('${SELECTOR:');

    // The palette tarball is a non-empty base64 string.
    expect(typeof opts.paletteTarB64).toBe('string');
    expect((opts.paletteTarB64 as string).length).toBeGreaterThan(100);
    // Quick sanity: base64 decodes to a gzip-magic-prefixed buffer.
    const decoded = Buffer.from(opts.paletteTarB64 as string, 'base64');
    expect(decoded[0]).toBe(0x1f);
    expect(decoded[1]).toBe(0x8b);
  });

  it('passes paletteTarB64 even when the recipe has no ${SELECTOR:...} (idempotent palette shipping)', async () => {
    // Cloud always gets the palette dir, even when the top recipe
    // doesn't reference any selectors. That way `runFlow: file:` refs
    // still find their siblings server-side.
    const recipePath = path.join(tmpDir, 'plain.yaml');
    fs.writeFileSync(recipePath, 'appId: x\n---\n- launchApp: x\n', 'utf8');

    const cloudRunRecipe = vi.fn().mockResolvedValue({
      status: 'pass', exitCode: 0, stdout: '', stderr: '',
      screenshotsDir: tmpDir, screenshots: [],
    });
    const cloud = { runRecipe: cloudRunRecipe } as any;
    const client = new MobileClient({ avd: {} as any, maestro: {} as any, cloud });

    await client.runRecipe(recipePath, {}, tmpDir);

    const opts = cloudRunRecipe.mock.calls[0][3];
    expect(opts.paletteTarB64).toBeDefined();
    expect((opts.paletteTarB64 as string).length).toBeGreaterThan(0);
  });
});

// Mapping-completeness Task 5 — `captureAllBoundaries` threads from
// `MobileClient.runRecipe`'s new 5th `opts` param down to
// `MaestroBackend.runRecipe`'s opts object. `MaestroBackend.runRecipe`
// itself is mocked here (its own chunk-count behavior is covered in
// test/mcp/mobile/maestro.test.ts); these tests pin the ONE hop this file
// can cheaply observe that maestro.test.ts cannot: that the client
// forwards exactly what the caller passed — nothing coerced to `true`
// when omitted, and the caller's `true` not dropped on the way through.
describe('MobileClient.runRecipe (captureAllBoundaries passthrough — local backend, Task 5)', () => {
  function fakeLocalBackends() {
    const avd = {
      ensureAvdRunning: vi.fn(),
      requireRunningAvd: vi.fn(),
      // ace#1357 fix 3: registerTestUser now proves the device answers.
      probeDeviceReachable: vi.fn().mockResolvedValue({ reachable: true }),
      findRunningAvd: vi.fn().mockResolvedValue(null),
      getAllocatedPorts: vi.fn().mockResolvedValue({ adbServerPort: 5039 }),
      getAdbShell: vi.fn(),
    } as any;
    const maestro = {
      runRecipe: vi.fn().mockResolvedValue({
        status: 'pass', exitCode: 0, stdout: '', stderr: '', screenshotsDir: '/tmp', screenshots: [],
      }),
    } as any;
    return { avd, maestro };
  }

  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cab-passthrough-'));
  });
  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('does not set captureAllBoundaries on the backend call when the caller omits opts entirely (default stays off)', async () => {
    const recipePath = path.join(tmpDir, 'r.yaml');
    fs.writeFileSync(recipePath, 'appId: x\n---\n- launchApp: x\n', 'utf8');
    const { avd, maestro } = fakeLocalBackends();
    const client = new MobileClient({ avd, maestro, cloud: null as any, bootstrapConfig: null });

    await client.runRecipe(recipePath, {}, tmpDir);

    expect(maestro.runRecipe).toHaveBeenCalledTimes(1);
    const backendOpts = maestro.runRecipe.mock.calls[0][3];
    expect(backendOpts.captureAllBoundaries).toBeUndefined();
  });

  it('forwards captureAllBoundaries: true through to the backend when the caller opts in explicitly', async () => {
    const recipePath = path.join(tmpDir, 'r.yaml');
    fs.writeFileSync(recipePath, 'appId: x\n---\n- launchApp: x\n', 'utf8');
    const { avd, maestro } = fakeLocalBackends();
    const client = new MobileClient({ avd, maestro, cloud: null as any, bootstrapConfig: null });

    await client.runRecipe(recipePath, {}, tmpDir, undefined, { captureAllBoundaries: true });

    const backendOpts = maestro.runRecipe.mock.calls[0][3];
    expect(backendOpts.captureAllBoundaries).toBe(true);
  });
});

describe('MobileClient.runRecipe (screenshot-on-recipe-error forensics)', () => {
  // jjackson/ace screenshot-on-error: a FAILED recipe leaves the device on
  // the offending screen. `runRecipe` captures a ui-dump (element tree) + a
  // screenshot of that screen automatically, surfacing them on
  // `result.failureForensics` for the manual-debug fallback. Best-effort:
  // forensic-capture errors never turn a fail into a throw, and `pass` runs
  // capture nothing.
  let savedBackend: string | undefined;
  let tmpDir: string;
  beforeEach(() => {
    savedBackend = process.env.ACE_MOBILE_BACKEND;
    process.env.ACE_MOBILE_BACKEND = 'cloud';
    clearSessionBackend();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'failshot-it-'));
  });
  afterEach(() => {
    if (savedBackend === undefined) delete process.env.ACE_MOBILE_BACKEND;
    else process.env.ACE_MOBILE_BACKEND = savedBackend;
    clearSessionBackend();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('captures ui-dump + screenshot of the failure screen on a failed recipe', async () => {
    const recipePath = path.join(tmpDir, 'will-fail.yaml');
    fs.writeFileSync(recipePath, 'appId: org.commcare.dalvik\n---\n- assertVisible:\n    id: "nope"\n', 'utf8');

    const cloudRunRecipe = vi
      .fn()
      // 1st call: the real recipe — fails.
      .mockResolvedValueOnce({
        status: 'fail', exitCode: 1, stdout: '', stderr: 'assertion failed', screenshotsDir: tmpDir, screenshots: [],
      })
      // 2nd call: the throwaway 1-step screenshot recipe — writes the PNG
      // the backend would have produced, then resolves pass.
      // (writes into the dir it is HANDED — this dispatch's own output
      // dir since #1130, not the root the caller passed.)
      .mockImplementationOnce(async (_r: string, _e: unknown, dir: string) => {
        fs.writeFileSync(path.join(dir, 'will-fail-FAILURE.png'), 'PNGDATA');
        return { status: 'pass', exitCode: 0, stdout: '', stderr: '', screenshotsDir: dir, screenshots: [] };
      });
    const captureUiDump = vi.fn().mockResolvedValue({
      xml: '<hierarchy><node resource-id="org.commcare.dalvik:id/nsv_home_screen"/></hierarchy>',
      elements: [{ id: 'org.commcare.dalvik:id/nsv_home_screen', text: '', class: 'View', bounds: '[0,0][1,1]' }],
    });
    const cloud = { runRecipe: cloudRunRecipe, captureUiDump } as any;
    const client = new MobileClient({ avd: {} as any, maestro: {} as any, cloud });

    const result = await client.runRecipe(recipePath, {}, tmpDir, 'AVD');

    expect(result.status).toBe('fail');
    expect(result.failureForensics).toBeDefined();
    // ui-dump is the high-signal artifact: written next to the run's
    // screenshots — i.e. inside THIS dispatch's own output dir (#1130).
    expect(result.failureForensics?.uiDumpPath).toBe(
      path.join(tmpDir, 'will-fail', 'will-fail-FAILURE.xml'),
    );
    expect(fs.existsSync(result.failureForensics!.uiDumpPath!)).toBe(true);
    expect(result.failureForensics?.elements?.[0]?.id).toContain('nsv_home_screen');
    // screenshot of the failure screen, resolved from the backend's PNG.
    expect(result.failureForensics?.screenshotPath).toBe(
      path.join(tmpDir, 'will-fail', 'will-fail-FAILURE.png'),
    );
    expect(captureUiDump).toHaveBeenCalledWith('AVD');
  });

  it('captures nothing on a passing recipe (no wasted round-trips)', async () => {
    const recipePath = path.join(tmpDir, 'will-pass.yaml');
    fs.writeFileSync(recipePath, 'appId: org.commcare.dalvik\n---\n- launchApp: org.commcare.dalvik\n', 'utf8');

    const cloudRunRecipe = vi.fn().mockResolvedValue({
      status: 'pass', exitCode: 0, stdout: '', stderr: '', screenshotsDir: tmpDir, screenshots: [],
    });
    const captureUiDump = vi.fn();
    const cloud = { runRecipe: cloudRunRecipe, captureUiDump } as any;
    const client = new MobileClient({ avd: {} as any, maestro: {} as any, cloud });

    const result = await client.runRecipe(recipePath, {}, tmpDir, 'AVD');

    expect(result.status).toBe('pass');
    expect(result.failureForensics).toBeUndefined();
    expect(captureUiDump).not.toHaveBeenCalled();
    expect(cloudRunRecipe).toHaveBeenCalledTimes(1); // no throwaway screenshot recipe
  });

  it('captures forensics on a THROWN failure (driver death) and attaches them to the error', async () => {
    // The highest-signal failures — driver death that exhausts the heal-and-
    // retry envelope, transport crashes — THROW rather than returning a
    // {status:'fail'} result, so the status-gated capture can't fire. The
    // throw arm must capture the failure screen too (the ui-dump is adb-based,
    // so it usually still works on a dead gRPC driver), attach it to the
    // error, and rethrow the ORIGINAL error untouched.
    const recipePath = path.join(tmpDir, 'will-throw.yaml');
    fs.writeFileSync(recipePath, 'appId: org.commcare.dalvik\n---\n- assertVisible:\n    id: "nope"\n', 'utf8');

    const cloudRunRecipe = vi
      .fn()
      // 1st call: the real recipe — throws a transport/driver error.
      .mockRejectedValueOnce(new Error('UNAVAILABLE: driver gRPC broken pipe'))
      // 2nd call: the throwaway 1-step screenshot recipe fired from the catch
      // arm — writes the failure-screen PNG, then resolves pass.
      .mockImplementationOnce(async (_r: string, _e: unknown, dir: string) => {
        fs.writeFileSync(path.join(dir, 'will-throw-FAILURE.png'), 'PNGDATA');
        return { status: 'pass', exitCode: 0, stdout: '', stderr: '', screenshotsDir: dir, screenshots: [] };
      });
    const captureUiDump = vi.fn().mockResolvedValue({
      xml: '<hierarchy><node resource-id="org.commcare.dalvik:id/nsv_home_screen"/></hierarchy>',
      elements: [{ id: 'org.commcare.dalvik:id/nsv_home_screen', text: '', class: 'View', bounds: '[0,0][1,1]' }],
    });
    const cloud = { runRecipe: cloudRunRecipe, captureUiDump } as any;
    const client = new MobileClient({ avd: {} as any, maestro: {} as any, cloud });

    // The ORIGINAL error must propagate — forensic capture never masks it.
    const err: any = await client.runRecipe(recipePath, {}, tmpDir, 'AVD').then(
      () => { throw new Error('expected runRecipe to reject'); },
      (e) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(String(err.message)).toContain('UNAVAILABLE');
    // ...with the failure-screen forensics attached to it.
    expect(err.failureForensics).toBeDefined();
    expect(err.failureForensics.uiDumpPath).toBe(
      path.join(tmpDir, 'will-throw', 'will-throw-FAILURE.xml'),
    );
    expect(fs.existsSync(err.failureForensics.uiDumpPath)).toBe(true);
    expect(err.failureForensics.elements?.[0]?.id).toContain('nsv_home_screen');
    expect(err.failureForensics.screenshotPath).toBe(
      path.join(tmpDir, 'will-throw', 'will-throw-FAILURE.png'),
    );
    expect(captureUiDump).toHaveBeenCalledWith('AVD');
  });
});

describe('MobileClient.runRecipe (recipe freshness pre-flight gate)', () => {
  // Closes the stale-Drive-artifact class from
  // `docs/learnings/2026-05-14-phase6-validation-arc.md` class-level
  // finding #1: a recipe whose stamped `selector_map_sha` doesn't
  // match the current map gets rejected before AVD wall-clock burns.
  let savedBackend: string | undefined;
  let savedApk: string | undefined;
  let tmpDir: string;
  beforeEach(() => {
    savedBackend = process.env.ACE_MOBILE_BACKEND;
    savedApk = process.env.ACE_CONNECT_APK_VERSION;
    process.env.ACE_MOBILE_BACKEND = 'cloud';
    clearSessionBackend();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freshness-test-'));
  });
  afterEach(() => {
    if (savedBackend === undefined) delete process.env.ACE_MOBILE_BACKEND;
    else process.env.ACE_MOBILE_BACKEND = savedBackend;
    if (savedApk === undefined) delete process.env.ACE_CONNECT_APK_VERSION;
    else process.env.ACE_CONNECT_APK_VERSION = savedApk;
    clearSessionBackend();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('rejects a recipe whose stamped selector_map_sha does NOT match the current map', async () => {
    const recipePath = path.join(tmpDir, 'stale.yaml');
    // Stamp with a deliberately-wrong SHA so the current map won't match.
    const header = [
      '# ACE Recipe Provenance — do not edit by hand',
      '# ace_version: 0.13.300',
      '# selector_map_sha: STALESHAxxxx',
      '# selector_map_apk_version: 2.63.0',
      '# generated_at: 2026-05-25T00:00:00.000Z',
      '',
      '',
    ].join('\n');
    fs.writeFileSync(
      recipePath,
      header + 'appId: org.commcare.dalvik\n---\n- launchApp: x\n',
      'utf8',
    );

    const cloudRunRecipe = vi.fn();
    const cloud = { runRecipe: cloudRunRecipe } as any;
    const client = new MobileClient({ avd: {} as any, maestro: {} as any, cloud });

    await expect(client.runRecipe(recipePath, {}, tmpDir)).rejects.toMatchObject({
      code: 'RECIPE_STALE',
    });
    expect(cloudRunRecipe).not.toHaveBeenCalled();
  });

  it('passes a recipe with no provenance header (legacy / static palette)', async () => {
    const recipePath = path.join(tmpDir, 'legacy.yaml');
    fs.writeFileSync(
      recipePath,
      'appId: org.commcare.dalvik\n---\n- launchApp: x\n',
      'utf8',
    );

    const cloudRunRecipe = vi.fn().mockResolvedValue({
      status: 'pass', exitCode: 0, stdout: '', stderr: '',
      screenshotsDir: tmpDir, screenshots: [],
    });
    const cloud = { runRecipe: cloudRunRecipe } as any;
    const client = new MobileClient({ avd: {} as any, maestro: {} as any, cloud });

    await client.runRecipe(recipePath, {}, tmpDir);
    expect(cloudRunRecipe).toHaveBeenCalledTimes(1);
  });

  it('passes a recipe whose stamped SHA matches the current map', async () => {
    // Compute the actual current SHA so we can write a matching header.
    const { computeSelectorMapSha } = await import('../../../lib/recipe-provenance.js');
    const { getActiveSelectorMapMetadata } = await import('../../../mcp/mobile/recipe-resolver.js');
    process.env.ACE_CONNECT_APK_VERSION = '2.63.0';
    const map = getActiveSelectorMapMetadata('2.63.0');
    const recipePath = path.join(tmpDir, 'fresh.yaml');
    const header = [
      '# ACE Recipe Provenance — do not edit by hand',
      '# ace_version: 0.13.444',
      `# selector_map_sha: ${map.sha}`,
      `# selector_map_apk_version: ${map.apkVersion}`,
      '# generated_at: 2026-05-26T19:00:00.000Z',
      '',
      '',
    ].join('\n');
    fs.writeFileSync(
      recipePath,
      header + 'appId: org.commcare.dalvik\n---\n- launchApp: x\n',
      'utf8',
    );
    // Quiet the unused warning on computeSelectorMapSha import:
    expect(typeof computeSelectorMapSha).toBe('function');

    const cloudRunRecipe = vi.fn().mockResolvedValue({
      status: 'pass', exitCode: 0, stdout: '', stderr: '',
      screenshotsDir: tmpDir, screenshots: [],
    });
    const cloud = { runRecipe: cloudRunRecipe } as any;
    const client = new MobileClient({ avd: {} as any, maestro: {} as any, cloud });

    await client.runRecipe(recipePath, {}, tmpDir);
    expect(cloudRunRecipe).toHaveBeenCalledTimes(1);
  });
});

describe('MobileClient.runRecipe (provenance sidecars)', () => {
  // Closes the silent stale-carryover class: every PNG the backend
  // emits gets a `<png>.meta.json` sidecar stamped with the current
  // dispatch's recipe_id + dispatch_id + ace_version + git_sha. UX eval
  // and stale-detection consumers compare dispatch_id against the
  // current dispatch's ID to reject leftover PNGs.
  let savedBackend: string | undefined;
  let tmpDir: string;
  beforeEach(() => {
    savedBackend = process.env.ACE_MOBILE_BACKEND;
    process.env.ACE_MOBILE_BACKEND = 'cloud';
    clearSessionBackend();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-test-'));
  });
  afterEach(() => {
    if (savedBackend === undefined) delete process.env.ACE_MOBILE_BACKEND;
    else process.env.ACE_MOBILE_BACKEND = savedBackend;
    clearSessionBackend();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('writes a `.meta.json` sidecar next to every PNG the backend emits, with current-dispatch fields', async () => {
    const recipePath = path.join(tmpDir, 'claim-opp.yaml');
    fs.writeFileSync(
      recipePath,
      'appId: org.commcare.dalvik\n---\n- takeScreenshot: "fake"\n',
      'utf8',
    );
    // Screenshots land in a dedicated subdir (the production shape) —
    // runRecipe wipes it at execution start (#756), so the backend mock
    // must write the PNG AT CALL TIME (post-wipe), as a real backend does.
    const shotsDir = path.join(tmpDir, 'shots');
    const pngPath = path.join(shotsDir, 'fake.png');
    const cloudRunRecipe = vi.fn().mockImplementation(async () => {
      fs.writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      return {
        status: 'pass',
        exitCode: 0,
        stdout: '',
        stderr: '',
        screenshotsDir: shotsDir,
        screenshots: [
          { stepName: 'fake', path: pngPath, takenAt: new Date().toISOString(), bytes: 4 },
        ],
      };
    });
    const cloud = { runRecipe: cloudRunRecipe } as any;
    const client = new MobileClient({ avd: {} as any, maestro: {} as any, cloud });

    const result = await client.runRecipe(recipePath, {}, shotsDir);

    // Sidecar exists on disk.
    const sidecarPath = `${pngPath}.meta.json`;
    expect(fs.existsSync(sidecarPath)).toBe(true);
    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
    expect(sidecar.recipe_id).toBe('claim-opp');
    expect(sidecar.dispatch_id).toMatch(/^\d{13}-[a-z0-9]{6}$/);
    expect(sidecar.ace_version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeof sidecar.written_at_epoch_ms).toBe('number');

    // Returned ScreenshotEntry has provenance attached in-memory too.
    expect(result.screenshots[0].provenance).toBeDefined();
    expect(result.screenshots[0].provenance!.recipe_id).toBe('claim-opp');
    expect(result.screenshots[0].provenance!.dispatch_id).toBe(sidecar.dispatch_id);
  });

  it('two consecutive runRecipe invocations produce distinct dispatch_ids', async () => {
    const recipePath = path.join(tmpDir, 'r.yaml');
    fs.writeFileSync(recipePath, 'appId: x\n---\n- launchApp: x\n', 'utf8');
    const shotsDir = path.join(tmpDir, 'shots');

    // PNGs are written at backend-call time (post-wipe, #756), like a
    // real backend.
    const make = (pngName: string) => {
      const p = path.join(shotsDir, pngName);
      fs.writeFileSync(p, Buffer.from([0x89]));
      return p;
    };

    const cloudRunRecipe = vi
      .fn()
      .mockImplementationOnce(async () => ({
        status: 'pass', exitCode: 0, stdout: '', stderr: '',
        screenshotsDir: shotsDir,
        screenshots: [{ stepName: 'a', path: make('a.png'), takenAt: '', bytes: 1 }],
      }))
      .mockImplementationOnce(async () => ({
        status: 'pass', exitCode: 0, stdout: '', stderr: '',
        screenshotsDir: shotsDir,
        screenshots: [{ stepName: 'b', path: make('b.png'), takenAt: '', bytes: 1 }],
      }));
    const cloud = { runRecipe: cloudRunRecipe } as any;
    const client = new MobileClient({ avd: {} as any, maestro: {} as any, cloud });

    const r1 = await client.runRecipe(recipePath, {}, shotsDir);
    const r2 = await client.runRecipe(recipePath, {}, shotsDir);

    expect(r1.screenshots[0].provenance!.dispatch_id).not.toBe(
      r2.screenshots[0].provenance!.dispatch_id,
    );
  });

  it('a screenshot left over from a prior dispatch is REMOVED before the next dispatch runs (#756)', async () => {
    // The structural fix for the stale-carryover class: the next
    // dispatch wipes its own output dir at execution start, so a
    // leftover PNG (and its sidecar) from a prior run of THAT recipe
    // cannot sit where fresh artifacts land. (Pre-#756 this test pinned
    // the weaker detect-via-dispatch_id-mismatch contract; removal
    // supersedes it.) Since #1130 the output dir is the dispatch-scoped
    // `<root>/<recipeId>/`, so the mock writes into the dir it is HANDED
    // — exactly what a real backend does.
    const recipePath = path.join(tmpDir, 'r.yaml');
    fs.writeFileSync(recipePath, 'appId: x\n---\n- launchApp: x\n', 'utf8');
    const shotsRoot = path.join(tmpDir, 'shots');
    const runDir = path.join(shotsRoot, 'r');

    const cloudRunRecipe = vi.fn().mockImplementationOnce(async (_r: string, _e: unknown, dir: string) => {
      const p = path.join(dir, 'leftover.png');
      fs.writeFileSync(p, Buffer.from([0x89]));
      return {
        status: 'pass', exitCode: 0, stdout: '', stderr: '',
        screenshotsDir: dir,
        screenshots: [{ stepName: 'leftover', path: p, takenAt: '', bytes: 1 }],
      };
    });
    const cloud = { runRecipe: cloudRunRecipe } as any;
    const client = new MobileClient({ avd: {} as any, maestro: {} as any, cloud });

    const run1 = await client.runRecipe(recipePath, {}, shotsRoot);
    // Run 1's artifacts are on disk — exactly where run 2's would land.
    expect(run1.screenshotsDir).toBe(runDir);
    expect(fs.existsSync(path.join(runDir, 'leftover.png'))).toBe(true);
    expect(fs.existsSync(path.join(runDir, 'leftover.png.meta.json'))).toBe(true);

    // Run 2: the recipe FAILS at its first step and produces nothing —
    // the bednet-spot-check 20260612-1220 shape. The dir must come out
    // EMPTY of run 1's PNGs: a failed run must not leave prior
    // artifacts masquerading as its output.
    cloudRunRecipe.mockImplementationOnce(async (_r: string, _e: unknown, dir: string) => ({
      status: 'fail', exitCode: 1, stdout: '', stderr: 'tile matcher failed',
      screenshotsDir: dir,
      screenshots: [],
    }));
    const run2 = await client.runRecipe(recipePath, {}, shotsRoot);

    expect(run2.status).toBe('fail');
    expect(fs.existsSync(path.join(runDir, 'leftover.png'))).toBe(false);
    expect(fs.existsSync(path.join(runDir, 'leftover.png.meta.json'))).toBe(false);
  });
});

describe('MobileClient.runRecipe (screenshot-dir freshness, jjackson/ace#756)', () => {
  let savedBackend: string | undefined;
  let tmpDir: string;
  beforeEach(() => {
    savedBackend = process.env.ACE_MOBILE_BACKEND;
    process.env.ACE_MOBILE_BACKEND = 'cloud';
    clearSessionBackend();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freshdir-test-'));
  });
  afterEach(() => {
    if (savedBackend === undefined) delete process.env.ACE_MOBILE_BACKEND;
    else process.env.ACE_MOBILE_BACKEND = savedBackend;
    clearSessionBackend();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('wipes stale artifacts from its own output dir before the backend runs; fresh artifacts survive', async () => {
    const recipePath = path.join(tmpDir, 'journey.yaml');
    fs.writeFileSync(recipePath, 'appId: x\n---\n- launchApp: x\n', 'utf8');
    const shotsRoot = path.join(tmpDir, 'shots');
    // Since #1130 the dispatch's output dir is `<root>/<recipeId>/`.
    const runDir = path.join(shotsRoot, 'journey');
    fs.mkdirSync(runDir, { recursive: true });
    // Stale artifacts from "a prior execution of THIS recipe".
    fs.writeFileSync(path.join(runDir, 'journey-deliver-final.png'), 'STALE');
    fs.writeFileSync(path.join(runDir, 'journey-deliver-final.png.meta.json'), '{}');
    fs.writeFileSync(path.join(runDir, 'old-dump.xml'), '<hierarchy/>');

    const cloudRunRecipe = vi.fn().mockImplementation(async (_r: string, _e: unknown, dir: string) => {
      // At backend-call time the dir must ALREADY be empty — the wipe
      // happens before the flow runs, not after.
      expect(dir).toBe(runDir);
      expect(fs.readdirSync(dir)).toEqual([]);
      const fresh = path.join(dir, 'fresh.png');
      fs.writeFileSync(fresh, Buffer.from([0x89]));
      return {
        status: 'pass', exitCode: 0, stdout: '', stderr: '',
        screenshotsDir: dir,
        screenshots: [{ stepName: 'fresh', path: fresh, takenAt: '', bytes: 1 }],
      };
    });
    const cloud = { runRecipe: cloudRunRecipe } as any;
    const client = new MobileClient({ avd: {} as any, maestro: {} as any, cloud });

    const result = await client.runRecipe(recipePath, {}, shotsRoot);

    expect(result.status).toBe('pass');
    expect(cloudRunRecipe).toHaveBeenCalledTimes(1);
    const remaining = fs.readdirSync(runDir).sort();
    expect(remaining).toEqual(['fresh.png', 'fresh.png.meta.json']);
  });

  it('creates the dispatch output dir (under the root) when it does not exist yet', async () => {
    const recipePath = path.join(tmpDir, 'journey.yaml');
    fs.writeFileSync(recipePath, 'appId: x\n---\n- launchApp: x\n', 'utf8');
    const shotsRoot = path.join(tmpDir, 'brand', 'new-shots');

    const cloudRunRecipe = vi.fn().mockImplementation(async (_r: string, _e: unknown, dir: string) => {
      expect(dir).toBe(path.join(shotsRoot, 'journey'));
      expect(fs.existsSync(dir)).toBe(true);
      return {
        status: 'pass', exitCode: 0, stdout: '', stderr: '',
        screenshotsDir: dir, screenshots: [],
      };
    });
    const cloud = { runRecipe: cloudRunRecipe } as any;
    const client = new MobileClient({ avd: {} as any, maestro: {} as any, cloud });

    await client.runRecipe(recipePath, {}, shotsRoot);
    expect(cloudRunRecipe).toHaveBeenCalledTimes(1);
  });

  it('a freshness-gate rejection (RECIPE_STALE) does NOT wipe prior artifacts', async () => {
    // The wipe runs after the pre-flight gates: a rejected dispatch
    // produced nothing, so destroying prior artifacts would only lose
    // forensic evidence.
    const recipePath = path.join(tmpDir, 'stale.yaml');
    const header = [
      '# ACE Recipe Provenance — do not edit by hand',
      '# ace_version: 0.13.300',
      '# selector_map_sha: STALESHAxxxx',
      '# selector_map_apk_version: 2.63.0',
      '# generated_at: 2026-05-25T00:00:00.000Z',
      '',
      '',
    ].join('\n');
    fs.writeFileSync(recipePath, header + 'appId: x\n---\n- launchApp: x\n', 'utf8');
    const shotsRoot = path.join(tmpDir, 'shots');
    // Prior artifacts of the SAME recipe — i.e. inside the very dir this
    // dispatch would wipe if it got past the gate (#1130 namespace).
    const runDir = path.join(shotsRoot, 'stale');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'prior.png'), 'PRIOR');

    const cloud = { runRecipe: vi.fn() } as any;
    const client = new MobileClient({ avd: {} as any, maestro: {} as any, cloud });

    await expect(client.runRecipe(recipePath, {}, shotsRoot)).rejects.toMatchObject({
      code: 'RECIPE_STALE',
    });
    expect(fs.existsSync(path.join(runDir, 'prior.png'))).toBe(true);
  });
});

// dimagi-internal/ace#1130 — the class-level preventer for
// "one screenshotDir across two journeys destroys the first one's
// evidence". Phase 6 runs the Learn leg, then the Deliver leg, and the
// Deliver dispatch's legitimate start-of-run wipe (#756) used to land on
// the Learn leg's finished, PASSING screenshots + video. That loss is
// unrecoverable: Learn completion is one-way per (test user, opportunity)
// (#568/#570), so re-capture costs a whole fresh `/ace:run`.
//
// The fix must hold BOTH ways, which is why both directions are pinned
// here: journey A's captures survive journey B's dispatch, AND a
// dispatch still clears its OWN prior output (otherwise #756's
// stale-carryover class re-opens, which is what widening #1034's
// preserve-list would have done).
describe('MobileClient.runRecipe (dispatch-scoped output, dimagi-internal/ace#1130)', () => {
  let savedBackend: string | undefined;
  let tmpDir: string;
  beforeEach(() => {
    savedBackend = process.env.ACE_MOBILE_BACKEND;
    process.env.ACE_MOBILE_BACKEND = 'cloud';
    clearSessionBackend();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-scope-'));
  });
  afterEach(() => {
    if (savedBackend === undefined) delete process.env.ACE_MOBILE_BACKEND;
    else process.env.ACE_MOBILE_BACKEND = savedBackend;
    clearSessionBackend();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  /** A backend that writes one PNG + one mp4 into whatever dir it's handed. */
  const capturingBackend = () =>
    vi.fn().mockImplementation(async (recipe: string, _e: unknown, dir: string) => {
      const base = path.basename(recipe).replace(/\.ya?ml$/, '');
      const png = path.join(dir, `${base}-final.png`);
      fs.writeFileSync(png, Buffer.from([0x89]));
      fs.writeFileSync(path.join(dir, `${base}.mp4`), 'VIDEO');
      return {
        status: 'pass', exitCode: 0, stdout: '', stderr: '',
        screenshotsDir: dir,
        screenshots: [{ stepName: `${base}-final`, path: png, takenAt: '', bytes: 1 }],
      };
    });

  it("journey A's completed captures SURVIVE a later dispatch for journey B sharing one root", async () => {
    const learn = path.join(tmpDir, 'journey-learn.yaml');
    const deliver = path.join(tmpDir, 'journey-deliver.yaml');
    fs.writeFileSync(learn, 'appId: x\n---\n- launchApp: x\n', 'utf8');
    fs.writeFileSync(deliver, 'appId: x\n---\n- launchApp: x\n', 'utf8');
    // The bug shape: ONE root handed to both legs.
    const shotsRoot = path.join(tmpDir, 'shots');

    const cloud = { runRecipe: capturingBackend() } as any;
    const client = new MobileClient({ avd: {} as any, maestro: {} as any, cloud });

    const learnRun = await client.runRecipe(learn, {}, shotsRoot);
    expect(learnRun.status).toBe('pass');
    const learnPng = learnRun.screenshots[0].path;
    const learnMp4 = path.join(learnRun.screenshotsDir, 'journey-learn.mp4');
    expect(fs.existsSync(learnPng)).toBe(true);
    expect(fs.existsSync(learnMp4)).toBe(true);

    // Deliver leg, same root. Pre-#1130 this wiped the Learn leg's
    // screenshot set and video — the 20260731-1353 `journey_learn:
    // {count: 1, status: lost-not-recapturable}` outcome.
    const deliverRun = await client.runRecipe(deliver, {}, shotsRoot);
    expect(deliverRun.status).toBe('pass');

    expect(fs.existsSync(learnPng)).toBe(true);
    expect(fs.existsSync(`${learnPng}.meta.json`)).toBe(true);
    expect(fs.existsSync(learnMp4)).toBe(true);
    // ...and the two legs did not share a directory in the first place.
    expect(deliverRun.screenshotsDir).not.toBe(learnRun.screenshotsDir);
    expect(learnRun.screenshotsDir).toBe(path.join(shotsRoot, 'journey-learn'));
    expect(deliverRun.screenshotsDir).toBe(path.join(shotsRoot, 'journey-deliver'));
  });

  it("a dispatch still clears its OWN prior ordinary output, keeping #756's guarantee", async () => {
    const deliver = path.join(tmpDir, 'journey-deliver.yaml');
    fs.writeFileSync(deliver, 'appId: x\n---\n- launchApp: x\n', 'utf8');
    const shotsRoot = path.join(tmpDir, 'shots');

    const cloud = { runRecipe: capturingBackend() } as any;
    const client = new MobileClient({ avd: {} as any, maestro: {} as any, cloud });

    const first = await client.runRecipe(deliver, {}, shotsRoot);
    const stalePng = first.screenshots[0].path;
    const staleMp4 = path.join(first.screenshotsDir, 'journey-deliver.mp4');
    // #1034 artifacts written into the dispatch dir between attempts.
    fs.writeFileSync(path.join(first.screenshotsDir, '00-postlearn-landing.xml'), '<hierarchy/>');
    fs.writeFileSync(path.join(first.screenshotsDir, 'journey-deliver-FAILURE.png'), 'FORENSIC');

    // Attempt 2 of the SAME recipe: produces nothing (fails at step 1).
    (cloud.runRecipe as any).mockImplementationOnce(async (_r: string, _e: unknown, dir: string) => ({
      status: 'fail', exitCode: 1, stdout: '', stderr: 'tile matcher failed',
      screenshotsDir: dir, screenshots: [],
    }));
    const second = await client.runRecipe(deliver, {}, shotsRoot);

    expect(second.status).toBe('fail');
    expect(second.screenshotsDir).toBe(first.screenshotsDir);
    // Ordinary captures from attempt 1 are gone — no stale PNG/mp4 may
    // masquerade as this failed attempt's output (#756).
    expect(fs.existsSync(stalePng)).toBe(false);
    expect(fs.existsSync(`${stalePng}.meta.json`)).toBe(false);
    expect(fs.existsSync(staleMp4)).toBe(false);
    // ...while #1034's preserved classes still survive the wipe.
    expect(fs.existsSync(path.join(first.screenshotsDir, '00-postlearn-landing.xml'))).toBe(true);
    expect(fs.existsSync(path.join(first.screenshotsDir, 'journey-deliver-FAILURE.png'))).toBe(true);
  });

  it('a shallow/protected root is still refused — namespacing cannot smuggle one past the guard (#1111 hygiene)', async () => {
    const recipePath = path.join(tmpDir, 'journey-learn.yaml');
    fs.writeFileSync(recipePath, 'appId: x\n---\n- launchApp: x\n', 'utf8');
    const cloudRunRecipe = vi.fn();
    const cloud = { runRecipe: cloudRunRecipe } as any;
    const client = new MobileClient({ avd: {} as any, maestro: {} as any, cloud });

    // ace#1111 moved the first line of defence to CONTAINMENT, so `/tmp`
    // now trips "refusing to touch … must be under" before the shallow-path
    // check. Either refusal satisfies the property under test.
    await expect(client.runRecipe(recipePath, {}, '/tmp')).rejects.toThrow(
      /refusing to (wipe|touch)/,
    );
    expect(cloudRunRecipe).not.toHaveBeenCalled();
  });
});

describe('MobileClient.useCloud (dynamic resolution)', () => {
  let savedEnv: string | undefined;
  beforeEach(() => {
    savedEnv = process.env.ACE_MOBILE_BACKEND;
    delete process.env.ACE_MOBILE_BACKEND;
    clearSessionBackend();
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.ACE_MOBILE_BACKEND;
    else process.env.ACE_MOBILE_BACKEND = savedEnv;
    clearSessionBackend();
  });

  it('re-resolves between calls — toggling the session file flips routing', () => {
    const avd = {} as any;
    const maestro = {} as any;
    const cloud = {} as any;
    const client = new MobileClient({ avd, maestro, cloud });

    expect(client.useCloud).toBe(false); // default
    setSessionBackend('cloud');
    expect(client.useCloud).toBe(true);  // session file flipped
    setSessionBackend('local');
    expect(client.useCloud).toBe(false); // back to local
  });

  it('throws CLOUD_NOT_CONFIGURED when cloud is selected but client.cloud is null', async () => {
    setSessionBackend('cloud');
    // No cloud option passed → constructor catches the CLOUD_NOT_CONFIGURED
    // error from CloudBackend (no ACE_WEB env) and sets this.cloud = null.
    const prevBase = process.env.ACE_WEB_BASE_URL;
    const prevTok = process.env.ACE_WEB_PAT_TOKEN;
    delete process.env.ACE_WEB_BASE_URL;
    delete process.env.ACE_WEB_PAT_TOKEN;
    try {
      const client = new MobileClient({ avd: {} as any, maestro: {} as any });
      expect(client.cloud).toBeNull();
      // requireCloud throws synchronously — listAvds() itself raises before
      // returning a Promise. Either form (sync throw or Promise rejection)
      // would be valid; this asserts the actual runtime behavior.
      expect(() => client.listAvds()).toThrow(/cloud backend selected but not configured/);
    } finally {
      if (prevBase !== undefined) process.env.ACE_WEB_BASE_URL = prevBase;
      if (prevTok !== undefined) process.env.ACE_WEB_PAT_TOKEN = prevTok;
    }
  });
});

describe('MobileClient cloud-only diagnostic atoms', () => {
  let savedEnv: string | undefined;
  beforeEach(() => {
    savedEnv = process.env.ACE_MOBILE_BACKEND;
    delete process.env.ACE_MOBILE_BACKEND;
    clearSessionBackend();
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.ACE_MOBILE_BACKEND;
    else process.env.ACE_MOBILE_BACKEND = savedEnv;
    clearSessionBackend();
  });

  function fakeCloud() {
    return {
      diagnose: vi.fn().mockResolvedValue({ ssm_ok: true, adb_devices: [] }),
      restartRunner: vi.fn().mockResolvedValue({ ssm_ok: true }),
    } as any;
  }

  it('routes diagnose / restartRunner to the cloud backend when cloud is active', async () => {
    setSessionBackend('cloud');
    const cloud = fakeCloud();
    const client = new MobileClient({ avd: {} as any, maestro: {} as any, cloud });

    await client.diagnose();
    expect(cloud.diagnose).toHaveBeenCalledTimes(1);

    await client.restartRunner({ waitForReady: false });
    expect(cloud.restartRunner).toHaveBeenCalledWith({ waitForReady: false });
  });

  it('throws CLOUD_ONLY_OPERATION for the admin atoms when active backend is local', async () => {
    // Default is local (no session file, no env).
    const client = new MobileClient({ avd: {} as any, maestro: {} as any, cloud: fakeCloud() });
    expect(client.useCloud).toBe(false);

    // requireCloudOnly throws synchronously before returning a Promise,
    // matching the pattern used by listAvds (see useCloud test above).
    // `diagnose` is deliberately NOT in this list any more — see below.
    expect(() => client.restartRunner()).toThrow(/only available on the cloud/);
  });

  it('routes diagnose to the LOCAL backend when cloud is inactive (#961)', async () => {
    // Was CLOUD_ONLY_OPERATION until ace#961: that left the local backend
    // with no self-describing probe, so a raw `adb devices` on the default
    // 5037 (the MCP allocates its own, typically 5039) read as a dead
    // emulator with nothing in-session to contradict it.
    const avd = { diagnose: vi.fn().mockResolvedValue({ backend: 'local', adb_server_port: 5039 }) };
    const client = new MobileClient({ avd: avd as any, maestro: {} as any, cloud: fakeCloud() });
    expect(client.useCloud).toBe(false);

    const d = await client.diagnose();
    expect(avd.diagnose).toHaveBeenCalledTimes(1);
    expect(d).toEqual({ backend: 'local', adb_server_port: 5039 });
  });

  it('tags the cloud diagnose envelope with backend: cloud so callers can discriminate', async () => {
    setSessionBackend('cloud');
    const cloud = fakeCloud();
    const client = new MobileClient({ avd: {} as any, maestro: {} as any, cloud });
    const d = await client.diagnose();
    expect(d.backend).toBe('cloud');
  });
});

describe('MobileClient.assertMaestroDriverHealthy', () => {
  // Stage 0 (ace#1818) asks `pm list packages` before it trusts a liveness
  // probe. Unless a test says otherwise these fakes report the driver
  // PRESENT, which is the state every one of them describes:
  // installed-but-wedged. The one genuinely-fresh-AVD case overrides it.
  const DRIVER_PRESENT = { app: true, test: true, queryOk: true };
  const DRIVER_ABSENT = { app: false, test: false, queryOk: true };

  function makeClient(
    probeReturns: Array<{ healthy: boolean; reason?: string }>,
    repairActions: string[] = ['force-stop', 'uninstall'],
    driverPackages: { app: boolean; test: boolean; queryOk: boolean } = DRIVER_PRESENT,
  ) {
    const probeCalls: number[] = [];
    const avd = {
      ensureAvdRunning: vi.fn(),
      findRunningAvd: vi.fn(),
    } as any;
    const maestro = {
      probeDriver: vi.fn(async (port: number, timeoutMs: number) => {
        probeCalls.push(timeoutMs);
        const next = probeReturns.shift();
        if (!next) throw new Error('probeDriver called more times than scripted');
        return next;
      }),
      repairDriver: vi.fn(async () => repairActions),
      // Default: pretend driver was already installed. Tests that exercise
      // the fresh-install path override this on the returned `maestro`.
      ensureDriverInstalled: vi.fn(async () => ['already-installed']),
      driverPackagesInstalled: vi.fn(async () => driverPackages),
    } as any;
    return { client: new MobileClient({ avd, maestro }), probeCalls, maestro };
  }

  it('passes through cleanly when the driver is healthy on the first probe', async () => {
    const { client, probeCalls, maestro } = makeClient([{ healthy: true }]);
    await expect(client.assertMaestroDriverHealthy('emulator-5554')).resolves.toBeUndefined();
    expect(probeCalls).toEqual([20_000]); // single short-timeout probe
    expect(maestro.repairDriver).not.toHaveBeenCalled();
  });

  it('repairs + re-probes with the longer reinstall timeout when stage 1 fails', async () => {
    const { client, probeCalls, maestro } = makeClient([
      { healthy: false, reason: 'UNAVAILABLE' },
      { healthy: true },
    ]);
    await expect(client.assertMaestroDriverHealthy('emulator-5554')).resolves.toBeUndefined();
    expect(probeCalls).toEqual([20_000, 90_000]); // 2nd probe gets reinstall budget
    expect(maestro.repairDriver).toHaveBeenCalledTimes(1);
    expect(maestro.repairDriver).toHaveBeenCalledWith('emulator-5554');
  });

  it('throws MaestroDriverError when stage 2 probe still reports unhealthy', async () => {
    const { client } = makeClient([
      { healthy: false, reason: 'UNAVAILABLE' },
      { healthy: false, reason: 'still UNAVAILABLE after reinstall' },
    ]);
    await expect(client.assertMaestroDriverHealthy('emulator-5554')).rejects.toThrow(/Maestro driver.*unhealthy after recovery/);
  });

  it('skips the probe for non-emulator serials (real device)', async () => {
    const { client, maestro } = makeClient([]);
    await expect(client.assertMaestroDriverHealthy('abc123def')).resolves.toBeUndefined();
    expect(maestro.probeDriver).not.toHaveBeenCalled();
    expect(maestro.repairDriver).not.toHaveBeenCalled();
  });

  // Fresh-AVD path (the malaria-itn-fgd/20260515-1645 bug). The driver
  // was never installed → stage-1 probe fails → ensureDriverInstalled
  // installs it → re-probe with the extended timeout passes → repair
  // never runs.
  it('installs driver and recovers without repair on a fresh AVD (Stage 1.5 wins)', async () => {
    // Packages genuinely absent. Since ace#1818 Stage 0 reads that from
    // `pm list packages` and skips the 20s stage-1 liveness probe, which
    // could not have succeeded anyway — so the only probe here is the
    // post-install one.
    const { client, probeCalls, maestro } = makeClient(
      [{ healthy: true }], // post-install re-probe
      ['force-stop', 'uninstall'],
      DRIVER_ABSENT,
    );
    maestro.ensureDriverInstalled = vi.fn().mockResolvedValue([
      'pm-ready', 'apks-resolved', 'installed:app', 'installed:test', 'verified',
    ]);
    await expect(client.assertMaestroDriverHealthy('emulator-5554')).resolves.toBeUndefined();
    expect(maestro.ensureDriverInstalled).toHaveBeenCalledWith('emulator-5554');
    expect(maestro.repairDriver).not.toHaveBeenCalled();
    expect(probeCalls).toEqual([90_000]); // post-install probe gets full budget
  });

  // When the driver is already installed (wedged-but-installed — the
  // pre-fix recovery class), Stage 1.5 short-circuits and we fall
  // through to the existing repair path.
  it('skips post-install re-probe when already-installed, runs repair as before', async () => {
    const { client, probeCalls, maestro } = makeClient([
      { healthy: false, reason: 'UNAVAILABLE' },
      { healthy: true }, // post-repair re-probe
    ]);
    // Default ensureDriverInstalled returns ['already-installed'].
    await expect(client.assertMaestroDriverHealthy('emulator-5554')).resolves.toBeUndefined();
    expect(maestro.ensureDriverInstalled).toHaveBeenCalledWith('emulator-5554');
    expect(maestro.repairDriver).toHaveBeenCalledTimes(1);
    expect(probeCalls).toEqual([20_000, 90_000]); // probe1 + probe2 only — no probe1.5
  });

  // Fresh install that didn't recover on the post-install probe: must
  // fall through to repair (the wedged-after-install case). Repair runs
  // and re-probes with the 90s budget; if THAT probe succeeds, the heal
  // returns clean. This is the "Stage 1.5 installed APKs but driver
  // never bound" recovery path.
  it('falls through to repair when fresh install probe re-fails, then recovers via repair', async () => {
    const { client, probeCalls, maestro } = makeClient([
      { healthy: false, reason: 'UNAVAILABLE: io exception' }, // stage 1
      { healthy: false, reason: 'still UNAVAILABLE post-install' }, // stage 1.5
      { healthy: true }, // stage 2 post-repair
    ]);
    maestro.ensureDriverInstalled = vi.fn().mockResolvedValue([
      'package-list-before:app=false,test=false',
      'pm-ready', 'apks-resolved', 'installed:app', 'installed:test',
      'apk-install-results:app=ok,test=ok',
      'package-list-after:app=true,test=true', 'verified', 'instrumentation-kicked',
    ]);
    await expect(client.assertMaestroDriverHealthy('emulator-5554')).resolves.toBeUndefined();
    expect(maestro.ensureDriverInstalled).toHaveBeenCalledWith('emulator-5554');
    expect(maestro.repairDriver).toHaveBeenCalledTimes(1);
    expect(probeCalls).toEqual([20_000, 90_000, 90_000]); // probe1 + probe1.5 + probe2
  });

  // Live-reproduced on malaria-itn-fgd/20260515-1645 attempt 4
  // (v0.13.263): probe1 fails ("maestro hierarchy: io exception") →
  // ensureDriverInstalled detects both halves present + short-circuits
  // as already-installed → repairDriver uninstalls + reinstalls →
  // probe2 succeeds. Under pre-fix repairDriver (which only
  // uninstalled), probe2 would have failed because no auto-reinstall
  // happened in the heal flow.
  it('heal flow recovers from already-installed-but-wedged state via repair-then-reinstall', async () => {
    const { client, probeCalls, maestro } = makeClient([
      { healthy: false, reason: 'UNAVAILABLE: io exception' }, // probe1
      { healthy: true }, // probe2 — post-repair, packages back in place
    ]);
    // ensureDriverInstalled short-circuits because both halves are
    // present on the wedged AVD.
    maestro.ensureDriverInstalled = vi.fn().mockResolvedValue([
      'package-list-before:app=true,test=true',
      'already-installed',
    ]);
    // repairDriver now ends with installDriverApks actions — assert
    // the heal flow does not blow up on the expanded action list.
    maestro.repairDriver = vi.fn().mockResolvedValue([
      'force-stop',
      'uninstall',
      'pm-uninstall-user-0',
      'pm-ready',
      'apks-resolved',
      'installed:app',
      'installed:test',
      'apk-install-results:app=ok,test=ok',
      'package-list-after:app=true,test=true',
      'verified',
      'instrumentation-kicked',
    ]);
    await expect(client.assertMaestroDriverHealthy('emulator-5554')).resolves.toBeUndefined();
    expect(maestro.ensureDriverInstalled).toHaveBeenCalledWith('emulator-5554');
    expect(maestro.repairDriver).toHaveBeenCalledTimes(1);
    // Two probes only: stage-1 + stage-2 (no stage-1.5 because
    // ensureDriverInstalled returned already-installed).
    expect(probeCalls).toEqual([20_000, 90_000]);
  });

  // If ensureDriverInstalled throws (operator hasn't run mobile-bootstrap
  // yet), we don't fail the heal — fall through to repair. The install
  // error is recorded in MaestroDriverError.attempts when repair also
  // fails.
  it('falls through to repair when ensureDriverInstalled throws', async () => {
    const { client, maestro } = makeClient([
      { healthy: false, reason: 'UNAVAILABLE' },
      { healthy: false, reason: 'still UNAVAILABLE' },
    ]);
    maestro.ensureDriverInstalled = vi.fn().mockRejectedValue(
      new Error('Cannot find Maestro driver APKs — ~/.maestro/lib/maestro-client.jar does not exist'),
    );
    await expect(client.assertMaestroDriverHealthy('emulator-5554')).rejects.toThrow(
      /Maestro driver.*unhealthy after recovery/,
    );
    expect(maestro.repairDriver).toHaveBeenCalledTimes(1);
  });
});

describe('MobileClient.ensureAvdRunning', () => {
  it('chains AvdBackend.ensureAvdRunning then assertMaestroDriverHealthy', async () => {
    // Post-2026-05-14: heal always runs runLocalBootstrap; needs
    // bootstrapConfig + the AvdBackend methods bootstrap calls.
    const avd = {
      ensureAvdRunning: vi.fn().mockResolvedValue({ name: 'AVD', serial: 'emulator-5554', status: 'booted' }),
      requireRunningAvd: vi.fn().mockResolvedValue({ name: 'AVD', serial: 'emulator-5554', status: 'booted' }),
      // ace#1357 fix 3: registerTestUser now proves the device answers.
      probeDeviceReachable: vi.fn().mockResolvedValue({ reachable: true }),
      findRunningAvd: vi.fn().mockResolvedValue({ name: 'AVD', serial: 'emulator-5554', status: 'booted' }),
      listPackages: vi.fn().mockResolvedValue(['org.commcare.dalvik']),
      clearConnectAppData: vi.fn().mockResolvedValue(true),
      getFocusedActivity: vi.fn().mockResolvedValue('mResumedActivity: ActivityRecord{... OpportunitiesActivity}'),
      captureUiDump: vi.fn().mockResolvedValue({ xml: '', elements: [] }),
      readCrashLogcat: vi.fn().mockResolvedValue(''),
      saveSnapshot: vi.fn().mockResolvedValue({ avdName: 'AVD', snapshotName: 'registered-test-user', saved: true, output: 'OK' }),
      setGmsEnabled: vi.fn().mockResolvedValue(undefined),
    disableHeadsUpNotifications: vi.fn().mockResolvedValue(undefined),
    applyEnvironmentBaseline: vi.fn().mockResolvedValue('abc123def456'),
      grantRuntimePermissions: vi.fn().mockResolvedValue(undefined),
    } as any;
    const maestro = {
      probeDriver: vi.fn().mockResolvedValue({ healthy: true }),
      driverPackagesInstalled: vi.fn().mockResolvedValue({ app: true, test: true, queryOk: true }),
      repairDriver: vi.fn(),
      runRecipe: vi.fn().mockResolvedValue({
        status: 'pass', exitCode: 0, stdout: '', stderr: '', screenshotsDir: '/tmp/', screenshots: [],
      }),
    } as any;
    const bootstrapConfig = {
      apkVersion: '2.62.0',
      testUser: {
        phone: TEST_PHONE, phoneLocal: TEST_PHONE_LOCAL, countryCode: '7',
        pin: '1234', backupCode: 'backup', name: 'ACE Test',
      },
    };
    const client = new MobileClient({ avd, maestro, bootstrapConfig });
    const r = await client.ensureAvdRunning('AVD');
    expect(r.serial).toBe('emulator-5554');
    expect(avd.ensureAvdRunning).toHaveBeenCalledWith('AVD');
    expect(maestro.probeDriver).toHaveBeenCalledTimes(1);
  });

  it('propagates MaestroDriverError when the driver heal exhausts', async () => {
    const avd = {
      ensureAvdRunning: vi.fn().mockResolvedValue({ name: 'AVD', serial: 'emulator-5554', status: 'booted' }),
      listPackages: vi.fn().mockResolvedValue(['org.commcare.dalvik']),
      getFocusedActivity: vi.fn().mockResolvedValue('mResumedActivity: ActivityRecord{... OpportunitiesActivity}'),
      captureUiDump: vi.fn().mockResolvedValue({ xml: '', elements: [] }),
      readCrashLogcat: vi.fn().mockResolvedValue(''),
      loadSnapshot: vi.fn(),
    } as any;
    const maestro = {
      probeDriver: vi.fn()
        .mockResolvedValueOnce({ healthy: false, reason: 'UNAVAILABLE' })
        .mockResolvedValueOnce({ healthy: false, reason: 'still UNAVAILABLE' }),
      repairDriver: vi.fn().mockResolvedValue(['force-stop', 'uninstall']),
      // Driver was already installed — exercises the wedged-but-installed
      // path that the original test was written against (Stage 1.5 short-
      // circuits, Stage 2 runs).
      ensureDriverInstalled: vi.fn().mockResolvedValue(['already-installed']),
      driverPackagesInstalled: vi.fn().mockResolvedValue({ app: true, test: true, queryOk: true }),
    } as any;
    const client = new MobileClient({ avd, maestro });
    await expect(client.ensureAvdRunning('AVD')).rejects.toThrow(/Maestro driver.*unhealthy after recovery/);
  });

  // jjackson/ace#589 — the boot→driver→recipe handoff race. The driver probe
  // passes, then the gRPC channel drops on the registration recipe's first
  // deviceInfo. The funnel retries itself (cold-boot is idempotent) instead of
  // making the agent re-dispatch by hand.
  describe('boot-race retry', () => {
    function clientWithStubbedHeal() {
      const avd = {
        ensureAvdRunning: vi.fn().mockResolvedValue({ name: 'AVD', serial: 'emulator-5554', status: 'booted' }),
      } as any;
      const client = new MobileClient({ avd, maestro: {} as any });
      // Isolate the retry loop: the driver assert + restore are exercised by
      // their own tests above; here we script their resolution per attempt.
      vi.spyOn(client, 'assertMaestroDriverHealthy').mockResolvedValue(undefined);
      return { avd, client };
    }

    it('re-runs the whole funnel once on a boot-race error, then succeeds', async () => {
      const { avd, client } = clientWithStubbedHeal();
      const restore = vi
        .spyOn(client, 'restoreDeviceUserState')
        .mockRejectedValueOnce(
          new Error(
            'register_test_user part A failed: io.grpc.StatusRuntimeException: UNAVAILABLE\n' +
              'Caused by: dadb.AdbStreamClosed: ADB stream is closed for localId: 97188347',
          ),
        )
        .mockResolvedValueOnce({ attempted: true, classified_as: 'ready', steps: [] } as any);

      const r = await client.ensureAvdRunning('AVD');
      expect(r.serial).toBe('emulator-5554');
      expect(r.heal?.deviceUserState).toMatchObject({ classified_as: 'ready' });
      // Both the cold-boot and the restore ran twice — the full idempotent funnel.
      expect(avd.ensureAvdRunning).toHaveBeenCalledTimes(2);
      expect(restore).toHaveBeenCalledTimes(2);
    });

    it('does NOT retry a non-boot-race failure (throws on first attempt)', async () => {
      const { avd, client } = clientWithStubbedHeal();
      const restore = vi
        .spyOn(client, 'restoreDeviceUserState')
        .mockRejectedValue(new Error('register_test_user part B failed: element not found'));

      await expect(client.ensureAvdRunning('AVD')).rejects.toThrow(/part B failed/);
      expect(avd.ensureAvdRunning).toHaveBeenCalledTimes(1);
      expect(restore).toHaveBeenCalledTimes(1);
    });

    it('gives up after the bounded attempts when the boot-race persists', async () => {
      const { avd, client } = clientWithStubbedHeal();
      const restore = vi
        .spyOn(client, 'restoreDeviceUserState')
        .mockRejectedValue(new Error('dadb.AdbStreamClosed: ADB stream is closed for localId: 1'));

      await expect(client.ensureAvdRunning('AVD')).rejects.toThrow(/AdbStreamClosed/);
      expect(avd.ensureAvdRunning).toHaveBeenCalledTimes(2);
      expect(restore).toHaveBeenCalledTimes(2);
    });
  });
});

describe('detectAppCrashLoop (ace#950)', () => {
  // Verbatim shape of the benign lines every `uiautomator dump` writes. Captured
  // live from ACE_Pixel_API_34 on 2026-07-26 against a device with NO crash —
  // the first implementation of this detector (match FATAL EXCEPTION|AndroidRuntime
  // anywhere AND org.commcare.dalvik anywhere) returned true on exactly this input.
  const HEALTHY = [
    '07-26 09:17:35.494  9097  9097 D AndroidRuntime: >>>>>> START com.android.internal.os.RuntimeInit uid 2000 <<<<<<',
    '07-26 09:17:35.498  9097  9097 I AndroidRuntime: Using default boot image',
    '07-26 09:17:35.580  9097  9097 D AndroidRuntime: Calling main entry com.android.commands.uiautomator.Launcher',
    '07-26 09:17:33.758  8858  8887 I Maestro : Skipping invisible child: ... packageName: org.commcare.dalvik; className: android.view.View',
    '07-26 09:17:36.600  9097  9097 D AndroidRuntime: Shutting down VM',
  ].join('\n');

  // The ace#938 crash: CommCare 2.63.0 NPE in the jobs-list parser.
  const CRASH = [
    '07-25 02:31:09.118  4471  4471 E AndroidRuntime: FATAL EXCEPTION: main',
    '07-25 02:31:09.118  4471  4471 E AndroidRuntime: Process: org.commcare.dalvik, PID: 4471',
    '07-25 02:31:09.118  4471  4471 E AndroidRuntime: java.lang.NullPointerException: Attempt to invoke ExtUtil.writeDate(null)',
    '07-25 02:31:09.118  4471  4471 E AndroidRuntime: \tat org.commcare.android.database.connect.models.ConnectOpportunitiesParser.parse',
  ].join('\n');

  it('does NOT fire on a healthy device whose logcat carries uiautomator AndroidRuntime lines', () => {
    expect(detectAppCrashLoop(HEALTHY)).toBe(false);
  });

  it('fires on a real CommCare fatal crash block', () => {
    expect(detectAppCrashLoop(CRASH)).toBe(true);
  });

  it('does NOT fire when the fatal crash belongs to another package', () => {
    const other = [
      '07-25 02:31:09.118  4471  4471 E AndroidRuntime: FATAL EXCEPTION: main',
      '07-25 02:31:09.118  4471  4471 E AndroidRuntime: Process: com.android.settings, PID: 4471',
      '07-25 02:31:09.118  4471  4471 E AndroidRuntime: java.lang.IllegalStateException',
    ].join('\n');
    expect(detectAppCrashLoop(other)).toBe(false);
  });

  it('does NOT fire when a commcare mention is far from the fatal marker', () => {
    // The false-positive shape: an unrelated crash, plus commcare noise many
    // lines later. Proximity is what makes the signal trustworthy.
    const mixed = [
      '07-25 02:31:09.118  4471  4471 E AndroidRuntime: FATAL EXCEPTION: main',
      '07-25 02:31:09.118  4471  4471 E AndroidRuntime: Process: com.android.settings, PID: 4471',
      '07-25 02:31:09.118  4471  4471 E AndroidRuntime: java.lang.IllegalStateException',
      '07-25 02:31:09.200  4471  4471 I ActivityManager: unrelated line',
      '07-25 02:31:09.300  4471  4471 I Maestro : packageName: org.commcare.dalvik',
    ].join('\n');
    expect(detectAppCrashLoop(mixed)).toBe(false);
  });

  it('returns false on empty input', () => {
    expect(detectAppCrashLoop('')).toBe(false);
  });

  it('summarizeCrash pulls the exception line and a few frames', () => {
    const s = summarizeCrash(CRASH);
    expect(s).toContain('FATAL EXCEPTION');
    expect(s).toContain('NullPointerException');
    expect(s!.length).toBeLessThanOrEqual(400);
  });

  it('summarizeCrash returns undefined when there is no crash', () => {
    expect(summarizeCrash(HEALTHY)).toBeUndefined();
  });
});

describe('classifyDeviceUserState', () => {
  it('classifies app-crash-looping ahead of every screen-based signal (ace#938/#950)', () => {
    // The exact ace#938 situation: registration HAD succeeded, but the crash
    // bounced the device to the first-start splash. Screen signals say
    // needs-app-config; the crash is the truth, and it outranks them.
    const firstStartSplash = '<node text="Enter Code"/><node text="Welcome to CommCare!"/>';
    const crash = [
      'E AndroidRuntime: FATAL EXCEPTION: main',
      'E AndroidRuntime: Process: org.commcare.dalvik, PID: 4471',
    ].join('\n');
    expect(
      classifyDeviceUserState('mResumedActivity: CommCareSetupActivity', firstStartSplash, [
        'org.commcare.dalvik',
      ]),
    ).toBe('needs-app-config');
    expect(
      classifyDeviceUserState(
        'mResumedActivity: CommCareSetupActivity',
        firstStartSplash,
        ['org.commcare.dalvik'],
        crash,
      ),
    ).toBe('app-crash-looping');
  });

  it('still reports commcare-not-installed ahead of a crash (nothing to crash)', () => {
    const crash = 'E AndroidRuntime: FATAL EXCEPTION: main\nE AndroidRuntime: Process: org.commcare.dalvik';
    expect(classifyDeviceUserState('', '<dump/>', [], crash)).toBe('commcare-not-installed');
  });

  it('is unchanged when no logcat is supplied (back-compat with existing callers)', () => {
    const drawer = '<node text="Opportunities"/><node text="Work History"/>';
    expect(
      classifyDeviceUserState('mResumedActivity: CommCareSetupActivity', drawer, [
        'org.commcare.dalvik',
      ]),
    ).toBe('ready');
  });

  it('returns commcare-not-installed when org.commcare.dalvik is absent', () => {
    expect(classifyDeviceUserState('mResumedActivity: Launcher', '<dump/>', [])).toBe(
      'commcare-not-installed',
    );
  });

  it('returns needs-personal-id when the PersonalID drawer is showing', () => {
    const ui = '<node text="Logged out of PersonalID"/><node text="Reconfigure"/>';
    expect(
      classifyDeviceUserState('mResumedActivity: CommCareSetupActivity', ui, ['org.commcare.dalvik']),
    ).toBe('needs-personal-id');
  });

  it('returns needs-app-config when CommCareSetupActivity foregrounded AND no Connect nav drawer (ace#950)', () => {
    expect(
      classifyDeviceUserState('mResumedActivity: ActivityRecord{... CommCareSetupActivity}', '<dump/>', [
        'org.commcare.dalvik',
      ]),
    ).toBe('needs-app-config');
  });

  it('returns needs-app-config for the first-start "Enter Code" INSTALL tile (not PersonalID — ace#950)', () => {
    expect(
      classifyDeviceUserState('mResumedActivity: SomeUnknownActivity', '<node text="Enter Code"/>', [
        'org.commcare.dalvik',
      ]),
    ).toBe('needs-app-config');
  });

  it('returns ready for the post-register, pre-claim state (CommCareSetupActivity + Connect nav drawer items)', () => {
    // Live state after registerTestUser succeeds on a fresh AVD:
    // CommCare app slot still on first-start "Enter Code" screen, but
    // Connect nav drawer has the registered user's items. Phase 6
    // recipes (connect-login + connect-claim-opp) advance from here.
    const drawer = '<node text="ACE Test"/><node text="Opportunities"/><node text="Work History"/>';
    expect(
      classifyDeviceUserState('mResumedActivity: ActivityRecord{... CommCareSetupActivity}', drawer, [
        'org.commcare.dalvik',
      ]),
    ).toBe('ready');
  });

  it('returns ready when the home/opp tile activity is foregrounded', () => {
    expect(
      classifyDeviceUserState('mResumedActivity: ActivityRecord{... OpportunitiesActivity}', '', [
        'org.commcare.dalvik',
      ]),
    ).toBe('ready');
  });

  it('returns unknown when no markers match', () => {
    expect(classifyDeviceUserState('mResumedActivity: SomethingElse', '', ['org.commcare.dalvik'])).toBe(
      'unknown',
    );
  });

  it('prefers PersonalID drawer over CommCareSetupActivity (stacked-state case)', () => {
    const stacked = '<node text="Logged out of PersonalID"/>';
    expect(
      classifyDeviceUserState(
        'mResumedActivity: ActivityRecord{... CommCareSetupActivity}',
        stacked,
        ['org.commcare.dalvik'],
      ),
    ).toBe('needs-personal-id');
  });
});

describe('MobileClient.restoreDeviceUserState (post-2026-05-14: always-bootstrap)', () => {
  const readyAvd = { name: 'AVD', serial: 'emulator-5554', status: 'booted' } as const;

  // The 2026-05-14 refactor dropped snapshot-load tier-1 from the heal
  // path entirely. Every dispatch runs the deterministic bootstrap:
  // pm clear Connect's app data + registerTestUser. See
  // docs/learnings/2026-05-14-demo-user-no-otp.md for the rationale.

  function makeBootstrapAvd(opts: {
    apkInstalled?: boolean;
    clearOk?: boolean;
    postRegisterReady?: boolean;
  } = {}) {
    const apkInstalled = opts.apkInstalled ?? true;
    const clearOk = opts.clearOk ?? true;
    const postRegisterReady = opts.postRegisterReady ?? true;

    return {
      ensureAvdRunning: vi.fn().mockResolvedValue(readyAvd),
      requireRunningAvd: vi.fn().mockResolvedValue(readyAvd),
      // ace#1357 fix 3: registerTestUser now proves the device answers.
      probeDeviceReachable: vi.fn().mockResolvedValue({ reachable: true }),
      findRunningAvd: vi.fn().mockResolvedValue(readyAvd),
      listPackages: vi
        .fn()
        .mockResolvedValue(apkInstalled ? ['org.commcare.dalvik'] : []),
      clearConnectAppData: vi.fn().mockResolvedValue(clearOk),
      getFocusedActivity: vi.fn().mockResolvedValue(
        postRegisterReady
          ? 'mResumedActivity: ActivityRecord{... OpportunitiesActivity}'
          : 'mResumedActivity: CommCareSetupActivity',
      ),
      captureUiDump: vi.fn().mockResolvedValue({ xml: '', elements: [] }),
      readCrashLogcat: vi.fn().mockResolvedValue(''),
      installApk: vi.fn().mockResolvedValue({
        packageId: 'org.commcare.dalvik', versionName: '2.62.0', versionCode: 1, path: '/tmp/apk',
      }),
      saveSnapshot: vi.fn().mockResolvedValue({
        avdName: 'AVD', snapshotName: 'registered-test-user', saved: true, output: 'OK',
      }),
      setGmsEnabled: vi.fn().mockResolvedValue(undefined),
    disableHeadsUpNotifications: vi.fn().mockResolvedValue(undefined),
    applyEnvironmentBaseline: vi.fn().mockResolvedValue('abc123def456'),
      grantRuntimePermissions: vi.fn().mockResolvedValue(undefined),
      adbPortFromSerial: () => 5554,
      // loadSnapshot intentionally absent — the heal must never call it.
    } as any;
  }

  function makeMaestro() {
    return {
      probeDriver: vi.fn().mockResolvedValue({ healthy: true }),
      driverPackagesInstalled: vi.fn().mockResolvedValue({ app: true, test: true, queryOk: true }),
      repairDriver: vi.fn(),
      runRecipe: vi.fn().mockResolvedValue({
        status: 'pass', exitCode: 0, stdout: '', stderr: '', screenshotsDir: '/tmp/', screenshots: [],
      }),
    } as any;
  }

  const bootstrapConfig = {
    apkVersion: '2.62.0',
    testUser: {
      phone: TEST_PHONE, phoneLocal: TEST_PHONE_LOCAL, countryCode: '7',
      pin: '1234', backupCode: 'backup', name: 'ACE Test',
    },
  };

  it('always runs the deterministic bootstrap (no snapshot tier-1)', async () => {
    const avd = makeBootstrapAvd();
    const maestro = makeMaestro();
    const client = new MobileClient({ avd, maestro, bootstrapConfig });
    const r = await client.ensureAvdRunning('AVD');
    // The heal NEVER calls loadSnapshot — there's no fast path anymore.
    expect(avd.loadSnapshot).toBeUndefined(); // method not even mocked
    // It DOES wipe app data + register fresh:
    expect(avd.clearConnectAppData).toHaveBeenCalledWith('AVD');
    expect(maestro.runRecipe).toHaveBeenCalled();
    expect(r.heal?.deviceUserState).toMatchObject({
      attempted: true,
      healed_via: 'local-bootstrap',
      verified_as: 'ready',
    });
    expect(r.heal?.deviceUserState?.bootstrap_steps).toContain('app-data-cleared');
  });

  it('skips pm clear when APK was just freshly installed (no data to wipe)', async () => {
    const fakeApkBytes = new Uint8Array(2_000_000);
    fakeApkBytes[0] = 0x50; fakeApkBytes[1] = 0x4b; fakeApkBytes[2] = 0x03; fakeApkBytes[3] = 0x04;
    const uniqueVersion = `test-skip-clear-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true, status: 200, arrayBuffer: async () => fakeApkBytes.buffer,
    });
    const avd = makeBootstrapAvd();
    // First listPackages call (start of bootstrap): APK NOT installed.
    // Second call (ace#1818 post-install verification) and third
    // (post-bootstrap probe): APK present, i.e. the install landed.
    avd.listPackages = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue(['org.commcare.dalvik']);
    const maestro = makeMaestro();
    const client = new MobileClient({
      avd, maestro, fetchImpl,
      bootstrapConfig: { ...bootstrapConfig, apkVersion: uniqueVersion },
    });
    const r = await client.ensureAvdRunning('AVD');
    expect(avd.installApk).toHaveBeenCalledTimes(1);
    // pm clear is skipped — the fresh install IS clean state.
    expect(avd.clearConnectAppData).not.toHaveBeenCalled();
    expect(r.heal?.deviceUserState?.bootstrap_steps).toContain('apk-installed');
    expect(r.heal?.deviceUserState?.bootstrap_steps).not.toContain('app-data-cleared');
  });

  it('throws when bootstrapConfig is absent', async () => {
    const avd = makeBootstrapAvd();
    const maestro = makeMaestro();
    const client = new MobileClient({ avd, maestro, bootstrapConfig: null });
    await expect(client.ensureAvdRunning('AVD')).rejects.toThrow(
      /AVD per-user state is unhealthy.*bootstrapConfig:absent/,
    );
  });

  it('throws with verify class when bootstrap completes but post-probe still wiped', async () => {
    const avd = makeBootstrapAvd({ postRegisterReady: false });
    avd.captureUiDump = vi
      .fn()
      .mockResolvedValue({ xml: '<node text="Logged out of PersonalID"/>', elements: [] });
    const maestro = makeMaestro();
    const client = new MobileClient({ avd, maestro, bootstrapConfig });
    await expect(client.ensureAvdRunning('AVD')).rejects.toThrow(
      /AVD per-user state is unhealthy.*needs-personal-id.*verify:needs-personal-id/,
    );
  });

  it('surfaces a crash-loop as app-crash-looping WITH the stack, not the splash screen (ace#938/#950)', async () => {
    // The ace#938 shape end-to-end through the funnel: registration succeeded,
    // CommCare then crash-looped back to the first-start splash. Before this
    // wiring the probe reported the SCREEN (needs-app-config / first-start),
    // which sent the investigation at registration for hours. The crash must
    // win, and the signal must carry the stack.
    const avd = makeBootstrapAvd({ postRegisterReady: false });
    avd.captureUiDump = vi.fn().mockResolvedValue({
      xml: '<node text="Enter Code"/><node text="Welcome to CommCare!"/>',
      elements: [],
    });
    avd.readCrashLogcat = vi.fn().mockResolvedValue(
      [
        'E AndroidRuntime: FATAL EXCEPTION: main',
        'E AndroidRuntime: Process: org.commcare.dalvik, PID: 4471',
        'E AndroidRuntime: java.lang.NullPointerException: ExtUtil.writeDate(null)',
      ].join('\n'),
    );
    const maestro = makeMaestro();
    const client = new MobileClient({ avd, maestro, bootstrapConfig });
    await expect(client.ensureAvdRunning('AVD')).rejects.toThrow(/app-crash-looping/);
    // and the funnel actually READ logcat rather than the arg being dead code
    expect(avd.readCrashLogcat).toHaveBeenCalled();
  });

  it('a healthy device is unaffected by the crash probe (no false halt)', async () => {
    // Same benign uiautomator AndroidRuntime noise that broke the first
    // detector implementation, now flowing through the real probe path.
    const avd = makeBootstrapAvd({ postRegisterReady: true });
    avd.readCrashLogcat = vi.fn().mockResolvedValue(
      [
        'D AndroidRuntime: >>>>>> START com.android.internal.os.RuntimeInit uid 2000 <<<<<<',
        'I Maestro : packageName: org.commcare.dalvik; className: android.view.View',
      ].join('\n'),
    );
    const maestro = makeMaestro();
    const client = new MobileClient({ avd, maestro, bootstrapConfig });
    await expect(client.ensureAvdRunning('AVD')).resolves.toBeTruthy();
  });

  it('an unreadable logcat degrades to no-crash rather than failing the probe', async () => {
    const avd = makeBootstrapAvd({ postRegisterReady: true });
    avd.readCrashLogcat = vi.fn().mockRejectedValue(new Error('adb: device offline'));
    const maestro = makeMaestro();
    const client = new MobileClient({ avd, maestro, bootstrapConfig });
    await expect(client.ensureAvdRunning('AVD')).resolves.toBeTruthy();
  });

  it('cloud backend with LIVE_REGISTER unset returns the legacy stub', async () => {
    setSessionBackend('cloud');
    const savedFlag = process.env.ACE_MOBILE_CLOUD_LIVE_REGISTER;
    delete process.env.ACE_MOBILE_CLOUD_LIVE_REGISTER;
    try {
      const cloud = {
        ensureAvdRunning: vi
          .fn()
          .mockResolvedValue({ name: 'cloud', serial: 'cloud:i-abc', status: 'booted' }),
      } as any;
      // No-op local backends — should not be touched on cloud routing.
      const avd = { loadSnapshot: vi.fn() } as any;
      const maestro = {} as any;
      const client = new MobileClient({ avd, maestro, cloud });
      const r = await client.ensureAvdRunning('cloud');
      expect(cloud.ensureAvdRunning).toHaveBeenCalledWith('cloud');
      // No local snapshot-load on cloud — local backends aren't touched.
      expect(avd.loadSnapshot).not.toHaveBeenCalled();
      expect(r.serial).toBe('cloud:i-abc');
      // LIVE_REGISTER unset → `restoreDeviceUserState`'s cloud branch
      // returns the legacy stub (the pre-Phase-D AMI's cold-boot path
      // was the restore mechanism). Same shape callers got pre-2026-05-26.
      expect(r.heal?.deviceUserState).toEqual({
        classified_as: 'unknown',
        attempted: false,
      });
    } finally {
      if (savedFlag === undefined) delete process.env.ACE_MOBILE_CLOUD_LIVE_REGISTER;
      else process.env.ACE_MOBILE_CLOUD_LIVE_REGISTER = savedFlag;
      clearSessionBackend();
    }
  });

  it('cloud backend with LIVE_REGISTER=true dispatches cloudBootstrapHeal', async () => {
    // Post-Phase-D AMI: cold-boot no longer pre-bakes the demo user, so
    // the heal funnel must drive registration inline on every dispatch.
    // Pre-2026-05-26 the cloud branch short-circuited regardless of
    // LIVE_REGISTER and silently left the AVD unregistered, forcing
    // operators to bail mid-`/ace:run` and run `/ace:mobile-bootstrap`
    // by hand. Live observed in bednet-spot-check run 20260525-2013,
    // Phase 6.
    setSessionBackend('cloud');
    const ENV_KEYS = [
      'ACE_MOBILE_CLOUD_LIVE_REGISTER',
      'ACE_CONNECT_APK_VERSION',
      'ACE_E2E_PHONE',
      'ACE_E2E_PHONE_LOCAL',
      'ACE_E2E_COUNTRY_CODE',
      'ACE_E2E_PIN',
      'ACE_E2E_BACKUP_CODE',
      'ACE_E2E_NAME',
    ] as const;
    const saved: Record<string, string | undefined> = {};
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.ACE_MOBILE_CLOUD_LIVE_REGISTER = 'true';
    process.env.ACE_CONNECT_APK_VERSION = '2.63.0';
    process.env.ACE_E2E_PHONE = TEST_PHONE;
    process.env.ACE_E2E_PHONE_LOCAL = TEST_PHONE_LOCAL;
    process.env.ACE_E2E_COUNTRY_CODE = '+7';
    process.env.ACE_E2E_PIN = '0000';
    process.env.ACE_E2E_BACKUP_CODE = '0000';
    process.env.ACE_E2E_NAME = 'ACE Test';
    try {
      const cloudRegister = vi
        .fn()
        .mockResolvedValue({ alreadyRegistered: false, phone: TEST_PHONE });
      const cloud = {
        ensureAvdRunning: vi
          .fn()
          .mockResolvedValue({ name: 'cloud', serial: 'cloud:i-abc', status: 'booted' }),
        clearAppData: vi.fn().mockResolvedValue(true),
        registerTestUser: cloudRegister,
      } as any;
      const avd = { loadSnapshot: vi.fn() } as any;
      const maestro = {} as any;
      const client = new MobileClient({ avd, maestro, cloud });

      const r = await client.ensureAvdRunning('cloud');

      expect(cloud.ensureAvdRunning).toHaveBeenCalledWith('cloud');
      expect(cloud.clearAppData).toHaveBeenCalledWith('org.commcare.dalvik');
      // registerTestUser was called with credentials derived from the
      // ACE_E2E_* env — verifying the cloud heal actually drives
      // bootstrap (and consumes the same env vars the local heal does).
      expect(cloudRegister).toHaveBeenCalledTimes(1);
      const regArgs = cloudRegister.mock.calls[0][0];
      expect(regArgs.phone).toBe(TEST_PHONE);
      expect(regArgs.phoneLocal).toBe(TEST_PHONE_LOCAL);
      expect(regArgs.pin).toBe('0000');
      // The post-heal log reflects an actual attempt — not the stub. It
      // does NOT claim a verified state: nothing on this path probes the
      // device, so `verified_as` is absent (ace#1067's cloud twin).
      expect(r.heal?.deviceUserState).toMatchObject({
        attempted: true,
        healed_via: 'cloud-bootstrap',
      });
      expect(r.heal?.deviceUserState?.verified_as).toBeUndefined();
    } finally {
      for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      clearSessionBackend();
    }
  });
});

describe('missingBootstrapEnvVars + bootstrapConfigFromEnv', () => {
  const KEYS = [
    'ACE_CONNECT_APK_VERSION',
    'ACE_E2E_PHONE',
    'ACE_E2E_PHONE_LOCAL',
    'ACE_E2E_COUNTRY_CODE',
    'ACE_E2E_PIN',
    'ACE_E2E_BACKUP_CODE',
    'ACE_E2E_NAME',
  ] as const;
  let saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved = {};
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('returns ALL seven names when none are set', () => {
    expect(missingBootstrapEnvVars().sort()).toEqual([...KEYS].sort());
    expect(bootstrapConfigFromEnv()).toBeNull();
  });

  it('returns only the missing names when some are set', () => {
    process.env.ACE_CONNECT_APK_VERSION = '2.62.0';
    process.env.ACE_E2E_PHONE = TEST_PHONE;
    process.env.ACE_E2E_PHONE_LOCAL = TEST_PHONE_LOCAL;
    // PIN, NAME, COUNTRY_CODE, BACKUP_CODE still missing
    expect(missingBootstrapEnvVars().sort()).toEqual(
      ['ACE_E2E_COUNTRY_CODE', 'ACE_E2E_PIN', 'ACE_E2E_BACKUP_CODE', 'ACE_E2E_NAME'].sort(),
    );
    expect(bootstrapConfigFromEnv()).toBeNull();
  });

  it('returns [] and a populated config when all seven are set', () => {
    process.env.ACE_CONNECT_APK_VERSION = '2.62.0';
    process.env.ACE_E2E_PHONE = TEST_PHONE;
    process.env.ACE_E2E_PHONE_LOCAL = TEST_PHONE_LOCAL;
    process.env.ACE_E2E_COUNTRY_CODE = '7';
    process.env.ACE_E2E_PIN = '1234';
    process.env.ACE_E2E_BACKUP_CODE = 'BACKUP1';
    process.env.ACE_E2E_NAME = 'ACE Test';
    expect(missingBootstrapEnvVars()).toEqual([]);
    expect(bootstrapConfigFromEnv()).toEqual({
      apkVersion: '2.62.0',
      testUser: {
        phone: TEST_PHONE,
        phoneLocal: TEST_PHONE_LOCAL,
        countryCode: '7',
        pin: '1234',
        backupCode: 'BACKUP1',
        name: 'ACE Test',
      },
    });
  });

  it('treats empty-string env vars the same as unset (missing)', () => {
    for (const k of KEYS) process.env[k] = 'x';
    process.env.ACE_E2E_PIN = '';
    expect(missingBootstrapEnvVars()).toEqual(['ACE_E2E_PIN']);
    expect(bootstrapConfigFromEnv()).toBeNull();
  });
});

describe('restoreDeviceUserState: bootstrapConfig-absent error names specific missing vars', () => {
  const readyAvd = { name: 'AVD', serial: 'emulator-5554', status: 'booted' } as const;
  const KEYS = [
    'ACE_CONNECT_APK_VERSION',
    'ACE_E2E_PHONE',
    'ACE_E2E_PHONE_LOCAL',
    'ACE_E2E_COUNTRY_CODE',
    'ACE_E2E_PIN',
    'ACE_E2E_BACKUP_CODE',
    'ACE_E2E_NAME',
  ] as const;
  let saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved = {};
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('enumerates the specific missing env var names when tier-1 fails and env is partial', async () => {
    // Set 6 of 7 so the failure surfaces a single name. The previous
    // "bootstrapConfig:absent" message gave an operator no signal about
    // which env var was missing — required a manual diff against .env.tpl.
    process.env.ACE_CONNECT_APK_VERSION = '2.62.0';
    process.env.ACE_E2E_PHONE = TEST_PHONE;
    process.env.ACE_E2E_PHONE_LOCAL = TEST_PHONE_LOCAL;
    process.env.ACE_E2E_COUNTRY_CODE = '7';
    process.env.ACE_E2E_PIN = '1234';
    process.env.ACE_E2E_BACKUP_CODE = 'BACKUP1';
    // ACE_E2E_NAME intentionally omitted.
    const avd = {
      ensureAvdRunning: vi.fn().mockResolvedValue(readyAvd),
      listPackages: vi.fn().mockResolvedValue(['org.commcare.dalvik']),
      getFocusedActivity: vi.fn(),
      captureUiDump: vi.fn(),
      readCrashLogcat: vi.fn().mockResolvedValue(''),
      loadSnapshot: vi.fn().mockResolvedValue({
        avdName: 'AVD',
        snapshotName: 'registered-test-user',
        saved: false,
        output: 'snapshot does not exist',
      }),
    } as any;
    const maestro = {
      probeDriver: vi.fn().mockResolvedValue({ healthy: true }),
      driverPackagesInstalled: vi.fn().mockResolvedValue({ app: true, test: true, queryOk: true }),
      repairDriver: vi.fn(),
    } as any;
    // Default ctor reads env — so bootstrapConfig will be null because
    // ACE_E2E_NAME is missing, but the error message must say so.
    const client = new MobileClient({ avd, maestro });
    await expect(client.ensureAvdRunning('AVD')).rejects.toThrow(/missing env: ACE_E2E_NAME/);
  });

  it('explicit null bootstrapConfig surfaces "explicitly disabled by caller" — distinct from env-missing', async () => {
    const avd = {
      ensureAvdRunning: vi.fn().mockResolvedValue(readyAvd),
      listPackages: vi.fn().mockResolvedValue(['org.commcare.dalvik']),
      getFocusedActivity: vi.fn(),
      captureUiDump: vi.fn(),
      readCrashLogcat: vi.fn().mockResolvedValue(''),
      loadSnapshot: vi.fn().mockResolvedValue({
        avdName: 'AVD',
        snapshotName: 'registered-test-user',
        saved: false,
        output: 'snapshot does not exist',
      }),
    } as any;
    const maestro = {
      probeDriver: vi.fn().mockResolvedValue({ healthy: true }),
      driverPackagesInstalled: vi.fn().mockResolvedValue({ app: true, test: true, queryOk: true }),
      repairDriver: vi.fn(),
    } as any;
    // All env vars populated → bootstrapConfigFromEnv would succeed, but
    // caller explicitly overrides to null.
    for (const k of KEYS) process.env[k] = 'x';
    const client = new MobileClient({ avd, maestro, bootstrapConfig: null });
    await expect(client.ensureAvdRunning('AVD')).rejects.toThrow(/explicitly disabled by caller/);
  });
});

describe('MobileClient.restoreDeviceUserState — cloud branch', () => {
  let savedBackend: string | undefined;
  let savedFlag: string | undefined;
  const cloudAvd = { name: 'cloud', serial: 'cloud:i-test', status: 'booted' } as const;
  const ENV_KEYS = [
    'ACE_CONNECT_APK_VERSION',
    'ACE_E2E_PHONE',
    'ACE_E2E_PHONE_LOCAL',
    'ACE_E2E_COUNTRY_CODE',
    'ACE_E2E_PIN',
    'ACE_E2E_BACKUP_CODE',
    'ACE_E2E_NAME',
  ] as const;
  let savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedBackend = process.env.ACE_MOBILE_BACKEND;
    savedFlag = process.env.ACE_MOBILE_CLOUD_LIVE_REGISTER;
    process.env.ACE_MOBILE_BACKEND = 'cloud';
    savedEnv = {};
    for (const k of ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    if (savedBackend === undefined) delete process.env.ACE_MOBILE_BACKEND;
    else process.env.ACE_MOBILE_BACKEND = savedBackend;
    if (savedFlag === undefined) delete process.env.ACE_MOBILE_CLOUD_LIVE_REGISTER;
    else process.env.ACE_MOBILE_CLOUD_LIVE_REGISTER = savedFlag;
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  const cloudBootstrapConfig = {
    apkVersion: '2.62.0',
    testUser: {
      phone: TEST_PHONE,
      phoneLocal: TEST_PHONE_LOCAL,
      countryCode: '+7',
      pin: '111111',
      backupCode: '222222',
      name: 'ACE Test',
    },
  };

  it('returns the legacy no-op stub when ACE_MOBILE_CLOUD_LIVE_REGISTER is unset', async () => {
    // Pre-Phase-D rollout state: the AMI cold-boot path registers the
    // user. The heal must continue to be a no-op stub so existing dispatches
    // don't change behavior.
    delete process.env.ACE_MOBILE_CLOUD_LIVE_REGISTER;
    const cloud = {
      clearAppData: vi.fn(),
      registerTestUser: vi.fn(),
    } as any;
    const client = new MobileClient({
      avd: {} as any,
      maestro: {} as any,
      cloud,
      bootstrapConfig: cloudBootstrapConfig,
    });
    const heal = await client.restoreDeviceUserState(cloudAvd);
    expect(heal).toEqual({ classified_as: 'unknown', attempted: false });
    expect(cloud.clearAppData).not.toHaveBeenCalled();
    expect(cloud.registerTestUser).not.toHaveBeenCalled();
  });

  it('runs cloud-bootstrap heal when ACE_MOBILE_CLOUD_LIVE_REGISTER=true', async () => {
    // Post-Phase-D state: AMI no longer pre-bakes the user, so the heal
    // MUST run pm clear + registerTestUser via the cloud endpoints.
    process.env.ACE_MOBILE_CLOUD_LIVE_REGISTER = 'true';
    const cloud = {
      clearAppData: vi.fn().mockResolvedValue(true),
      registerTestUser: vi.fn().mockResolvedValue({
        alreadyRegistered: false,
        phone: TEST_PHONE,
        backupCode: '222222',
      }),
    } as any;
    const client = new MobileClient({
      avd: {} as any,
      maestro: {} as any,
      cloud,
      bootstrapConfig: cloudBootstrapConfig,
      staticRecipesDir: new URL('../../../mcp/mobile/recipes/static/', import.meta.url).pathname,
    });
    const heal = await client.restoreDeviceUserState(cloudAvd);
    expect(cloud.clearAppData).toHaveBeenCalledWith('org.commcare.dalvik');
    expect(cloud.registerTestUser).toHaveBeenCalledTimes(1);
    // `classified_as: 'unknown'` and no `verified_as` — the cloud path runs
    // no verification probe, so it reports the call it made, not a device
    // state it never observed (ace#1067). Detailed coverage of the honesty
    // contract lives in test/mcp/mobile/bootstrap-honesty.test.ts.
    expect(heal).toMatchObject({
      classified_as: 'unknown',
      attempted: true,
      healed_via: 'cloud-bootstrap',
    });
    expect(heal.verified_as).toBeUndefined();
    expect(heal.bootstrap_steps).toEqual(['app-data-cleared', 'registered-unverified']);
  });

  it('emits app-data-clear-noop step when pm clear surfaces cleared=false (APK not installed)', async () => {
    // Post-Phase-D AMI ships CommCare installed via the same state
    // mechanism, so pm clear should succeed. But on a partially-broken
    // AVD it's possible for the package to be absent; the heal must
    // tolerate that and proceed to register (which itself reinstalls).
    process.env.ACE_MOBILE_CLOUD_LIVE_REGISTER = 'true';
    const cloud = {
      clearAppData: vi.fn().mockResolvedValue(false),
      registerTestUser: vi.fn().mockResolvedValue({
        alreadyRegistered: true,
        phone: TEST_PHONE,
      }),
    } as any;
    const client = new MobileClient({
      avd: {} as any,
      maestro: {} as any,
      cloud,
      bootstrapConfig: cloudBootstrapConfig,
      staticRecipesDir: new URL('../../../mcp/mobile/recipes/static/', import.meta.url).pathname,
    });
    const heal = await client.restoreDeviceUserState(cloudAvd);
    expect(heal.bootstrap_steps).toEqual([
      'app-data-clear-noop',
      'register-already-unverified',
    ]);
  });

  it('throws DeviceUserStateError naming the missing env var when bootstrapConfig is absent', async () => {
    // Even on cloud, the heal needs the test-user credentials —
    // without them we have nothing to register. The error must
    // enumerate the specific missing vars so the operator doesn't
    // have to diff against .env.tpl.
    process.env.ACE_MOBILE_CLOUD_LIVE_REGISTER = 'true';
    process.env.ACE_CONNECT_APK_VERSION = '2.62.0';
    process.env.ACE_E2E_PHONE = TEST_PHONE;
    process.env.ACE_E2E_PHONE_LOCAL = TEST_PHONE_LOCAL;
    process.env.ACE_E2E_COUNTRY_CODE = '+7';
    process.env.ACE_E2E_PIN = '111111';
    process.env.ACE_E2E_BACKUP_CODE = '222222';
    // ACE_E2E_NAME intentionally omitted.
    const cloud = { clearAppData: vi.fn(), registerTestUser: vi.fn() } as any;
    const client = new MobileClient({
      avd: {} as any,
      maestro: {} as any,
      cloud,
      // Default ctor reads env → bootstrapConfig will be null.
    });
    await expect(client.restoreDeviceUserState(cloudAvd)).rejects.toThrow(
      /missing env: ACE_E2E_NAME/,
    );
  });
});

describe('classifyDeviceUserState: scoped regexes reject deeply-nested false positives', () => {
  it('does NOT false-positive on "Reconfigure" appearing in a non-text attribute or deep node body', () => {
    // Pre-scoping, the regex `/Reconfigure/i` would match anywhere in
    // the XML — including a Help dialog's accessibility content or a
    // settings tooltip. Both of those are real strings CommCare could
    // surface in unrelated dialogs; the scoped regex requires the
    // string be inside `text="..."` or `content-desc="..."`.
    const dump = `<hierarchy>
      <!-- Reconfigure mentioned in a comment, NOT a UI element -->
      <node class="android.widget.HelpDialog" help-target="something Reconfigure"/>
      <node text="Welcome" />
      <node text="OK" />
    </hierarchy>`;
    expect(classifyDeviceUserState('mResumedActivity: Launcher', dump, ['org.commcare.dalvik'])).toBe(
      'unknown',
    );
  });

  it('still classifies needs-personal-id when "Reconfigure" appears in a text attribute (real wipe banner)', () => {
    const dump = '<node text="Reconfigure" resource-id="reconfigure_button"/>';
    expect(
      classifyDeviceUserState('mResumedActivity: CommCareSetupActivity', dump, ['org.commcare.dalvik']),
    ).toBe('needs-personal-id');
  });

  it('still classifies needs-personal-id when the wipe phrase is in content-desc (accessibility-only label)', () => {
    const dump = '<node content-desc="Logged out of PersonalID"/>';
    expect(
      classifyDeviceUserState('mResumedActivity: CommCareSetupActivity', dump, ['org.commcare.dalvik']),
    ).toBe('needs-personal-id');
  });

  it('PersonalID-wipe banner takes precedence over positive Connect-nav signals (stacked-state real case)', () => {
    // The drawer can still show cached nav items briefly after a
    // server-side wipe lands the banner. The wipe banner must win.
    const dump =
      '<node text="Logged out of PersonalID"/><node text="Opportunities"/><node text="Work History"/>';
    expect(
      classifyDeviceUserState('mResumedActivity: HomeActivity', dump, ['org.commcare.dalvik']),
    ).toBe('needs-personal-id');
  });
});

describe('registerTestUser: tempdir lifecycle', () => {
  it('cleans up the temp registration dir on success', async () => {
    // Scoped to a dir only this test writes to. Diffing the GLOBAL
    // os.tmpdir() made the assertion depend on whether anything else on
    // the machine happened to register a user in the same window —
    // another live ACE session, another vitest worker, a second suite.
    // Measured 8 failures across 8 runs with one concurrent writer. ace#1942.
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-regtmp-test-'));
    const before = new Set(fs.readdirSync(tmpRoot).filter((f) => f.startsWith('ace-mobile-reg-')));
    const { avd, maestro } = fakeMaestroAndAvd({
      registerToOtp: 'pass',
      registerFromOtp: 'pass',
      otp: '123456',
    });
    const client = new MobileClient({ avd, maestro, staticRecipesDir: REAL_STATIC_DIR, regTmpRoot: tmpRoot });
    await client.registerTestUser({
      avdName: 'AVD',
      phone: '+74260000001',
      phoneLocal: '4260000001',
      countryCode: '+7',
      pin: '111111',
      backupCode: '222222',
      name: 'ACE Test',
    });
    const after = new Set(fs.readdirSync(tmpRoot).filter((f) => f.startsWith('ace-mobile-reg-')));
    // The new dir created during this call must have been removed.
    const created = [...after].filter((f) => !before.has(f));
    expect(created).toEqual([]);
  });

  it('creates its scratch dir under regTmpRoot, never the global os.tmpdir()', () => {
    // The invariant behind ace#1942: the assertions above are only
    // meaningful if the client actually honours the seam. Without it they
    // silently go back to diffing a directory the whole machine writes to,
    // and start failing on other people's work rather than on this code.
    const scoped = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-regtmp-seam-'));
    try {
      const { avd, maestro } = fakeMaestroAndAvd({
        registerToOtp: 'pass',
        registerFromOtp: 'pass',
        otp: '123456',
      });
      const client = new MobileClient({
        avd,
        maestro,
        staticRecipesDir: REAL_STATIC_DIR,
        regTmpRoot: scoped,
      });
      expect(client.regTmpRoot).toBe(scoped);
      expect(client.regTmpRoot).not.toBe(os.tmpdir());

      // Omitted -> production default is still the global tmpdir.
      const dflt = new MobileClient({ avd, maestro, staticRecipesDir: REAL_STATIC_DIR });
      expect(dflt.regTmpRoot).toBe(os.tmpdir());
    } finally {
      fs.rmSync(scoped, { recursive: true, force: true });
    }
  });

  it('keeps the temp registration dir on failure for post-mortem', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-regtmp-test-'));
    const before = new Set(fs.readdirSync(tmpRoot).filter((f) => f.startsWith('ace-mobile-reg-')));
    const { avd, maestro } = fakeMaestroAndAvd({
      registerToOtp: 'fail', // part A fails — registration throws
      registerFromOtp: 'pass',
      otp: '123456',
    });
    const client = new MobileClient({ avd, maestro, staticRecipesDir: REAL_STATIC_DIR, regTmpRoot: tmpRoot });
    await expect(
      client.registerTestUser({
        avdName: 'AVD',
        phone: '+74260000001',
        phoneLocal: '4260000001',
        countryCode: '+7',
        pin: '111111',
        backupCode: '222222',
        name: 'ACE Test',
      }),
    ).rejects.toThrow(/register_test_user part A failed/);
    const after = new Set(fs.readdirSync(tmpRoot).filter((f) => f.startsWith('ace-mobile-reg-')));
    const created = [...after].filter((f) => !before.has(f));
    // Exactly one new dir kept, for the failed call.
    expect(created.length).toBe(1);
    // Best-effort cleanup so the test itself doesn't leak.
    for (const c of created) {
      try {
        fs.rmSync(path.join(tmpRoot, c), { recursive: true, force: true });
      } catch {
        /* leave it; harmless */
      }
    }
  });
});

describe('ensureCommCareApkCached: integrity-checked cache', () => {
  // The cache lives at <os.tmpdir()>/ace-mobile-apk-cache/. We use a
  // unique APK version per assertion to avoid colliding with the real
  // cache or with other tests.
  const cacheDir = path.join(os.tmpdir(), 'ace-mobile-apk-cache');
  beforeEach(() => {
    fs.mkdirSync(cacheDir, { recursive: true });
  });

  // Helper: a 2MB byte array starting with ZIP magic.
  function fakeApkBuffer(version: string): Uint8Array {
    const buf = new Uint8Array(2_000_000);
    buf[0] = 0x50;
    buf[1] = 0x4b;
    buf[2] = 0x03;
    buf[3] = 0x04;
    // Mix the version into the body so different versions have
    // different SHAs (otherwise multiple tests would write byte-identical
    // payloads and the test wouldn't distinguish them).
    for (let i = 0; i < version.length && i < 64; i++) buf[100 + i] = version.charCodeAt(i);
    return buf;
  }

  it('downloads + writes both .apk and .sha256 sidecar on cache miss', async () => {
    const version = `test-sha-write-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const apkPath = path.join(cacheDir, `commcare-${version}.apk`);
    const shaPath = `${apkPath}.sha256`;
    const bytes = fakeApkBuffer(version);
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });
    const avd = { listPackages: listPackagesInstallSucceeds(), installApk: vi.fn() } as any;
    const maestro = {} as any;
    const client = new MobileClient({
      avd,
      maestro,
      fetchImpl,
      bootstrapConfig: {
        apkVersion: version,
        testUser: {
          phone: TEST_PHONE,
          phoneLocal: TEST_PHONE_LOCAL,
          countryCode: '7',
          pin: '1234',
          backupCode: 'b',
          name: 'n',
        },
      },
    });
    // runLocalBootstrap → ensureCommCareApkCached path
    await expect(
      client.runLocalBootstrap({ name: 'AVD', serial: 'emulator-5554', status: 'booted' } as any),
    ).rejects.toThrow(); // registerTestUser will fail on the no-op maestro mock — fine.

    expect(fs.existsSync(apkPath)).toBe(true);
    expect(fs.existsSync(shaPath)).toBe(true);
    const sidecarSha = fs.readFileSync(shaPath, 'utf8').trim();
    const actualSha = crypto.createHash('sha256').update(fs.readFileSync(apkPath)).digest('hex');
    expect(sidecarSha).toBe(actualSha);

    // Cleanup so we don't pollute the cache across CI runs.
    try {
      fs.unlinkSync(apkPath);
      fs.unlinkSync(shaPath);
    } catch {
      /* leave */
    }
  });

  it('rejects a download that lacks ZIP magic (truncated or HTML error page)', async () => {
    const version = `test-bad-magic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const apkPath = path.join(cacheDir, `commcare-${version}.apk`);
    try {
      fs.unlinkSync(apkPath);
    } catch {
      /* fine */
    }
    // 2MB of zeros — passes size sanity check but has no ZIP magic.
    const bytes = new Uint8Array(2_000_000);
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => bytes.buffer,
    });
    const avd = { listPackages: listPackagesInstallSucceeds() } as any;
    const maestro = {} as any;
    const client = new MobileClient({
      avd,
      maestro,
      fetchImpl,
      bootstrapConfig: {
        apkVersion: version,
        testUser: {
          phone: TEST_PHONE,
          phoneLocal: TEST_PHONE_LOCAL,
          countryCode: '7',
          pin: '1234',
          backupCode: 'b',
          name: 'n',
        },
      },
    });
    await expect(
      client.runLocalBootstrap({ name: 'AVD', serial: 'emulator-5554', status: 'booted' } as any),
    ).rejects.toThrow(/not a valid APK \(missing ZIP magic bytes\)/);
    // Must NOT have written the bad bytes — magic-check happens before write.
    expect(fs.existsSync(apkPath)).toBe(false);
  });

  it('rejects a truncated download (under the 1MB size floor)', async () => {
    const version = `test-too-small-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const bytes = new Uint8Array(500_000); // < 1MB
    bytes[0] = 0x50;
    bytes[1] = 0x4b;
    bytes[2] = 0x03;
    bytes[3] = 0x04;
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => bytes.buffer,
    });
    const avd = { listPackages: listPackagesInstallSucceeds() } as any;
    const maestro = {} as any;
    const client = new MobileClient({
      avd,
      maestro,
      fetchImpl,
      bootstrapConfig: {
        apkVersion: version,
        testUser: {
          phone: TEST_PHONE,
          phoneLocal: TEST_PHONE_LOCAL,
          countryCode: '7',
          pin: '1234',
          backupCode: 'b',
          name: 'n',
        },
      },
    });
    await expect(
      client.runLocalBootstrap({ name: 'AVD', serial: 'emulator-5554', status: 'booted' } as any),
    ).rejects.toThrow(/too small.*likely truncated/);
  });

  it('treats cache SHA mismatch as a miss and re-downloads (catches in-place corruption)', async () => {
    const version = `test-sha-mismatch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const apkPath = path.join(cacheDir, `commcare-${version}.apk`);
    const shaPath = `${apkPath}.sha256`;
    // Seed cache with bytes A but a sidecar SHA for non-A → on next
    // call the SHAs won't match → must re-download from fetchImpl.
    const seededBytes = fakeApkBuffer(version);
    fs.writeFileSync(apkPath, Buffer.from(seededBytes));
    fs.writeFileSync(shaPath, 'a'.repeat(64)); // bogus stored SHA
    // Fresh download bytes (different content via a different version
    // suffix in the body) so we can prove fetchImpl was invoked.
    const freshBytes = fakeApkBuffer(`${version}-FRESH`);
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () =>
        freshBytes.buffer.slice(freshBytes.byteOffset, freshBytes.byteOffset + freshBytes.byteLength),
    });
    const avd = { listPackages: listPackagesInstallSucceeds() } as any;
    const maestro = {} as any;
    const client = new MobileClient({
      avd,
      maestro,
      fetchImpl,
      bootstrapConfig: {
        apkVersion: version,
        testUser: {
          phone: TEST_PHONE,
          phoneLocal: TEST_PHONE_LOCAL,
          countryCode: '7',
          pin: '1234',
          backupCode: 'b',
          name: 'n',
        },
      },
    });
    await expect(
      client.runLocalBootstrap({ name: 'AVD', serial: 'emulator-5554', status: 'booted' } as any),
    ).rejects.toThrow();
    // Fetch DID fire (cache mismatch → re-download).
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // Sidecar now matches the fresh bytes on disk.
    const onDisk = fs.readFileSync(apkPath);
    const sidecarSha = fs.readFileSync(shaPath, 'utf8').trim();
    const actualSha = crypto.createHash('sha256').update(onDisk).digest('hex');
    expect(sidecarSha).toBe(actualSha);
    // Cleanup.
    try {
      fs.unlinkSync(apkPath);
      fs.unlinkSync(shaPath);
    } catch {
      /* leave */
    }
  });

  it('adopts a sidecar-less legacy cache entry (writes the sidecar on the fly without re-downloading)', async () => {
    const version = `test-legacy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const apkPath = path.join(cacheDir, `commcare-${version}.apk`);
    const shaPath = `${apkPath}.sha256`;
    // Seed APK with no sidecar — simulates a cache populated by a
    // pre-sidecar version of this method.
    const legacyBytes = fakeApkBuffer(version);
    fs.writeFileSync(apkPath, Buffer.from(legacyBytes));
    try {
      fs.unlinkSync(shaPath);
    } catch {
      /* fine */
    }
    const fetchImpl = vi.fn(); // must NOT be called — adopt path
    const avd = { listPackages: listPackagesInstallSucceeds() } as any;
    const maestro = {} as any;
    const client = new MobileClient({
      avd,
      maestro,
      fetchImpl,
      bootstrapConfig: {
        apkVersion: version,
        testUser: {
          phone: TEST_PHONE,
          phoneLocal: TEST_PHONE_LOCAL,
          countryCode: '7',
          pin: '1234',
          backupCode: 'b',
          name: 'n',
        },
      },
    });
    await expect(
      client.runLocalBootstrap({ name: 'AVD', serial: 'emulator-5554', status: 'booted' } as any),
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
    // Sidecar should have been written on adoption.
    expect(fs.existsSync(shaPath)).toBe(true);
    const sidecarSha = fs.readFileSync(shaPath, 'utf8').trim();
    const actualSha = crypto.createHash('sha256').update(fs.readFileSync(apkPath)).digest('hex');
    expect(sidecarSha).toBe(actualSha);
    // Cleanup.
    try {
      fs.unlinkSync(apkPath);
      fs.unlinkSync(shaPath);
    } catch {
      /* leave */
    }
  });

  // ── URL-template fallback ──────────────────────────────────────
  //
  // Dimagi has renamed the release asset three times: 2.62.0
  // (`app-commcare-release.apk`), 2.63.0/2.63.1 (`commcare-<v>-release.apk`),
  // and 2.63.2+ (`commcare-<v>.apk`). The downloader probes
  // newest-convention-first and falls back, so every pin keeps working.
  // NAMING NOTE (2026-09-06, ace#1997): "newest" here means FIRST-PROBED, not
  // newest-convention. `client.ts` probes `app-commcare-release.apk` first
  // because that is what `commcare_2.64.0` actually ships — Dimagi reverted to
  // the OLDEST asset name. The convention does not progress with the version
  // and is not derivable from it; it is read off the release each time.
  it('downloads from the first-probed filename (app-commcare-release.apk) on first attempt', async () => {
    const version = `test-new-name-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const apkPath = path.join(cacheDir, `commcare-${version}.apk`);
    const shaPath = `${apkPath}.sha256`;
    try { fs.unlinkSync(apkPath); } catch { /* fine */ }
    try { fs.unlinkSync(shaPath); } catch { /* fine */ }
    const bytes = fakeApkBuffer(version);
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/app-commcare-release.apk')) {
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        };
      }
      return { ok: false, status: 404, statusText: 'Not Found', arrayBuffer: async () => new ArrayBuffer(0) };
    });
    const avd = { listPackages: listPackagesInstallSucceeds(), installApk: vi.fn() } as any;
    const maestro = {} as any;
    const client = new MobileClient({
      avd,
      maestro,
      fetchImpl,
      bootstrapConfig: {
        apkVersion: version,
        testUser: {
          phone: TEST_PHONE,
          phoneLocal: TEST_PHONE_LOCAL,
          countryCode: '7',
          pin: '1234',
          backupCode: 'b',
          name: 'n',
        },
      },
    });
    await expect(
      client.runLocalBootstrap({ name: 'AVD', serial: 'emulator-5554', status: 'booted' } as any),
    ).rejects.toThrow();
    // One fetch — the first-probed filename succeeded, no fallback needed.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringMatching(/\/app-commcare-release\.apk$/));
    expect(fs.existsSync(apkPath)).toBe(true);
    try { fs.unlinkSync(apkPath); fs.unlinkSync(shaPath); } catch { /* leave */ }
  });

  it('falls back through the remaining conventions when the first-probed filename 404s', async () => {
    const version = `test-fallback-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const apkPath = path.join(cacheDir, `commcare-${version}.apk`);
    const shaPath = `${apkPath}.sha256`;
    try { fs.unlinkSync(apkPath); } catch { /* fine */ }
    try { fs.unlinkSync(shaPath); } catch { /* fine */ }
    const bytes = fakeApkBuffer(version);
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith(`/commcare-${version}-release.apk`)) {
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        };
      }
      return { ok: false, status: 404, statusText: 'Not Found', arrayBuffer: async () => new ArrayBuffer(0) };
    });
    const avd = { listPackages: listPackagesInstallSucceeds(), installApk: vi.fn() } as any;
    const maestro = {} as any;
    const client = new MobileClient({
      avd,
      maestro,
      fetchImpl,
      bootstrapConfig: {
        apkVersion: version,
        testUser: {
          phone: TEST_PHONE,
          phoneLocal: TEST_PHONE_LOCAL,
          countryCode: '7',
          pin: '1234',
          backupCode: 'b',
          name: 'n',
        },
      },
    });
    await expect(
      client.runLocalBootstrap({ name: 'AVD', serial: 'emulator-5554', status: 'booted' } as any),
    ).rejects.toThrow();
    // Three fetches, in the order client.ts probes them: the 2.62.0/2.64.0
    // name first, then `commcare-<v>.apk` (2.63.2), then the `-release` form
    // (2.63.0/1) which answers here. Pinning the ORDER is the point — it is
    // what stops someone "restoring" a newest-convention-first list on the
    // assumption that asset naming marches forward. It does not: 2.64.0
    // reverted to app-commcare-release.apk (ace#1997).
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl).toHaveBeenNthCalledWith(1, expect.stringMatching(/\/app-commcare-release\.apk$/));
    expect(fetchImpl).toHaveBeenNthCalledWith(2, expect.stringMatching(new RegExp(`/commcare-${version}\\.apk$`)));
    expect(fetchImpl).toHaveBeenNthCalledWith(3, expect.stringMatching(new RegExp(`/commcare-${version}-release\\.apk$`)));
    expect(fs.existsSync(apkPath)).toBe(true);
    try { fs.unlinkSync(apkPath); fs.unlinkSync(shaPath); } catch { /* leave */ }
  });

  it('throws when all three filename conventions 404', async () => {
    const version = `test-both-404-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const apkPath = path.join(cacheDir, `commcare-${version}.apk`);
    try { fs.unlinkSync(apkPath); } catch { /* fine */ }
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    const avd = { listPackages: listPackagesInstallSucceeds() } as any;
    const maestro = {} as any;
    const client = new MobileClient({
      avd,
      maestro,
      fetchImpl,
      bootstrapConfig: {
        apkVersion: version,
        testUser: {
          phone: TEST_PHONE,
          phoneLocal: TEST_PHONE_LOCAL,
          countryCode: '7',
          pin: '1234',
          backupCode: 'b',
          name: 'n',
        },
      },
    });
    await expect(
      client.runLocalBootstrap({ name: 'AVD', serial: 'emulator-5554', status: 'booted' } as any),
    ).rejects.toThrow(/APK download failed/);
    // All three URL conventions were tried before erroring.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

describe('getConfiguredApkVersion: env-var with default', () => {
  // Selector maps live at mcp/mobile/selectors/connect-<v>.yaml; the
  // resolver looks up files by this version. Sourced from
  // ACE_CONNECT_APK_VERSION so an opt-in env override can route a session
  // to a newer selector baseline (e.g. 2.63.0) without changing defaults.
  const prev = process.env.ACE_CONNECT_APK_VERSION;
  afterEach(() => {
    if (prev === undefined) delete process.env.ACE_CONNECT_APK_VERSION;
    else process.env.ACE_CONNECT_APK_VERSION = prev;
  });

  // Asserted against DEFAULT_APK_VERSION rather than a literal: this pair
  // hardcoded '2.63.2' and went red on the 2.64.0 bump while testing nothing
  // the bump got wrong. `test/apk-pin-currency.test.ts` is what pins the
  // constant's VALUE against .env.tpl and the newest map; this only has to
  // pin that the getter falls back to it (ace#1997).
  it('returns DEFAULT_APK_VERSION when env var is unset', () => {
    delete process.env.ACE_CONNECT_APK_VERSION;
    expect(getConfiguredApkVersion()).toBe(DEFAULT_APK_VERSION);
  });

  it('returns the env-var value when set', () => {
    process.env.ACE_CONNECT_APK_VERSION = '2.62.0';
    expect(getConfiguredApkVersion()).toBe('2.62.0');
  });

  it('falls back to DEFAULT_APK_VERSION when env var is empty string', () => {
    process.env.ACE_CONNECT_APK_VERSION = '';
    expect(getConfiguredApkVersion()).toBe(DEFAULT_APK_VERSION);
  });
});

describe('runLocalBootstrap: no snapshot save (cold-boot model)', () => {
  const readyAvd = { name: 'AVD', serial: 'emulator-5554', status: 'booted' } as const;

  it('does NOT call saveSnapshot — every dispatch cold-boots so no snapshot would ever be loaded', async () => {
    const version = `test-no-snapshot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const bytes = new Uint8Array(2_000_000);
    bytes[0] = 0x50;
    bytes[1] = 0x4b;
    bytes[2] = 0x03;
    bytes[3] = 0x04;
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => bytes.buffer,
    });
    const avd = {
      ensureAvdRunning: vi.fn().mockResolvedValue(readyAvd),
      requireRunningAvd: vi.fn().mockResolvedValue(readyAvd),
      // ace#1357 fix 3: registerTestUser now proves the device answers.
      probeDeviceReachable: vi.fn().mockResolvedValue({ reachable: true }),
      findRunningAvd: vi.fn().mockResolvedValue(readyAvd),
      listPackages: listPackagesInstallSucceeds(),
      getFocusedActivity: vi.fn(),
      captureUiDump: vi.fn().mockResolvedValue({ xml: '', elements: [] }),
      readCrashLogcat: vi.fn().mockResolvedValue(''),
      loadSnapshot: vi.fn(),
      installApk: vi.fn().mockResolvedValue({
        packageId: 'org.commcare.dalvik',
        versionName: version,
        versionCode: 1,
        path: '/tmp/apk',
      }),
      // saveSnapshot is still mocked so a regression that reintroduces
      // the call would surface here.
      saveSnapshot: vi.fn().mockResolvedValue({
        avdName: 'AVD',
        snapshotName: 'registered-test-user',
        saved: true,
        output: 'OK',
      }),
      setGmsEnabled: vi.fn().mockResolvedValue(undefined),
      disableHeadsUpNotifications: vi.fn().mockResolvedValue(undefined),
      applyEnvironmentBaseline: vi.fn().mockResolvedValue('abc123def456'),
      grantRuntimePermissions: vi.fn().mockResolvedValue(undefined),
    } as any;
    const maestro = {
      probeDriver: vi.fn().mockResolvedValue({ healthy: true }),
      driverPackagesInstalled: vi.fn().mockResolvedValue({ app: true, test: true, queryOk: true }),
      repairDriver: vi.fn(),
      runRecipe: vi.fn().mockResolvedValue({
        status: 'pass',
        exitCode: 0,
        stdout: 'PHONE_ALREADY_REGISTERED',
        stderr: '',
        screenshotsDir: '/tmp/',
        screenshots: [],
      }),
    } as any;
    const client = new MobileClient({
      avd,
      maestro,
      fetchImpl,
      bootstrapConfig: {
        apkVersion: version,
        testUser: {
          phone: TEST_PHONE,
          phoneLocal: TEST_PHONE_LOCAL,
          countryCode: '7',
          pin: '1234',
          backupCode: 'b',
          name: 'n',
        },
      },
    });
    const steps = await client.runLocalBootstrap({
      name: 'AVD',
      serial: 'emulator-5554',
      status: 'booted',
    } as any);
    // No snapshot-saved step. The heal flow never persists a snapshot.
    expect(steps).not.toContain('snapshot-saved');
    expect(avd.saveSnapshot).not.toHaveBeenCalled();
    // It still ran the actual bootstrap steps.
    expect(steps).toContain('apk-installed');
    expect(steps).toContain('environment-baseline-applied');
  });
});
