/**
 * Dashboard defects the DDD loop FOUND but could not FIX, reported as their own
 * Phase 7 outcome: `found_not_fixed` (ace#2337).
 *
 * Under `/ace:run` the canopy DDD loop's write path is the unified spec
 * (narration + recipe) only. The labs report pages ACE Phase 7 authors are
 * deployed templates whose `render_code` lives in the connect-labs database, so
 * `config/ddd-loop.yaml` pinned them out of the loop's edit scope as the
 * `labs-report-template` fixed surface (until 2026-10-16; see DASHBOARD_SURFACES
 * for what is still out). A defect on one of those pages is
 * rediscovered every pass and never applied, and before this module it reached
 * the write-back folded into `stopped_not_converged` — which a reader takes to
 * mean "the demo is bad", when it means "the fixer cannot reach that surface".
 * Opposite conclusions, opposite remedies (a better narrative vs. a dashboard edit).
 *
 * Operator decision (Jonathan, 2026-10-16): report them as their own explicit
 * status, "found, not fixed", with which dashboard and what defect.
 *
 * Input: the canopy DDD run's `run_state.yaml`, parsed. canopy stamps every
 * finding's edit scope (`scripts/ddd/floor.py` `scope_detail`): an out-of-scope
 * finding carries `edit_scope: out` plus `surface` / `owner` / `issue` when a
 * configured fixed surface matched it. A cell held only by such findings is
 * `pinned` in `cell_floor.cells[].blocked_by`. Both are read; a finding is
 * counted once, by `finding_id`.
 *
 * Pure.
 */

/**
 * The `config/ddd-loop.yaml` fixed surfaces that hold a dashboard defect the
 * loop cannot apply. Since 2026-10-16 the report PAGES are in scope (ACE's Labs
 * template workflows, lib/labs-report-templates.ts); what stays out is a figure
 * Labs does not compute (`labs-engine`) and the registry's own labels
 * (`labs-semantic-registry`). `labs-report-template` stays listed so a DDD run
 * stamped by the earlier config still reads correctly.
 */
export const DASHBOARD_SURFACES: readonly string[] = ['labs-engine', 'labs-semantic-registry', 'labs-report-template'];

/** Phase 7's own outcome for a loop that ended with unapplied dashboard defects. */
export const FOUND_NOT_FIXED = 'found_not_fixed';

export interface UnappliedDashboardFinding {
  finding_id: string | null;
  scene: string | null;
  dimension: string | null;
  /** The page the scene films, when the caller passed the spec's scene URLs. */
  dashboard_url: string | null;
  surface: string;
  owner: string | null;
  issue: string | null;
  /** What is wrong, in the judge's words (fix_recommendation, else detail), ≤ 240 chars. */
  defect: string;
  /** True when this finding alone holds a below-bar cell (the loop could not move it). */
  pinned: boolean;
}

export interface Phase7DddOutcome {
  /** canopy's `terminal_status`, verbatim — never rewritten. */
  ddd_terminal_status: string | null;
  /** What Phase 7 reports: `found_not_fixed`, or the terminal status unchanged. */
  outcome: string | null;
  /** `phases.synthetic-data-and-workflows.verdict`. */
  verdict: string;
  unapplied_dashboard_findings: UnappliedDashboardFinding[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : typeof v === 'number' ? String(v) : null);

/** canopy's scene key: `6`, `"6"`, `scene_6` → `"6"` (1-based, `scripts/ddd/floor.py` `_scene_key`). */
function sceneKey(raw: unknown): string | null {
  const m = /^\s*(?:scene[_ ]?)?(\d+)/i.exec(String(raw ?? ''));
  return m ? String(Number(m[1])) : null;
}

/**
 * `{ "<1-based scene>": url }` from a unified spec's `scenes`. A scene with no
 * `url` is on the previous scene's page (same rule as
 * `lib/narration-on-screen.ts` `narrationClaimsBySurface`).
 */
export function sceneUrlsFromSpec(spec: unknown): Record<string, string> {
  const scenes = isObj(spec) && Array.isArray(spec.scenes) ? spec.scenes : [];
  const out: Record<string, string> = {};
  let current: string | null = null;
  scenes.forEach((s, i) => {
    const url = isObj(s) ? str(s.url) : null;
    if (url) current = url;
    if (current) out[String(i + 1)] = current;
  });
  return out;
}

function dashboardSurface(f: Obj): string | null {
  if (String(f.edit_scope ?? '').toLowerCase() !== 'out') return null;
  const surface = str(f.surface);
  if (surface && DASHBOARD_SURFACES.includes(surface)) return surface;
  // A finding a fixer declined (out_of_scope.json) may carry the surface only in its reason.
  const reason = str(f.edit_scope_reason) ?? '';
  return DASHBOARD_SURFACES.find((s) => reason.includes(s)) ?? null;
}

export function unappliedDashboardFindings(
  dddState: unknown,
  sceneUrls: Readonly<Record<string, string>> = {},
): UnappliedDashboardFinding[] {
  if (!isObj(dddState)) return [];
  const pinnedIds = new Set<string>();
  const cellFloor = isObj(dddState.cell_floor) ? dddState.cell_floor : {};
  for (const c of Array.isArray(cellFloor.cells) ? cellFloor.cells : []) {
    if (!isObj(c) || c.status !== 'pinned') continue;
    for (const b of Array.isArray(c.blocked_by) ? c.blocked_by : []) {
      const id = isObj(b) ? str(b.finding_id) : null;
      if (id) pinnedIds.add(id);
    }
  }
  const out: UnappliedDashboardFinding[] = [];
  const seen = new Set<string>();
  for (const f of Array.isArray(dddState.findings) ? dddState.findings : []) {
    if (!isObj(f)) continue;
    const surface = dashboardSurface(f);
    if (!surface) continue;
    const id = str(f.finding_id);
    const defect = (str(f.fix_recommendation) ?? str(f.detail) ?? '').slice(0, 240);
    const key = id ?? `${f.scene}|${defect}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const scene = sceneKey(f.scene);
    out.push({
      finding_id: id,
      scene,
      dimension: str(f.dimension),
      dashboard_url: scene ? sceneUrls[scene] ?? null : null,
      surface,
      owner: str(f.owner),
      issue: str(f.issue),
      defect,
      pinned: Boolean(id && pinnedIds.has(id)) || f.pinned === true,
    });
  }
  return out;
}

/**
 * Phase 7's reading of the loop's ending. `converged_clean` stays `pass` even
 * with unapplied dashboard findings below the bar (they are still recorded): the
 * loop met its bar. Any other ending WITH unapplied dashboard findings reports
 * `found_not_fixed`; without them, the terminal status is reported unchanged.
 */
export function phase7DddOutcome(
  dddState: unknown,
  sceneUrls: Readonly<Record<string, string>> = {},
): Phase7DddOutcome {
  const terminal = isObj(dddState) ? str(dddState.terminal_status) : null;
  const unapplied = unappliedDashboardFindings(dddState, sceneUrls);
  if (terminal === 'converged_clean') {
    return { ddd_terminal_status: terminal, outcome: terminal, verdict: 'pass', unapplied_dashboard_findings: unapplied };
  }
  const outcome = unapplied.length ? FOUND_NOT_FIXED : terminal;
  return {
    ddd_terminal_status: terminal,
    outcome,
    verdict: `partial-ddd-${outcome ?? 'unknown'}`,
    unapplied_dashboard_findings: unapplied,
  };
}
