// mcp/mobile/client.ts
import * as path from 'node:path';
import { writeProvisionedMarker } from './avd-provisioned-marker.js';
import { buildUnreachableMessage } from './device-reachable.js';
import { findLatestBootLog, bootLogTail, fatalBootLine } from './boot-log.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { AvdBackend } from './backends/avd.js';
import {
  CloudBackend,
  type CloudDiagnostics,
} from './backends/cloud.js';
import { MaestroBackend, collectScreenshotsFromDir } from './backends/maestro.js';
import {
  AvdBootError,
  DeviceUserStateError,
  isTransientBootRaceError,
  MaestroDriverError,
  MobileError,
  NoInviteSuspectedError,
  StaleRecipeError,
} from './errors.js';
import { detectNoInviteSignature } from '../../lib/no-invite-detector.js';
import { RecipeGenerator, type LlmFn } from './backends/recipe-generator.js';
import {
  prepareRecipeForMaestro,
  injectAceEnvVars,
  getActiveSelectorMapMetadata,
  resolveActiveSelectorMapId,
  resolveStaticRecipesDir,
  isStaticRecipesDirOverride,
  INSTALLED_STATIC_RECIPES_DIR,
  STATIC_RECIPES_DIR_ENV,
  loadSelectorTypes,
} from './recipe-resolver.js';
import { lintRecipeText } from './recipe-lint.js';
import { validateRecipeFreshness } from '../../lib/recipe-provenance.js';
import { resolveBackend, preflightMobileBackend } from './backend-toggle.js';
import type {
  AvdInfo, ApkInfo, RecipeRunResult, TestUserRegistrationResult, UiDumpResult,
  SnapshotResult, DeviceUserStateClass, DeviceStateHealLog, LocalBootstrapConfig,
  TestUserCredentials, EnsureAvdRunningOptions,
  VideoArtifact, LocalDiagnostics, DeviceProbeFailures, RunRecipeOptions,
  MaestroDriverProbeResult, ThrownRecipePartial,
} from './types.js';
import { logInfo } from './logging.js';
import {
  dispatchOutputDir,
  resetScreenshotDir,
  explainScreenshotDirFailure,
} from './screenshot-dir.js';
import { runRecipeWithDriverHeal } from './maestro-driver-retry.js';
import {
  buildProvenance,
  getAceVersion,
  getGitSha,
  newDispatchId,
  writeProvenanceSidecar,
} from '../../lib/screenshot-provenance.js';
import {
  describeOppCollision,
  detectOppCollisions,
  resolveSessionOppContext,
} from '../../lib/session-opp-collision.js';
import { listLiveSessionLocks, updateSessionLockContext } from './session-lock.js';
import {
  recorderConfigFromEnv,
  startRecording,
  stopRecording,
} from './screen-recorder.js';
import { clearSpool, listSpooled, spoolDir,
  countSpooledEntries, spoolVideo } from './video-spool.js';

/**
 * Return shape of the dual-mode `mobile_diagnose` atom
 * (dimagi-internal/ace#961). Discriminate on `backend`:
 *
 *   const d = await client.diagnose();
 *   if (d.backend === 'local') d.adb_server_port;      // 5039, typically
 *   else                       d.runner_service_state; // cloud in-VM state
 *
 * The union lives here rather than in `types.ts` because `types.ts` is
 * deliberately backend-agnostic and does not import `CloudDiagnostics`.
 */
export type MobileDiagnostics =
  | LocalDiagnostics
  | ({ backend: 'cloud' } & CloudDiagnostics);

/**
 * Screen-recorder seam. Injected only by tests; production binds the real
 * `screen-recorder.ts` functions.
 */
export interface RecorderHooks {
  start: typeof startRecording;
  stop: typeof stopRecording;
}

/**
 * Video-spool seam. Injected only by tests; production binds the real
 * `video-spool.ts` functions.
 *
 * This exists for the same reason `recorder` does, and its absence had a
 * concrete cost: `spoolVideo(v)` with no options resolves the REAL
 * `os.homedir()` and the REAL `process.ppid`, so the unit suite wrote
 * 5-byte "VIDEO" files into the developer's own `~/.ace/mobile-videos/`,
 * one ppid directory per `npm test`. `video-spool.test.ts` already avoids
 * that via its `homeDir` override; the client had no equivalent.
 */
export interface SpoolHooks {
  video: typeof spoolVideo;
  list: typeof listSpooled;
  clear: typeof clearSpool;
  dir: typeof spoolDir;
  /** Total entries the wipe will remove — see `countSpooledEntries`. */
  count: typeof countSpooledEntries;
}

export interface MobileClientOpts {
  avd?: AvdBackend;
  maestro?: MaestroBackend;
  cloud?: CloudBackend;
  /**
   * Static palette dir. When omitted, resolved via
   * `resolveStaticRecipesDir()` — which honours
   * `ACE_MOBILE_STATIC_RECIPES_DIR` and otherwise returns the palette
   * shipped in this install. Whatever this resolves to is ALSO what
   * `prepareRecipeForMaestro` uses (the client passes it through), so
   * the two resolution paths cannot diverge (jjackson/ace#1062).
   */
  staticRecipesDir?: string;
  /**
   * Root under which `registerTestUser` creates its scratch
   * `ace-mobile-reg-<rand>` directory. Defaults to `os.tmpdir()`.
   *
   * This exists so the tempdir-lifecycle tests can assert on a directory
   * only they write to. They used to diff the GLOBAL `os.tmpdir()` for
   * `ace-mobile-reg-*` and assert the delta was empty, which any
   * concurrent registration — another live ACE session, another vitest
   * worker — falsified. Same class as the `~/.ace` sharing in ace#1883.
   * ace#1942.
   */
  regTmpRoot?: string;
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
  /**
   * Optional override for the on-device screen recorder (testing only).
   * Default binds the real `screen-recorder.ts` start/stop functions.
   */
  recorder?: RecorderHooks;
  /**
   * Optional override for the per-session video spool (testing only).
   * Default binds the real `video-spool.ts` functions, which resolve the
   * real home dir + ppid — inject a fake in tests so the suite never
   * writes into `~/.ace/mobile-videos/`.
   */
  spool?: SpoolHooks;
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

/**
 * Merge a PARTIAL per-call test-user override onto the env-derived credentials
 * (dimagi-internal/ace#1289).
 *
 * **Inertness is the contract, and it is stronger than "equivalent":** with no
 * override — the production default while `ACE_PER_RUN_TEST_USER` is off — this
 * returns the `base` object BY REFERENCE. Not a copy, not a spread. There is no
 * code path in which an absent override can perturb what gets registered.
 *
 * Only keys whose value is a non-empty string override. An empty string from a
 * caller that read an unset env var must not blank out a working credential —
 * the same "caller args still win when present" rule
 * `mobile_register_test_user` already applies, for the same reason (a blank
 * pass there produced a server-side "Request validation failed" with no
 * field-level detail).
 */
export function mergeTestUserOverride(
  base: TestUserCredentials,
  override?: Partial<TestUserCredentials>,
): TestUserCredentials {
  if (!override) return base;
  const merged = { ...base };
  for (const key of Object.keys(base) as (keyof TestUserCredentials)[]) {
    const v = override[key];
    if (typeof v === 'string' && v.length > 0) merged[key] = v;
  }
  return merged;
}

/**
 * The selector-map APK version that recipe resolution targets.
 *
 * Reads `ACE_CONNECT_APK_VERSION` (the same env var that pins the APK
 * download in `runLocalBootstrap`), falling back to `2.63.2` when unset
 * or empty so the default tracks the validated baseline. Bump the
 * default here in lockstep with the `.env.tpl` default when a new
 * selector baseline is verified and promoted.
 *
 * 2.63.2 promoted 2026-07-25 after a live drift check on ACE_Pixel_API_34
 * (see the header of `selectors/connect-2.63.2.yaml`). NOTE: pin only
 * PUBLISHED releases — at time of writing `commcare_2.63.3` exists as a
 * GitHub DRAFT with no assets, so pinning it fails the download outright.
 */
export const DEFAULT_APK_VERSION = '2.63.2';
export function getConfiguredApkVersion(): string {
  const v = process.env.ACE_CONNECT_APK_VERSION;
  return v && v.length > 0 ? v : DEFAULT_APK_VERSION;
}

/**
 * Palette dir this client resolves to when `opts.staticRecipesDir` is
 * omitted. Deliberately a FUNCTION call rather than a module-level const:
 * `resolveStaticRecipesDir` reads `ACE_MOBILE_STATIC_RECIPES_DIR` (and
 * validates it), so evaluating it per-construction is what makes a bare
 * `new MobileClient()` — including `mcp/mobile-server.ts`'s — honour the
 * override. See `recipe-resolver.ts § resolveStaticRecipesDir`
 * (jjackson/ace#1062).
 */
export { INSTALLED_STATIC_RECIPES_DIR, STATIC_RECIPES_DIR_ENV };

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
/**
 * True when a logcat excerpt shows CommCare dying with an uncaught exception.
 *
 * Deliberately narrow, and the narrowness is load-bearing — the obvious
 * implementation is wrong. Matching `FATAL EXCEPTION|AndroidRuntime` anywhere
 * and `org.commcare.dalvik` anywhere in the same buffer FALSE-POSITIVES on a
 * perfectly healthy device: `adb logcat -d` carries benign `D/I AndroidRuntime`
 * startup lines from every `uiautomator dump` (uid 2000, "Calling main entry
 * ... uiautomator.Launcher"), and the CommCare package name appears all over an
 * ordinary buffer. Caught live on ACE_Pixel_API_34, 2026-07-26, against a device
 * with no crash at all.
 *
 * So: require the real fatal marker (`FATAL EXCEPTION`, which Android only
 * emits for an uncaught throwable), and require `org.commcare.dalvik` to appear
 * in the crash block itself — the `Process: <pkg>` line Android prints
 * immediately under the marker — not somewhere else in the buffer. An unrelated
 * system-app crash on a busy emulator therefore can't halt a Phase 6 dispatch.
 *
 * Pure: the caller supplies the excerpt so this stays unit-testable.
 */
export function detectAppCrashLoop(logcat: string): boolean {
  const lines = logcat.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/FATAL EXCEPTION/.test(lines[i])) continue;
    // Android's crash block puts `Process: <pkg>, PID: <n>` within a line or
    // two of the marker. Scan a small window rather than the whole buffer.
    const block = lines.slice(i, i + 4).join('\n');
    if (/org\.commcare\.dalvik/.test(block)) return true;
  }
  return false;
}

/**
 * Pull the first exception line + a couple of stack frames out of a crash
 * logcat excerpt, for the error message. Keeps the funnel's output actionable
 * without dumping kilobytes of log into a subagent return.
 */
export function summarizeCrash(logcat: string): string | undefined {
  const lines = logcat.split('\n');
  const idx = lines.findIndex((l) => /FATAL EXCEPTION/.test(l));
  if (idx === -1) return undefined;
  return lines
    .slice(idx, idx + 5)
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' | ')
    .slice(0, 400);
}

/**
 * Detect the "another automation client holds the device" failure.
 *
 * Android permits exactly ONE `UiAutomation` client per device. When a second
 * one attaches — a concurrent Maestro run, a sibling ACE session's
 * `uiautomator dump`, an IDE inspector — the loser fails to acquire the
 * singleton and `uiautomator dump` never writes `window_dump.xml`. The
 * stack is unmistakable and lands in `logcat -b crash`:
 *
 *   com.android.commands.uiautomator.DumpCommand.run(DumpCommand.java:78)
 *     at android.app.UiAutomation.connectWithTimeout(UiAutomation.java:381)
 *     at UiAutomationConnection.registerUiTestAutomationServiceLocked(:576)
 *   java.lang.RuntimeException: Bad file descriptor
 *
 * Narrow on purpose, same discipline as `detectAppCrashLoop`: match the two
 * frames that only appear when the singleton acquisition itself failed, not
 * the bare string "UiAutomation" (which shows up in ordinary uiautomator
 * startup chatter on a perfectly healthy device).
 *
 * Pure: caller supplies the excerpt so this stays unit-testable. ace#1155.
 */
export function detectUiAutomationFailure(logcat: string | undefined): boolean {
  if (!logcat) return false;
  return (
    /UiAutomation\.connectWithTimeout|UiAutomation\.connect\b/.test(logcat) ||
    /registerUiTestAutomationServiceLocked/.test(logcat)
  );
}

/**
 * Render the adb-server contention hint (ace#1155, the "optional but
 * valuable" half).
 *
 * Cross-session contention on a shared device is structurally invisible from
 * inside one session: each session talks to its OWN adb server, so a sibling
 * session's uiautomator client simply does not appear anywhere in this
 * session's view. Naming it in the failure text is the only way the operator
 * learns the device is shared.
 *
 * Pure: takes the already-gathered `{port, sees}` observations. Returns
 * undefined when there is nothing worth saying (0 or 1 attached server).
 */
export function describeAdbServerContention(
  serial: string,
  serversSeeingSerial: number[],
): string | undefined {
  if (serversSeeingSerial.length < 2) return undefined;
  const ports = [...serversSeeingSerial].sort((a, b) => a - b).join(', ');
  return (
    `${serversSeeingSerial.length} adb servers (ports ${ports}) are attached to ${serial} — ` +
    `another session is very likely driving this device. Android allows ONE UiAutomation ` +
    `client at a time; kill the competing client rather than re-bootstrapping this one.`
  );
}

/**
 * One-line rendering of what the probe could NOT observe, for the
 * `ui_dump_signal` field on a probe-failure classification.
 *
 * The point is that the signal on a failure class must describe the FAILURE,
 * never a screen reading — `pickStateSignal` on an empty dump happily returns
 * something screen-shaped, which is exactly the confident-and-wrong output
 * ace#1155 is about.
 */
export function describeProbeFailures(failures: DeviceProbeFailures): string {
  const parts: string[] = [];
  if (failures.deviceUnreachable) parts.push('no-device-on-probe-adb-server');
  if (failures.packageQueryFailed) parts.push('pm-list-packages-errored');
  if (failures.uiDumpFailed) parts.push('uiautomator-dump-produced-no-xml');
  return parts.length ? parts.join(',') : 'none';
}

/**
 * Render the parenthetical that `registerTestUser` appends to a part-B
 * failure, given what the post-failure probe managed to observe.
 *
 * The old text was a single fixed string ending *"— not 'ready', so this is a
 * real registration failure not recipe flakiness"*, appended regardless of
 * class. On `hh-poverty-targeting/20260730-2210` that shipped a certainty the
 * probe had not earned: the probe had observed nothing at all, and the
 * sentence sent two investigations at re-bootstrapping and reinstalling a
 * healthy device. A probe that failed must say it failed; only a probe that
 * SAW the device may draw a conclusion from what it saw.
 *
 * ace#1155. Pure so the wording is pinned by a test.
 */
export function postFailureProbeVerdict(
  cls: DeviceUserStateClass,
  signal: string | undefined,
): string {
  const head = `(post-failure device probe: classified_as=${cls}, signal=${signal ?? 'none'}`;
  if (cls === 'device-unreachable' || cls === 'probe-failed') {
    return (
      `${head} — the probe itself did NOT complete, so this says NOTHING about ` +
      `whether registration failed or what state the device is in. Do not treat it ` +
      `as evidence for reinstalling or re-registering anything; fix the probe path first.)`
    );
  }
  if (cls === 'uiautomation-unavailable') {
    return (
      `${head} — Android's single UiAutomation slot could not be acquired, so the ` +
      `screen was never read. The likely cause is ANOTHER automation client holding ` +
      `the device (a concurrent Maestro/uiautomator run, typically a sibling session ` +
      `on this host). Remediation is to kill the competing client — NOT to reinstall ` +
      `CommCare or re-run the bootstrap.)`
    );
  }
  if (cls === 'unknown') {
    return (
      `${head} — no known marker matched. The probe ran but could not classify the ` +
      `device, so this is inconclusive rather than a confirmed registration failure.)`
    );
  }
  return `${head} — not 'ready', so this is a real registration failure not recipe flakiness)`;
}

/**
 * Classify the device's user-facing state from the probe's observations.
 *
 * **`installedPackages: null` means the query FAILED, not "no packages".**
 * That distinction is the whole point of ace#1155: `pm list packages` erroring
 * used to degrade to `[]`, which the first line of this function read as a
 * confident "CommCare is absent". On hh-poverty-targeting/20260730-2210 that
 * produced `classified_as=commcare-not-installed` — twice, reproducibly — on a
 * device where CommCare was installed, booted, and sitting on
 * `PersonalIdActivity`, and the label sent the investigation at reinstalling
 * the app while the real fault was UiAutomation contention. A class that names
 * a concrete checkable thing is the one most likely to be believed, so it must
 * never be reachable without a successful query behind it.
 */
export function classifyDeviceUserState(
  focusedActivity: string,
  uiDumpXml: string,
  installedPackages: string[] | null,
  crashLogcat?: string,
  probeFailures: DeviceProbeFailures = {},
): DeviceUserStateClass {
  // Nothing was observed at all — every downstream signal is vacuous.
  if (probeFailures.deviceUnreachable) return 'device-unreachable';

  // Package state UNKNOWN. Report what we don't know; never a package claim.
  if (installedPackages === null || probeFailures.packageQueryFailed) {
    // When the automation layer is what broke, say so — `uiautomation-
    // unavailable` is strictly more actionable than `probe-failed` (kill the
    // competing client vs. "something went wrong").
    if (detectUiAutomationFailure(crashLogcat)) return 'uiautomation-unavailable';
    return 'probe-failed';
  }

  if (!installedPackages.some((p) => p === 'org.commcare.dalvik')) {
    return 'commcare-not-installed';
  }
  // A crash-loop outranks EVERY screen-based signal, because it destroys the
  // premise those signals rest on: an app dying with an uncaught exception
  // restarts back at the first-start splash, so the screen reports
  // `needs-app-config` (and, before ace#950's disambiguation, reported
  // `needs-personal-id`) no matter how healthy registration actually is.
  //
  // That's not a hypothetical ordering argument — it is exactly what ace#938
  // cost: PersonalID registration had SUCCEEDED, CommCare 2.63.0 was
  // crash-looping on an NPE in the jobs-list parser, and the funnel's verdict
  // sent several recovery rounds at re-registration. Registration kept
  // "succeeding" and kept getting wiped by the next crash. The one signal that
  // would have named the real fault — FATAL EXCEPTION, twice, with a clean
  // stack — was sitting in logcat the entire time and was never read.
  //
  // Recovery routing consequence: this class must NOT be treated as healable
  // by re-running the bootstrap. The remediation is an APK/app-side fix (in
  // #938's case, moving the baseline off 2.63.0), so the funnel throws with
  // the stack rather than burning retries.
  if (crashLogcat && detectAppCrashLoop(crashLogcat)) {
    return 'app-crash-looping';
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
  // No positive registered signal + first-start markers = the app-install
  // setup screen, which is `needs-app-config` — NOT `needs-personal-id`.
  //
  // These two were collapsed onto `needs-personal-id` because the recovery
  // is the same (tier-2 bootstrap re-registers either way). That collapse
  // cost real debugging time in dimagi-internal/ace#938/#950: CommCare was
  // crash-looping back to the first-start splash, whose "Enter Code" tile is
  // the APP-INSTALL-by-code control — nothing to do with the PersonalID
  // enter-code screen. The funnel reported `needs-personal-id`, which sent
  // the investigation at registration (registration was fine), while the
  // real signal — a FATAL EXCEPTION in logcat — was never surfaced.
  //
  // Recovery routing is unchanged: `restoreDeviceUserState` only branches on
  // `ready` / `unknown`, so both classes still throw DeviceUserStateError.
  // What changes is that the error now names the right surface.
  if (/CommCareSetupActivity/i.test(focusedActivity)) {
    return 'needs-app-config';
  }
  if (/Enter Code|Scan Application Barcode|Welcome to CommCare/i.test(uiDumpXml)) {
    return 'needs-app-config';
  }
  // Deliberately LAST, after every dumpsys-derived signal. `focusedActivity`
  // comes from `dumpsys`, which is independent of UiAutomation — so a device
  // whose uiautomator is contended can still legitimately classify `ready` or
  // `needs-app-config` above, and that answer is better than a contention
  // report. What this replaces is the useless `unknown`: when the ONLY reason
  // we have no screen signal is that the dump never happened, say that
  // instead of shrugging. ace#1155.
  if (probeFailures.uiDumpFailed || detectUiAutomationFailure(crashLogcat)) {
    return 'uiautomation-unavailable';
  }
  return 'unknown';
}


/**
 * Rewrite the registration steps in a bootstrap-step list to their
 * `-unverified` form (dimagi-internal/ace#1067).
 *
 * A heal log's `bootstrap_steps` is read by operators and skills as a record
 * of what the funnel ACHIEVED. `registered` / `register-already` are emitted
 * purely because `registerTestUser` returned — that is a record of a CALL, not
 * of a confirmed device state. When nothing subsequently confirmed the device
 * is registered, the honest step name says so, so a caller can't read
 * `bootstrap_steps: [..., "registered"]` alongside `verified_as: "unknown"`
 * and conclude the device is ready. (It did exactly that, and burned a full
 * recipe cycle discovering otherwise.)
 *
 * This is the single source of truth for that vocabulary — both the local
 * funnel (which downgrades only when its post-bootstrap probe couldn't
 * confirm) and the cloud funnel (which never verifies at all) route through
 * it, so the two backends can't drift into describing the same uncertainty
 * with different words.
 */
export function markRegistrationUnverified(steps: string[]): string[] {
  return steps.map((st) =>
    st === 'registered' || st === 'register-already' ? `${st}-unverified` : st,
  );
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
    // "Enter Code" here is `enter_app_location` — the INSTALL-APP-BY-CODE
    // tile on the first-start splash, NOT the PersonalID enter-code screen.
    // The old bare `screen:enter-code` label conflated the two and sent the
    // #938 investigation at registration for far too long (ace#950).
    [/Enter Code/i, 'screen:first-start-install-tile(Enter Code, NOT PersonalID)'],
    [/Scan Application Barcode/i, 'screen:first-start-scan-barcode'],
    [/Welcome to CommCare/i, 'screen:first-start-welcome'],
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
  /** Root for `registerTestUser` scratch dirs. See MobileClientOpts.regTmpRoot (ace#1942). */
  readonly regTmpRoot: string;
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
  private readonly recorder: RecorderHooks;
  private readonly spool: SpoolHooks;
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
    this.staticRecipesDir = opts.staticRecipesDir ?? resolveStaticRecipesDir();
    this.regTmpRoot = opts.regTmpRoot ?? os.tmpdir();
    // `bootstrapConfig: null` (explicit) disables auto-bootstrap;
    // `undefined` (omitted) reads from env; non-null override wins.
    this.bootstrapConfig =
      opts.bootstrapConfig === undefined ? bootstrapConfigFromEnv() : opts.bootstrapConfig;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.recorder = opts.recorder ?? { start: startRecording, stop: stopRecording };
    this.spool = opts.spool ?? {
      video: spoolVideo,
      list: listSpooled,
      clear: clearSpool,
      dir: spoolDir,
      count: countSpooledEntries,
    };
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
  async ensureAvdRunning(name: string, opts?: EnsureAvdRunningOptions): Promise<AvdInfo> {
    // Pre-boot backend preflight (jjackson/ace#839): fail loud on an
    // unconfigured cloud toggle, or note a likely dispatch/session mismatch,
    // BEFORE booting any local AVD. Purely a check over the resolved backend
    // + cloud-config presence — no I/O, no state change. Runs first so a
    // wrong local boot on a shared host can't squat a busy emulator port
    // before the misconfiguration surfaces.
    const preflight = preflightMobileBackend({
      resolved: resolveBackend(),
      cloudConfigured: this.cloud !== null,
    });
    if (preflight.fatal) {
      throw new MobileError(
        preflight.fatal.code,
        preflight.fatal.message,
        preflight.fatal.remediation,
      );
    }
    if (preflight.note) {
      logInfo(`ensure_avd_running: ${preflight.note}`);
    }

    // ace#1821, visibility half. Two sessions on ONE OPPORTUNITY is a different
    // resource conflict from two sessions on one AVD, and it gets a different
    // answer. The device conflict is a hard failure the session cannot survive,
    // so `AvdContendedError` throws. This one is a choice the operator is
    // entitled to make — their words: "that's an error I can live with since it
    // would be my own fault" — so it WARNS and proceeds, always. A refusal here
    // would block a deliberate act on evidence that is structurally incomplete:
    // `~/.ace/sessions` is per-$HOME, so a second macOS account's sessions are
    // unreadable (which is why `lib/mobile-contention.ts` reads `ps` instead),
    // and `ps` cannot see an opp slug. Absence of a collision is not evidence
    // of absence, and you must not gate on evidence that can only under-report.
    //
    // Named, not merely counted: pid + run + AVD is enough to find the other
    // window. Runs before the boot so the operator sees it while there is still
    // time to stop.
    const oppCtx = resolveSessionOppContext(
      { opp_slug: opts?.oppSlug, run_id: opts?.runId },
      process.env,
    );
    if (oppCtx.opp_slug) {
      try {
        const collisions = detectOppCollisions(
          { mcp_pid: process.pid, opp_slug: oppCtx.opp_slug },
          listLiveSessionLocks(),
        );
        const msg = describeOppCollision(oppCtx.opp_slug, collisions);
        if (msg) console.warn(`[ace-mobile] ensure_avd_running: ${msg}`);
      } catch {
        /* the warning is best-effort — it must never be able to fail a boot */
      }
    }

    if (this.useCloud) {
      // Per-run test-user overrides are LOCAL-ONLY (dimagi-internal/ace#1289).
      // The cloud backend registers inside the AMI from its own baked recipes,
      // so honouring an override here would need `ACE_MOBILE_CLOUD_LIVE_REGISTER=true`
      // AND an ace-web change to forward caller-supplied credentials. Throw
      // rather than silently register the env-derived user under a caller that
      // believes it minted a fresh one — a silent fallback would reintroduce
      // the accumulated-invite class the override exists to close.
      if (opts?.testUser) {
        throw new MobileError(
          'CLOUD_TEST_USER_OVERRIDE_UNSUPPORTED',
          'mobile_ensure_avd_running: per-run testUser overrides are not supported on the cloud backend — ' +
            'registration happens inside the AMI from its baked recipes, which do not accept ' +
            'caller-supplied credentials.',
          'Run on the local AVD backend (/ace:mobile-backend local), or land ' +
            'ACE_MOBILE_CLOUD_LIVE_REGISTER=true plus ace-web support for caller-supplied ' +
            'registration credentials first.',
        );
      }
      const info = await this.requireCloud().ensureAvdRunning(name);
      // Symmetric with the local branch — drive registration through
      // `restoreDeviceUserState` so the same contract holds across
      // backends: *after this method returns, the device is at the
      // Connect home, signed in as the test user*.
      //
      // The cloud branch of `restoreDeviceUserState` dispatches to
      // `cloudBootstrapHeal` when `ACE_MOBILE_CLOUD_LIVE_REGISTER=true`
      // (the post-Phase-D AMI default), otherwise returns the legacy
      // `{ attempted: false }` stub — preserving behavior for any
      // deployment that's still riding the pre-Phase-D AMI's pre-baked
      // demo user. Pre-2026-05-26 this method short-circuited with the
      // stub unconditionally, which silently left the cloud AVD
      // unregistered on every fresh-AMI boot and forced operators to
      // run `/ace:mobile-bootstrap` by hand mid-`/ace:run`.
      const deviceUserState = await this.restoreDeviceUserState(info);
      return { ...info, heal: { deviceUserState } };
    }
    // Bounded retry over the WHOLE idempotent funnel (cold-boot → driver
    // assert → restore/register). The driver readiness probe
    // (`assertMaestroDriverHealthy`) can pass and the gRPC channel then drop
    // on the very first `deviceInfo` of the registration recipe — a transient
    // boot→driver→recipe handoff race (jjackson/ace#589). The agent's only
    // recovery was to re-dispatch this exact funnel, so we do it here instead
    // of surfacing a typed throw. Cold-boot is idempotent (kill + `-wipe-data`
    // + re-register), so a re-run is safe. Only the boot-race signature
    // triggers the retry; any other failure throws on the first attempt.
    const MAX_FUNNEL_ATTEMPTS = 2;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_FUNNEL_ATTEMPTS; attempt++) {
      try {
        const info = await this.avd.ensureAvdRunning(name);
        // Stamp the lock with what we now know (ace#1821). Deliberately AFTER
        // the boot, and a merge rather than a rewrite: the ports in that file
        // are what the reaper matches against `lsof`, and re-recording the lock
        // from here — which does not know them — would strand real daemons.
        //
        // `info.name`, not `name`: `selectAvd` may have switched us onto a
        // different pool member, and the lock should say which device is
        // actually held. That also fills in `avd_name`, which has been in the
        // SessionLock schema and printed by `bin/ace-mobile-reap` since it
        // landed, and has never once been written — the only `recordSessionLock`
        // call site omits it, so every lock on every host reads `avd=?`.
        updateSessionLockContext(process.pid, { ...oppCtx, avd_name: info.name });
        await this.assertMaestroDriverHealthy(info.serial);
        const deviceUserState = await this.restoreDeviceUserState(info, opts);
        return { ...info, heal: { deviceUserState } };
      } catch (e) {
        lastErr = e;
        if (attempt < MAX_FUNNEL_ATTEMPTS && isTransientBootRaceError(e)) {
          logInfo(
            `ensure_avd_running: transient boot-race on attempt ${attempt}/${MAX_FUNNEL_ATTEMPTS} ` +
              `(${e instanceof Error ? e.message.split('\n')[0] : String(e)}); ` +
              `re-running the cold-boot funnel`,
          );
          continue;
        }
        throw e;
      }
    }
    // Unreachable: the loop either returns or throws. Satisfies the type checker.
    throw lastErr;
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
  async restoreDeviceUserState(
    avd: AvdInfo,
    opts?: EnsureAvdRunningOptions,
  ): Promise<DeviceStateHealLog> {
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
    const bootstrapSteps = await this.runLocalBootstrap(avd, opts);
    const verifyAfterBootstrap = await this.probeDeviceUserState(avd);
    if (
      verifyAfterBootstrap.classified_as === 'ready' ||
      verifyAfterBootstrap.classified_as === 'unknown'
    ) {
      logInfo(
        `device_user_state: restored to ${verifyAfterBootstrap.classified_as} via local-bootstrap on ${avd.serial}`,
      );
      // Never report a step we did not CONFIRM (dimagi-internal/ace#1067).
      // `registered` was previously emitted purely because
      // `registerTestUser` returned, so a heal log could read
      // `bootstrap_steps: [... "registered"]` alongside
      // `verified_as: "unknown"` — asserting the very thing it failed to
      // verify. Callers read that as "device is fully ready" and burn a
      // whole recipe cycle discovering otherwise.
      //
      // NOTE ON THE ISSUE'S ASK #2. #1067 also asks that
      // `verified_as: "unknown"` stop returning success at all. It must
      // NOT: `unknown` is the ORDINARY post-bootstrap classification on a
      // healthy device — the run that live-validated #1058 (claim leg,
      // `STATUS: pass exit 0`) logged `restored to unknown via
      // local-bootstrap` immediately before passing. Throwing there would
      // fail working runs, so the honest fix is to stop OVERCLAIMING in
      // the log rather than to start rejecting a legitimate state.
      const confirmed = verifyAfterBootstrap.classified_as === 'ready';
      const reportedSteps = confirmed
        ? bootstrapSteps
        : markRegistrationUnverified(bootstrapSteps);
      if (!confirmed) {
        logInfo(
          `device_user_state: post-bootstrap probe could not confirm readiness on ${avd.serial} ` +
            `(classified_as=unknown, signal=${verifyAfterBootstrap.ui_dump_signal ?? 'none'}) — ` +
            `reporting 'registered-unverified'. This is normal on a healthy device; it is NOT a claim that registration succeeded.`,
        );
      }
      return {
        classified_as: verifyAfterBootstrap.classified_as,
        attempted: true,
        healed_via: 'local-bootstrap',
        verified_as: verifyAfterBootstrap.classified_as,
        focused_activity: verifyAfterBootstrap.focused_activity,
        ui_dump_signal: verifyAfterBootstrap.ui_dump_signal,
        bootstrap_steps: reportedSteps,
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
    const failures: DeviceProbeFailures = {};
    // `null`, NOT `[]` (dimagi-internal/ace#1155). `[]` is a legitimate
    // answer meaning "queried fine, CommCare absent"; a thrown query means
    // we do not know. Collapsing the two produced two consecutive
    // `commcare-not-installed` verdicts against a device with CommCare
    // installed, booted, and foregrounded.
    const packages = await this.avd
      .listPackages(avd.name, 'org.commcare.dalvik')
      .catch((e: unknown) => {
        // `requireRunningAvd` throws AvdBootError when this probe's OWN adb
        // server sees no device — that is `device-unreachable`, a strictly
        // stronger statement than "the query failed".
        if (e instanceof AvdBootError) failures.deviceUnreachable = true;
        else failures.packageQueryFailed = true;
        return null;
      });
    const focused = await this.avd
      .getFocusedActivity(avd.name)
      .catch(() => '');
    const dump = await this.avd
      .captureUiDump(avd.name)
      .catch(() => ({ xml: '', elements: [], failed: true } as UiDumpResult));
    if (dump.failed) failures.uiDumpFailed = true;
    // Diagnostic-only: a logcat we can't read degrades to "no crash
    // detected", never to a probe failure. See readCrashLogcat.
    const crashLog = await this.avd.readCrashLogcat(avd.name).catch(() => '');

    const cls = classifyDeviceUserState(focused, dump.xml, packages, crashLog, failures);
    // When the crash probe is what decided the class, the stack IS the
    // signal — surfacing "screen:first-start-welcome" here instead would
    // reproduce the exact ace#938 misdirection this probe exists to prevent.
    let signal: string | undefined;
    if (cls === 'app-crash-looping') {
      signal = summarizeCrash(crashLog) ?? 'crash:commcare-fatal-exception';
    } else if (
      cls === 'uiautomation-unavailable' ||
      cls === 'probe-failed' ||
      cls === 'device-unreachable'
    ) {
      // Same discipline for the probe-failure classes: the signal must name
      // WHAT WE COULD NOT DO, not a screen reading derived from a dump that
      // never happened. Append the cross-session contention hint when the
      // host actually has more than one adb server on this serial — that
      // condition is invisible from inside a single session and it is the
      // one that produces `uiautomation-unavailable`.
      const parts = [`probe:${describeProbeFailures(failures)}`];
      if (cls === 'uiautomation-unavailable') {
        const contention = await this.describeDeviceContention(avd.serial);
        if (contention) parts.push(contention);
      }
      signal = parts.join(' | ');
    } else {
      signal = pickStateSignal(focused, dump.xml);
    }
    return { classified_as: cls, focused_activity: focused, ui_dump_signal: signal };
  }

  /**
   * Best-effort cross-session contention report for a device serial
   * (dimagi-internal/ace#1155, the "optional but valuable" half).
   *
   * Each ACE session talks to its OWN adb server, so a sibling session's
   * uiautomator client is structurally invisible from inside this one. This
   * enumerates the adb servers listening on the host and asks each whether it
   * can see `serial`; two or more means the device is shared and the
   * remediation is to kill the competitor, not to re-bootstrap.
   *
   * Runs ONLY on the failure path and never throws — a diagnostic that can
   * die is worse than no diagnostic.
   */
  private async describeDeviceContention(serial: string): Promise<string | undefined> {
    if (process.platform === 'win32') return undefined;
    try {
      const ports = await this.avd.listAdbServerPortsSeeing(serial);
      return describeAdbServerContention(serial, ports);
    } catch {
      return undefined;
    }
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
  /**
   * Assert the device has VALIDATED internet, or throw a typed
   * `network-unreachable` error naming it (dimagi-internal/ace#1067).
   *
   * Reads Android's own ConnectivityService verdict rather than probing
   * ourselves. A network is marked `VALIDATED` only after the platform's
   * captive-portal HTTP probe succeeds, so this is TCP/HTTP-grounded.
   *
   * Deliberately NOT ping — see the caller for why ICMP is unusable on
   * QEMU user-mode networking.
   *
   * Fail-open on an unreadable dumpsys: this is a precondition CHECK, not
   * a capability we own. If `dumpsys connectivity` changes shape or the
   * shell errors we must not start blocking otherwise-healthy bootstraps
   * on our inability to parse it — the whole point is to convert a
   * confusing downstream failure into a clear one, never to invent a new
   * failure mode of its own.
   */
  private async assertDeviceNetworkValidated(avd: AvdInfo): Promise<void> {
    let out = '';
    try {
      const shell = this.avd.getAdbShell();
      const r = await shell('adb', ['-s', avd.serial, 'shell', 'dumpsys', 'connectivity'], {
        timeoutMs: 20_000,
      });
      out = `${r.stdout ?? ''}`;
    } catch {
      return; // unreadable → fail open, see doc comment
    }
    if (out.trim().length === 0) return; // fail open

    // ConnectivityService prints capabilities per network; a usable one
    // carries both INTERNET and VALIDATED.
    const hasValidated = /VALIDATED/.test(out);
    const hasInternet = /INTERNET/.test(out);
    if (hasValidated && hasInternet) return;

    throw new MobileError(
      'DEVICE_NETWORK_UNREACHABLE',
      `AVD ${avd.serial} has no VALIDATED internet connection (INTERNET=${hasInternet}, VALIDATED=${hasValidated}). ` +
        `Test-user registration walks the PersonalID phone-number screen, which fails with ` +
        `"No network connection. Please check your internet and try again." — surfacing later as a ` +
        `selector-not-found deep inside connect-register-from-otp rather than as a network fault.`,
      `Check the emulator's network: 'adb -s ${avd.serial} shell dumpsys connectivity'. ` +
        `A cold restart (mobile_stop_avd then mobile_ensure_avd_running) usually restores QEMU user-mode networking. ` +
        `Do NOT diagnose with ping — ICMP is unreliable on this NAT even when TCP/HTTPS work.`,
    );
  }

  async runLocalBootstrap(avd: AvdInfo, opts?: EnsureAvdRunningOptions): Promise<string[]> {
    if (!this.bootstrapConfig) {
      throw new MobileError(
        'NO_BOOTSTRAP_CONFIG',
        'runLocalBootstrap called without bootstrapConfig — env vars (ACE_E2E_* / ACE_CONNECT_APK_VERSION) are missing',
        'Run /ace:setup --force-env to re-inject .env from 1Password.',
      );
    }
    const { apkVersion } = this.bootstrapConfig;
    // Per-call credential override (dimagi-internal/ace#1289). With no `opts`
    // — the production default while ACE_PER_RUN_TEST_USER is off — this
    // returns the env-derived object ITSELF, unchanged and not even copied.
    const testUser = mergeTestUserOverride(this.bootstrapConfig.testUser, opts?.testUser);
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
      // VERIFY THE INSTALL, do not assume it (dimagi-internal/ace#1818).
      //
      // `installApk` reporting success is a record of a CALL, not of a
      // state — the same distinction #1067 forced on the `registered`
      // step below. On bednet-check-2-visit/20260828-0629 the bootstrap
      // proceeded from here to Step 3's registration recipe against an
      // AVD with ZERO third-party packages, and Maestro then burned the
      // full 600s chunk budget driving an app that did not exist. The
      // error named `connect-register-to-otp.yaml`, so triage went at the
      // recipe's selectors — four wrong diagnoses before the truth.
      //
      // A ~200ms `pm list packages org.commcare.dalvik` is the whole
      // difference between that and a typed error naming the cause.
      // `listPackages` THROWS on an unanswerable query rather than
      // returning an empty list (ace#1155), so an absence here is a real
      // observation, not a failed read.
      const afterInstall = await this.avd.listPackages(avd.name, 'org.commcare.dalvik');
      if (!afterInstall.includes('org.commcare.dalvik')) {
        throw new DeviceUserStateError('commcare-not-installed', [
          `apk-install:reported-success(${apkVersion})`,
          `verify:org.commcare.dalvik absent from \`pm list packages\` on ${avd.serial}`,
          'Refusing to run a registration recipe against a device with no CommCare app — ' +
            'that wedges Maestro for the full chunk budget and reports the RECIPE as the fault. ' +
            'Check AVD disk space, then rerun /ace:mobile-bootstrap.',
        ]);
      }
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

    // Step 2: apply the AVD environment baseline — BEFORE registration.
    //
    // Ordering is load-bearing and used to be wrong. The baseline ran at
    // "step 2.5", i.e. AFTER registerTestUser, which meant the one recipe
    // most exposed to a hostile environment ran in the un-baselined one.
    // That is not theoretical: on 2026-07-26 a cold boot put PersonalID's
    // "Enable Location Service" hard gate on screen (under a second,
    // stacked CommCare "Location Data Disabled" alert, which is why every
    // conditional in connect-register-from-otp reported SKIPPED and the
    // flow died on `rvJobList is visible`). The baseline enables the
    // location providers that clear that gate — but it ran too late to
    // help, every dispatch, by construction.
    //
    // Bundles:
    //   - location providers on (gps + network) — clears PersonalID's
    //     registration gate on a bare AOSP AVD
    //   - heads-up notifications off (PR #328 / 0.13.252) — AOSP AVDs
    //     periodically fire a touch-receptive Messages-app banner that
    //     steals the next Maestro tap mid-recipe
    //   - GMS DND-disallow (PR #328 / 0.13.252)
    //   - screen_off_timeout 30 min — prevents the AVD locking the
    //     screen mid-recipe (Maestro tap-on-locked-screen surfaces as a
    //     generic selector miss, costs ~10 min of recipe-debug time per
    //     occurrence)
    //   - default mock GPS fix for geopoint capture widgets
    //
    // Class-level fix — every smoke run on this AVD will hit one of
    // these sooner or later. Best-effort; idempotent; re-applied every
    // dispatch (the cold-boot wipes userdata.img, taking these settings
    // with it). Captures a fingerprint so telemetry can detect when an
    // AVD is running an older baseline.
    this.lastBaselineFingerprint = await this.avd
      .applyEnvironmentBaseline(avd.name)
      .catch(() => undefined);
    steps.push('environment-baseline-applied');

    // Step 2.5: assert the device actually has VALIDATED internet before
    // spending a registration walk on it (dimagi-internal/ace#1067).
    //
    // Registration cannot succeed without connectivity, and the failure
    // currently surfaces as a confusing selector-not-found deep inside
    // `connect-register-from-otp` — the Maestro screenshot named the real
    // cause ("No network connection. Please check your internet and try
    // again.") while the thrown error pointed at the `rvJobList` assert.
    // One typed error at the funnel boundary beats three steps of
    // misdirection.
    //
    // DELIBERATELY NOT PING. The emulator's QEMU user-mode network can
    // return 83-100% ICMP loss with duplicate replies, corrupt data bytes
    // and nonsense RTTs (`3955527499347845 ms`) while DNS and TCP/HTTPS
    // work perfectly — the Connect jobs list rendered five server-provided
    // tiles on exactly such a device. ICMP health is a red herring here.
    //
    // Android's ConnectivityService marks a network `VALIDATED` only after
    // its own captive-portal HTTP probe succeeds, so reading that flag is a
    // TCP/HTTP-grounded check with no extra round-trip of our own.
    await this.assertDeviceNetworkValidated(avd);

    // Step 3: register the test user. Demo users (+7426 prefix) skip
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

    // Dimagi has renamed the release asset at least three times:
    //   2.62.0        → `app-commcare-release.apk`
    //   2.63.0/2.63.1 → `commcare-<v>-release.apk`
    //   2.63.2+       → `commcare-<v>.apk`        (the `-release` suffix dropped)
    // Probe newest-convention-first and fall back, so both older pins and
    // future re-renames keep working without a code change. The 2.63.2
    // form was missing here until 2026-07-25, which made pinning 2.63.2
    // fail with APK_DOWNLOAD_FAILED even though the release was published.
    const baseUrl = `https://github.com/dimagi/commcare-android/releases/download/commcare_${version}`;
    const candidateUrls = [
      `${baseUrl}/commcare-${version}.apk`,
      `${baseUrl}/commcare-${version}-release.apk`,
      `${baseUrl}/app-commcare-release.apk`,
    ];
    let res: Awaited<ReturnType<typeof this.fetchImpl>> | undefined;
    let lastUrl = candidateUrls[0];
    for (const url of candidateUrls) {
      lastUrl = url;
      logInfo(`local_bootstrap: downloading CommCare ${version} from ${url}`);
      res = await this.fetchImpl(url);
      if (res.ok) break;
      logInfo(`local_bootstrap: ${url} returned HTTP ${res.status} — trying next filename`);
    }
    if (!res || !res.ok) {
      throw new MobileError(
        'APK_DOWNLOAD_FAILED',
        `CommCare APK download failed: HTTP ${res?.status} ${res?.statusText} from ${lastUrl} (tried ${candidateUrls.length} filename conventions)`,
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

    // Stage 0: is the driver even INSTALLED? ~50ms of `pm list packages`,
    // and it is what stops Stage 1 from short-circuiting the whole install
    // path on a device that has no driver at all (dimagi-internal/ace#1818).
    //
    // Why Stage 1 cannot answer this on its own: `probeDriver` runs
    // `maestro --host=localhost --port=<adbPort> hierarchy`, i.e. the
    // DIRECT-TCP dadb path keyed on a HOST port. A zero exit there proves
    // "something answered on localhost:<port>", not "the driver is present
    // on THIS serial" — and on a host running more than one emulator (two
    // macOS accounts each running ACE is the live case, ace#1819) those are
    // different claims. On bednet-check-2-visit/20260828-0629 the probe
    // returned `healthy: true` while `pm list packages | grep -i maestro`
    // was empty on the same serial minutes later; the early return skipped
    // Stage 1.5's install, and the bootstrap then drove a registration
    // recipe at a device with no gRPC server for the full 600s budget,
    // reporting the RECIPE as the fault.
    //
    // ace#1155 applies: a FAILED query is not a negative answer. When the
    // query cannot be answered (`queryOk: false`) we fall through to the
    // old probe-first behaviour rather than manufacturing an absence.
    const pkgs = await this.maestro.driverPackagesInstalled(serial);
    attempts.push(
      `packages-before:app=${pkgs.app},test=${pkgs.test}${pkgs.queryOk ? '' : ',query-failed'}`,
    );
    const knownAbsent = pkgs.queryOk && (!pkgs.app || !pkgs.test);
    if (knownAbsent) {
      logInfo(
        `maestro_driver: driver packages absent on ${serial} ` +
          `(dev.mobile.maestro=${pkgs.app}, dev.mobile.maestro.test=${pkgs.test}) — ` +
          `skipping the stage 1 liveness probe and installing directly`,
      );
    }

    // Stage 1: cheap probe. 20s budget covers the Maestro v2.x CLI's
    // JVM cold-start (~10-12s steady-state on a healthy AVD), measured
    // on v2.3.0 / Java 17 — the v1.39 budget of 8s ran shorter than v2's
    // first-invocation init and caused false-positive "unhealthy" verdicts
    // that triggered Stage 2 repair on a perfectly working driver
    // (malaria-itn-app/20260517-1829 trace: probe1 always shell-timed out
    // at 8s, full uninstall+reinstall ran, then probe2 hit the post-tear-down
    // gRPC bind race and surfaced UNAVAILABLE). See
    // docs/learnings/2026-05-19-maestro-v2-probe-timeout.md.
    let probe = knownAbsent
      ? { healthy: false, reason: 'skipped — driver packages absent on this serial' }
      : await this.maestro.probeDriver(adbPort, 20_000);
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
  async probeMaestroDriver(serial: string, timeoutMs: number = 8_000): Promise<MaestroDriverProbeResult> {
    const adbPort = AvdBackend.adbPortFromSerial(serial);
    if (adbPort === null) {
      return {
        healthy: false,
        reason: 'serial is not an emulator-NNNN (real-device probe not supported)',
        adbPort: null,
        portKind: null,
        driverPackages: null,
      };
    }
    // The port label, stated once so nobody has to re-derive it.
    //
    // `adbPort` is `adbPortFromSerial(serial)` — `emulator-5558` -> 5559 —
    // which is the EMULATOR'S OWN adbd port, the one Maestro dials on the
    // `Dadb.create(localhost, port)` direct-TCP path (see
    // `MaestroBackend.buildMaestroArgs`). It is NOT the adb SERVER port
    // that `mobile_diagnose` reports (allocated from 5037 upward by
    // `port-allocator.ts`). Both numbers are correct and they are not the
    // same kind of thing; seeing 5559 here next to 5040 there is expected,
    // and reading it as a contradiction cost a triage on
    // bednet-check-2-visit/20260828-0629. `portKind` makes the distinction
    // machine-readable instead of folklore (ace#1818).
    const portKind = 'emulator-adbd-direct-tcp' as const;

    // Assert the driver is actually INSTALLED before letting a zero exit
    // from `maestro hierarchy` stand in for health. ~50ms; turns
    // `healthy` from a guess into an observation. See
    // `assertMaestroDriverHealthy` Stage 0 for the full mechanism.
    const packages = await this.maestro.driverPackagesInstalled(serial);
    if (packages.queryOk && (!packages.app || !packages.test)) {
      const absent = [
        !packages.app ? 'dev.mobile.maestro' : null,
        !packages.test ? 'dev.mobile.maestro.test' : null,
      ]
        .filter(Boolean)
        .join(' + ');
      return {
        healthy: false,
        reason: `Maestro driver not installed on ${serial}: ${absent} absent from \`pm list packages\`. Run \`mobile_ensure_avd_running\` (or /ace:mobile-bootstrap) to install it — a passing \`maestro hierarchy\` on this host cannot prove the driver is present on THIS serial.`,
        adbPort,
        portKind,
        driverPackages: packages,
      };
    }
    const r = await this.maestro.probeDriver(adbPort, timeoutMs);
    if (!packages.queryOk) {
      // ace#1155: an unanswerable query is not an absence. Report the
      // liveness verdict, but say plainly that it is unverified.
      return {
        ...r,
        reason: [r.reason, 'driver package query failed — health verdict is UNVERIFIED']
          .filter(Boolean)
          .join('; '),
        adbPort,
        portKind,
        driverPackages: packages,
      };
    }
    return { ...r, adbPort, portKind, driverPackages: packages };
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
  /**
   * Set a mock GPS fix on the AVD (longitude-FIRST). Local-AVD only for
   * now — the cloud emulator backend has no location-set endpoint yet, so
   * a `cloud` session throws a clear `CLOUD_MOCK_LOCATION_UNSUPPORTED`
   * rather than silently no-op'ing. The local cold-boot baseline already
   * seeds DEFAULT_MOCK_LOCATION, so geopoint capture works without an
   * explicit call; use this to override with opp-specific coordinates.
   */
  setLocation(
    avdName: string,
    longitude: number,
    latitude: number,
    altitude?: number,
    satellites?: number,
  ): ReturnType<AvdBackend['setLocation']> {
    if (this.useCloud) {
      throw new MobileError(
        'CLOUD_MOCK_LOCATION_UNSUPPORTED',
        'mobile_set_location is not yet supported on the cloud emulator backend ' +
          '(no /api/mobile location-set endpoint). Run against the local AVD ' +
          '(ACE_MOBILE_BACKEND unset / =local), or add a cloud location-set route.',
      );
    }
    return this.avd.setLocation(avdName, longitude, latitude, altitude, satellites);
  }

  // ── Diagnostics + cloud-only admin ─────────────────────────────────
  //
  // `diagnose` is DUAL-MODE (dimagi-internal/ace#961): cloud returns the
  // in-VM `CloudDiagnostics`, local returns `LocalDiagnostics` (adb server
  // port + serial + device visibility on THAT port). Callers discriminate
  // on the `backend` field.
  //
  // `restartRunner` remains cloud-only — there is no local analogue of the
  // runner unit. When the active backend is local it throws a clear typed
  // error rather than silently no-op'ing, so a skill sees a signal instead of
  // an empty result. (`patchLaunchScript` was removed in ace#1113.)

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

  /**
   * Read-only diagnostic snapshot of whichever backend is active
   * (dimagi-internal/ace#961). Never boots, heals, or mutates.
   *
   *  - cloud → the in-VM `CloudDiagnostics` from `/api/mobile/diagnose`,
   *    tagged `backend: 'cloud'`.
   *  - local → `LocalDiagnostics`: the adb server port this session
   *    ACTUALLY allocated, the devices visible on that port, and the AVD
   *    behind them.
   *
   * Why local matters: the local backend probe-allocates its own adb server
   * (typically 5039), so a raw `adb devices` hits the default 5037, shows
   * nothing, and reads as a dead emulator. Before this the atom threw
   * `CLOUD_ONLY_OPERATION` on local, leaving the process table as the only
   * authoritative read.
   */
  async diagnose(): Promise<MobileDiagnostics> {
    if (this.useCloud) {
      return { backend: 'cloud', ...(await this.requireCloud().diagnose()) };
    }
    return this.avd.diagnose();
  }

  /** Cleanly restart the in-VM ace-mobile-runner unit. Cloud only. */
  restartRunner(opts: { waitForReady?: boolean } = {}): Promise<CloudDiagnostics> {
    return this.requireCloudOnly('mobile_restart_runner').restartRunner(opts);
  }

  /** Hot-patch the in-VM ace-emulator-launch script. Cloud only. */

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
   * body and screenshots are downloaded into this dispatch's output dir.
   *
   * `screenshotDir` is a run-scoped ROOT, not the literal output dir
   * (dimagi-internal/ace#1130). Artifacts land in
   * `<screenshotDir>/<recipeId>/` — always read them back from the
   * returned `screenshotsDir` / `screenshots[].path`. Callers MAY pass one
   * root for a whole phase: per-recipe namespacing is what makes it
   * impossible for one journey's start-of-run wipe (#756) to destroy
   * another journey's finished captures.
   */
  async runRecipe(
    recipePath: string,
    env: Record<string, string>,
    screenshotDir: string,
    avdName?: string,
    opts?: RunRecipeOptions,
  ): Promise<RecipeRunResult> {
    // The serial the recipe actually ran on, for provenance (ace#1396).
    let lastDeviceSerial: string | undefined;
    // Pre-flight: refuse to run if the recipe carries a provenance
    // header that doesn't match the current selector map. Closes the
    // stale-Drive-artifact class from
    // `docs/learnings/2026-05-14-phase6-validation-arc.md` (class-
    // level finding #1). Recipes without a header (static palette,
    // legacy generated recipes from before this contract) pass
    // through unchanged — `validateRecipeFreshness` returns ok=true
    // when no header is present.
    const apkVersion = getConfiguredApkVersion();
    try {
      const recipeText = fs.readFileSync(recipePath, 'utf8');
      const map = getActiveSelectorMapMetadata(apkVersion);
      const freshness = validateRecipeFreshness({
        recipeText,
        currentSelectorMapSha: map.sha,
        currentApkVersion: map.apkVersion,
      });
      if (!freshness.ok) {
        throw new StaleRecipeError(recipePath, freshness.reason, {
          provenance: freshness.provenance,
          current_selector_map_path: map.path,
          current_selector_map_sha: map.sha,
          current_apk_version: map.apkVersion,
        });
      }
    } catch (e) {
      if (e instanceof StaleRecipeError) throw e;
      // Recipe path unreadable or selector map missing — let the
      // downstream `prepareRecipeForMaestro` surface those with its
      // own error path. Don't mask a more useful error message.
    }

    // Pre-flight: LINT the recipe we are about to dispatch.
    //
    // `mobile_validate_recipe` runs this exact linter, and
    // `skills/app-test-cases` has instructed callers to run it since
    // 2026-06. That is prose, and prose relies on the caller choosing to
    // comply. On `spark-facilitator/20260820-0817` Phase 3 shipped a
    // `journey-deliver.yaml` carrying three violations the linter would
    // have named for free; nothing ran it, so the defects reached the
    // device and cost real dispatches to diagnose (ace#1690 gap 1).
    //
    // Linting HERE makes it structurally impossible for an unlinted
    // recipe to reach a device: the rule moves from something a skill
    // must remember into the boundary every dispatch already crosses.
    // Class-level preventer, per `CLAUDE.md § Conventions`.
    //
    // Verified safe to make a hard failure: all 22 recipes in the
    // shipped static palette lint clean against the live
    // `connect-2.63.2` map, so this rejects generated-recipe defects
    // without touching the palette. A lint failure is loud on purpose —
    // walking a recipe known to be malformed is what this replaces.
    {
      let recipeText: string | undefined;
      try {
        recipeText = fs.readFileSync(recipePath, 'utf8');
      } catch {
        // Unreadable path — `prepareRecipeForMaestro` owns that error.
        recipeText = undefined;
      }
      if (recipeText !== undefined) {
        // A missing or unparseable selector map must never turn a lint
        // pass into a hard failure: the map-aware rule abstains and
        // every text-only rule still runs. Same contract as
        // `mobile_validate_recipe`.
        let selectorTypes: Record<string, 'id' | 'text' | 'point'> | undefined;
        try {
          selectorTypes = loadSelectorTypes(apkVersion);
        } catch {
          selectorTypes = undefined;
        }
        const lint = lintRecipeText(recipeText, { selectorTypes });
        if (!lint.ok) {
          const first = lint.violations[0];
          throw new MobileError(
            'RECIPE_LINT_FAILED',
            `recipe lint failed for ${recipePath} ` +
              `[${first.rule}] line ${first.line}: ${first.detail}` +
              (lint.violations.length > 1
                ? ` (+${lint.violations.length - 1} more violation(s))`
                : ''),
            first.remediation,
            { recipe_path: recipePath, violations: lint.violations },
          );
        }
      }
    }

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
    // Resolves selector placeholders against the configured APK
    // version's selector map at `mcp/mobile/selectors/connect-<v>.yaml`.
    // Sources from `ACE_CONNECT_APK_VERSION` so opt-in QA against a new
    // baseline (e.g. 2.63.0) routes here without a code change. See
    // `getConfiguredApkVersion`.
    // `this.staticRecipesDir` is passed EXPLICITLY so the client's palette
    // dir and the resolver's are the same value by construction. Before
    // #1062 the resolver re-derived its own install-bound dir and silently
    // ignored the client's — the divergence that made a staged palette fix
    // read as a failed fix.
    const prep = await prepareRecipeForMaestro(recipePath, apkVersion, this.staticRecipesDir);
    if (prep.unverifiedSelectorsInTop.length > 0) {
      logInfo(
        `runRecipe: ${recipePath} uses unverified selectors ` +
          `${JSON.stringify(prep.unverifiedSelectorsInTop)} — proceeding, but ` +
          `recipe may halt at the first unverified-selector tap.`,
      );
    }

    // Generate fresh per-dispatch provenance up front so we can stamp
    // every PNG the backend writes. `recipeId` is the recipe filename
    // sans extension — stable across the resolved-temp-dir copy. See
    // `lib/screenshot-provenance.ts` for the shape; consumers (UX eval,
    // stale-carryover detection) compare `dispatch_id` against the
    // current dispatch's ID to detect leftover PNGs from prior runs.
    const recipeId = path.basename(recipePath).replace(/\.ya?ml$/, '');
    const dispatchId = newDispatchId();

    // Dispatch-scoped output namespace (dimagi-internal/ace#1130). The
    // caller passes a run-scoped ROOT; this dispatch owns
    // `<root>/<recipeId>/` and nothing else. Two different journeys
    // therefore cannot share an output dir even when handed the same
    // root, so the wipe below can only ever clear THIS recipe's own
    // prior output — the cross-journey destruction that lost a passing
    // Learn leg's screenshots + video on bednet-spot-check/20260731-1353
    // is unrepresentable now, without widening #1034's preserve-list
    // (which would re-open #756's stale-carryover class).
    const runDir = dispatchOutputDir(screenshotDir, recipeId);

    // Structural freshness guarantee (jjackson/ace#756): the screenshot
    // dir this dispatch reports must contain ONLY artifacts from THIS
    // execution. Stale PNGs from a prior run (or a prior session on a
    // shared runner) otherwise sit exactly where fresh ones land, and a
    // failed recipe leaves them masquerading as its output. Wipe-and-
    // recreate before the flow runs — covers BOTH backends from one
    // choke point (local Maestro writes into the dir; cloud downloads
    // into it). Runs AFTER prepareRecipeForMaestro so a recipe that
    // happens to live inside the dir has already been copied out, and
    // AFTER the freshness gate so a pre-flight rejection doesn't
    // destroy prior artifacts without producing new ones.
    try {
      resetScreenshotDir(runDir);
    } catch (err) {
      // ace#1456: a bare EACCES here reads as "something broke" and gives no
      // hint that other roots are accepted. Rethrow it typed and actionable.
      const explained = explainScreenshotDirFailure(err, runDir);
      throw explained ?? err;
    }

    // Screen recording (local backend only — cloud is Phase 2). Best-effort
    // throughout: a recording failure must never change the recipe verdict.
    const recorderConfig = recorderConfigFromEnv();
    const videos: VideoArtifact[] = [];
    let recordAttempt = 0;

    let result: RecipeRunResult;
    try {
      if (this.useCloud) {
        const paletteTarB64 = tarDirAsBase64(prep.tempDir);
        result = await this.requireCloud().runRecipe(
          prep.resolvedPath,
          enrichedEnv,
          runDir,
          { state: avdName, paletteTarB64 },
        );
      } else {
        // Bounded driver-death heal-and-retry envelope (jjackson/ace#592 item
        // 5). A Maestro driver / gRPC transport crash ("Broken pipe",
        // UNAVAILABLE) can take the AVD down mid-run, leaving the recipe
        // classified `failureClass: 'driver'` (or throwing a transport error).
        // On that — and ONLY that — cold-boot the AVD (restores the phase
        // precondition deterministically) and retry once. Any other failure
        // class is a real result and is returned untouched. Re-resolve avdInfo
        // INSIDE runOnce: a cold-boot can change serial / adbPort.
        // See `mcp/mobile/maestro-driver-retry.ts` for the safety rationale.
        result = await runRecipeWithDriverHeal({
          // No avdName → nothing to heal; disable retry (maxRetries 0).
          maxRetries: avdName ? 1 : 0,
          log: logInfo,
          runOnce: async () => {
            const avdInfo = avdName ? await this.resolveAvdInfo(avdName) : undefined;
            // Hoisted for provenance (ace#1396). A driver heal cold-boots the
            // AVD and ROTATES the serial, so the value that matters is the one
            // from the attempt that actually produced the artifacts — not the
            // first resolution.
            lastDeviceSerial = avdInfo?.serial ?? lastDeviceSerial;
            // Start/stop INSIDE runOnce, not around the whole try: a driver
            // heal cold-boots the AVD and rotates the serial, so each attempt
            // needs its own recorder. The `finally` also covers the throw
            // path for free — a driver death is the case the video is worth
            // most.
            recordAttempt += 1;
            let handle: ReturnType<typeof startRecording>;
            if (recorderConfig.enabled && avdInfo?.serial) {
              try {
                const ports = await this.avd.getAllocatedPorts();
                handle = this.recorder.start({
                  serial: avdInfo.serial,
                  recipeId,
                  dispatchId,
                  attempt: recordAttempt,
                  outDir: runDir,
                  config: recorderConfig,
                  adbServerPort: ports.adbServerPort,
                });
              } catch (e) {
                logInfo(`runRecipe: could not start recording for ${recipeId}: ${String(e)}`);
              }
            }
            try {
              // Pass `serial` through so MaestroBackend can capture per-screenshot
              // UI hierarchy dumps in the quiet windows between sub-recipes. See
              // `MaestroBackend.runRecipeWithDumps` for the split-and-capture
              // contract and `docs/learnings/2026-05-14-atlas-side-channel-capture.md`
              // for why a side-channel dump (running concurrent with Maestro)
              // doesn't work. When `serial` is undefined the backend falls back
              // to the pre-0.13.229 single-invocation path with no dumps.
              return await this.maestro.runRecipe(prep.resolvedPath, enrichedEnv, runDir, {
                adbPort: avdInfo?.adbPort,
                serial: avdInfo?.serial,
                captureAllBoundaries: opts?.captureAllBoundaries,
              });
            } finally {
              if (handle) {
                try {
                  const video = await this.recorder.stop(handle, { shell: this.avd.getAdbShell() });
                  if (video) videos.push(video);
                } catch (e) {
                  logInfo(`runRecipe: could not stop recording for ${recipeId}: ${String(e)}`);
                }
              }
            }
          },
          heal: async () => {
            // Full cold-boot funnel — restores AVD + driver + fresh demo user
            // at the Connect home (the journey-recipe precondition).
            if (avdName) await this.ensureAvdRunning(avdName);
          },
        });
      }
    } catch (e) {
      // Thrown-failure forensics (screenshot-on-error, THROW arm). A driver
      // death that exhausts the heal-and-retry envelope, a transport crash, or
      // any other backend throw never produces a RecipeRunResult — so the
      // `status === 'fail'` capture below can't fire. These are among the
      // highest-signal failures (the device hung / the driver died), and a
      // dead Maestro gRPC driver usually still leaves an adb-screenshottable
      // screen (the ui-dump path is adb-based, not gRPC). Capture HERE too,
      // best-effort, attach the paths to the thrown error so callers can
      // surface them, then rethrow the ORIGINAL error untouched. The artifacts
      // also land in this dispatch's `runDir` alongside its other PNGs regardless
      // of whether the caller reads `error.failureForensics`. Forensic capture
      // must never mask the real failure: its own errors are swallowed.
      try {
        // No structured stderr excerpt is available here: `e` is a raw
        // thrown transport error (EPIPE/ECONNRESET/etc — see
        // `maestro-driver-retry.ts`), not a Maestro-classified failure with
        // `failure.stderrExcerpt` attached. Pass undefined rather than
        // inventing one from `e.message`, which is a JS/transport error
        // string, not a Maestro "matching regex: ..." excerpt.
        const forensics = await this.captureFailureForensics(
          avdName,
          runDir,
          recipeId,
          undefined,
        );
        (e as { failureForensics?: RecipeRunResult['failureForensics'] }).failureForensics =
          forensics;
        if (forensics?.screenshotPath || forensics?.uiDumpPath) {
          logInfo(
            `runRecipe: thrown failure for ${recipeId} — captured forensics ` +
              `(screenshot=${forensics.screenshotPath ?? 'none'}, uiDump=${forensics.uiDumpPath ?? 'none'})`,
          );
        }
      } catch (fe) {
        logInfo(
          `runRecipe: thrown-failure forensics capture failed for ${recipeId}: ${String(fe)}`,
        );
      }
      // Stamp + spool whatever we recorded before the throw. The pre-crash
      // footage is the forensically interesting case, so it must carry the
      // same `<video>.meta.json` provenance sidecar the success path writes
      // — otherwise the ONE recording most worth reading lands unstamped.
      //
      // The spool (not the thrown error) is the delivery mechanism here: a
      // throw surfaces as an MCP error, so nothing downstream can read a
      // property hung off it. An earlier version also did
      // `(e as {videos}).videos = videos`; that write had no consumer
      // anywhere in mcp/, lib/, skills/, or test/ and has been removed.
      //
      // Guarded end to end: neither stamping nor spooling may throw and
      // replace the ORIGINAL error — same invariant as every other recorder
      // call site in this method.
      try {
        if (videos.length) {
          const throwProvenance = buildProvenance({
            recipeId,
            dispatchId,
            aceVersion: getAceVersion(),
            gitSha: getGitSha(),
            // ace#1396: which device this actually ran on. Without it an
            // artifact cannot be attributed after the fact, and on a
            // multi-emulator host that is a real question.
            deviceSerial: lastDeviceSerial,
            writtenAtEpochMs: Date.now(),
          });
          for (const v of videos) {
            try {
              writeProvenanceSidecar(v.path, throwProvenance);
              v.provenance = throwProvenance;
            } catch (pe) {
              logInfo(
                `runRecipe: failed to write provenance sidecar for ${v.path} on thrown failure: ${String(pe)}`,
              );
            }
            this.spool.video(v);
          }
        }
      } catch (ve) {
        logInfo(`runRecipe: failed to stamp/spool videos on thrown failure for ${recipeId}: ${String(ve)}`);
      }
      // A DISPATCH THAT DID REAL WORK MUST NEVER REPORT AS IF IT DID NONE
      // (dimagi-internal/ace#1822).
      //
      // The throw is still the throw — this path is a genuine failure and
      // callers that catch it keep catching it. What changes is that the
      // artifacts stop being invisible. Before this, a thrown dispatch lost
      // `screenshots[]` (and with it every `takenAt`, which the Deliver
      // duration-floor gate in `skills/app-screenshot-capture` Step 5
      // computes `walk_elapsed_seconds` from), `videos[]`, and even the
      // directory they landed in — so 35 real frames from a completed,
      // ONE-WAY Learn leg were unreachable through the result, and the
      // skill's "screenshots come ONLY from a `status: pass` execution in
      // THIS run" rule discarded them.
      //
      // Attached, not returned: widening `RecipeRunResult.status` to
      // `'error'` would change the contract for every caller of a passing
      // run. `mobile_run_recipe` reads this off the error and surfaces it in
      // the atom payload, which is where a skill can actually see it.
      try {
        const partial: ThrownRecipePartial = {
          status: 'error',
          screenshotsDir: runDir,
          screenshots: collectScreenshotsFromDir(runDir),
          videos,
          recipeId,
          dispatchId,
          deviceSerial: lastDeviceSerial,
        };
        (e as { partialResult?: ThrownRecipePartial }).partialResult = partial;
        logInfo(
          `runRecipe: thrown failure for ${recipeId} — ${partial.screenshots.length} screenshot(s) + ` +
            `${videos.length} video(s) preserved in ${runDir} and attached to the error`,
        );
      } catch (pe) {
        logInfo(`runRecipe: could not attach partial result on thrown failure for ${recipeId}: ${String(pe)}`);
      }
      throw e;
    }

    // Screenshot-on-recipe-error (debug assist): a failed recipe leaves the
    // device on the offending screen — capture a ui-dump + screenshot of it
    // NOW, before anything else moves the device, so "why did this step fail"
    // is debuggable from artifacts (and surfaced to the manual-debug fallback).
    // Best-effort: never let forensic capture turn a fail into a throw.
    if (result.status === 'fail') {
      try {
        result.failureForensics = await this.captureFailureForensics(
          avdName,
          runDir,
          recipeId,
          result.failure?.stderrExcerpt,
        );
      } catch (e) {
        logInfo(`runRecipe: failure-forensics capture failed for ${recipeId}: ${String(e)}`);
      }
    }

    // Stamp every PNG with a provenance sidecar before returning.
    // Best-effort: write failures don't fail the recipe (forensics-only
    // metadata, not a load-bearing invariant). Sidecars land at
    // `<png>.meta.json` next to each PNG; PNG bytes are never modified
    // so training-slide pipelines that read the PNG directly are
    // unaffected. Consumers query via `readProvenanceSidecar(pngPath)`.
    const provenance = buildProvenance({
      recipeId,
      dispatchId,
      aceVersion: getAceVersion(),
      gitSha: getGitSha(),
      // ace#1396: which device this actually ran on.
      deviceSerial: lastDeviceSerial,
      writtenAtEpochMs: Date.now(),
    });
    for (const s of result.screenshots) {
      try {
        writeProvenanceSidecar(s.path, provenance);
        s.provenance = provenance;
      } catch (e) {
        logInfo(`runRecipe: failed to write provenance sidecar for ${s.path}: ${String(e)}`);
      }
    }
    // Stamp + spool the recordings. Sidecars land at `<video>.meta.json`,
    // same convention as PNGs. The spool is how videos from recipes whose
    // callers aren't uploading skills (heal, registration, baseline) still
    // reach Drive — see `mcp/mobile/video-spool.ts`.
    for (const v of videos) {
      try {
        writeProvenanceSidecar(v.path, provenance);
        v.provenance = provenance;
      } catch (e) {
        logInfo(`runRecipe: failed to write provenance sidecar for ${v.path}: ${String(e)}`);
      }
      this.spool.video(v);
    }
    if (videos.length) result.videos = videos;
    // Surface WHICH palette this run actually used, in the atom result the
    // operator reads. The log line alone isn't enough — an operator
    // validating a staged palette fix pre-merge needs positive proof in the
    // result that the override won (jjackson/ace#1062).
    result.paletteDir = prep.paletteDir;
    result.paletteDirSource = prep.paletteDirSource;
    // Restate the dir THIS dispatch owns (dimagi-internal/ace#1130). Both
    // backends already report the dir they were handed, but the contract
    // "read your artifacts from `screenshotsDir`, never from the root you
    // passed" is the client's to guarantee — a caller that globs the root
    // would see sibling journeys' artifacts.
    result.screenshotsDir = runDir;
    return result;
  }

  /**
   * List the mp4s this SESSION's local recipe runs spooled, plus the spool
   * directory itself.
   *
   * The spool is keyed by the MCP's own ppid (see `video-spool.ts`), and
   * that key is exactly what a skill cannot obtain — so before this atom
   * existed, both screenshot-capture skills instructed a runtime LLM to
   * hand-resolve `~/.ace/mobile-videos/<ppid>/` and `rm -rf` it. The two
   * failure modes that invites are both bad: glob every child of
   * `mobile-videos` and you delete a CONCURRENT session's spool; fail to
   * resolve the path and the sweep is skipped, leaving per-ppid directories
   * with no GC. The MCP knows its own ppid, so the atom answers the
   * question the skill cannot.
   */
  listSessionVideos(): { spoolDir: string; videos: string[] } {
    const videos = this.spool.list();
    return { spoolDir: this.spool.dir(), videos };
  }

  /**
   * Clear THIS session's video spool. Returns how many files were removed
   * so the caller can log a real count rather than assuming.
   *
   * Scoped to this session's ppid by construction — it cannot touch a
   * concurrent session's spool.
   */
  clearSessionVideos(): { spoolDir: string; cleared: number } {
    const dir = this.spool.dir();
    // Count what the WIPE removes, not what `list()` shows. `list()` filters
    // to `.mp4` because callers want recordings, while `clear()` removes the
    // directory recursively — so counting from `list()` under-reported the
    // moment anything else lived in the spool, which is now always: every
    // spooled video carries a `.meta.json` provenance sidecar
    // (dimagi-internal/ace#1084).
    const cleared = this.spool.count();
    this.spool.clear();
    return { spoolDir: dir, cleared };
  }

  /**
   * Best-effort capture of the device state at a recipe FAILURE — a ui-dump
   * (element tree: ids/text/bounds — the highest-signal artifact for selector
   * and nav debugging) plus a screenshot of the screen the recipe died on,
   * plus (when available) the Maestro stderr excerpt naming what the recipe
   * was reaching for. Written into `screenshotDir` as
   * `<recipeId>-FAILURE.{xml,png,txt}` so they ride along with the run's
   * other screenshots (uploaded + provenance-stamped) and are available to
   * the manual-debug fallback. Cross-backend.
   *
   * Bypasses `client.runRecipe` (calls the backend directly) so the throwaway
   * 1-step screenshot recipe doesn't recurse or trip the freshness pre-flight.
   * Every step is independently try/caught: forensic capture must never turn a
   * recipe failure into a thrown error.
   */
  private async captureFailureForensics(
    avdName: string | undefined,
    screenshotDir: string,
    recipeId: string,
    stderrExcerpt: string | undefined,
  ): Promise<RecipeRunResult['failureForensics']> {
    const out: NonNullable<RecipeRunResult['failureForensics']> = {};
    const base = `${recipeId}-FAILURE`;
    try {
      fs.mkdirSync(screenshotDir, { recursive: true });
    } catch {
      /* ignore */
    }

    // 1. UI dump — the element tree of the failure screen.
    if (avdName) {
      try {
        const dump = await this.captureUiDump(avdName);
        const xmlPath = path.join(screenshotDir, `${base}.xml`);
        fs.writeFileSync(xmlPath, dump.xml, 'utf8');
        out.uiDumpPath = xmlPath;
        out.elements = dump.elements;
      } catch (e) {
        logInfo(`captureFailureForensics: ui-dump failed for ${recipeId}: ${String(e)}`);
      }
    }

    // 2. Screenshot of the failure screen via a throwaway 1-step recipe.
    try {
      const tmpRecipe = path.join(os.tmpdir(), `ace-failshot-${base}-${process.pid}.yaml`);
      fs.writeFileSync(
        tmpRecipe,
        `appId: org.commcare.dalvik\n---\n- takeScreenshot: "${base}"\n`,
      );
      try {
        if (this.useCloud) {
          await this.requireCloud().runRecipe(tmpRecipe, {}, screenshotDir, {
            state: avdName,
            screenshotPrefix: base,
          });
        } else if (avdName) {
          const avd = await this.resolveAvdInfo(avdName);
          if (avd) {
            await this.maestro.runRecipe(tmpRecipe, {}, screenshotDir, {
              adbPort: avd.adbPort,
              serial: avd.serial,
            });
          }
        }
      } finally {
        try {
          fs.unlinkSync(tmpRecipe);
        } catch {
          /* ignore */
        }
      }
      // Resolve the produced PNG (don't assume the backend's exact naming):
      // prefer `<base>.png`, else the newest screenshotDir PNG mentioning base.
      const exact = path.join(screenshotDir, `${base}.png`);
      if (fs.existsSync(exact)) {
        out.screenshotPath = exact;
      } else {
        const hit = fs
          .readdirSync(screenshotDir)
          .filter((f) => f.endsWith('.png') && f.includes(base))
          .sort()
          .pop();
        if (hit) out.screenshotPath = path.join(screenshotDir, hit);
      }
    } catch (e) {
      logInfo(`captureFailureForensics: screenshot failed for ${recipeId}: ${String(e)}`);
    }

    // 3. Stderr excerpt — what the recipe was reaching for when it died.
    // The ui-dump alone shows what IS on screen; without this, the atlas
    // drift classifier (`lib/atlas-drift.ts`) has no `wanted` matchers to
    // diff against it and can never distinguish `matcher-miss` (the wanted
    // element IS on screen — the recipe/selector is wrong) from
    // `unmapped-surface` (nothing wanted is on screen — a real coverage
    // gap). Those two have opposite fixes, so this file is what makes that
    // call possible at all. Best-effort and skipped entirely when no
    // excerpt was passed in (e.g. a thrown transport error with no
    // Maestro-classified failure attached).
    if (stderrExcerpt) {
      try {
        const txtPath = path.join(screenshotDir, `${base}.txt`);
        fs.writeFileSync(txtPath, stderrExcerpt, 'utf8');
        out.stderrPath = txtPath;
      } catch (e) {
        logInfo(`captureFailureForensics: stderr-excerpt write failed for ${recipeId}: ${String(e)}`);
      }
    }

    return out;
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

    // Prove the device ANSWERS before driving recipes at it (ace#1357 fix 3).
    // requireRunningAvd only asserts adb LISTS the serial; a cold boot that
    // died after registering leaves an entry nothing can reach, and Maestro
    // then fails installing its driver apk with `Connection refused`. The real
    // cause is already on disk — #1047's stderr capture wrote it — but its
    // attach block only decorates boot-wait errors, so on this path it was
    // dropped and replaced by a dadb trace. Lead with the fatal line instead.
    const reach = await this.avd.probeDeviceReachable(avd.serial);
    if (!reach.reachable) {
      const bootLogPath = findLatestBootLog(os.tmpdir());
      throw new Error(
        buildUnreachableMessage({
          serial: avd.serial,
          avdName: args.avdName,
          reason: reach.reason ?? 'no response',
          bootLogPath,
          fatalLine: bootLogPath ? fatalBootLine(bootLogTail(bootLogPath, 200)) : undefined,
          tail: bootLogPath ? bootLogTail(bootLogPath) : undefined,
        }),
      );
    }

    const adbPort = AvdBackend.adbPortFromSerial(avd.serial) ?? undefined;
    const tmp = fs.mkdtempSync(path.join(this.regTmpRoot, 'ace-mobile-reg-'));

    // Resolve `${SELECTOR:...}` placeholders BEFORE handing the recipes to
    // Maestro — the same prep `runRecipe` and `cloudRegisterTestUser` run.
    // PR #650 migrated connect-register-{to,from}-otp.yaml off raw
    // `org.commcare.dalvik:id/*` literals onto `${SELECTOR:...}` tokens; this
    // bootstrap path was still passing the RAW recipe paths to Maestro, so
    // the placeholders reached Maestro unsubstituted and it coerced them to
    // `id: NaN` (failing the very first splash assertion — jjackson/ace#682).
    // `prepareRecipeForMaestro` resolves EVERY file in the static palette
    // into `prep.tempDir`, so both register recipes land there as resolved
    // siblings (and any `runFlow: file:` refs resolve to the resolved copies).
    const toContinueRaw = path.join(this.staticRecipesDir, 'connect-register-to-otp.yaml');
    const prep = await prepareRecipeForMaestro(
      toContinueRaw,
      getConfiguredApkVersion(),
      this.staticRecipesDir,
    );
    const toContinue = path.join(prep.tempDir, 'connect-register-to-otp.yaml');
    const fromContinue = path.join(prep.tempDir, 'connect-register-from-otp.yaml');
    let success = false;
    try {
      // Pre-grant runtime permissions BEFORE launching CommCare. Both
      // pm clear (Step 1.5 of runLocalBootstrap) AND fresh APK installs
      // (Step 1) leave the device with ungranted runtime perms; on the
      // next launch Android surfaces a GrantPermissionsActivity dialog
      // BEFORE CommCareSetupActivity for each ungranted perm
      // (location, audio, camera, ...). The registration recipes assume
      // the welcome screen is the first surface and have zero handling
      // for the system dialog — they stall. Pre-granting flips the
      // class from "intermittent unrecoverable halt" to "no dialog
      // appears." Idempotent + no-op-safe if APK isn't installed yet.
      //
      // Bednet-spot-check run 20260526-2310 Phase 6 (2026-05-27) hit
      // this twice; two consecutive agents misread the post-dialog
      // recipe timeout as "registration didn't advance past phone
      // entry." See `AvdBackend.grantRuntimePermissions` for the full
      // perm list + rationale.
      await this.avd.grantRuntimePermissions(args.avdName).catch(() => {});

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
        // Pre-invite gating signature: Continue-tap succeeded but
        // CommCare fell out of foreground (server-side
        // /users/start_configuration crashed because the phone has no
        // Connect invite — the canonical CONNECT-ID-3F class). Surface
        // a typed error with the exact remedy instead of a generic
        // stderr blob. See `lib/no-invite-detector.ts` and
        // `playbook/integrations/mobile-integration.md § Pre-invite
        // gating`.
        if (detectNoInviteSignature({ stderr: partA.stderr, stdout: partA.stdout })) {
          throw new NoInviteSuspectedError(
            args.phone,
            partA.stderr || partA.stdout,
          );
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
        // Post-failure device-state backstop (added 2026-05-25 after the
        // bednet-spot-check/20260525-1405 phantom blocker). Demo-bypass
        // re-registrations can blur through intermediate screens
        // (App Lock setup, system unlock prompt, photo capture) faster
        // than Maestro's polling window can land on them — recipe
        // halts at an `extendedWaitUntil` assertion despite the
        // underlying registration completing fine on the device.
        // The recipe-side fix made those waits conditional + added a
        // terminal-state assertion; this is the client-side backstop:
        // if the recipe still halts for some other reason, probe the
        // device for the post-registered drawer markers
        // (classifyDeviceUserState `ready`). If the device IS ready,
        // treat as success — the recipe's halt was timing noise, not
        // a real failure. Class-level fix for recipe-flakiness-vs-
        // actual-device-state divergence.
        const verify = await this.probeDeviceUserState(avd).catch(() => ({
          classified_as: 'unknown' as DeviceUserStateClass,
          focused_activity: undefined,
          ui_dump_signal: undefined,
        }));
        if (verify.classified_as === 'ready') {
          logInfo(
            `register_test_user: part B recipe halted but device classified 'ready' (signal=${verify.ui_dump_signal ?? 'none'}) — treating as success`,
          );
          success = true;
          return { alreadyRegistered: true, phone: args.phone };
        }
        throw new Error(
          `register_test_user part B failed: ${partB.stderr || partB.stdout}\n` +
            postFailureProbeVerdict(verify.classified_as, verify.ui_dump_signal),
        );
      }

      success = true;
      return { alreadyRegistered: false, phone: args.phone, backupCode: args.backupCode };
    } finally {
      // Record that this AVD has PROVEN itself (ace#1047 fix 2). Reaching here
      // with success means CommCare is installed and a test user exists — the
      // only evidence that makes this AVD a safe fallback for a concurrent
      // session whose own AVD is held. Written here rather than at each return
      // so all four success paths are covered by one line. Best-effort: a
      // marker that fails to write only leaves the AVD ineligible as a
      // fallback, which is the safe direction.
      if (success) {
        const avdHome =
          process.env.ANDROID_AVD_HOME ?? path.join(os.homedir(), '.android', 'avd');
        writeProvisionedMarker(avdHome, args.avdName, {
          marked_at: new Date().toISOString(),
          // The map ACE actually loads, read from disk — not the never-set
          // `ACE_SELECTOR_MAP` env var this used to record as `undefined`,
          // which `JSON.stringify` then dropped, so the field never landed on
          // a single marker on any host (ace#1993).
          selector_map: resolveActiveSelectorMapId(),
        });
      }
      // The resolved-recipe temp dir is internal plumbing — always reap it,
      // success or failure (it holds no post-mortem signal; the screenshot
      // artifacts under `tmp` are what matters).
      try {
        fs.rmSync(prep.tempDir, { recursive: true, force: true });
      } catch {
        // Best-effort — OS temp dir is bounded.
      }
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
    const prep = await prepareRecipeForMaestro(
      toPath,
      getConfiguredApkVersion(),
      this.staticRecipesDir,
    );
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
   * Verification step (``probeDeviceUserState``) is NOT called here:
   * unlike the local backend, the cloud backend has no lightweight UI dump
   * probe that doesn't go through a full Maestro round-trip.
   *
   * Because of that, this path does not claim a verified state
   * (dimagi-internal/ace#1067). It returns ``classified_as: 'unknown'``, omits
   * ``verified_as`` entirely, and suffixes its registration step
   * ``-unverified``. The previous docstring reasoned that "if the
   * registration succeeds the device IS ready" — true of the happy path, but
   * it made the return a claim about the DEVICE when the only evidence held
   * was a claim about the CALL, and the whole point of #1067 is that callers
   * act on the difference.
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

    // Report what we actually know, which on this path is "the cloud
    // endpoints returned without error" — nothing more
    // (dimagi-internal/ace#1067, the cloud twin of the local overclaim).
    //
    // This used to return `classified_as: 'ready'` AND `verified_as: 'ready'`
    // with `bootstrap_steps: [..., 'registered']`, having probed nothing at
    // all — strictly a bigger claim than the local funnel's, which at least
    // reported whatever its own probe said. `verified_as` is now OMITTED
    // because no verification ran (the field is optional precisely so an
    // unverified path can decline to answer), `classified_as` is `unknown`
    // because that is the truth, and the registration step carries the
    // `-unverified` suffix from the shared vocabulary.
    //
    // Still a SUCCESS, deliberately. `unknown` is not a fault — see the
    // local path's note on #1067's ask 2, declined with evidence from two
    // passing runs. The fix for an overclaim is to stop overclaiming, not to
    // start failing runs that work.
    //
    // The honest ceiling here is a *reporting* fix: a real cloud
    // verification needs a probe the cloud backend does not have (its only
    // UI-dump route is a full Maestro round-trip). If one is added, feed its
    // verdict into `classified_as`/`verified_as` and drop the suffix on
    // confirmation, exactly as the local path does.
    return {
      classified_as: 'unknown',
      attempted: true,
      healed_via: 'cloud-bootstrap',
      bootstrap_steps: markRegistrationUnverified(steps),
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
