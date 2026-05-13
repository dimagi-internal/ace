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
  constructor(avdName: string, reason: string) {
    super(
      'AVD_BOOT_FAILED',
      `AVD ${avdName} failed to boot: ${reason}`,
      'Run /ace:mobile-bootstrap to verify AVD setup.',
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
