export interface AvdInfo {
  name: string;
  serial: string;       // adb device serial, e.g. "emulator-5554"
  status: 'booted' | 'booting' | 'offline';
  bootTimeMs?: number;
  /**
   * Optional heal log produced by `MobileClient.ensureAvdRunning` when its
   * probes detected a recoverable state and ran a heal. Subagents surface
   * this to skills so they can attribute halts ("snapshot-load recovered
   * the state" vs "heal exhausted, need /ace:mobile-bootstrap") rather
   * than guessing from indirect signals like the recipe error string.
   * Undefined when nothing needed healing.
   */
  heal?: {
    maestroDriver?: { healed: boolean; attempts?: string[] };
    deviceUserState?: DeviceStateHealLog;
  };
}

/**
 * Per-user device-state classification — see `classifyDeviceUserState`
 * in `client.ts` for the signal-to-class mapping.
 *
 * - `ready`                  — Connect home / opp tile screen reachable; proceed.
 * - `commcare-not-installed` — `org.commcare.dalvik` absent. CommCare 2.62.0+
 *                              IS the Connect-enabled client (NO separate
 *                              package); never grep for `connect`.
 * - `needs-app-config`       — CommCareSetupActivity foregrounded / "Enter
 *                              Code" screen. No `ApplicationDocument`.
 * - `needs-personal-id`      — "Logged out of PersonalID" drawer banner.
 *                              Connect identity layer is gone.
 * - `unknown`                — none of the known markers; let downstream
 *                              recipes classify, don't halt up-front.
 */
export type DeviceUserStateClass =
  | 'ready'
  | 'commcare-not-installed'
  | 'needs-app-config'
  | 'needs-personal-id'
  | 'unknown';

export interface DeviceStateHealLog {
  classified_as: DeviceUserStateClass;
  attempted: boolean;
  healed_via?: 'snapshot-load' | 'local-bootstrap' | 'none';
  verified_as?: DeviceUserStateClass;
  focused_activity?: string;
  ui_dump_signal?: string;
  /**
   * Populated only when `healed_via: 'local-bootstrap'` — itemized
   * record of the tier-2 actions taken (apk_installed, registered,
   * snapshot_saved). Surfaces what the auto-bootstrap actually did so
   * the operator can verify against expectations.
   */
  bootstrap_steps?: string[];
}

/**
 * Test-user credentials + APK version pin needed by `runLocalBootstrap`.
 * Populated from `ACE_E2E_*` and `ACE_CONNECT_APK_VERSION` env vars by
 * `bootstrapConfigFromEnv()`. Set to `null` (the default for callers
 * that don't pass `bootstrapConfig` and don't have all required env
 * vars set) to disable the tier-2 fallback — `restoreDeviceUserState`
 * will throw `snapshot-load-failed` on snapshot-missing without
 * attempting a bootstrap.
 */
export interface LocalBootstrapConfig {
  apkVersion: string;
  testUser: {
    phone: string;
    phoneLocal: string;
    countryCode: string;
    pin: string;
    backupCode: string;
    name: string;
  };
}

export interface ApkInfo {
  packageId: string;    // e.g. "org.commcare.dalvik"
  versionName: string;
  versionCode: number;
  path: string;
}

export interface RecipeRunResult {
  status: 'pass' | 'fail';
  exitCode: number;
  stdout: string;
  stderr: string;
  screenshotsDir: string;
  screenshots: ScreenshotEntry[];
  /**
   * Structured per-step report parsed from Maestro's --debug-output
   * commands JSON. Optional — backends that can't surface it (or
   * Maestro versions that don't emit a commands JSON) leave this
   * undefined, and skills should fall back to `screenshots[]` ordering.
   * Cloud backend populates this from `/api/mobile/run-recipe`'s
   * `steps[]` envelope field (since ace-web v0.x).
   */
  steps?: StepResult[];
  /**
   * Cloud backend only: post-failure in-VM diagnostic snapshot
   * captured via `/api/mobile/diagnose`. Populated when `status:
   * 'fail'` and the diagnose probe itself succeeded. Lets skills see
   * the runner's state at the moment of failure (was the emulator
   * still alive? did pm crash? did the marker disappear?) without
   * making a separate round-trip. Undefined on `pass` or when
   * diagnose itself failed. Shape mirrors ace-web's Diagnostics
   * dataclass — see CloudDiagnostics in backends/cloud.ts.
   */
  // Untyped here to avoid pulling CloudDiagnostics into the
  // backend-agnostic types module; the cloud backend casts on assign.
  diagnostics?: Record<string, unknown>;
}

export interface StepResult {
  index: number;
  name: string;
  status: 'pass' | 'fail' | 'skipped' | 'unknown';
  /** Filename only (not a full path) — matches a ScreenshotEntry.stepName when set. */
  screenshot?: string;
  error?: string;
  durationMs?: number;
}

export interface ScreenshotEntry {
  stepName: string;
  path: string;
  takenAt: string;      // ISO 8601
  bytes: number;
}

export interface TestUserRegistrationResult {
  alreadyRegistered: boolean;
  phone: string;
  backupCode?: string;  // present only on first registration
}

export interface UiDumpResult {
  xml: string;
  elements: Array<{ id?: string; text?: string; class?: string; bounds?: string }>;
}

export interface SnapshotResult {
  avdName: string;
  snapshotName: string;
  saved: boolean;
  output: string;
}
