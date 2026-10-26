/**
 * `nova-app-lint` — one call, the deterministic Phase 3 gate.
 *
 *   npx tsx "$ACE_ROOT/scripts/nova-app-lint.ts" --app <nova_app_id> --type learn|deliver \
 *     [--work <work_id>] [--allow-preload id,id] [--declared-modules "A|B"] \
 *     [--out <result.json>] [--snapshot-out <snapshot.json>] [--from-bundle <snapshot.json>]
 *
 * Reads `get_app`, every `get_module`, every `get_form` and every BOUND lookup
 * table once (server-side over JSON-RPC, `lib/nova-rpc.ts` — none of it passes
 * through the model's context, which is the point: a Deliver blueprint is
 * 100–400 KB of JSON), runs `lib/nova-app-lint.ts`, prints the report, and
 * writes the structured result with `--out`.
 *
 * `--snapshot-out` (alias `--bundle-out`) writes what it read as the Phase 3
 * Nova app snapshot (`lib/nova-app-snapshot.ts`, ace#3132): stamped with the
 * app's `updated_at` taken BEFORE the read, so an edit landing mid-read makes
 * the snapshot stale rather than silently half-new. Every later checker in
 * the pass reads that file (`scripts/nova-app-snapshot.ts`) instead of
 * re-walking Nova, and `--from-bundle <snapshot>` re-lints it with no Nova
 * calls at all.
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
import { isNovaRateLimit, isNovaTransient, NOVA_RATE_LIMIT_MIN_BACKOFF_MS, novaCall } from '../lib/nova-rpc.js';
import { fetchNovaAppBundle, type NovaAppBundle, type NovaCall } from '../lib/nova-app-bundle.js';
import { formatNovaAppLint, lintNovaApp, type AppType } from '../lib/nova-app-lint.js';
import { readAppUpdatedAt, stampSnapshot } from '../lib/nova-app-snapshot.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/**
 * Nova answers bursts with a 429 and occasionally a 5xx; both are transient.
 * Back off and retry — a lint that dies on a rate limit would read as
 * "incomplete" and stall the gate for no reason.
 *
 * A 429 arrives either as `HTTP 429` or as a tool error ("Too many requests")
 * with no status code, so both are matched (`isNovaRateLimit`, ace#3301). Nova
 * returns no `retry_after`; a rate limit backs off at least
 * `NOVA_RATE_LIMIT_MIN_BACKOFF_MS`, doubling. A throttled write did not apply,
 * but the caller cannot assume that, so `beforeResend` runs ahead of every
 * retry — a write path passes a re-read of the affected entity there and then
 * resends with the SAME `request_id`.
 */
export function withNovaRetry(
  call: NovaCall,
  sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
  opts: { beforeResend?: (tool: string, args: Record<string, unknown>) => Promise<void> } = {},
): NovaCall {
  return async (tool, args) => {
    let delay = 2000;
    let limitedDelay = NOVA_RATE_LIMIT_MIN_BACKOFF_MS;
    for (let attempt = 0; ; attempt++) {
      try {
        return await call(tool, args);
      } catch (e) {
        const msg = (e as Error).message ?? '';
        const limited = isNovaRateLimit(msg);
        if (attempt >= 5 || !(limited || isNovaTransient(msg))) throw e;
        await sleep(limited ? limitedDelay : delay);
        if (limited) limitedDelay *= 2;
        else delay *= 2;
        await opts.beforeResend?.(tool, args);
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
    const workId = arg('work');
    const head: any = workId ? null : await call('get_app', { app_id: appId! });
    const updatedAt = workId ? null : await readAppUpdatedAt(appId!, (head?.app ?? head)?.name, call);
    const fetchedAt = new Date().toISOString();
    bundle = stampSnapshot(await fetchNovaAppBundle(appId!, call, { workId }), {
      fetchedAt,
      updatedAt,
      scope: workId ? 'work' : 'saved',
    });
  }
  const bundleOut = arg('snapshot-out') ?? arg('bundle-out');
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
