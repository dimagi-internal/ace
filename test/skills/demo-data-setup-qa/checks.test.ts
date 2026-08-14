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
