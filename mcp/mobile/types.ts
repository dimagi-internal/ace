/**
 * Local-AVD counterpart to the cloud backend's `CloudDiagnostics`
 * (dimagi-internal/ace#961). Returned by `AvdBackend.diagnose()` and, via
 * `MobileClient.diagnose()`, by the `mobile_diagnose` atom when the active
 * backend is local.
 *
 * `backend` is the discriminant that lets one atom serve both backends:
 * `'local'` here, `'cloud'` on the cloud envelope.
 *
 * The reason this type exists at all is `adb_server_port`. The local
 * backend probe-allocates its own adb server (5037 upward — typically 5039
 * on a workstation where a sibling session already holds 5037), so a raw
 * `adb devices` from a session shell talks to the DEFAULT 5037, prints an
 * empty device list, and reads as a dead emulator while the emulator is
 * running fine. `adb_env_hint` carries the copy-pasteable fix.
 */
export interface LocalDiagnostics {
  backend: 'local';
  /** The adb server port THIS backend booted the emulator against. */
  adb_server_port: number;
  emulator_console_port: number;
  emulator_adb_bridge_port: number;
  /** False when ANDROID_ADB_SERVER_PORT / ACE_MOBILE_EMULATOR_PORT pinned them. */
  ports_auto_allocated: boolean;
  /** e.g. `ANDROID_ADB_SERVER_PORT=5039` — prefix a raw adb call with this. */
  adb_env_hint: string;
  /** Devices visible on `adb_server_port` (NOT on the default 5037). */
  adb_devices: Array<{ serial: string; state: string }>;
  adb_visible_count: number;
  /** AVD name behind the first emulator serial, when readable. */
  avd_name: string | null;
  avd_serial: string | null;
  /** `emulator -list-avds` — what could be booted. */
  known_avds: string[];
  /** Set instead of throwing when the adb probe itself failed. */
  adb_error: string | null;
  /**
   * Cross-session AVD contention (ace#1821). Null only on the cloud backend.
   *
   * Every OTHER field above describes THIS session and can be entirely correct
   * while the device is being destroyed by a peer — that is exactly how
   * `adb_visible_count: 0` read as a dead device through four wrong diagnoses
   * on `bednet-check-2-visit/20260828-0629`, while nine live ace-mobile MCPs
   * across two macOS accounts cold-booted one shared AVD with `-wipe-data`.
   * This is the only field here that describes the HOST rather than us.
   */
  contention: ContentionSummary | null;
}

/** The host-level view: who else could be fighting us for the AVD. */
export interface ContentionSummary {
  other_mobile_sessions: number;
  /** True when a peer runs under a DIFFERENT macOS account — invisible to any
   * `~/.ace/sessions` lock or `pgrep -u <uid>` scan, and so to every other
   * mechanism ACE has. */
  cross_account: boolean;
  sessions: Array<{
    pid: number;
    user: string;
    plugin_version: string | null;
    started_at: string;
    is_self: boolean;
  }>;
  known_avd_count: number;
  verdict: 'pass' | 'warn' | 'skip';
  /** Names the cause and the remedy — a bare count is what misled the diagnoses. */
  reason: string;
}

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
 * - `uiautomation-unavailable` — Android's per-device UiAutomation singleton
 *                              could not be acquired, so `uiautomator dump`
 *                              wrote no `window_dump.xml`. Another automation
 *                              client (a concurrent Maestro/uiautomator run,
 *                              typically a sibling ACE session on the same
 *                              host) holds the device. The remediation is to
 *                              kill the competing client — NOT to reinstall
 *                              or re-register anything. See ace#1155.
 * - `device-unreachable`     — the probe's own adb server had no device
 *                              attached, so NOTHING about the device was
 *                              observed. Never a claim about package state.
 * - `probe-failed`           — a device was reachable but the package query
 *                              itself errored, so package state is UNKNOWN.
 *                              Distinct from `commcare-not-installed`, which
 *                              requires a SUCCESSFUL query that came back
 *                              without `org.commcare.dalvik`. Conflating the
 *                              two is what ace#1155 cost: a failed query read
 *                              as a confident negative answer and sent two
 *                              investigations at reinstalling a package that
 *                              was installed the whole time.
 * - `unknown`                — none of the known markers; let downstream
 *                              recipes classify, don't halt up-front.
 */
export type DeviceUserStateClass =
  | 'ready'
  | 'commcare-not-installed'
  | 'needs-app-config'
  | 'needs-personal-id'
  | 'app-crash-looping'
  | 'uiautomation-unavailable'
  | 'device-unreachable'
  | 'probe-failed'
  | 'unknown';

/**
 * What the probe FAILED to observe, as distinct from what it observed.
 *
 * The load-bearing distinction (ace#1155): an empty result from a query that
 * ERRORED is not a negative answer. `classifyDeviceUserState` may only report
 * a package-state class when it was handed a package list that actually came
 * back from a device.
 */
export interface DeviceProbeFailures {
  /** The probe's adb server had no device attached at all. */
  deviceUnreachable?: boolean;
  /** `pm list packages` errored / could not be run. */
  packageQueryFailed?: boolean;
  /** `uiautomator dump` produced no readable `window_dump.xml`. */
  uiDumpFailed?: boolean;
}

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
  testUser: TestUserCredentials;
}

/**
 * The credential set `runLocalBootstrap` registers on the device.
 *
 * Extracted from {@link LocalBootstrapConfig} (which used to inline it) so a
 * caller can hand `mobile_ensure_avd_running` a PARTIAL override without
 * restating the whole bootstrap config — see {@link EnsureAvdRunningOptions}.
 */
export interface TestUserCredentials {
  phone: string;
  phoneLocal: string;
  countryCode: string;
  pin: string;
  backupCode: string;
  name: string;
}

/**
 * Optional per-call overrides for `MobileClient.ensureAvdRunning`.
 *
 * **Omitting this is the production default and changes nothing** — the client
 * uses `bootstrapConfigFromEnv()` exactly as it always has, byte for byte.
 *
 * It exists for the per-run demo test user (dimagi-internal/ace#1289): a caller
 * that minted a run-scoped `+7426…` number needs the cold-boot registration to
 * use THAT number without rewriting `.env` — which matters because every MCP
 * server reads `.env` at module load, so an `.env` write would need a full
 * Claude Code restart to take effect. A call argument needs none.
 *
 * Only the fields you pass are overridden; the rest still come from
 * `ACE_E2E_*`. That is deliberate: `pin` / `backupCode` are not per-user
 * secrets in the demo range, so a per-run caller passes only
 * `{ phone, phoneLocal, countryCode, name }`.
 *
 * LOCAL BACKEND ONLY. The cloud backend registers inside the AMI and needs
 * `ACE_MOBILE_CLOUD_LIVE_REGISTER=true` plus an ace-web change to accept
 * caller-supplied credentials; passing overrides while routed to cloud throws
 * rather than silently registering the wrong user.
 */
export interface EnsureAvdRunningOptions {
  testUser?: Partial<TestUserCredentials>;
}

export interface ApkInfo {
  packageId: string;    // e.g. "org.commcare.dalvik"
  versionName: string;
  versionCode: number;
  path: string;
}

/**
 * Options for `MobileClient.runRecipe` (and, one layer down,
 * `MaestroBackend.runRecipe`) — the `mobile_run_recipe` atom's tunables
 * that aren't already positional args (recipePath, env, screenshotDir,
 * avdName).
 */
export interface RunRecipeOptions {
  /**
   * Tier 2 of the mapping ladder: open a dump window at every top-level
   * `runFlow` boundary. Costs one extra `maestro test` invocation per
   * window. Default false. Turn on only after an atlas-report.yaml says
   * `classification: unmapped-surface`.
   */
  captureAllBoundaries?: boolean;
}

export interface RecipeRunResult {
  status: 'pass' | 'fail';
  exitCode: number;
  /**
   * Non-fatal faults observed around this run that did NOT decide the
   * verdict. Added for ace#1822: a Maestro session-teardown exception raised
   * after the last step completed is real information about the host, but it
   * is not a statement about whether the walk ran — so it is reported here
   * beside a `pass` rather than converting one into a `fail`. Also carries a
   * cold-boot heal failure that the envelope declined to let discard an
   * attempt's artifacts.
   *
   * `exitCode` is NEVER rewritten to hide such a fault: a warning-carrying
   * `pass` can legitimately have a non-zero exit code, and that asymmetry is
   * the audit trail.
   */
  warnings?: string[];
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
    /**
     * Sibling `<recipeId>-FAILURE.txt` containing the Maestro stderr excerpt
     * (when one was available at capture time). This is what lets the atlas
     * drift classifier (`lib/atlas-drift.ts` `classifyScreenCoverage`) tell
     * `matcher-miss` (the recipe reached for an id/text that IS on screen —
     * fix the recipe) from `unmapped-surface` (nothing wanted is on screen —
     * a real coverage gap) — those have opposite fixes, and without the
     * stderr excerpt the classifier can never see what the recipe wanted.
     * Absent when no excerpt was available (e.g. a thrown transport error
     * with no Maestro-classified failure attached) or the write failed.
     */
    stderrPath?: string;
  };
  /**
   * The static palette dir this run actually resolved `runFlow: file:`
   * refs against, and whether it came from the plugin install or from an
   * `ACE_MOBILE_STATIC_RECIPES_DIR` override.
   *
   * Exists so an operator live-validating a staged palette fix pre-merge
   * gets POSITIVE proof in the result that the staged copy won. Before
   * jjackson/ace#1062 an override was silently ignored, producing a false
   * negative (the run read as a failed fix) with no signal anywhere but a
   * Maestro trace. Set by `MobileClient.runRecipe`; undefined on results
   * built by paths that don't go through it.
   */
  paletteDir?: string;
  paletteDirSource?: 'install' | 'override';
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
   * MD5 of the PNG bytes. Always set by `collectScreenshotsFromDir`.
   *
   * Exists so the DISTINCTNESS question — "is this a new moment?" — is
   * answered by the harness rather than by whoever writes the manifest.
   */
  md5?: string;
  /**
   * Set iff this frame is byte-identical to an earlier one; names the
   * canonical `stepName` whose moment it actually shows.
   *
   * A consumer must never present a frame carrying this as a distinct moment
   * (ace#866/#1304). The harness picks the canonical twin — see
   * `markDuplicateFrames` — because the rule has an exception that is
   * reliably missed when applied by hand.
   */
  duplicateOf?: string;
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
  /**
   * True when the dump COULD NOT BE TAKEN — `uiautomator dump` errored or
   * `window_dump.xml` was never written — as opposed to a screen that
   * genuinely produced no hierarchy. Both yield `xml: ''`; only one of them
   * says anything about the screen. See ace#1155.
   */
  failed?: boolean;
}

export interface SnapshotResult {
  avdName: string;
  snapshotName: string;
  saved: boolean;
  output: string;
}

/**
 * Result of the read-only Maestro driver probe (`mobile_probe_maestro_driver`).
 *
 * `healthy` is an OBSERVATION, not a guess: it requires the driver packages
 * to be present on this exact serial, not merely a zero exit from
 * `maestro hierarchy` (dimagi-internal/ace#1818).
 *
 * `adbPort` is the EMULATOR'S OWN adbd port (`emulator-5558` -> 5559), the
 * one Maestro dials on its direct-TCP path — NOT the adb SERVER port that
 * `mobile_diagnose` reports. `portKind` names which of the two it is so the
 * distinction never has to be re-derived from a serial.
 *
 * `driverPackages.queryOk === false` means the package query could not be
 * answered; per ace#1155 that is NOT an absence, and the health verdict is
 * flagged UNVERIFIED in `reason` rather than forced to `false`.
 */
export interface MaestroDriverProbeResult {
  healthy: boolean;
  reason?: string;
  adbPort: number | null;
  portKind: 'emulator-adbd-direct-tcp' | null;
  driverPackages: { app: boolean; test: boolean; queryOk: boolean } | null;
}


/**
 * What a THROWN `mobile_run_recipe` dispatch nonetheless produced
 * (dimagi-internal/ace#1822).
 *
 * `client.runRecipe` attaches this to the error it rethrows, and the
 * `mobile_run_recipe` atom surfaces it in the error payload. The throw
 * remains a throw — this exists so that a dispatch which did real,
 * UNREPEATABLE work (a one-way Learn leg, #568/#570) cannot report as if it
 * did none.
 *
 * `screenshots[].takenAt` is the specific field this rescues: the Deliver
 * duration-floor gate in `skills/app-screenshot-capture` Step 5 computes
 * `walk_elapsed_seconds` from it, and a thrown dispatch had no route to it
 * at all.
 */
export interface ThrownRecipePartial {
  status: 'error';
  screenshotsDir: string;
  screenshots: ScreenshotEntry[];
  videos: VideoArtifact[];
  recipeId: string;
  dispatchId: string;
  deviceSerial?: string;
}
