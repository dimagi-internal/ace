/**
 * Static QA checks for `demo-data-setup-qa`, promoted to importable TS.
 *
 * Why these two exist (dimagi-internal/ace#1161, absorbing #1037):
 *
 * The skill's stated job, per `lib/artifact-manifest.ts`, is that "a dead
 * dashboard must not reach a stakeholder". Run against
 * hh-poverty-targeting/20260730-2210 it returned **7/7 pass** on a demo whose
 * review dashboard was analytically dead (#1160) and whose walkthrough scored
 * concept 2.0/5, user 1.0/5, arc 1.0/5. Every check inspected the HANDOFF —
 * realized.json's shape, a URL against a regex, plan↔handoff key agreement, an
 * integer, a date. None fetched a `par_url` and looked at what it renders, and
 * a regex cannot tell a real run from a fabricated id.
 *
 * The other half (#1037): check 2 demanded `&opportunity_id=` on every
 * dashboard while `demo-data-setup` Step 4 requires `&program_id=` for
 * program-owned rollups — so a correctly-built `program_admin_report` failed
 * its own gate, and the only URL that passed was one verified to render
 * "Workflow definition 5040 not found". Scope is now tied to OWNERSHIP, which
 * turns a contradiction into a check that catches the real defect.
 *
 * Both are pure functions over already-fetched data, so they stay inside the
 * QA contract (binary, no LLM, no scores) and are unit-tested directly.
 */

import type { QACheckResult } from '../../lib/qa-types';

/** Templates whose workflows are PROGRAM-owned (cross-opp rollups). */
const PROGRAM_OWNED_TEMPLATES = ['program_admin_report', 'audit_par'];

export interface DashboardRef {
  key: string;
  template: string;
  par_url: string;
  role?: string;
  shape?: string;
}

const RUN_DEEPLINK =
  /^https:\/\/labs\.connect\.dimagi\.com\/labs\/workflow\/\d+\/run\/\?run_id=\d+&(opportunity_id|program_id)=\d+$/;

/**
 * Every `par_url` is a run deep-link AND carries the scope param its
 * dashboard's ownership requires.
 *
 * Live proof both directions matter (workflow 5040 / run 5048 / program 10037):
 * `&program_id=` renders the SOP grid; `&opportunity_id=` returns 200 with body
 * "Workflow definition 5040 not found." A 200 is not evidence — which is why
 * the scope, not just the shape, has to be checked.
 */
export function checkParUrlScope(dashboards: DashboardRef[]): QACheckResult {
  const problems: string[] = [];
  for (const d of dashboards) {
    const m = RUN_DEEPLINK.exec(d.par_url ?? '');
    if (!m) {
      problems.push(
        `${d.key}: not a run deep-link (need /workflow/<id>/run/?run_id=<id>&(opportunity_id|program_id)=<id>) — got ${d.par_url}`,
      );
      continue;
    }
    const scope = m[1];
    const wantsProgram = PROGRAM_OWNED_TEMPLATES.includes(d.template);
    if (wantsProgram && scope !== 'program_id') {
      problems.push(
        `${d.key}: template '${d.template}' is program-owned, so its par_url MUST carry &program_id= — ` +
          `&opportunity_id= 404s it ("Workflow definition not found")`,
      );
    }
    if (!wantsProgram && scope !== 'opportunity_id') {
      problems.push(
        `${d.key}: template '${d.template}' is opp-owned, so its par_url MUST carry &opportunity_id=`,
      );
    }
  }
  if (problems.length === 0) return { pass: true, detail: `${dashboards.length} par_url(s) correctly scoped` };
  return {
    pass: false,
    detail: problems.join('; '),
    auto_fix_hint:
      'rebuild each par_url with the scope its ownership requires: program_admin_report / audit_par → ' +
      '&program_id=<program_id>; every opp-owned dashboard → &opportunity_id=<labs_opp_id>. Both forms ' +
      'return HTTP 200, so verify by fetching and confirming the page renders its grid rather than ' +
      '"Workflow definition <id> not found" (dimagi-internal/ace#1037).',
  };
}

export type PayloadFindingKind = 'snapshot-missing-pipelines' | 'field-all-null';

export interface PayloadFinding {
  kind: PayloadFindingKind;
  alias?: string;
  field?: string;
  detail: string;
}

export interface PayloadReport {
  pass: boolean;
  findings: PayloadFinding[];
}

export interface WorkflowPayload {
  definition?: { pipeline_sources?: Record<string, unknown> };
  instance?: { status?: string; snapshot?: { pipelines?: { alias?: string; rows?: Record<string, unknown>[] }[] } };
}

/** Null, undefined, empty string, or numeric zero — the shapes a dead binding produces. */
function isDeadValue(v: unknown): boolean {
  return v === null || v === undefined || v === '' || v === 0;
}

/**
 * Does the page actually render data? Operates on the parsed `#workflow-data`
 * payload the run page embeds — so the fetch belongs to the caller and the
 * judgement is pure and testable.
 *
 * Two unambiguous shapes, both taken from #1160:
 *  - `pipeline_sources` declared while the snapshot carries no pipelines at all
 *    (workflow 5069 declared `performance_data -> 5068` with
 *    `snapshot_inputs.pipelines: []`, so `pipeline_data` was `[]` live);
 *  - a bound field that is null/zero for EVERY row (pipeline 5068 kept the
 *    stock `performance_review` schema pointed at `form.meta.instanceID`, which
 *    the synthetic generator never writes → `visit_count` 0 for all 8 workers,
 *    beside a chip reading `visits: 835`).
 *
 * A field that is zero for SOME rows is data, not a dead binding — flagging it
 * would make this the always-fires class.
 */
export function checkParUrlPayloadPopulated(payload: WorkflowPayload): PayloadReport {
  const findings: PayloadFinding[] = [];
  const declared = Object.keys(payload?.definition?.pipeline_sources ?? {});
  const pipelines = payload?.instance?.snapshot?.pipelines ?? [];

  if (declared.length > 0 && pipelines.length === 0) {
    findings.push({
      kind: 'snapshot-missing-pipelines',
      detail:
        `definition declares pipeline_sources (${declared.join(', ')}) but the run snapshot holds no ` +
        `pipelines — the page renders no pipeline data at all. Declare snapshot_inputs.pipelines ` +
        `covering every alias in pipeline_sources before completing the run.`,
    });
  }

  for (const p of pipelines) {
    const rows = p.rows ?? [];
    if (rows.length === 0) continue;
    const columns = new Set<string>();
    for (const r of rows) for (const k of Object.keys(r)) columns.add(k);
    for (const field of columns) {
      const allDead = rows.every((r) => isDeadValue(r[field]));
      if (allDead) {
        findings.push({
          kind: 'field-all-null',
          alias: p.alias,
          field,
          detail: `${p.alias ?? 'pipeline'}.${field} is null/zero for all ${rows.length} row(s) — the schema path likely never matches the generated fixtures`,
        });
      }
    }
  }

  return { pass: findings.length === 0, findings };
}

export function formatPayloadReport(report: PayloadReport): string {
  if (report.pass) return 'par_url payload: populated — pipelines present and no uniformly-dead bound field';
  return [
    'par_url payload: the dashboard renders but is analytically DEAD —',
    ...report.findings.map((f) => `  [${f.kind}] ${f.detail}`),
    'A dead dashboard must not reach a stakeholder (lib/artifact-manifest.ts).',
    'Re-point the pipeline schema at the REAL form paths the generator writes, and',
    'declare snapshot_inputs.pipelines for every alias (dimagi-internal/ace#1160/#1161).',
  ].join('\n');
}

// ── #1162: the interactive run must still be interactive at render time ──

/**
 * Roles whose dashboard exists so that someone can ACT on it on camera.
 * Compared after lowercasing and folding `_` to `-`.
 */
const INTERACTIVE_ROLES = new Set(['review-action', 'review', 'decision']);

function isInteractiveRole(role: string | undefined): boolean {
  return INTERACTIVE_ROLES.has((role ?? '').trim().toLowerCase().replace(/_/g, '-'));
}

export interface DashboardPayloadPair {
  dashboard: DashboardRef;
  payload: WorkflowPayload;
}

/**
 * Exactly the review-action run stays `in_progress`; every other run is
 * `completed`.
 *
 * Completing a run is how `par_url` becomes a stable, idempotent deep-link —
 * correct, and what most dashboards want. But it also flips the page
 * read-only: workflow 5069's render code carries a `completed` branch that
 * prints "This run is completed… Decisions are read-only" and disables the
 * status dropdown. On hh-poverty-targeting/20260730-2210 Phase 7 completed
 * BOTH runs ~14 minutes before the render, so the narrative's payoff — a
 * reviewer taking a decision — had nothing to click: all 10 spec actions were
 * wait_for/hold, 7 scenes yielded 2 distinct images, arc 1.0/5 (#1162).
 *
 * Two-sided on purpose. Firing only on the completed-interactive case would
 * accept the opposite failure — everything left in_progress, quietly trading
 * away snapshot stability on links a stakeholder keeps.
 *
 * A payload with no `instance.status` is reported, not failed: an absent field
 * is a fetch-shape question, and a QA gate that fails on what it cannot see is
 * the always-fires class (ace#1026).
 */
export function checkInteractiveRunsLive(pairs: DashboardPayloadPair[]): QACheckResult {
  const problems: string[] = [];
  const unknown: string[] = [];

  for (const { dashboard, payload } of pairs) {
    const status = payload?.instance?.status;
    const interactive = isInteractiveRole(dashboard.role);
    if (!status) {
      unknown.push(`${dashboard.key} (role ${dashboard.role ?? 'unset'})`);
      continue;
    }
    if (interactive && status === 'completed') {
      problems.push(
        `${dashboard.key}: role '${dashboard.role}' is interactive but its run is completed — the page ` +
          `renders "This run is completed… Decisions are read-only" with the status control disabled, so ` +
          `the decision the narrative demonstrates cannot be performed on camera`,
      );
    }
    if (!interactive && status !== 'completed') {
      problems.push(
        `${dashboard.key}: role '${dashboard.role ?? 'unset'}' is non-interactive but its run is ` +
          `'${status}' — only a completed run carries a snapshot, so this par_url is not a stable ` +
          `idempotent deep-link`,
      );
    }
  }

  const unknownNote = unknown.length ? ` (unknown run status, not judged: ${unknown.join(', ')})` : '';
  if (problems.length === 0) {
    return { pass: true, detail: `${pairs.length} dashboard run state(s) match their role${unknownNote}` };
  }
  return {
    pass: false,
    detail: problems.join('; ') + unknownNote,
    auto_fix_hint:
      'Leave ONLY the review-action dashboard\'s run in_progress — skip workflow_save_snapshot for it — ' +
      'and complete every other dashboard\'s run as usual. The interactive dashboard trades snapshot ' +
      'stability for a page the reviewer can actually act on; the rest keep it (dimagi-internal/ace#1162).',
  };
}
