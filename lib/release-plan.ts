//
// release-plan — the exact list of SHARE actions `/ace:release` will execute.
//
// Owner decision (Jonathan, 2026-10-03): "we should have one
// validate-release-readiness … which does everything that could cause work to
// happen besides sharing, and then the release should just be to share
// everything. but when validate release readiness passes it means executing
// release doesn't change anything other than sharing externally."
//
// So validation computes the plan here, writes it into the verdict with a
// content hash, and the release re-reads it and executes ONLY its actions, in
// order. Nothing the release does is decided at release time except the one
// value no-one can know earlier: the ace-web invite's accept link, which
// ace-web mints when the invite is made. Email bodies carry the literal
// `{{ACCEPT_LINK}}` for it, and that is the only substitution `emailBody`
// performs.
//
// Pure.

import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import type { Memberships } from './run-surface-audit.js';

export const RELEASE_PLAN_SCHEMA_VERSION = 1 as const;
export const ACCEPT_LINK_TOKEN = '{{ACCEPT_LINK}}';

export type ReviewerRole = 'viewer' | 'editor';
export interface Reviewer {
  email: string;
  role: ReviewerRole;
}

const EMAIL = /^[^\s@,:]+@[^\s@,:]+\.[^\s@,:]+$/;

/** `a@x.org:editor,b@y.org` → reviewers, lower-cased, de-duplicated, sorted. Throws on a bad entry. */
export function parseReviewers(spec: string | undefined | null): Reviewer[] {
  if (!spec || !spec.trim()) return [];
  const byEmail = new Map<string, Reviewer>();
  for (const raw of spec.split(',')) {
    const part = raw.trim();
    if (!part) continue;
    const [emailRaw, roleRaw] = part.split(':');
    const email = emailRaw.trim().toLowerCase();
    const role = (roleRaw ?? 'viewer').trim().toLowerCase();
    if (!EMAIL.test(email)) throw new Error(`not an email address: "${emailRaw}"`);
    if (role !== 'viewer' && role !== 'editor') throw new Error(`role for ${email} must be viewer or editor, not "${roleRaw}"`);
    const prev = byEmail.get(email);
    if (prev && prev.role !== role) throw new Error(`${email} is listed twice with different roles`);
    byEmail.set(email, { email, role });
  }
  return [...byEmail.values()].sort((a, b) => a.email.localeCompare(b.email));
}

export function reviewersKey(rs: readonly Reviewer[]): string {
  return [...rs].map((r) => `${r.email.toLowerCase()}:${r.role}`).sort().join(',');
}

/** Dimagi staff are not outside reviewers: the shared-tenant rule does not apply to them. */
export function isDimagiStaff(email: string): boolean {
  return /@dimagi\.com$/i.test(email);
}

export interface Tenancy {
  hq_domain?: string | null;
  connect_pm_org?: string | null;
  connect_holding_org?: string | null;
  labs_allowed_domains?: string[] | null;
  ocs_team?: string | null;
}

/** A Drive document the review page links to, with its sharing as the service account reads it. */
export interface DriveDocAccess {
  file_id: string;
  url: string;
  label?: string;
  title?: string;
  /** The role of a `type: anyone` permission, or null when there is none. */
  anyone_role: 'reader' | 'commenter' | 'writer' | null;
  /** Set when the permissions could not be read — never treated as open. */
  error?: string;
}

export interface ReleaseOptions {
  forward_source: boolean;
  allow_cross_workspace_forward: boolean;
  allow_shared_connect: boolean;
}

export interface ReleaseAction {
  step: number;
  id: string;
  system: 'hq' | 'connect' | 'drive' | 'ace-web' | 'email';
  kind: 'hq_invite' | 'connect_org_member' | 'drive_share' | 'forward_source' | 'ace_web_invite' | 'email';
  email?: string;
  target: string;
  role?: string;
  shared?: boolean;
  title?: string;
  url?: string;
  scope?: 'anyone_with_link';
  cross_workspace?: boolean;
  subject?: string;
}

export interface NotGranted {
  email: string;
  system: 'hq' | 'connect' | 'labs' | 'ocs';
  reason: string;
}

export interface PlannedEmail {
  to: string;
  subject: string;
  body: string;
}

export interface ReleasePlan {
  schema_version: typeof RELEASE_PLAN_SCHEMA_VERSION;
  workspace: string;
  opp: string;
  run_id: string;
  options: ReleaseOptions;
  reviewers: Reviewer[];
  actions: ReleaseAction[];
  not_granted: NotGranted[];
  emails: PlannedEmail[];
}

/** A plan-building problem — becomes a release-readiness finding. */
export interface PlanProblem {
  id: string;
  severity: 'blocker' | 'warning';
  detail: string;
  fix: string;
  summary: string;
  action: string;
}

// ---------------------------------------------------------------------------
// Hashes
// ---------------------------------------------------------------------------

/** JSON with object keys sorted at every depth — the hashing form. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

const sha = (s: string) => `sha256:${createHash('sha256').update(s).digest('hex')}`;

export function planHash(plan: ReleasePlan): string {
  return sha(canonicalJson(plan));
}

/**
 * The run's state as content, not bytes: parsed and canonicalised, so a CRLF
 * or a re-serialisation by Drive does not read as a change while any changed
 * value does.
 */
export function runStateHash(runStateText: string): string {
  return sha(canonicalJson(parseYaml(runStateText.replace(/\r\n/g, '\n')) ?? null));
}

// ---------------------------------------------------------------------------
// Grantability — which systems may an outside reviewer be let into?
// ---------------------------------------------------------------------------

interface CloneBlock {
  from?: { workspace?: string; opp?: string; run?: string };
  hq?: { status?: string };
  connect?: { status?: string };
  labs?: { status?: string };
}

function cloneBlock(runState: unknown): CloneBlock {
  const c = (runState as { clone?: unknown } | null)?.clone;
  return c && typeof c === 'object' ? (c as CloneBlock) : {};
}

export interface Grants {
  hq: boolean;
  connect: 'own' | 'shared' | false;
  labs: boolean;
}

/**
 * HQ / Connect / labs are grantable to an outside reviewer only when the clone
 * rebuilt the run's asset there into the run's OWN area (`clone.<sys>.status
 * == done`); a grant on a shared tenant opens every ACE run. Connect has one
 * escape hatch, `--allow-shared connect`, recorded as shared. Dimagi staff are
 * not outside reviewers. OCS is never an account — always the public link.
 */
export function grantsFor(email: string, runState: unknown, allowSharedConnect: boolean): Grants {
  const c = cloneBlock(runState);
  const staff = isDimagiStaff(email);
  const done = (s?: { status?: string }) => s?.status === 'done';
  return {
    hq: staff || done(c.hq),
    connect: staff || done(c.connect) ? 'own' : allowSharedConnect ? 'shared' : false,
    labs: staff || done(c.labs),
  };
}

/**
 * The memberships each reviewer WILL hold once the plan has run — what the
 * per-reviewer run-surface-audit is asked to judge. A reviewer not yet invited
 * but planned for is a member for this purpose; one the plan will not grant is
 * not, whatever they hold today unless `current` (a read-back) says so.
 */
export function projectedMemberships(
  reviewers: readonly Reviewer[],
  runState: unknown,
  allowSharedConnect: boolean,
  current: Memberships = {},
): Memberships {
  const out: Memberships = { hq: {}, connect: {}, ocs: {} };
  for (const r of reviewers) {
    const g = grantsFor(r.email, runState, allowSharedConnect);
    out.hq![r.email] = g.hq || !!current.hq?.[r.email];
    out.connect![r.email] = !!g.connect || !!current.connect?.[r.email];
    out.ocs![r.email] = !!current.ocs?.[r.email];
  }
  return out;
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export interface PlanInput {
  workspace: string;
  opp: string;
  runId: string;
  reviewers: readonly Reviewer[];
  runState: unknown;
  tenancy: Tenancy | null;
  driveDocs: readonly DriveDocAccess[] | null;
  options: ReleaseOptions;
  /** ACE_WEB_BASE_URL — for the summary URL when run_state has none. */
  aceWebBase: string;
}

function problem(id: string, severity: 'blocker' | 'warning', detail: string, fix: string, summary: string, action: string): PlanProblem {
  return { id, severity, detail, fix, summary, action };
}

export function summaryUrl(input: Pick<PlanInput, 'workspace' | 'opp' | 'runId' | 'runState' | 'aceWebBase'>): string {
  const own = (input.runState as { ace_web_summary_url?: unknown } | null)?.ace_web_summary_url;
  if (typeof own === 'string' && own.includes(`/opps/${input.workspace}/${input.opp}/runs/${input.runId}/`)) return own;
  return `${input.aceWebBase.replace(/\/+$/, '')}/opps/${input.workspace}/${input.opp}/runs/${input.runId}/summary`;
}

function chatUrl(runState: unknown): string | null {
  const u = (runState as { phases?: Record<string, { products?: { ocs_chatbot?: { public_url?: unknown } } }> } | null)?.phases?.['ocs-setup']?.products
    ?.ocs_chatbot?.public_url;
  return typeof u === 'string' && u ? u : null;
}

/**
 * Build the release plan. Returns the plan (always, so a NOT READY verdict can
 * still be explained) and the problems that stop it being executable. A plan
 * with any blocker problem is never written as the release plan.
 */
export function buildReleasePlan(input: PlanInput): { plan: ReleasePlan; problems: PlanProblem[] } {
  const problems: PlanProblem[] = [];
  const { workspace, opp, runId, reviewers, runState, options } = input;
  const tenancy = input.tenancy ?? {};
  const actions: Omit<ReleaseAction, 'step'>[] = [];
  const notGranted: NotGranted[] = [];

  if (!reviewers.length) {
    problems.push(problem('reviewers-missing', 'blocker',
      'no reviewers were named, so there is nobody to plan access for and nothing checked that the people the run is for can open it',
      'pass --reviewers <email[:role]>,… or --from-thread <id>',
      'Nobody has been named to review this run.',
      'Name the reviewers, then validate release readiness again.'));
  }
  if (!input.tenancy) {
    problems.push(problem('plan-tenancy-unread', 'blocker',
      "the opp's tenancy (HQ space, Connect orgs) was not read, so no grant can be planned",
      'pass --tenancy (bin/ace-bind --show), or let the script read it from ace-web',
      "Where this run's apps and Connect workspace live could not be read.",
      'Re-run the validation once ace-web answers.'));
  }

  // 1. HQ, 2. Connect — per reviewer, grantable systems only.
  const hqDomain = tenancy.hq_domain ?? null;
  const holding = tenancy.connect_holding_org ?? null;
  const pm = tenancy.connect_pm_org ?? null;
  const granted = new Map<string, Grants>();
  for (const r of reviewers) {
    const g = grantsFor(r.email, runState, options.allow_shared_connect);
    granted.set(r.email, g);
    if (g.hq) {
      if (hqDomain) actions.push({ id: `hq:${r.email}`, system: 'hq', kind: 'hq_invite', email: r.email, target: hqDomain, role: 'App Editor' });
    } else notGranted.push({ email: r.email, system: 'hq', reason: "shared tenant — the HQ space holds other runs' apps" });
    if (g.connect) {
      if (holding) actions.push({ id: `connect:${r.email}:${holding}`, system: 'connect', kind: 'connect_org_member', email: r.email, target: holding, role: 'viewer', shared: g.connect === 'shared' });
      if (g.connect === 'shared' && pm && pm !== holding) {
        actions.push({ id: `connect:${r.email}:${pm}`, system: 'connect', kind: 'connect_org_member', email: r.email, target: pm, role: 'viewer', shared: true });
      }
    } else notGranted.push({ email: r.email, system: 'connect', reason: 'shared tenant — the Connect orgs hold every ACE opportunity' });
    if (!g.labs) notGranted.push({ email: r.email, system: 'labs', reason: 'shared tenant — the labs scope was not rebuilt for this run' });
    notGranted.push({ email: r.email, system: 'ocs', reason: 'no account — the support chatbot is reviewed through its public chat link' });
  }
  if (input.tenancy && reviewers.some((r) => granted.get(r.email)?.hq) && !hqDomain) {
    problems.push(problem('plan-tenancy-missing:hq_domain', 'blocker', 'the tenancy records no hq_domain, so the HQ invite has no project space', 'record the opp tenancy in ace-web (clone-to-new-workspace)', "This run's HQ project space is not recorded.", 'Record the project space for this opportunity, then validate again.'));
  }
  if (input.tenancy && reviewers.some((r) => granted.get(r.email)?.connect) && !holding) {
    problems.push(problem('plan-tenancy-missing:connect_holding_org', 'blocker', 'the tenancy records no connect_holding_org, so the Connect invite has no workspace', 'record the opp tenancy in ace-web (clone-to-new-workspace)', "This run's Connect workspace is not recorded.", 'Record the Connect workspace for this opportunity, then validate again.'));
  }

  // 3. Drive — every document the review page links to must open for the reviewer.
  if (input.driveDocs === null) {
    problems.push(problem('drive-access-unchecked', 'blocker', "the sharing of the Drive documents on the review page was not read", 'scripts/release-readiness.ts drive-access --surface surface.json', 'Nobody checked that the documents on the review page will open for the reviewers.', 'Run the Drive sharing check, then validate again.'));
  } else {
    for (const d of input.driveDocs) {
      if (d.error) {
        problems.push(problem(`drive-access-unread:${d.file_id}`, 'blocker', `could not read the sharing of ${d.url}: ${d.error}`, 'make the file readable by the ACE service account, or remove the link from the review page', `The sharing of "${d.title ?? d.label ?? d.file_id}" could not be read.`, 'Fix access to that document, then validate again.'));
        continue;
      }
      if (d.anyone_role) continue; // already open to anyone with the link — verified, nothing to do
      actions.push({ id: `drive:${d.file_id}`, system: 'drive', kind: 'drive_share', target: d.file_id, title: d.title ?? d.label ?? d.file_id, url: d.url, role: 'commenter', scope: 'anyone_with_link' });
    }
  }

  // 4. Forward the source link — explicit, and never another workspace's page by default.
  if (options.forward_source) {
    const from = cloneBlock(runState).from;
    if (!from?.workspace || !from.opp || !from.run) {
      problems.push(problem('forward-source-not-a-clone', 'blocker', 'run_state has no clone.from, so there is no source link to forward', 'drop --forward-source (only a finished clone has a source)', 'There is no earlier link to forward: this run is not a copy of another run.', 'Release without forwarding.'));
    } else {
      const cross = from.workspace !== workspace;
      if (cross && !options.allow_cross_workspace_forward) {
        problems.push(problem('forward-source-cross-workspace', 'blocker',
          `--forward-source would redirect the public summary of ${from.workspace}/${from.opp}/${from.run} — a run in ANOTHER workspace (${from.workspace}) — to this run. Everyone who opens that page, ${from.workspace}'s own people included, would land here instead`,
          `refused. Drop --forward-source, or pass --allow-cross-workspace-forward if redirecting ${from.workspace}'s page is really intended`,
          `Forwarding would take over ${from.workspace}'s own public page for this run: everyone who opens it, ${from.workspace}'s people included, would be sent here.`,
          `Release without forwarding, or confirm it on purpose with --allow-cross-workspace-forward.`));
      } else {
        actions.push({ id: 'forward-source', system: 'ace-web', kind: 'forward_source', target: `${from.workspace}/${from.opp}/${from.run}`, cross_workspace: cross });
      }
    }
  } else if (options.allow_cross_workspace_forward) {
    problems.push(problem('forward-override-without-forward', 'blocker', '--allow-cross-workspace-forward was passed without --forward-source', 'pass both, or neither', 'An override was given for a forward that was not asked for.', 'Pass both flags, or neither.'));
  }

  // 5. ace-web, last of the grants.
  for (const r of reviewers) {
    actions.push({ id: `ace-web:${r.email}`, system: 'ace-web', kind: 'ace_web_invite', email: r.email, target: workspace, role: r.role });
  }

  // 6. One email per reviewer.
  const summary = summaryUrl(input);
  const chat = chatUrl(runState);
  if (!chat && reviewers.length) {
    problems.push(problem('plan-no-chat-link', 'warning', 'run_state records no ocs_chatbot.public_url, so the email cannot link the support chatbot', 'record products.ocs_chatbot.public_url (ocs-agent-setup)', 'The invitation email will not include the support chatbot.', 'Record the chatbot\'s public link if reviewers should try it.'));
  }
  const emails: PlannedEmail[] = [];
  for (const r of reviewers) {
    const mine = actions.filter((a) => a.email === r.email);
    const e = reviewerEmail({ opp, runId, workspace, reviewer: r, summary, chat, actions: mine, notGranted: notGranted.filter((n) => n.email === r.email) });
    emails.push(e);
    actions.push({ id: `email:${r.email}`, system: 'email', kind: 'email', email: r.email, target: r.email, subject: e.subject });
  }

  // The order IS the contract: HQ, Connect, Drive, forward, ace-web, emails.
  const ORDER: ReleaseAction['kind'][] = ['hq_invite', 'connect_org_member', 'drive_share', 'forward_source', 'ace_web_invite', 'email'];
  const ordered = actions
    .map((a, i) => ({ a, i }))
    .sort((x, y) => ORDER.indexOf(x.a.kind) - ORDER.indexOf(y.a.kind) || x.i - y.i)
    .map(({ a }, i) => ({ step: i + 1, ...a }) as ReleaseAction);

  return {
    plan: {
      schema_version: RELEASE_PLAN_SCHEMA_VERSION,
      workspace,
      opp,
      run_id: runId,
      options: { ...options },
      reviewers: [...reviewers],
      actions: ordered,
      not_granted: notGranted,
      emails,
    },
    problems,
  };
}

function reviewerEmail(x: {
  opp: string;
  runId: string;
  workspace: string;
  reviewer: Reviewer;
  summary: string;
  chat: string | null;
  actions: ReadonlyArray<Omit<ReleaseAction, 'step'>>;
  notGranted: readonly NotGranted[];
}): PlannedEmail {
  const hq = x.actions.find((a) => a.kind === 'hq_invite');
  const connect = x.actions.filter((a) => a.kind === 'connect_org_member');
  const lines: string[] = [];
  lines.push('Hello,');
  lines.push('');
  lines.push(`You have been given access to review ${x.opp} (run ${x.runId}).`);
  lines.push('');
  lines.push(`1. Accept your invitation to the review workspace: ${ACCEPT_LINK_TOKEN}`);
  lines.push('   Sign in with the address this email was sent to.');
  lines.push(`2. The run's review page: ${x.summary}`);
  if (x.chat) lines.push(`3. Try the support chatbot (no account needed): ${x.chat}`);
  lines.push('');
  lines.push('What you can open:');
  lines.push('- the review page and every document it links to');
  if (hq) lines.push(`- the apps in the CommCare HQ project space ${hq.target} (CommCare HQ sends its own invitation)`);
  for (const c of connect) lines.push(`- the Connect workspace ${c.target}, as a viewer (Connect sends its own invitation)`);
  if (connect.length) {
    lines.push('');
    lines.push('Important for Connect: sign in to Connect with "Log in with CommCare HQ" BEFORE you accept the Connect invitation. Accepting first creates a password account that stops the CommCare HQ sign-in from working.');
  }
  const cannot = x.notGranted.filter((n) => n.system !== 'ocs');
  if (cannot.length) {
    lines.push('');
    lines.push('What you cannot open, and why:');
    for (const n of cannot) lines.push(`- ${n.system === 'hq' ? 'the CommCare HQ project space' : n.system === 'connect' ? 'the Connect workspace' : 'the labs dashboards'}: it is shared with other programmes, so it is not opened to outside reviewers`);
  }
  lines.push('');
  lines.push('Thank you,');
  lines.push('ACE, for Dimagi');
  return { to: x.reviewer.email, subject: `Review access: ${x.opp} (run ${x.runId})`, body: lines.join('\n') + '\n' };
}

/**
 * The body `/ace:release` sends — the planned body with the accept link
 * filled in, and nothing else changed. Refuses a link that is not an ace-web
 * invite link, and a body with no placeholder to fill (a tampered plan).
 */
export function emailBody(plan: ReleasePlan, to: string, acceptLink: string): { subject: string; body: string } {
  const e = plan.emails.find((m) => m.to.toLowerCase() === to.toLowerCase());
  if (!e) throw new Error(`the release plan has no email to ${to}`);
  if (!/^https?:\/\/\S+\/invite\/[A-Za-z0-9_-]+\/?$/.test(acceptLink)) throw new Error(`not an ace-web invite link: ${acceptLink}`);
  if (!e.body.includes(ACCEPT_LINK_TOKEN)) throw new Error(`the planned email to ${to} has no ${ACCEPT_LINK_TOKEN} to fill`);
  return { subject: e.subject, body: e.body.split(ACCEPT_LINK_TOKEN).join(acceptLink) };
}

/** The grant table + email drafts the operator approves, as plain text. */
export function renderPlan(plan: ReleasePlan): string {
  const out: string[] = [];
  out.push(`Release plan — ${plan.workspace}/${plan.opp}/${plan.run_id}`);
  out.push('');
  out.push('| Reviewer | HQ | Connect | Labs | OCS | ace-web |');
  out.push('|---|---|---|---|---|---|');
  for (const r of plan.reviewers) {
    const a = plan.actions.filter((x) => x.email === r.email);
    const ng = (s: NotGranted['system']) => plan.not_granted.find((n) => n.email === r.email && n.system === s);
    const hq = a.find((x) => x.kind === 'hq_invite');
    const cn = a.filter((x) => x.kind === 'connect_org_member');
    const aw = a.find((x) => x.kind === 'ace_web_invite');
    out.push(
      `| ${r.email} (${r.role}) | ${hq ? `invite ${hq.target} as ${hq.role}` : `NOT GRANTED — ${ng('hq')?.reason ?? 'no grant'}`} | ${
        cn.length ? cn.map((c) => `${c.target} as ${c.role}${c.shared ? ' (SHARED — revoke later)' : ''}`).join('; ') : `NOT GRANTED — ${ng('connect')?.reason ?? 'no grant'}`
      } | ${ng('labs') ? `NOT GRANTED — ${ng('labs')!.reason}` : 'no call (domain already allowed)'} | public link (no account) | ${aw ? `invite to ${aw.target} as ${aw.role}` : '—'} |`,
    );
  }
  const drive = plan.actions.filter((x) => x.kind === 'drive_share');
  out.push('');
  out.push(drive.length ? 'Drive shares (anyone with the link, commenter):' : 'Drive shares: none — every document on the review page is already open.');
  for (const d of drive) out.push(`- ${d.title} — ${d.url}`);
  const fwd = plan.actions.find((x) => x.kind === 'forward_source');
  out.push('');
  out.push(fwd ? `Forward: ${fwd.target}'s public summary will redirect here${fwd.cross_workspace ? ' — ANOTHER WORKSPACE\'S PAGE (override given)' : ''}.` : 'Forward: no.');
  out.push('');
  out.push('Steps, in order:');
  for (const s of plan.actions) out.push(`${s.step}. ${s.kind} ${s.email ? `${s.email} → ` : ''}${s.target}${s.role ? ` (${s.role})` : ''}`);
  for (const e of plan.emails) {
    out.push('');
    out.push(`--- Email to ${e.to} — Subject: ${e.subject}`);
    out.push(e.body.trimEnd());
  }
  out.push('');
  out.push('Releasing executes only these steps. Nothing else in the run changes.');
  return out.join('\n') + '\n';
}
