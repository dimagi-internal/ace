/**
 * The Connect organizations this ACE instance acts in — resolved in ONE place.
 *
 * ACE runs Connect on a program-manager / network-manager model (CLAUDE.md
 * § Phases): the PM org creates the program; an NM org accepts the program
 * invite and holds the opportunity. With an NM org configured, Phase 4's
 * build/QA opportunity is itself held by that (ACE-controlled) NM org, so every
 * run exercises the real flow; the partner LLO's opportunity is still created
 * later, in Phase 9. Which orgs those are is a property of the
 * INSTANCE, not of ACE — another deployment will use its own. Until
 * 2026-09-26 every skill named the PM org as a literal, so there was no way
 * for an instance to say "use mine".
 *
 * Configuration (both optional, read from the installed `.env`):
 *
 *   ACE_CONNECT_PM_ORG   PM org slug. Unset → the legacy default below, so an
 *                        install that has never set it keeps working exactly
 *                        as before.
 *   ACE_CONNECT_NM_ORG   NM org slug. Unset → `null` (not configured). When
 *                        set, Phase 4 runs the REAL PM→NM flow: the PM org
 *                        invites the NM org to the program, the application is
 *                        accepted, and the run's opportunity is created HELD BY
 *                        the NM org (`phase4Orgs` below). Unset keeps the legacy
 *                        self-managed shape (opportunity held by the PM org).
 *
 * Neither key is declared in `.env.tpl` (they are documented there COMMENTED),
 * so `bin/ace-setup --force-env` treats them as local-only keys and preserves
 * them across every re-inject — the per-instance value survives re-setup and
 * 1Password never overrides it. See `playbook/integrations/connect-api.md
 * § Which Connect orgs ACE acts in`.
 *
 * A run that targets an ace-web WORKSPACE other than the instance default
 * (`/ace:run <ws>/<opp>`) does not use these keys at all: its orgs come from
 * that opp's tenancy via `connectOrgsFromTenancy` below (resolved by
 * `lib/run-workspace.ts`), and a tenancy with no PM org is an error, never a
 * fallback to the instance's orgs.
 *
 * What this does NOT govern: an existing opp's program. `opp.yaml.connect.program`
 * records the program's own org (its URL is `/a/<org>/program/...`), and that
 * recorded org stays authoritative for reuse — changing ACE_CONNECT_PM_ORG must
 * never orphan a program an opp already owns.
 *
 * *Enforced:* `test/lib/connect-orgs.test.ts` (resolution),
 * `test/skills/no-hardcoded-connect-org.test.ts` (this file is the only place
 * the legacy slug may appear as a live value).
 */

/** The PM org every ACE install used before orgs were configurable. */
export const LEGACY_DEFAULT_PM_ORG = 'ai-demo-space';

export const PM_ORG_ENV = 'ACE_CONNECT_PM_ORG';
export const NM_ORG_ENV = 'ACE_CONNECT_NM_ORG';

export interface ConnectOrgs {
  /** Slug of the program-manager org (always set — legacy default when unconfigured). */
  pm_org: string;
  /** Slug of the network-manager org, or null when this instance has not configured one. */
  nm_org: string | null;
  source: {
    pm_org: 'env' | 'legacy-default' | 'tenancy';
    nm_org: 'env' | 'unset' | 'tenancy';
  };
}

export class ConnectOrgConfigError extends Error {
  constructor(
    readonly key: string,
    readonly value: string,
    reason: string,
  ) {
    super(`${key}=${JSON.stringify(value)} is not a usable Connect org slug: ${reason}`);
    this.name = 'ConnectOrgConfigError';
  }
}

// A Connect org slug is the `<org>` path segment of `/a/<org>/...`. We only
// refuse what could never be that segment (a pasted URL, a path, whitespace,
// quotes) — we do not guess at Connect's own slug rules beyond that.
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function read(env: Record<string, string | undefined>, key: string): string | null {
  const raw = env[key];
  if (raw === undefined) return null;
  const v = raw.trim().replace(/^['"]|['"]$/g, '');
  if (v === '') return null;
  // An unresolved 1Password reference is "not configured", not a slug.
  if (v.startsWith('op://')) return null;
  if (!SLUG.test(v)) {
    throw new ConnectOrgConfigError(
      key,
      v,
      v.includes('/') ? 'use the slug from the URL path (the part after /a/), not a URL or path' : 'expected letters, digits, "-" or "_"',
    );
  }
  return v;
}

/**
 * Resolve the configured Connect orgs from an environment map. Pure: pass
 * `process.env`, or a map built from the installed `.env` file.
 *
 * Throws `ConnectOrgConfigError` on a value that cannot be an org slug — a
 * misconfiguration fails loud here rather than as a 404 three phases later.
 */
export function resolveConnectOrgs(env: Record<string, string | undefined>): ConnectOrgs {
  const pm = read(env, PM_ORG_ENV);
  const nm = read(env, NM_ORG_ENV);
  return {
    pm_org: pm ?? LEGACY_DEFAULT_PM_ORG,
    nm_org: nm,
    source: {
      pm_org: pm ? 'env' : 'legacy-default',
      nm_org: nm ? 'env' : 'unset',
    },
  };
}

/**
 * The Connect orgs a RUN acts in when it targets an ace-web workspace whose opp
 * tenancy names them (`GET /api/w/<ws>/opps/<opp>/tenancy` → `tenancy`,
 * resolved by `lib/run-workspace.ts`). The tenancy's `connect_pm_org` is the
 * program org and `connect_holding_org` the org that holds the opportunity —
 * exactly the `pm_org` / `nm_org` pair `phase4Orgs` takes, so a workspace run
 * runs the same PM→NM flow in the partner's own orgs.
 *
 * This is the ONLY other way an org slug enters ACE besides `.env`, and it
 * lives here so this file stays the sole resolver. Throws
 * `ConnectOrgConfigError` when the tenancy names no PM org — a partner run
 * must never fall back to the instance's (shared) orgs.
 */
export function connectOrgsFromTenancy(tenancy: {
  connect_pm_org?: string | null;
  connect_holding_org?: string | null;
}): ConnectOrgs {
  const env = {
    [PM_ORG_ENV]: tenancy.connect_pm_org ?? undefined,
    [NM_ORG_ENV]: tenancy.connect_holding_org ?? undefined,
  };
  let pm: string | null;
  let nm: string | null;
  try {
    pm = read(env, PM_ORG_ENV);
    nm = read(env, NM_ORG_ENV);
  } catch (e) {
    if (e instanceof ConnectOrgConfigError) {
      const field = e.key === PM_ORG_ENV ? 'tenancy.connect_pm_org' : 'tenancy.connect_holding_org';
      throw new ConnectOrgConfigError(field, e.value, e.message.replace(/^.*?: /, ''));
    }
    throw e;
  }
  if (!pm) {
    throw new ConnectOrgConfigError('tenancy.connect_pm_org', '', 'the workspace tenancy names no Connect PM org');
  }
  return { pm_org: pm, nm_org: nm, source: { pm_org: 'tenancy', nm_org: nm ? 'tenancy' : 'unset' } };
}

/**
 * Which orgs Phase 4 acts in, derived from the configured orgs.
 *
 * - `pm-nm` (nm_org configured): the program lives in the PM org, the PM org
 *   invites the NM org, the application is accepted, and the opportunity is
 *   created with `target_organization_slug = nm_org` — HELD by the NM org.
 *   Verification rules are then set at the PM org's URL: Connect's
 *   verification-rules page is PM-only and serves only when request org !=
 *   holding org (ace#2419; observed spark-facilitator/20260925-1536, proved
 *   live 2026-09-26 on probe opportunity 7bfcb845-015c-416a-a200-9795c68dfc55).
 * - `self-managed` (nm_org unset): legacy — the PM org holds its own
 *   opportunity, and verification rules cannot be set (ace#2419).
 */
export interface Phase4Orgs {
  mode: 'pm-nm' | 'self-managed';
  /** Org that owns the program; the org whose URL every PM-only surface needs. */
  pm_org: string;
  /** Org the opportunity is created under (`target_organization_slug`). */
  holding_org: string;
  /** True iff Connect will serve the PM-only verification-rules page for this opp. */
  verification_rules_settable: boolean;
}

/**
 * `program_org` overrides the configured PM org when the run REUSES a program
 * whose recorded URL names a different org (that recorded org stays
 * authoritative — see the header).
 */
export function phase4Orgs(orgs: Pick<ConnectOrgs, 'pm_org' | 'nm_org'>, program_org?: string | null): Phase4Orgs {
  const pm = program_org && program_org.trim() !== '' ? program_org : orgs.pm_org;
  if (orgs.nm_org && orgs.nm_org !== pm) {
    return { mode: 'pm-nm', pm_org: pm, holding_org: orgs.nm_org, verification_rules_settable: true };
  }
  return { mode: 'self-managed', pm_org: pm, holding_org: pm, verification_rules_settable: false };
}

/**
 * The two orgs a RUN recorded in `run_state.yaml.phases.connect-setup.products.connect`.
 *
 * New runs write `pm_org_slug` (the program's org — PM-only pages and program
 * reads) and `holding_org_slug` (the org the opportunity lives in — reviewer
 * access, the org an FLW sees). Legacy runs wrote only `organization_slug`,
 * which was both (self-managed), so it backfills either missing key.
 *
 * Returns nulls rather than guessing when nothing is recorded — a reader must
 * not fall back to the CONFIGURED org for a past run, which may have changed.
 */
export function runConnectOrgs(connect: unknown): { pm_org_slug: string | null; holding_org_slug: string | null } {
  const c = (connect && typeof connect === 'object' ? connect : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
  const legacy = str(c.organization_slug);
  return {
    pm_org_slug: str(c.pm_org_slug) ?? legacy,
    holding_org_slug: str(c.holding_org_slug) ?? legacy,
  };
}

/** Render resolved orgs as the `connect_orgs:` block every Connect-acting phase dispatch carries. */
export function renderConnectOrgsBlock(o: ConnectOrgs, indent = ''): string {
  const p4 = phase4Orgs(o);
  const note =
    p4.mode === 'pm-nm'
      ? 'nm_org configured — Phase 4 runs PM→NM: the opportunity is held by nm_org, verification rules are set at pm_org'
      : 'nm_org unset — Phase 4 is self-managed (opportunity held by pm_org; verification rules cannot be set, ace#2419)';
  return [
    'connect_orgs:',
    '  status: ok',
    `  pm_org: "${o.pm_org}"`,
    `  nm_org: ${o.nm_org === null ? 'null' : `"${o.nm_org}"`}`,
    `  phase4_mode: ${p4.mode}`,
    `  phase4_holding_org: "${p4.holding_org}"`,
    '  source:',
    `    pm_org: ${o.source.pm_org}`,
    `    nm_org: ${o.source.nm_org}`,
    `  note: "${note}"`,
  ]
    .map((l) => indent + l)
    .join('\n');
}

/** Render the resolution as the `connect_orgs:` block `bin/ace-doctor --preflight` emits. */
export function renderConnectOrgsYaml(env: Record<string, string | undefined>): string {
  try {
    return renderConnectOrgsBlock(resolveConnectOrgs(env));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return [
      'connect_orgs:',
      '  status: fail',
      '  pm_org: null',
      '  nm_org: null',
      `  remediation: ${JSON.stringify(`${msg} — fix it in the installed .env (local-only key; /ace:setup --force-env preserves it)`)}`,
    ].join('\n');
  }
}
