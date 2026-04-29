// mcp/mobile/client.ts
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { AvdBackend } from './backends/avd.js';
import { MaestroBackend } from './backends/maestro.js';
import { fetchOtp } from './auth/fetch-otp.js';
import type {
  AvdInfo, ApkInfo, RecipeRunResult, OtpResult, TestUserRegistrationResult, UiDumpResult,
} from './types.js';
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
  async registerTestUser(args: {
    avdName: string;
    phone: string;
    phoneLocal: string;
    countryCode: string;
    pin: string;
    backupCode: string;
    name: string;
  }): Promise<TestUserRegistrationResult> {
    await this.avd.ensureAvdRunning(args.avdName);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-mobile-reg-'));
    const toOtpRecipe = path.join(this.staticRecipesDir, 'connect-register-to-otp.yaml');
    const fromOtpRecipe = path.join(this.staticRecipesDir, 'connect-register-from-otp.yaml');

    logInfo('register_test_user: part A (to OTP)');
    const partA = await this.maestro.runRecipe(toOtpRecipe, {
      PHONE_LOCAL: args.phoneLocal,
      COUNTRY_CODE: args.countryCode,
      PIN: args.pin,
    }, path.join(tmp, 'to-otp'));
    if (partA.status !== 'pass') {
      // Detect "already registered" early via a sentinel string the recipe writes on duplicate.
      if (partA.stdout.includes('PHONE_ALREADY_REGISTERED')) {
        return { alreadyRegistered: true, phone: args.phone };
      }
      throw new Error(`register_test_user part A failed: ${partA.stderr || partA.stdout}`);
    }

    logInfo('register_test_user: fetching OTP');
    const otpResult = await this.fetchOtp(args.phone);

    logInfo('register_test_user: part B (from OTP)');
    const partB = await this.maestro.runRecipe(fromOtpRecipe, {
      OTP: otpResult.otp,
      NAME: args.name,
      BACKUP_CODE: args.backupCode,
    }, path.join(tmp, 'from-otp'));
    if (partB.status !== 'pass') {
      if (partB.stdout.includes('PHONE_ALREADY_REGISTERED')) {
        return { alreadyRegistered: true, phone: args.phone };
      }
      throw new Error(`register_test_user part B failed: ${partB.stderr || partB.stdout}`);
    }

    return { alreadyRegistered: false, phone: args.phone, backupCode: args.backupCode };
  }
}
