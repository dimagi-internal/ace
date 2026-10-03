/**
 * lib/release-plan.ts — the exact share actions /ace:release executes.
 */
import { describe, expect, it } from 'vitest';
import { assessSurfaceAudit } from '../../lib/release-readiness';
import { collapseSharedCauses } from '../../lib/release-readiness-plain';
import {
  ACCEPT_LINK_TOKEN,
  buildReleasePlan,
  emailBody,
  grantsFor,
  parseReviewers,
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

describe('buildReleasePlan', () => {
  it('orders HQ, Connect, Drive, ace-web, emails — and nothing else', () => {
    const { plan, problems } = buildReleasePlan(base);
    expect(problems.filter((p) => p.severity === 'blocker')).toEqual([]);
    expect(plan.actions.map((a) => a.kind)).toEqual([
      'hq_invite', 'hq_invite', 'connect_org_member', 'connect_org_member', 'drive_share', 'ace_web_invite', 'ace_web_invite', 'email', 'email',
    ]);
    expect(plan.actions.map((a) => a.step)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
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
