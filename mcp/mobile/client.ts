// mcp/mobile/client.ts
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { AvdBackend } from './backends/avd.js';
import {
  CloudBackend,
  type CloudDiagnostics,
  type CloudPatchLaunchScriptResult,
} from './backends/cloud.js';
import { MaestroBackend } from './backends/maestro.js';
import { DeviceUserStateError, MaestroDriverError, MobileError } from './errors.js';
import { RecipeGenerator, type LlmFn } from './backends/recipe-generator.js';
import { resolveBackend } from './backend-toggle.js';
import type {
  AvdInfo, ApkInfo, RecipeRunResult, TestUserRegistrationResult, UiDumpResult,
  SnapshotResult, DeviceUserStateClass, DeviceStateHealLog,
} from './types.js';
import { logInfo } from './logging.js';

export interface MobileClientOpts {
  avd?: AvdBackend;
  maestro?: MaestroBackend;
  cloud?: CloudBackend;
  staticRecipesDir?: string;
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
 * Order matters — first-match wins. The classifier prefers explicit
 * "wipe" markers over the `ready` activity check so that a stacked
 * state (PersonalID drawer over a setup activity) lands on the heal-able
 * class, not on `ready`.
 */
export function classifyDeviceUserState(
  focusedActivity: string,
  uiDumpXml: string,
  installedPackages: string[],
): DeviceUserStateClass {
  if (!installedPackages.some((p) => p === 'org.commcare.dalvik')) {
    return 'commcare-not-installed';
  }
  if (/Logged out of PersonalID|Lost PersonalID configuration|\bReconfigure\b/i.test(uiDumpXml)) {
    return 'needs-personal-id';
  }
  if (/CommCareSetupActivity/i.test(focusedActivity)) {
    return 'needs-app-config';
  }
  if (/Enter Code|Scan Application Barcode|Welcome to CommCare/i.test(uiDumpXml)) {
    return 'needs-app-config';
  }
  if (/OpportunitiesActivity|VendorVisitActivity|DispatchActivity|HomeActivity/i.test(focusedActivity)) {
    return 'ready';
  }
  return 'unknown';
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

  constructor(opts: MobileClientOpts = {}) {
    this.avd = opts.avd ?? new AvdBackend();
    this.maestro = opts.maestro ?? new MaestroBackend();
    this.staticRecipesDir = opts.staticRecipesDir ?? DEFAULT_STATIC_DIR;
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
    if (this.useCloud) return this.requireCloud().ensureAvdRunning(name);
    const info = await this.avd.ensureAvdRunning(name);
    await this.assertMaestroDriverHealthy(info.serial);
    const deviceUserState = await this.restoreDeviceUserState(info);
    return { ...info, heal: { deviceUserState } };
  }

  /**
   * Restore the AVD's per-user state to the known precondition by
   * unconditionally loading `registered-test-user`, then verify the
   * load landed on a usable state. Throws `DeviceUserStateError` on
   * snapshot failure OR verification failure.
   *
   * **Design pattern: preconditions are restored, not adapted.** Every
   * Phase 6 dispatch needs the AVD at the Connect home with the test
   * user signed in. Rather than probe-and-adapt to whatever state we
   * find (a class of complexity that landed an inverted-conclusion bug
   * live in 2026-05-13 turmeric run 20260513-0616), we always restore
   * to the known state via `loadSnapshot`. ~3s round-trip; deterministic
   * starting state every Phase 6 run. See CLAUDE.md § Phase preconditions.
   *
   * **Cloud backend follows the same contract via a different mechanism.**
   * `backends/cloud.ts` documents that each `/api/mobile/ensure-running`
   * call cold-boots the AVD and runs the registration recipes against
   * it, producing a fresh demo user every time (~3-4 min). Cloud's
   * cold-boot IS the restore mechanism; no explicit snapshot-load is
   * needed because the AMI ships the registration recipes built-in.
   * The contract — *"after `MobileClient.ensureAvdRunning` returns, the
   * device is at the Connect home, signed in as the test user"* — is
   * identical across backends; only the mechanism differs.
   *
   * **Recovery escalation.** If the local snapshot doesn't exist (first
   * machine setup, snapshot deleted) or doesn't restore the device to
   * `ready` (snapshot corruption, post-snapshot APK upgrade drift), the
   * heal throws `DeviceUserStateError` with the precise class so the
   * operator knows whether to re-snapshot or re-bootstrap. The full
   * registration + server-side `${ACE_E2E_PHONE}` invite check is
   * `/ace:mobile-bootstrap`'s job; the auto-heal does not duplicate it.
   *
   * **Why the classifier still exists.** Post-load verification — when
   * the snapshot loaded but state is somehow still wrong (corrupted
   * snapshot, APK upgrade drift) the classifier names which class is
   * wrong so the operator gets a precise label, not "snapshot didn't
   * work." That's the only path the classifier fires on now.
   */
  async restoreDeviceUserState(avd: AvdInfo): Promise<DeviceStateHealLog> {
    if (this.useCloud) {
      // Cloud's cold-boot path is the equivalent restore mechanism;
      // see `backends/cloud.ts` header comment. Surface `unknown` so
      // callers don't gate on the local-only field.
      return { classified_as: 'unknown', attempted: false };
    }

    // Restore: ALWAYS load the snapshot. No pre-probe. The snapshot
    // produces a deterministic starting state every Phase 6 run.
    const snapshotName = 'registered-test-user';
    logInfo(
      `device_user_state: restoring to known state via loadSnapshot(${snapshotName}) on ${avd.serial}`,
    );
    let loadOutcome: SnapshotResult;
    try {
      loadOutcome = await this.avd.loadSnapshot(avd.name, snapshotName);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new DeviceUserStateError('snapshot-load-failed', [
        `loadSnapshot:throw(${msg})`,
      ]);
    }
    if (!loadOutcome.saved) {
      throw new DeviceUserStateError('snapshot-load-failed', [
        `loadSnapshot:fail(${loadOutcome.output.slice(0, 200)})`,
      ]);
    }

    // Verify the restore actually landed on a usable state.
    const verify = await this.probeDeviceUserState(avd);
    if (verify.classified_as === 'ready' || verify.classified_as === 'unknown') {
      logInfo(
        `device_user_state: restored to ${verify.classified_as} via snapshot-load on ${avd.serial}`,
      );
      return {
        classified_as: verify.classified_as,
        attempted: true,
        healed_via: 'snapshot-load',
        verified_as: verify.classified_as,
        focused_activity: verify.focused_activity,
        ui_dump_signal: verify.ui_dump_signal,
      };
    }

    // Snapshot loaded but state is still wiped — snapshot corruption
    // or post-snapshot APK upgrade drift. The classifier surfaces
    // which class so the operator knows whether to re-snapshot or
    // re-bootstrap.
    throw new DeviceUserStateError(verify.classified_as, [
      'loadSnapshot:pass',
      `verify:${verify.classified_as}`,
      `signal:${verify.ui_dump_signal ?? 'none'}`,
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
    // Stage 1: cheap probe.
    let probe = await this.maestro.probeDriver(adbPort, 8_000);
    if (probe.healthy) return;
    attempts.push(`probe1: ${probe.reason ?? 'unknown'}`);
    logInfo(`maestro_driver: stage 1 probe unhealthy on ${serial} — attempting repair`);

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
    if (this.useCloud) {
      return this.requireCloud().runRecipe(recipePath, env, screenshotDir, { state: avdName });
    }
    const adbPort = avdName ? await this.resolveAdbPort(avdName) : undefined;
    return this.maestro.runRecipe(recipePath, env, screenshotDir, { adbPort });
  }

  private async resolveAdbPort(avdName: string): Promise<number | undefined> {
    const found = await this.avd.findRunningAvd(avdName);
    if (!found) return undefined;
    const port = AvdBackend.adbPortFromSerial(found.serial);
    return port ?? undefined;
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
      // ace-web's cold-boot path (`ace-emulator-launch`) already registers
      // the +7426 demo user using credentials from AWS Secrets Manager
      // (`ace-mobile-test-user-creds`) before `/run/ace-mobile/ready` is
      // touched. So when routed through cloud, this atom is a no-op that
      // attests the pre-baked registration. The caller's `args.phone` is
      // expected to match the secret's phone; mismatched callers should
      // not invoke this atom on cloud.
      logInfo(`register_test_user: cloud backend — no-op (AMI cold-boot path registers ${args.phone})`);
      return { alreadyRegistered: true, phone: args.phone };
    }
    const avd = await this.avd.ensureAvdRunning(args.avdName);
    const adbPort = AvdBackend.adbPortFromSerial(avd.serial) ?? undefined;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-mobile-reg-'));
    const toContinue = path.join(this.staticRecipesDir, 'connect-register-to-otp.yaml');
    const fromContinue = path.join(this.staticRecipesDir, 'connect-register-from-otp.yaml');

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
        return { alreadyRegistered: true, phone: args.phone };
      }
      throw new Error(`register_test_user part B failed: ${partB.stderr || partB.stdout}`);
    }

    return { alreadyRegistered: false, phone: args.phone, backupCode: args.backupCode };
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
