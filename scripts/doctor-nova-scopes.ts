/**
 * scripts/doctor-nova-scopes.ts
 *
 * The LIVE half of the `nova_scopes` probe (ace#174). Makes ONE `tools/call
 * get_hq_connection` against the Nova MCP with the configured `NOVA_API_KEY`
 * and reports what that key can actually DO — as opposed to `nova_auth`, which
 * only proves the transport accepted the bearer.
 *
 * Backing dispatcher for two surfaces in `bin/ace-doctor`, mirroring
 * `doctor-nova-header.ts`:
 *   --format=yaml   → the `nova_scopes:` block in --preflight (which is what
 *                     /ace:run gates on before Phase 1 — the whole point, per
 *                     ace#174 comment 2: catching this at Phase 3 is too late)
 *   --format=lines  → PASS/WARN/FAIL lines for the human [Auth liveness] block
 *
 * Decision logic is `lib/nova-scope-probe.ts`, so the response shapes are unit
 * tested against captured frames rather than exercised only over the network.
 *
 * Exit status: ALWAYS 0. A probe that crashes must never take doctor down
 * (same convention as doctor-nova-header.ts / doctor-ocs-generation.ts).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePluginDataDir } from '../lib/plugin-data-dir.js';
import { classifyNovaScopeProbe, type NovaScopeVerdict } from '../lib/nova-scope-probe.js';

const NOVA_MCP_URL = 'https://mcp.commcare.app/mcp';
const TIMEOUT_MS = 8_000;

/**
 * Hand-rolled .env read — same rationale as doctor-nova-header.ts: this
 * script's stdout IS the YAML block spliced into the preflight snapshot, and
 * dotenvx writes an "injected env (N)" banner that would break the parse.
 */
function readEnvValue(name: string): string {
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
      const m = line.match(new RegExp(`^\\s*(?:export\\s+)?${name}=(.*)$`));
      if (!m) continue;
      const value = m[1].trim().replace(/^['"]|['"]$/g, '');
      // `op://…` means the template was never injected on this machine.
      if (!value || value.startsWith('op://')) continue;
      return value;
    }
  }
  return process.env[name] ?? '';
}

async function callGetHqConnection(
  key: string,
): Promise<{ status: number | null; body: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(NOVA_MCP_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        // Nova answers tools/call as an SSE frame even for a plain JSON
        // request, so this header is required, not decorative.
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_hq_connection', arguments: {} },
      }),
      signal: controller.signal,
    });
    return { status: res.status, body: await res.text() };
  } catch {
    return { status: null, body: '' };
  } finally {
    clearTimeout(timer);
  }
}

function yamlEscape(s: string): string {
  return (s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ').trim();
}

function emitYaml(v: NovaScopeVerdict): void {
  console.log('nova_scopes:');
  console.log(`  status: ${v.status}`);
  console.log(`  reason: ${v.reason}`);
  console.log(`  scope: "${yamlEscape(v.scope)}"`);
  console.log(`  hq_key_bound: ${v.configured === null ? 'null' : v.configured}`);
  console.log(`  domains: ${v.domains.length}`);
  console.log(`  required_scope: ${v.requiredScope ? `"${yamlEscape(v.requiredScope)}"` : 'null'}`);
  console.log(`  detail: "${yamlEscape(v.summary)}"`);
  console.log(`  remediation: "${yamlEscape(v.remediation)}"`);
}

function emitLines(v: NovaScopeVerdict): void {
  const label = v.status === 'pass' ? 'PASS' : v.status === 'skip' ? 'INFO' : v.status.toUpperCase();
  console.log(`${label} nova_scopes: ${v.summary}`);
  console.log(`  scope: ${v.scope}`);
  if (v.remediation) console.log(`  fix: ${v.remediation}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const formatArg = args.find((a) => a.startsWith('--format='));
  const format = formatArg ? formatArg.split('=')[1] : 'lines';

  const key = readEnvValue('NOVA_API_KEY');
  const expectedDomain = readEnvValue('ACE_HQ_DOMAIN');

  const { status, body } = key
    ? await callGetHqConnection(key)
    : { status: null as number | null, body: '' };

  const verdict = classifyNovaScopeProbe({
    keyConfigured: key !== '',
    httpStatus: status,
    body,
    expectedDomain: expectedDomain || undefined,
  });

  if (format === 'yaml') emitYaml(verdict);
  else emitLines(verdict);
}

try {
  await main();
} catch {
  // Never take doctor down.
}
process.exit(0);
