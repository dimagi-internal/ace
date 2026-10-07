/**
 * clone-setup-checklist — the operator setup that opens every
 * `/ace:clone-to-new-workspace` (operator decision, Jon 2026-10-02), and the
 * checks ACE runs once the operator says "done". All wording and URLs live in
 * `lib/clone-setup-checklist.ts`; this script only does I/O.
 *
 *   npx tsx scripts/clone-setup-checklist.ts [print] --workspace <ws> \
 *       [--hq-domain <slug>] [--pm-org <slug>] [--nm-org <slug>] [--skip-connect]
 *     Print the checklist to send the operator, verbatim (markdown).
 *
 *   npx tsx scripts/clone-setup-checklist.ts create-orgs --workspace <ws> [--pm-org <slug>] [--nm-org <slug>]
 *     ACE creates the two Connect orgs itself (ace@ holds all_org_profile_edit_access
 *     since dimagi/commcare-connect#1580): `<ws>-pm-test` and `<ws>-nm-test` unless
 *     flags say otherwise. Idempotent: an org ace@ already administers is skipped;
 *     a slug owned by someone else, or a create Connect suffixed, fails loudly.
 *     Prints JSON `{ok, orgs[]}`; exit 1 on any failure.
 *
 *   npx tsx scripts/clone-setup-checklist.ts verify --workspace <ws> [slugs…] [--live]
 *     Without --live: list every read-only check ACE runs (session GETs + MCP calls).
 *     With --live: run the session checks (HQ my_role, Connect org home + program
 *     init) and print JSON `{ok, results[]}`; exit 1 when any fails. The MCP
 *     checks (commcare_get_subscription, commcare_list_apps,
 *     connect_list_programs, connect_list_opportunities) are the skill's to run.
 *
 *   npx tsx scripts/clone-setup-checklist.ts accept-invites --hq-domain <slug> \
 *       [--pm-org <slug>] [--nm-org <slug>] [--days 30]
 *     ACE joins the spaces the operator invited it to, by itself: finds each
 *     invitation in ace@'s mailbox (gog, identity from config/agent.json),
 *     accepts it with ACE's own HQ / Connect session, then runs the live
 *     checks. A missing invitation is reported, never guessed around; an
 *     already-accepted one is fine (the read-back is the authority).
 *
 * Auth is reused, never reimplemented: HQ and Connect both go through the
 * Connect `PlaywrightSession` (its OAuth-via-HQ flow leaves valid HQ cookies in
 * the same jar). HTTP only — no click-driving.
 */
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { APIRequestContext } from 'playwright';
import { PlaywrightSession } from '../mcp/connect/auth/playwright-session.js';
import { loadPluginEnv } from '../lib/load-plugin-env.js';
import { resolveGogIdentity } from '../lib/gog-identity.js';
import { csrfFromHtml } from '../lib/hq-web-users-page.js';
import {
  CONNECT_BASE_URL,
  classifyConnectProbe,
  classifyHqMyRole,
  classifyOrgCreate,
  classifyOrgPreflight,
  connectOrgHomeUrl,
  connectOrgMembersUrl,
  connectProgramInitUrl,
  extractConnectInviteUrl,
  extractHqInviteUrl,
  hqMyRoleUrl,
  renderCloneSetupChecklist,
  renderVerifyChecks,
  withDefaultOrgs,
  type CloneSetupSlugs,
  type OrgCreateResult,
  type ProbeResult,
} from '../lib/clone-setup-checklist.js';
import { HQ_BASE_URL } from '../lib/hq-enterprise-flip.js';

loadPluginEnv(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

function slugs(): CloneSetupSlugs {
  return withDefaultOrgs({
    workspace: arg('workspace') ?? '',
    hqDomain: arg('hq-domain'),
    pmOrg: arg('pm-org'),
    nmOrg: arg('nm-org'),
    skipConnect: flag('skip-connect'),
  });
}

function session(): PlaywrightSession {
  return new PlaywrightSession({
    baseUrl: process.env.CONNECT_BASE_URL || CONNECT_BASE_URL,
    cchqBaseUrl: HQ_BASE_URL,
    hqUsername: process.env.ACE_HQ_USERNAME,
    hqPassword: process.env.ACE_HQ_PASSWORD,
  });
}

async function liveChecks(request: APIRequestContext, s: CloneSetupSlugs): Promise<ProbeResult[]> {
  const out: ProbeResult[] = [];
  if (s.hqDomain) {
    const r = await request.get(hqMyRoleUrl(s.hqDomain), { maxRedirects: 0 });
    out.push(classifyHqMyRole(r.status(), await r.text()));
  } else {
    out.push({ id: 'hq-admin', ok: false, detail: 'no --hq-domain: the operator has not sent the HQ space slug yet' });
  }
  if (s.skipConnect) return out;
  const probe = async (id: 'pm-admin' | 'pm-program-manager' | 'nm-admin', url: string) => {
    const r = await request.get(url, { maxRedirects: 0 });
    out.push(classifyConnectProbe(id, r.status()));
  };
  // The member table, not the org home: since #1580 the home answers 200 for any
  // org ace@ can profile-edit (all of them), so it no longer proves Admin.
  await probe('pm-admin', connectOrgMembersUrl(s.pmOrg as string));
  await probe('pm-program-manager', connectProgramInitUrl(s.pmOrg as string));
  await probe('nm-admin', connectOrgMembersUrl(s.nmOrg as string));
  return out;
}

async function createOrg(request: APIRequestContext, role: 'pm' | 'nm', name: string): Promise<OrgCreateResult> {
  const members = await request.get(connectOrgMembersUrl(name), { maxRedirects: 0 });
  const home = members.status() === 200 ? members : await request.get(connectOrgHomeUrl(name), { maxRedirects: 0 });
  const pre = classifyOrgPreflight(role, name, members.status(), home.status());
  if (pre) return pre;
  const url = `${CONNECT_BASE_URL}/register/organization/`;
  const g = await request.get(url, { maxRedirects: 0 });
  if (g.status() !== 200) return { role, name, status: 'error', ok: false, detail: `GET ${url} → ${g.status()} ${g.headers()['location'] ?? ''}`.trim() };
  const csrf = csrfFromHtml(await g.text()) ?? '';
  // `name` is the only required field; skip_membership is left unticked so ace@
  // becomes the org's Admin (it must invite, create programs and opportunities).
  const p = await request.post(url, {
    form: { csrfmiddlewaretoken: csrf, name },
    headers: { Referer: url, 'X-CSRFToken': csrf },
    maxRedirects: 0,
  });
  return classifyOrgCreate(role, name, p.status(), p.headers()['location'] ?? '', p.status() === 200 ? await p.text() : '');
}

function gog(args: string[]): string {
  const { account, client } = resolveGogIdentity({ repoRoot: REPO_ROOT });
  const r = spawnSync('gog', [...args, '-a', account, '--client', client], { encoding: 'utf8', timeout: 60_000 });
  if (r.status !== 0) throw new Error(`gog ${args.slice(0, 2).join(' ')} failed: ${(r.stderr || r.stdout || '').slice(0, 300)}`);
  return r.stdout;
}

/** Newest invitation link for `slug` among threads matching `query`, or null. */
function findInvite(query: string, extract: (text: string) => string | null): string | null {
  const found = JSON.parse(gog(['gmail', 'search', query, '--max', '10', '-j'])) as { threads?: Array<{ id: string }> };
  for (const t of found.threads ?? []) {
    const url = extract(gog(['gmail', 'thread', 'get', t.id, '--full']));
    if (url) return url;
  }
  return null;
}

interface AcceptResult {
  system: 'hq' | 'connect';
  slug: string;
  status: 'accepted' | 'already-used' | 'no-invitation' | 'error';
  detail: string;
}

async function acceptHq(request: APIRequestContext, domain: string, days: number): Promise<AcceptResult> {
  const url = findInvite(
    `from:commcarehq-noreply-production@dimagi.com subject:"to join CommCareHQ" newer_than:${days}d`,
    (t) => extractHqInviteUrl(t, domain),
  );
  if (!url) return { system: 'hq', slug: domain, status: 'no-invitation', detail: `no HQ invitation for ${domain} in the last ${days} days (checklist item 1c)` };
  // UserInvitationView: GET renders the accept page; an authenticated POST by
  // the invited user accepts. An already-accepted invitation redirects to login,
  // which is fine — the my_role read-back decides.
  const g = await request.get(url, { maxRedirects: 0 });
  if (g.status() !== 200) {
    const loc = g.headers()['location'] ?? '';
    const used = g.status() === 302 && /login|no_permissions/.test(loc);
    return { system: 'hq', slug: domain, status: used ? 'already-used' : 'error', detail: `GET ${url} → ${g.status()} ${loc}`.trim() };
  }
  const csrf = csrfFromHtml(await g.text()) ?? '';
  const p = await request.post(url, {
    form: { csrfmiddlewaretoken: csrf },
    headers: { Referer: url, 'X-CSRFToken': csrf },
    maxRedirects: 0,
  });
  return { system: 'hq', slug: domain, status: p.status() === 302 ? 'accepted' : 'error', detail: `POST ${url} → ${p.status()}` };
}

async function acceptConnect(request: APIRequestContext, org: string, days: number, item: string): Promise<AcceptResult> {
  const url = findInvite(
    `from:connect-devops@dimagi.com subject:"invited you to join" newer_than:${days}d`,
    (t) => extractConnectInviteUrl(t, org),
  );
  if (!url) return { system: 'connect', slug: org, status: 'no-invitation', detail: `no Connect invitation for ${org} in the last ${days} days (checklist item ${item})` };
  // accept_invite: an authenticated GET by the invited email accepts, then
  // redirects to the org's opportunity list.
  // An invitation already accepted / revoked / expired redirects to login instead.
  const g = await request.get(url, { maxRedirects: 0 });
  const loc = g.headers()['location'] ?? '';
  const status = g.status() !== 302 ? 'error' : loc.includes(`/a/${org}/opportunity`) ? 'accepted' : /login/.test(loc) ? 'already-used' : 'error';
  return { system: 'connect', slug: org, status, detail: `GET ${url} → ${g.status()} ${loc}`.trim() };
}

async function main(): Promise<void> {
  const cmd = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'print';
  const s = slugs();

  if (cmd === 'print') {
    if (!s.workspace) throw new Error('print: --workspace is required');
    process.stdout.write(renderCloneSetupChecklist(s) + '\n');
    return;
  }

  if (cmd === 'create-orgs') {
    if (!s.workspace || s.skipConnect) throw new Error('create-orgs: --workspace is required, and --skip-connect has no orgs to create');
    const sess = session();
    try {
      const request = (await sess.getContext()).request;
      const orgs = [await createOrg(request, 'pm', s.pmOrg as string), await createOrg(request, 'nm', s.nmOrg as string)];
      const ok = orgs.every((o) => o.ok);
      process.stdout.write(JSON.stringify({ ok, orgs }, null, 2) + '\n');
      if (!ok) process.exitCode = 1;
    } finally {
      await sess.close();
    }
    return;
  }

  if (cmd === 'verify' && !flag('live')) {
    process.stdout.write(renderVerifyChecks(s) + '\n');
    return;
  }

  if (cmd === 'verify' || cmd === 'accept-invites') {
    const sess = session();
    try {
      const request = (await sess.getContext()).request;
      let accepted: AcceptResult[] = [];
      if (cmd === 'accept-invites') {
        const days = Number(arg('days') ?? 30);
        if (s.hqDomain) accepted.push(await acceptHq(request, s.hqDomain, days));
        // Connect orgs are ACE's own since #1580 (create-orgs): there is no invitation
        // to accept for them. One the operator created by hand and invited ace@ to
        // (an explicit --pm-org/--nm-org) is still accepted here.
        const hasInvite = async (org: string) => (await request.get(connectOrgMembersUrl(org), { maxRedirects: 0 })).status() !== 200;
        if (!s.skipConnect && (await hasInvite(s.pmOrg as string))) accepted.push(await acceptConnect(request, s.pmOrg as string, days, 'create-orgs'));
        if (!s.skipConnect && (await hasInvite(s.nmOrg as string))) accepted.push(await acceptConnect(request, s.nmOrg as string, days, 'create-orgs'));
      }
      const results = await liveChecks(request, s);
      const ok = results.every((r) => r.ok);
      process.stdout.write(JSON.stringify({ ok, ...(cmd === 'accept-invites' ? { accepted } : {}), results }, null, 2) + '\n');
      if (!ok) process.exitCode = 1;
    } finally {
      await sess.close();
    }
    return;
  }

  process.stderr.write('usage: clone-setup-checklist.ts [print|create-orgs|verify [--live]|accept-invites] --workspace <ws> [--hq-domain d] [--pm-org o] [--nm-org o] [--skip-connect]\n');
  process.exit(2);
}

main().catch((e) => {
  process.stderr.write(`clone-setup-checklist: ${(e as Error).stack ?? e}\n`);
  process.exit(1);
});
