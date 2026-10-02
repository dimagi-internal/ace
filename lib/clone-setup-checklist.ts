// The operator setup checklist that opens every `clone-to-new-workspace` run
// (operator decision, Jon 2026-10-02): "When we are doing a clone, have me
// create the HQ space and turn on demo mode, and then have me manually create
// a PM and NM org for you to use, and give me clear URLs to click to do all of
// this efficiently."
//
// So ACE no longer creates the partner's HQ space, and per-partner Connect orgs
// are the normal path (not `--keep-shared connect`). This module is the SINGLE
// source of every URL the operator clicks and of the checks ACE then runs; the
// skill, `playbook/integrations/commcare-api.md § New project spaces` and
// `playbook/integrations/connect-api.md § Org setup` all point here.
//
// Every URL below was read from upstream source (2026-10-02):
//   HQ  create space   /register/domain/                      corehq/apps/registration/urls.py `registration_domain`
//   HQ  demo mode      /a/<d>/settings/project/internal_subscription_management/   (lib/hq-enterprise-flip.ts)
//   HQ  invite ace@    /a/<d>/settings/users/web/invite/      corehq/apps/users/urls.py `InviteWebUserView`
//                                                             (live-verified by `commcare_invite_web_user`)
//   HQ  accept invite  /a/<d>/settings/users/join/<uuid>/     users/urls.py `domain_accept_invitation`;
//                      UserInvitationView accepts on an authenticated POST by the invited user
//                      (corehq/apps/users/views/web.py). The emailed link has exactly this
//                      shape (ace@ mailbox, "Invitation from … to join CommCareHQ", 2026-10-02).
//   HQ  read-back      /a/<d>/settings/users/my_role/         corehq/apps/users/views/my_role.py →
//                      {role, is_domain_admin, …}; 404 for a space that does not exist
//                      (live, 2026-10-02: connect-ace-prod 200 Admin, made-up slug 404).
//   Connect create org /register/organization/                config/urls.py `organization_create`; the
//                      creator becomes Admin and lands on /a/<slug>/opportunity/.
//   Connect org home   /a/<org>/organization/                 `organization_home`, @org_admin_access_required
//                      → 200 only for an org ADMIN. "Enable Program Manager" is the
//                      `program_manager` field of OrganizationChangeForm, rendered only for
//                      ORG_MANAGEMENT_SETTINGS_ACCESS holders (Connect staff).
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

export const HQ_REGISTER_URL = `${HQ_BASE_URL}/register/domain/`;
export const CONNECT_REGISTER_ORG_URL = `${CONNECT_BASE_URL}/register/organization/`;

export interface CloneSetupSlugs {
  /** ace-web workspace slug the clone goes to. */
  workspace: string;
  hqDomain?: string;
  pmOrg?: string;
  nmOrg?: string;
  /** `--keep-shared connect`: the clone keeps the shared Connect orgs, so no Connect items. */
  skipConnect?: boolean;
}

const PH = { hq: '<hq-space>', pm: '<program-manager-org>', nm: '<partner-org>' } as const;

/** Fill a URL whose path segment may be a placeholder (never URL-encode a placeholder). */
function withSlug(build: (slug: string) => string, slug: string | undefined, placeholder: string): string {
  if (slug) return build(slug);
  const SENTINEL = 'ZZSLUGZZ';
  return build(SENTINEL).replace(SENTINEL, placeholder);
}

export const hqInviteUrl = (d: string) => `${HQ_BASE_URL}/a/${encodeURIComponent(d)}/settings/users/web/invite/`;
export const hqMyRoleUrl = (d: string) => `${HQ_BASE_URL}/a/${encodeURIComponent(d)}/settings/users/my_role/`;
export const connectOrgHomeUrl = (o: string) => `${CONNECT_BASE_URL}/a/${encodeURIComponent(o)}/organization/`;
export const connectProgramInitUrl = (o: string) => `${CONNECT_BASE_URL}/a/${encodeURIComponent(o)}/program/init/`;

/** The default HQ project name to suggest: `connect-ace-<workspace>`, cut to HQ's 25-char cap. */
export function suggestedHqDomain(workspace: string): string {
  return `connect-ace-${workspace}`.slice(0, HQ_NAME_MAX).replace(/-+$/, '');
}

function titleCase(ws: string): string {
  return ws.split(/[-_]/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

/**
 * The message ACE sends the operator. Markdown, one message, every URL
 * clickable; slugs substituted where known, `<placeholder>` + "send me the
 * slug" where not. Written for the operator, not for ACE: no internal
 * vocabulary (see the jargon test in test/lib/clone-setup-checklist.test.ts).
 */
export function renderCloneSetupChecklist(s: CloneSetupSlugs): string {
  const ws = s.workspace;
  const name = titleCase(ws);
  const hq = s.hqDomain;
  const hqShown = hq ?? suggestedHqDomain(ws);
  const flipUrl = withSlug(hqEnterpriseFlipUrl, hq, PH.hq);
  const inviteUrl = withSlug(hqInviteUrl, hq, PH.hq);
  const lines: string[] = [];

  const items = s.skipConnect ? 'the HQ project space' : 'one HQ project space and two Connect organizations';
  lines.push(
    `**Setup for the \`${ws}\` workspace: ${items}** (about ${s.skipConnect ? 5 : 10} minutes in your browser).`,
    `Do the items in order. Afterwards ACE checks every item, and accepts its own invitations from ${ACE_EMAIL}'s inbox.`,
    '',
    `**1. CommCare HQ project space \`${hq ?? PH.hq}\`**`,
    hq
      ? `   a. Create it (skip if it already exists): ${HQ_REGISTER_URL} with Project Name \`${hq}\`.`
      : `   a. Create it: ${HQ_REGISTER_URL} with Project Name \`${hqShown}\` (${HQ_NAME_MAX} characters at most). **Send me its slug**: the part after \`/a/\` in the address HQ takes you to.`,
    `   b. Turn on demo mode (needs your HQ superuser login): open ${flipUrl}, set **Subscription Type** to **Test or Demo Project**, and press **Update**. It is not invoiced. Do not pick a paid plan or a trial instead.`,
    `   c. Invite ACE: open ${inviteUrl}, enter \`${ACE_EMAIL}\` with role **Admin**, and send the invitation.`,
  );

  if (!s.skipConnect) {
    const pmHome = withSlug(connectOrgHomeUrl, s.pmOrg, PH.pm);
    const nmHome = withSlug(connectOrgHomeUrl, s.nmOrg, PH.nm);
    const createOrg = (slug: string | undefined, suggested: string) =>
      slug
        ? `   a. Create it (skip if it already exists): ${CONNECT_REGISTER_ORG_URL}`
        : `   a. Create it: ${CONNECT_REGISTER_ORG_URL} (suggested name: "${suggested}"). **Send me its slug**: the part after \`/a/\` in the address Connect takes you to.`;
    const addAce = `open **Members**, choose **Add Member**, and add \`${ACE_EMAIL}\` with role **Admin**.`;
    lines.push(
      '',
      `**2. Connect organization that runs the program \`${s.pmOrg ?? PH.pm}\`**`,
      createOrg(s.pmOrg, `${name} Program`),
      `   b. Turn on program management (needs Connect staff access): open ${pmHome}, tick **Enable Program Manager**, and save.`,
      `   c. Invite ACE: on the same page, ${addAce}`,
      '',
      `**3. Connect organization that holds the opportunity \`${s.nmOrg ?? PH.nm}\`**`,
      createOrg(s.nmOrg, name),
      `   b. Invite ACE: on ${nmHome}, ${addAce}`,
    );
  }

  const missing: string[] = [];
  if (!hq) missing.push('the HQ project space slug');
  if (!s.skipConnect && !s.pmOrg) missing.push('the slug of the organization that runs the program');
  if (!s.skipConnect && !s.nmOrg) missing.push('the slug of the organization that holds the opportunity');
  lines.push(
    '',
    missing.length
      ? `**Then reply with** ${missing.join(', ')}, and "done".`
      : '**Then reply "done".**',
  );
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
export function cloneSetupVerifyChecks(s: CloneSetupSlugs): VerifyCheck[] {
  const hq = s.hqDomain ?? PH.hq;
  const checks: VerifyCheck[] = [
    { id: 'hq-admin', system: 'hq', by: 'session', fixItem: '1a/1c', how: `GET ${withSlug(hqMyRoleUrl, s.hqDomain, PH.hq)}`, pass: '200 with is_domain_admin: true (the space exists and ace@ is an Admin; 404 = no such space)' },
    { id: 'hq-plan', system: 'hq', by: 'tool', fixItem: '1b', how: `commcare_get_subscription(domain: ${hq})`, pass: 'is_paid_edition: true (demo mode is on)' },
    { id: 'hq-api', system: 'hq', by: 'tool', fixItem: '1b', how: `commcare_list_apps(domain: ${hq})`, pass: '200 (the REST API is open; HQ_API_NOT_IN_PLAN = still on Free)' },
  ];
  if (s.skipConnect) return checks;
  const pm = s.pmOrg ?? PH.pm;
  const nm = s.nmOrg ?? PH.nm;
  checks.push(
    { id: 'pm-admin', system: 'connect', by: 'session', fixItem: '2a/2c', how: `GET ${withSlug(connectOrgHomeUrl, s.pmOrg, PH.pm)}`, pass: '200 (ace@ is an Admin of the org; 404 = no such org, or ace@ not an Admin)' },
    { id: 'pm-program-manager', system: 'connect', by: 'session', fixItem: '2b', how: `GET ${withSlug(connectProgramInitUrl, s.pmOrg, PH.pm)}`, pass: '200 (Enable Program Manager is on; 404 = off)' },
    { id: 'pm-programs', system: 'connect', by: 'tool', fixItem: '2b', how: `connect_list_programs(organization_slug: ${pm})`, pass: 'succeeds' },
    { id: 'nm-admin', system: 'connect', by: 'session', fixItem: '3a/3b', how: `GET ${withSlug(connectOrgHomeUrl, s.nmOrg, PH.nm)}`, pass: '200 (ace@ is an Admin of the org)' },
    { id: 'nm-opportunities', system: 'connect', by: 'tool', fixItem: '3a/3b', how: `connect_list_opportunities(organization_slug: ${nm})`, pass: 'succeeds' },
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
  if (status !== 200) return { id: 'hq-admin', ok: false, detail: `HQ answered ${status}: ace@ is not a member of the space yet (its invitation is missing or not accepted)` };
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

/** A Connect org-home or program-init GET (redirects not followed). */
export function classifyConnectProbe(id: 'pm-admin' | 'pm-program-manager' | 'nm-admin', status: number): ProbeResult {
  if (status === 200) {
    return { id, ok: true, detail: id === 'pm-program-manager' ? 'Program Manager is on and ace@ is an Admin' : 'ace@ is an Admin' };
  }
  if (status === 302) return { id, ok: false, detail: 'Connect redirected to login — the ACE Connect session is stale (run /ace:connect-login)' };
  if (id === 'pm-program-manager') return { id, ok: false, detail: `Connect answered ${status}: Enable Program Manager is off (or ace@ is not an Admin)` };
  return { id, ok: false, detail: `Connect answered ${status}: the org does not exist, or ace@ is not an Admin of it` };
}
