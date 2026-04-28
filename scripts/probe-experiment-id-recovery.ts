/**
 * Probe alternative ways to recover an OCS chatbot's integer experiment_id
 * from its UUID public_id. Tests four candidate paths:
 *   A. GET /api/experiments/<uuid>/ — does the detail endpoint include int id?
 *   B. GET /a/<team>/chatbots/ — HTML page listing every bot with /chatbots/<int>/ links
 *   C. GET /a/<team>/chatbots/<uuid>/ — does the human URL accept UUID?
 *   D. GET /a/<team>/chatbots/<uuid>/edit/ — same
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';

const ENV_FILE = path.join(process.env.HOME!, '.claude/plugins/data/ace-ace/.env');
if (fs.existsSync(ENV_FILE)) {
  for (const line of fs.readFileSync(ENV_FILE, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

const baseUrl = process.env.OCS_BASE_URL!;
const token = process.env.OCS_API_TOKEN!;
const team = process.env.OCS_TEAM_SLUG!;
const PROBE_UUID = '5e946111-357e-4748-97b9-1fadacfa7122'; // turmeric bot

// Read playwright auth state to mimic browser session for HTML pages
const SESSION_FILE = path.join(process.env.HOME!, '.ace', `ocs-session-${team}.json`);
let cookieHeader = '';
if (fs.existsSync(SESSION_FILE)) {
  const session = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
  cookieHeader = (session.cookies as Array<{name: string; value: string}>)
    .map(c => `${c.name}=${c.value}`).join('; ');
}

async function probe(label: string, url: string, headers: Record<string, string>) {
  try {
    const r = await fetch(url, { headers, redirect: 'manual' });
    const txt = await r.text();
    console.log(`\n=== ${label} ===\n${url}\nstatus=${r.status} location=${r.headers.get('location') ?? '-'}`);
    if (txt.length < 800 && r.status >= 200 && r.status < 300) {
      console.log(`body: ${txt.slice(0, 800)}`);
    } else {
      // Look for /chatbots/<int>/ patterns in the body
      const matches = [...txt.matchAll(/\/chatbots\/(\d+)\//g)];
      const ints = [...new Set(matches.map(m => m[1]))];
      console.log(`body length: ${txt.length}`);
      if (ints.length) console.log(`integers found in /chatbots/<int>/ patterns: ${ints.slice(0, 10).join(', ')}${ints.length > 10 ? '…' : ''}`);
      // Look for the probed UUID in the body
      if (txt.includes(PROBE_UUID)) {
        const i = txt.indexOf(PROBE_UUID);
        console.log(`UUID found in body around: …${txt.slice(Math.max(0, i - 200), i)}<UUID>${txt.slice(i + PROBE_UUID.length, i + PROBE_UUID.length + 200)}…`);
      } else {
        console.log('UUID not present in body');
      }
    }
  } catch (e: any) {
    console.log(`\n=== ${label} === FAIL: ${e.message}`);
  }
}

async function main() {
  const apiHeaders = { Authorization: `Bearer ${token}` };
  const browserHeaders = { Cookie: cookieHeader, 'User-Agent': 'Mozilla/5.0 ACE-probe' };

  console.log(`Probing live OCS for experiment_id of UUID ${PROBE_UUID}\n`);

  await probe('A — REST detail endpoint', `${baseUrl}/api/experiments/${PROBE_UUID}/`, apiHeaders);
  await probe('B — team chatbots HTML page', `${baseUrl}/a/${team}/chatbots/`, browserHeaders);

  // B' — dump key chunks of the team chatbots HTML to see how the bot list renders
  const r = await fetch(`${baseUrl}/a/${team}/chatbots/`, { headers: browserHeaders });
  const html = await r.text();
  console.log(`\n=== B' — anchor analysis on /a/${team}/chatbots/ ===`);
  console.log(`length=${html.length}, status=${r.status}`);
  console.log(`title=${(html.match(/<title>([^<]+)/) ?? [])[1]}`);
  // Look for HTMX endpoints that might contain int IDs
  const htmxMatches = [...new Set([...html.matchAll(/hx-[a-z]+="([^"]+)"/g)].map(m => m[1]))];
  console.log(`distinct hx-* attrs (first 15): ${htmxMatches.slice(0, 15).join(' | ')}`);
  // Look for any URL with /chatbots/<thing>/
  const chatbotUrls = [...new Set([...html.matchAll(/\/chatbots\/[^"\/\s]+\//g)].map(m => m[0]))];
  console.log(`distinct /chatbots/<X>/ URLs: ${chatbotUrls.slice(0, 15).join(' | ')}`);
  // Is there a CSRF/login redirect pattern indicating we're not authenticated?
  console.log(`contains "log in"/"login": ${/log[\s-]?in/i.test(html)}`);
  console.log(`contains UUID anywhere: ${html.includes(PROBE_UUID)}`);

  await probe('C — human URL with UUID', `${baseUrl}/a/${team}/chatbots/${PROBE_UUID}/`, browserHeaders);
  await probe('D — edit URL with UUID', `${baseUrl}/a/${team}/chatbots/${PROBE_UUID}/edit/`, browserHeaders);

  // E — what about an HTMX list endpoint like /a/<team>/chatbots/list/ or similar?
  for (const tail of ['list/', 'rows/', 'data/', 'table/']) {
    await probe(`E — /chatbots/${tail}`, `${baseUrl}/a/${team}/chatbots/${tail}`, browserHeaders);
  }
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
