/**
 * Read-only probe: does ACE's own HQ key confirm `commcare_connect` on a
 * project space? Replays the two calls Nova's compatibility probe makes, so an
 * `upload_app_to_hq` -> `project_space_incompatible` / `unverified` refusal can
 * be attributed to Nova's stored key vs the space itself (ace#2704).
 *
 *   npx tsx scripts/probe-hq-connect-flag.ts <domain>
 *
 * Exit 0 = available, 1 = any other verdict. Prints no secrets.
 */
import { loadPluginEnv } from '../lib/load-plugin-env.js';
import {
  CONNECT_FLAG_SLUG,
  classifyConnectFlag,
  parseUserDomains,
  VERDICT_REMEDY,
  type ProbeLeg,
} from '../lib/hq-connect-flag-probe.js';

loadPluginEnv(import.meta.url);

const domain = process.argv[2] ?? process.env.ACE_HQ_DOMAIN;
if (!domain) {
  console.error('usage: probe-hq-connect-flag.ts <domain>');
  process.exit(2);
}
if (!process.env.ACE_HQ_USERNAME || !process.env.ACE_HQ_API_KEY) {
  // Without this, a missing .env would classify as `hq-unreachable` and blame HQ.
  console.error('ACE_HQ_USERNAME / ACE_HQ_API_KEY not loaded — run from the installed plugin or /ace:setup.');
  process.exit(2);
}
const base =(process.env.ACE_HQ_BASE_URL || 'https://www.commcarehq.org').replace(/\/$/, '');
const auth = `ApiKey ${process.env.ACE_HQ_USERNAME}:${process.env.ACE_HQ_API_KEY}`;

async function leg(query: string): Promise<ProbeLeg> {
  const url = `${base}/api/user_domains/v1/?${query}`;
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      headers: { Authorization: auth, Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });
    const ms = Date.now() - t0;
    if (!res.ok) {
      console.log(`  ${query} -> HTTP ${res.status} (${ms} ms)`);
      return { ok: false, status: res.status };
    }
    const domains = parseUserDomains(await res.json());
    console.log(`  ${query} -> 200 (${ms} ms) ${domains ? domains.length + ' domains' : 'MALFORMED'}`);
    return domains ? { ok: true, domains } : { ok: false, status: 502 };
  } catch (err) {
    console.log(`  ${query} -> error ${(err as Error).message}`);
    return { ok: false, status: 'error' };
  }
}

const visible = await leg('limit=100');
const flagged = await leg(`limit=100&feature_flag=${CONNECT_FLAG_SLUG}`);
const verdict = classifyConnectFlag(domain, visible, flagged);
console.log(`\n${domain}: ${verdict}\n${VERDICT_REMEDY[verdict]}`);
process.exit(verdict === 'available' ? 0 : 1);
