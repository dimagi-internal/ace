import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DASHBOARD_SURFACES,
  FOUND_NOT_FIXED,
  phase7DddOutcome,
  sceneUrlsFromSpec,
  unappliedDashboardFindings,
} from '../../lib/ddd-unapplied-findings.js';

// Real findings from the 2026-10-15 ACE DDD runs; `expect` names the
// config/ddd-loop.yaml fixed surface each one matched.
const REAL = JSON.parse(
  readFileSync(join(__dirname, '..', 'fixtures', 'ddd-loop-config', 'findings.json'), 'utf8'),
).findings as Array<Record<string, unknown>>;

/** A canopy DDD run_state as the loop leaves it: findings stamped with their edit scope. */
function dddState(terminal: string) {
  const findings = REAL.map((f, i) => {
    const out = f.expect !== 'in';
    return {
      finding_id: `f${i}`,
      scene: `scene_${(i % 4) + 1}`,
      dimension: 'visual_polish',
      detail: f.detail,
      fix_recommendation: f.fix_recommendation,
      edit_scope: out ? 'out' : 'in',
      ...(out ? { surface: f.expect, owner: 'ACE Phase 7 (labs report templates)', issue: 'dimagi-internal/ace#2337' } : {}),
    };
  });
  const firstDashboard = findings.find((f) => DASHBOARD_SURFACES.includes(String(f.surface)))!;
  return {
    terminal_status: terminal,
    findings,
    cell_floor: {
      cells: [{ key: '1::visual_polish', status: 'pinned', blocked_by: [{ finding_id: firstDashboard.finding_id }] }],
    },
  };
}

const isDashboard = (s: unknown) => DASHBOARD_SURFACES.includes(String(s));
const dashboardCount = REAL.filter((f) => isDashboard(f.expect)).length;

describe('found, not fixed (ace#2337)', () => {
  it('the fixture carries real dashboard findings and real in-scope controls', () => {
    expect(dashboardCount).toBeGreaterThan(0);
    expect(REAL.some((f) => f.expect === 'in')).toBe(true);
    expect(REAL.some((f) => f.expect !== 'in' && !isDashboard(f.expect))).toBe(true);
  });

  it('a stopped loop with unapplied dashboard defects reports found_not_fixed, not stopped_not_converged', () => {
    const r = phase7DddOutcome(dddState('stopped_not_converged'));
    expect(r.outcome).toBe(FOUND_NOT_FIXED);
    expect(r.verdict).toBe('partial-ddd-found_not_fixed');
    expect(r.ddd_terminal_status).toBe('stopped_not_converged'); // canopy's status kept verbatim
    expect(r.unapplied_dashboard_findings).toHaveLength(dashboardCount);
  });

  it('records which dashboard and what defect, and only the dashboard surface', () => {
    const urls = sceneUrlsFromSpec({ scenes: [{ url: 'https://labs/p/1' }, {}, { url: 'https://labs/p/3' }, {}] });
    const rows = unappliedDashboardFindings(dddState('stopped_not_converged'), urls);
    expect(rows.every((r) => isDashboard(r.surface))).toBe(true);
    expect(rows.every((r) => r.defect.length > 0 && r.defect.length <= 240)).toBe(true);
    expect(rows.every((r) => r.issue === 'dimagi-internal/ace#2337')).toBe(true);
    const byScene = Object.fromEntries(rows.map((r) => [r.scene, r.dashboard_url]));
    expect(byScene['2']).toBe('https://labs/p/1'); // follow-on scene inherits the page
    expect(byScene['4']).toBe('https://labs/p/3');
    expect(rows.filter((r) => r.pinned)).toHaveLength(1);
  });

  it('without unapplied dashboard defects the terminal status passes through unchanged', () => {
    const state = dddState('stopped_not_converged');
    state.findings = state.findings.filter((f) => !isDashboard(f.surface));
    const r = phase7DddOutcome(state);
    expect(r.outcome).toBe('stopped_not_converged');
    expect(r.verdict).toBe('partial-ddd-stopped_not_converged');
    expect(r.unapplied_dashboard_findings).toEqual([]);
  });

  it('converged_clean stays pass but still records what was left unapplied', () => {
    const r = phase7DddOutcome(dddState('converged_clean'));
    expect(r.verdict).toBe('pass');
    expect(r.outcome).toBe('converged_clean');
    expect(r.unapplied_dashboard_findings).toHaveLength(dashboardCount);
  });

  it('the phase doc runs the helper and writes the status distinctly', () => {
    const doc = readFileSync(join(__dirname, '..', '..', 'agents', 'synthetic-data-and-workflows.md'), 'utf8');
    expect(doc).toContain('scripts/ddd-unapplied-findings.ts');
    expect(doc).toContain('partial-ddd-found_not_fixed');
    expect(doc).toContain('unapplied_dashboard_findings');
  });
});
