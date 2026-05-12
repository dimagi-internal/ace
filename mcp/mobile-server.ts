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
import { parse as parseYaml } from 'yaml';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { MobileClient } from './mobile/client.js';
import { logInfo, logError } from './mobile/logging.js';
import { resolveBackend } from './mobile/backend-toggle.js';

const client = new MobileClient();

// One-line startup banner so "which backend is this MCP routing to?" is
// trivially answerable from the Claude Code MCP log. The resolver is
// re-run on every call, so this is only a snapshot of the value AT
// startup; a slash-command toggle mid-session won't re-emit this line.
{
  const { backend, source, sessionFile, ppid } = resolveBackend();
  const cloudReady = client.cloud !== null;
  process.stderr.write(
    `[ace-mobile] startup backend=${backend} source=${source} ppid=${ppid} ` +
    `cloud_ready=${cloudReady} session_file=${sessionFile}\n`,
  );
}

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
  'mobile_run_recipe',
  {
    recipePath: z.string(),
    envVars: z.record(z.string()).default({}),
    screenshotDir: z.string(),
    // Optional override. Default = `process.env.ACE_AVD_NAME`. When set,
    // ACE looks up the running AVD's adb port and runs maestro with
    // `--host=localhost --port=<X>` so dadb talks to the emulator
    // directly. This bypasses the dadb-1.2.10 listDadbs bug that aborts
    // the whole device enumeration on the first `unauthorized` entry —
    // fatal on shared workstations where another user's emulator is
    // visible to your adb server. Defaulting from env makes the
    // workaround opt-out instead of opt-in, so screenshot-capture and
    // baseline skills don't silently regress when they forget to pass
    // it. Set explicitly to a different name only if running against
    // multiple concurrent AVDs.
    avdName: z.string().optional(),
  },
  async ({ recipePath, envVars, screenshotDir, avdName }) => {
    const resolvedAvd = avdName ?? process.env.ACE_AVD_NAME;
    return {
      content: [{ type: 'text', text: JSON.stringify(await client.runRecipe(recipePath, envVars, screenshotDir, resolvedAvd), null, 2) }],
    };
  },
);

server.tool(
  'mobile_capture_ui_dump',
  { avdName: z.string() },
  async ({ avdName }) => ({
    content: [{ type: 'text', text: JSON.stringify(await client.captureUiDump(avdName), null, 2) }],
  }),
);

server.tool(
  'mobile_probe_maestro_driver',
  {
    avdName: z.string().describe('AVD name (e.g. ACE_Pixel_API_34). Must already be booted — this atom does not boot.'),
    timeoutMs: z.number().int().positive().optional().describe('Probe timeout in ms (default 8000). On a healthy AVD `maestro hierarchy` returns ~2s; raise only if you suspect a slow first-time install of the driver app.'),
  },
  async ({ avdName, timeoutMs }) => {
    // Cloud short-circuit: there is no local adb port to probe, and the
    // cloud runner's launch script proves Maestro is installed by
    // running two real registration recipes before touching the ready
    // marker — so `runner_service_state === 'active' && adb sees a
    // 'device'` is a tight equivalent to "Maestro driver healthy".
    // Without this branch, the atom always returned `healthy: false`
    // on cloud (the local `findRunningAvd` never finds a `cloud:i-...`
    // serial), which made Phase 5 pre-flight spuriously fail.
    if (client.useCloud) {
      const diag = await client.diagnose();
      const sawDevice = diag.adb_devices.some((d) => d.state === 'device');
      const runnerActive = diag.runner_service_state === 'active';
      const healthy = runnerActive && sawDevice;
      const reason = healthy
        ? undefined
        : !runnerActive
          ? `cloud runner ${diag.runner_service_state ?? 'unknown'} (expected active)`
          : 'cloud emulator not visible to adb';
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            healthy,
            reason,
            adbPort: null,
            serial: diag.adb_devices[0]?.serial,
            backend: 'cloud',
          }, null, 2),
        }],
      };
    }
    // Look up the AVD's serial without booting it — caller must have a
    // running emulator. We deliberately don't call `ensureAvdRunning`
    // here so this atom stays a *probe* (no heal, no mutation) — that
    // separation is what lets ace-doctor and Phase 5 pre-flight call
    // it to ask "would the heal path even need to run?" before paying
    // its wall-clock cost.
    const info = await client.avd.findRunningAvd(avdName);
    if (!info) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ healthy: false, reason: `AVD ${avdName} not booted (no emulator-NNNN serial in adb devices)`, adbPort: null }, null, 2) }],
        isError: false,
      };
    }
    const r = await client.probeMaestroDriver(info.serial, timeoutMs);
    return { content: [{ type: 'text', text: JSON.stringify({ ...r, serial: info.serial }, null, 2) }] };
  },
);

server.tool(
  'mobile_validate_recipe',
  {
    yaml: z.string().describe('Maestro YAML body to validate. Standard ACE-recipe shape: appId frontmatter + `---` separator + step list. Validates step-key allowlist (launchApp, tapOn, inputText, takeScreenshot, assertVisible, assertNotVisible, extendedWaitUntil, waitForAnimationToEnd, eraseText, swipe, pressKey, back, scroll, hideKeyboard, runFlow, evalScript, stopApp) and structural integrity (`---` separator present, appId in frontmatter, every step is a single-key object). Use this AFTER an ACE skill (running as a Claude Code session) writes Maestro YAML inline using its own LLM context — the mobile MCP does not bundle an LLM client, so YAML generation is the calling agent\'s responsibility, not this server\'s.'),
  },
  async ({ yaml }) => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmp = path.join(os.tmpdir(), `mob-validate-${Date.now()}-${Math.random().toString(36).slice(2)}.yaml`);
    fs.writeFileSync(tmp, yaml);
    try {
      const { MaestroBackend } = await import('./mobile/backends/maestro.js');
      const backend = new MaestroBackend({});
      await backend.validateRecipe(tmp);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, valid: true }, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, valid: false, error: e.message }, null, 2) }], isError: true };
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  },
);

server.tool(
  'mobile_resolve_selectors',
  {
    yaml: z.string().describe('Maestro YAML body containing `${SELECTOR:logical-name}` placeholders to resolve.'),
    apkVersion: z.string().default('2.62.0').describe('Connect APK version. Maps to mcp/mobile/selectors/connect-<apkVersion>.yaml. Defaults to 2.62.0; bump when re-baselining against a new APK.'),
  },
  async ({ yaml, apkVersion }) => {
    const pathMod = await import('node:path');
    const here = pathMod.dirname(fileURLToPath(import.meta.url));
    const selectorPath = pathMod.join(here, 'mobile', 'selectors', `connect-${apkVersion}.yaml`);
    if (!fs.existsSync(selectorPath)) {
      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: `selector map not found: ${selectorPath}` }, null, 2) }], isError: true };
    }
    const map = parseYaml(fs.readFileSync(selectorPath, 'utf8')) as {
      apk_version: string;
      selectors: Record<string, { type: 'id' | 'text' | 'point'; value: string; unverified?: boolean; purpose?: string }>;
    };
    if (!map.selectors) {
      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: `selector map at ${selectorPath} has no \`selectors\` block` }, null, 2) }], isError: true };
    }

    // Substitute every `${SELECTOR:logical-name}` with the matcher block
    // appropriate to the entry's `type`. Composer is responsible for
    // having the placeholder on its own indented line so the substitution
    // produces valid YAML (e.g. inside an `extendedWaitUntil.visible:`
    // block, the placeholder lives on the line right under the parent).
    const unresolved: string[] = [];
    const unverified: string[] = [];
    const re = /\$\{SELECTOR:([a-z0-9-]+)\}/g;
    const out = yaml.replace(re, (_match, name: string) => {
      const entry = map.selectors[name];
      if (!entry) {
        unresolved.push(name);
        return `# UNRESOLVED ${name}`;
      }
      if (entry.unverified) unverified.push(name);
      switch (entry.type) {
        case 'id':   return `id: "${entry.value}"`;
        case 'text': return `text: "${entry.value}"`;
        case 'point': return `point: "${entry.value}"`;
        default: unresolved.push(name); return `# UNRESOLVED-TYPE ${name}`;
      }
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          ok: unresolved.length === 0,
          yaml: out,
          unresolved,
          unverified,
          apk_version: map.apk_version,
          source_map: selectorPath,
        }, null, 2),
      }],
      isError: unresolved.length > 0,
    };
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

// ── Cloud-only diagnostics + admin atoms ─────────────────────────────
//
// These three atoms target the ace-web cloud backend specifically.
// They throw `MobileError(CLOUD_ONLY_OPERATION)` against the local
// AVD backend — skills that need them should gate on the cloud
// toggle, OR catch the error and skip.

server.tool(
  'mobile_diagnose',
  {},
  async () => ({
    content: [
      { type: 'text', text: JSON.stringify(await client.diagnose(), null, 2) },
    ],
  }),
);

server.tool(
  'mobile_restart_runner',
  {
    waitForReady: z
      .boolean()
      .optional()
      .describe(
        'Block until the runner re-sets the ready marker (default true). False is fire-and-forget — returns a partial Diagnostics snapshot immediately.',
      ),
  },
  async ({ waitForReady }) => ({
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          await client.restartRunner({ waitForReady }),
          null,
          2,
        ),
      },
    ],
  }),
);

server.tool(
  'mobile_patch_launch_script',
  {
    scriptBody: z
      .string()
      .describe(
        "Full new body of /usr/local/bin/ace-emulator-launch. Must start with '#!/bin/bash'. Server enforces a 64KB cap.",
      ),
    restartRunner: z
      .boolean()
      .optional()
      .describe(
        'After writing the new script, restart ace-mobile-runner.service so the next cold-boot exercises it (default true).',
      ),
  },
  async ({ scriptBody, restartRunner }) => ({
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          await client.patchLaunchScript({ scriptBody, restartRunner }),
          null,
          2,
        ),
      },
    ],
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
