/**
 * `nova-app-lint` — one call, the deterministic Phase 3 gate.
 *
 *   npx tsx "$ACE_ROOT/scripts/nova-app-lint.ts" --app <nova_app_id> --type learn|deliver \
 *     [--work <work_id>] [--allow-preload id,id] [--declared-modules "A|B"] \
 *     [--out <result.json>] [--bundle-out <bundle.json>] [--from-bundle <bundle.json>]
 *
 * Reads `get_app`, every `get_module`, every `get_form` and every BOUND lookup
 * table once (server-side over JSON-RPC, `lib/nova-rpc.ts` — none of it passes
 * through the model's context, which is the point: a Deliver blueprint is
 * 100–400 KB of JSON), runs `lib/nova-app-lint.ts`, prints the report, and
 * writes the structured result with `--out`.
 *
 * Why a script and not an MCP atom: the Nova reads must happen server-side to
 * keep the blueprint out of context, ACE's MCP servers do not hold a Nova
 * client, and an atom change needs a full Claude restart to go live where a
 * script is live on the next `/ace:update`.
 *
 * Exit codes (the gate keys on these):
 *   0  pass or warn — gate OPEN; evals may be dispatched
 *   2  fail — at least one blocker; repair, then re-run this
 *   3  incomplete — a rule could not run (read error, partial table); NOT a pass
 *   1  usage / auth / transport error
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { loadPluginEnv } from '../lib/load-plugin-env.js';
import { novaCall } from '../lib/nova-rpc.js';
import { fetchNovaAppBundle, type NovaAppBundle, type NovaCall } from '../lib/nova-app-bundle.js';
import { formatNovaAppLint, lintNovaApp, type AppType } from '../lib/nova-app-lint.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/**
 * Nova answers bursts with HTTP 429 and occasionally a 5xx; both are
 * transient. Back off and retry — a lint that dies on a rate limit would
 * read as "incomplete" and stall the gate for no reason.
 */
export function withNovaRetry(call: NovaCall, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): NovaCall {
  return async (tool, args) => {
    let delay = 2000;
    for (let attempt = 0; ; attempt++) {
      try {
        return await call(tool, args);
      } catch (e) {
        const msg = (e as Error).message ?? '';
        if (attempt >= 5 || !/HTTP (429|5\d\d)/.test(msg)) throw e;
        await sleep(delay);
        delay *= 2;
      }
    }
  };
}

async function main(): Promise<number> {
  const appId = arg('app');
  const from = arg('from-bundle');
  if (!appId && !from) {
    process.stderr.write('usage: nova-app-lint.ts --app <nova_app_id> --type learn|deliver [--work <id>] [--out <json>]\n');
    return 1;
  }
  const type = arg('type');
  if (type && type !== 'learn' && type !== 'deliver') {
    process.stderr.write(`--type must be learn or deliver, got "${type}"\n`);
    return 1;
  }

  let bundle: NovaAppBundle;
  if (from) {
    bundle = JSON.parse(readFileSync(from, 'utf8'));
  } else {
    loadPluginEnv(import.meta.url);
    const call = withNovaRetry((tool, args) => novaCall(tool, args));
    bundle = await fetchNovaAppBundle(appId!, call, { workId: arg('work') });
  }
  const bundleOut = arg('bundle-out');
  if (bundleOut) writeFileSync(bundleOut, JSON.stringify(bundle, null, 1));

  const result = lintNovaApp(bundle, {
    appType: type as AppType | undefined,
    allowPreload: (arg('allow-preload') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    declaredModules: arg('declared-modules')?.split('|').map((s) => s.trim()).filter(Boolean),
  });
  const out = arg('out');
  if (out) writeFileSync(out, JSON.stringify(result, null, 2));
  process.stdout.write(formatNovaAppLint(result) + '\n');
  return result.verdict === 'fail' ? 2 : result.verdict === 'incomplete' ? 3 : 0;
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!);
if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`nova-app-lint: ${(e as Error).message}\n`);
      process.exit(1);
    },
  );
}
