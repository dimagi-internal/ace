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
    expectedCount: 50,
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
    expectedCount: 16,
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
    expectedCount: 37,
    // gdrive bridges five Google APIs — one prefix per surface plus a
    // small set of cross-surface helpers (manifest generator, forms
    // reader, OAuth-personal Drive read, YAML patch helper, opp-path
    // resolver, run_state.yaml validator + classifier).
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
      'validate_run_state',
      'classify_phase_writeback',
    ],
  },
};

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
