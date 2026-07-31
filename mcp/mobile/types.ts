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
  /**
   * Cloud-backend cold-boot diagnostics, surfaced so a slow `ensure_avd_running`
   * is attributable in the transcript instead of opaque. Populated only by the
   * cloud backend (and only when ace-web returns them):
   *  - `timings`: per-phase wall seconds (ec2_start_s / emulator_wait_s / …),
   *    so an EC2-provisioning-bound boot is distinguishable from an in-VM
   *    emulator-boot-bound one.
   *  - `accel`: 'kvm' (hardware-accelerated) vs 'tcg' (software fallback, ~10x
   *    slower) — the prime suspect for multi-minute boots.
   */
  timings?: Record<string, number> | null;
  accel?: string | null;
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
 * - `app-crash-looping`      — CommCare is dying with an uncaught exception
 *                              and restarting. Classified FIRST, because a
 *                              crash-loop lands the device back on the
 *                              first-start splash and therefore *looks* like
 *                              `needs-app-config` (or, before ace#950, like
 *                              `needs-personal-id`) to every screen-based
 *                              signal. Re-registering cannot fix it: the fix
 *                              is an APK/app change. See ace#938/#950.
 * - `unknown`                — none of the known markers; let downstream
 *                              recipes classify, don't halt up-front.
 */
export type DeviceUserStateClass =
  | 'ready'
  | 'commcare-not-installed'
  | 'needs-app-config'
  | 'needs-personal-id'
  | 'app-crash-looping'
  | 'unknown';

export interface DeviceStateHealLog {
  classified_as: DeviceUserStateClass;
  attempted: boolean;
  healed_via?: 'snapshot-load' | 'local-bootstrap' | 'cloud-bootstrap' | 'none';
  verified_as?: DeviceUserStateClass;
  focused_activity?: string;
  ui_dump_signal?: string;
  /**
   * Itemized record of the bootstrap actions taken (`apk-installed`,
   * `environment-baseline-applied`, `registered`, ...) — populated on both
   * `healed_via: 'local-bootstrap'` and `'cloud-bootstrap'`. Surfaces what
   * the auto-bootstrap actually did so the operator can check it against
   * expectations.
   *
   * A step name is a claim, so unconfirmed claims are marked as such
   * (dimagi-internal/ace#1067): registration steps carry an `-unverified`
   * suffix (`registered-unverified`, `register-already-unverified`) whenever
   * no probe confirmed the resulting device state — always on cloud, and on
   * local whenever the post-bootstrap probe didn't return `ready`. Callers
   * must not treat the unsuffixed and suffixed forms as equivalent; see
   * `markRegistrationUnverified` in `client.ts`.
   */
  bootstrap_steps?: string[];
  /**
   * True when the AVD environment baseline (heads-up notifications off,
   * GMS DND-disallow, lock-screen timeout 30 min) was applied in this
   * bootstrap. False / undefined for older paths that bypass the baseline.
   * Telemetry-friendly signal — pairs with `environment_baseline_fingerprint`
   * to detect drift across baseline versions.
   */
  environment_baseline_applied?: boolean;
  /**
   * sha1-12 fingerprint of the sorted list of setting keys that compose
   * the environment baseline. Changes whenever the baseline itself
   * changes (key added / removed). Lets telemetry detect AVDs running
   * an older baseline version.
   */
  environment_baseline_fingerprint?: string;
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
   * Screen recordings of this run, one per attempt. Local backend only —
   * the cloud backend leaves this undefined until Phase 2 (see
   * `docs/superpowers/specs/2026-07-30-avd-session-recording-design.md`).
   * Always best-effort: a recording failure never changes `status`.
   */
  videos?: VideoArtifact[];
  /**
   * Structured failure classification from `lib/maestro-failure-class.ts`.
   * Populated on every recipe run (both pass and fail). Consumers can
   * switch on `failure.failureClass` to act on a finite enum rather
   * than parsing stderr strings inline. See `FailureClass` for the
   * 8-class taxonomy.
   */
  failure?: {
    failureClass:
      | 'pass'
      | 'driver'
      | 'app-crash'
      | 'network'
      | 'selector-not-found'
      | 'test-logic'
      | 'timeout'
      | 'unknown';
    stderrExcerpt: string;
    stageReached?: string;
  };
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
  /**
   * Best-effort forensic capture of the device state at the moment a recipe
   * FAILED — captured automatically by `client.runRecipe` whenever
   * `status: 'fail'`, as a debug assist (jjackson/ace screenshot-on-error).
   * A failure leaves the device on the offending screen, so a fresh ui-dump
   * (element tree with ids/text/bounds — the highest-signal artifact for
   * selector/nav debugging) plus a screenshot of that screen are the best
   * evidence for "why did this step fail". Both are best-effort: capture
   * errors are logged and never fail the recipe. Absent on `pass`.
   */
  failureForensics?: {
    uiDumpPath?: string;
    screenshotPath?: string;
    elements?: Array<{ id?: string; text?: string; class?: string; bounds?: string }>;
  };
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
  /**
   * Absolute path to a sibling `<stepName>.xml` UI hierarchy dump
   * captured at the same moment as the PNG. Present only when the
   * caller passed `serial` to `MaestroBackend.runRecipe` AND the
   * matching .xml file is on disk. See § Local backend split-and-dump
   * in `MaestroBackend.runRecipeWithDumps` for the capture contract.
   */
  uiDumpPath?: string;
  /** Byte size of the sibling .xml dump when `uiDumpPath` is set. */
  uiDumpBytes?: number;
  /**
   * Per-dispatch provenance read from `<path>.meta.json` sidecar. Set
   * by `MobileClient.runRecipe` after the backend returns. Consumers
   * (UX eval, stale-carryover detection) compare `dispatch_id` against
   * the current dispatch's ID to detect leftover PNGs from prior runs.
   * Absent on backends/callers that pre-date the sidecar contract.
   * Shape: `lib/screenshot-provenance.ts § ScreenshotProvenance`.
   */
  provenance?: {
    recipe_id: string;
    dispatch_id: string;
    ace_version: string;
    git_sha?: string;
    written_at_epoch_ms: number;
  };
}

/**
 * A screen recording of one recipe-run attempt, captured by
 * `mcp/mobile/screen-recorder.ts` via on-device `adb shell screenrecord`.
 *
 * One per ATTEMPT, not per recipe: `runRecipeWithDriverHeal` can cold-boot
 * the AVD mid-run, which kills the recorder and rotates the serial. The
 * pre-crash segment is the forensically interesting one, so both are kept.
 * Naming: attempt 1 is `<recipeId>.mp4`, later attempts are
 * `<recipeId>-attempt<N>.mp4`.
 */
export interface VideoArtifact {
  /** Absolute host path to the mp4 (inside the run's screenshotDir). */
  path: string;
  bytes: number;
  recipeId: string;
  dispatchId: string;
  /** 1-based attempt index within a single `runRecipe` call. */
  attempt: number;
  /** Same shape/semantics as `ScreenshotEntry.provenance`. */
  provenance?: {
    recipe_id: string;
    dispatch_id: string;
    ace_version: string;
    git_sha?: string;
    written_at_epoch_ms: number;
  };
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
