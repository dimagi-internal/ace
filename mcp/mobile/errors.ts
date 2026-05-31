export class MobileError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly remediation?: string,
    public readonly diagnostics?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'MobileError';
  }
}

export class AvdBootError extends MobileError {
  constructor(avdName: string, reason: string, diagnostics?: Record<string, unknown>) {
    super(
      'AVD_BOOT_FAILED',
      `AVD ${avdName} failed to boot: ${reason}`,
      'Run /ace:mobile-bootstrap to verify AVD setup.',
      diagnostics,
    );
  }
}

/**
 * Thrown by `AvdBackend.ensureAvdRunning` when the cold-boot's post-spawn
 * wait stalls in a specific phase (adb-register → boot-completed →
 * storage-mount). Carries structured diagnostics so the orchestrator's
 * halt classifier and on-call humans don't have to grep at a bare string.
 *
 * The boot-wait short-circuit (returning the first `offline` reading as
 * fatal) was the failure mode on malaria-itn-fgd/20260515-1645 Phase 6
 * attempt 7 against v0.13.270's brand-new cold-boot path. The class-level
 * preventer: every wait phase has its own typed budget and surfaces which
 * phase ran out.
 */
export class AvdBootTimeoutError extends MobileError {
  constructor(
    avdName: string,
    serial: string | null,
    phase: 'adb-register' | 'boot-completed' | 'storage-mount',
    elapsedMs: number,
    budgetMs: number,
    lastAdbState: string | null,
    lastBootCompleted: string,
  ) {
    super(
      'AVD_BOOT_TIMEOUT',
      `AVD ${avdName}${serial ? ` (${serial})` : ''} stalled in phase=${phase} ` +
        `(elapsed_ms=${elapsedMs} budget_ms=${budgetMs} ` +
        `last_adb_state=${lastAdbState ?? 'absent'} last_boot_completed='${lastBootCompleted}')`,
      'Run /ace:mobile-bootstrap to verify AVD setup. ' +
        'If the phase is adb-register, the emulator process likely died on startup — ' +
        'check that no other emulator is on the same console port and that the AVD config is valid. ' +
        'If the phase is boot-completed, the AVD is starting but slow — bump AVD_BOOT_TIMEOUT_MS or check disk I/O. ' +
        'If the phase is storage-mount, userdata.img is corrupt — delete and re-create the AVD.',
      { phase, elapsed_ms: elapsedMs, budget_ms: budgetMs, last_adb_state: lastAdbState, last_boot_completed: lastBootCompleted },
    );
  }
}

export class RecipeValidationError extends MobileError {
  constructor(recipePath: string, reason: string) {
    super('RECIPE_INVALID', `Invalid Maestro recipe at ${recipePath}: ${reason}`);
  }
}

/**
 * Thrown by `MobileClient.runRecipe`'s pre-flight gate when a recipe's
 * stamped `selector_map_sha` doesn't match the currently-active
 * selector map. Closes the stale-Drive-artifact class from
 * `docs/learnings/2026-05-14-phase6-validation-arc.md` (class-level
 * finding #1): when a code change renames a logical selector, every
 * previously-generated journey recipe on Drive becomes silently stale.
 * The pre-flight refuses to run so the operator regenerates instead
 * of burning AVD wall-clock.
 */
export class StaleRecipeError extends MobileError {
  constructor(recipePath: string, reason: string, diagnostics?: Record<string, unknown>) {
    super(
      'RECIPE_STALE',
      `Recipe ${recipePath} is stale relative to the current selector map: ${reason}`,
      'Re-run /ace:step app-test-cases to regenerate the journey recipes against the current selector map.',
      diagnostics,
    );
  }
}

/**
 * Thrown by `MobileClient.registerTestUser` when the Part A failure
 * matches the canonical pre-invite gating signature (Continue-tap
 * succeeded → CommCare app fell out of foreground → registration
 * never completed). The fix is to ensure the phone has an active
 * invite to a Connect opportunity before retrying.
 *
 * Detection signature lives in `lib/no-invite-detector.ts`. Background:
 * `playbook/integrations/mobile-integration.md § Pre-invite gating`.
 * Inside `/ace:run`, Phase 4's `connect-opp-setup` step 8 satisfies
 * this precondition automatically, so this error mainly surfaces from
 * one-off `/ace:step` invocations against a fresh test phone.
 */
export class NoInviteSuspectedError extends MobileError {
  constructor(phone: string, stderrExcerpt: string) {
    super(
      'NO_INVITE_SUSPECTED',
      `registerTestUser for ${phone} matched the pre-invite gating failure signature: ` +
        `Continue-tap succeeded but CommCare fell out of foreground. ` +
        `Excerpt: ${stderrExcerpt.slice(0, 240)}`,
      `Invite ${phone} to an active Connect opportunity via ` +
        `connect_send_flw_invite({ opportunity_id, phone_numbers: ['${phone}'] }), ` +
        `or run /ace:run end-to-end so Phase 4's connect-opp-setup invites it for you.`,
    );
  }
}

/**
 * Recognises the transient boot→driver-install→recipe handoff race where a
 * freshly cold-booted emulator's Maestro gRPC channel passes the readiness
 * probe but then drops on the VERY FIRST `deviceInfo` call of the next recipe
 * (the registration walk). Canonical signatures, observed on
 * malaria-rdt/20260531-0739 Phase 6 (jjackson/ace#589):
 *
 *   io.grpc.StatusRuntimeException: UNAVAILABLE
 *   Caused by: dadb.AdbStreamClosed: ADB stream is closed for localId: ...
 *   [ERROR] Not able to reach the gRPC server while processing deviceInfo command
 *
 * The only recovery is to re-run the idempotent cold-boot funnel
 * (`MobileClient.ensureAvdRunning`), which is now done automatically rather
 * than surfaced as a typed throw the agent has to manually re-dispatch.
 * Matched on message/stack text so it fires regardless of which error class
 * wraps the underlying Maestro failure (it surfaces as a bare `Error` from
 * `registerTestUser`'s `part A failed:` path).
 */
const TRANSIENT_BOOT_RACE_PATTERNS: RegExp[] = [
  /AdbStreamClosed/i,
  /ADB stream is closed/i,
  /StatusRuntimeException:\s*UNAVAILABLE/i,
  /Not able to reach the gRPC server/i,
];

export function isTransientBootRaceError(err: unknown): boolean {
  if (err == null) return false;
  const parts: string[] = [];
  if (err instanceof Error) {
    parts.push(err.message);
    if (err.stack) parts.push(err.stack);
  } else {
    parts.push(String(err));
  }
  const haystack = parts.join('\n');
  return TRANSIENT_BOOT_RACE_PATTERNS.some((re) => re.test(haystack));
}

export class AdbError extends MobileError {
  constructor(public readonly subcommand: string, public readonly exitCode: number, stderr: string) {
    super('ADB_ERROR', `adb ${subcommand} failed (exit ${exitCode}): ${stderr.slice(0, 200)}`);
  }
}

export class MaestroError extends MobileError {
  constructor(public readonly recipePath: string, public readonly exitCode: number, stderr: string) {
    super('MAESTRO_ERROR', `maestro test ${recipePath} failed (exit ${exitCode}): ${stderr.slice(0, 200)}`);
  }
}

// Surfaced when the AVD is booted and `adb` reports `device`, but the Maestro
// driver app (`dev.mobile.maestro`) on the AVD is not responding on its gRPC
// channel — the canonical symptom is `maestro hierarchy` (or the first
// `deviceInfo` call of `maestro test`) returning `UNAVAILABLE` and timing
// out. Distinct from AvdBootError (the AVD itself wouldn't boot) and
// MaestroError (a specific recipe failed). The healer in
// `MobileClient.ensureAvdRunning` tries `am force-stop` and then
// uninstall-and-reinstall before throwing this; by the time it surfaces, the
// AVD needs operator attention (or `/ace:mobile-bootstrap`) before Phase 6
// `app-screenshot-capture` can capture anything.
export class MaestroDriverError extends MobileError {
  constructor(serial: string, attempts: string[]) {
    super(
      'MAESTRO_DRIVER_UNAVAILABLE',
      `Maestro driver on AVD ${serial} is unhealthy after recovery: ${attempts.join('; ')}`,
      'Run /ace:mobile-bootstrap to re-baseline the AVD + Maestro driver, then retry. If the failure persists, capture `adb -s <serial> logcat | grep maestro` for upstream debugging.',
    );
  }
}

// Surfaced when the AVD is booted and Maestro driver is healthy, but the
// per-user device state is wiped: either CommCare has no `ApplicationDocument`
// configured (CommCareSetupActivity foregrounded; "Enter Code" / barcode
// screen) or PersonalID has lost server configuration ("Logged out of
// PersonalID" drawer banner with a "Reconfigure" CTA). The healer in
// `MobileClient.ensureAvdRunning` tries `loadSnapshot('registered-test-user')`
// before throwing; by the time this surfaces, the snapshot is missing or
// stale and the operator needs `/ace:mobile-bootstrap` (which can also do
// the server-side `${ACE_E2E_PHONE}` invite check the auto-heal cannot).
//
// Class history: misdiagnosed as "Connect APK not installed" on turmeric
// run 20260513-0616 — the subagent saw `org.commcare.dalvik` absent of a
// sibling `connect`-named package and inverted-concluded. The state
// classifier (`classifyDeviceUserState`) was added to make this class
// structurally impossible to mislabel.
export class DeviceUserStateError extends MobileError {
  constructor(stateClass: string, attempts: string[]) {
    super(
      'DEVICE_USER_STATE_WIPED',
      `AVD per-user state is unhealthy (${stateClass}) after recovery: ${attempts.join('; ')}`,
      'Run /ace:mobile-bootstrap to re-register the ACE test user, configure the CommCare app, and save a fresh `registered-test-user` snapshot. The auto-heal only does snapshot-load; full registration + server-side invite verification require the bootstrap flow.',
    );
  }
}
