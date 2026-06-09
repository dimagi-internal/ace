/**
 * Cross-server registration-coverage tests.
 *
 * Catches the "tool added to a handler module but not registered on the
 * MCP server" class of bug — and its inverse. Each `mcp/<server>-server.ts`
 * file calls `server.tool('name', ...)` for every atom it exposes; this
 * test parses those calls and asserts three invariants per server:
 *
 *   1. Snapshot count: the number of `server.tool(...)` calls matches an
 *      explicit expected count. Update intentionally when shipping atoms.
 *   2. Prefix allowlist: every tool name starts with one of the prefixes
 *      this server is allowed to register.
 *   3. No duplicate tool registrations within a file.
 *
 * For servers whose `mcp/<server>/capability-map.ts` is the canonical
 * atom roster, opt into a fourth invariant via `capabilityMap`:
 *
 *   4. Map ↔ server alignment: every map key has a corresponding
 *      `<prefix><key>` server registration, and every prefixed server
 *      registration has a map entry.
 *
 * As of 2026-05-14 only OCS has perfect alignment. Connect, mobile, and
 * gdrive each have intentional or accidental drift — see PR body for
 * the inventory; enable `capabilityMap` for each once that drift is
 * resolved.
 *
 * This test parses statically: the *-server.ts files do top-level
 * `await server.connect(transport)`, so importing them would connect
 * stdio.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CAPABILITY_MAP as OCS_MAP } from '../../mcp/ocs/capability-map.js';
import { CAPABILITY_MAP as MOBILE_MAP } from '../../mcp/mobile/capability-map.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function extractToolRegistrations(relpath: string): string[] {
  const src = fs.readFileSync(path.join(REPO_ROOT, relpath), 'utf-8');
  // Multiline-tolerant: matches `server.tool(\n  'name',` and `server.tool('name',`.
  const re = /\bserver\.tool\s*\(\s*['"]([a-z][a-z0-9_]*)['"]/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}

interface ServerSpec {
  file: string;
  expectedCount: number;
  allowedPrefixes: string[];
  capabilityMap?: Record<string, unknown>;
  capabilityPrefix?: string;
}

// Snapshot of registered atoms per server (as of 2026-05-14).
// Update intentionally when shipping a new atom.
const SERVERS: Record<string, ServerSpec> = {
  connect: {
    file: 'mcp/connect-server.ts',
    expectedCount: 51,
    // `connect_*` are Connect atoms; `commcare_*` are CommCare HQ atoms
    // (build/release/upload-multimedia) registered alongside because they
    // close the LLO-deploy loop through the same MCP.
    allowedPrefixes: ['connect_', 'commcare_'],
    // capabilityMap intentionally omitted — `preflight_learn_app_user` is
    // a HQ helper that lives outside the Connect capability-map. Add an
    // explicit exemption list and enable when ready.
  },
  ocs: {
    file: 'mcp/ocs-server.ts',
    expectedCount: 32,
    allowedPrefixes: ['ocs_'],
    capabilityMap: OCS_MAP,
    capabilityPrefix: 'ocs_',
  },
  mobile: {
    file: 'mcp/mobile-server.ts',
    expectedCount: 17,
    allowedPrefixes: ['mobile_'],
    // capabilityMap enabled in PR-R (2026-05-25) after aligning the map
    // with the server registrations. The previously-extra
    // `generate_recipes_from_app_summary` is now documented in the
    // capability-map source as "intentionally not registered as an MCP
    // atom" (programmatic-only); the previously-missing 5 atoms
    // (validate_recipe, resolve_selectors, diagnose, restart_runner,
    // patch_launch_script) now appear in both places.
    capabilityMap: MOBILE_MAP,
    capabilityPrefix: 'mobile_',
  },
  decisions: {
    file: 'mcp/decisions-server.ts',
    expectedCount: 1,
    allowedPrefixes: ['decisions_'],
  },
  'google-drive': {
    file: 'mcp/google-drive-server.ts',
    expectedCount: 42,
    // gdrive bridges five Google APIs — one prefix per surface plus a
    // small set of cross-surface helpers (manifest generator, forms
    // reader, OAuth-personal Drive read, YAML patch helper, opp-path
    // resolver, current-run discoverer, run_state.yaml validator +
    // classifier, phase-artifact verifier, phase-products verifier,
    // run-folder README renderer, decisions-log renderer).
    allowedPrefixes: [
      'drive_',
      'sheets_',
      'docs_',
      'slides_',
      'read_personal_drive_doc',
      'update_yaml_file',
      'generate_inputs_manifest',
      'get_google_form_definition',
      'resolve_opp_path',
      'resolve_current_run_id',
      'validate_run_state',
      'classify_phase_writeback',
      'verify_phase_artifacts',
      'verify_phase_products',
      'render_run_readme',
      'render_decisions_log',
    ],
  },
};

/**
 * Class-level preventer for the "MCP server boots without loading .env"
 * bug class.
 *
 * Surfaced 2026-05-26 in the bednet-spot-check pre-flight: `ace-gdrive`
 * was the only MCP server missing `dotenvConfig(...)` at boot, so every
 * gdrive atom that read `process.env.ACE_DRIVE_ROOT_FOLDER_ID` (et al.)
 * saw undefined — including `resolve_opp_path`, which is the very first
 * atom every `/ace:run` calls. The other three ace-* MCPs (connect, ocs,
 * mobile) had been loading dotenv since their original implementations;
 * `decisions` was added in this same fix for consistency.
 *
 * (connect-labs is no longer a stdio server — it's a native `type: "http"`
 * plugin.json entry, so there's no `mcp/*-server.ts` source to env-check.
 * Its auth header comes from `scripts/labs-auth-headers.mjs`, covered by
 * `test/mcp/connect-labs/headers-helper.test.ts`.)
 *
 * Rule: every `mcp/*-server.ts` source MUST call either `dotenvConfig(`
 * or `parseEnvFile(` before any atom handler runs.
 */
const ENV_LOADER_PATTERNS = [/\bdotenvConfig\s*\(/, /\bparseEnvFile\s*\(/];
const SERVER_FILES_FOR_ENV_CHECK = [
  'mcp/google-drive-server.ts',
  'mcp/connect-server.ts',
  'mcp/ocs-server.ts',
  'mcp/mobile-server.ts',
  'mcp/decisions-server.ts',
];

describe('MCP server env loading (boot-time)', () => {
  it.each(SERVER_FILES_FOR_ENV_CHECK)(
    '%s loads .env at boot (calls dotenvConfig or parseEnvFile)',
    (relpath) => {
      const src = fs.readFileSync(path.join(REPO_ROOT, relpath), 'utf-8');
      const hasLoader = ENV_LOADER_PATTERNS.some((re) => re.test(src));
      expect(
        hasLoader,
        `${relpath} must call dotenvConfig() or parseEnvFile() at boot ` +
          `so atoms can read ACE_* env vars from <plugin-data-dir>/.env`,
      ).toBe(true);
    },
  );
});

/**
 * Class-level preventer for the "MCP server file exists but is not wired
 * into plugin.json" bug class.
 *
 * Surfaced 2026-05-27 in the bednet-spot-check Phase 1 run: the
 * `mcp/decisions-server.ts` file shipped in PR #496 (typed
 * `decisions_append_rows` atom) was never added to
 * `.claude-plugin/plugin.json`'s `mcpServers` map. Result: every Phase 1
 * subagent silently failed to access the typed atom, fell back to a
 * direct `drive_create_file` write, copied the SKILL.md example's `rows:`
 * parameter name as the YAML top-level key (instead of the canonical
 * `decisions:`), and shipped malformed decisions.yaml files that ace-web
 * silently parsed as 0 rows. None of the existing tests caught this — the
 * snapshot-count test verified the file had 1 tool, but didn't cross-check
 * that the server was actually loaded.
 *
 * Rule: every `mcp/*-server.ts` file MUST have a corresponding entry in
 * `.claude-plugin/plugin.json.mcpServers` whose `args[1]` path resolves
 * to that file. Server-name → file mapping is many-to-one (we register
 * `google-drive-server.ts` under the name `ace-gdrive`); the cross-check
 * is path-based, not name-based.
 */
describe('MCP server plugin.json registration', () => {
  it('every mcp/*-server.ts is wired into .claude-plugin/plugin.json', () => {
    const mcpDir = path.join(REPO_ROOT, 'mcp');
    const serverFiles = fs
      .readdirSync(mcpDir)
      .filter((f) => f.endsWith('-server.ts'))
      .map((f) => `mcp/${f}`);

    const pluginJson = JSON.parse(
      fs.readFileSync(
        path.join(REPO_ROOT, '.claude-plugin/plugin.json'),
        'utf-8',
      ),
    );
    const registered = new Set<string>();
    for (const entry of Object.values(pluginJson.mcpServers ?? {}) as Array<{
      args?: string[];
    }>) {
      for (const arg of entry.args ?? []) {
        // Args contain ${CLAUDE_PLUGIN_ROOT}/mcp/<file>.ts — strip the
        // placeholder and any leading slash to match against serverFiles.
        const m = arg.match(/mcp\/[A-Za-z0-9_-]+-server\.ts$/);
        if (m) registered.add(m[0]);
      }
    }

    const unregistered = serverFiles.filter((f) => !registered.has(f));
    expect(
      unregistered,
      'MCP server files present on disk but not registered in ' +
        '.claude-plugin/plugin.json.mcpServers. Without registration, ' +
        'agents cannot reach the server\'s typed atoms — they fall back ' +
        'to ad-hoc drive_create_file writes that bypass schema validation ' +
        '(2026-05-27 decisions-server.ts regression).',
    ).toEqual([]);
  });
});

describe('MCP server tool registration', () => {
  describe.each(Object.entries(SERVERS))('%s', (_name, spec) => {
    const tools = extractToolRegistrations(spec.file);

    it('registers the expected number of tools (update snapshot when shipping atoms)', () => {
      expect(tools, `${spec.file} actual tools: ${JSON.stringify(tools)}`)
        .toHaveLength(spec.expectedCount);
    });

    it('uses only the allowed prefixes for this server', () => {
      const offenders = tools.filter(
        (t) => !spec.allowedPrefixes.some((p) => t === p || t.startsWith(p)),
      );
      expect(offenders, `tools in ${spec.file} with unrecognized prefix`).toEqual([]);
    });

    it('has no duplicate tool names', () => {
      const seen = new Set<string>();
      const dupes: string[] = [];
      for (const t of tools) {
        if (seen.has(t)) dupes.push(t);
        seen.add(t);
      }
      expect(dupes, `${spec.file}: duplicate tool registrations`).toEqual([]);
    });

    if (spec.capabilityMap && spec.capabilityPrefix) {
      const prefix = spec.capabilityPrefix;
      const map = spec.capabilityMap;
      it('every capability-map key is registered on the server', () => {
        const registeredStripped = new Set(
          tools
            .filter((t) => t.startsWith(prefix))
            .map((t) => t.slice(prefix.length)),
        );
        const missing = Object.keys(map).filter((k) => !registeredStripped.has(k));
        expect(missing,
          `${spec.file} is missing registrations for capability-map atoms`).toEqual([]);
      });

      it('every prefixed server tool has a capability-map entry (no orphan atoms)', () => {
        const orphans = tools
          .filter((t) => t.startsWith(prefix))
          .map((t) => t.slice(prefix.length))
          .filter((k) => !(k in map));
        expect(orphans,
          `${spec.file} registers tools missing from capability-map`).toEqual([]);
      });
    }
  });
});
