export class MobileError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly remediation?: string,
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
// AVD needs operator attention (or `/ace:mobile-bootstrap`) before Phase 5
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
