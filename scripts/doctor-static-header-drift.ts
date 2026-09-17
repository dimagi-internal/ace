/**
 * scripts/doctor-static-header-drift.ts
 *
 * The LIVE half of the `static_header_drift` probe (dimagi-internal/ace#2159).
 * Answers ONE question, for EVERY user-scope MCP entry that pins one:
 * *is the static `Authorization` header still the credential ACE is
 * configured with?*
 *
 * Backing dispatcher for two surfaces in `bin/ace-doctor`, mirroring
 * `doctor-nova-header.ts`:
 *   --format=yaml   → the `static_header_drift:` block in --preflight
 *                     (a HALT class: it runs before Phase 1, not at Phase 7)
 *   --format=lines  → PASS/WARN lines for the human [Auth liveness] block
 *
 * WHY THE LABS PROBES COULD NOT ALREADY SEE THIS. `connect_labs_env`,
 * `connect_labs_mcp_reachable` and `connect_labs_connect_oauth` all read
 * `LABS_MCP_TOKEN` from `.env` and curl labs with it. On the reporting run that
 * token returned HTTP 200 while the session's own connection returned 401 —
 * they were green on a credential the session was not using. `bin/ace-doctor`
 * never reads `~/.claude.json` at all (`grep -n 'claude.json' bin/ace-doctor`
 * → zero hits before this change), so the file that decides the outcome was
 * simply unobserved.
 *
 * SELF-HEAL (--heal). When drift is PROVEN and this probe owns the entry,
 * re-point it at the configured credential. Precedent and reasoning are
 * `doctor-nova-header.ts`'s: the state is proven, so there is nothing for a
 * human to decide. Entries whose heal belongs to another probe (`nova` →
 * `nova_header_readiness`) are REPORTED and not written — two probes editing
 * one entry in a single doctor run is how you get contradictory output.
 *
 * Status stays `fail` after a successful heal. MCP subprocesses bind their
 * headers at connection time, so the restart remains mandatory
 * (`CLAUDE.md § MCP changes need a full Claude restart`).
 *
 * NEVER PRINTS A TOKEN. The values here are live credentials; the classifier
 * returns only verdicts, and the heal path redacts the key out of any error
 * text before it is printed.
 *
 * Exit status: ALWAYS 0. A probe that crashes must never take doctor down.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolvePluginDataDir } from '../lib/plugin-data-dir.js';
import {
  STATIC_HEADER_SERVERS,
  classifyAllStaticHeaderDrift,
  remediationForStaticHeaderDrift,
  staticAuthBearer,
  type StaticHeaderDriftEntry,
} from '../lib/static-header-drift.js';

/**
 * Hand-rolled `.env` read — same rationale as `doctor-nova-header.ts`: this
 * script's stdout IS the YAML block spliced into the preflight snapshot, and
 * dotenvx writes an "injected env (N)" banner to stdout that would break the
 * orchestrator's parse.
 */
function envCandidates(): string[] {
  const dataDir = resolvePluginDataDir(import.meta.url);
  return [
    dataDir ? path.join(dataDir, '.env') : '',
    path.join(process.env.HOME || '', '.claude/plugins/data/ace-ace/.env'),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env'),
    path.join(process.env.HOME || '', '.ace/env.sh'),
  ].filter(Boolean);
}

function readConfiguredKey(name: string): string {
  // Matches both `KEY=…` and `export KEY=…`.
  const re = new RegExp(`^\\s*(?:export\\s+)?${name}=(.*)$`);
  for (const file of envCandidates()) {
    if (!fs.existsSync(file)) continue;
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      const m = line.match(re);
      if (!m) continue;
      const value = m[1].trim().replace(/^['"]|['"]$/g, '');
      // An unresolved 1Password reference is not a credential.
      if (!value || value.startsWith('op://')) continue;
      return value;
    }
  }
  return '';
}

interface UserScopeEntry {
  server: string;
  headers: Record<string, string> | null;
  url: string;
}

/** Every `mcpServers` entry in `~/.claude.json`. `null` when unreadable. */
function readUserScopeEntries(): UserScopeEntry[] | null {
  const file = path.join(process.env.HOME || '', '.claude.json');
  if (!fs.existsSync(file)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const servers = j?.mcpServers;
    if (!servers || typeof servers !== 'object') return [];
    return Object.entries(servers).map(([server, cfg]) => ({
      server,
      headers: ((cfg as { headers?: Record<string, string> })?.headers ?? null) as Record<
        string,
        string
      > | null,
      url: String((cfg as { url?: string })?.url ?? ''),
    }));
  } catch {
    return null;
  }
}

/** Re-point a user-scope entry at the current credential. */
function repointOverride(server: string, url: string, key: string): { ok: boolean; detail: string } {
  if (!url) return { ok: false, detail: 'entry carries no url to re-add it with' };
  const candidates = [
    path.join(process.env.HOME || '', '.local/bin/claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ];
  const bin = candidates.find((c) => fs.existsSync(c)) ?? 'claude';
  try {
    execFileSync(
      bin,
      [
        'mcp', 'add',
        '--transport', 'http',
        '--scope', 'user',
        server, url,
        '--header', `Authorization: Bearer ${key}`,
      ],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (e) {
    const msg = String(
      (e as { stderr?: string; message?: string })?.stderr ?? (e as Error)?.message ?? e,
    );
    return { ok: false, detail: msg.replace(new RegExp(key, 'g'), '<redacted>').split('\n')[0] };
  }
  // Verify by reading the config back — never trust the exit code alone.
  const after = readUserScopeEntries();
  const entry = after?.find((e) => e.server === server);
  if (staticAuthBearer(entry?.headers ?? null) !== key) {
    return { ok: false, detail: 'entry did not read back with the expected token' };
  }
  return { ok: true, detail: '' };
}

function yamlEscape(s: string): string {
  return (s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ').trim();
}

function main(): void {
  const args = process.argv.slice(2);
  const formatArg = args.find((a) => a.startsWith('--format='));
  const format = formatArg ? formatArg.split('=')[1] : 'lines';
  const heal = args.includes('--heal');

  const userScope = readUserScopeEntries();
  const configured = new Map<string, string>();
  for (const spec of STATIC_HEADER_SERVERS) {
    configured.set(spec.server, readConfiguredKey(spec.envKey));
  }

  // Walk EVERY entry that pins a header, not just the registered ones — an
  // unregistered one is reported as unjudgeable rather than silently skipped.
  const entries: StaticHeaderDriftEntry[] = (userScope ?? [])
    .filter((e) => staticAuthBearer(e.headers) !== '')
    .map((e) => ({
      serverName: e.server,
      headers: e.headers,
      configuredKey: configured.get(e.server) ?? '',
    }));

  let result = classifyAllStaticHeaderDrift({
    entries,
    configReadable: userScope !== null,
  });

  const healed: string[] = [];
  const healFailures: string[] = [];
  if (heal) {
    for (const v of result.drifted) {
      if (!v.autoHealable) continue;
      const url = userScope?.find((e) => e.server === v.server)?.url ?? '';
      const key = configured.get(v.server) ?? '';
      const r = repointOverride(v.server, url, key);
      if (r.ok) healed.push(v.server);
      else healFailures.push(`${v.server}: ${r.detail}`);
    }
    if (healed.length > 0) {
      // Report the state as it now is, but KEEP the fail: the running MCP
      // subprocess still holds the old header until a full restart.
      result = {
        ...result,
        reason: `${result.reason} Re-pointed automatically: ${healed.join(', ')}.`,
      };
    }
  }

  const remediation = result.verdicts
    .map((v) => remediationForStaticHeaderDrift(v, { autoHealed: healed.includes(v.server) }))
    .filter((r) => r !== '')
    .join(' | ');

  if (format === 'yaml') {
    console.log('static_header_drift:');
    console.log(`  status: ${result.verdict}`);
    console.log(`  config_readable: ${userScope !== null}`);
    console.log(`  pinned_entries: ${entries.length}`);
    console.log(`  drifted: [${result.drifted.map((d) => d.server).join(', ')}]`);
    console.log(`  healed: [${healed.join(', ')}]`);
    for (const v of result.verdicts) {
      console.log(`  ${v.server}:`);
      console.log(`    status: ${v.status}`);
      console.log(`    reason: ${v.reason}`);
      console.log(`    env_key: ${v.envKey ?? 'null'}`);
      console.log(`    matches: ${v.matches === null ? 'null' : v.matches}`);
    }
    console.log(`  detail: "${yamlEscape(result.reason)}"`);
    console.log(`  remediation: "${yamlEscape(remediation)}"`);
    return;
  }

  const label = 'static_header_drift';
  if (result.verdict === 'pass') {
    console.log(`PASS ${label}: ${result.reason}`);
    return;
  }
  if (result.verdict === 'skip') {
    console.log(`INFO ${label}: skipped — ${result.reason}`);
    return;
  }
  console.log(`WARN ${label}: ${result.reason}`);
  for (const v of result.drifted) {
    console.log(`  ${v.server}: ${v.summary}`);
  }
  for (const f of healFailures) console.log(`  detail: auto-heal did not apply (${f})`);
  if (remediation) console.log(`  fix: ${remediation}`);
}

try {
  main();
} catch {
  // Never take doctor down.
}
process.exit(0);
