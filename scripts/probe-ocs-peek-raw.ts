import 'dotenv/config';
import * as fs from 'fs'; import * as path from 'path'; import * as os from 'os';
import { PlaywrightSession } from '../mcp/ocs/auth/playwright-session.js';
if (!process.env.OCS_USERNAME) {
  for (const line of fs.readFileSync(path.join(os.homedir(), '.claude/plugins/data/ace-ace/.env'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
}
(async () => {
  const baseUrl = process.env.OCS_BASE_URL!;
  const teamSlug = process.env.OCS_TEAM_SLUG!;
  const s = new PlaywrightSession({ baseUrl, teamSlug, username: process.env.OCS_USERNAME!, password: process.env.OCS_PASSWORD! });
  try {
    const ctx = await s.getContext();
    const r = await ctx.request.get(`${baseUrl}/a/${teamSlug}/pipelines/data/5981/`);
    console.log(JSON.stringify(await r.json(), null, 2));
  } finally { await s.close().catch(()=>{}); }
})();
