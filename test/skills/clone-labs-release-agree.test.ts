/**
 * clone § 4c, validate-release-readiness and release-run say the SAME thing
 * about Labs (ace#3020).
 *
 * The defect: `clone-to-new-workspace` § 4c said Labs was "not widened
 * (Dimagi-only)" while `validate-release-readiness` said "the clone already
 * WIDENED each synthetic opp's allowlist" and `release-run` said "the clone
 * already allowed the reviewer's domain". Three skills, two stories, and the
 * tenancy guard enforced a third — so a released run never shared its Phase 7
 * dashboards. Owner, 2026-10-16: they are meant to be shared, by REBUILDING
 * them in the clone's own program ("create the report in the new program and
 * the synthetic data in the new program"). Observed releasing
 * noora-health/20261015-1129 to Noora Health's co-founders.
 *
 * The one story, pinned here and in lib/release-plan.ts:
 *   clone § 4c rebuilds Phase 7 in a new labs program + labs workspace whose
 *   LLOs are the clone's Connect orgs → readiness grants Labs only when
 *   clone.labs AND clone.connect are done → release makes no Labs call (the
 *   Connect grant is the Labs grant). Nobody widens a synthetic allowlist.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildReleasePlan, grantsFor, parseReviewers } from '../../lib/release-plan';

const ROOT = join(__dirname, '../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const CLONE = read('skills/clone-to-new-workspace/SKILL.md');
const SEC_4C = CLONE.slice(CLONE.indexOf('### 4c.'), CLONE.indexOf('## Step 5'));
const READINESS = read('skills/validate-release-readiness/SKILL.md');
const RELEASE = read('skills/release-run/SKILL.md');

describe('Labs: clone § 4c, readiness and release agree (ace#3020)', () => {
  it('§ 4c is a REBUILD in the clone\'s own program, never a widening', () => {
    expect(SEC_4C).toMatch(/^### 4c\. Labs — rebuild/);
    expect(SEC_4C.length).toBeGreaterThan(2000); // the section really sliced
    for (const step of ['synthetic_clone_to_labs_only', 'semantic_registry_get', 'semantic_registry_create', 'workflow_get', "'indicator_programme_report'", 'benchmarks_create_opp_reports', 'labs-workspace-setup.ts', 'clone-labs-rebuild.ts', 'remap']) {
      expect(SEC_4C, step).toContain(step);
    }
    expect(SEC_4C).toMatch(/clone\.labs: \{status: done/);
    expect(SEC_4C).toMatch(/workspace: \{llos:/);
    expect(SEC_4C).not.toMatch(/Dimagi-only/);
    // a COPY (owner, 2026-10-16): no generator runs in the rebuild
    expect(SEC_4C).toContain('**Never regenerate.**');
    expect(SEC_4C).not.toMatch(/run-labs-synthetic-generate/);
    for (const line of SEC_4C.split('\n').filter((l) => /synthetic_generate_from_manifest|synthetic_clone_generate|synthetic_clone_opp\b/.test(l))) {
      expect(SEC_4C.slice(SEC_4C.indexOf('**Never regenerate.**'), SEC_4C.indexOf('Run it after 4b'))).toContain(line.trim());
    }
    // synthetic_set_allowed_domains may only appear as a prohibition
    for (const m of SEC_4C.matchAll(/synthetic_set_allowed_domains/g)) {
      const before = SEC_4C.slice(Math.max(0, m.index! - 40), m.index!);
      expect(before, before).toMatch(/do not call|never/i);
    }
  });

  it('readiness says the clone REBUILT Labs and grants it on the Connect grant', () => {
    expect(READINESS).toContain('Labs is REBUILT, never widened');
    expect(READINESS).toContain('`clone-to-new-workspace` § 4c');
    expect(READINESS).toContain('plan-labs-workspace-llo-missing');
    expect(READINESS).not.toMatch(/WIDENED each synthetic opp/);
  });

  it('release makes no Labs call: the Connect grant is the Labs grant', () => {
    expect(RELEASE).toContain('IS the Labs grant');
    expect(RELEASE).toContain('`clone-to-new-workspace` § 4c');
    expect(RELEASE).not.toMatch(/allowed the reviewer's domain/);
    expect(RELEASE).not.toMatch(/synthetic_set_allowed_domains/);
    expect(read('commands/release.md')).not.toMatch(/synthetic_set_allowed_domains/);
    expect(read('commands/clone-to-new-workspace.md')).not.toMatch(/synthetic_set_allowed_domains/);
  });

  it('the plan code holds the same rule the three docs state', () => {
    const rs = (labs: unknown, connect = 'done') => ({ clone: { hq: { status: 'done' }, connect: { status: connect }, labs } });
    const partner = 'edith@noorahealth.org';
    expect(grantsFor(partner, rs({ status: 'done' }), false).labs).toBe(true);
    expect(grantsFor(partner, rs({ status: 'skipped' }), false).labs).toBe(false);
    expect(grantsFor(partner, rs({ status: 'done' }, 'skipped'), true).labs).toBe(false);
    const { plan, problems } = buildReleasePlan({
      workspace: 'noora-health', opp: 'noora-health', runId: '20261015-1129', reviewers: parseReviewers(partner),
      runState: { ...rs({ status: 'done', workspace: { llos: ['noora-health-nm-test'] } }), phases: { 'synthetic-data-and-workflows': { products: { synthetic: { labs_opp_id: 10300 } } } } },
      tenancy: { hq_domain: 'connect-ace-noora', connect_holding_org: 'noora-health-nm-test', connect_pm_org: 'noora-health-pm-test' },
      driveDocs: [], options: { forward_source: false, allow_cross_workspace_forward: false, allow_shared_connect: false },
      aceWebBase: 'https://labs.connect.dimagi.com/ace', aceWebMembership: { members: [], pending_invites: [] },
    });
    // no Labs action kind exists; the pm org missing from the workspace blocks
    expect(plan.actions.map((a) => a.system as string)).not.toContain('labs');
    expect(problems.find((p) => p.id === 'plan-labs-workspace-llo-missing')?.detail).toContain('noora-health-pm-test');
  });
});
