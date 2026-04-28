/**
 * Probe the live OCS /api/experiments/ response shape to confirm whether
 * the `url` field that 0.6.1's experiment_id parser depends on is actually
 * present. The 2026-04-28 validation run reported experiment_id: null on
 * live calls despite unit-test mocks succeeding.
 *
 * Reads OCS auth from the same env the MCP server uses.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';

const ENV_FILE = path.join(process.env.HOME!, '.claude/plugins/data/ace-ace/.env');
if (fs.existsSync(ENV_FILE)) {
  const env = fs.readFileSync(ENV_FILE, 'utf-8');
  for (const line of env.split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  }
}

const baseUrl = process.env.OCS_BASE_URL || 'https://www.openchatstudio.com';
const token = process.env.OCS_REST_API_KEY || process.env.OCS_API_TOKEN;
if (!token) { console.error('No OCS REST token in env'); process.exit(1); }

async function main() {
  const r = await fetch(`${baseUrl}/api/experiments/?page_size=3`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  console.log('Status:', r.status);
  const body = await r.json();
  console.log('Top-level keys:', Object.keys(body));
  const results = (body as { results?: unknown[] }).results;
  if (!Array.isArray(results)) { console.log('No results array.'); return; }
  console.log(`\n${results.length} experiments returned. First entry's keys:`);
  if (results[0]) {
    console.log(Object.keys(results[0] as object));
    console.log('\nFirst entry full shape (truncated values):');
    const e = results[0] as Record<string, unknown>;
    for (const [k, v] of Object.entries(e)) {
      const s = typeof v === 'string' ? `"${v.slice(0, 80)}"` : JSON.stringify(v).slice(0, 80);
      console.log(`  ${k}: ${s}`);
    }
  }
}

main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
