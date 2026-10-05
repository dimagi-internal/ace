/**
 * validate-release-readiness → /ace:release: the verdict and the gate.
 *
 * The owner's rule (Jonathan, 2026-10-03): when validation passes, executing
 * release changes nothing but external sharing. The gate is how that holds:
 * a release runs ONLY against a READY verdict whose plan is untampered and was
 * validated for exactly this run, these reviewers, these flags and this
 * run_state — and every mismatch REFUSES rather than adapting.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { assessGates, buildReleaseVerdict, releaseGate, renderReleaseReport, type RunFile } from '../../lib/release-readiness';
import { buildReleasePlan, planHash, runStateHash } from '../../lib/release-plan';

const FIX = join(__dirname, '../fixtures/release-readiness/spark-20260926-1800');
const json = <T>(n: string): T => JSON.parse(readFileSync(join(FIX, n), 'utf8')) as T;
const rsText = readFileSync(join(FIX, 'run_state.yaml'), 'utf8');
const catalog = { qaSkills: new Set(['idea-to-pdd']), evalSkills: new Set(['build-memo']) };
const opts = { forward_source: false, allow_cross_workspace_forward: false, allow_shared_connect: false };
const reviewers = [{ email: 'amina@spark.org', role: 'viewer' as const }];

function readyVerdict(files: RunFile[]) {
  const { plan } = buildReleasePlan({
    workspace: 'spark', opp: 'spark-facilitator', runId: '20260926-1800', reviewers,
    runState: parseYaml(rsText), tenancy: { hq_domain: 'connect-ace-spark', connect_holding_org: 'spark-nm' },
    driveDocs: [], options: opts, aceWebBase: 'https://labs.connect.dimagi.com/ace',
  });
  return buildReleaseVerdict({ workspace: 'spark', opp: 'spark-facilitator', runId: '20260926-1800', checkedAt: '2026-10-01T21:00:00Z', files, findings: [], reviewers, runStateHash: runStateHash(rsText), plan });
}

describe('verdict', () => {
  it('the real Spark run is NOT_READY, carries no plan, and the gate refuses it', () => {
    const files = json<RunFile[]>('inventory.json');
    const findings = assessGates(files, parseYaml(rsText), catalog);
    const v = buildReleaseVerdict({ workspace: 'dimagi-team', opp: 'spark-facilitator', runId: '20260926-1800', checkedAt: '2026-10-01T21:00:00Z', files, findings, reviewers, runStateHash: runStateHash(rsText) });
    expect(v.kind).toBe('release-readiness');
    expect(v.verdict).toBe('NOT_READY');
    expect(v.release_plan).toBeNull();
    expect(renderReleaseReport(v)).toMatch(/NOT READY to release/);
    const g = releaseGate(v, { workspace: 'dimagi-team', opp: 'spark-facilitator', runId: '20260926-1800', files, runStateHash: runStateHash(rsText), reviewers, options: opts });
    expect(g.ok).toBe(false);
    expect(g.reason).toMatch(/NOT_READY/);
  });

  it('no reviewers → never READY, even with zero blockers', () => {
    const v = buildReleaseVerdict({ workspace: 'spark', opp: 'o', runId: 'r', checkedAt: '2026-10-01T21:00:00Z', files: [], findings: [], reviewers: [], runStateHash: 'x' });
    expect(v.verdict).toBe('NOT_READY');
    expect(v.release_plan).toBeNull();
  });

  it('a READY verdict carries the plan, its hash and the run_state hash; the report shows the plan', () => {
    const v = readyVerdict(json<RunFile[]>('inventory.json'));
    expect(v.verdict).toBe('READY');
    expect(v.plan_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(v.run_state_hash).toBe(runStateHash(rsText));
    expect(renderReleaseReport(v, 'PLAN TEXT')).toContain('PLAN TEXT');
  });

  it('run_state hashing is content, not bytes', () => {
    expect(runStateHash(rsText.replace(/\n/g, '\r\n'))).toBe(runStateHash(rsText));
    expect(runStateHash(rsText + '\nextra: 1\n')).not.toBe(runStateHash(rsText));
  });
});

describe('the release gate refuses every mismatch', () => {
  const files = json<RunFile[]>('inventory.json');
  const ready = readyVerdict(files);
  const here = { workspace: 'spark', opp: 'spark-facilitator', runId: '20260926-1800', files, runStateHash: runStateHash(rsText), reviewers, options: opts };

  it('passes the exact request', () => {
    expect(releaseGate(ready, here).ok).toBe(true);
  });
  it('another run / workspace, a dry run, no verdict', () => {
    expect(releaseGate(ready, { ...here, workspace: 'dimagi-team' }).ok).toBe(false);
    expect(releaseGate({ ...ready, read_only: true }, here).ok).toBe(false);
    expect(releaseGate(null, here).ok).toBe(false);
  });
  it('a write to the run after validation (but not the verdict files themselves)', () => {
    const changed = [...files, { path: '4-connect/build-memo.md', modifiedTime: '2026-10-02T00:00:00Z' }];
    expect(releaseGate(ready, { ...here, files: changed }).reason).toMatch(/changed after the validation/);
    const own = [...files, { path: 'release-readiness_report.md', modifiedTime: '2026-10-09T00:00:00Z' }];
    expect(releaseGate(ready, { ...here, files: own }).ok).toBe(true);
  });
  it('reviewers must match exactly — extra, missing, or a different role', () => {
    expect(releaseGate(ready, { ...here, reviewers: [...reviewers, { email: 'x@spark.org', role: 'viewer' }] }).reason).toMatch(/not the reviewers validated/);
    expect(releaseGate(ready, { ...here, reviewers: [] }).ok).toBe(false);
    expect(releaseGate(ready, { ...here, reviewers: [{ email: 'amina@spark.org', role: 'editor' }] }).ok).toBe(false);
  });
  it('cc must match exactly — the cc validated is part of the plan (ace#2706)', () => {
    const cc = ['jj@dimagi.com', 'neal@dimagi.com'];
    const { plan } = buildReleasePlan({
      workspace: 'spark', opp: 'spark-facilitator', runId: '20260926-1800', reviewers, cc,
      runState: parseYaml(rsText), tenancy: { hq_domain: 'connect-ace-spark', connect_holding_org: 'spark-nm' },
      driveDocs: [], options: opts, aceWebBase: 'https://labs.connect.dimagi.com/ace',
    });
    const withCc = buildReleaseVerdict({ workspace: 'spark', opp: 'spark-facilitator', runId: '20260926-1800', checkedAt: '2026-10-01T21:00:00Z', files, findings: [], reviewers, cc, runStateHash: runStateHash(rsText), plan });
    expect(withCc.verdict).toBe('READY');
    expect(withCc.cc).toEqual(cc);
    expect(releaseGate(withCc, { ...here, cc }).ok).toBe(true);
    expect(releaseGate(withCc, { ...here, cc: [...cc].reverse() }).ok).toBe(true); // order is not a difference
    expect(releaseGate(withCc, { ...here, cc: ['jj@dimagi.com'] }).reason).toMatch(/cc requested .* is not the cc validated/);
    expect(releaseGate(withCc, { ...here, cc: [...cc, 'x@dimagi.com'] }).ok).toBe(false);
    expect(releaseGate(withCc, here).ok).toBe(false); // cc dropped at release
    expect(releaseGate(ready, { ...here, cc }).ok).toBe(false); // cc added at release
    // a pre-cc plan (no `cc` key at all) reads as "nobody copied"
    const legacy = JSON.parse(JSON.stringify(ready));
    delete legacy.release_plan.cc;
    for (const e of legacy.release_plan.emails) delete e.cc;
    for (const a of legacy.release_plan.actions) delete a.cc;
    legacy.plan_hash = planHash(legacy.release_plan);
    expect(releaseGate(legacy, here).ok).toBe(true);
    expect(releaseGate(legacy, { ...here, cc }).ok).toBe(false);
    // the cc cannot be edited into a validated plan
    const tampered = JSON.parse(JSON.stringify(ready));
    tampered.release_plan.cc = ['jj@dimagi.com'];
    expect(releaseGate(tampered, { ...here, cc: ['jj@dimagi.com'] }).reason).toMatch(/does not match its recorded hash/);
  });
  it('flags must match', () => {
    expect(releaseGate(ready, { ...here, options: { ...opts, forward_source: true } }).reason).toMatch(/forward-source/);
    expect(releaseGate(ready, { ...here, options: { ...opts, allow_shared_connect: true } }).ok).toBe(false);
  });
  it('run_state content must match', () => {
    expect(releaseGate(ready, { ...here, runStateHash: runStateHash(rsText + '\nextra: 1\n') }).reason).toMatch(/run_state\.yaml changed/);
  });
  it('the plan cannot be edited after validation', () => {
    const tampered = JSON.parse(JSON.stringify(ready));
    tampered.release_plan.actions.push({ step: 99, id: 'hq:evil@x.org', system: 'hq', kind: 'hq_invite', email: 'evil@x.org', target: 'connect-ace-spark' });
    expect(releaseGate(tampered, here).reason).toMatch(/does not match its recorded hash/);
  });
  it('a verdict of any other kind or schema has no plan and is refused', () => {
    expect(releaseGate({ ...ready, kind: 'other', schema_version: 1 } as never, here).reason).toMatch(/no release plan/);
  });
});
