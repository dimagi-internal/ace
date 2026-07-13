/**
 * One-off probe for issue #855: compare the workers/user_invite state of the
 * hh-poverty opp (wedged) vs the bednet opp (healthy) for ACE_E2E_PHONE.
 * Read-only. Run: npx tsx scripts/_probe-workers-855.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { request } from 'playwright';

const BASE = process.env.CONNECT_BASE_URL || 'https://connect.dimagi.com';
const SESSION = path.join(os.homedir(), '.ace', 'connect-session.json');
const ORG = 'ai-demo-space';
const OPPS: Record<string, string> = {
  'hh-poverty (wedged)': '9d4bb89e-a3f2-49c6-94f0-974c9579a143',
  'bednet-0706 (healthy)': '31eed630-52c9-4a35-a96d-c744beab031d',
};
const PHONE = process.env.TARGET_PHONE || '+74260000101';

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

async function main() {
  const ctx = await request.newContext({
    storageState: JSON.parse(fs.readFileSync(SESSION, 'utf8')),
    baseURL: BASE,
  });
  for (const [label, uuid] of Object.entries(OPPS)) {
    console.log(`\n=== ${label} (${uuid})`);
    for (const sub of ['workers/', 'workers/?view=invites', 'user_invite/']) {
      const url = `/a/${ORG}/opportunity/${uuid}/${sub}`;
      const r = await ctx.get(url, { headers: { 'HX-Request': 'true' } });
      const status = r.status();
      if (!r.ok()) {
        console.log(`  ${sub} -> HTTP ${status}`);
        continue;
      }
      const html = await r.text();
      // Find table rows mentioning the phone (with or without +)
      const needle = PHONE.replace('+', '');
      const rows = [...html.matchAll(/<tr[\s\S]*?<\/tr>/g)]
        .map((m) => m[0])
        .filter((row) => row.includes(needle));
      if (rows.length === 0) {
        console.log(`  ${sub} -> HTTP ${status}, no row for ${PHONE} (page len ${html.length})`);
        // also report total rows for context
        const all = [...html.matchAll(/<tr[\s\S]*?<\/tr>/g)].length;
        console.log(`    total <tr> rows: ${all}`);
      }
      for (const row of rows) {
        console.log(`  ${sub} -> ROW: ${stripTags(row).slice(0, 300)}`);
      }
    }
  }
  await ctx.dispose();
}

main().catch((e) => {
  console.error('PROBE FAILED:', e.message);
  process.exit(1);
});
