/**
 * Probe: assert ACE's DOCUMENTED connect-labs pipeline aggregation allow-list
 * against the live server's own rejection payload.
 *
 * Run:
 *   LABS_INTEGRATION=1 npx tsx scripts/probe-labs-pipeline-aggregations.ts
 *
 * Opt-in on purpose. Without `LABS_INTEGRATION=1` this exits 0 with a SKIP
 * line, matching the other live-surface probes and the
 * `LABS_INTEGRATION=1 npm test -- test/mcp/connect-labs/integration/`
 * convention in CLAUDE.md — CI must not make an unconditional network call.
 *
 * Why this exists (dimagi-internal/ace#1675): ACE documented this enum wrongly
 * twice, in two files, 2.5 months apart. The server is unusually helpful — it
 * echoes the full valid list on every rejection — so re-deriving the truth
 * costs exactly ONE deliberately-bad call. `pipeline_preview` with a
 * `schema_override` is the right vehicle: it validates the schema WITHOUT
 * persisting anything, so the probe mutates nothing.
 *
 * The offline half is `lib/labs-aggregations.ts` +
 * `test/lib/labs-aggregations.test.ts`, which run in CI with no network and
 * diff the playbook against the pinned list. This probe refreshes that pin.
 *
 * Exit codes: 0 = no drift (or skipped), 1 = drift or probe failure.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveToken } from './labs-auth-headers.mjs';
import {
  LIVE_PIPELINE_AGGREGATIONS,
  NUMERIC_AGGREGATIONS_REQUIRING_FLOAT_TRANSFORM,
  parseValidAggregationsFromError,
  parseDocumentedAggregations,
  diffAggregations,
  isAggregationDriftFree,
} from '../lib/labs-aggregations.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLAYBOOK = path.resolve(__dirname, '../playbook/integrations/connect-labs.md');

const LABS_MCP_URL = process.env.LABS_MCP_URL ?? 'https://labs.connect.dimagi.com/mcp/';

/**
 * A pipeline + opportunity the caller can read. Defaults are the pair the
 * ace#1675 report was measured on; both are per-run artifacts and WILL be
 * swept eventually, so override them rather than "fixing" the probe when they
 * 404. Any readable pipeline works — the probe never inspects its schema.
 */
const PIPELINE_ID = Number(process.env.LABS_PROBE_PIPELINE_ID ?? 5242);
const OPPORTUNITY_ID = Number(process.env.LABS_PROBE_OPPORTUNITY_ID ?? 10047);

/** A token no allow-list will ever contain, so the server must reject it. */
const BOGUS_AGGREGATION = '__ace_probe_invalid__';

function log(msg: string): void {
  process.stdout.write(`[probe] ${msg}\n`);
}

/** Call one labs MCP tool over the native HTTP JSON-RPC transport. */
async function callTool(
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  const res = await fetch(LABS_MCP_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      // The server negotiates SSE; it replies with `event:`/`data:` framing.
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  if (!res.ok) {
    throw new Error(`labs MCP returned HTTP ${res.status} ${res.statusText}`);
  }
  const raw = await res.text();
  const frame = raw.split('\n').find((l) => l.startsWith('data: '));
  const payload = JSON.parse(frame ? frame.slice('data: '.length) : raw);
  if (payload.error) {
    throw new Error(`JSON-RPC error: ${JSON.stringify(payload.error)}`);
  }
  const content = payload.result?.content?.[0]?.text ?? '';
  return { text: String(content), isError: Boolean(payload.result?.isError) };
}

/** Send one deliberately-invalid aggregation and read the list echoed back. */
async function fetchLiveAggregations(token: string): Promise<string[]> {
  const { text } = await callTool(token, 'pipeline_preview', {
    pipeline_id: PIPELINE_ID,
    opportunity_id: OPPORTUNITY_ID,
    sample_size: 1,
    schema_override: {
      name: 'ace-probe',
      fields: [
        { name: 'ace_probe_bogus', path: 'form.__ace_probe__', aggregation: BOGUS_AGGREGATION },
      ],
    },
  });

  const valid = parseValidAggregationsFromError(text);
  if (!valid) {
    throw new Error(
      `Server did not echo a "Valid: [...]" list. This usually means the ` +
        `pipeline/opportunity pair is gone (they are per-run artifacts) or the ` +
        `token lacks access — NOT that the allow-list is empty.\n` +
        `  pipeline_id=${PIPELINE_ID} opportunity_id=${OPPORTUNITY_ID}\n` +
        `  Override with LABS_PROBE_PIPELINE_ID / LABS_PROBE_OPPORTUNITY_ID.\n` +
        `  Server said: ${text.slice(0, 400)}`,
    );
  }
  return valid;
}

async function main(): Promise<number> {
  if (process.env.LABS_INTEGRATION !== '1') {
    log('SKIP: set LABS_INTEGRATION=1 to run this live probe.');
    return 0;
  }

  const token = resolveToken(fileURLToPath(import.meta.url));
  if (!token) {
    log('FAIL: no LABS_MCP_TOKEN resolvable. Run /ace:labs-token-mint or /ace:setup --force-env.');
    return 1;
  }

  log(`querying ${LABS_MCP_URL} (pipeline ${PIPELINE_ID}, opp ${OPPORTUNITY_ID})`);
  const live = await fetchLiveAggregations(token);
  log(`live allow-list: ${live.join(', ')}`);

  let failed = false;

  // 1. Live server vs the pin in lib/labs-aggregations.ts.
  const pinDrift = diffAggregations(LIVE_PIPELINE_AGGREGATIONS, live);
  if (isAggregationDriftFree(pinDrift)) {
    log('PASS: lib/labs-aggregations.ts pin matches the live server.');
  } else {
    failed = true;
    log('FAIL: the pin in lib/labs-aggregations.ts is stale.');
    if (pinDrift.undocumented.length) log(`  server added:   ${pinDrift.undocumented.join(', ')}`);
    if (pinDrift.invented.length) log(`  server dropped: ${pinDrift.invented.join(', ')}`);
    log('  Update LIVE_PIPELINE_AGGREGATIONS, then re-run `npm test`.');
  }

  // 2. Live server vs what the playbook currently claims.
  const documented = parseDocumentedAggregations(readFileSync(PLAYBOOK, 'utf8'));
  if (!documented) {
    failed = true;
    log('FAIL: could not find the allow-list sentence in playbook/integrations/connect-labs.md.');
  } else {
    const docDrift = diffAggregations(documented, live);
    if (isAggregationDriftFree(docDrift)) {
      log('PASS: the playbook documents exactly the live allow-list.');
    } else {
      failed = true;
      log('FAIL: playbook/integrations/connect-labs.md has drifted from the live server.');
      if (docDrift.invented.length)
        log(`  documented but REJECTED by the server: ${docDrift.invented.join(', ')}`);
      if (docDrift.undocumented.length)
        log(`  live but undocumented:                 ${docDrift.undocumented.join(', ')}`);
    }
  }

  // 3. Reminder of the half no enum check can catch. Not a live assertion —
  //    proving it needs a numeric field path this probe cannot know — but the
  //    silent case is the expensive one, so name it every run.
  const { failLoud, failSilent } = NUMERIC_AGGREGATIONS_REQUIRING_FLOAT_TRANSFORM;
  log(
    `NOTE: ${[...failLoud, ...failSilent].join('/')} need transform: "float" once ` +
      `grouping_key is set. ${failLoud.join('/')} error out; ${failSilent.join('/')} ` +
      `return a silently WRONG lexicographic answer.`,
  );

  return failed ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    log(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
