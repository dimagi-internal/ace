/**
 * Did OCS fail to deliver to a PersonalID participant after a send? Read-only.
 *
 *   npx tsx scripts/ocs-delivery-failures.ts --participant <connect-username> --since-minutes 10 [--team connect-ace]
 *
 * Reads the team's notifications with ACE's saved OCS login (`~/.ace/ocs-session-<team>.json`, /ace:ocs-login).
 * Exit 0: no delivery failure for that participant in the window. Exit 2: at least one (printed as JSON).
 * Exit 3: the saved login no longer works. Run it ~20-30 s after the send: OCS delivers asynchronously.
 * Why it exists: lib/ocs-delivery-failures.ts.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import {
  deliveryFailureEvents,
  failuresSince,
  parseDeliveryFailures,
  parseNotificationList,
} from '../lib/ocs-delivery-failures.js';

const { values } = parseArgs({
  options: {
    team: { type: 'string', default: process.env.OCS_TEAM_SLUG ?? 'connect-ace' },
    participant: { type: 'string' },
    'since-minutes': { type: 'string', default: '10' },
    base: { type: 'string', default: 'https://www.openchatstudio.com' },
  },
});

const sessionFile = path.join(os.homedir(), '.ace', `ocs-session-${values.team}.json`);
if (!fs.existsSync(sessionFile)) {
  console.error(`no saved OCS login at ${sessionFile}; run /ace:ocs-login`);
  process.exit(3);
}
const state = JSON.parse(fs.readFileSync(sessionFile, 'utf8')) as { cookies: { name: string; value: string; domain: string }[] };
const host = new URL(values.base!).hostname;
const cookie = state.cookies.filter((c) => host.endsWith(c.domain.replace(/^\./, ''))).map((c) => `${c.name}=${c.value}`).join('; ');

async function get(p: string): Promise<string> {
  const res = await fetch(new URL(p, values.base), { headers: { cookie, 'hx-request': 'true' }, redirect: 'manual' });
  if (res.status >= 300 && res.status < 400) {
    console.error(`OCS redirected ${p} to ${res.headers.get('location')}: the saved login expired; run /ace:ocs-login`);
    process.exit(3);
  }
  if (!res.ok) throw new Error(`GET ${p} -> ${res.status}`);
  return res.text();
}

const since = new Date(Date.now() - Number(values['since-minutes']) * 60_000);
const events = deliveryFailureEvents(parseNotificationList(await get('/notifications/table/')));
const hits = [];
for (const e of events) {
  const table = await get(`${e.eventPath}table/?`);
  hits.push(...failuresSince(parseDeliveryFailures(table), since, values.participant));
}
console.log(JSON.stringify({ team: values.team, since: since.toISOString(), participant: values.participant ?? null, failures: hits }, null, 2));
process.exit(hits.length ? 2 : 0);
