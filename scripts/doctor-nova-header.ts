/**
 * scripts/doctor-nova-header.ts
 *
 * The LIVE half of the `nova_header_readiness` probe. Answers ONE question:
 * *will the Nova MCP receive an `Authorization` header in this session?*
 *
 * Backing dispatcher for two surfaces in `bin/ace-doctor`:
 *   --format=yaml   → the `nova_header_readiness:` block in --preflight
 *                     (a HALT class: it runs before Phase 1, not at Phase 3)
 *   --format=lines  → PASS/WARN lines for the human [Auth liveness] block
 *
 * WHY THIS IS NOT A SHELL CHECK. The predecessor (`nova_shell_env`) was
 * `[ -n "${NOVA_API_KEY:-}" ]`, evaluated inside `bin/ace-doctor` — a bash
 * process whose env comes from the user's rc files (`~/.zshenv` sources
 * `~/.ace/env.sh`). It therefore ALWAYS saw the key and always printed
 * "headersHelper will authenticate", which is a claim about a different
 * process. The env that decides the outcome belongs to the CLAUDE CODE
 * process, and the only way to read it is `ps -Eww` against that pid.
 *
 * SELF-HEAL (--heal). When the verdict is `fail` AND auto-healable, install the
 * nova-plugin#52 static-header override with the configured PAT. Precedent:
 * `nova_needs_auth_cache` already auto-clears rather than printing a one-liner
 * for a human to run (ace#1579 — "the entry is PROVEN stale, so there is
 * nothing to decide"). The same reasoning applies here, and more strongly: the
 * documented alternative (`/mcp` → Clear authentication) is a no-op in this
 * state, so leaving it to the operator means leaving them in a loop.
 *
 * This ALSO re-asserts on every run: the override was found missing on two
 * machines that had previously been working, so it is treated as declared
 * state, not a one-time setup step. A rotated key is re-pointed for the same
 * reason — the override is static and does not follow a rotation.
 *
 * Exit status: ALWAYS 0. A probe that crashes must never take doctor down
 * (same convention as scripts/doctor-ocs-generation.ts).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolvePluginDataDir } from '../lib/plugin-data-dir.js';
import {
  classifyNovaHeaderReadiness,
  remediationFor,
  type NovaHeaderVerdict,
} from '../lib/nova-header-readiness.js';

const NOVA_MCP_URL = 'https://mcp.commcare.app/mcp';

/**
 * Hand-rolled .env read — same rationale as doctor-ocs-generation.ts: this
 * script's stdout IS the YAML block spliced into the preflight snapshot, and
 * dotenvx writes an "injected env (N)" banner to stdout that would break the
 * orchestrator's parse.
 */
function readConfiguredKey(): string {
  const dataDir = resolvePluginDataDir(import.meta.url);
  const candidates = [
    dataDir ? path.join(dataDir, '.env') : '',
    path.join(process.env.HOME || '', '.claude/plugins/data/ace-ace/.env'),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env'),
    path.join(process.env.HOME || '', '.ace/env.sh'),
  ].filter(Boolean);
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      // Matches both `NOVA_API_KEY=…` and `export NOVA_API_KEY=…`.
      const m = line.match(/^\s*(?:export\s+)?NOVA_API_KEY=(.*)$/);
      if (!m) continue;
      const value = m[1].trim().replace(/^['"]|['"]$/g, '');
      if (!value || value.startsWith('op://')) continue;
      return value;
    }
  }
  return '';
}

/**
 * Walk up the process tree to the `claude` process. `bin/ace-doctor` is
 * normally invoked from a Bash tool call, so the immediate parent is a shell,
 * not Claude Code. Returns null when no ancestor looks like claude.
 */
function findClaudePid(startPpid: number): number | null {
  let pid = startPpid;
  for (let hops = 0; hops < 8 && pid > 1; hops++) {
    let out = '';
    try {
      out = execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return null;
    }
    if (!out) return null;
    const m = out.match(/^\s*(\d+)\s+(.*)$/);
    if (!m) return null;
    const [, parent, comm] = m;
    // Match the binary name, not a substring of some unrelated path.
    if (/(^|\/)claude$/.test(comm.trim())) return pid;
    pid = Number(parent);
  }
  return null;
}

/**
 * Read a process's environment. Returns the variable NAMES plus a token count
 * used as the readability CONTROL — an empty name list with a zero count means
 * the read was refused, which must never be reported as a clean env.
 */
function readProcessEnv(pid: number): { names: string[] | null; tokenCount: number } {
  let out = '';
  try {
    out = execFileSync('ps', ['-Eww', '-p', String(pid)], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return { names: null, tokenCount: 0 };
  }
  const names: string[] = [];
  let tokenCount = 0;
  for (const token of out.split(/\s+/)) {
    const m = token.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (!m) continue;
    tokenCount++;
    names.push(m[1]);
  }
  return { names: tokenCount > 0 ? names : null, tokenCount };
}

/** The user-scope `nova` MCP entry's headers, if one exists. */
function readUserScopeNovaHeaders(): Record<string, string> | null {
  const file = path.join(process.env.HOME || '', '.claude.json');
  if (!fs.existsSync(file)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const nova = j?.mcpServers?.nova;
    if (!nova) return null;
    return (nova.headers ?? {}) as Record<string, string>;
  } catch {
    return null;
  }
}

function bearerOf(headers: Record<string, string> | null): string {
  if (!headers) return '';
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== 'authorization') continue;
    return String(value).replace(/^Bearer\s+/i, '').trim();
  }
  return '';
}

/** Install (or re-point) the nova-plugin#52 static-header override. */
function installOverride(key: string): { ok: boolean; detail: string } {
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
        'nova', NOVA_MCP_URL,
        '--header', `Authorization: Bearer ${key}`,
      ],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (e) {
    const msg = String((e as { stderr?: string; message?: string })?.stderr ?? (e as Error)?.message ?? e);
    return { ok: false, detail: msg.replace(new RegExp(key, 'g'), '<redacted>').split('\n')[0] };
  }
  // Verify by reading the config back — never trust the exit code alone.
  const after = bearerOf(readUserScopeNovaHeaders());
  if (after !== key) return { ok: false, detail: 'entry did not read back with the expected token' };
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

  const key = readConfiguredKey();
  const headers = readUserScopeNovaHeaders();
  const claudePid = findClaudePid(process.ppid);
  const env = claudePid ? readProcessEnv(claudePid) : { names: null, tokenCount: 0 };
  const overrideToken = bearerOf(headers);

  let verdict: NovaHeaderVerdict = classifyNovaHeaderReadiness({
    claudeEnvNames: env.names,
    claudeEnvTokenCount: env.tokenCount,
    userScopeNovaHeaders: headers,
    keyConfigured: key !== '',
    staticHeaderMatchesConfiguredKey:
      overrideToken && key ? overrideToken === key : null,
  });

  let healed = false;
  let healDetail = '';
  if (heal && verdict.status === 'fail' && verdict.autoHealable && key) {
    const r = installOverride(key);
    healed = r.ok;
    healDetail = r.detail;
    if (r.ok) {
      // Re-classify against the now-installed override so the reported state is
      // the real one. Status stays `fail`: MCP subprocesses bind at session
      // start, so a restart is still mandatory before this session can use it.
      verdict = { ...verdict, summary: verdict.summary + ' — override installed automatically' };
    }
  }

  const fix = remediationFor(verdict, { autoInstalled: healed });

  if (format === 'yaml') {
    console.log('nova_header_readiness:');
    console.log(`  status: ${verdict.status}`);
    console.log(`  reason: ${verdict.reason}`);
    console.log(`  claude_pid: ${claudePid ?? 'null'}`);
    console.log(`  env_readable: ${env.tokenCount > 0}`);
    console.log(`  static_override: ${headers !== null && overrideToken !== ''}`);
    console.log(`  healed: ${healed}`);
    console.log(`  detail: "${yamlEscape(verdict.summary)}"`);
    console.log(`  remediation: "${yamlEscape(fix)}"`);
    return;
  }

  if (verdict.status === 'pass') {
    console.log(`PASS nova_header_readiness: ${verdict.summary}`);
    return;
  }
  if (verdict.status === 'skip') {
    console.log(`INFO nova_header_readiness: skipped — ${verdict.summary}`);
    if (fix) console.log(`  fix: ${fix}`);
    return;
  }
  console.log(`WARN nova_header_readiness: ${verdict.summary}`);
  if (healDetail) console.log(`  detail: auto-heal did not apply (${healDetail})`);
  if (fix) console.log(`  fix: ${fix}`);
}

try {
  main();
} catch {
  // Never take doctor down.
}
process.exit(0);
