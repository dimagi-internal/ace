/**
 * Which ace-web WORKSPACE a run is built in, and that workspace's tenancy —
 * resolved in ONE place.
 *
 * Owner, 2026-10-08: "just like the tenants for commcare, ocs, and connect are
 * configurable so too should the workspace be." `/ace:run <ws>/<opp>` builds a
 * run directly in workspace `<ws>`: its Drive root, its HQ project space, its
 * Connect PM + holding orgs — so it reads that workspace's reviewer answers
 * (`<opp>/inputs/decision-overrides.yaml` under the workspace's own Drive root)
 * and lands where its reviewers already are, instead of building in the
 * default workspace and re-cloning.
 *
 * Source of truth: ace-web's `GET /api/w/<ws>/opps/<opp>/tenancy` →
 * `{slug, tenancy: {hq_domain, connect_pm_org, connect_holding_org, ocs_team?},
 * drive_root_folder_id, source}` — the same read `bin/ace-bind` makes to bind a
 * session (that one is Python-stdlib because the tenancy hook is; this is the
 * TS side, shared with `scripts/release-readiness.ts`).
 *
 * Two regimes, deliberately asymmetric:
 *
 * - **Default workspace** (`ACE_WEB_WORKSPACE`, `dimagi-team`): every value
 *   comes from the installed `.env` exactly as before workspaces were
 *   addressable, so nothing changes for existing runs. The ace-web tenancy is
 *   read only to WARN when it disagrees with `.env`.
 * - **Any other workspace** (a partner's): every value comes from ace-web and
 *   a missing one is a typed `RunWorkspaceError` naming the field and how to
 *   set it. There is NO fallback to `.env` — that would build a partner run in
 *   the shared HQ space / Connect orgs, which is exactly what clones exist to
 *   avoid. A partner tenancy that NAMES a shared tenant is refused for the same
 *   reason.
 *
 * Pure except `fetchOppTenancy` (one GET, injectable fetch). The CLI is
 * `scripts/resolve-run-workspace.ts`; the orchestrator calls it at run start.
 *
 * *Enforced:* `test/lib/run-workspace.test.ts`.
 */

import { connectOrgsFromTenancy, renderConnectOrgsBlock, resolveConnectOrgs, type ConnectOrgs } from './connect-orgs.js';

/** The tenancy fields ace-web stores per opp (`apps/opps/tenancy.py` `Tenancy`). */
export interface AceWebTenancy {
  hq_domain?: string | null;
  connect_pm_org?: string | null;
  connect_holding_org?: string | null;
  ocs_team?: string | null;
}

/** Body of `GET /api/w/<ws>/opps/<opp>/tenancy`. */
export interface TenancyResponse {
  slug?: string;
  tenancy?: AceWebTenancy | null;
  drive_root_folder_id?: string | null;
  /** `opp` (the opp's own row) or `workspace-default` (no row yet). */
  source?: string;
}

export type RunWorkspaceErrorCode =
  | 'NO_DEFAULT_WORKSPACE'
  | 'ACE_WEB_NOT_CONFIGURED'
  | 'TENANCY_UNREADABLE'
  | 'TENANCY_INCOMPLETE'
  | 'SHARED_TENANT'
  | 'OCS_TEAM_MISMATCH'
  | 'BAD_SLUG';

/** Loud, typed failure: `fields` names what is missing/wrong, `remediation` says how to fix it. */
export class RunWorkspaceError extends Error {
  constructor(
    readonly code: RunWorkspaceErrorCode,
    message: string,
    readonly remediation: string,
    readonly fields: string[] = [],
  ) {
    super(message);
    this.name = 'RunWorkspaceError';
  }
}

export interface RunWorkspace {
  workspace: string;
  opp: string;
  /** True iff `workspace` is the instance default (`ACE_WEB_WORKSPACE`). */
  is_default: boolean;
  /** Where the values below came from. */
  source: 'env' | 'ace-web';
  /** The workspace's ACE Drive root — pass as `resolve_opp_path`'s `aceRootFolderId`. */
  drive_root_folder_id: string;
  /** HQ project space Phase 3 deploys and releases into. */
  hq_domain: string;
  /** Connect orgs for every Connect-acting phase (feed `phase4Orgs`). */
  connect_orgs: ConnectOrgs;
  /** OCS team the run's chatbot lives on (always the configured one — see `ocs.note`). */
  ocs: { team: string; source: 'tenancy' | 'configured'; note: string };
  /**
   * The `api_key` Phase 4 hands Connect for the run's apps. Default workspace:
   * ACE's own key, as before. Partner workspace: a key restricted to the
   * partner's HQ space, minted by Phase 4 (`commcare_create_api_key`) under
   * `hqApiKeyName(...)` — a partner's opportunity must never hold ACE's
   * all-spaces key (`lib/hq-api-key-store.ts`).
   */
  hq_api_key: { kind: 'instance'; ref: '${ACE_HQ_API_KEY}' } | { kind: 'space-restricted'; mint_per_run: true };
  /** Non-fatal observations (default workspace only: ace-web vs .env drift). */
  warnings: string[];
}

const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function clean(v: string | null | undefined): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim().replace(/^['"]|['"]$/g, '');
  if (t === '' || t.startsWith('op://')) return null;
  return t;
}

/** The workspace a bare `<opp>` argument means. */
export function defaultWorkspace(env: Record<string, string | undefined>): string | null {
  return clean(env.ACE_WEB_WORKSPACE);
}

/** `scripts/resolve-run-workspace.ts` / ace-bind: the URL of the tenancy read. */
export function tenancyUrl(baseUrl: string, workspace: string, opp: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/api/w/${encodeURIComponent(workspace)}/opps/${encodeURIComponent(opp)}/tenancy`;
}

/**
 * Read an opp's tenancy from ace-web. Throws `RunWorkspaceError`
 * (`ACE_WEB_NOT_CONFIGURED` / `TENANCY_UNREADABLE`) rather than returning a
 * partial value — callers decide whether a failed read is fatal.
 */
export async function fetchOppTenancy(opts: {
  baseUrl: string | undefined;
  token: string | undefined;
  workspace: string;
  opp: string;
  fetchImpl?: typeof fetch;
}): Promise<TenancyResponse> {
  const base = clean(opts.baseUrl);
  const token = clean(opts.token);
  if (!base || !token) {
    throw new RunWorkspaceError(
      'ACE_WEB_NOT_CONFIGURED',
      'ACE_WEB_BASE_URL and ACE_WEB_PAT_TOKEN are required to read a workspace tenancy',
      'run /ace:setup (it writes ACE\'s own ace-web token), or /ace:ace-web-pat-mint',
      ['ACE_WEB_BASE_URL', 'ACE_WEB_PAT_TOKEN'],
    );
  }
  const url = tenancyUrl(base, opts.workspace, opts.opp);
  const f = opts.fetchImpl ?? fetch;
  let r: Response;
  try {
    r = await f(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  } catch (e) {
    throw new RunWorkspaceError(
      'TENANCY_UNREADABLE',
      `could not reach ace-web at ${base}: ${e instanceof Error ? e.message : String(e)}`,
      'check the network / ACE_WEB_BASE_URL and retry',
    );
  }
  if (r.status === 404) {
    throw new RunWorkspaceError(
      'TENANCY_UNREADABLE',
      `ace-web has no workspace ${JSON.stringify(opts.workspace)} that ACE's token belongs to (404 on ${url})`,
      `check the workspace slug; an owner of ${opts.workspace} invites ace@dimagi-ai.com (clone-to-new-workspace § Step 0)`,
    );
  }
  if (!r.ok) {
    throw new RunWorkspaceError(
      'TENANCY_UNREADABLE',
      `ace-web returned HTTP ${r.status} for ${url}`,
      r.status === 401 || r.status === 403
        ? 're-mint ACE\'s ace-web token (/ace:setup) and confirm ace@ is a member of the workspace'
        : 'retry; if persistent, open the URL as ace@',
    );
  }
  return (await r.json()) as TenancyResponse;
}

function sharedTenants(env: Record<string, string | undefined>) {
  let orgs: string[] = [];
  try {
    const o = resolveConnectOrgs(env);
    orgs = [o.pm_org, o.nm_org].filter((x): x is string => !!x);
  } catch {
    /* an unusable .env org is the default workspace's problem, not this check's */
  }
  return {
    drive_root: clean(env.ACE_DRIVE_ROOT_FOLDER_ID),
    hq_domain: clean(env.ACE_HQ_DOMAIN),
    connect_orgs: new Set(orgs),
  };
}

const TENANCY_FIX = (ws: string, opp: string) =>
  `an owner of workspace ${ws} records it in ace-web — PATCH /api/w/${ws}/opps/${opp}/tenancy (or the workspace default, PATCH /api/workspaces/${ws}); ` +
  'the clone-to-new-workspace operator checklist (Step 0) sets up and verifies each one';

/**
 * Resolve the workspace a run targets. Pure: pass the env map and, for any
 * workspace other than the default, the ace-web tenancy response (or the
 * error reading it).
 */
export function resolveRunWorkspace(input: {
  workspace: string | null;
  opp: string;
  env: Record<string, string | undefined>;
  response?: TenancyResponse | null;
  responseError?: Error | null;
}): RunWorkspace {
  const { env, opp } = input;
  const def = defaultWorkspace(env);
  const workspace = input.workspace ?? def;
  if (!workspace) {
    throw new RunWorkspaceError(
      'NO_DEFAULT_WORKSPACE',
      'no workspace given and ACE_WEB_WORKSPACE is unset in the installed .env',
      'pass <workspace>/<opp>, or set ACE_WEB_WORKSPACE (/ace:setup --force-env)',
      ['ACE_WEB_WORKSPACE'],
    );
  }
  for (const [k, v] of [['workspace', workspace], ['opp', opp]] as const) {
    if (!SLUG.test(v)) {
      throw new RunWorkspaceError('BAD_SLUG', `${k} ${JSON.stringify(v)} is not a slug`, 'use the slug from the ace-web URL', [k]);
    }
  }
  const configuredOcs = clean(env.OCS_TEAM_SLUG);
  const t: AceWebTenancy = input.response?.tenancy ?? {};

  if (workspace === def) {
    // Default workspace: .env is authoritative — nothing changes for existing runs.
    const drive = clean(env.ACE_DRIVE_ROOT_FOLDER_ID);
    const hq = clean(env.ACE_HQ_DOMAIN) ?? 'connect-ace-prod';
    const missing = [!drive && 'ACE_DRIVE_ROOT_FOLDER_ID', !configuredOcs && 'OCS_TEAM_SLUG'].filter(Boolean) as string[];
    if (missing.length) {
      throw new RunWorkspaceError(
        'TENANCY_INCOMPLETE',
        `the default workspace's .env is missing ${missing.join(', ')}`,
        're-inject the installed .env: /ace:setup --force-env',
        missing,
      );
    }
    const orgs = resolveConnectOrgs(env);
    const warnings: string[] = [];
    if (input.response) {
      const drift = (field: string, aceWeb: string | null | undefined, local: string | null) => {
        const a = clean(aceWeb ?? null);
        if (a && local && a !== local) warnings.push(`ace-web ${field}=${a} but .env says ${local}; this run uses .env (default workspace)`);
      };
      drift('drive_root_folder_id', input.response.drive_root_folder_id, drive);
      drift('tenancy.hq_domain', t.hq_domain, hq);
      drift('tenancy.connect_pm_org', t.connect_pm_org, orgs.pm_org);
      drift('tenancy.connect_holding_org', t.connect_holding_org, orgs.nm_org);
      drift('tenancy.ocs_team', t.ocs_team, configuredOcs);
    } else if (input.responseError) {
      warnings.push(`ace-web tenancy not read (${input.responseError.message}); default workspace runs from .env`);
    }
    return {
      workspace,
      opp,
      is_default: true,
      source: 'env',
      drive_root_folder_id: drive!,
      hq_domain: hq,
      connect_orgs: orgs,
      ocs: { team: configuredOcs!, source: 'configured', note: 'the configured OCS team (OCS_TEAM_SLUG)' },
      hq_api_key: { kind: 'instance', ref: '${ACE_HQ_API_KEY}' },
      warnings,
    };
  }

  // Partner workspace: ace-web is the only source. No .env fallback, ever.
  if (!input.response) {
    const e = input.responseError;
    throw new RunWorkspaceError(
      e instanceof RunWorkspaceError ? e.code : 'TENANCY_UNREADABLE',
      `cannot build in workspace ${workspace}: its tenancy was not read${e ? ` (${e.message})` : ''}`,
      e instanceof RunWorkspaceError ? e.remediation : 'retry the ace-web tenancy read',
      e instanceof RunWorkspaceError ? e.fields : [],
    );
  }
  const drive = clean(input.response.drive_root_folder_id);
  const hq = clean(t.hq_domain);
  const pm = clean(t.connect_pm_org);
  const holding = clean(t.connect_holding_org);
  const missing = [
    !drive && 'drive_root_folder_id',
    !hq && 'tenancy.hq_domain',
    !pm && 'tenancy.connect_pm_org',
    !holding && 'tenancy.connect_holding_org',
  ].filter(Boolean) as string[];
  if (missing.length) {
    throw new RunWorkspaceError(
      'TENANCY_INCOMPLETE',
      `workspace ${workspace}'s tenancy for ${opp} is incomplete — missing ${missing.join(', ')}. ` +
        'A partner run never falls back to the shared tenants.',
      TENANCY_FIX(workspace, opp),
      missing,
    );
  }

  const shared = sharedTenants(env);
  const sharedHits = [
    drive === shared.drive_root && `drive_root_folder_id=${drive} is the default workspace's Drive root`,
    hq === shared.hq_domain && `tenancy.hq_domain=${hq} is the shared HQ space`,
    shared.connect_orgs.has(pm!) && `tenancy.connect_pm_org=${pm} is a shared Connect org`,
    shared.connect_orgs.has(holding!) && `tenancy.connect_holding_org=${holding} is a shared Connect org`,
  ].filter(Boolean) as string[];
  if (sharedHits.length) {
    throw new RunWorkspaceError(
      'SHARED_TENANT',
      `workspace ${workspace}'s tenancy names ACE's shared tenants (${sharedHits.join('; ')}) — a partner run would build in the space it must be isolated from`,
      TENANCY_FIX(workspace, opp),
      sharedHits.map((h) => h.split('=')[0]),
    );
  }

  const tenancyOcs = clean(t.ocs_team);
  if (tenancyOcs && tenancyOcs !== configuredOcs) {
    throw new RunWorkspaceError(
      'OCS_TEAM_MISMATCH',
      `workspace ${workspace}'s tenancy names OCS team ${tenancyOcs}, but this session's OCS MCP is fixed to ${configuredOcs ?? '(unset)'} (OCS_TEAM_SLUG is read once at MCP start)`,
      `set OCS_TEAM_SLUG=${tenancyOcs} in the installed .env, fully restart Claude Code, then re-run — or clear ocs_team in the tenancy so the bot stays on ${configuredOcs ?? 'the configured team'} and is reviewed by public link`,
      ['tenancy.ocs_team'],
    );
  }
  if (!configuredOcs) {
    throw new RunWorkspaceError('TENANCY_INCOMPLETE', 'OCS_TEAM_SLUG is unset in the installed .env', 're-inject the installed .env: /ace:setup --force-env', ['OCS_TEAM_SLUG']);
  }

  let orgs: ConnectOrgs;
  try {
    orgs = connectOrgsFromTenancy({ connect_pm_org: pm, connect_holding_org: holding });
  } catch (e) {
    throw new RunWorkspaceError('TENANCY_INCOMPLETE', e instanceof Error ? e.message : String(e), TENANCY_FIX(workspace, opp), ['tenancy.connect_pm_org']);
  }

  return {
    workspace,
    opp,
    is_default: false,
    source: 'ace-web',
    drive_root_folder_id: drive!,
    hq_domain: hq!,
    connect_orgs: orgs,
    ocs: tenancyOcs
      ? { team: tenancyOcs, source: 'tenancy', note: `the workspace's own OCS team (${tenancyOcs})` }
      : {
          team: configuredOcs,
          source: 'configured',
          note: `the tenancy names no OCS team, so the bot is built on the configured team (${configuredOcs}) and reviewed by its public link, as a clone's is — say so in the run summary`,
        },
    hq_api_key: { kind: 'space-restricted', mint_per_run: true },
    warnings: [],
  };
}

/**
 * Name of the space-restricted HQ key Phase 4 mints for a partner-workspace
 * run (`commcare_create_api_key(domain, name)` → `hq-key:<name>`). Per run, so
 * minting never rotates a key another opportunity (e.g. the clone's) holds.
 */
export function hqApiKeyName(hqDomain: string, runId: string): string {
  return `ace-run-${hqDomain}-${runId}`;
}

/** The public run-summary page (no login) — `run_state.yaml` `ace_web_summary_url`. */
export function runSummaryUrl(baseUrl: string, workspace: string, opp: string, runId: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/opps/${workspace}/${opp}/runs/${runId}/summary`;
}

/** The members' workbench page for a run. */
export function runWorkbenchUrl(baseUrl: string, workspace: string, opp: string, runId: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/w/${workspace}/opps/${opp}/runs/${runId}`;
}

/**
 * The `run_workspace:` block the orchestrator prints at run start and passes,
 * with its nested `connect_orgs:` block, into every phase dispatch.
 * `preflight_reads` lists the cheap reads the orchestrator makes before Phase 1
 * to prove ACE can reach a partner's HQ space and Connect orgs.
 */
export function renderRunWorkspaceYaml(r: RunWorkspace | RunWorkspaceError): string {
  if (r instanceof RunWorkspaceError) {
    return [
      'run_workspace:',
      '  status: fail',
      `  code: ${r.code}`,
      `  fields: [${r.fields.map((f) => JSON.stringify(f)).join(', ')}]`,
      `  message: ${JSON.stringify(r.message)}`,
      `  remediation: ${JSON.stringify(r.remediation)}`,
    ].join('\n');
  }
  const reads = r.is_default
    ? []
    : [
        `commcare_list_apps(domain: ${r.hq_domain})   # 200 = ace@ reaches the HQ space`,
        `get_hq_connection()   # Nova: available_domains[].name must include ${r.hq_domain}, or Phase 3 cannot upload (missing → press Refresh on the CommCare HQ card at https://commcare.app/settings; Nova stores the reachable spaces when the key is saved)`,
        `connect_list_programs(organization_slug: ${r.connect_orgs.pm_org})   # ace@ reads the PM org`,
        `connect_list_opportunities(organization_slug: ${r.connect_orgs.nm_org})   # ace@ reads the holding org`,
      ];
  return [
    'run_workspace:',
    '  status: ok',
    `  workspace: ${r.workspace}`,
    `  opp: ${r.opp}`,
    `  is_default: ${r.is_default}`,
    `  source: ${r.source}`,
    `  drive_root_folder_id: ${r.drive_root_folder_id}`,
    `  hq_domain: ${r.hq_domain}`,
    `  ocs_team: ${r.ocs.team}`,
    `  ocs_source: ${r.ocs.source}`,
    `  ocs_note: ${JSON.stringify(r.ocs.note)}`,
    r.hq_api_key.kind === 'instance'
      ? '  hq_api_key: "${ACE_HQ_API_KEY}"'
      : `  hq_api_key: "hq-key:${hqApiKeyName(r.hq_domain, '<run-id>')}"   # Phase 4 mints it: commcare_create_api_key(domain: ${r.hq_domain}, name: ${hqApiKeyName(r.hq_domain, '<run-id>')})`,
    `  preflight_reads:${reads.length ? '' : ' []'}`,
    ...reads.map((x) => `    - ${x}`),
    `  warnings:${r.warnings.length ? '' : ' []'}`,
    ...r.warnings.map((w) => `    - ${JSON.stringify(w)}`),
    renderConnectOrgsBlock(r.connect_orgs, '  '),
  ].join('\n');
}
