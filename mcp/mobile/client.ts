// mcp/mobile/client.ts
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { AvdBackend } from './backends/avd.js';
import { MaestroBackend } from './backends/maestro.js';
import { RecipeGenerator, type LlmFn } from './backends/recipe-generator.js';
import type {
  AvdInfo, ApkInfo, RecipeRunResult, TestUserRegistrationResult, UiDumpResult,
  SnapshotResult,
} from './types.js';
import { logInfo } from './logging.js';

export interface MobileClientOpts {
  avd?: AvdBackend;
  maestro?: MaestroBackend;
  staticRecipesDir?: string;
}

const DEFAULT_STATIC_DIR = new URL('./recipes/static/', import.meta.url).pathname;

export interface DriveAdapter {
  readFile(driveId: string, filePath: string): Promise<string>;
  writeFile(driveId: string, filePath: string, content: string): Promise<void>;
  listFolder(driveId: string, folderPath: string): Promise<string[]>;
}

export class MobileClient {
  readonly avd: AvdBackend;
  readonly maestro: MaestroBackend;
  readonly staticRecipesDir: string;

  constructor(opts: MobileClientOpts = {}) {
    this.avd = opts.avd ?? new AvdBackend();
    this.maestro = opts.maestro ?? new MaestroBackend();
    this.staticRecipesDir = opts.staticRecipesDir ?? DEFAULT_STATIC_DIR;
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
  saveSnapshot(avdName: string, snapshotName: string): Promise<SnapshotResult> {
    return this.avd.saveSnapshot(avdName, snapshotName);
  }
  loadSnapshot(avdName: string, snapshotName: string): Promise<SnapshotResult> {
    return this.avd.loadSnapshot(avdName, snapshotName);
  }

  /**
   * When `avdName` is provided, the recipe runs against that emulator's
   * adb port directly via `maestro --host=localhost --port=<adbd>`,
   * which sidesteps the dadb-1.2.10 listDadbs bug that aborts on any
   * unauthorized device in the local adb-server's device list (see
   * `MaestroBackend.runRecipe`). Without `avdName` we fall back to
   * Maestro's default device auto-discovery for backward compatibility.
   */
  async runRecipe(
    recipePath: string,
    env: Record<string, string>,
    screenshotDir: string,
    avdName?: string,
  ): Promise<RecipeRunResult> {
    const adbPort = avdName ? await this.resolveAdbPort(avdName) : undefined;
    return this.maestro.runRecipe(recipePath, env, screenshotDir, { adbPort });
  }

  private async resolveAdbPort(avdName: string): Promise<number | undefined> {
    const found = await this.avd.findRunningAvd(avdName);
    if (!found) return undefined;
    const port = AvdBackend.adbPortFromSerial(found.serial);
    return port ?? undefined;
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
    const avd = await this.avd.ensureAvdRunning(args.avdName);
    const adbPort = AvdBackend.adbPortFromSerial(avd.serial) ?? undefined;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-mobile-reg-'));
    const toContinue = path.join(this.staticRecipesDir, 'connect-register-to-otp.yaml');
    const fromContinue = path.join(this.staticRecipesDir, 'connect-register-from-otp.yaml');

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
        return { alreadyRegistered: true, phone: args.phone };
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
        return { alreadyRegistered: true, phone: args.phone };
      }
      throw new Error(`register_test_user part B failed: ${partB.stderr || partB.stdout}`);
    }

    return { alreadyRegistered: false, phone: args.phone, backupCode: args.backupCode };
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
