// mcp/mobile/client.ts
import * as path from 'node:path';
import { AvdBackend } from './backends/avd.js';
import { MaestroBackend } from './backends/maestro.js';
import { fetchOtp } from './auth/fetch-otp.js';
import type {
  AvdInfo, ApkInfo, RecipeRunResult, OtpResult, TestUserRegistrationResult, UiDumpResult,
} from './types.js';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { logInfo } from './logging.js';

export interface MobileClientOpts {
  avd?: AvdBackend;
  maestro?: MaestroBackend;
  staticRecipesDir?: string;
  playwrightUserDataDir?: string;
}

const DEFAULT_STATIC_DIR = new URL('./recipes/static/', import.meta.url).pathname;
const DEFAULT_PLAYWRIGHT_DIR =
  process.env.ACE_PLAYWRIGHT_USER_DATA_DIR ||
  path.join(process.env.HOME ?? '', '.ace', 'playwright-userdata');

export class MobileClient {
  readonly avd: AvdBackend;
  readonly maestro: MaestroBackend;
  readonly staticRecipesDir: string;
  readonly playwrightUserDataDir: string;

  constructor(opts: MobileClientOpts = {}) {
    this.avd = opts.avd ?? new AvdBackend();
    this.maestro = opts.maestro ?? new MaestroBackend();
    this.staticRecipesDir = opts.staticRecipesDir ?? DEFAULT_STATIC_DIR;
    this.playwrightUserDataDir = opts.playwrightUserDataDir ?? DEFAULT_PLAYWRIGHT_DIR;
  }

  // ---- Atom-level methods (one per capability) ----

  ensureAvdRunning(name: string): Promise<AvdInfo> { return this.avd.ensureAvdRunning(name); }
  stopAvd(name: string): Promise<void> { return this.avd.stopAvd(name); }
  listAvds(): Promise<string[]> { return this.avd.listAvds(); }
  installApk(avdName: string, apk: string): Promise<ApkInfo> { return this.avd.installApk(avdName, apk); }
  uninstallApk(avdName: string, pkg: string): Promise<{ uninstalled: boolean }> {
    return this.avd.uninstallApk(avdName, pkg);
  }
  captureUiDump(avdName: string): Promise<UiDumpResult> { return this.avd.captureUiDump(avdName); }

  fetchOtp(phone: string, headed = false): Promise<OtpResult> {
    return fetchOtp(phone, { userDataDir: this.playwrightUserDataDir, headed });
  }

  runRecipe(recipePath: string, env: Record<string, string>, screenshotDir: string): Promise<RecipeRunResult> {
    return this.maestro.runRecipe(recipePath, env, screenshotDir);
  }

  // register_test_user and generate_recipes_from_app_summary added in later tasks.
  registerTestUser(_args: {
    avdName: string; phone: string; phoneLocal: string; countryCode: string;
    pin: string; backupCode: string; name: string;
  }): Promise<TestUserRegistrationResult> {
    throw new Error('not implemented yet');
  }
}
