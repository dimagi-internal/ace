/**
 * ACE Mobile MCP Server
 *
 * Exposes 19 atomic mobile capabilities backed by Maestro + adb +
 * Playwright, or — on the `lease` backend (the default where no AVD is
 * provisioned) — a leased android-emulator machine driven through
 * canopy-web's capability broker. Routing → backend lives in
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
  // ace#2114 — stdout IS this process's JSON-RPC transport, so nothing
  // diagnostic may go there. dotenv v17 prints `◇ injected env (N) …` via
  // console.log unless silenced, and it offers no stderr option. Every
  // diagnostic this server emits (see `[ace-plugin-data-dir]` above) is on
  // stderr; this makes dotenv obey the same rule.
  quiet: true,
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
  loadSelectorTypes,
  isStaticRecipesDirOverride,
  INSTALLED_STATIC_RECIPES_DIR,
  STATIC_RECIPES_DIR_ENV,
} from './mobile/recipe-resolver.js';
import { logInfo, logError } from './mobile/logging.js';
import { resolveBackend } from './mobile/backend-toggle.js';
import { installToolErrorGuard, serializeMobileToolError } from './mobile/tool-error.js';
import { withRecipeProgress } from './mobile/recipe-progress.js';

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
  const { backend, source, sessionFile, ppid, defaultReason } = resolveBackend();
  const leaseReady = client.lease !== null;
  const paletteSource = isStaticRecipesDirOverride(client.staticRecipesDir)
    ? `override:${STATIC_RECIPES_DIR_ENV}`
    : 'install';
  process.stderr.write(
    `[ace-mobile] startup backend=${backend} source=${source} ppid=${ppid} ` +
    `lease_ready=${leaseReady} session_file=${sessionFile} ` +
    (defaultReason ? `default_reason="${defaultReason}" ` : '') +
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

// EVERY atom registered below this line is error-guarded (ace#2223).
//
// (Written without naming the registration call literally: the oracle in
// `test/lib/atom-schema-parser.test.ts` counts registrations with a plain
// regex over the file, so the phrase in a COMMENT reads to it as a
// nineteenth atom and reddens CI. The parser under test is comment-aware
// since #2192; its test's own control is not.)
//
// Without it, a tool callback that throws is caught by the SDK, which answers
// with `createToolError(error.message)` — the message and nothing else. Every
// MobileError in `mcp/mobile/errors.ts` authors a `remediation` that IS the
// diagnosis, and all of it was being discarded here. On
// spark-facilitator/20260907-1120 that turned an AVD-contention halt into a
// cause-free string, and routed the operator to `/ace:mobile-bootstrap` when
// the code had already written the pool/contention answer.
//
// Installed on the SERVER, not per call site, so an atom added later is
// covered whether or not its author knows this exists. MUST stay above the
// first registration.
installToolErrorGuard(server);

server.tool(
  'mobile_ensure_avd_running',
  {
    avdName: z
      .string()
      .default(process.env.ACE_AVD_NAME ?? 'ACE_Pixel_API_34')
      .describe(
        'Local: the AVD to cold-boot. Lease: a non-cc-* name leases cc-<ACE_CONNECT_APK_VERSION>, the CommCare the ' +
          'selector map is for (a cc-* name must match it). The lease result carries `lease` (lease_id, expires_at, ' +
          'idle_release_s, state, baseline parity) — a lease idle for idle_release_s (900 s) with no call is released.',
      ),
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
    // Honoured on both backends: the lease registers from this client too.
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
        'Optional per-run test-user credential override (ace#1289). Omit (the default) and the device signs in as ' +
          'a Connect test worker this session checks out from the pool (ace#2955; `test_worker` in the result names ' +
          'the slot and the lock). Passed, that identity is used UNLOCKED — no pool slot describes it. ' +
          'Honoured on both backends (local AVD and lease).',
      ),
    oppSlug: z.string().optional().describe('Opportunity slug this session is driving (ace#1821). Recorded in the session lock; if another live session on this host names the same opp, a WARNING naming its pid, run and AVD is printed. Never a refusal — two sessions on one opp is a legitimate operator choice, and only same-account sessions are visible at all. Falls back to ACE_OPP_SLUG.'),
    runId: z.string().optional().describe('Run id within that opportunity, recorded in the same session lock and named in the collision warning. Only meaningful alongside oppSlug. Falls back to ACE_RUN_ID.'),
    prewarm: z
      .boolean()
      .optional()
      .describe(
        'true = start the device booting and return AT ONCE, without waiting, registering or verifying. Lease: starts ' +
          '(or joins) the acquire so the multi-minute boot overlaps your other prep; the next normal call joins it and ' +
          'heals as usual — make that call within idle_release_s (900 s) of the machine becoming ready. Local: a no-op. ' +
          'Phase 6 calls this first (qa-and-training Step 0). If a pre-flight gate then halts, call mobile_stop_avd.',
      ),
  },
  async ({ avdName, testUser, oppSlug, runId, prewarm }) => ({
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          prewarm ? await client.prewarmAvd(avdName) : await client.ensureAvdRunning(
            avdName,
            testUser || oppSlug || runId ? { testUser, oppSlug, runId } : undefined,
          ),
          null,
          2,
        ),
      },
    ],
  }),
);

server.tool(
  'mobile_stop_avd',
  { avdName: z.string() },
  async ({ avdName }) => {
    // Also releases every Connect test worker this session held (ace#2955).
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
  {
    avdName: z.string(),
    apkPath: z
      .string()
      .describe(
        'Local APK path, or an https:// / s3:// URI. On the lease a local APK is uploaded and installed once per ' +
          'machine (cached by content hash), so a repeat call is a no-op; a new machine installs it again.',
      ),
  },
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
    slot: z
      .string()
      .optional()
      .describe(
        'Sign the device in as this Connect test worker (e.g. "worker-3"). It MUST be a slot this session holds — ' +
          'check workers out first with mobile_checkout_test_workers. Takes precedence over the credential fields. ' +
          'Omit slot AND phone to sign in as the session\'s own worker (checked out from the pool if none is held, ace#2955).',
      ),
    // Explicit credential fields: an identity outside the pool, used UNLOCKED
    // (e.g. the add-worker walk registering a new number before it is stored
    // in 1Password). Missing fields fall back to ACE_E2E_*; caller args win
    // when present, and a blank pass never blanks a working credential.
    phone: z.string().optional().describe('Explicit identity (unlocked). Must keep the +7426 demo prefix.'),
    phoneLocal: z.string().optional(),
    countryCode: z.string().optional(),
    pin: z.string().optional(),
    backupCode: z.string().optional(),
    name: z.string().optional(),
  },
  async (args) => ({
    content: [{ type: 'text', text: JSON.stringify(await client.registerTestUserForAtom(args), null, 2) }],
  }),
);

// ── Connect test-worker pool (ace#2955) ───────────────────────────
//
// Each device session signs in as ONE Connect test worker, checked out
// exclusively through canopy-web's `test-worker` pool capability, so two
// sessions on any two machines never share a worker (the ace#2934 failure).
// mobile_ensure_avd_running checks one out on its own; these two atoms are for
// multi-worker tests (e.g. case sharing: four workers on one opportunity).

server.tool(
  'mobile_checkout_test_workers',
  {
    count: z
      .number()
      .int()
      .min(1)
      .max(16)
      .describe(
        'Total workers this session should hold, INCLUDING the one the device is signed in as. Waits up to 10 min ' +
          'for queued slots, then fails TEST_WORKER_POOL_EXHAUSTED naming who holds each slot — it never shares one. ' +
          'More than 1 requires the pool lock to be live (TEST_WORKER_POOL_UNAVAILABLE names the publish step).',
      ),
  },
  async ({ count }) => ({
    content: [{ type: 'text', text: JSON.stringify(await client.checkoutTestWorkers(count), null, 2) }],
  }),
);

server.tool(
  'mobile_release_test_workers',
  {
    slots: z
      .array(z.string())
      .optional()
      .describe('Slots to release. Omitted: every held worker the device is NOT signed in as.'),
    all: z
      .boolean()
      .optional()
      .describe('true = release the signed-in worker too (only when this device is done with it). mobile_stop_avd releases everything.'),
  },
  async ({ slots, all }) => ({
    content: [{ type: 'text', text: JSON.stringify(await client.releaseTestWorkers({ slots, all }), null, 2) }],
  }),
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
  async ({ recipePath, envVars, screenshotDir, avdName, captureAllBoundaries }, extra) => {
    const resolvedAvd = avdName ?? process.env.ACE_AVD_NAME;
    try {
      // MCP progress (ace#2877): Claude Code aborts a stdio tool call that
      // sends "no response or progress" for 1800s, which killed a healthy
      // 25-form Learn walk mid-flight. `withRecipeProgress` sends a real
      // event per chunk plus a bounded 30s heartbeat when the request
      // carries a progressToken — see `mobile/recipe-progress.ts`.
      const result = await withRecipeProgress(extra, (onProgress) =>
        client.runRecipe(recipePath, envVars, screenshotDir, resolvedAvd, { captureAllBoundaries, onProgress }),
      );
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2),
        }],
      };
    } catch (e) {
      // A DISPATCH THAT DID REAL WORK MUST NOT REPORT AS IF IT DID NONE
      // (dimagi-internal/ace#1822). Still an error — `isError: true`, and the
      // message is the original, untouched. What is added is the record of
      // what the dispatch actually captured before it died, which a bare
      // error string cannot carry.
      //
      // This matters most where the work is UNREPEATABLE. Learn completion is
      // one-way per (test user, opportunity) (#568/#570), so a walk that
      // submitted and then died at session teardown leaves frames that can
      // never be produced again; without this the caller sees a string, the
      // skill's "screenshots come ONLY from a `status: pass` execution in
      // THIS run" rule discards the directory, and the obvious response —
      // re-run the leg — is impossible.
      //
      // The `status`/`message`/`code`/`remediation`/`diagnostics` half of this
      // envelope is the shared serializer (ace#2223) — this handler used to
      // build it by hand and, exactly like the SDK's own fallback, omitted
      // `remediation`. What stays local is the part only this atom knows: the
      // partial result and the note about it.
      const partial = (e as { partialResult?: unknown }).partialResult;
      const forensics = (e as { failureForensics?: unknown }).failureForensics;
      return serializeMobileToolError(e, {
        ...(partial && typeof partial === 'object' ? partial : {}),
        failureForensics: forensics,
        note:
          'The dispatch THREW. Any screenshots/videos listed above were genuinely captured ' +
          'before the failure and are on disk at screenshotsDir — do not assume the run ' +
          'produced nothing (ace#1822).',
      });
    }
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
    // Lease short-circuit: there is no local adb port to probe. Without this
    // branch the atom always returned `healthy: false` on a remote backend
    // (the local `findRunningAvd` never finds a remote serial), which made
    // Phase 6 pre-flight spuriously fail.
    const diag = client.useLease ? await client.diagnose() : null;
    // Lease: the in-VM `ace-mobile diagnose` reports the same adb device list.
    // There is no runner unit; a ready lease whose emulator adb can see is the
    // equivalent signal. With no lease held, nothing is booted — say so.
    if (diag && diag.backend === 'lease') {
      const devices = (diag.adb_devices as Array<{ serial: string; state: string }> | undefined) ?? [];
      const sawDevice = devices.some((d) => d.state === 'device');
      const healthy = diag.lease?.status === 'ready' && sawDevice;
      const reason = healthy
        ? undefined
        : !diag.lease
          ? 'no lease held — mobile_ensure_avd_running acquires one'
          : diag.lease.status !== 'ready'
            ? `lease ${diag.lease.lease_id} is ${diag.lease.status} (expected ready)`
            : 'leased emulator not visible to adb';
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            healthy,
            reason,
            adbPort: null,
            portKind: null,
            driverPackages: null,
            serial: devices[0]?.serial,
            backend: 'lease',
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
        content: [{ type: 'text', text: JSON.stringify({ healthy: false, reason: `AVD ${avdName} not booted (no emulator-NNNN serial in adb devices)`, adbPort: null, portKind: null, driverPackages: null }, null, 2) }],
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
    apkVersion: z.string().default('2.64.0').describe('Connect APK version whose selector map the map-aware lint rules read (mcp/mobile/selectors/connect-<apkVersion>.yaml). Used to type-check value-position `${SELECTOR:name}` placements (if the map is missing, that one rule abstains and every other check still runs) and to gate APK-specific rules such as date-picker-next-cell-tap-noop (ace#2518).'),
  },
  async ({ yaml, apkVersion }) => {
    // Static lint pass FIRST. Catches known-broken structural shapes
    // (e.g. inputText-scalar-with-sibling-option) with a precise
    // rule-named error before delegating to the Maestro parser, which
    // surfaces unhelpful "expected <block end>" errors for the same
    // class. (The old apostrophe ban in this comment block is retired:
    // scripts/dump-atom-schemas.ts now parses with the TypeScript compiler
    // API, so comments are the scanner's problem — ace#2192.)
    const { lintRecipeText } = await import('./mobile/recipe-lint.js');
    // Map-aware rules need the ACTIVE selector map. A missing/unparseable map
    // must never turn a lint pass into a hard failure — the rule abstains and
    // every text-only rule still runs.
    let selectorTypes: Record<string, 'id' | 'text' | 'point'> | undefined;
    try {
      selectorTypes = loadSelectorTypes(apkVersion);
    } catch {
      selectorTypes = undefined;
    }
    const lint = lintRecipeText(yaml, { selectorTypes, apkVersion });
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
      // Superset of the old `{ok, valid, error}` shape — existing consumers
      // read the same keys, and an authored `remediation` now rides along
      // instead of being dropped here the way it was at the SDK boundary
      // (ace#2223).
      return serializeMobileToolError(e, { ok: false, valid: false, error: e.message });
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  },
);

server.tool(
  'mobile_resolve_selectors',
  {
    yaml: z.string().describe('Maestro YAML body containing `${SELECTOR:logical-name}` placeholders to resolve.'),
    apkVersion: z.string().default('2.64.0').describe('Connect APK version. Maps to mcp/mobile/selectors/connect-<apkVersion>.yaml. Defaults to 2.64.0 (live-calibrated 2026-09-06, ace#1997). Pin only releases carrying an .apk ASSET — a stronger test than "published": 2.63.3 IS published but ships only an .aab (verified 2026-09-06), and 2.64.0 reverted to the 2.62.0 asset name app-commcare-release.apk.'),
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
      // Same superset treatment as mobile_validate_recipe (ace#2223). This one
      // matters concretely: a bad ACE_MOBILE_STATIC_RECIPES_DIR raises
      // STATIC_RECIPES_DIR_INVALID, whose remediation names the exact palette
      // directory to point at — the one thing an operator live-validating a
      // staged palette fix needs, and could not previously see.
      const msg = e instanceof Error ? e.message : String(e);
      return serializeMobileToolError(e, { ok: false, error: msg });
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

// ── Diagnostics ───────────────────────────────────────────────────
//
// `mobile_diagnose` works on BOTH backends (ace#961) — discriminate the
// result on its `backend` field. `mobile_restart_runner` was REMOVED
// 2026-10-14 with ace-web's cloud emulator, the only backend that had a
// long-lived runner to restart; on a lease, release + re-acquire
// (`mobile_stop_avd` then `mobile_ensure_avd_running`) is the restore.
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
      // Test-worker leases FIRST and synchronously: a parent that follows
      // SIGTERM with SIGKILL during the async cleanup below would otherwise
      // pin each held slot for idle_release_s (ace#3033).
      try {
        client?.workers?.releaseHeldSync(sig);
      } catch {
        /* best-effort — the exit hook and idle release cover the rest */
      }
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
