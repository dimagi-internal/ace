// The operator setup checklist that opens every `clone-to-new-workspace` run
// (operator decision, Jon 2026-10-02): "When we are doing a clone, have me
// create the HQ space and turn on demo mode, and then have me manually create
// a PM and NM org for you to use, and give me clear URLs to click to do all of
// this efficiently."
//
// Amended 2026-10-07: ace@ now holds Connect's `all_org_profile_edit_access`
// (dimagi/commcare-connect#1580, CI-995), so ACE CREATES both Connect orgs
// itself (`scripts/clone-setup-checklist.ts create-orgs`), named
// `<workspace>-pm-test` / `<workspace>-nm-test` (Jon, 2026-10-07: "make sure
// your naming convention is consistent, end in xxx-pm-test and xxx-nm-test").
//
// Amended 2026-10-15 (ace#3014, Jon): "for 1, you should create it and make
// yourself admin, you just tell me to fix the subscription after you've
// created it (that's how this should work in general). for 2, you shouldn't be
// telling me to go through django admin, there is a proper edit page I just
// need to toggle for you". So ACE creates the HQ space too
// (`commcare_create_domain`, hr_name `connect-ace-<workspace>`; the creator is
// its Admin — no invitation), and the checklist is only what ace@ cannot do:
//   - HQ demo mode (superuser-only subscription change), and
//   - Program manager on the program org, toggled on that org's own edit page
//     `/a/<org>/organization/` by staff with org-management access. ace@'s view
//     of that page omits the field (live 2026-10-07), which is why it stays
//     the operator's. Never Django admin.
// There is no "Is test" item. The owner, using the edit page live on
// 2026-10-15, found it shows the Program manager toggle but no Is test toggle,
// and the clone (dimagi-team/noora-health/20261015-1129) went on without it:
// none of the read-backs below ever needed it. Do not route it to Django admin.
//
// This module is the SINGLE source of every URL the operator clicks and of the
// checks ACE then runs; the skill, `playbook/integrations/commcare-api.md § New
// project spaces` and `playbook/integrations/connect-api.md § Org setup` all
// point here.
//
// Every URL below was read from upstream source (2026-10-02):
//   HQ  create space   ACE: `commcare_create_domain` (POST /register/domain/; never sent to the operator)
//   HQ  demo mode      /a/<d>/settings/project/internal_subscription_management/   (lib/hq-enterprise-flip.ts)
//   HQ  accept invite  /a/<d>/settings/users/join/<uuid>/     users/urls.py `domain_accept_invitation`;
//                      UserInvitationView accepts on an authenticated POST by the invited user
//                      (corehq/apps/users/views/web.py). The emailed link has exactly this
//                      shape (ace@ mailbox, "Invitation from … to join CommCareHQ", 2026-10-02).
//                      Only for a space someone else created; one ACE created needs none.
//   HQ  read-back      /a/<d>/settings/users/my_role/         corehq/apps/users/views/my_role.py →
//                      {role, is_domain_admin, …}; 404 for a space that does not exist
//                      (live, 2026-10-02: connect-ace-prod 200 Admin, made-up slug 404).
//   Connect create org /register/organization/                config/urls.py `organization_create`
//                      (OrganizationCreateForm; only `name` is required). The creator becomes
//                      Admin and is redirected to /a/<slug>/opportunity/ — unless it ticks
//                      `skip_membership`, which ACE never does. The slug is
//                      `slugify_uniquely(name)`; `clean_name` refuses a name already used
//                      (case-insensitive) and re-renders the form (200).
//   Connect org home   /a/<org>/organization/                 `organization_home`, @org_profile_edit_access_required
//                      → since #1580 (2026-10-07) 200 for ANY org ace@ can profile-edit,
//                      i.e. every org — so it no longer proves membership (live: `dimagi`,
//                      where ace@ is not a member, 200). It does prove the org EXISTS (404 if not).
//                      It is also the org's EDIT page, where staff toggle Program manager (it has no Is test toggle).
//   Connect members    /a/<org>/organization/member_table     `org_member_table`, @org_admin_access_required
//                      → 200 only for an org ADMIN, else 404 (live 2026-10-07: ace-pm-org 200,
//                      `dimagi` 404). THIS is the admin read-back.
//   Connect accept     /a/<org>/organization/invite/<token>/  `accept_invite`: an authenticated GET by
//                      the invited email accepts it (no form).
//   Connect PM probe   /a/<org>/program/init/                 ProgramCreate(OrgPMRequiredMixin): 200 iff the
//                      org has program_manager AND the user is its admin, else 404. ace@ has
//                      no all-org access, so the probe discriminates (live 2026-10-02: the
//                      configured PM org 200, the NM org 404).

import { hqEnterpriseFlipUrl, HQ_BASE_URL } from './hq-enterprise-flip.js';

export const CONNECT_BASE_URL = 'https://connect.dimagi.com';
export const ACE_EMAIL = 'ace@dimagi-ai.com';
/** HQ `DomainRegistrationForm` caps the project name at 25 characters. */
export const HQ_NAME_MAX = 25;

export const CONNECT_REGISTER_ORG_URL = `${CONNECT_BASE_URL}/register/organization/`;

export interface CloneSetupSlugs {
  /** ace-web workspace slug the clone goes to. */
  workspace: string;
  /** The HQ space ACE created (the `domain` `commcare_create_domain` returned). */
  hqDomain?: string;
  pmOrg?: string;
  nmOrg?: string;
  /** `--keep-shared connect`: the clone keeps the shared Connect orgs, so no Connect items. */
  skipConnect?: boolean;
}

const PH = { hq: '<hq-space>' } as const;

/** Fill a URL whose path segment may be a placeholder (never URL-encode a placeholder). */
function withSlug(build: (slug: string) => string, slug: string | undefined, placeholder: string): string {
  if (slug) return build(slug);
  const SENTINEL = 'ZZSLUGZZ';
  return build(SENTINEL).replace(SENTINEL, placeholder);
}

export const hqMyRoleUrl = (d: string) => `${HQ_BASE_URL}/a/${encodeURIComponent(d)}/settings/users/my_role/`;
export const connectOrgHomeUrl = (o: string) => `${CONNECT_BASE_URL}/a/${encodeURIComponent(o)}/organization/`;
export const connectOrgMembersUrl = (o: string) => `${CONNECT_BASE_URL}/a/${encodeURIComponent(o)}/organization/member_table`;
export const connectProgramInitUrl = (o: string) => `${CONNECT_BASE_URL}/a/${encodeURIComponent(o)}/program/init/`;

/** The HQ project name ACE creates the space with: `connect-ace-<workspace>`, cut to HQ's 25-char cap. */
export function suggestedHqDomain(workspace: string): string {
  return `connect-ace-${workspace}`.slice(0, HQ_NAME_MAX).replace(/-+$/, '');
}

/**
 * The Connect org names (and therefore slugs) ACE creates for a clone:
 * `<workspace>-pm-test` runs the program, `<workspace>-nm-test` holds the
 * opportunity. Connect derives the slug from the name, and a workspace slug is
 * already slug-shaped, so name === slug unless Connect had to make it unique —
 * which `create-orgs` refuses rather than accepting a suffixed slug.
 */
export function connectOrgNames(workspace: string): { pm: string; nm: string } {
  return { pm: `${workspace}-pm-test`, nm: `${workspace}-nm-test` };
}

/** Flags first; otherwise the naming convention. Never derives a value for `--keep-shared connect`. */
export function withDefaultOrgs(s: CloneSetupSlugs): CloneSetupSlugs {
  if (s.skipConnect || !s.workspace) return s;
  const d = connectOrgNames(s.workspace);
  return { ...s, pmOrg: s.pmOrg ?? d.pm, nmOrg: s.nmOrg ?? d.nm };
}

/**
 * The message ACE sends the operator. Markdown, one message, every URL
 * clickable, every slug substituted. Written for the operator, not for ACE: no
 * internal vocabulary (see the jargon test in test/lib/clone-setup-checklist.test.ts).
 * It asks only for what ace@ cannot do itself — never to create the space or
 * the orgs, never to invite ace@, never Django admin (ace#3014). So the HQ
 * space must exist first: ACE creates it and passes the slug HQ returned.
 */
export function renderCloneSetupChecklist(input: CloneSetupSlugs): string {
  const s = withDefaultOrgs(input);
  const ws = s.workspace;
  const hq = s.hqDomain;
  if (!hq) {
    throw new Error(
      `renderCloneSetupChecklist: hqDomain is required — ACE creates the HQ space first (commcare_create_domain, hr_name ${suggestedHqDomain(ws)}) and passes the slug it returned`,
    );
  }
  const lines: string[] = [];

  const items = s.skipConnect ? 'one HQ setting' : 'one HQ setting and one Connect setting';
  lines.push(
    `**Setup for the \`${ws}\` workspace: ${items}** (about ${s.skipConnect ? 2 : 4} minutes in your browser).`,
    `ACE has already created the HQ project space${s.skipConnect ? '' : ' and both Connect organizations'} and is their Admin. These are the settings only you can change. Afterwards ACE checks every item.`,
    '',
    `**1. CommCare HQ project space \`${hq}\`**`,
    `   a. Turn on demo mode (needs your HQ superuser login): open ${hqEnterpriseFlipUrl(hq)}, set **Subscription Type** to **Test or Demo Project**, and press **Update**. It is not invoiced. Do not pick a paid plan or a trial instead.`,
  );

  if (!s.skipConnect) {
    const pm = s.pmOrg as string;
    const nm = s.nmOrg as string;
    lines.push(
      '',
      `**2. Connect organization \`${pm}\`**`,
      `   a. \`${pm}\` runs the program, so it needs a setting only Connect staff can change (needs your Connect staff login): open its edit page ${connectOrgHomeUrl(pm)}, turn on **Program manager**, and press **Save**. Nothing is needed on \`${nm}\`, which holds the opportunity.`,
    );
  }

  lines.push('', '**Then reply "done".**');
  return lines.join('\n');
}

export interface VerifyCheck {
  id: string;
  system: 'hq' | 'connect';
  /** What ACE runs (an MCP tool call or a session GET). */
  how: string;
  /** What passing looks like. */
  pass: string;
  /** The checklist item that fixes a failure, e.g. "1b". */
  fixItem: string;
  /** `session`: run by `scripts/clone-setup-checklist.ts verify --live`; `tool`: an MCP call the skill makes. */
  by: 'session' | 'tool';
}

/** The read-only checks ACE runs after the operator replies — the skill runs exactly these. */
export function cloneSetupVerifyChecks(input: CloneSetupSlugs): VerifyCheck[] {
  const s = withDefaultOrgs(input);
  const hq = s.hqDomain ?? PH.hq;
  const checks: VerifyCheck[] = [
    { id: 'hq-admin', system: 'hq', by: 'session', fixItem: 'create-space', how: `GET ${withSlug(hqMyRoleUrl, s.hqDomain, PH.hq)}`, pass: '200 with is_domain_admin: true (the space exists and ace@ is an Admin; 404 = no such space — ACE creates it with commcare_create_domain)' },
    { id: 'hq-plan', system: 'hq', by: 'tool', fixItem: '1a', how: `commcare_get_subscription(domain: ${hq})`, pass: 'is_paid_edition: true (demo mode is on)' },
    { id: 'hq-api', system: 'hq', by: 'tool', fixItem: '1a', how: `commcare_list_apps(domain: ${hq})`, pass: '200 (the REST API is open; HQ_API_NOT_IN_PLAN = still on Free)' },
  ];
  if (s.skipConnect) return checks;
  const pm = s.pmOrg as string;
  const nm = s.nmOrg as string;
  checks.push(
    { id: 'pm-admin', system: 'connect', by: 'session', fixItem: 'create-orgs', how: `GET ${connectOrgMembersUrl(pm)}`, pass: '200 (ace@ is an Admin of the org; 404 = no such org, or ace@ not an Admin — rerun create-orgs)' },
    { id: 'pm-program-manager', system: 'connect', by: 'session', fixItem: '2a', how: `GET ${connectProgramInitUrl(pm)}`, pass: '200 (Program manager is on; 404 = off)' },
    { id: 'pm-programs', system: 'connect', by: 'tool', fixItem: '2a', how: `connect_list_programs(organization_slug: ${pm})`, pass: 'succeeds' },
    { id: 'nm-admin', system: 'connect', by: 'session', fixItem: 'create-orgs', how: `GET ${connectOrgMembersUrl(nm)}`, pass: '200 (ace@ is an Admin of the org)' },
    { id: 'nm-opportunities', system: 'connect', by: 'tool', fixItem: 'create-orgs', how: `connect_list_opportunities(organization_slug: ${nm})`, pass: 'succeeds' },
  );
  return checks;
}

export function renderVerifyChecks(s: CloneSetupSlugs): string {
  return cloneSetupVerifyChecks(s)
    .map((c) => `- [${c.id}] (${c.by === 'session' ? 'verify --live' : 'MCP'}) ${c.how} → ${c.pass}. On failure: checklist item ${c.fixItem}.`)
    .join('\n');
}

// ── Invitation links in ace@'s mailbox ─────────────────────────────────────

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The HQ join link for `domain` in an invitation email body, or null. */
export function extractHqInviteUrl(text: string, domain: string): string | null {
  const re = new RegExp(`https://www\\.commcarehq\\.org/a/${esc(domain)}/settings/users/join/[0-9a-fA-F-]{20,}/`);
  return re.exec(text)?.[0] ?? null;
}

/** The Connect accept link for `org` in an invitation email body, or null. */
export function extractConnectInviteUrl(text: string, org: string): string | null {
  const re = new RegExp(`https://connect\\.dimagi\\.com/a/${esc(org)}/organization/invite/[A-Za-z0-9_-]{8,}/`);
  return re.exec(text)?.[0] ?? null;
}

// ── Live read-back classification (pure; the script does the I/O) ───────────

export interface ProbeResult {
  id: string;
  ok: boolean;
  detail: string;
}

/** `/a/<d>/settings/users/my_role/` → is ace@ an Admin of an existing space? */
export function classifyHqMyRole(status: number, body: string): ProbeResult {
  if (status === 404) return { id: 'hq-admin', ok: false, detail: 'HQ answers 404: the space does not exist (or the slug is wrong)' };
  if (status !== 200) return { id: 'hq-admin', ok: false, detail: `HQ answered ${status}: ace@ is not a member of the space (ACE did not create it, and no invitation was accepted)` };
  let j: { role?: string; is_domain_admin?: boolean; is_dimagi_admin?: boolean };
  try {
    j = JSON.parse(body);
  } catch {
    return { id: 'hq-admin', ok: false, detail: 'HQ answered 200 but not JSON (a login page?) — re-run after the HQ session refreshes' };
  }
  if (j.is_dimagi_admin) return { id: 'hq-admin', ok: false, detail: 'ace@ reads as a Dimagi global admin, which proves nothing about membership' };
  if (j.is_domain_admin) return { id: 'hq-admin', ok: true, detail: `ace@ is a member with role ${j.role ?? 'Admin'}` };
  return { id: 'hq-admin', ok: false, detail: `ace@ is a member but with role ${j.role ?? '(none)'}, not Admin` };
}

/** A Connect member-table (admin) or program-init GET (redirects not followed). */
export function classifyConnectProbe(id: 'pm-admin' | 'pm-program-manager' | 'nm-admin', status: number): ProbeResult {
  if (status === 200) {
    return { id, ok: true, detail: id === 'pm-program-manager' ? 'Program Manager is on and ace@ is an Admin' : 'ace@ is an Admin' };
  }
  if (status === 302) return { id, ok: false, detail: 'Connect redirected to login — the ACE Connect session is stale (run /ace:connect-login)' };
  if (id === 'pm-program-manager') return { id, ok: false, detail: `Connect answered ${status}: Program manager is off (or ace@ is not an Admin)` };
  return { id, ok: false, detail: `Connect answered ${status}: the org does not exist, or ace@ is not an Admin of it` };
}

// ── Creating the two orgs (ACE's own step since #1580) ──────────────────────

export interface OrgCreateResult {
  role: 'pm' | 'nm';
  name: string;
  status: 'created' | 'exists' | 'taken' | 'suffixed' | 'error';
  ok: boolean;
  detail: string;
}

/**
 * What to do before creating: probe the admin-gated member table, then the org
 * home. 200 on members → ace@ already administers it (rerun: skip). 200 on home
 * only → the name is someone else's org — never adopt it. 404 on both → create.
 */
export function classifyOrgPreflight(role: 'pm' | 'nm', name: string, membersStatus: number, homeStatus: number): OrgCreateResult | null {
  if (membersStatus === 200) return { role, name, status: 'exists', ok: true, detail: 'already exists with ace@ as Admin' };
  if (membersStatus === 302 || homeStatus === 302) return { role, name, status: 'error', ok: false, detail: 'Connect redirected to login — the ACE Connect session is stale (run /ace:connect-login)' };
  if (homeStatus === 200) return { role, name, status: 'taken', ok: false, detail: `an org with slug ${name} exists and ace@ is not its Admin — pick another workspace name or pass --${role}-org` };
  return null;
}

/** The POST to /register/organization/ (redirects not followed). */
export function classifyOrgCreate(role: 'pm' | 'nm', name: string, status: number, location: string, body: string): OrgCreateResult {
  const m = /\/a\/([^/]+)\/(opportunity|organization)\//.exec(location);
  if (status === 302 && m) {
    if (m[1] === name) return { role, name, status: 'created', ok: true, detail: `created ${CONNECT_BASE_URL}/a/${name}/` };
    return { role, name, status: 'suffixed', ok: false, detail: `Connect created it under slug ${m[1]}, not ${name} — use --${role}-org ${m[1]} or retire it` };
  }
  if (status === 302 && /login/.test(location)) return { role, name, status: 'error', ok: false, detail: 'Connect redirected to login — the ACE Connect session is stale (run /ace:connect-login)' };
  const errs = [...body.matchAll(/class="[^"]*(?:invalid-feedback|errorlist|text-red)[^"]*"[^>]*>\s*(?:<[^>]+>\s*)*([^<]+)/g)].map((e) => e[1].trim()).filter(Boolean);
  if (status === 200 && errs.some((e) => /already exists/i.test(e))) return { role, name, status: 'taken', ok: false, detail: `Connect: ${errs.join('; ')}` };
  return { role, name, status: 'error', ok: false, detail: `POST /register/organization/ → ${status}${errs.length ? `: ${errs.join('; ')}` : ''}` };
}
