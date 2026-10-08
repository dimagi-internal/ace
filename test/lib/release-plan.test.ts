/**
 * lib/release-plan.ts — the exact share actions /ace:release executes.
 */
import { describe, expect, it } from 'vitest';
import { assessSurfaceAudit } from '../../lib/release-readiness';
import { collapseSharedCauses } from '../../lib/release-readiness-plain';
import {
  ACCEPT_LINK_TOKEN,
  RELEASE_ACE_WEB_ROLE,
  buildReleasePlan,
  emailBody,
  grantsFor,
  memberEmailBody,
  parseAlreadyMember,
  parseCc,
  parseReviewers,
  partitionThreadParticipants,
  planHash,
  projectedMemberships,
  renderPlan,
  type PlanInput,
} from '../../lib/release-plan';

const clone = {
  ace_web_summary_url: 'https://labs.connect.dimagi.com/ace/opps/spark/spark-facilitator/runs/r1/summary',
  clone: {
    from: { workspace: 'dimagi-team', opp: 'spark-facilitator', run: 'r0' },
    hq: { status: 'done' },
    connect: { status: 'done' },
    labs: { status: 'done' },
  },
  phases: { 'ocs-setup': { products: { ocs_chatbot: { public_url: 'https://www.openchatstudio.com/a/t/chat/x/' } } } },
};
const base: PlanInput = {
  workspace: 'spark',
  opp: 'spark-facilitator',
  runId: 'r1',
  reviewers: parseReviewers('amina@spark.org,bo@spark.org:editor'),
  runState: clone,
  tenancy: { hq_domain: 'connect-ace-spark', connect_holding_org: 'spark-nm', connect_pm_org: 'spark-pm' },
  driveDocs: [
    { file_id: 'OPENOPENOPEN1', url: 'https://docs.google.com/document/d/OPENOPENOPEN1/edit', title: 'Guide', anyone_role: 'commenter' },
    { file_id: 'PRIVATEPRIV22', url: 'https://docs.google.com/document/d/PRIVATEPRIV22/edit', title: 'Work order', anyone_role: null },
  ],
  options: { forward_source: false, allow_cross_workspace_forward: false, allow_shared_connect: false },
  aceWebBase: 'https://labs.connect.dimagi.com/ace',
  aceWebMembership: { members: [{ email: 'ace@dimagi-ai.com', role: 'owner', user_id: 1 }], pending_invites: [] },
};

describe('parseReviewers', () => {
  it('normalises, defaults viewer, rejects junk', () => {
    expect(parseReviewers(' B@Spark.org:editor , a@spark.org ')).toEqual([
      { email: 'a@spark.org', role: 'viewer' },
      { email: 'b@spark.org', role: 'editor' },
    ]);
    expect(parseReviewers('')).toEqual([]);
    expect(() => parseReviewers('not-an-email')).toThrow();
    expect(() => parseReviewers('a@x.org:owner')).toThrow();
    expect(() => parseReviewers('a@x.org:viewer,a@x.org:editor')).toThrow();
  });
});

describe('ace-web release role (owner directive 2026-10-08: every release invite is editor)', () => {
  it('every ace_web_invite is editor — including reviewers passed as :viewer — and Connect stays viewer', () => {
    expect(RELEASE_ACE_WEB_ROLE).toBe('editor');
    const reviewers = parseReviewers('amina@spark.org:viewer,bo@spark.org:editor,cy@spark.org,neal@dimagi.com:viewer');
    const { plan } = buildReleasePlan({ ...base, reviewers });
    const invites = plan.actions.filter((a) => a.kind === 'ace_web_invite');
    expect(invites.map((a) => a.email).sort()).toEqual(reviewers.map((r) => r.email).sort());
    for (const a of invites) expect(a).toMatchObject({ system: 'ace-web', target: base.workspace, role: 'editor' });
    const connect = plan.actions.filter((a) => a.kind === 'connect_org_member');
    expect(connect.length).toBeGreaterThan(0);
    for (const a of connect) expect(a.role).toBe('viewer');
    for (const a of plan.actions.filter((x) => x.kind === 'hq_invite')) expect(a.role).toBe('App Editor');
    const txt = renderPlan(plan);
    expect(txt).toContain(`invite to ${base.workspace} as editor`);
    expect(txt).not.toContain(`invite to ${base.workspace} as viewer`);
  });

  it('the plan hash stays deterministic', () => {
    const a = buildReleasePlan(base).plan;
    const b = buildReleasePlan(base).plan;
    expect(planHash(a)).toBe(planHash(b));
  });
});

describe('buildReleasePlan', () => {
  it('orders HQ, Connect, Drive, ace-web, emails — and nothing else', () => {
    const { plan, problems } = buildReleasePlan(base);
    expect(problems.filter((p) => p.severity === 'blocker')).toEqual([]);
    expect(plan.actions.map((a) => a.kind)).toEqual([
      'hq_invite', 'hq_invite', 'connect_org_member', 'connect_org_member', 'connect_org_member', 'connect_org_member', 'drive_share', 'ace_web_invite', 'ace_web_invite', 'email', 'email',
    ]);
    expect(plan.actions.map((a) => a.step)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    // only the private doc is shared; the open one is verified, not touched
    expect(plan.actions.filter((a) => a.kind === 'drive_share').map((a) => a.target)).toEqual(['PRIVATEPRIV22']);
    expect(plan.actions.find((a) => a.id === 'ace-web:bo@spark.org')?.role).toBe('editor');
    expect(plan.not_granted.filter((n) => n.system === 'ocs')).toHaveLength(2);
  });

  it('an outside reviewer is never granted a shared tenant; Dimagi staff are', () => {
    const shared = { ...clone, clone: { ...clone.clone, hq: { status: 'kept-shared' }, connect: { status: 'not-done' } } };
    const { plan } = buildReleasePlan({ ...base, runState: shared, reviewers: parseReviewers('amina@spark.org,jj@dimagi.com') });
    expect(plan.actions.filter((a) => a.kind === 'hq_invite').map((a) => a.email)).toEqual(['jj@dimagi.com']);
    expect(plan.not_granted.find((n) => n.email === 'amina@spark.org' && n.system === 'hq')?.reason).toMatch(/shared tenant/);
    expect(grantsFor('amina@spark.org', shared, true).connect).toBe('shared');
  });

  it('--allow-shared connect grants both shared orgs, marked shared', () => {
    const shared = { ...clone, clone: { ...clone.clone, connect: { status: 'kept-shared' } } };
    const { plan } = buildReleasePlan({ ...base, runState: shared, reviewers: parseReviewers('amina@spark.org'), options: { ...base.options, allow_shared_connect: true } });
    const c = plan.actions.filter((a) => a.kind === 'connect_org_member');
    expect(c.map((a) => [a.target, a.shared])).toEqual([['spark-nm', true], ['spark-pm', true]]);
  });

  it('a dedicated clone grants BOTH its Connect orgs: the holding org (opportunity) and the PM org (program)', () => {
    // The run links the program at /a/<pm_org>/program/<id>/ and the verification rules
    // live on the PM org's page; a holding-org viewer alone cannot open either (Jonathan
    // Jackson, 2026-10-06: "they should be invited to the spark pm org too right?").
    const { plan } = buildReleasePlan({ ...base, reviewers: parseReviewers('amina@spark.org') });
    const c = plan.actions.filter((a) => a.kind === 'connect_org_member');
    expect(c.map((a) => [a.target, a.shared, a.role])).toEqual([['spark-nm', false, 'viewer'], ['spark-pm', false, 'viewer']]);
  });

  it('a self-managed opp (PM org holds its own opportunity) is granted that one org once', () => {
    const { plan } = buildReleasePlan({ ...base, reviewers: parseReviewers('amina@spark.org'), tenancy: { ...base.tenancy!, connect_pm_org: 'spark-nm' } });
    expect(plan.actions.filter((a) => a.kind === 'connect_org_member').map((a) => a.target)).toEqual(['spark-nm']);
  });

  it('no reviewers is a blocker', () => {
    expect(buildReleasePlan({ ...base, reviewers: [] }).problems.map((p) => p.id)).toContain('reviewers-missing');
  });

  it('unread Drive sharing blocks; an unchecked list blocks', () => {
    const { problems } = buildReleasePlan({ ...base, driveDocs: [{ file_id: 'X', url: 'u', anyone_role: null, error: '404' }] });
    expect(problems.map((p) => p.id)).toContain('drive-access-unread:X');
    expect(buildReleasePlan({ ...base, driveDocs: null }).problems.map((p) => p.id)).toContain('drive-access-unchecked');
  });

  it('--forward-source of ANOTHER workspace is refused without the override, and says so plainly', () => {
    const fwd = { ...base, options: { ...base.options, forward_source: true } };
    const refused = buildReleasePlan(fwd);
    const p = refused.problems.find((x) => x.id === 'forward-source-cross-workspace')!;
    expect(p.severity).toBe('blocker');
    expect(p.summary).toMatch(/dimagi-team's own public page/);
    expect(refused.plan.actions.some((a) => a.kind === 'forward_source')).toBe(false);

    const allowed = buildReleasePlan({ ...base, options: { ...base.options, forward_source: true, allow_cross_workspace_forward: true } });
    expect(allowed.problems.filter((x) => x.severity === 'blocker')).toEqual([]);
    const a = allowed.plan.actions.find((x) => x.kind === 'forward_source')!;
    expect(a).toMatchObject({ target: 'dimagi-team/spark-facilitator/r0', cross_workspace: true });
    // forward comes after the Drive shares and before the ace-web invites
    const kinds = allowed.plan.actions.map((x) => x.kind);
    expect(kinds.indexOf('forward_source')).toBeGreaterThan(kinds.lastIndexOf('drive_share'));
    expect(kinds.indexOf('forward_source')).toBeLessThan(kinds.indexOf('ace_web_invite'));

    const notClone = buildReleasePlan({ ...fwd, runState: { ...clone, clone: {} } });
    expect(notClone.problems.map((x) => x.id)).toContain('forward-source-not-a-clone');
  });

  it('every email is planned in full; only the accept link is filled at release', () => {
    const { plan } = buildReleasePlan(base);
    const e = plan.emails.find((m) => m.to === 'amina@spark.org')!;
    expect(e.body).toContain(ACCEPT_LINK_TOKEN);
    expect(e.body).toContain(clone.ace_web_summary_url);
    expect(e.body).toContain('Log in with CommCare HQ');
    expect(e.body).not.toMatch(/CommCare Connect/);
    const filled = emailBody(plan, 'amina@spark.org', 'https://labs.connect.dimagi.com/ace/invite/abc123');
    expect(filled.body).toBe(e.body.replace(ACCEPT_LINK_TOKEN, 'https://labs.connect.dimagi.com/ace/invite/abc123'));
    expect(() => emailBody(plan, 'amina@spark.org', 'https://evil.example/x')).toThrow();
    expect(() => emailBody(plan, 'nobody@x.org', 'https://labs.connect.dimagi.com/ace/invite/abc')).toThrow();
  });

  it('the hash is stable and changes with any action', () => {
    const a = buildReleasePlan(base).plan;
    const b = buildReleasePlan(base).plan;
    expect(planHash(a)).toBe(planHash(b));
    b.actions[0].role = 'Admin';
    expect(planHash(a)).not.toBe(planHash(b));
  });

  it('renders a grant table and every email for approval', () => {
    const txt = renderPlan(buildReleasePlan(base).plan);
    expect(txt).toContain('| Reviewer | HQ | Connect | Labs | OCS | ace-web |');
    expect(txt).toContain('amina@spark.org (viewer)');
    expect(txt).toContain('Work order');
    expect(txt).toContain('--- Email to bo@spark.org');
    expect(txt).toContain('Nothing else in the run changes.');
  });
});

describe('the audit sees what the plan will do', () => {
  it('projected memberships: a planned grant counts, an ungranted shared tenant does not', () => {
    const shared = { ...clone, clone: { ...clone.clone, hq: { status: 'not-done' } } };
    const m = projectedMemberships(parseReviewers('amina@spark.org'), shared, false);
    expect(m.hq?.['amina@spark.org']).toBe(false);
    expect(m.connect?.['amina@spark.org']).toBe(true);
    expect(m.ocs?.['amina@spark.org']).toBe(false);
  });

  it('a private doc the plan shares is not a blocker; one it does not share is', () => {
    const audit = {
      findings: [
        { code: 'LINK-PRIVATE-DELIVERABLE', severity: 'broken' as const, where: 'wo', detail: 'https://docs.google.com/document/d/PRIVATEPRIV22/edit — private', fix: 'f' },
        { code: 'LINK-PRIVATE-DELIVERABLE', severity: 'broken' as const, where: 'x', detail: 'https://docs.google.com/document/d/OTHEROTHER33/edit — private', fix: 'f' },
      ],
    };
    const f = assessSurfaceAudit(audit, null, { plannedDriveIds: new Set(['PRIVATEPRIV22']) });
    expect(f).toHaveLength(1);
    expect(f[0].detail).toContain('OTHEROTHER33');
  });

  it('no reviewers: the audit\'s REVIEWERS-UNDECLARED folds into reviewers-missing', () => {
    const out = collapseSharedCauses([
      { id: 'reviewers-missing', area: 'reviewers', severity: 'blocker', owner: 'validate-release-readiness', detail: 'd', fix: 'f' },
      { id: 'surface:REVIEWERS-UNDECLARED:apps[0].hq_url', area: 'public-summary', severity: 'warning', owner: 'run-surface-audit', detail: 'd', fix: 'f' },
    ]);
    expect(out.map((f) => f.id)).toEqual(['reviewers-missing']);
    expect(out[0].merged).toEqual(['surface:REVIEWERS-UNDECLARED:apps[0].hq_url']);
  });
});

describe('cc — Dimagi staff copied on every release email (ace#2706)', () => {
  // Operator decision (Jonathan, 2026-10-05, spark-facilitator): "All 8 get the
  // email" — the partner reviewers get grants + their email, the Dimagi staff on
  // the requesting thread are copied on each email and granted nothing.
  const cc = parseCc('neal@dimagi.com, JJ@dimagi.com,jj@dimagi.com');

  it('parseCc normalises and sorts; refuses any non-Dimagi address and ACE itself', () => {
    expect(cc).toEqual(['jj@dimagi.com', 'neal@dimagi.com']);
    expect(parseCc('')).toEqual([]);
    expect(() => parseCc('amina@spark.org')).toThrow(/not Dimagi staff/);
    expect(() => parseCc('jj@dimagi.com,someone@gmail.com')).toThrow(/someone@gmail\.com/);
    expect(() => parseCc('ace@dimagi-ai.com')).toThrow(/ACE's own mailbox/);
    expect(() => parseCc('eva@dimagi-ai.com')).toThrow(/not Dimagi staff/);
    expect(() => parseCc('nope')).toThrow(/not an email/);
  });

  it('the plan carries cc, on the plan and on every email action and email — and grants the cc nothing', () => {
    const { plan, problems } = buildReleasePlan({ ...base, cc });
    expect(problems.filter((p) => p.severity === 'blocker')).toEqual([]);
    expect(plan.cc).toEqual(cc);
    const emails = plan.actions.filter((a) => a.kind === 'email');
    expect(emails).toHaveLength(2);
    for (const a of emails) expect(a.cc).toEqual(cc);
    for (const e of plan.emails) expect(e.cc).toEqual(cc);
    // no grant of any kind names a cc'd address
    expect(plan.actions.filter((a) => a.kind !== 'email' && cc.includes(a.email ?? ''))).toEqual([]);
    expect(plan.actions.filter((a) => cc.includes(a.target))).toEqual([]);
    // the email body is unchanged by cc — only the header differs
    expect(plan.emails[0].body).toBe(buildReleasePlan(base).plan.emails[0].body);
    expect(emailBody(plan, 'amina@spark.org', 'https://labs.connect.dimagi.com/ace/invite/abc123').cc).toEqual(cc);
  });

  it('cc is in the plan hash', () => {
    const none = buildReleasePlan(base).plan;
    const some = buildReleasePlan({ ...base, cc }).plan;
    const other = buildReleasePlan({ ...base, cc: ['jj@dimagi.com'] }).plan;
    expect(none.cc).toEqual([]);
    expect(planHash(some)).not.toBe(planHash(none));
    expect(planHash(some)).not.toBe(planHash(other));
    expect(planHash(some)).toBe(planHash(buildReleasePlan({ ...base, cc: [...cc].reverse() }).plan));
  });

  it('a non-Dimagi cc, or a cc who is also a reviewer, is a blocker even past parseCc', () => {
    const bad = buildReleasePlan({ ...base, cc: ['outsider@gmail.com', 'ace@dimagi-ai.com'] }).problems.map((p) => p.id);
    expect(bad).toContain('reviewers-cc-not-dimagi:outsider@gmail.com');
    expect(bad).toContain('reviewers-cc-not-dimagi:ace@dimagi-ai.com');
    const both = buildReleasePlan({ ...base, reviewers: parseReviewers('amina@spark.org,jj@dimagi.com'), cc: ['jj@dimagi.com'] }).problems;
    expect(both.find((p) => p.id === 'reviewers-cc-is-reviewer:jj@dimagi.com')?.severity).toBe('blocker');
  });

  it('the approval text shows who is copied', () => {
    expect(renderPlan(buildReleasePlan({ ...base, cc }).plan)).toContain('--- Email to amina@spark.org — Cc: jj@dimagi.com, neal@dimagi.com');
    expect(renderPlan(buildReleasePlan(base).plan)).toContain('Copied on the emails: nobody.');
  });

  it('cc is never derived from a thread — it is an explicit --cc opt-in only (ace#2720)', () => {
    const p = partitionThreadParticipants(['jjackson@dimagi.com', 'amina@spark.org']);
    expect(p).not.toHaveProperty('cc');
  });
});

describe('--from-thread: Dimagi staff on the thread are REVIEWERS (ace#2720)', () => {
  // Operator correction (Jonathan Jackson, 2026-10-05), superseding the
  // staff→cc split of ace#2706 / PR #2708: "we want dimagi people to be invited
  // into the workspace if they are on the project".
  const p = partitionThreadParticipants(
    ['Jonathan Jackson <jjackson@dimagi.com>', 'amina@spark.org', 'Bo <BO@spark.org>', 'ace@dimagi-ai.com', 'consultant@gmail.com', 'neal@dimagi.com', 'eva@dimagi-ai.com'],
  );

  it('Dimagi staff are reviewers; partners, ACE and anyone else are excluded with a reason', () => {
    // ace-web dropped the per-opp labs_allowed_domains (2026-10-08): a partner
    // is invited only when the operator names them in --reviewers.
    expect(p.reviewers).toEqual(['jjackson@dimagi.com', 'neal@dimagi.com']);
    expect(p.excluded.map((e) => e.email)).toEqual(['ace@dimagi-ai.com', 'amina@spark.org', 'bo@spark.org', 'consultant@gmail.com', 'eva@dimagi-ai.com']);
    expect(p.excluded.find((e) => e.email === 'ace@dimagi-ai.com')?.reason).toMatch(/ACE's own mailbox/);
    expect(p.excluded.find((e) => e.email === 'amina@spark.org')?.reason).toMatch(/name them in --reviewers/);
  });

  it('each staff reviewer gets an ace-web workspace invite, the partner grants and their own email', () => {
    const reviewers = parseReviewers(p.reviewers.join(','));
    expect(reviewers.every((r) => r.role === 'viewer')).toBe(true);
    const { plan, problems } = buildReleasePlan({ ...base, reviewers });
    expect(problems.filter((x) => x.severity === 'blocker')).toEqual([]);
    expect(plan.cc).toEqual([]);
    for (const staff of ['jjackson@dimagi.com', 'neal@dimagi.com']) {
      expect(plan.actions.find((a) => a.kind === 'ace_web_invite' && a.email === staff)).toMatchObject({ target: base.workspace, role: 'editor' });
      expect(plan.actions.some((a) => a.kind === 'hq_invite' && a.email === staff)).toBe(true);
      expect(plan.actions.some((a) => a.kind === 'connect_org_member' && a.email === staff)).toBe(true);
      expect(plan.actions.some((a) => a.kind === 'email' && a.target === staff)).toBe(true);
      expect(plan.emails.some((e) => e.to === staff)).toBe(true);
    }
  });
});

// ace#2770 — a reviewer already in the ace-web workspace gets no invite and no
// accept link. Live repro 2026-10-07 (/ace:release spark/spark-facilitator/
// 20261004-1706, step 27): `409 {"title": "jjackson@dimagi.com is already a
// owner of this workspace"}` → no token → step 35's email unbuildable.
describe('existing ace-web members (ace#2770)', () => {
  const ACE = { email: 'ace@dimagi-ai.com', role: 'owner', user_id: 1 };
  const reviewers = parseReviewers('new@spark.org,ed@spark.org,jjackson@dimagi.com,pend@spark.org,view@spark.org');
  const input: PlanInput = {
    ...base,
    reviewers,
    aceWebMembership: {
      members: [ACE, { email: 'ed@spark.org', role: 'editor', user_id: 11 }, { email: 'JJackson@dimagi.com', role: 'owner', user_id: 2 }, { email: 'view@spark.org', role: 'viewer', user_id: 12 }],
      pending_invites: [{ email: 'pend@spark.org', role: 'editor' }],
    },
  };
  const { plan, problems } = buildReleasePlan(input);
  const aw = (email: string) => plan.actions.filter((a) => a.email === email && a.system === 'ace-web');
  const mail = (to: string) => plan.emails.find((e) => e.to === to)!;
  const WB = 'https://labs.connect.dimagi.com/ace/w/spark/opps/spark-facilitator/runs/r1';

  it('(a) a new reviewer: invite + accept link, unchanged', () => {
    expect(problems.filter((p) => p.severity === 'blocker')).toEqual([]);
    expect(aw('new@spark.org')).toMatchObject([{ kind: 'ace_web_invite', role: 'editor' }]);
    expect(aw('new@spark.org')[0].reinvite).toBeUndefined();
    expect(mail('new@spark.org').variant).toBe('invite');
    expect(mail('new@spark.org').body).toContain(ACCEPT_LINK_TOKEN);
    expect(plan.ace_web).toContainEqual({ email: 'new@spark.org', status: 'invite', role: 'editor' });
  });

  it('(b) an existing editor: no ace-web action, already-member recorded, existing-member email', () => {
    expect(aw('ed@spark.org')).toEqual([]);
    expect(plan.ace_web).toContainEqual({ email: 'ed@spark.org', status: 'already-member', role: 'editor' });
    const e = mail('ed@spark.org');
    expect(e.variant).toBe('existing-member');
    expect(e.body).not.toContain(ACCEPT_LINK_TOKEN);
    expect(e.body).toContain(`sign in at ${WB}`);
    // everything else is kept: review page, chatbot, what they can open, the Connect order note
    expect(e.body).toContain(clone.ace_web_summary_url);
    expect(e.body).toContain('openchatstudio.com');
    expect(e.body).toContain('What you can open:');
    expect(e.body).toContain('Log in with CommCare HQ');
    // still gets the other grants and its email action
    expect(plan.actions.some((a) => a.kind === 'hq_invite' && a.email === 'ed@spark.org')).toBe(true);
    expect(plan.actions.some((a) => a.kind === 'email' && a.email === 'ed@spark.org')).toBe(true);
  });

  it('(c) an existing OWNER (the jjackson case) is already-member — never invited (that 409s)', () => {
    expect(aw('jjackson@dimagi.com')).toEqual([]);
    expect(plan.ace_web).toContainEqual({ email: 'jjackson@dimagi.com', status: 'already-member', role: 'owner' });
    expect(mail('jjackson@dimagi.com').variant).toBe('existing-member');
  });

  it('(d) a pending invite: re-invited (ace-web mints a fresh token per POST), normal email', () => {
    expect(aw('pend@spark.org')).toMatchObject([{ kind: 'ace_web_invite', role: 'editor', reinvite: true }]);
    expect(plan.ace_web).toContainEqual({ email: 'pend@spark.org', status: 'invite-pending', role: 'editor' });
    expect(mail('pend@spark.org').variant).toBe('invite');
    expect(mail('pend@spark.org').body).toContain(ACCEPT_LINK_TOKEN);
  });

  it('(e) an existing viewer: an ace_web_role raise to editor (an invite would 409), existing-member email', () => {
    expect(aw('view@spark.org')).toMatchObject([{ kind: 'ace_web_role', user_id: 12, from_role: 'viewer', role: 'editor', target: 'spark' }]);
    expect(plan.ace_web).toContainEqual({ email: 'view@spark.org', status: 'role-upgrade', role: 'editor' });
    expect(mail('view@spark.org').variant).toBe('existing-member');
    // ordered before the invites, after forward; all before the emails
    const kinds = plan.actions.map((a) => a.kind);
    expect(kinds.lastIndexOf('ace_web_role')).toBeLessThan(kinds.indexOf('ace_web_invite'));
    expect(kinds.lastIndexOf('ace_web_invite')).toBeLessThan(kinds.indexOf('email'));
  });

  it('membership not read, or read with an error, is a blocker — never "nobody is a member"', () => {
    expect(buildReleasePlan({ ...input, aceWebMembership: null }).problems.map((p) => p.id)).toContain('plan-ace-web-membership-unread');
    const err = buildReleasePlan({ ...input, aceWebMembership: { members: [], pending_invites: [], error: 'GET …/invites → 403' } }).problems;
    expect(err.find((p) => p.id === 'plan-ace-web-membership-unread')).toMatchObject({ severity: 'blocker' });
    expect(err.find((p) => p.id === 'plan-ace-web-membership-unread')!.detail).toContain('403');
  });

  it('the hash is deterministic and sees membership', () => {
    expect(planHash(buildReleasePlan(input).plan)).toBe(planHash(plan));
    const reordered = { ...input, aceWebMembership: { ...input.aceWebMembership!, members: [...input.aceWebMembership!.members].reverse() } };
    expect(planHash(buildReleasePlan(reordered).plan)).toBe(planHash(plan));
    expect(planHash(buildReleasePlan({ ...input, aceWebMembership: { members: [ACE], pending_invites: [] } }).plan)).not.toBe(planHash(plan));
  });

  it('plan-show says "already a member (role) — no invite"', () => {
    const txt = renderPlan(plan);
    expect(txt).toContain('| already a member (editor) — no invite |');
    expect(txt).toContain('| already a member (owner) — no invite |');
    expect(txt).toContain('already a member (viewer) — raise to editor, no invite');
    expect(txt).toContain('re-invite: an earlier invite is still pending');
    expect(txt).toContain('ace_web_role view@spark.org → spark (viewer → editor)');
    expect(txt).toContain('--- Email to ed@spark.org — Subject: Review access: spark-facilitator (run r1) — already a member: no accept link');
  });
});

describe('the two email variants (ace#2770)', () => {
  const membership = {
    members: [{ email: 'ace@dimagi-ai.com', role: 'owner', user_id: 1 }, { email: 'bo@spark.org', role: 'admin', user_id: 3 }],
    pending_invites: [],
  };
  const { plan } = buildReleasePlan({ ...base, aceWebMembership: membership });
  const LINK = 'https://labs.connect.dimagi.com/ace/invite/abc123';

  it('emailBody still requires a real invite link for an invite email, and refuses an existing-member email', () => {
    expect(emailBody(plan, 'amina@spark.org', LINK).body).toContain(LINK);
    expect(() => emailBody(plan, 'amina@spark.org', 'https://labs.connect.dimagi.com/ace/w/spark')).toThrow(/not an ace-web invite link/);
    expect(() => emailBody(plan, 'bo@spark.org', LINK)).toThrow(/existing-member variant/);
  });

  it('memberEmailBody sends a planned existing-member email unchanged', () => {
    const e = plan.emails.find((m) => m.to === 'bo@spark.org')!;
    expect(memberEmailBody(plan, 'bo@spark.org', 'admin')).toEqual({ subject: e.subject, body: e.body, cc: [] });
  });

  it('an invite that 409s at release: the accept step becomes the sign-in step, nothing else changes', () => {
    const planned = plan.emails.find((m) => m.to === 'amina@spark.org')!.body;
    const out = memberEmailBody(plan, 'amina@spark.org', parseAlreadyMember('amina@spark.org is already a editor of this workspace')!).body;
    expect(out).not.toContain(ACCEPT_LINK_TOKEN);
    expect(out).toContain(`sign in at ${plan.workbench_url}`);
    const strip = (b: string) => b.split('\n').filter((l) => !l.startsWith('1. ')).join('\n');
    expect(strip(out)).toBe(strip(planned));
  });

  it('refuses a member below editor — not a satisfied grant', () => {
    expect(() => memberEmailBody(plan, 'amina@spark.org', 'viewer')).toThrow(/below the release's editor/);
    expect(() => memberEmailBody(plan, 'nobody@x.org', 'owner')).toThrow(/no email to/);
  });

  it("parseAlreadyMember reads ace-web's 409 title (live wording, 2026-10-07)", () => {
    expect(parseAlreadyMember('jjackson@dimagi.com is already a owner of this workspace')).toBe('owner');
    expect(parseAlreadyMember('x@y.org is already an admin of this workspace')).toBe('admin');
    expect(parseAlreadyMember('Admin or owner required')).toBeNull();
  });
});
