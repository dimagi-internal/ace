/**
 * ACE Mobile MCP Server
 *
 * Exposes 19 atomic mobile capabilities backed by Maestro + adb +
 * Playwright + (when ACE_MOBILE_BACKEND=cloud) ace-web's cloud
 * emulator HTTP API. Routing → backend lives in
 * `mcp/mobile/capability-map.ts`; the registration-coverage test pins
 * map ↔ server alignment.
 *
 * `generate_recipes_from_app_summary` is intentionally NOT exposed as
 * an MCP atom — it's invoked programmatically by skills via
 * MobileClient because it requires a Drive adapter + LLM function as
 * inputs that don't fit cleanly into MCP tool schemas.
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
import { ALLOWED_STEP_KEYS } from './mobile/backends/maestro.js';
import {
  resolveSelectorsInYaml,
  isStaticRecipesDirOverride,
  INSTALLED_STATIC_RECIPES_DIR,
  STATIC_RECIPES_DIR_ENV,
} from './mobile/recipe-resolver.js';
import { logInfo, logError } from './mobile/logging.js';
import { resolveBackend } from './mobile/backend-toggle.js';

// A bare `new MobileClient()` resolves its palette dir via
// `resolveStaticRecipesDir()`, so it honours `ACE_MOBILE_STATIC_RECIPES_DIR`
// without the server having to read the env var itself — which keeps the
// expansion + validation in one place (jjackson/ace#1062). A bad override
// throws HERE, at MCP startup, which is the loudest available signal: the
// server refuses to start rather than quietly serving the install palette.
let client: MobileClient;
try {
  client = new MobileClient();
} catch (e) {
  process.stderr.write(
    `[ace-mobile:error] startup FAILED constructing MobileClient: ${(e as Error).message}\n` +
    `[ace-mobile:error] ${(e as { remediation?: string }).remediation ?? ''}\n`,
  );
  throw e;
}

// One-line startup banner so "which backend is this MCP routing to?" is
// trivially answerable from the Claude Code MCP log. The resolver is
// re-run on every call, so this is only a snapshot of the value AT
// startup; a slash-command toggle mid-session won't re-emit this line.
//
// `palette_dir` is on the banner for the same reason it's on the
// `mobile_run_recipe` result: an operator live-validating a staged palette
// fix pre-merge must be able to SEE that the override took effect. Note
// that MCP subprocesses bind env at spawn, so a mid-session export does
// NOT reach this process — the banner is how you confirm the restart
// actually picked it up.
{
  const { backend, source, sessionFile, ppid } = resolveBackend();
  const cloudReady = client.cloud !== null;
  const paletteSource = isStaticRecipesDirOverride(client.staticRecipesDir)
    ? `override:${STATIC_RECIPES_DIR_ENV}`
    : 'install';
  process.stderr.write(
    `[ace-mobile] startup backend=${backend} source=${source} ppid=${ppid} ` +
    `cloud_ready=${cloudReady} session_file=${sessionFile} ` +
    `palette_dir=${client.staticRecipesDir} palette_source=${paletteSource}\n`,
  );
  if (paletteSource !== 'install') {
    process.stderr.write(
      `[ace-mobile] palette OVERRIDE active — recipes resolve against ` +
      `${client.staticRecipesDir}, NOT the plugin's own ` +
      `${INSTALLED_STATIC_RECIPES_DIR}\n`,
    );
  }
}

const server = new McpServer({ name: 'ace-mobile', version: '0.9.0' });

server.tool(
  'mobile_ensure_avd_running',
  {
    avdName: z.string().default(process.env.ACE_AVD_NAME ?? 'ACE_Pixel_API_34'),
    // OPTIONAL per-run test-user override (dimagi-internal/ace#1289).
    //
    // Omit it — the production default while ACE_PER_RUN_TEST_USER is off —
    // and the cold-boot registers the env-derived ACE_E2E_* user exactly as it
    // always has. `mergeTestUserOverride` returns the env object by reference
    // when this is absent, so "omitted" is byte-identical to the pre-#1289
    // behaviour, not merely equivalent.
    //
    // Supplied, it lets a caller register a run-scoped `+7426…` demo number
    // WITHOUT rewriting `.env`. That distinction is the point: every MCP
    // server reads `.env` at module load, so an `.env` write needs a full
    // Claude Code restart to take effect (CLAUDE.md § MCP changes need a full
    // Claude restart) — a call argument needs none. Pass only what varies per
    // run (phone / phoneLocal / countryCode / name); pin + backupCode are not
    // per-user secrets in the demo range and still come from env.
    //
    // LOCAL BACKEND ONLY — the cloud path throws
    // CLOUD_TEST_USER_OVERRIDE_UNSUPPORTED rather than silently registering
    // the env user.
    testUser: z
      .object({
        phone: z
          .string()
          .optional()
          .describe('Full E.164 demo number. MUST keep the +7426 prefix — upstream demo behaviour (OTP skip, Play Integrity bypass) is a startswith on it. Derive via lib/per-run-test-user.ts.'),
        phoneLocal: z
          .string()
          .optional()
          .describe('National number without the +7 country code (10 digits), as the registration recipe types it.'),
        countryCode: z.string().optional().describe('Country code for the registration screen. Always "+7" for the demo range.'),
        pin: z.string().optional().describe('Device PIN. Not a per-user secret in the demo range — normally omitted so ACE_E2E_PIN is used.'),
        backupCode: z.string().optional().describe('PersonalID backup code. Normally omitted so ACE_E2E_BACKUP_CODE is used.'),
        name: z.string().optional().describe('Display name written during registration; naming it after the run id makes the Connect workers table readable.'),
      })
      .optional()
      .describe(
        'Optional per-run test-user credential override (ace#1289). Omit for the env-derived ' +
          'ACE_E2E_* user (the default). Local AVD backend only.',
      ),
  },
  async ({ avdName, testUser }) => ({
    content: [
      {
        type: 'text',
        text: JSON.stringify(await client.ensureAvdRunning(avdName, testUser ? { testUser } : undefined), null, 2),
      },
    ],
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
    avdName: z.string().default(process.env.ACE_AVD_NAME ?? 'ACE_Pixel_API_34'),
    // All credential fields are optional and fall back to ACE_E2E_* env
    // vars in the handler — same env conventions used by
    // bootstrapConfigFromEnv() and the recipe-resolver placeholder map.
    // Caller args still win when present; this just lets skill callers
    // (qa-and-training) invoke the tool without re-plumbing every
    // credential through the orchestrator, and avoids server-side
    // "Request validation failed" responses from empty-string passes.
    phone: z.string().optional(),
    phoneLocal: z.string().optional(),
    countryCode: z.string().optional(),
    pin: z.string().optional(),
    backupCode: z.string().optional(),
    name: z.string().optional(),
  },
  async (args) => {
    const resolved = {
      avdName: args.avdName,
      phone: args.phone || process.env.ACE_E2E_PHONE || '',
      phoneLocal: args.phoneLocal || process.env.ACE_E2E_PHONE_LOCAL || '',
      countryCode: args.countryCode || process.env.ACE_E2E_COUNTRY_CODE || '',
      pin: args.pin || process.env.ACE_E2E_PIN || '',
      backupCode: args.backupCode || process.env.ACE_E2E_BACKUP_CODE || '',
      name: args.name || process.env.ACE_E2E_NAME || 'ACE Test',
    };
    // Surface the named missing field(s) here rather than punting to
    // ace-web's Pydantic validator, which returns a generic
    // "Request validation failed" with no field-level detail.
    const missing = (
      ['phone', 'phoneLocal', 'countryCode', 'pin', 'backupCode'] as const
    ).filter((k) => !resolved[k]);
    if (missing.length > 0) {
      const envHints = missing
        .map((k) => `ACE_E2E_${k === 'phoneLocal' ? 'PHONE_LOCAL' : k === 'countryCode' ? 'COUNTRY_CODE' : k === 'backupCode' ? 'BACKUP_CODE' : k.toUpperCase()}`)
        .join(', ');
      throw new Error(
        `mobile_register_test_user: required field(s) missing — ${missing.join(', ')}. ` +
          `Pass them as args, or set ${envHints} in the environment.`,
      );
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(await client.registerTestUser(resolved), null, 2) }],
    };
  },
);

server.tool(
  'mobile_run_recipe',
  {
    recipePath: z.string(),
    envVars: z.record(z.string()).default({}),
    // Run-scoped output ROOT, not the literal output dir. Each dispatch
    // writes into `<screenshotDir>/<recipeId>/` and the start-of-run wipe
    // (#756) targets only that subdir, so two journeys handed the same
    // root can never destroy each other's captures
    // (dimagi-internal/ace#1130). Read artifacts back from the returned
    // `screenshotsDir` / `screenshots[].path`, never by globbing the root.
    screenshotDir: z
      .string()
      .describe(
        'Run-scoped output ROOT. Artifacts land in <screenshotDir>/<recipeId>/ ' +
          '(dispatch-scoped, ace#1130); read them back from the returned screenshotsDir.',
      ),
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
    captureAllBoundaries: z.boolean().optional().describe('Tier 2 of the mapping ladder. EXPENSIVE — opens an extra ui-dump window at every top-level `runFlow` boundary, not just at `takeScreenshot` (one extra `maestro test` invocation per window; measured 3→10 and 1→9 on the two calibration recipes). Default false. Only turn this on for a targeted re-walk after an atlas-report.yaml reports `classification: unmapped-surface`.'),
  },
  async ({ recipePath, envVars, screenshotDir, avdName, captureAllBoundaries }) => {
    const resolvedAvd = avdName ?? process.env.ACE_AVD_NAME;
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(
          await client.runRecipe(recipePath, envVars, screenshotDir, resolvedAvd, { captureAllBoundaries }),
          null,
          2,
        ),
      }],
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
    // serial), which made Phase 6 pre-flight spuriously fail.
    const diag = client.useCloud ? await client.diagnose() : null;
    // `diagnose()` is dual-mode since ace#961; narrow on the discriminant
    // (inside `useCloud` it is always the cloud envelope).
    if (diag && diag.backend === 'cloud') {
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
    // separation is what lets ace-doctor and Phase 6 pre-flight call
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
    yaml: z.string().describe(`Maestro YAML body to validate. Standard ACE-recipe shape: appId frontmatter + \`---\` separator + step list. Validates step-key allowlist (${[...ALLOWED_STEP_KEYS].join(', ')}) and structural integrity (\`---\` separator present, appId in frontmatter, every step is a single-key object). Use this AFTER an ACE skill (running as a Claude Code session) writes Maestro YAML inline using its own LLM context — the mobile MCP does not bundle an LLM client, so YAML generation is the calling agent's responsibility, not this server's.`),
  },
  async ({ yaml }) => {
    // Static lint pass FIRST. Catches known-broken structural shapes
    // (e.g. inputText-scalar-with-sibling-option) with a precise
    // rule-named error before delegating to the Maestro parser, which
    // surfaces unhelpful "expected <block end>" errors for the same
    // class. NOTE: avoid stray apostrophes in this comment block —
    // scripts/dump-atom-schemas.ts walks chars with a string-aware but
    // comment-unaware parser. A bare `'` here starts a phantom string
    // and makes every subsequent atom invisible to docs/atom-schemas.md.
    const { lintRecipeText } = await import('./mobile/recipe-lint.js');
    const lint = lintRecipeText(yaml);
    if (!lint.ok) {
      const first = lint.violations[0];
      const msg = `recipe lint failed [${first.rule}] line ${first.line}: ${first.detail}. Remediation: ${first.remediation}`;
      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, valid: false, error: msg, violations: lint.violations }, null, 2) }], isError: true };
    }
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
    apkVersion: z.string().default('2.63.2').describe('Connect APK version. Maps to mcp/mobile/selectors/connect-<apkVersion>.yaml. Defaults to 2.63.2 (live drift-checked 2026-07-25); bump when re-baselining against a new APK. Pin PUBLISHED releases only — 2.63.3 is a GitHub draft with no assets.'),
  },
  async ({ yaml, apkVersion }) => {
    try {
      const r = resolveSelectorsInYaml(yaml, apkVersion);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            ok: r.unresolved.length === 0,
            yaml: r.yaml,
            unresolved: r.unresolved,
            unverified: r.unverified,
            apk_version: r.apkVersion,
            source_map: r.sourceMap,
          }, null, 2),
        }],
        isError: r.unresolved.length > 0,
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, error: msg }, null, 2) }],
        isError: true,
      };
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

server.tool(
  'mobile_set_location',
  {
    avdName: z.string().default(process.env.ACE_AVD_NAME ?? 'ACE_Pixel_API_34'),
    longitude: z
      .number()
      .describe('Longitude (X). NOTE: longitude is the FIRST coordinate (emulator `geo fix` console convention) — pass it before latitude to avoid the classic transposition footgun.'),
    latitude: z.number().describe('Latitude (Y).'),
    altitude: z.number().optional().describe('Altitude in metres (default 480).'),
    satellites: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Number of satellites in the simulated fix (default 12). >= 4 yields a usable fix; more improves the reported accuracy shown in a CommCare geopoint accuracy readout.'),
  },
  async ({ avdName, longitude, latitude, altitude, satellites }) => ({
    content: [{ type: 'text', text: JSON.stringify(await client.setLocation(avdName, longitude, latitude, altitude, satellites), null, 2) }],
  }),
);

// ── Session video spool ──────────────────────────────────────────────
//
// Every LOCAL `mobile_run_recipe` call records an mp4 and drops a copy
// in a spool keyed by THIS MCP's ppid (`mcp/mobile/video-spool.ts`).
// Skills sweep the spool at the end of a phase and upload what they
// find.
//
// These two atoms exist because the spool key is the one thing a skill
// cannot resolve: the ppid belongs to the MCP process, not the skill.
// The previous contract had both screenshot-capture SKILL.md files
// telling a runtime LLM to hand-resolve `~/.ace/mobile-videos/<ppid>/`
// and `rm -rf` it — which invites globbing `mobile-videos/*/` and
// deleting a CONCURRENT session's spool, or skipping the sweep because
// the path couldn't be resolved (leaving per-ppid dirs with no GC).

server.tool(
  'mobile_list_session_videos',
  {},
  async () => ({
    content: [
      { type: 'text', text: JSON.stringify(client.listSessionVideos(), null, 2) },
    ],
  }),
);

server.tool(
  'mobile_clear_session_videos',
  {},
  async () => ({
    content: [
      { type: 'text', text: JSON.stringify(client.clearSessionVideos(), null, 2) },
    ],
  }),
);

// ── Diagnostics + cloud-only admin atoms ─────────────────────────────
//
// `mobile_diagnose` works on BOTH backends (ace#961) — discriminate the
// result on its `backend` field. `mobile_restart_runner` targets the
// ace-web cloud backend specifically and throws
// `MobileError(CLOUD_ONLY_OPERATION)` against the local AVD backend —
// skills that need it should gate on the cloud toggle, OR catch the
// error and skip.
//
// `mobile_patch_launch_script` was REMOVED 2026-08-14 (ace#1113). It took a
// full bash body and replaced /usr/local/bin/ace-emulator-launch on the
// shared cloud runner, then restarted the service — arbitrary code execution
// on shared infra from one model-authored argument, in a session that
// routinely ingests untrusted inbound content. It had no production caller
// (only tests + a "diagnostic/debug" playbook mention), so deleting it beat
// gating it: deletion is the only mitigation a prompt injection cannot
// defeat. The launch script belongs in version control, shipped by the
// normal deploy; if in-session iteration is ever needed again, add a TYPED
// config atom (avdName / coldBoot / timeouts rendered server-side from a
// template) rather than a free-form script body.

server.tool(
  'mobile_diagnose',
  // Deliberately arg-less on both backends, so `docs/atom-schemas.md`
  // (and its staleness gate) is unaffected by the dual-mode change.
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

// Graceful self-cleanup: when the MCP subprocess is told to exit
// (Claude Code closing the session, host shutdown, manual kill), KILL
// the adb/qemu daemons we spawned on our allocated ports, THEN drop
// our session lock.
//
// The kill-before-release order is load-bearing. An earlier version
// of this handler released the lock first and called it good — but
// adb/qemu daemonize via double-fork and outlive the MCP that spawned
// them, so the moment the lock was gone, future reapers had no record
// of which ports to clean and the daemons leaked forever. Live-
// surfaced 2026-05-21 during the parallel-session test cycle: cross-
// session orphans accumulated because graceful shutdowns weren't
// killing daemons. Reproducer pattern: spawn MCP → mobile_ensure_avd_running
// → exit MCP gracefully → adb on 5037 + qemu on 5554 still running,
// no lock at ~/.ace/sessions/* to point at them.
//
// The hard-kill case (-9, OOM-kill, crash) is still covered by the
// PID-liveness-probing reaper: the lock SURVIVES the kill, future
// allocator sees a stale lock, kills processes on its ports, removes
// the lock. So either path produces the same end state.
//
// We don't register `process.on('exit', ...)` because that handler
// must be sync and ESM `import` is async; the SIGINT/SIGTERM/SIGHUP
// handlers cover every signal-driven shutdown path, and the reaper is
// the safety net for everything else.
{
  let releasing = false;
  const release = async () => {
    if (releasing) return;
    releasing = true;
    try {
      const { cleanupSessionDaemons } = await import('./mobile/session-lock.js');
      cleanupSessionDaemons(process.pid);
    } catch {
      /* ignore — best-effort */
    }
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => {
      void release().finally(() => process.exit(0));
    });
  }
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logInfo('ace-mobile MCP server listening on stdio');
}

main().catch((e) => {
  logError('fatal', e);
  process.exit(1);
});
