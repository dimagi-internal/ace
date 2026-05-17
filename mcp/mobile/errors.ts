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
