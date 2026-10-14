// lease-contract.ts ↔ the two systems it drives. Unit tests mock fetch and
// fake the CLI, so without this a route rename on canopy-web, or a flag the
// CLI never declared, stays green here while every live call 404s or dies as
// an argparse usage error on the machine.
//
// (a) routes: every LEASE_ROUTES entry exists on canopy-web, with only the
//     query params the server reads. Fixture: canopy-web's own openapi.
// (b) CLI: every subcommand and flag CLI sends is one the in-VM `ace-mobile`
//     parser declares, and every flag that parser REQUIRES is one we send.
//     Fixture: the CLI's own argparse, dumped.
//
// Both fixtures regenerate from source: scripts/refresh-lease-contract-fixtures.ts.
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CLI, CLI_BIN, LEASE_ROUTES, cliArgv, routePath } from '../../../../mcp/mobile/backends/lease-contract.js';
import { dumpCliContract } from '../../../../lib/ace-mobile-cli-contract.js';

const root = path.resolve(__dirname, '../../../..');
const routes = JSON.parse(
  fs.readFileSync(path.join(root, 'test/fixtures/canopy-web-capability-routes.json'), 'utf8'),
) as { source: string; routes: Record<string, { query: string[]; body: boolean }> };
const cli = JSON.parse(
  fs.readFileSync(path.join(root, 'test/fixtures/ace-mobile-cli-contract.json'), 'utf8'),
) as {
  subcommands: Record<string, { flags: string[]; required: string[]; positionals: Record<string, string[] | null> }>;
};

describe('lease-contract.ts ↔ canopy-web capability routes', () => {
  it.each(Object.entries(LEASE_ROUTES))('%s exists on canopy-web', (_name, route) => {
    const key = `${route.method} ${route.path}`;
    expect(routes.routes[key], `canopy-web has no ${key} (fixture source: ${routes.source})`).toBeDefined();
  });

  it.each(Object.entries(LEASE_ROUTES).filter(([, r]) => 'query' in r))('%s query params are read by the server', (_n, route) => {
    const served = routes.routes[`${route.method} ${route.path}`]?.query ?? [];
    for (const q of (route as { query: readonly string[] }).query) expect(served, `?${q}`).toContain(q);
  });

  it('routePath refuses a query param outside the contract', () => {
    expect(() => routePath('get', { lease_id: 'x' }, { prefix: 'a' })).toThrow(/not in the contract/);
    expect(routePath('artifacts', { lease_id: 'L 1' }, { prefix: 'run/' })).toBe('/api/capabilities/leases/L%201/artifacts?prefix=run%2F');
  });

  it('no route string lives outside lease-contract.ts', () => {
    for (const f of ['mcp/mobile/backends/lease.ts', 'lib/capability-lease-probe.ts', 'scripts/doctor-capability-lease.ts']) {
      const src = fs.readFileSync(path.join(root, f), 'utf8');
      expect(src, f).not.toMatch(/['"`]\/api\//);
    }
  });
});

describe('lease-contract.ts ↔ the in-VM ace-mobile CLI', () => {
  const inRepoCli = path.join(root, 'infra/capabilities/android-emulator/image/cli/ace_mobile.py');

  it('the fixture IS the CLI in this checkout (live argparse dump)', () => {
    // python3 is on every CI runner (test/infra/android-emulator-cli.test.ts runs the CLI's own suite).
    const live = dumpCliContract(inRepoCli);
    expect(
      live.subcommands,
      'the CLI changed — run: npx tsx scripts/refresh-lease-contract-fixtures.ts --cli infra/capabilities/android-emulator/image/cli/ace_mobile.py, then fix lease-contract.ts until this file passes',
    ).toEqual(cli.subcommands);
  });

  it('argv[0] is the one allow-listed binary', () => {
    expect(CLI_BIN).toBe('ace-mobile');
    const manifest = path.join(root, 'infra/capabilities/android-emulator/capability.yaml');
    if (fs.existsSync(manifest)) expect(fs.readFileSync(manifest, 'utf8')).toMatch(/allow:\s*\[\s*ace-mobile\s*\]/);
  });

  it.each(Object.entries(CLI))('%s: subcommand and every flag exist on the CLI', (_name, op) => {
    const sub = cli.subcommands[op.sub[0]];
    expect(sub, `the CLI has no subcommand ${op.sub[0]}`).toBeDefined();
    // Positional words after the subcommand (snapshot save|load) must be choices.
    const positionalChoices = Object.values(sub.positionals);
    op.sub.slice(1).forEach((word, i) => {
      expect(positionalChoices[i], `${op.sub[0]} takes no positional ${word}`).toContain(word);
    });
    for (const flag of Object.values(op.flags)) {
      expect(sub.flags, `${op.sub[0]} does not declare ${flag}`).toContain(flag);
    }
    for (const req of sub.required) {
      expect(Object.values(op.flags), `${op.sub[0]} requires ${req}; the contract never sends it`).toContain(req);
    }
  });

  it('cliArgv repeats list flags and drops undefined ones', () => {
    expect(cliArgv('runRecipe', { recipe: 's3://b/r.yaml', env: ['A=1', 'B=2'], out: 's3://b/o/' })).toEqual([
      'ace-mobile', 'run-recipe', '--recipe', 's3://b/r.yaml', '--env', 'A=1', '--env', 'B=2', '--out', 's3://b/o/',
    ]);
    expect(cliArgv('snapshotLoad', { name: 'pre' })).toEqual(['ace-mobile', 'snapshot', 'load', '--name', 'pre']);
  });
});
