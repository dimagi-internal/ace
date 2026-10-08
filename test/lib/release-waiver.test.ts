/**
 * validate-release-readiness `--waive <blocker-id>=<reason>` (ace#2707).
 *
 * Operator decision (Jonathan, 2026-10-05, the spark-facilitator release):
 * release the work order as a DRAFT although `pdd-to-work-order-eval` fails —
 * three independent judges scored it 7.15–7.65 and are not converging — with
 * the reason recorded and the failing grade still visible.
 *
 * The rules this pins:
 *   - a waived blocker STAYS in the verdict, marked `waived: {by, at, reason}`,
 *     and is excluded from READY;
 *   - only area `eval` (eval quality) is waivable — every other area is refused;
 *   - a waiver that names no blocker is refused, and so is an unattributed one;
 *   - waivers are on the plan (in its hash), shown for approval, and compared
 *     exactly by the release gate.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  WAIVABLE_AREAS,
  buildReleaseVerdict,
  parseWaivers,
  releaseGate,
  renderReleaseReport,
  type ReleaseArea,
  type ReleaseFinding,
  type RunFile,
} from '../../lib/release-readiness';
import { buildReleasePlan, planHash, renderPlan, runStateHash } from '../../lib/release-plan';

const FIX = join(__dirname, '../fixtures/release-readiness/spark-20260926-1800');
const files = JSON.parse(readFileSync(join(FIX, 'inventory.json'), 'utf8')) as RunFile[];
const rsText = readFileSync(join(FIX, 'run_state.yaml'), 'utf8');
const opts = { forward_source: false, allow_cross_workspace_forward: false, allow_shared_connect: false };
const reviewers = [{ email: 'amina@spark.org', role: 'viewer' as const }];
const WO = 'eval-below-band:pdd-to-work-order-eval';
const REASON = 'release the work order as a DRAFT: three judges 7.15-7.65, not converging';
const BY = 'jjackson@dimagi.com';
const AT = '2026-10-05T18:00:00Z';

const woBlocker: ReleaseFinding = {
  id: WO, area: 'eval', severity: 'blocker', owner: 'pdd-to-work-order',
  detail: 'pdd-to-work-order-eval fail 7.4 (pass band ≥ 8)', fix: "fix pdd-to-work-order's output per the verdict, then re-run pdd-to-work-order-eval",
};

function plan() {
  return buildReleasePlan({
    workspace: 'spark', opp: 'spark-facilitator', runId: '20260926-1800', reviewers,
    runState: parseYaml(rsText), tenancy: { hq_domain: 'connect-ace-spark', connect_holding_org: 'spark-nm' },
    driveDocs: [], options: opts, aceWebBase: 'https://labs.connect.dimagi.com/ace', aceWebMembership: { members: [], pending_invites: [] },
  }).plan;
}

function verdict(findings: ReleaseFinding[], waivers = parseWaivers([`${WO}=${REASON}`]), waivedBy: string | undefined = BY) {
  return buildReleaseVerdict({
    workspace: 'spark', opp: 'spark-facilitator', runId: '20260926-1800', checkedAt: AT, files, findings,
    reviewers, runStateHash: runStateHash(rsText), plan: plan(), waivers, waivedBy,
  });
}

const here = { workspace: 'spark', opp: 'spark-facilitator', runId: '20260926-1800', files, runStateHash: runStateHash(rsText), reviewers, options: opts };

describe('parseWaivers', () => {
  it('splits at the first "=", trims, sorts by id', () => {
    expect(parseWaivers([' b:x = why = because ', 'a:y=r'])).toEqual([
      { id: 'a:y', reason: 'r' },
      { id: 'b:x', reason: 'why = because' },
    ]);
    expect(parseWaivers([])).toEqual([]);
  });
  it('refuses a waiver with no id, no reason, or no "="; and one id waived twice', () => {
    expect(() => parseWaivers(['eval-below-band:x'])).toThrow(/<blocker-id>=<reason>/);
    expect(() => parseWaivers(['=because'])).toThrow(/blocker id/);
    expect(() => parseWaivers(['eval-below-band:x=  '])).toThrow(/reason/);
    expect(() => parseWaivers(['a=one', 'a=two'])).toThrow(/twice/);
  });
});

describe('a waived eval blocker', () => {
  const v = verdict([woBlocker]);

  it('is READY, and the blocker stays in the verdict marked waived — by, at, reason', () => {
    expect(v.verdict).toBe('READY');
    const b = v.blockers.find((f) => f.id === WO)!;
    expect(b.waived).toEqual({ by: BY, at: AT, reason: REASON });
    expect(b.detail).toMatch(/7\.4/); // the failing grade is still there
    expect(v.counts).toMatchObject({ blockers: 0, waived: 1 });
    expect(v.areas.eval.blockers).toBe(0);
    expect(v.waivers).toEqual([{ id: WO, reason: REASON, by: BY, at: AT, detail: woBlocker.detail }]);
  });

  it('is on the release plan, in its hash, and shown for approval', () => {
    expect(v.release_plan!.waivers).toEqual(v.waivers);
    expect(v.plan_hash).toBe(planHash(v.release_plan!));
    const other = verdict([woBlocker], parseWaivers([`${WO}=a different reason`]));
    expect(other.plan_hash).not.toBe(v.plan_hash);
    const txt = renderPlan(v.release_plan!);
    expect(txt).toContain('WAIVED');
    expect(txt).toContain(WO);
    expect(txt).toContain('7.4');
    expect(txt).toContain(REASON);
    expect(txt).toContain(BY);
  });

  it('the report keeps the failing grade visible, under its own heading', () => {
    const r = renderReleaseReport(v);
    expect(r).toMatch(/Waived by the operator/);
    expect(r).toContain('7.4');
    expect(r).toContain(REASON);
    expect(r).toContain(BY);
    expect(r).toMatch(/1 waived/);
  });

  it('an un-waived blocker beside it still blocks', () => {
    const other: ReleaseFinding = { ...woBlocker, id: 'eval-below-band:training-faq-eval', owner: 'training-faq' };
    const v2 = verdict([woBlocker, other]);
    expect(v2.verdict).toBe('NOT_READY');
    expect(v2.counts).toMatchObject({ blockers: 1, waived: 1 });
    const g = releaseGate(v2, { ...here, waivers: parseWaivers([`${WO}=${REASON}`]) });
    expect(g.ok).toBe(false);
    expect(g.reason).toContain('training-faq');
    expect(g.reason).not.toContain(WO); // the waived one is not listed as blocking
  });
});

describe('only eval-quality blockers are waivable', () => {
  const NOT_WAIVABLE: Array<[ReleaseArea, string]> = [
    ['drive', 'drive-access-unread:FILE'], // sharing
    ['public-summary', 'surface:LINK-CONFIDENTIAL:x'], // confidentiality
    ['links', 'link:Learn app'],
    ['hq', 'hq-plan-free:connect-ace-spark'],
    ['reviewers', 'reviewers-missing'],
    ['public-summary', 'required-before:wo-12'], // required-before ask
    ['public-summary', 'decisions-plain:idea-to-pdd'], // plain-language gate
    ['connect', 'connect-postcondition:payment-units'],
    ['apps', 'app-unreleased:deliver'],
    ['qa', 'qa-fail:pdd-to-work-order'],
    ['release-plan', 'forward-source-cross-workspace'],
    ['previews', 'preview-gap:x'],
    ['chatbot', 'chatbot-untested'],
  ];
  it('the waivable set is exactly {eval}', () => {
    expect([...WAIVABLE_AREAS]).toEqual(['eval']);
  });
  for (const [area, id] of NOT_WAIVABLE) {
    it(`refuses a waiver of ${area} blocker ${id}`, () => {
      const f: ReleaseFinding = { id, area, severity: 'blocker', owner: 'x', detail: 'd', fix: 'f' };
      const v = verdict([f], parseWaivers([`${id}=please`]));
      expect(v.verdict).toBe('NOT_READY');
      expect(v.blockers.find((b) => b.id === id)?.waived).toBeUndefined();
      const refused = v.blockers.find((b) => b.id === `waiver-refused:${id}`)!;
      expect(refused.severity).toBe('blocker');
      expect(refused.detail).toMatch(new RegExp(`area ${area}`));
      expect(v.release_plan).toBeNull();
    });
  }
  it('every eval finding kind is waivable', () => {
    for (const id of [WO, 'eval-missing:training-faq-eval', 'eval-stale:pdd-to-work-order-eval', 'eval-unreadable:pdd-to-work-order-eval']) {
      const v = verdict([{ ...woBlocker, id }], parseWaivers([`${id}=r`]));
      expect(v.verdict, id).toBe('READY');
    }
  });
});

describe('a waiver must name a real blocker and an operator', () => {
  it('a waiver that matches no blocker is refused (a typo never reads as "waived")', () => {
    const v = verdict([woBlocker], parseWaivers([`${WO}=${REASON}`, 'eval-below-band:typo-eval=x']));
    expect(v.verdict).toBe('NOT_READY');
    expect(v.blockers.map((b) => b.id)).toContain('waiver-unmatched:eval-below-band:typo-eval');
  });
  it('a warning is not a blocker and cannot be waived', () => {
    const v = verdict([{ ...woBlocker, severity: 'warning' }], parseWaivers([`${WO}=r`]));
    expect(v.blockers.map((b) => b.id)).toContain(`waiver-unmatched:${WO}`);
  });
  it('a waiver with no operator email is refused', () => {
    const v = verdict([woBlocker], parseWaivers([`${WO}=${REASON}`]), '');
    expect(v.verdict).toBe('NOT_READY');
    expect(v.blockers.map((b) => b.id)).toContain(`waiver-unattributed:${WO}`);
  });
});

describe('the release gate compares waivers exactly', () => {
  const v = verdict([woBlocker]);
  const same = parseWaivers([`${WO}=${REASON}`]);

  it('passes the same waivers', () => {
    expect(releaseGate(v, { ...here, waivers: same }).ok).toBe(true);
  });
  it('refuses a missing, different or extra waiver', () => {
    expect(releaseGate(v, here).reason).toMatch(/waivers requested .* are not the waivers validated/);
    expect(releaseGate(v, { ...here, waivers: parseWaivers([`${WO}=another reason`]) }).ok).toBe(false);
    expect(releaseGate(v, { ...here, waivers: [...same, { id: 'eval-below-band:x-eval', reason: 'r' }] }).ok).toBe(false);
  });
  it('a plan validated with no waivers refuses one added at release', () => {
    const clean = verdict([], []);
    expect(clean.verdict).toBe('READY');
    expect(releaseGate(clean, here).ok).toBe(true);
    expect(releaseGate(clean, { ...here, waivers: same }).ok).toBe(false);
  });
  it('a waiver cannot be edited into a validated plan', () => {
    const t = JSON.parse(JSON.stringify(v));
    t.release_plan.waivers[0].reason = 'edited';
    expect(releaseGate(t, { ...here, waivers: parseWaivers([`${WO}=edited`]) }).reason).toMatch(/does not match its recorded hash/);
  });
});
