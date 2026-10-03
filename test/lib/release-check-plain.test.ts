/**
 * release-check findings carry a plain `summary` + `action`, and one root
 * cause is one item. Fixture: the two findings spark/spark-facilitator/
 * 20261001-2208's verdict carried on 2026-10-03, verbatim.
 */
import { describe, expect, it } from 'vitest';

import { buildReleaseVerdict, renderReleaseReport, releaseGate, type ReleaseFinding } from '../../lib/release-check';
import { collapseSharedCauses, linkList, plainFinding, productLabel } from '../../lib/release-check-plain';
import { plainLanguageFindings } from '../../lib/decision-review';

const SPARK: ReleaseFinding[] = [
  {
    id: 'eval-below-band:run-surface-audit-eval',
    area: 'eval',
    severity: 'blocker',
    owner: 'run-surface-audit',
    detail: 'run-surface-audit-eval incomplete (pass band ≥ 7)',
    fix: "fix run-surface-audit's output per the verdict, then re-run run-surface-audit-eval",
  },
  {
    id: 'surface:REVIEWERS-UNDECLARED:apps[0].hq_url, apps[1].hq_url, connect.opportunity.url, assistant.ocs_url',
    area: 'public-summary',
    severity: 'warning',
    owner: 'run-surface-audit',
    detail:
      '4 link(s) on this page require MEMBERSHIP, and no reviewer was named, so nothing checked whether the people this run is being shared with can open them. Anonymous reachability only proves the link works for somebody (apps[0].hq_url, apps[1].hq_url, connect.opportunity.url, assistant.ocs_url)',
    fix: 'pass --reviewer <email> per person (plus --memberships), or withhold these links as internal build tools',
  },
];

const verdict = () =>
  buildReleaseVerdict({ workspace: 'spark', opp: 'spark-facilitator', runId: '20261001-2208', checkedAt: '2026-10-03T12:00:00Z', files: [], findings: SPARK });

describe('release-check plain language', () => {
  it('folds the incomplete review-page eval into the finding that stopped it — one item, still NOT READY', () => {
    const v = verdict();
    expect(v.verdict).toBe('NOT_READY');
    expect(v.counts).toEqual({ blockers: 1, warnings: 0 });
    expect(v.blockers[0].merged).toEqual(['eval-below-band:run-surface-audit-eval']);
  });

  it('says what to do in words a partner-facing operator can act on', () => {
    const [b] = verdict().blockers;
    expect(b.action).toBe("Name the Spark reviewers — we'll check they can open the two HQ apps, the Connect opportunity and the chatbot console.");
    expect(b.summary).toMatch(/member-only links on the review page/);
    for (const t of [b.summary!, b.action!]) expect(plainLanguageFindings(t)).toEqual([]);
    // compatibility: the build team's fields survive
    expect(b.fix).toMatch(/--reviewer/);
  });

  it('never makes a NOT READY verdict READY (control: a lone surface warning stays a warning)', () => {
    expect(collapseSharedCauses([SPARK[1]])).toEqual([SPARK[1]]);
    const v = buildReleaseVerdict({ workspace: 'spark', opp: 'o', runId: 'r', checkedAt: 'x', files: [], findings: [SPARK[1]] });
    expect(v.verdict).toBe('READY');
    expect(v.warnings[0].summary).toBeTruthy();
  });

  it('gives every finding class a summary and action without ACE internals', () => {
    const samples: ReleaseFinding[] = [
      { id: 'qa-fail:training-faq-qa', area: 'qa', severity: 'blocker', owner: 'training-faq-qa', detail: 'x', fix: 'y' },
      { id: 'eval-missing:pdd-to-deliver-app-eval', area: 'eval', severity: 'blocker', owner: 'pdd-to-deliver-app-eval', detail: 'x', fix: 'y' },
      { id: 'connect-verification_rules_persisted', area: 'connect', severity: 'warning', owner: 'connect-opp-setup', detail: 'x', fix: 'y' },
      { id: 'app-unreleased:learn', area: 'apps', severity: 'blocker', owner: 'app-release', detail: 'x', fix: 'y' },
      { id: 'chatbot-untested', area: 'chatbot', severity: 'blocker', owner: 'ocs-chatbot-qa', detail: 'x', fix: 'y' },
    ];
    for (const f of samples) {
      const p = plainFinding(f, { workspace: 'spark' });
      expect(plainLanguageFindings(`${p.summary} ${p.action}`), f.id).toEqual([]);
    }
    expect(productLabel('pdd-to-deliver-app-eval')).toBe('the Deliver (field) app');
    expect(linkList('apps[0].hq_url')).toBe('the HQ app');
  });

  it('the report and the gate lead with the plain text', () => {
    const v = verdict();
    const report = renderReleaseReport(v);
    expect(report).toContain("**Nobody has checked that the Spark reviewers");
    expect(report).toContain('For the build team');
    const gate = releaseGate(v, { workspace: 'spark', opp: 'spark-facilitator', runId: '20261001-2208', files: [] });
    expect(gate.ok).toBe(false);
    expect(gate.reason).toContain('Name the Spark reviewers');
  });
});
