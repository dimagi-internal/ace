// mcp/mobile/client.ts
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { AvdBackend } from './backends/avd.js';
import {
  CloudBackend,
  type CloudDiagnostics,
  type CloudPatchLaunchScriptResult,
} from './backends/cloud.js';
import { MaestroBackend } from './backends/maestro.js';
import { DeviceUserStateError, MaestroDriverError, MobileError } from './errors.js';
import { RecipeGenerator, type LlmFn } from './backends/recipe-generator.js';
import { prepareRecipeForMaestro, injectAceEnvVars } from './recipe-resolver.js';
import { resolveBackend } from './backend-toggle.js';
import type {
  AvdInfo, ApkInfo, RecipeRunResult, TestUserRegistrationResult, UiDumpResult,
  SnapshotResult, DeviceUserStateClass, DeviceStateHealLog, LocalBootstrapConfig,
} from './types.js';
import { logInfo } from './logging.js';

export interface MobileClientOpts {
  avd?: AvdBackend;
  maestro?: MaestroBackend;
  cloud?: CloudBackend;
  staticRecipesDir?: string;
  /**
   * Optional override for the tier-2 (auto-bootstrap) recovery in
   * `restoreDeviceUserState`. When provided, used as-is. When omitted
   * (the production default), the constructor calls
   * `bootstrapConfigFromEnv()` to assemble it from `ACE_E2E_*` +
   * `ACE_CONNECT_APK_VERSION`. Pass `null` explicitly to disable the
   * tier-2 path (tests that want the legacy snapshot-load-fails-and-
   * throws behavior).
   */
  bootstrapConfig?: LocalBootstrapConfig | null;
  /**
   * Optional override for the APK fetch (testing only). Default is
   * native `fetch`. Tests inject a mock to avoid network round-trips.
   */
  fetchImpl?: typeof fetch;
}

/**
 * The seven env vars `runLocalBootstrap` needs. Centralized so a typo'd
 * var name in `bootstrapConfigFromEnv` and the operator-facing error
 * message can't drift apart.
 */
const BOOTSTRAP_ENV_VARS = [
  'ACE_CONNECT_APK_VERSION',
  'ACE_E2E_PHONE',
  'ACE_E2E_PHONE_LOCAL',
  'ACE_E2E_COUNTRY_CODE',
  'ACE_E2E_PIN',
  'ACE_E2E_BACKUP_CODE',
  'ACE_E2E_NAME',
] as const;

/**
 * Return the names of any `BOOTSTRAP_ENV_VARS` that are missing or empty.
 * Empty array means all are populated.
 *
 * Surfaced in `DeviceUserStateError` attempts so an operator who's
 * missing one variable sees its specific name rather than a blanket
 * "bootstrapConfig:absent" — the previous error required a `.env` diff
 * against `.env.tpl` to identify the culprit.
 */
export function missingBootstrapEnvVars(): string[] {
  return BOOTSTRAP_ENV_VARS.filter((name) => !process.env[name]);
}

/**
 * Read the test-user credentials + APK version pin from env. Returns
 * `null` if any required var is missing — `restoreDeviceUserState` will
 * then halt with `snapshot-load-failed` on snapshot-missing instead of
 * attempting the tier-2 bootstrap.
 *
 * Pair with `missingBootstrapEnvVars()` to identify exactly which vars
 * are missing for the operator-facing error.
 */
export function bootstrapConfigFromEnv(): LocalBootstrapConfig | null {
  if (missingBootstrapEnvVars().length > 0) return null;
  return {
    apkVersion: process.env.ACE_CONNECT_APK_VERSION!,
    testUser: {
      phone: process.env.ACE_E2E_PHONE!,
      phoneLocal: process.env.ACE_E2E_PHONE_LOCAL!,
      countryCode: process.env.ACE_E2E_COUNTRY_CODE!,
      pin: process.env.ACE_E2E_PIN!,
      backupCode: process.env.ACE_E2E_BACKUP_CODE!,
      name: process.env.ACE_E2E_NAME!,
    },
  };
}

const DEFAULT_STATIC_DIR = new URL('./recipes/static/', import.meta.url).pathname;

export interface DriveAdapter {
  readFile(driveId: string, filePath: string): Promise<string>;
  writeFile(driveId: string, filePath: string, content: string): Promise<void>;
  listFolder(driveId: string, folderPath: string): Promise<string[]>;
}

/**
 * Classify the AVD's user-facing state from three signals. Pure function;
 * see `MobileClient.probeDeviceUserState` for the signal-collection path.
 *
 * **The `ready` definition is broad on purpose.** Phase 6's prerequisite
 * recipes (`connect-login.yaml` + `connect-claim-opp.yaml`) navigate
 * from "Connect-registered, no opp claimed yet" forward to the opp
 * tile — they don't require the device to start on the
 * OpportunitiesActivity. So any state where (a) CommCare is installed
 * AND (b) PersonalID is healthy counts as `ready`. The classifier
 * looks for positive PersonalID-healthy signals — Connect nav-drawer
 * items, opp/visit activities — and treats their presence as ready
 * even when the CommCare app slot is still on the first-start setup
 * screen (the legitimate post-register, pre-claim state that
 * `registerTestUser` leaves the device in).
 *
 * Order matters — first-match wins.
 */
export function classifyDeviceUserState(
  focusedActivity: string,
  uiDumpXml: string,
  installedPackages: string[],
): DeviceUserStateClass {
  if (!installedPackages.some((p) => p === 'org.commcare.dalvik')) {
    return 'commcare-not-installed';
  }
  // PersonalID-wipe banner is the unambiguous wipe signal (Connect
  // server-side de-registration). Highest priority — fires even when a
  // post-register drawer would otherwise look healthy.
  //
  // Scoped to `text="..."` and `content-desc="..."` attribute values so
  // a deeply nested tooltip, accessibility hint, or status string that
  // happens to contain "Reconfigure" anywhere in the dump can't
  // false-positive. The bare word "Reconfigure" is especially generic
  // — without scoping, a future CommCare update that surfaces it in any
  // unrelated dialog would silently halt every Phase 6 dispatch with
  // DeviceUserStateError before tier-2 ever fires.
  if (
    /(?:text|content-desc)="[^"]*(?:Logged out of PersonalID|Lost PersonalID configuration|Reconfigure)[^"]*"/i.test(
      uiDumpXml,
    )
  ) {
    return 'needs-personal-id';
  }
  // Positive PersonalID-healthy signals: Connect nav-drawer items only
  // appear post-registration ("Work History" / "Opportunities" /
  // "Messaging" / "CommCare Apps"), or an opp/visit activity is
  // foregrounded (the post-claim path). Either is `ready`.
  if (/\bWork History\b|\bOpportunities\b|\bMessaging\b|\bCommCare Apps\b/i.test(uiDumpXml)) {
    return 'ready';
  }
  if (/OpportunitiesActivity|VendorVisitActivity|DispatchActivity|HomeActivity/i.test(focusedActivity)) {
    return 'ready';
  }
  // No positive registered signal + first-start markers = unregistered.
  // Same recovery as wiped (run registerTestUser via tier-2 bootstrap).
  if (/CommCareSetupActivity/i.test(focusedActivity)) {
    return 'needs-personal-id';
  }
  if (/Enter Code|Scan Application Barcode|Welcome to CommCare/i.test(uiDumpXml)) {
    return 'needs-personal-id';
  }
  return 'unknown';
}

/**
 * APKs are signed JAR files; signed JARs are ZIP files. Every valid APK
 * therefore starts with the local-file-header magic `PK\x03\x04` (50 4b
 * 03 04). Truncated downloads, GitHub HTML error pages, and corrupted
 * cache entries all fail this check at zero cost.
 */
function isApkZipMagic(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
}

/**
 * Tar + gzip every file in `dir` (non-recursive into hidden dirs that
 * Maestro doesn't reference — we tar the visible contents only) and
 * return a base64 string. Used to ship the resolved palette to the
 * cloud backend so the server's Maestro sees the same sibling layout
 * the local backend's Maestro sees. The `cd` form means the tarball
 * contains *relative* paths, so server-side `tar xzf - -C run_dir`
 * lays them out as direct children of `run_dir`.
 *
 * `COPYFILE_DISABLE=1` suppresses macOS AppleDouble (`._foo.yaml`)
 * sidecar files that bsdtar otherwise embeds for filesystem extended
 * attributes. Without this, the cloud-side `tar xzf` on Linux emits a
 * `Ignoring unknown extended header keyword 'LIBARCHIVE.xattr...'`
 * warning per file and lands stray `._*.yaml` files in `run_dir` —
 * harmless to Maestro but they pollute the S3 artifact list. Verified
 * live in smoke test 2026-05-16 (palette-smoke-001).
 */
function tarDirAsBase64(dir: string): string {
  const result = spawnSync('tar', ['-czf', '-', '-C', dir, '.'], {
    encoding: 'buffer',
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  if (result.status !== 0) {
    const err = result.stderr instanceof Buffer
      ? result.stderr.toString()
      : String(result.stderr ?? 'unknown');
    throw new Error(`tarDirAsBase64: tar exited ${result.status} (${err.trim()})`);
  }
  if (!(result.stdout instanceof Buffer)) {
    throw new Error('tarDirAsBase64: tar produced no stdout buffer');
  }
  return result.stdout.toString('base64');
}

/**
 * Pick a short human-readable signal string from the probe data — used
 * in the heal log so the subagent's return surfaces "what was on screen"
 * without dumping the full XML. First non-empty match wins.
 */
function pickStateSignal(focusedActivity: string, uiDumpXml: string): string | undefined {
  const markers: Array<[RegExp, string]> = [
    [/Logged out of PersonalID/i, 'drawer:logged-out-personal-id'],
    [/Lost PersonalID configuration/i, 'drawer:lost-personal-id-config'],
    [/\bReconfigure\b/i, 'drawer:reconfigure-cta'],
    [/CommCareSetupActivity/, 'activity:CommCareSetupActivity'],
    [/Enter Code/i, 'screen:enter-code'],
    [/Scan Application Barcode/i, 'screen:scan-barcode'],
    [/Welcome to CommCare/i, 'screen:welcome-to-commcare'],
    [/OpportunitiesActivity/, 'activity:OpportunitiesActivity'],
    [/VendorVisitActivity/, 'activity:VendorVisitActivity'],
  ];
  for (const [re, label] of markers) {
    if (re.test(focusedActivity) || re.test(uiDumpXml)) return label;
  }
  return undefined;
}

export class MobileClient {
  readonly avd: AvdBackend;
  readonly maestro: MaestroBackend;
  readonly staticRecipesDir: string;
  /**
   * Cloud backend handle. Always pre-constructed when ACE_WEB env is
   * available so a mid-session toggle to cloud routes immediately. Null
   * only when the runtime can't build a CloudBackend (missing
   * ACE_WEB_BASE_URL / ACE_WEB_PAT_TOKEN), in which case routing to
   * cloud throws a clear typed error.
   */
  readonly cloud: CloudBackend | null;
  /**
   * Tier-2 (auto-bootstrap) config for `restoreDeviceUserState`. Null
   * disables the fallback. See `bootstrapConfigFromEnv` for env-derived
   * defaults.
   */
  readonly bootstrapConfig: LocalBootstrapConfig | null;
  private readonly fetchImpl: typeof fetch;
  /**
   * Fingerprint of the AVD environment baseline applied during the most
   * recent `runLocalBootstrap`. Surfaced via the heal log so telemetry
   * can detect when an AVD is running an older baseline version.
   * Undefined when no bootstrap has run on this client, or when the
   * baseline application failed silently.
   */
  private lastBaselineFingerprint: string | undefined;

  constructor(opts: MobileClientOpts = {}) {
    this.avd = opts.avd ?? new AvdBackend();
    this.maestro = opts.maestro ?? new MaestroBackend();
    this.staticRecipesDir = opts.staticRecipesDir ?? DEFAULT_STATIC_DIR;
    // `bootstrapConfig: null` (explicit) disables auto-bootstrap;
    // `undefined` (omitted) reads from env; non-null override wins.
    this.bootstrapConfig =
      opts.bootstrapConfig === undefined ? bootstrapConfigFromEnv() : opts.bootstrapConfig;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    // Eagerly try to construct CloudBackend so /ace:mobile-backend can
    // flip the toggle mid-session without an MCP restart. We catch the
    // typed env-missing error so envs without ACE_WEB still start up.
    if (opts.cloud !== undefined) {
      this.cloud = opts.cloud;
    } else {
      try {
        this.cloud = new CloudBackend();
      } catch (e) {
        if (e instanceof MobileError && e.code === 'CLOUD_NOT_CONFIGURED') {
          this.cloud = null;
        } else {
          throw e;
        }
      }
    }
  }

  /**
   * Resolve the active backend on every routing decision so a slash-
   * command toggle takes effect mid-session.
   */
  get useCloud(): boolean {
    return resolveBackend().backend === 'cloud';
  }

  /**
   * Route to cloud if it's both selected and configured. If the toggle
   * says cloud but CloudBackend wasn't constructible, throw a typed
   * error pointing at the missing env so the caller sees a clear signal
   * instead of silently falling back to local.
   */
  private requireCloud(): CloudBackend {
    if (!this.cloud) {
      throw new MobileError(
        'CLOUD_NOT_CONFIGURED',
        'cloud backend selected but not configured',
        'Set ACE_WEB_BASE_URL and ACE_WEB_PAT_TOKEN in .env, or switch backend with /ace:mobile-backend local.',
      );
    }
    return this.cloud;
  }

  // ---- Atom-level methods (one per capability) ----

  /**
   * Boot the AVD if cold AND assert the on-device Maestro driver is
   * responsive on its gRPC channel. Two-stage: first
   * `AvdBackend.ensureAvdRunning` boots the emulator and runs
   * `runPostBootPrep`; then `assertMaestroDriverHealthy` proves Maestro
   * can actually drive it.
   *
   * Why the driver probe lives here. Pre-0.13.165, `mobile_ensure_avd_running`
   * returned PASS as soon as the emulator booted and `adb` reported the
   * device as `device`. Phase 6 `app-screenshot-capture` would then call
   * `mobile_run_recipe`, the first `deviceInfo` gRPC call would hit
   * `UNAVAILABLE` (driver app installed but its gRPC server dead — or
   * driver not installed and the runtime install racing), and the skill
   * would degrade to `verdict: incomplete` for a state that's actually
   * recoverable. By doing the probe + repair here we make
   * `ensure_avd_running` the single source of truth for "AVD is ready
   * for Maestro": `mobile-bootstrap`, Phase 6's pre-flight, and
   * `app-screenshot-capture` Step 3 all call this same path. DRY.
   *
   * Cloud backend skips the local driver check — its workers manage
   * Maestro state on their side, and the gRPC channel they expose
   * through ace-web has its own health semantics.
   */
  async ensureAvdRunning(name: string): Promise<AvdInfo> {
    if (this.useCloud) {
      const info = await this.requireCloud().ensureAvdRunning(name);
      // Symmetric shape with the local branch: callers that read
      // `info.heal.deviceUserState` from `mobile_ensure_avd_running`
      // get a populated stub on cloud instead of undefined. Cloud's
      // cold-boot path IS the equivalent restore mechanism (the AMI
      // ships the registration recipes built-in and runs them on
      // every cold boot) so there's nothing for the auto-heal to
      // attempt locally — `attempted: false` reflects that.
      return {
        ...info,
        heal: {
          deviceUserState: { classified_as: 'unknown', attempted: false },
        },
      };
    }
    const info = await this.avd.ensureAvdRunning(name);
    await this.assertMaestroDriverHealthy(info.serial);
    const deviceUserState = await this.restoreDeviceUserState(info);
    return { ...info, heal: { deviceUserState } };
  }

  /**
   * Restore the AVD's per-user state to a guaranteed-clean precondition
   * by running the deterministic bootstrap path on every dispatch:
   * install the CommCare APK (the cold-booted AVD has none — see
   * `AvdBackend.ensureAvdRunning`), then a fresh `registerTestUser` walk
   * (demo bypass — ~15-25s). Throws `DeviceUserStateError` on bootstrap
   * failure OR post-bootstrap verification failure.
   *
   * **Design pattern: preconditions are restored, not adapted.** Every
   * Phase 6 dispatch needs the AVD at the Connect home with a fresh,
   * authenticated demo user. Rather than probe-and-adapt to whatever
   * state we find (a class of complexity that landed an inverted-
   * conclusion bug in 2026-05-13 turmeric run 20260513-0616), we always
   * restore to that state via cold start — wipe + register. See
   * CLAUDE.md § Phase preconditions.
   *
   * **Always cold-boot, nothing preserved across dispatches.** The
   * upstream `AvdBackend.ensureAvdRunning` now ALWAYS kills any running
   * emulator and boots fresh with `-wipe-data`. The prior model that
   * preserved the running AVD process (and with it the APK install,
   * lockscreen state, GMS toggles, Maestro driver state, instrumentation
   * residue, etc.) was a snapshot-load tier-1 in disguise: cached running
   * state accumulated junk-state classes that had to be debugged one at
   * a time. Cold-boot makes those classes structurally impossible.
   *
   * **No snapshot tier-1.** Earlier versions tried a fast-path
   * `loadSnapshot('registered-test-user')` before falling back to
   * register. That cached-state shortcut has a recurring failure mode:
   * snapshots silently age (the wall-clock + cached Connect Token both
   * freeze at capture; the token then real-time-expires; the
   * post-restore opp-list call 401s with the misleading "Authentication
   * credentials were not provided"). The clock-sync in PR #281 was a
   * band-aid for one symptom of that class; the right fix is to drop
   * the snapshot from the heal path entirely. Demo users skip OTP — see
   * `docs/learnings/2026-05-14-demo-user-no-otp.md` for the rationale.
   *
   * **Cloud backend follows the same contract via a different mechanism.**
   * `backends/cloud.ts` documents that each `/api/mobile/ensure-running`
   * call cold-boots the AVD and runs registration recipes against it.
   * The contract — *"after `MobileClient.ensureAvdRunning` returns, the
   * device is at the Connect home, signed in as the test user"* — is
   * identical across backends; only the mechanism differs.
   *
   * **What's preserved across dispatches (free):**
   * - Host-side APK cache at `<tmp>/ace-mobile-apk-cache/` (a host
   *   filesystem artifact, not on-device state — survives the wipe).
   *
   * **What's torn down + rebuilt per dispatch (~60-90s):**
   * - AVD emulator process (cold-booted; `-wipe-data` scrubs userdata.img).
   * - CommCare APK install (re-installed from host cache).
   * - Maestro driver APK install (re-installed by `assertMaestroDriverHealthy`).
   * - All system settings, lockscreen state, GMS toggles, Connect tokens.
   * - Fresh demo-user registration → fresh tokens + clean local state.
   *
   * **`saveSnapshot` kept as a manual debugging atom.** Operator can
   * save a snapshot via the MCP atom to capture interesting state for
   * later inspection, but the heal flow never saves or loads snapshots.
   */
  async restoreDeviceUserState(avd: AvdInfo): Promise<DeviceStateHealLog> {
    if (this.useCloud) {
      // Two cloud modes, gated on ACE_MOBILE_CLOUD_LIVE_REGISTER:
      //   true  → live cloud-bootstrap (pm clear + registerTestUser),
      //           mirroring local's always-deterministic-bootstrap.
      //   else  → legacy stub. The AMI's cold-boot path is the
      //           equivalent restore mechanism for pre-Phase-D AMIs;
      //           see `backends/cloud.ts` header.
      if (process.env.ACE_MOBILE_CLOUD_LIVE_REGISTER === 'true') {
        return this.cloudBootstrapHeal(avd);
      }
      return { classified_as: 'unknown', attempted: false };
    }

    if (!this.bootstrapConfig) {
      const missing = missingBootstrapEnvVars();
      const detail =
        missing.length > 0
          ? `bootstrapConfig:absent (missing env: ${missing.join(', ')}; run /ace:setup --force-env then retry)`
          : `bootstrapConfig:absent (explicitly disabled by caller)`;
      throw new DeviceUserStateError('unknown', [detail]);
    }

    logInfo(
      `device_user_state: restoring to known state via deterministic bootstrap on ${avd.serial}`,
    );
    const bootstrapSteps = await this.runLocalBootstrap(avd);
    const verifyAfterBootstrap = await this.probeDeviceUserState(avd);
    if (
      verifyAfterBootstrap.classified_as === 'ready' ||
      verifyAfterBootstrap.classified_as === 'unknown'
    ) {
      logInfo(
        `device_user_state: restored to ${verifyAfterBootstrap.classified_as} via local-bootstrap on ${avd.serial}`,
      );
      return {
        classified_as: verifyAfterBootstrap.classified_as,
        attempted: true,
        healed_via: 'local-bootstrap',
        verified_as: verifyAfterBootstrap.classified_as,
        focused_activity: verifyAfterBootstrap.focused_activity,
        ui_dump_signal: verifyAfterBootstrap.ui_dump_signal,
        bootstrap_steps: bootstrapSteps,
        environment_baseline_applied: this.lastBaselineFingerprint !== undefined,
        environment_baseline_fingerprint: this.lastBaselineFingerprint,
      };
    }
    throw new DeviceUserStateError(verifyAfterBootstrap.classified_as, [
      `runLocalBootstrap:pass(${bootstrapSteps.join(',')})`,
      `verify:${verifyAfterBootstrap.classified_as}`,
      `signal:${verifyAfterBootstrap.ui_dump_signal ?? 'none'}`,
    ]);
  }


  /**
   * Read-only probe of the AVD's user-facing state. Three signals:
   *   1. `org.commcare.dalvik` installed?
   *   2. focused activity (resumed activity from `dumpsys`)
   *   3. UI hierarchy dump (uiautomator)
   * Classified into a `DeviceUserStateClass`. No mutation; safe to call
   * repeatedly. Today the only caller is `restoreDeviceUserState`'s
   * post-load verification step.
   */
  private async probeDeviceUserState(avd: AvdInfo): Promise<{
    classified_as: DeviceUserStateClass;
    focused_activity?: string;
    ui_dump_signal?: string;
  }> {
    const packages = await this.avd
      .listPackages(avd.name, 'org.commcare.dalvik')
      .catch(() => [] as string[]);
    const focused = await this.avd
      .getFocusedActivity(avd.name)
      .catch(() => '');
    const dump = await this.avd
      .captureUiDump(avd.name)
      .catch(() => ({ xml: '', elements: [] } as UiDumpResult));

    const cls = classifyDeviceUserState(focused, dump.xml, packages);
    const signal = pickStateSignal(focused, dump.xml);
    return { classified_as: cls, focused_activity: focused, ui_dump_signal: signal };
  }

  /**
   * Run the local-bootstrap-equivalent sequence inline against the
   * freshly cold-booted AVD. Mirrors steps 5 / 9 of `/ace:mobile-bootstrap`:
   *
   *   1. Ensure `org.commcare.dalvik` is installed (downloads the APK
   *      from the pinned GitHub release if missing, caches under
   *      `<tmp>/ace-mobile-apk-cache/`). After cold-boot the AVD has no
   *      APK installed (the `-wipe-data` flag scrubs userdata.img), so
   *      the install branch fires every dispatch.
   *   2. `registerTestUser` with the env-derived `ACE_E2E_*` creds
   *      (idempotent — returns alreadyRegistered if the device already
   *      has the user). Phase 4's `connect-opp-setup` Step 8 invites
   *      `${ACE_E2E_PHONE}` to the run's opp before Phase 6 runs, so
   *      the CONNECT-ID-3F server-side invite check is satisfied.
   *
   * Cookie seeding (`scripts/seed-connect-cookies.ts`) + the
   * server-side `${ACE_E2E_PHONE}` invite check are deliberately NOT
   * here — the former is host-filesystem prep that `/ace:setup` owns,
   * and the latter is handled by Phase 4 inside `/ace:run`.
   *
   * No snapshot save. The AVD is cold-booted on every dispatch, so a
   * post-bootstrap snapshot would never be loaded (the next dispatch's
   * `-wipe-data` scrubs userdata.img). `saveSnapshot` is preserved as
   * a manual debugging atom but not part of the heal path.
   *
   * Returns the list of bootstrap steps that actually fired (e.g.
   * `['apk-installed', 'registered', 'environment-baseline-applied']`);
   * skipped idempotent steps are omitted so the heal log shows what
   * changed.
   */
  async runLocalBootstrap(avd: AvdInfo): Promise<string[]> {
    if (!this.bootstrapConfig) {
      throw new MobileError(
        'NO_BOOTSTRAP_CONFIG',
        'runLocalBootstrap called without bootstrapConfig — env vars (ACE_E2E_* / ACE_CONNECT_APK_VERSION) are missing',
        'Run /ace:setup --force-env to re-inject .env from 1Password.',
      );
    }
    const { apkVersion, testUser } = this.bootstrapConfig;
    const steps: string[] = [];

    // Step 1: ensure CommCare APK installed.
    //
    // The AVD is cold-booted with `-wipe-data` upstream, so userdata.img
    // is scrubbed and the APK is never preserved across dispatches —
    // this install branch fires every time. The host-side cache at
    // `<tmp>/ace-mobile-apk-cache/commcare-<ver>.apk` survives the wipe
    // (it's a host filesystem artifact, not on-device state), so the
    // re-install is bounded to ~3-5s `adb install` rather than the
    // ~30s GitHub re-download on a cache miss.
    const packages = await this.avd.listPackages(avd.name, 'org.commcare.dalvik');
    if (!packages.includes('org.commcare.dalvik')) {
      logInfo(`local_bootstrap: CommCare ${apkVersion} not installed on ${avd.serial} — downloading + installing`);
      const apkPath = await this.ensureCommCareApkCached(apkVersion);
      await this.avd.installApk(avd.name, apkPath);
      steps.push('apk-installed');
    } else {
      steps.push('apk-present');
    }

    // Step 1.5: wipe Connect's per-app data — defensive belt-and-
    // suspenders. With the upstream cold-boot `-wipe-data`, the APK is
    // never present here on the production path, so this branch should
    // not fire. Retained for compatibility with tests/mocks that stub
    // listPackages returning an installed APK, and as a safety net if a
    // future change ever weakens the cold-boot guarantee. `pm clear` is
    // ~0.5s; does NOT touch the APK installation; does NOT require root.
    if (packages.includes('org.commcare.dalvik')) {
      const cleared = await this.avd
        .clearConnectAppData(avd.name)
        .catch(() => false);
      steps.push(cleared ? 'app-data-cleared' : 'app-data-clear-failed');
    }

    // Step 2: register the test user. Demo users (+7426 prefix) skip
    // OTP server-side — total walk-through cost is ~15-25s. See the
    // demo-user-no-OTP learning for the breakdown.
    logInfo(`local_bootstrap: registering test user ${testUser.phone} on ${avd.serial}`);
    const reg = await this.registerTestUser({
      avdName: avd.name,
      phone: testUser.phone,
      phoneLocal: testUser.phoneLocal,
      countryCode: testUser.countryCode,
      pin: testUser.pin,
      backupCode: testUser.backupCode,
      name: testUser.name,
    });
    steps.push(reg.alreadyRegistered ? 'register-already' : 'registered');

    // Step 2.5: apply the AVD environment baseline. Bundles:
    //   - heads-up notifications off (PR #328 / 0.13.252) — AOSP AVDs
    //     periodically fire a touch-receptive Messages-app banner that
    //     steals the next Maestro tap mid-recipe
    //   - GMS DND-disallow (PR #328 / 0.13.252)
    //   - screen_off_timeout 30 min — prevents the AVD locking the
    //     screen mid-recipe (Maestro tap-on-locked-screen surfaces as a
    //     generic selector miss, costs ~10 min of recipe-debug time per
    //     occurrence)
    // Class-level fix — every smoke run on this AVD will hit one of
    // these sooner or later. Best-effort; idempotent; re-applied every
    // dispatch (the cold-boot wipes userdata.img, taking these settings
    // with it). Captures a fingerprint so telemetry can detect when an
    // AVD is running an older baseline.
    this.lastBaselineFingerprint = await this.avd
      .applyEnvironmentBaseline(avd.name)
      .catch(() => undefined);
    steps.push('environment-baseline-applied');

    // No snapshot save. The next dispatch always cold-boots with
    // `-wipe-data`, so a saved snapshot would never be loaded.
    // `saveSnapshot` remains available as a manual debugging atom but
    // is not part of the heal path.
    return steps;
  }

  /**
   * Download the CommCare APK for the given version if not already
   * cached locally; returns the local path. Cache lives under
   * `<os.tmpdir()>/ace-mobile-apk-cache/commcare-<version>.apk` so it
   * survives across sessions but isn't checked in.
   *
   * Integrity model: each cached APK has a sidecar `<apk>.sha256` file
   * holding the SHA256 of the bytes that were written. Cache HITS
   * re-compute the SHA and compare; mismatch is treated as a cache
   * miss and triggers a re-download. Cache MISSES validate the ZIP
   * magic bytes before writing (truncated downloads silently produced
   * cache poisoning under the prior `size > 1_000_000` check —
   * everything after stayed broken until the operator manually wiped
   * `/tmp/ace-mobile-apk-cache/`). Sidecars without a paired APK and
   * vice-versa are repaired on the next call.
   */
  private async ensureCommCareApkCached(version: string): Promise<string> {
    const cacheDir = path.join(os.tmpdir(), 'ace-mobile-apk-cache');
    await fs.promises.mkdir(cacheDir, { recursive: true });
    const apkPath = path.join(cacheDir, `commcare-${version}.apk`);
    const shaPath = `${apkPath}.sha256`;

    // Cache check — must have non-trivial size, valid ZIP magic, AND
    // either match the stored sidecar SHA or have no sidecar (legacy
    // cache from pre-sidecar versions; populate the sidecar on the fly).
    try {
      const buf = await fs.promises.readFile(apkPath);
      if (buf.length > 1_000_000 && isApkZipMagic(buf)) {
        const actualSha = crypto.createHash('sha256').update(buf).digest('hex');
        const expectedSha = await fs.promises
          .readFile(shaPath, 'utf8')
          .then((s) => s.trim())
          .catch(() => null);
        if (expectedSha === null) {
          // Legacy cache — adopt the current bytes as authoritative.
          await fs.promises.writeFile(shaPath, actualSha).catch(() => {});
          return apkPath;
        }
        if (actualSha === expectedSha) return apkPath;
        logInfo(
          `local_bootstrap: cached APK sha mismatch for ${version} (expected ${expectedSha.slice(0, 12)}, got ${actualSha.slice(0, 12)}) — re-downloading`,
        );
      } else {
        logInfo(
          `local_bootstrap: cached APK at ${apkPath} is corrupt (size=${buf.length}, magic_ok=${isApkZipMagic(buf)}) — re-downloading`,
        );
      }
    } catch {
      // Not cached — fall through to download.
    }

    const url = `https://github.com/dimagi/commcare-android/releases/download/commcare_${version}/app-commcare-release.apk`;
    logInfo(`local_bootstrap: downloading CommCare ${version} from ${url}`);
    const res = await this.fetchImpl(url);
    if (!res.ok) {
      throw new MobileError(
        'APK_DOWNLOAD_FAILED',
        `CommCare APK download failed: HTTP ${res.status} ${res.statusText} from ${url}`,
        `Verify ACE_CONNECT_APK_VERSION pins a real release tag at https://github.com/dimagi/commcare-android/releases, or download manually to ${apkPath}.`,
      );
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1_000_000) {
      throw new MobileError(
        'APK_DOWNLOAD_FAILED',
        `Downloaded CommCare ${version} APK is too small (${buf.length} bytes) — likely truncated or a non-APK response from GitHub.`,
        `Verify network connectivity and that ACE_CONNECT_APK_VERSION pins a real release; if the issue persists, download manually to ${apkPath}.`,
      );
    }
    if (!isApkZipMagic(buf)) {
      throw new MobileError(
        'APK_DOWNLOAD_FAILED',
        `Downloaded CommCare ${version} payload is not a valid APK (missing ZIP magic bytes) — got ${buf.slice(0, 16).toString('hex')}.`,
        `GitHub may have returned an HTML error page instead of the APK. Verify the release exists at https://github.com/dimagi/commcare-android/releases/tag/commcare_${version}.`,
      );
    }
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    // Write APK first, then sidecar — order matters for the cache-hit
    // path: if a future call sees the APK but no sidecar, it adopts
    // the bytes as authoritative (legacy path). Reversed order could
    // leave a sidecar pointing at a missing APK.
    await fs.promises.writeFile(apkPath, buf);
    await fs.promises.writeFile(shaPath, sha);
    return apkPath;
  }

  /**
   * Probe + (if needed) repair + re-probe the Maestro driver on a booted
   * AVD. Throws `MaestroDriverError` on exhaustion.
   *
   * Read-only probing is exposed separately as `probeMaestroDriver` for
   * callers (doctor) that want a fast diagnostic without mutating state.
   */
  async assertMaestroDriverHealthy(serial: string): Promise<void> {
    const adbPort = AvdBackend.adbPortFromSerial(serial);
    if (adbPort === null) {
      // Non-emulator serial (real device, unusual local setup) — skip the
      // probe rather than fail. The probe assumes the standard emulator
      // port layout; real-device sessions are out of scope.
      return;
    }
    const attempts: string[] = [];
    // Stage 1: cheap probe. 20s budget covers the Maestro v2.x CLI's
    // JVM cold-start (~10-12s steady-state on a healthy AVD), measured
    // on v2.3.0 / Java 17 — the v1.39 budget of 8s ran shorter than v2's
    // first-invocation init and caused false-positive "unhealthy" verdicts
    // that triggered Stage 2 repair on a perfectly working driver
    // (malaria-itn-app/20260517-1829 trace: probe1 always shell-timed out
    // at 8s, full uninstall+reinstall ran, then probe2 hit the post-tear-down
    // gRPC bind race and surfaced UNAVAILABLE). See
    // docs/learnings/2026-05-19-maestro-v2-probe-timeout.md.
    let probe = await this.maestro.probeDriver(adbPort, 20_000);
    if (probe.healthy) return;
    attempts.push(`probe1: ${probe.reason ?? 'unknown'}`);
    logInfo(`maestro_driver: stage 1 probe unhealthy on ${serial} — attempting install + repair`);

    // Stage 1.5: explicitly install the driver APKs.
    //
    // Why this exists separately from the Stage 2 `repairDriver` flow:
    // `repairDriver` relies on the documented Maestro CLI behavior that
    // the next `maestro hierarchy` call reinstalls the driver
    // automatically. That works fine when the driver was once
    // installed and is now wedged (the canonical leep run 20260511-0507
    // class). It does NOT work on a **fresh AVD where the driver was
    // never installed**: the CLI's first auto-push races the AVD's
    // early-boot `pm` service availability, fails with "Install failed:
    // cmd: Can't find service: package", and subsequent probes see an
    // empty port 7001 with no retry path inside the CLI. Reproduced
    // live 2× on malaria-itn-fgd/20260515-1645 across a machine reboot.
    //
    // `ensureDriverInstalled` is idempotent: when the driver is already
    // installed, it short-circuits in ~150ms and we proceed straight
    // to Stage 2 below (the wedged-but-installed recovery path).
    try {
      const installActions = await this.maestro.ensureDriverInstalled(serial);
      attempts.push(`install: ${installActions.join(',')}`);
      if (!installActions.includes('already-installed')) {
        // Fresh install — give the driver a moment to bind its gRPC
        // server, then re-probe with the same extended budget Stage 2
        // uses.
        probe = await this.maestro.probeDriver(adbPort, 90_000);
        if (probe.healthy) {
          logInfo(`maestro_driver: recovered after ${installActions.join(',')} on ${serial}`);
          return;
        }
        attempts.push(`probe1.5: ${probe.reason ?? 'unknown'}`);
      }
    } catch (e: any) {
      // Don't fail the heal on an install error — fall through to the
      // repair path. The install error message is captured in
      // `attempts` so MaestroDriverError surfaces it if Stage 2 also
      // fails to recover.
      attempts.push(`install-error: ${(e?.message ?? String(e)).slice(0, 180)}`);
    }

    // Stage 2: force-stop + uninstall + re-probe with a longer timeout to
    // allow the driver to reinstall and bind its gRPC server.
    const actions = await this.maestro.repairDriver(serial);
    attempts.push(`repair: ${actions.join(',')}`);
    probe = await this.maestro.probeDriver(adbPort, 90_000);
    if (probe.healthy) {
      logInfo(`maestro_driver: recovered after ${actions.join(',')} on ${serial}`);
      return;
    }
    attempts.push(`probe2: ${probe.reason ?? 'unknown'}`);
    throw new MaestroDriverError(serial, attempts);
  }

  /**
   * Read-only Maestro driver health probe. No recovery, no mutation —
   * just answers "would the next `maestro test` call work?" for the
   * given serial. Used by `ace-doctor` to gate the `mobile_infra` line
   * before `/ace:run` starts.
   */
  async probeMaestroDriver(serial: string, timeoutMs: number = 8_000): Promise<{ healthy: boolean; reason?: string; adbPort: number | null }> {
    const adbPort = AvdBackend.adbPortFromSerial(serial);
    if (adbPort === null) {
      return { healthy: false, reason: 'serial is not an emulator-NNNN (real-device probe not supported)', adbPort: null };
    }
    const r = await this.maestro.probeDriver(adbPort, timeoutMs);
    return { ...r, adbPort };
  }
  stopAvd(name: string, opts: { force?: boolean } = {}): Promise<void> {
    if (this.useCloud) return this.requireCloud().stopAvd(name, opts);
    // The local AVD backend has no busy guard — opts is ignored there.
    return this.avd.stopAvd(name);
  }
  listAvds(): Promise<string[]> {
    if (this.useCloud) return this.requireCloud().listAvds();
    return this.avd.listAvds();
  }
  installApk(avdName: string, apk: string): Promise<ApkInfo> {
    if (this.useCloud) return this.requireCloud().installApk(avdName, apk);
    return this.avd.installApk(avdName, apk);
  }
  uninstallApk(avdName: string, pkg: string): Promise<{ uninstalled: boolean }> {
    if (this.useCloud) return this.requireCloud().uninstallApk(avdName, pkg);
    return this.avd.uninstallApk(avdName, pkg);
  }
  captureUiDump(avdName: string): Promise<UiDumpResult> {
    if (this.useCloud) return this.requireCloud().captureUiDump(avdName);
    return this.avd.captureUiDump(avdName);
  }
  saveSnapshot(avdName: string, snapshotName: string): Promise<SnapshotResult> {
    if (this.useCloud) return this.requireCloud().saveSnapshot(avdName, snapshotName);
    return this.avd.saveSnapshot(avdName, snapshotName);
  }
  loadSnapshot(avdName: string, snapshotName: string): Promise<SnapshotResult> {
    if (this.useCloud) return this.requireCloud().loadSnapshot(avdName, snapshotName);
    return this.avd.loadSnapshot(avdName, snapshotName);
  }

  // ── Cloud-only diagnostics + admin ─────────────────────────────────
  //
  // These three methods are only meaningful against the cloud backend
  // (there is no `/api/mobile/diagnose` for a local AVD — `adb` is the
  // local equivalent). When the active backend is local we throw a
  // clear typed error rather than silently no-op'ing, so a skill that
  // calls `mobile_diagnose` against a local backend sees a signal
  // instead of a misleading empty result.

  private requireCloudOnly(operation: string): CloudBackend {
    if (!this.useCloud) {
      throw new MobileError(
        'CLOUD_ONLY_OPERATION',
        `${operation} is only available on the cloud mobile backend`,
        'Switch to cloud with /ace:mobile-backend cloud, or invoke this against the cloud directly.',
      );
    }
    return this.requireCloud();
  }

  /** Read-only in-VM diagnostic snapshot. Cloud only. */
  diagnose(): Promise<CloudDiagnostics> {
    return this.requireCloudOnly('mobile_diagnose').diagnose();
  }

  /** Cleanly restart the in-VM ace-mobile-runner unit. Cloud only. */
  restartRunner(opts: { waitForReady?: boolean } = {}): Promise<CloudDiagnostics> {
    return this.requireCloudOnly('mobile_restart_runner').restartRunner(opts);
  }

  /** Hot-patch the in-VM ace-emulator-launch script. Cloud only. */
  patchLaunchScript(opts: {
    scriptBody: string;
    restartRunner?: boolean;
  }): Promise<CloudPatchLaunchScriptResult> {
    return this.requireCloudOnly('mobile_patch_launch_script').patchLaunchScript(opts);
  }

  /**
   * When `avdName` is provided, the recipe runs against that emulator's
   * adb port directly via `maestro --host=localhost --port=<adbd>`,
   * which sidesteps the dadb-1.2.10 listDadbs bug that aborts on any
   * unauthorized device in the local adb-server's device list (see
   * `MaestroBackend.runRecipe`). Without `avdName` we fall back to
   * Maestro's default device auto-discovery for backward compatibility.
   *
   * On the cloud backend `avdName` is the desired baked state (e.g.
   * `cc-2.62.0`). The recipe is shipped as a YAML string in the request
   * body and screenshots are downloaded into `screenshotDir`.
   */
  async runRecipe(
    recipePath: string,
    env: Record<string, string>,
    screenshotDir: string,
    avdName?: string,
  ): Promise<RecipeRunResult> {
    // Auto-inject ACE_E2E_* env vars from process.env (PIN, PHONE,
    // BACKUP_CODE, etc.) — caller-provided values win on conflict.
    // See `mcp/mobile/recipe-resolver.ts § injectAceEnvVars` for the
    // mapping. Closes harness-gap-1 from turmeric retry #5.
    const enrichedEnv = injectAceEnvVars(env);

    // Resolve `${SELECTOR:...}` placeholders in the top-level recipe AND
    // every file in the static palette before invoking Maestro. The
    // resolved files are written to a temp dir; Maestro's relative-path
    // `runFlow: file:` refs naturally resolve to the temp-dir siblings.
    // Closes harness-gap-2 from turmeric retry #5. Both backends go
    // through the same prep — for cloud we ship the resolved temp dir
    // as a tarball alongside the top recipe, so cloud's Maestro sees
    // the same sibling layout the local path's Maestro sees. (Pre-
    // 2026-05-16 the cloud branch skipped this entirely on the
    // assumption that ace-web resolved server-side; it never did.)
    // The selector map's APK version is hard-coded to 2.62.0 for now —
    // when ACE moves to a newer Connect APK, this becomes a
    // `process.env.ACE_CONNECT_APK_VERSION` lookup.
    const prep = await prepareRecipeForMaestro(recipePath, '2.62.0');
    if (prep.unverifiedSelectorsInTop.length > 0) {
      logInfo(
        `runRecipe: ${recipePath} uses unverified selectors ` +
          `${JSON.stringify(prep.unverifiedSelectorsInTop)} — proceeding, but ` +
          `recipe may halt at the first unverified-selector tap.`,
      );
    }

    if (this.useCloud) {
      const paletteTarB64 = tarDirAsBase64(prep.tempDir);
      return this.requireCloud().runRecipe(
        prep.resolvedPath,
        enrichedEnv,
        screenshotDir,
        { state: avdName, paletteTarB64 },
      );
    }

    const avdInfo = avdName ? await this.resolveAvdInfo(avdName) : undefined;
    // Pass `serial` through so MaestroBackend can capture per-screenshot
    // UI hierarchy dumps in the quiet windows between sub-recipes. See
    // `MaestroBackend.runRecipeWithDumps` for the split-and-capture
    // contract and `docs/learnings/2026-05-14-atlas-side-channel-capture.md`
    // for why a side-channel dump (running concurrent with Maestro)
    // doesn't work. When `serial` is undefined the backend falls back
    // to the pre-0.13.229 single-invocation path with no dumps.
    return this.maestro.runRecipe(prep.resolvedPath, enrichedEnv, screenshotDir, {
      adbPort: avdInfo?.adbPort,
      serial: avdInfo?.serial,
    });
  }

  private async resolveAvdInfo(
    avdName: string,
  ): Promise<{ adbPort?: number; serial?: string } | undefined> {
    const found = await this.avd.findRunningAvd(avdName);
    if (!found) return undefined;
    const port = AvdBackend.adbPortFromSerial(found.serial);
    return { adbPort: port ?? undefined, serial: found.serial };
  }

  /**
   * Register the ACE test user end-to-end via Maestro. Assumes the +7426
   * demo-bypass prefix is in use (otherwise Connect-id needs a real OTP, a
   * path we no longer maintain — see CHANGELOG 0.10.17). Also assumes the
   * phone is pre-invited to a Connect opportunity; without that, Connect-id's
   * /users/start_configuration crashes with SystemExit (CI-643).
   *
   * Two recipes back this:
   *   - connect-register-to-otp.yaml: launch → phone entry → Continue
   *   - connect-register-from-otp.yaml: snackbar OK → App Lock + PIN →
   *     name → backup code → photo capture
   */
  async registerTestUser(args: {
    avdName: string;
    phone: string;
    phoneLocal: string;
    countryCode: string;
    pin: string;
    backupCode: string;
    name: string;
  }): Promise<TestUserRegistrationResult> {
    if (this.useCloud) {
      // Feature-flagged: when `ACE_MOBILE_CLOUD_LIVE_REGISTER=true`,
      // call the new ace-web endpoint to drive the same two-recipe
      // walkthrough server-side that the local backend runs here
      // — converging cloud onto local's always-deterministic-bootstrap
      // model. Otherwise fall back to the legacy "trust the AMI cold-
      // boot pre-bake" no-op for the in-flight rollout.
      //
      // The AMI's `ace-emulator-launch` (pre-cutover) registers the
      // +7426 demo user using AWS Secrets Manager creds before the
      // `/run/ace-mobile/ready` marker fires. Once Phase D rebakes the
      // AMI to drop the pre-bake, the flag must be on or every
      // dispatch will fail with an unregistered Connect app.
      if (process.env.ACE_MOBILE_CLOUD_LIVE_REGISTER === 'true') {
        return this.cloudRegisterTestUser(args);
      }
      logInfo(`register_test_user: cloud backend — no-op (AMI cold-boot path registers ${args.phone})`);
      return { alreadyRegistered: true, phone: args.phone };
    }
    // Use requireRunningAvd, not ensureAvdRunning — registerTestUser is
    // called by runLocalBootstrap after the orchestrator has already
    // cold-booted the AVD via this.avd.ensureAvdRunning. Triggering
    // another cold-boot here would wipe the just-installed CommCare
    // APK and loop forever.
    const avd = await this.avd.requireRunningAvd(args.avdName);
    const adbPort = AvdBackend.adbPortFromSerial(avd.serial) ?? undefined;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-mobile-reg-'));
    const toContinue = path.join(this.staticRecipesDir, 'connect-register-to-otp.yaml');
    const fromContinue = path.join(this.staticRecipesDir, 'connect-register-from-otp.yaml');
    let success = false;
    try {
      // GMS is enabled here so CommCare 2.62.0's launch check passes. We
      // disable it between part A and part B so the in-app face-capture
      // step (only reached on the fresh-registration branch of part B)
      // can fall back to ManualMode. See `AvdBackend.setGmsEnabled`.
      await this.avd.setGmsEnabled(args.avdName, true);

      logInfo('register_test_user: part A (launch → Continue)');
      const partA = await this.maestro.runRecipe(toContinue, {
        PHONE_LOCAL: args.phoneLocal,
        COUNTRY_CODE: args.countryCode,
        PIN: args.pin,
      }, path.join(tmp, 'part-a'), { adbPort });
      if (partA.status !== 'pass') {
        if (partA.stdout.includes('PHONE_ALREADY_REGISTERED')) {
          success = true;
          return { alreadyRegistered: true, phone: args.phone };
        }
        throw new Error(`register_test_user part A failed: ${partA.stderr || partA.stdout}`);
      }

      // Disable GMS so face-capture in part B picks ManualMode. CommCare
      // already passed its launch check above, and doesn't re-check GMS
      // mid-session.
      await this.avd.setGmsEnabled(args.avdName, false);

      logInfo('register_test_user: part B (post-Continue → registered)');
      const partB = await this.maestro.runRecipe(fromContinue, {
        NAME: args.name,
        BACKUP_CODE: args.backupCode,
        PIN: args.pin,
      }, path.join(tmp, 'part-b'), { adbPort });
      if (partB.status !== 'pass') {
        if (partB.stdout.includes('PHONE_ALREADY_REGISTERED')) {
          success = true;
          return { alreadyRegistered: true, phone: args.phone };
        }
        throw new Error(`register_test_user part B failed: ${partB.stderr || partB.stdout}`);
      }

      success = true;
      return { alreadyRegistered: false, phone: args.phone, backupCode: args.backupCode };
    } finally {
      // Clean up on success; on failure, keep the screenshot artifacts
      // for post-mortem (the user is going to want to see "what did
      // Maestro actually do?" when registration broke). The path is
      // logged so it's discoverable.
      if (success) {
        try {
          fs.rmSync(tmp, { recursive: true, force: true });
        } catch {
          // Best-effort — leak is small and bounded by the size of two
          // Maestro screenshot dirs; better than throwing in finally.
        }
      } else {
        logInfo(`register_test_user: kept temp artifacts at ${tmp} for post-mortem`);
      }
    }
  }

  /**
   * Cloud-side counterpart to ``registerTestUser`` — drives the two-
   * recipe walkthrough on the cloud AVD via ace-web's
   * ``/api/mobile/register-test-user`` endpoint. The server runs the
   * same two recipes + GMS toggle that local does inline.
   *
   * Recipes ship to the server as a base64 tar.gz of the resolved
   * static palette. Uses ``prepareRecipeForMaestro`` to produce the
   * same resolved temp-dir layout the local Maestro sees (selector
   * placeholders expanded, palette siblings populated). The two
   * recipe basenames are passed alongside so the server knows which
   * file to invoke first vs. second.
   *
   * Behind ``ACE_MOBILE_CLOUD_LIVE_REGISTER`` — see the caller
   * ``registerTestUser`` for the gate and rollout rationale.
   */
  private async cloudRegisterTestUser(args: {
    avdName: string;
    phone: string;
    phoneLocal: string;
    countryCode: string;
    pin: string;
    backupCode: string;
    name: string;
  }): Promise<TestUserRegistrationResult> {
    const toName = 'connect-register-to-otp.yaml';
    const fromName = 'connect-register-from-otp.yaml';
    const toPath = path.join(this.staticRecipesDir, toName);

    // Resolve the static palette into a temp dir so the server sees
    // the same sibling layout local does. We hand `to_otp` to
    // `prepareRecipeForMaestro` as the "top" recipe; the palette
    // includes both register recipes (the function resolves *every*
    // file in STATIC_RECIPES_DIR), so `from_otp` lands alongside.
    const prep = await prepareRecipeForMaestro(toPath, '2.62.0');
    try {
      const paletteTarB64 = tarDirAsBase64(prep.tempDir);
      logInfo(
        `register_test_user: cloud backend — live register for ${args.phone} (palette ${paletteTarB64.length}b)`,
      );
      return await this.requireCloud().registerTestUser({
        phone: args.phone,
        phoneLocal: args.phoneLocal,
        countryCode: args.countryCode,
        pin: args.pin,
        backupCode: args.backupCode,
        name: args.name,
        paletteTarB64,
        toOtpRecipe: toName,
        fromOtpRecipe: fromName,
      });
    } finally {
      try {
        fs.rmSync(prep.tempDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; the OS temp dir is bounded.
      }
    }
  }

  /**
   * Cloud-side heal flow — mirrors ``runLocalBootstrap``'s
   * ``clearConnectAppData + registerTestUser`` sequence against the
   * cloud AVD. Called from ``restoreDeviceUserState``'s cloud branch
   * when ``ACE_MOBILE_CLOUD_LIVE_REGISTER=true``.
   *
   * Returns a ``DeviceStateHealLog`` shaped identically to the
   * local-bootstrap variant so downstream telemetry doesn't have to
   * branch — only the ``healed_via`` field shifts to
   * ``'cloud-bootstrap'`` so the operator can distinguish the path.
   *
   * Defends against missing ``bootstrapConfig`` the same way the local
   * branch does: env vars (``ACE_E2E_*``) must be present, otherwise
   * we have no credentials to register with and the heal can't proceed.
   *
   * Verification step (``probeDeviceUserState``) is intentionally NOT
   * called here. Unlike the local backend, the cloud backend has no
   * lightweight UI dump probe that doesn't go through a full Maestro
   * round-trip — and a successful ``cloudRegisterTestUser`` already
   * implies the device reached a registered state (the second register
   * recipe asserts on the post-registered drawer). If the registration
   * succeeds the device IS ``ready``; if it fails we surface the
   * underlying ``MobileError`` from the cloud call.
   */
  private async cloudBootstrapHeal(avd: AvdInfo): Promise<DeviceStateHealLog> {
    if (!this.bootstrapConfig) {
      const missing = missingBootstrapEnvVars();
      const detail =
        missing.length > 0
          ? `bootstrapConfig:absent (missing env: ${missing.join(', ')}; run /ace:setup --force-env then retry)`
          : `bootstrapConfig:absent (explicitly disabled by caller)`;
      throw new DeviceUserStateError('unknown', [detail]);
    }
    const { testUser } = this.bootstrapConfig;
    const cloud = this.requireCloud();

    // Step 1: wipe Connect's per-app data. Idempotent — if the package
    // isn't installed (the post-Phase-D AMI state) the server reports
    // cleared=false and we still proceed.
    logInfo(`cloud_bootstrap: pm clear org.commcare.dalvik on ${avd.serial}`);
    const cleared = await cloud.clearAppData('org.commcare.dalvik').catch(() => false);
    const steps: string[] = [cleared ? 'app-data-cleared' : 'app-data-clear-noop'];

    // Step 2: register the test user via the cloud endpoint. Uses the
    // same flag-gated path that ``MobileClient.registerTestUser``'s
    // cloud branch takes — but called directly here to keep the heal
    // log shape clean (the public method's return is the
    // ``TestUserRegistrationResult``, not a ``DeviceStateHealLog``).
    logInfo(`cloud_bootstrap: registering test user ${testUser.phone} on ${avd.serial}`);
    const reg = await this.cloudRegisterTestUser({
      avdName: avd.name,
      phone: testUser.phone,
      phoneLocal: testUser.phoneLocal,
      countryCode: testUser.countryCode,
      pin: testUser.pin,
      backupCode: testUser.backupCode,
      name: testUser.name,
    });
    steps.push(reg.alreadyRegistered ? 'register-already' : 'registered');

    return {
      classified_as: 'ready',
      attempted: true,
      healed_via: 'cloud-bootstrap',
      verified_as: 'ready',
      bootstrap_steps: steps,
    };
  }

  async generateRecipesFromAppSummary(args: {
    oppName: string;
    appKind: 'learn' | 'deliver';
    drive: DriveAdapter;
    driveRootId: string;
    /**
     * REQUIRED. The mobile MCP does not bundle an LLM client. Inside Claude
     * Code, ACE skills generate Maestro YAML inline using their own LLM
     * context and validate via `mobile_validate_recipe` — they do not call
     * this method. This method is provided for non-Claude-Code programmatic
     * callers (scripts, CI jobs) that supply their own LlmFn.
     */
    llm: LlmFn;
  }): Promise<{ recipePaths: string[]; manifestPath: string }> {
    const summaryPath = `ACE/${args.oppName}/app-summaries/${args.appKind}-app-summary.md`;
    const summary = await args.drive.readFile(args.driveRootId, summaryPath);

    const generator = new RecipeGenerator({ llm: args.llm });
    const moduleNames = generator.parseSummary(summary);

    const recipePaths: string[] = [];
    const manifestEntries: { module: string; path: string }[] = [];
    for (let i = 0; i < moduleNames.length; i++) {
      const moduleName = moduleNames[i];
      const yaml = await generator.generateForModule({ summary, moduleName, appKind: args.appKind });
      const recipePath = `ACE/${args.oppName}/mobile-recipes/${args.appKind}/module-${i + 1}.yaml`;
      await args.drive.writeFile(args.driveRootId, recipePath, yaml);
      recipePaths.push(recipePath);
      manifestEntries.push({ module: moduleName, path: recipePath });
    }

    const manifestPath = `ACE/${args.oppName}/mobile-recipes/${args.appKind}/manifest.yaml`;
    const manifestYaml =
      `# auto-generated by ace-mobile recipe-generator\n` +
      `app_kind: ${args.appKind}\n` +
      `generated_at: ${new Date().toISOString()}\n` +
      `recipes:\n` +
      manifestEntries.map((e) => `  - module: "${e.module.replace(/"/g, '\\"')}"\n    path: ${e.path}`).join('\n') +
      `\n`;
    await args.drive.writeFile(args.driveRootId, manifestPath, manifestYaml);

    return { recipePaths, manifestPath };
  }
}
