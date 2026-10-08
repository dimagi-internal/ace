/**
 * Resolve which ace-web workspace a run targets and print its `run_workspace:`
 * block (with the nested `connect_orgs:` block every Connect-acting phase
 * dispatch carries). Read-only: one GET of ace-web's tenancy endpoint.
 *
 *   npx tsx scripts/resolve-run-workspace.ts <opp>                 # default workspace
 *   npx tsx scripts/resolve-run-workspace.ts <opp>/<run-id>
 *   npx tsx scripts/resolve-run-workspace.ts <ws>/<opp>[/<run-id>]
 *
 * Exit 0 with `status: ok`, exit 2 with `status: fail` + `code` + `remediation`
 * (a partner workspace whose tenancy is incomplete, names a shared tenant, or
 * names an OCS team this session cannot reach). The orchestrator runs this at
 * `/ace:run` start (agents/ace-orchestrator.md § Starting a New Opportunity
 * step 1) and halts on exit 2. Logic: lib/run-workspace.ts.
 */
import { loadPluginEnv } from '../lib/load-plugin-env.js';
import { parseOppRef } from '../lib/run-paths.js';
import {
  defaultWorkspace,
  fetchOppTenancy,
  renderRunWorkspaceYaml,
  resolveRunWorkspace,
  RunWorkspaceError,
  type TenancyResponse,
} from '../lib/run-workspace.js';

loadPluginEnv(import.meta.url);

async function main(): Promise<number> {
  const target = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (!target) {
    process.stderr.write('usage: resolve-run-workspace.ts <opp> | <opp>/<run-id> | <ws>/<opp>[/<run-id>]\n');
    return 64;
  }
  const env = process.env as Record<string, string | undefined>;
  let out: string;
  let ok = false;
  try {
    const ref = parseOppRef(target);
    const workspace = ref.workspace ?? defaultWorkspace(env);
    let response: TenancyResponse | null = null;
    let responseError: Error | null = null;
    if (workspace) {
      try {
        response = await fetchOppTenancy({
          baseUrl: env.ACE_WEB_BASE_URL,
          token: env.ACE_WEB_PAT_TOKEN,
          workspace,
          opp: ref.opp,
        });
      } catch (e) {
        responseError = e instanceof Error ? e : new Error(String(e));
      }
    }
    const rw = resolveRunWorkspace({ workspace: ref.workspace, opp: ref.opp, env, response, responseError });
    out = renderRunWorkspaceYaml(rw);
    if (ref.runId) out += `\n  run_id: ${ref.runId}`;
    ok = true;
  } catch (e) {
    const err =
      e instanceof RunWorkspaceError
        ? e
        : new RunWorkspaceError('BAD_SLUG', e instanceof Error ? e.message : String(e), 'pass <opp>, <opp>/<run-id> or <ws>/<opp>[/<run-id>]');
    out = renderRunWorkspaceYaml(err);
  }
  process.stdout.write(out + '\n');
  return ok ? 0 : 2;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`resolve-run-workspace: ${e instanceof Error ? e.stack : String(e)}\n`);
    process.exit(1);
  },
);
