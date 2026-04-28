import fs from 'fs';
import path from 'path';
const ENV_FILE = path.join(process.env.HOME!, '.claude/plugins/data/ace-ace/.env');
for (const line of fs.readFileSync(ENV_FILE, 'utf-8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)/);
  if (m) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
}
const SESSION_FILE = path.join(process.env.HOME!, '.ace', `ocs-session-${process.env.OCS_TEAM_SLUG}.json`);
const session = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
const cookieHeader = (session.cookies as Array<{name: string; value: string}>).map(c => `${c.name}=${c.value}`).join('; ');

async function main() {
  const r = await fetch(`${process.env.OCS_BASE_URL}/a/${process.env.OCS_TEAM_SLUG}/chatbots/table/`, { headers: { Cookie: cookieHeader }});
  const html = await r.text();
  console.log('status:', r.status, 'length:', html.length);
  // Find chunks of HTML around /chatbots/<int>/ URLs to understand the structure
  const idx = html.indexOf('/chatbots/12003/');
  if (idx >= 0) {
    console.log('\n--- 1500 chars around /chatbots/12003/ ---');
    console.log(html.slice(Math.max(0, idx - 100), idx + 1500));
  }
}
main();
