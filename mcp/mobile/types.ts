export interface AvdInfo {
  name: string;
  serial: string;       // adb device serial, e.g. "emulator-5554"
  status: 'booted' | 'booting' | 'offline';
  bootTimeMs?: number;
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
