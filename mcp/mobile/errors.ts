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

export class OtpFetchError extends MobileError {
  constructor(reason: 'AUTH_REQUIRED' | 'NOT_FOUND' | 'STALE' | 'UNKNOWN', phone: string) {
    const code = `OTP_${reason}`;
    const remediation =
      reason === 'AUTH_REQUIRED'
        ? 'Run with PHASE9_HEADED=1 to sign in to Dimagi SSO once; cookies will persist.'
        : reason === 'NOT_FOUND'
          ? 'Verify the phone is registered and within 60s of OTP issuance.'
          : 'Re-fetch; OTP may have rotated.';
    super(code, `OTP fetch (${reason}) for ${phone}`, remediation);
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
