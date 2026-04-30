/**
 * ACE Mobile MCP Server
 *
 * Exposes 9 atomic mobile capabilities backed by Maestro + adb + Playwright.
 * (`generate_recipes_from_app_summary` is intentionally programmatic-only —
 * it's invoked by skills via MobileClient directly because it requires a
 * Drive adapter + LLM function as inputs that don't fit cleanly into MCP
 * tool schemas.)
 *
 * See docs/superpowers/specs/2026-04-28-ace-mobile-emulation-design.md
 */

import { config as dotenvConfig } from 'dotenv';
import * as path from 'node:path';
import { resolvePluginDataDir, logPluginDataDirDiag } from '../lib/plugin-data-dir.js';
logPluginDataDirDiag('ace-mobile', import.meta.url);
const __pluginDataDir = resolvePluginDataDir(import.meta.url);
dotenvConfig({
  path: __pluginDataDir
    ? path.join(__pluginDataDir, '.env')
    : path.join(process.cwd(), '.env'),
});

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { MobileClient } from './mobile/client.js';
import { logInfo, logError } from './mobile/logging.js';

const client = new MobileClient();

const server = new McpServer({ name: 'ace-mobile', version: '0.9.0' });

server.tool(
  'mobile_ensure_avd_running',
  { avdName: z.string().default(process.env.ACE_AVD_NAME ?? 'ACE_Pixel_API_34') },
  async ({ avdName }) => ({
    content: [{ type: 'text', text: JSON.stringify(await client.ensureAvdRunning(avdName), null, 2) }],
  }),
);

server.tool(
  'mobile_stop_avd',
  { avdName: z.string() },
  async ({ avdName }) => {
    await client.stopAvd(avdName);
    return { content: [{ type: 'text', text: `stopped ${avdName}` }] };
  },
);

server.tool(
  'mobile_list_avds',
  {},
  async () => ({ content: [{ type: 'text', text: JSON.stringify(await client.listAvds(), null, 2) }] }),
);

server.tool(
  'mobile_install_apk',
  { avdName: z.string(), apkPath: z.string() },
  async ({ avdName, apkPath }) => ({
    content: [{ type: 'text', text: JSON.stringify(await client.installApk(avdName, apkPath), null, 2) }],
  }),
);

server.tool(
  'mobile_uninstall_apk',
  { avdName: z.string(), packageId: z.string() },
  async ({ avdName, packageId }) => ({
    content: [{ type: 'text', text: JSON.stringify(await client.uninstallApk(avdName, packageId), null, 2) }],
  }),
);

server.tool(
  'mobile_register_test_user',
  {
    avdName: z.string(),
    phone: z.string(),
    phoneLocal: z.string(),
    countryCode: z.string(),
    pin: z.string(),
    backupCode: z.string(),
    name: z.string().default('ACE Test'),
  },
  async (args) => ({
    content: [{ type: 'text', text: JSON.stringify(await client.registerTestUser(args), null, 2) }],
  }),
);

server.tool(
  'mobile_fetch_otp',
  { phone: z.string(), headed: z.boolean().default(false) },
  async ({ phone, headed }) => ({
    content: [{ type: 'text', text: JSON.stringify(await client.fetchOtp(phone, headed), null, 2) }],
  }),
);

server.tool(
  'mobile_run_recipe',
  {
    recipePath: z.string(),
    envVars: z.record(z.string()).default({}),
    screenshotDir: z.string(),
  },
  async ({ recipePath, envVars, screenshotDir }) => ({
    content: [{ type: 'text', text: JSON.stringify(await client.runRecipe(recipePath, envVars, screenshotDir), null, 2) }],
  }),
);

server.tool(
  'mobile_capture_ui_dump',
  { avdName: z.string() },
  async ({ avdName }) => ({
    content: [{ type: 'text', text: JSON.stringify(await client.captureUiDump(avdName), null, 2) }],
  }),
);

server.tool(
  'mobile_generate_recipe_for_module',
  {
    summary: z.string().describe('The full app summary markdown — the recipe-generator parses module names from this and grounds the LLM call in it.'),
    moduleName: z.string().describe('The specific module name to generate a recipe for (e.g. "Photo standardization", "Final assessment"). Must match one of the module names parseSummary would return for this summary, or the LLM has nothing to anchor to.'),
    appKind: z.enum(['learn', 'deliver']).describe('Which app the module belongs to. Drives the system-prompt framing.'),
  },
  async ({ summary, moduleName, appKind }) => {
    const { RecipeGenerator } = await import('./mobile/backends/recipe-generator.js');
    const gen = new RecipeGenerator();  // uses built-in Anthropic LlmFn (ANTHROPIC_API_KEY env)
    try {
      const yaml = await gen.generateForModule({ summary, moduleName, appKind });
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, yaml }, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: e.message }, null, 2) }], isError: true };
    }
  },
);

server.tool(
  'mobile_save_snapshot',
  { avdName: z.string(), snapshotName: z.string() },
  async ({ avdName, snapshotName }) => ({
    content: [{ type: 'text', text: JSON.stringify(await client.saveSnapshot(avdName, snapshotName), null, 2) }],
  }),
);

server.tool(
  'mobile_load_snapshot',
  { avdName: z.string(), snapshotName: z.string() },
  async ({ avdName, snapshotName }) => ({
    content: [{ type: 'text', text: JSON.stringify(await client.loadSnapshot(avdName, snapshotName), null, 2) }],
  }),
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logInfo('ace-mobile MCP server listening on stdio');
}

main().catch((e) => {
  logError('fatal', e);
  process.exit(1);
});
