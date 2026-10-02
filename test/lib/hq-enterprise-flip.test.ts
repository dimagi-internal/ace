/**
 * The HQ superuser step at release time (ace#2552 → ace#2600). A space ACE
 * created is on Free until a Dimagi HQ superuser picks "Test or Demo Project"
 * on its internal subscription management page; release-check blocks on it
 * and its `fix` is that step, verbatim, so whoever runs /ace:release sees the
 * exact URL and clicks.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { hqDomainFromRunState, hqEnterpriseFlipSteps, hqEnterpriseFlipUrl } from '../../lib/hq-enterprise-flip';
import { assessHqPlan, buildReleaseVerdict, renderReleaseReport } from '../../lib/release-check';
import { parseSubscriptionPage } from '../../mcp/connect/backends/commcare';

const fixture = (n: string) => readFileSync(join(__dirname, '../fixtures/hq-subscription', `${n}.html`), 'utf8');

describe('hqEnterpriseFlipSteps', () => {
  it("names the NEW space's own internal-subscription page, the option and the button", () => {
    const s = hqEnterpriseFlipSteps('connect-ace-spark');
    expect(hqEnterpriseFlipUrl('connect-ace-spark')).toBe('https://www.commcarehq.org/a/connect-ace-spark/settings/project/internal_subscription_management/');
    expect(s).toContain('https://www.commcarehq.org/a/connect-ace-spark/settings/project/internal_subscription_management/');
    expect(s).toContain('**Test or Demo Project**');
    expect(s).toContain('**Update**');
    expect(s).toMatch(/superuser/);
    expect(s).toContain('https://www.commcarehq.org/a/connect-ace-spark/settings/project/subscription/');
  });
});

describe('hqDomainFromRunState', () => {
  it('reads the apps domain from the real Spark run', () => {
    const rs = parseYaml(readFileSync(join(__dirname, '../fixtures/release-check/spark-20260926-1800/run_state.yaml'), 'utf8'));
    expect(hqDomainFromRunState(rs)).toBe('connect-ace-prod');
  });
  it('falls back to a per-app domain, and is null when nothing is recorded', () => {
    expect(hqDomainFromRunState({ phases: { 'commcare-setup': { products: { apps: { learn: { domain: 'connect-ace-x' } } } } } })).toBe('connect-ace-x');
    expect(hqDomainFromRunState({})).toBeNull();
  });
});

describe('assessHqPlan', () => {
  it('blocks a Free space with the superuser step as the fix (live connect-ace-spark read)', () => {
    const plan = parseSubscriptionPage(fixture('connect-ace-spark'), 'connect-ace-spark');
    const [f, ...rest] = assessHqPlan('connect-ace-spark', plan);
    expect(rest).toEqual([]);
    expect(f).toMatchObject({ id: 'hq-plan-free:connect-ace-spark', area: 'hq', severity: 'blocker', owner: 'HQ superuser (operator)' });
    expect(f.fix).toBe(hqEnterpriseFlipSteps('connect-ace-spark'));
  });
  it('passes a paid space (live connect-ace-prod read)', () => {
    expect(assessHqPlan('connect-ace-prod', parseSubscriptionPage(fixture('connect-ace-prod'), 'connect-ace-prod'))).toEqual([]);
  });
  it('treats an unread plan, a plan for another space, or no recorded domain as blockers — never a pass', () => {
    expect(assessHqPlan('connect-ace-spark', null)[0].id).toBe('hq-plan-unchecked');
    expect(assessHqPlan('connect-ace-spark', { domain: 'connect-ace-prod', is_paid_edition: true })[0].id).toBe('hq-plan-wrong-space');
    expect(assessHqPlan(null, null)[0].id).toBe('hq-domain-unknown');
  });
  it('renders the steps as one bullet in the report, URL intact', () => {
    const findings = assessHqPlan('connect-ace-spark', { domain: 'connect-ace-spark', edition: 'Free', is_paid_edition: false });
    const v = buildReleaseVerdict({ workspace: 'spark', opp: 'o', runId: 'r', checkedAt: '2026-10-02T00:00:00Z', files: [], findings, readOnly: false });
    expect(v.verdict).toBe('NOT_READY');
    expect(v.areas.hq).toEqual({ blockers: 1, warnings: 0 });
    const md = renderReleaseReport(v);
    expect(md).toContain('  1. Signed in to CommCare HQ as a Dimagi **superuser**, open https://www.commcarehq.org/a/connect-ace-spark/settings/project/internal_subscription_management/');
  });
});
