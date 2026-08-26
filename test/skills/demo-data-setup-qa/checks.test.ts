/**
 * dimagi-internal/ace#1161 (+ #1037, merged into it).
 *
 * `demo-data-setup-qa` exists to guarantee, per lib/artifact-manifest.ts, that
 * "a dead dashboard must not reach a stakeholder". Run against
 * hh-poverty-targeting/20260730-2210 it returned **7/7 pass** — on a demo whose
 * review dashboard was analytically dead (#1160) and whose walkthrough scored
 * concept 2.0/5, user 1.0/5, arc 1.0/5 with 21 findings.
 *
 * All six checks inspected the HANDOFF: realized.json shape, a URL matched
 * against a regex, plan↔handoff key agreement, an integer, a date, manifest
 * sections. **None fetched a par_url and looked at what it renders.** A regex
 * cannot tell a real run from a fabricated id.
 *
 * #1037's half: check 2 required `&opportunity_id=` on EVERY dashboard, while
 * demo-data-setup Step 4 requires `&program_id=` for program-owned rollups —
 * so a correctly-built `program_admin_report` failed its own QA gate, and the
 * only way to pass was to emit a URL verified 404 ("Workflow definition 5040
 * not found").
 */
import { describe, it, expect } from 'vitest';

import {
  checkParUrlScope,
  checkParUrlPayloadPopulated,
  checkInteractiveRunsLive,
  formatPayloadReport,
} from '../../../skills/demo-data-setup-qa/checks';

describe('checkParUrlScope — ownership decides the scope param (#1037)', () => {
  const base = 'https://labs.connect.dimagi.com/labs/workflow/5040/run/?run_id=5048';

  it('accepts &program_id= on a program-owned rollup', () => {
    const r = checkParUrlScope([
      { key: 'audit', template: 'program_admin_report', par_url: `${base}&program_id=10037` },
    ]);
    expect(r.pass).toBe(true);
  });

  it('REJECTS &opportunity_id= on a program-owned rollup — the verified-404 shape', () => {
    const r = checkParUrlScope([
      { key: 'audit', template: 'program_admin_report', par_url: `${base}&opportunity_id=10037` },
    ]);
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/program_id/);
  });

  it('accepts &opportunity_id= on an opp-owned dashboard', () => {
    const r = checkParUrlScope([
      { key: 'scorecard', template: 'llo_weekly_review', par_url: `${base}&opportunity_id=10039` },
    ]);
    expect(r.pass).toBe(true);
  });

  it('REJECTS &program_id= on an opp-owned dashboard (the mirror error)', () => {
    const r = checkParUrlScope([
      { key: 'scorecard', template: 'llo_weekly_review', par_url: `${base}&program_id=10039` },
    ]);
    expect(r.pass).toBe(false);
  });

  it('still rejects a URL with no run_id at all', () => {
    const r = checkParUrlScope([
      { key: 'x', template: 'llo_weekly_review',
        par_url: 'https://labs.connect.dimagi.com/labs/workflow/5040/run/?opportunity_id=10039' },
    ]);
    expect(r.pass).toBe(false);
  });
});

describe('checkParUrlPayloadPopulated — look at what the page renders (#1161)', () => {
  /** #1160's defect 3: pipeline_sources declared, snapshot has none. */
  const DEAD_SNAPSHOT = {
    definition: { pipeline_sources: { performance_data: 5068 } },
    instance: { status: 'completed', snapshot: { pipelines: [] } },
  };

  /** #1160's defects 1+2: rows exist but every bound field is 0/null. */
  const DEAD_FIELDS = {
    definition: { pipeline_sources: { flw_kpis: 5065 } },
    instance: {
      status: 'completed',
      snapshot: {
        pipelines: [
          { alias: 'flw_kpis', rows: [
            { username: 'ibrahim', visit_count: 0, app_version: null },
            { username: 'blessing', visit_count: 0, app_version: null },
          ] },
        ],
      },
    },
  };

  const HEALTHY = {
    definition: { pipeline_sources: { flw_kpis: 5065 } },
    instance: {
      status: 'completed',
      snapshot: {
        pipelines: [
          { alias: 'flw_kpis', rows: [
            { username: 'ibrahim', completed_visits: 128, mean_ppi_score: 38.0 },
            { username: 'blessing', completed_visits: 131, mean_ppi_score: 37.3 },
          ] },
        ],
      },
    },
  };

  it('fails when pipeline_sources is declared but the snapshot holds no pipelines', () => {
    const r = checkParUrlPayloadPopulated(DEAD_SNAPSHOT);
    expect(r.pass).toBe(false);
    expect(r.findings.map((f) => f.kind)).toContain('snapshot-missing-pipelines');
  });

  it('fails when a bound field is uniformly zero/null across every row', () => {
    const r = checkParUrlPayloadPopulated(DEAD_FIELDS);
    expect(r.pass).toBe(false);
    const dead = r.findings.filter((f) => f.kind === 'field-all-null');
    expect(dead.map((f) => f.field).sort()).toEqual(['app_version', 'visit_count']);
  });

  it('passes a populated dashboard', () => {
    const r = checkParUrlPayloadPopulated(HEALTHY);
    expect(r.findings).toEqual([]);
    expect(r.pass).toBe(true);
  });

  it('does not flag a legitimately-zero field when SOME row is non-zero', () => {
    // Precision: a real zero for one worker is data, not a dead binding.
    const mixed = JSON.parse(JSON.stringify(HEALTHY));
    mixed.instance.snapshot.pipelines[0].rows[0].completed_visits = 0;
    expect(checkParUrlPayloadPopulated(mixed).pass).toBe(true);
  });

  it('does not flag an identifier-ish column that is legitimately uniform', () => {
    // `username` is never all-null here; guard against flagging string columns
    // that simply repeat — only null/zero counts as dead.
    const repeated = JSON.parse(JSON.stringify(HEALTHY));
    repeated.instance.snapshot.pipelines[0].rows.forEach((r: Record<string, unknown>) => {
      r.opportunity = 'hh-poverty-targeting';
    });
    expect(checkParUrlPayloadPopulated(repeated).pass).toBe(true);
  });

  it('names the alias and field so the fix is obvious', () => {
    const text = formatPayloadReport(checkParUrlPayloadPopulated(DEAD_FIELDS));
    expect(text).toMatch(/flw_kpis/);
    expect(text).toMatch(/visit_count/);
  });
});

/**
 * dimagi-internal/ace#1162 — the interactive run must still be interactive
 * when the camera arrives.
 *
 * Phase 7 completed BOTH workflow runs (5071, 5072) at 2026-08-01T01:12Z,
 * ~14 minutes before the render at ~01:26Z. Completing is how a par_url
 * becomes a stable idempotent deep-link, so it is right for most dashboards
 * — but workflow 5069's render code has a `completed` branch that prints
 * "This run is completed… Decisions are read-only" and DISABLES the status
 * dropdown. The narrative's payoff scene is a reviewer taking a decision, so
 * the payoff was structurally unperformable: all 10 spec actions degraded to
 * wait_for/hold, 7 scenes produced 2 distinct images, arc scored 1.0/5.
 *
 * Option 1 (Jon, 2026-08-14): leave ONLY the review-action dashboard's run
 * in_progress; complete every other run as today. `source.dashboards[].role`
 * already carries the signal, so this is checkable from the handoff plus the
 * payload the QA step already fetches.
 *
 * The check is deliberately two-sided. Firing only on "interactive run was
 * completed" would let the opposite sloppiness through — every run left
 * in_progress, which silently gives up snapshot stability on links a
 * stakeholder keeps.
 */
describe('checkInteractiveRunsLive (#1162)', () => {
  const live = { instance: { status: 'in_progress' } };
  const done = { instance: { status: 'completed' } };

  it('fails when a review-action dashboard’s run is completed — the #1162 repro', () => {
    const r = checkInteractiveRunsLive([
      { dashboard: { key: 'program_admin', template: 'program_admin_report', par_url: 'u', role: 'overview' }, payload: done },
      { dashboard: { key: 'llo_review', template: 'llo_weekly_review', par_url: 'u', role: 'review-action' }, payload: done },
    ]);
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/llo_review/);
    expect(r.detail).toMatch(/read-only/i);
    expect(r.auto_fix_hint).toMatch(/in_progress/);
  });

  it('passes the option-1 shape: the review-action run live, every other run completed', () => {
    const r = checkInteractiveRunsLive([
      { dashboard: { key: 'program_admin', template: 'program_admin_report', par_url: 'u', role: 'overview' }, payload: done },
      { dashboard: { key: 'child_recovery', template: 'sam_followup', par_url: 'u', role: 'recovery' }, payload: done },
      { dashboard: { key: 'llo_review', template: 'llo_weekly_review', par_url: 'u', role: 'review-action' }, payload: live },
    ]);
    expect(r.pass).toBe(true);
  });

  it('fails the opposite sloppiness: a non-interactive run left in_progress loses snapshot stability', () => {
    const r = checkInteractiveRunsLive([
      { dashboard: { key: 'program_admin', template: 'program_admin_report', par_url: 'u', role: 'overview' }, payload: live },
    ]);
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/program_admin/);
    expect(r.detail).toMatch(/snapshot/i);
  });

  it('treats role spelling variants as the same role', () => {
    for (const role of ['review-action', 'review_action', 'Review-Action', 'decision']) {
      expect(checkInteractiveRunsLive([{ dashboard: { key: 'k', template: 't', par_url: 'u', role }, payload: done }]).pass).toBe(false);
    }
  });

  it('is silent on a dashboard whose payload carries no status — it judges what it can see', () => {
    const r = checkInteractiveRunsLive([
      { dashboard: { key: 'llo_review', template: 'llo_weekly_review', par_url: 'u', role: 'review-action' }, payload: {} },
    ]);
    expect(r.pass).toBe(true);
    expect(r.detail).toMatch(/unknown/i);
  });

  it('passes vacuously on an empty dashboard list', () => {
    expect(checkInteractiveRunsLive([]).pass).toBe(true);
  });
});

// ── #1658 ──────────────────────────────────────────────────────────

/**
 * Check 9's two defects, measured on `bednet-check-2-visit`:
 *
 *  - `20260817-1720` passed check 9 with `conditionalFields: []` and the
 *    justification "no conditional blocks", while the app returned two
 *    `relevant` expressions. `20260825-1310`, same app + generator, declared
 *    them and measured 18 of 276 off-branch on each. The spec — not the data
 *    — decided the verdict, so the spec must be derived, and a run with no
 *    derivation behind it must not pass.
 *  - The auto-fix hint sent the author to a manifest knob that does not exist
 *    (`BeneficiaryCohort` has no conditional/relevant primitive), making the
 *    check unpassable for any gated form. The hint now names the scrub.
 */
import { checkDatasetObeysPddConstraints } from '../../../skills/demo-data-setup-qa/checks';
import type { ConstraintReport } from '../../../lib/dataset-constraints';

const CLEAN_REPORT: ConstraintReport = { ok: true, total: 276, violations: [] };
const DERIVED = { unparsed: [], questionsSeen: 4, gatesParsed: 2 };

describe('checkDatasetObeysPddConstraints (#1658)', () => {
  it('passes a measured zero over a spec that was actually derived', () => {
    const r = checkDatasetObeysPddConstraints({ derivation: DERIVED, report: CLEAN_REPORT });
    expect(r.pass).toBe(true);
    expect(r.detail).toMatch(/spec derived from 4 question/);
  });

  it('FAILS a clean audit that has no derivation behind it — the false-green shape', () => {
    const r = checkDatasetObeysPddConstraints({ derivation: null, report: CLEAN_REPORT });
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/no spec derivation/);
    expect(r.auto_fix_hint).toMatch(/specFromDeliverApp/);
  });

  it('accepts a stated no-deliver-app reason (the denovo provider)', () => {
    const r = checkDatasetObeysPddConstraints({
      derivation: null,
      noDeliverAppReason: 'provider denovo — labs-only opp 10046 has no deliver app',
      report: CLEAN_REPORT,
    });
    expect(r.pass).toBe(true);
  });

  it('FAILS when the app returned no questions — an empty spec measures an empty zero', () => {
    const r = checkDatasetObeysPddConstraints({
      derivation: { unparsed: [], questionsSeen: 0, gatesParsed: 0 },
      report: CLEAN_REPORT,
    });
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/0 questions/);
  });

  it('reports an unparsed relevant expression instead of passing silently', () => {
    const r = checkDatasetObeysPddConstraints({
      derivation: {
        unparsed: [
          {
            kind: 'relevant',
            field: 'slept_under_net',
            path: '/data/net_check/slept_under_net',
            expression: "selected(/data/agree_again/consent_confirmed, 'yes')",
            reason: 'not an equality',
          },
        ],
        questionsSeen: 4,
        gatesParsed: 1,
      },
      report: CLEAN_REPORT,
    });
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/were NOT audited/);
    expect(r.detail).toMatch(/selected\(/);
    expect(r.auto_fix_hint).toMatch(/ADDITION/);
  });

  it('reports a field the scrub could never locate', () => {
    const r = checkDatasetObeysPddConstraints({
      derivation: DERIVED,
      scrub: { records: 276, fields: [], totalCleared: 0, unresolvedFields: ['slept_under_net'] },
      report: CLEAN_REPORT,
    });
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/could not locate slept_under_net/);
  });

  it('fails on violations and hints at the scrub, NOT at the manifest knob that does not exist', () => {
    const r = checkDatasetObeysPddConstraints({
      derivation: DERIVED,
      report: {
        ok: false,
        total: 276,
        violations: [
          { kind: 'conditional-off-branch', field: 'slept_under_net', count: 18, detail: 'off branch' },
          { kind: 'conditional-off-branch', field: 'net_visibly_hanging', count: 18, detail: 'off branch' },
        ],
      },
    });
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/18 of 276/);
    expect(r.auto_fix_hint).toMatch(/scrubOffBranchFields/);
    // The impossible remedy must not come back: there is no manifest-side
    // conditional primitive, so a hint that demands one is unsatisfiable.
    expect(r.auto_fix_hint).not.toMatch(/regenerate with the constraint applied at the manifest/i);
    expect(r.auto_fix_hint).toMatch(/no manifest-side remedy/i);
  });
});
