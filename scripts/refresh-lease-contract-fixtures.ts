/**
 * Regenerate the two fixtures `test/mcp/mobile/backends/lease-contract.test.ts`
 * checks `mcp/mobile/backends/lease-contract.ts` against — from the systems
 * that own them, never by hand:
 *
 *   --canopy-web <checkout>  canopy-web's own openapi schema (Django's
 *                            `api.get_openapi_schema()`), narrowed to the
 *                            capability routes → test/fixtures/canopy-web-capability-routes.json
 *   --cli <ace_mobile.py>    the in-VM CLI's own argparse parser (`build_parser()`)
 *                            → test/fixtures/ace-mobile-cli-contract.json
 *
 * Either flag may be given alone. Run after either side changes its contract:
 *
 *   npx tsx scripts/refresh-lease-contract-fixtures.ts \
 *     --canopy-web ../canopy-web \
 *     --cli infra/capabilities/android-emulator/image/cli/ace_mobile.py
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dumpCliContract } from '../lib/ace-mobile-cli-contract.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROUTES_FIXTURE = path.join(ROOT, 'test/fixtures/canopy-web-capability-routes.json');
const CLI_FIXTURE = path.join(ROOT, 'test/fixtures/ace-mobile-cli-contract.json');

/** The routes the lease backend and the doctor probe may call. */
const ROUTE_FILTER = /^\/api\/capabilities(\/|$)|^\/api\/agents\/\{slug\}\/capabilities$/;

const DUMP_OPENAPI = `
import os, json, django
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings.test')
django.setup()
from apps.api.api import api
print(json.dumps(api.get_openapi_schema(), default=str))
`;


/** HEAD's short sha, marked `+uncommitted` when the tree has local changes — say what was actually read. */
function gitSha(dir: string): string {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).trim();
    return dirty ? `${sha}+uncommitted` : sha;
  } catch {
    return 'unknown';
  }
}

function refreshRoutes(checkout: string): void {
  const raw = execFileSync('uv', ['run', 'python', '-c', DUMP_OPENAPI], {
    cwd: checkout,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const schema = JSON.parse(raw.trim().split('\n').pop()!) as {
    paths: Record<string, Record<string, { parameters?: Array<{ in: string; name: string }>; requestBody?: unknown }>>;
  };
  const routes: Record<string, { query: string[]; body: boolean }> = {};
  for (const [p, item] of Object.entries(schema.paths)) {
    if (!ROUTE_FILTER.test(p)) continue;
    for (const [method, op] of Object.entries(item)) {
      routes[`${method.toUpperCase()} ${p}`] = {
        query: (op.parameters ?? []).filter((x) => x.in === 'query').map((x) => x.name).sort(),
        body: Boolean(op.requestBody),
      };
    }
  }
  if (Object.keys(routes).length === 0) {
    throw new Error(`no capability routes in ${checkout}'s openapi — is apps/capabilities registered on the NinjaAPI?`);
  }
  const sorted = Object.fromEntries(Object.entries(routes).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(
    ROUTES_FIXTURE,
    JSON.stringify(
      {
        _doc:
          `canopy-web capability-broker routes, from canopy-web's openapi (api.get_openapi_schema()) @ ${gitSha(checkout)}. ` +
          'Regenerate with scripts/refresh-lease-contract-fixtures.ts --canopy-web <checkout>; ' +
          'test/mcp/mobile/backends/lease-contract.test.ts checks lease-contract.ts against it.',
        source: 'openapi',
        routes: sorted,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`wrote ${path.relative(ROOT, ROUTES_FIXTURE)} (${Object.keys(sorted).length} routes)`);
}

function refreshCli(cliPath: string): void {
  const dumped = dumpCliContract(cliPath);
  fs.writeFileSync(
    CLI_FIXTURE,
    JSON.stringify(
      {
        _doc:
          `ace-mobile CLI argparse contract (build_parser()), from ${path.basename(cliPath)} @ ${gitSha(path.dirname(path.resolve(cliPath)))}, ` +
          `cli_version ${dumped.cli_version}. Regenerate with scripts/refresh-lease-contract-fixtures.ts --cli <ace_mobile.py>.`,
        ...dumped,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`wrote ${path.relative(ROOT, CLI_FIXTURE)} (${Object.keys(dumped.subcommands).length} subcommands)`);
}

const args = process.argv.slice(2);
const at = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const cw = at('--canopy-web');
const cli = at('--cli');
if (!cw && !cli) {
  console.error('usage: refresh-lease-contract-fixtures.ts [--canopy-web <checkout>] [--cli <ace_mobile.py>]');
  process.exit(2);
}
if (cw) refreshRoutes(cw);
if (cli) refreshCli(cli);
