/**
 * Probe / one-shot: run `connect_create_organization`'s code path outside the
 * MCP (whose subprocess binds its tool list at start, so a freshly merged atom
 * is not callable until Claude restarts). dimagi-internal/ace#3170.
 *
 * Dry run by default: GETs `/register/organization/`, reports whether ace@
 * already belongs to an org of this name and the slug Connect would derive.
 * POSTs nothing.
 *
 *   npx tsx scripts/probe-connect-create-organization.ts "ACE Test LLO (Synthetic)"
 *
 * `--create` performs the real create (irreversible: Connect has no delete).
 * It is still idempotent by name: an org ace@ already belongs to is returned,
 * not duplicated.
 *
 *   npx tsx scripts/probe-connect-create-organization.ts "ACE Test LLO (Synthetic)" --create \
 *     [--notes "…"] [--short-name "…"]
 *
 * Env: the installed plugin's .env (`ACE_HQ_USERNAME` / `ACE_HQ_PASSWORD` for
 * the Connect session's auto-relogin), via loadPluginEnv (ace#2141).
 */
import { loadPluginEnv } from '../lib/load-plugin-env.js';
import { PlaywrightSession } from '../mcp/connect/auth/playwright-session.js';
import { PlaywrightBackend } from '../mcp/connect/backends/playwright.js';

loadPluginEnv(import.meta.url);

const args = process.argv.slice(2);
const name = args.find((a) => !a.startsWith('--'));
const flag = (f: string) => {
  const i = args.indexOf(f);
  return i > -1 ? args[i + 1] : undefined;
};
if (!name) {
  console.error('usage: npx tsx scripts/probe-connect-create-organization.ts "<name>" [--create] [--notes "…"] [--short-name "…"]');
  process.exit(2);
}
const create = args.includes('--create');
const baseUrl = process.env.CONNECT_BASE_URL ?? 'https://connect.dimagi.com';

async function main() {
  const session = new PlaywrightSession({
    baseUrl,
    cchqBaseUrl: process.env.CCHQ_BASE_URL ?? 'https://www.commcarehq.org',
    hqUsername: process.env.ACE_HQ_USERNAME,
    hqPassword: process.env.ACE_HQ_PASSWORD,
  });
  const ctx = await session.getContext();
  const backend = new PlaywrightBackend({ baseUrl, csrfToken: session.getCsrfToken(), request: ctx.request, session });
  try {
    const out = await backend.createOrganization({
      name: name!,
      notes: flag('--notes'),
      short_name: flag('--short-name'),
      dry_run: !create,
    });
    console.log(JSON.stringify(out, null, 2));
  } catch (err) {
    const e = err as { toJSON?: () => unknown; message?: string };
    console.error(JSON.stringify(e.toJSON ? e.toJSON() : { error: String(e.message ?? err) }, null, 2));
    process.exitCode = 1;
  } finally {
    await session.close?.();
  }
}

await main();
