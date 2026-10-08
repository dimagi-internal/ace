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
// A reviewer who is ALREADY a member of the ace-web workspace gets no invite
// and no accept link (ace#2770): ace-web refuses to invite an existing member
// (409, `apps/workspaces/api.py:472-477` on ace-web main), so no token would
// ever exist. Validation reads the membership (`AceWebMembership`) and plans
// that reviewer's email in its existing-member variant — "sign in at the run's
// members page" — and `memberEmailBody` is the release's no-link path, also
// used when an invite answers 409 at release time.
//
// Pure.

import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import type { Memberships } from './run-surface-audit.js';

export const RELEASE_PLAN_SCHEMA_VERSION = 1 as const;
export const ACCEPT_LINK_TOKEN = '{{ACCEPT_LINK}}';

export type ReviewerRole = 'viewer' | 'editor';

/**
 * The ace-web workspace role every release invite carries — always `editor`,
 * whatever `:role` the reviewer was passed with. Owner directive (Jonathan
 * Jackson, 2026-10-08): "everyone ace invites in as part of a release should be
 * editor". The reviewer's `:viewer` / `:editor` no longer reaches ace-web; Connect
 * keeps its own fixed `viewer` org role (right for outside reviewers), and HQ its
 * `App Editor`.
 */
export const RELEASE_ACE_WEB_ROLE = 'editor' as const;

/** ace-web's four workspace roles, lowest first (`apps/workspaces/models.py:70` `ROLE_RANK` on ace-web main). */
export const ACE_WEB_ROLES = ['viewer', 'editor', 'admin', 'owner'] as const;
export type AceWebRole = (typeof ACE_WEB_ROLES)[number];

/** -1 for anything that is not an ace-web role (never "enough"). */
export function aceWebRoleRank(role: string | null | undefined): number {
  return ACE_WEB_ROLES.indexOf((role ?? '') as AceWebRole);
}

/** Does `role` already give at least what a release grants (`RELEASE_ACE_WEB_ROLE`)? */
export function meetsReleaseRole(role: string | null | undefined): boolean {
  return aceWebRoleRank(role) >= aceWebRoleRank(RELEASE_ACE_WEB_ROLE);
}

/**
 * The target workspace's membership as validation read it from ace-web:
 * `GET /api/workspaces/<ws>/members` (any member; `[{id, user: {id, email,
 * display_name}, role, joined_at}]`) and `GET /api/workspaces/<ws>/invites`
 * (admin and above; `[{email, role, invited_by_email, created_at,
 * expires_at}]`, pending only, never a token — ace-web #885). `error` is set
 * when either read failed — never treated as "nobody is a member".
 */
export interface AceWebMembership {
  members: Array<{ email: string; role: string; user_id: number }>;
  pending_invites: Array<{ email: string; role: string }>;
  error?: string;
}

/** ace-web's 409 for an invite to an existing member: `<email> is already a <role> of this workspace`. */
export function parseAlreadyMember(title: string | null | undefined): AceWebRole | null {
  const m = /\bis already an? (viewer|editor|admin|owner) of this workspace\b/i.exec(title ?? '');
  return m ? (m[1].toLowerCase() as AceWebRole) : null;
}

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

/** ACE's own mailbox — the sender of every release email, so never a recipient of one. */
export const ACE_MAILBOX = 'ace@dimagi-ai.com';

/**
 * `--cc a@dimagi.com,b@dimagi.com` → the Dimagi staff copied on EVERY release
 * email, lower-cased, de-duplicated, sorted. They get no grant: a cc is told,
 * not let in (ace#2706). An explicit operator OPT-IN only — nothing derives it
 * from a thread: Dimagi staff on the requesting thread are reviewers, not cc
 * (operator correction, Jonathan, 2026-10-05, ace#2720: "we want dimagi people
 * to be invited into the workspace if they are on the project").
 *
 * Only Dimagi staff (`@dimagi.com`) may be copied. Anyone else on a release
 * email reads a partner's access instructions without being a reviewer of the
 * run — refused here, with the address named. ACE's own mailbox is the sender.
 */
export function parseCc(spec: string | undefined | null): string[] {
  if (!spec || !spec.trim()) return [];
  const out = new Set<string>();
  for (const raw of spec.split(',')) {
    const email = raw.trim().toLowerCase();
    if (!email) continue;
    if (!EMAIL.test(email)) throw new Error(`--cc: not an email address: "${raw.trim()}"`);
    if (email === ACE_MAILBOX) throw new Error(`--cc: ${email} is ACE's own mailbox — it sends the release emails, it is not copied on them`);
    if (!isDimagiStaff(email)) throw new Error(`--cc: ${email} is not Dimagi staff (@dimagi.com) — only Dimagi staff may be copied on a release email; a partner reads it as a reviewer (--reviewers) or not at all`);
    out.add(email);
  }
  return [...out].sort();
}

export function ccKey(cc: readonly string[] | undefined | null): string {
  return [...new Set((cc ?? []).map((e) => e.toLowerCase()))].sort().join(',');
}

/**
 * `--from-thread`: split the requesting thread's participants (every From /
 * To / Cc address) into reviewers and excluded.
 *
 * Operator correction (Jonathan, 2026-10-05, ace#2720): "we want dimagi people
 * to be invited into the workspace if they are on the project". So:
 *
 * - Dimagi staff (`@dimagi.com`) → `reviewers`: an ace-web workspace
 *   invite (as `editor`, RELEASE_ACE_WEB_ROLE), the same grants a partner gets (`grantsFor` already treats staff
 *   as grantable on every system), and their own release email.
 * - ACE's own mailbox, and anyone else → `excluded`, with the reason — shown to
 *   the operator, never silently invited or copied. A partner is invited only
 *   when the operator names them in `--reviewers` (ace-web dropped the per-opp
 *   `labs_allowed_domains` that used to admit a partner domain, 2026-10-08).
 *
 * Nothing here derives `--cc`: copying staff without a grant (ace#2706) is an
 * explicit operator opt-in only.
 */
export function partitionThreadParticipants(
  participants: readonly string[],
): { reviewers: string[]; excluded: Array<{ email: string; reason: string }> } {
  const reviewers = new Set<string>();
  const excluded = new Map<string, string>();
  for (const raw of participants) {
    // `Name <a@x.org>` and bare `a@x.org` both
    const email = (/<([^>]+)>/.exec(raw)?.[1] ?? raw).trim().toLowerCase();
    if (!email) continue;
    if (!EMAIL.test(email)) excluded.set(email, 'not an email address');
    else if (email === ACE_MAILBOX) excluded.set(email, "ACE's own mailbox — the sender");
    else if (isDimagiStaff(email)) reviewers.add(email);
    else excluded.set(email, 'not Dimagi staff — name them in --reviewers to invite them; never copied');
  }
  return {
    reviewers: [...reviewers].sort(),
    excluded: [...excluded].map(([email, reason]) => ({ email, reason })).sort((a, b) => a.email.localeCompare(b.email)),
  };
}

export interface Tenancy {
  hq_domain?: string | null;
  connect_pm_org?: string | null;
  connect_holding_org?: string | null;
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
  kind: 'hq_invite' | 'connect_org_member' | 'drive_share' | 'forward_source' | 'ace_web_invite' | 'ace_web_role' | 'email';
  email?: string;
  /** `ace_web_role`: the member's ace-web user id (the PATCH path) and the role validation read. */
  user_id?: number;
  from_role?: string;
  /** `ace_web_invite`: the reviewer already had a pending invite — this one mints a fresh link; the earlier one stays valid. */
  reinvite?: boolean;
  target: string;
  role?: string;
  shared?: boolean;
  title?: string;
  url?: string;
  scope?: 'anyone_with_link';
  cross_workspace?: boolean;
  subject?: string;
  /** `email` actions: the Dimagi staff copied on it (ace#2706). */
  cc?: string[];
}

export interface NotGranted {
  email: string;
  system: 'hq' | 'connect' | 'labs' | 'ocs';
  reason: string;
}

export interface PlannedEmail {
  to: string;
  /**
   * `invite` — step 1 is the ace-web accept link (`{{ACCEPT_LINK}}`, filled by
   * `emailBody`). `existing-member` — the reviewer is already a member at
   * `RELEASE_ACE_WEB_ROLE` or above (or the plan upgrades them to it), so step 1
   * is "sign in at the run's members page" and there is nothing to fill
   * (`memberEmailBody`). Absent on a pre-#2770 plan = `invite`.
   */
  variant?: 'invite' | 'existing-member';
  /** Dimagi staff copied on this email — the plan's `cc`, the same on every email. */
  cc: string[];
  subject: string;
  body: string;
}

/**
 * A readiness blocker the operator released past (`--waive <id>=<reason>`,
 * ace#2707). Recorded on the plan — so in its hash — with the failing finding's
 * `detail`, so the grade stays visible wherever the plan is shown.
 */
export interface PlanWaiver {
  id: string;
  reason: string;
  /** The operator's git email. */
  by: string;
  /** When the validation that applied it ran. */
  at: string;
  /** The waived finding's detail — the failing grade, kept visible. */
  detail: string;
}

export interface ReleasePlan {
  schema_version: typeof RELEASE_PLAN_SCHEMA_VERSION;
  workspace: string;
  opp: string;
  run_id: string;
  options: ReleaseOptions;
  reviewers: Reviewer[];
  /** Dimagi staff copied on every release email; granted nothing (ace#2706). Absent on a pre-cc plan = none. */
  cc: string[];
  actions: ReleaseAction[];
  not_granted: NotGranted[];
  emails: PlannedEmail[];
  /** Readiness blockers waived by the operator (eval quality only). Absent on a pre-waiver plan = none. */
  waivers?: PlanWaiver[];
  /**
   * The run's members-only workbench page (`…/w/<ws>/opps/<opp>/runs/<run>`) —
   * where an existing member signs in (ace#2770). Absent on a pre-#2770 plan.
   */
  workbench_url?: string;
  /**
   * The ace-web grant per reviewer, as validation read it: `invite` (a fresh
   * invite), `invite-pending` (re-invited — a fresh link; the earlier invite
   * stays valid), `already-member` (no call; `role` is the read-back),
   * `role-upgrade` (a member below editor, raised by an `ace_web_role` action).
   * Absent on a pre-#2770 plan.
   */
  ace_web?: Array<{ email: string; status: 'invite' | 'invite-pending' | 'already-member' | 'role-upgrade'; role: string }>;
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
  /** Dimagi staff to copy on every release email (`parseCc`). */
  cc?: readonly string[];
  runState: unknown;
  tenancy: Tenancy | null;
  driveDocs: readonly DriveDocAccess[] | null;
  options: ReleaseOptions;
  /** ACE_WEB_BASE_URL — for the summary URL when run_state has none, and the workbench URL. */
  aceWebBase: string;
  /**
   * The target workspace's ace-web members + pending invites, read by
   * validation (ace#2770). `null` = not read: a blocker, never "nobody is a
   * member" — inviting an existing member 409s and leaves their email unsendable.
   */
  aceWebMembership: AceWebMembership | null;
}

function problem(id: string, severity: 'blocker' | 'warning', detail: string, fix: string, summary: string, action: string): PlanProblem {
  return { id, severity, detail, fix, summary, action };
}

export function summaryUrl(input: Pick<PlanInput, 'workspace' | 'opp' | 'runId' | 'runState' | 'aceWebBase'>): string {
  const own = (input.runState as { ace_web_summary_url?: unknown } | null)?.ace_web_summary_url;
  if (typeof own === 'string' && own.includes(`/opps/${input.workspace}/${input.opp}/runs/${input.runId}/`)) return own;
  return `${input.aceWebBase.replace(/\/+$/, '')}/opps/${input.workspace}/${input.opp}/runs/${input.runId}/summary`;
}

/** The run's members-only workbench page — where an existing ace-web member signs in. */
export function workbenchUrl(input: Pick<PlanInput, 'workspace' | 'opp' | 'runId' | 'aceWebBase'>): string {
  return `${input.aceWebBase.replace(/\/+$/, '')}/w/${input.workspace}/opps/${input.opp}/runs/${input.runId}`;
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
  // Copied staff: Dimagi only, never ACE itself, never someone already a reviewer.
  // parseCc refuses these at the CLI; this holds for any other caller.
  const cc = [...new Set((input.cc ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean))].sort();
  for (const e of cc) {
    if (e === ACE_MAILBOX || !isDimagiStaff(e)) {
      problems.push(problem(`reviewers-cc-not-dimagi:${e}`, 'blocker',
        `--cc ${e} is not Dimagi staff (@dimagi.com) — only Dimagi staff may be copied on a release email`,
        `drop ${e} from --cc (a partner is named in --reviewers, or not at all)`,
        `${e} would be copied on the reviewers' access emails without being a reviewer.`,
        `Remove ${e} from the copy list, or name them as a reviewer.`));
    } else if (reviewers.some((r) => r.email === e)) {
      problems.push(problem(`reviewers-cc-is-reviewer:${e}`, 'blocker',
        `${e} is in both --reviewers and --cc`,
        `name ${e} in one of them`,
        `${e} is listed both as a reviewer and as a copy.`,
        `Keep ${e} in one list only.`));
    }
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
      // The PM org too: it holds the PROGRAM (and the verification rules page), which
      // the run links to; a viewer of the holding org alone cannot open it (ace#2723).
      if (pm && pm !== holding) {
        actions.push({ id: `connect:${r.email}:${pm}`, system: 'connect', kind: 'connect_org_member', email: r.email, target: pm, role: 'viewer', shared: g.connect === 'shared' });
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

  // 5. ace-web, last of the grants — per reviewer, from the membership read (ace#2770).
  //    ace-web 409s an invite to ANY existing member (api.py:472-477) and a role
  //    change is its own PATCH (api.py:750-790, admin+ acting strictly above both
  //    roles — permissions.py:185), so:
  //    - member at editor or above → no call; the email is the existing-member variant;
  //    - member below editor (viewer) → `ace_web_role` (PATCH to editor), same email variant;
  //    - pending invite → a fresh invite (ace-web keeps no uniqueness on (workspace,
  //      email) and mints a new token per POST, api.py:479 / models.py:98-123);
  //    - otherwise → invite + accept link, unchanged.
  const membership = input.aceWebMembership;
  if (!membership || membership.error) {
    if (reviewers.length) {
      problems.push(problem('plan-ace-web-membership-unread', 'blocker',
        `the ace-web membership of workspace ${workspace} was not read${membership?.error ? `: ${membership.error}` : ''}, so nothing shows which reviewers are already members — inviting a member is refused (409) and leaves their email unsendable (ace#2770)`,
        `let assess read it (ACE_WEB_PAT_TOKEN; ACE must be admin or owner of ${workspace} to list pending invites), or pass --ace-web-membership <json>`,
        `Who is already in the ${workspace} review workspace could not be read.`,
        'Re-run the validation once ace-web answers.'));
    }
  }
  const memberOf = new Map((membership?.members ?? []).map((m) => [m.email.trim().toLowerCase(), m]));
  const pendingFor = new Set((membership?.pending_invites ?? []).map((i) => i.email.trim().toLowerCase()));
  const aceWeb: NonNullable<ReleasePlan['ace_web']> = [];
  const existingMember = new Set<string>();
  for (const r of reviewers) {
    const m = memberOf.get(r.email);
    if (m && meetsReleaseRole(m.role)) {
      aceWeb.push({ email: r.email, status: 'already-member', role: m.role });
      existingMember.add(r.email);
    } else if (m) {
      actions.push({ id: `ace-web-role:${r.email}`, system: 'ace-web', kind: 'ace_web_role', email: r.email, target: workspace, user_id: m.user_id, from_role: m.role, role: RELEASE_ACE_WEB_ROLE });
      aceWeb.push({ email: r.email, status: 'role-upgrade', role: RELEASE_ACE_WEB_ROLE });
      existingMember.add(r.email);
    } else {
      const reinvite = pendingFor.has(r.email);
      actions.push({ id: `ace-web:${r.email}`, system: 'ace-web', kind: 'ace_web_invite', email: r.email, target: workspace, role: RELEASE_ACE_WEB_ROLE, ...(reinvite ? { reinvite: true } : {}) });
      aceWeb.push({ email: r.email, status: reinvite ? 'invite-pending' : 'invite', role: RELEASE_ACE_WEB_ROLE });
    }
  }

  // 6. One email per reviewer.
  const summary = summaryUrl(input);
  const workbench = workbenchUrl(input);
  const chat = chatUrl(runState);
  if (!chat && reviewers.length) {
    problems.push(problem('plan-no-chat-link', 'warning', 'run_state records no ocs_chatbot.public_url, so the email cannot link the support chatbot', 'record products.ocs_chatbot.public_url (ocs-agent-setup)', 'The invitation email will not include the support chatbot.', 'Record the chatbot\'s public link if reviewers should try it.'));
  }
  const emails: PlannedEmail[] = [];
  for (const r of reviewers) {
    const mine = actions.filter((a) => a.email === r.email);
    const e = reviewerEmail({ opp, runId, workspace, reviewer: r, cc, summary, workbench, existingMember: existingMember.has(r.email), chat, actions: mine, notGranted: notGranted.filter((n) => n.email === r.email) });
    emails.push(e);
    actions.push({ id: `email:${r.email}`, system: 'email', kind: 'email', email: r.email, target: r.email, subject: e.subject, cc: [...cc] });
  }

  // The order IS the contract: HQ, Connect, Drive, forward, ace-web, emails.
  const ORDER: ReleaseAction['kind'][] = ['hq_invite', 'connect_org_member', 'drive_share', 'forward_source', 'ace_web_role', 'ace_web_invite', 'email'];
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
      cc,
      actions: ordered,
      not_granted: notGranted,
      emails,
      workbench_url: workbench,
      ace_web: aceWeb,
    },
    problems,
  };
}

function reviewerEmail(x: {
  opp: string;
  runId: string;
  workspace: string;
  reviewer: Reviewer;
  cc: readonly string[];
  summary: string;
  workbench: string;
  existingMember: boolean;
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
  lines.push(x.existingMember ? memberStep(x.workbench) : inviteStep());
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
  return {
    to: x.reviewer.email,
    variant: x.existingMember ? 'existing-member' : 'invite',
    cc: [...x.cc],
    subject: `Review access: ${x.opp} (run ${x.runId})`,
    body: lines.join('\n') + '\n',
  };
}

/** Step 1 of an `invite` email — the accept link, filled at release. */
function inviteStep(): string {
  return `1. Accept your invitation to the review workspace: ${ACCEPT_LINK_TOKEN}\n   Sign in with the address this email was sent to.`;
}

/** Step 1 of an `existing-member` email — no invitation, they already have access. */
function memberStep(workbench: string): string {
  return `1. You are already a member of the review workspace — sign in at ${workbench}\n   Sign in with the address this email was sent to.`;
}

function plannedEmail(plan: ReleasePlan, to: string): PlannedEmail {
  const e = plan.emails.find((m) => m.to.toLowerCase() === to.toLowerCase());
  if (!e) throw new Error(`the release plan has no email to ${to}`);
  return e;
}

/**
 * The body `/ace:release` sends to a reviewer it INVITED — the planned body
 * with the accept link filled in, and nothing else changed. Refuses a link that
 * is not an ace-web invite link, and a body with no placeholder to fill (an
 * existing-member email, or a tampered plan).
 */
export function emailBody(plan: ReleasePlan, to: string, acceptLink: string): { subject: string; body: string; cc: string[] } {
  const e = plannedEmail(plan, to);
  if (!/^https?:\/\/\S+\/invite\/[A-Za-z0-9_-]+\/?$/.test(acceptLink)) throw new Error(`not an ace-web invite link: ${acceptLink}`);
  if (e.variant === 'existing-member') throw new Error(`the planned email to ${to} is the existing-member variant — it takes no accept link (email-body --already-member)`);
  if (!e.body.includes(ACCEPT_LINK_TOKEN)) throw new Error(`the planned email to ${to} has no ${ACCEPT_LINK_TOKEN} to fill`);
  return { subject: e.subject, body: e.body.split(ACCEPT_LINK_TOKEN).join(acceptLink), cc: [...(e.cc ?? [])] };
}

/**
 * The body `/ace:release` sends to a reviewer who is ALREADY an ace-web member
 * (ace#2770) — no accept link. `memberRole` is the role ace-web reported: the
 * read-back for a planned `existing-member` email, or the role named in the
 * invite's 409 (`parseAlreadyMember`) when a reviewer planned for an invite
 * turned out to be a member at release. Refuses a role below editor (that
 * member does not hold what the release grants — re-validate, which plans an
 * `ace_web_role` upgrade). For an `invite` email it swaps the accept-link step
 * for the sign-in step and changes nothing else; it never fills a link.
 */
export function memberEmailBody(plan: ReleasePlan, to: string, memberRole: string): { subject: string; body: string; cc: string[] } {
  const e = plannedEmail(plan, to);
  if (!meetsReleaseRole(memberRole)) {
    throw new Error(`${to} is a ${memberRole || '(unknown role)'} of the workspace, below the release's ${RELEASE_ACE_WEB_ROLE} — not a satisfied grant; re-validate (the plan then upgrades the role)`);
  }
  if (e.variant === 'existing-member') {
    if (e.body.includes(ACCEPT_LINK_TOKEN)) throw new Error(`the planned existing-member email to ${to} carries ${ACCEPT_LINK_TOKEN} (a tampered plan)`);
    return { subject: e.subject, body: e.body, cc: [...(e.cc ?? [])] };
  }
  if (!plan.workbench_url) throw new Error(`the plan records no workbench_url — re-validate before sending ${to} the existing-member email`);
  const step = inviteStep();
  if (e.body.split(step).length !== 2) throw new Error(`the planned email to ${to} does not carry exactly one accept-link step (a tampered plan)`);
  return { subject: e.subject, body: e.body.replace(step, memberStep(plan.workbench_url)), cc: [...(e.cc ?? [])] };
}

/** The grant table + email drafts the operator approves, as plain text. */
export function renderPlan(plan: ReleasePlan): string {
  const out: string[] = [];
  out.push(`Release plan — ${plan.workspace}/${plan.opp}/${plan.run_id}`);
  out.push('');
  out.push(plan.cc?.length ? `Copied on every email (Dimagi staff, no access granted): ${plan.cc.join(', ')}` : 'Copied on the emails: nobody.');
  out.push('');
  out.push('| Reviewer | HQ | Connect | Labs | OCS | ace-web |');
  out.push('|---|---|---|---|---|---|');
  for (const r of plan.reviewers) {
    const a = plan.actions.filter((x) => x.email === r.email);
    const ng = (s: NotGranted['system']) => plan.not_granted.find((n) => n.email === r.email && n.system === s);
    const hq = a.find((x) => x.kind === 'hq_invite');
    const cn = a.filter((x) => x.kind === 'connect_org_member');
    const aw = a.find((x) => x.kind === 'ace_web_invite');
    const up = a.find((x) => x.kind === 'ace_web_role');
    const st = plan.ace_web?.find((x) => x.email === r.email);
    const aceWebCell = st?.status === 'already-member'
      ? `already a member (${st.role}) — no invite`
      : up
        ? `already a member (${up.from_role}) — raise to ${up.role}, no invite`
        : aw
          ? `invite to ${aw.target} as ${aw.role}${aw.reinvite ? ' (re-invite: an earlier invite is still pending; it stays valid)' : ''}`
          : '—';
    out.push(
      `| ${r.email} (${r.role}) | ${hq ? `invite ${hq.target} as ${hq.role}` : `NOT GRANTED — ${ng('hq')?.reason ?? 'no grant'}`} | ${
        cn.length ? cn.map((c) => `${c.target} as ${c.role}${c.shared ? ' (SHARED — revoke later)' : ''}`).join('; ') : `NOT GRANTED — ${ng('connect')?.reason ?? 'no grant'}`
      } | ${ng('labs') ? `NOT GRANTED — ${ng('labs')!.reason}` : 'no call (domain already allowed)'} | public link (no account) | ${aceWebCell} |`,
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
  if (plan.waivers?.length) {
    out.push('WAIVED readiness blockers — still failing, released anyway on the operator\'s say-so:');
    for (const w of plan.waivers) out.push(`- ${w.id}: ${w.detail}\n  waived by ${w.by} at ${w.at} — "${w.reason}"`);
  } else {
    out.push('Waived readiness blockers: none.');
  }
  out.push('');
  out.push('Steps, in order:');
  for (const s of plan.actions) out.push(`${s.step}. ${s.kind} ${s.email ? `${s.email} → ` : ''}${s.target}${s.from_role ? ` (${s.from_role} → ${s.role})` : s.role ? ` (${s.role})` : ''}${s.cc?.length ? ` cc ${s.cc.join(', ')}` : ''}`);
  for (const e of plan.emails) {
    out.push('');
    out.push(`--- Email to ${e.to}${e.cc?.length ? ` — Cc: ${e.cc.join(', ')}` : ''} — Subject: ${e.subject}${e.variant === 'existing-member' ? ' — already a member: no accept link' : ''}`);
    out.push(e.body.trimEnd());
  }
  if (plan.workbench_url && plan.emails.some((e) => e.variant !== 'existing-member')) {
    out.push('');
    out.push(`If ace-web answers an invite with "already a <editor|admin|owner>", that reviewer's grant is satisfied and step 1 of their email becomes: "You are already a member of the review workspace — sign in at ${plan.workbench_url}". Nothing else in it changes.`);
  }
  out.push('');
  out.push('Releasing executes only these steps. Nothing else in the run changes.');
  return out.join('\n') + '\n';
}
