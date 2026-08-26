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
import type {
  ConstraintReport,
  ScrubReport,
  UnparsedExpression,
} from '../../lib/dataset-constraints';

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

export type PayloadFindingKind =
  | 'snapshot-missing-pipelines'
  | 'field-all-null'
  | 'live-pipelines-unavailable';

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

export interface SnapshotPipeline {
  alias?: string;
  rows?: Record<string, unknown>[];
}

export interface WorkflowPayload {
  definition?: { pipeline_sources?: Record<string, unknown> | Array<{ alias?: string; [k: string]: unknown }> };
  instance?: {
    status?: string;
    /**
     * `pipelines` arrives in EITHER shape (ace#1701):
     *   - a dict keyed by alias — what labs actually writes today
     *     (`connect_labs/workflow/templates/__init__.py`:
     *      `out["pipelines"] = {alias: pipelines[alias] ...}`)
     *   - an array of `{alias, rows}` — the shape this check was written for.
     */
    snapshot?: { pipelines?: SnapshotPipeline[] | Record<string, SnapshotPipeline> };
  };
}

/**
 * Both snapshot shapes, as one array (ace#1701).
 *
 * Reading only the array shape made this check throw `pipelines is not
 * iterable` on every real completed run, and made the
 * `snapshot-missing-pipelines` branch unreachable besides — a dict has no
 * `.length`, and `undefined === 0` is false. Check 7 exists so that a dead
 * dashboard cannot reach a stakeholder (#1161); it could not see one.
 */
export function normalizeSnapshotPipelines(
  pipelines: SnapshotPipeline[] | Record<string, SnapshotPipeline> | undefined,
): SnapshotPipeline[] {
  if (!pipelines) return [];
  if (Array.isArray(pipelines)) return pipelines;
  return Object.entries(pipelines).map(([alias, value]) => ({ alias, ...(value ?? {}) }));
}

/** `pipeline_sources` is a dict of alias->id in the stored definition and an array of {alias,...} on the run page. */
function declaredAliases(sources: WorkflowPayload['definition'] extends infer D ? any : never): string[] {
  if (!sources) return [];
  if (Array.isArray(sources)) {
    return sources.map((s: { alias?: string }) => String(s?.alias ?? '')).filter(Boolean);
  }
  return Object.keys(sources);
}

/** Null, undefined, empty string, or numeric zero — the shapes a dead binding produces. */
function isDeadValue(v: unknown): boolean {
  return v === null || v === undefined || v === '' || v === 0;
}

/**
 * labs' own row columns, which every pipeline row carries whether or not the
 * terminal stage fills them (ace#1701).
 *
 * Whether one of these is populated is decided by `terminal_stage`, not by the
 * schema: WORKFLOW_REFERENCE § "Built-in Row Fields" gives `visit_level` rows
 * `username / visit_date / entity_id / entity_name` and `aggregated` rows the
 * `*_visits` counters and `first/last_visit_date`, and the `entity` stage
 * "drops the status/flagged counters because they're visit-level facts". So a
 * built-in that is null for every row is NOT evidence of a wrong schema path —
 * and it fires on every entity-stage and visit-level pipeline. Measured on
 * run 5258 (healthy, `pipeline_preview` `fields_all_null: []`): 15 findings,
 * all built-ins, none a schema path.
 *
 * #1160's real defect is not one of these: that was render code binding the
 * denormalized `worker.visit_count`, not a pipeline column.
 */
const LABS_BUILTIN_ROW_COLUMNS = new Set([
  'id', 'username', 'visit_date', 'entity_id', 'entity_name', 'status', 'flagged',
  'opportunity_id', 'days_active', 'total_visits', 'approved_visits', 'pending_visits',
  'rejected_visits', 'flagged_visits', 'first_visit_date', 'last_visit_date',
]);

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
/**
 * @param livePipelines Rows for a run that is deliberately still `in_progress`
 *   (the `review-action` dashboard check 8 requires to stay live, #1162). Such
 *   a run has no snapshot BY DESIGN, and the server-rendered `#workflow-data`
 *   carries `pipeline_data: {}` because the page fills it over SSE after
 *   mount — so the caller fetches
 *   `GET /labs/workflow/api/<def>/pipeline-data/?opportunity_id=<opp>` and
 *   passes the result here. Absence is a reported finding, never a silent pass.
 */
export function checkParUrlPayloadPopulated(
  payload: WorkflowPayload,
  livePipelines?: SnapshotPipeline[] | Record<string, SnapshotPipeline>,
): PayloadReport {
  const findings: PayloadFinding[] = [];
  const declared = declaredAliases(payload?.definition?.pipeline_sources);
  const completed = payload?.instance?.status === 'completed';

  const live = normalizeSnapshotPipelines(
    livePipelines ?? (payload as { pipeline_data?: Record<string, SnapshotPipeline> })?.pipeline_data,
  );
  const pipelines = completed
    ? normalizeSnapshotPipelines(payload?.instance?.snapshot?.pipelines)
    : live;

  if (declared.length > 0 && pipelines.length === 0) {
    findings.push({
      kind: completed ? 'snapshot-missing-pipelines' : 'live-pipelines-unavailable',
      detail: completed
        ? `definition declares pipeline_sources (${declared.join(', ')}) but the run snapshot holds no ` +
          `pipelines — the page renders no pipeline data at all. Declare snapshot_inputs.pipelines ` +
          `covering every alias in pipeline_sources before completing the run.`
        : `this run is '${payload?.instance?.status ?? 'unknown'}', so it has no snapshot by design ` +
          `(#1162) — and no live pipeline rows were supplied for ${declared.join(', ')}, so nothing ` +
          `was judged. Fetch GET /labs/workflow/api/<definition_id>/pipeline-data/?opportunity_id=<opp> ` +
          `and pass it as livePipelines.`,
    });
  }

  for (const p of pipelines) {
    const rows = p.rows ?? [];
    if (rows.length === 0) continue;
    const columns = new Set<string>();
    for (const r of rows) for (const k of Object.keys(r)) columns.add(k);
    for (const field of columns) {
      if (LABS_BUILTIN_ROW_COLUMNS.has(field)) continue;
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

// ── #1658: check 9's spec is DERIVED, and its auto-fix is one that exists ──

/**
 * Check 9 (`dataset_obeys_pdd_constraints`) as a pure function.
 *
 * Two defects it closes, both measured on `bednet-check-2-visit` (ace#1658):
 *
 * 1. **The spec was author-supplied**, so under-declaring it produced a false
 *    green. `20260817-1720` recorded `pass` with `conditionalFields: []` and
 *    the justification "no conditional blocks" — while
 *    `get_opportunity_apps(2214, 'deliver')` returned two `relevant`
 *    expressions verbatim. `20260825-1310`, same opp / app / generator,
 *    declared them and measured 18 of 276 off-branch on each. So the spec now
 *    comes from `specFromDeliverApp`, and this check REFUSES a run that has
 *    no derivation behind it: a `derivation` of `null` is only legal with a
 *    stated reason (the `denovo` provider has no deliver app to read).
 *
 * 2. **The old auto-fix was impossible.** "Regenerate with the constraint
 *    applied at the manifest" names a knob the labs generator does not have —
 *    `BeneficiaryCohort` in
 *    `connect_labs/labs/synthetic/generator/fixtures/manifest.py` carries no
 *    conditional / relevant / branch primitive, and `FieldDistribution.null_rate`
 *    is unconditional. So a gated form could only reach green by narrowing the
 *    spec or hand-patching records. The hint now points at
 *    `scrubOffBranchFields` — a declared, reproducible, idempotent generator
 *    post-step.
 *
 * An unparsed `relevant` is a FINDING, not a silent pass: an expression the
 * derivation could not read is a gate this check cannot prove was audited.
 */
export interface DatasetConstraintCheckInput {
  /**
   * `specFromDeliverApp(get_opportunity_apps(<opp>, 'deliver'))`, or `null`
   * when the demo has no deliver app to derive from.
   */
  derivation: { unparsed: UnparsedExpression[]; questionsSeen: number; gatesParsed: number } | null;
  /** Required when `derivation` is null — why no app was read (e.g. provider `denovo`). */
  noDeliverAppReason?: string;
  /** The scrub actually applied to the fixture before the dashboards read it. */
  scrub?: ScrubReport;
  /** `auditDataset` over the records as they now stand. */
  report: ConstraintReport;
}

const SCRUB_HINT =
  'Re-run the branch scrub, do not narrow the spec: scrubOffBranchFields(records, spec.conditionalFields) ' +
  'from lib/dataset-constraints.ts, then write the scrubbed user_visits.json back to the opp\'s fixture ' +
  'folder BEFORE any dashboard run is minted, and record the per-field counts in the run summary. There is ' +
  'no manifest-side remedy: the labs generator has no conditional/relevant primitive, so a gated form ' +
  'always draws off-branch values (dimagi-internal/ace#1658).';

export function checkDatasetObeysPddConstraints(input: DatasetConstraintCheckInput): QACheckResult {
  const problems: string[] = [];
  const hints: string[] = [];

  if (!input.derivation) {
    if (!input.noDeliverAppReason?.trim()) {
      problems.push(
        'no spec derivation and no stated reason — the spec would be hand-declared from prose, which is ' +
          'the false-green shape this check exists to close',
      );
      hints.push(
        'derive the spec with specFromDeliverApp(get_opportunity_apps(<connect opp>, \'deliver\')); if this ' +
          'demo genuinely has no deliver app (provider denovo), state that as noDeliverAppReason.',
      );
    }
  } else if (input.derivation.questionsSeen === 0) {
    problems.push(
      'the deliver app returned 0 questions, so conditionalFields / integerFields were derived from nothing',
    );
    hints.push(
      're-fetch get_opportunity_apps(<connect opp>, \'deliver\') and confirm deliver_app is non-null before ' +
        'auditing; an empty app derives an empty spec, and an empty spec measures zero violations.',
    );
  }

  const unparsed = input.derivation?.unparsed ?? [];
  if (unparsed.length > 0) {
    problems.push(
      `${unparsed.length} expression(s) could not be derived into the spec, so those gates were NOT audited: ` +
        unparsed.map((u) => `${u.field} [${u.kind}] ${u.expression}`).join('; '),
    );
    hints.push(
      'hand-declare each unparsed gate as an ADDITION (mergeDatasetSpecs(derived, additions)) — never as a ' +
        'replacement for the derived spec — then re-run the scrub and the audit.',
    );
  }

  if (input.scrub?.unresolvedFields.length) {
    problems.push(
      `the branch scrub could not locate ${input.scrub.unresolvedFields.join(', ')} in any record, so those ` +
        'fields were never scrubbed',
    );
    hints.push(
      'check the fixture nesting against the app XPath — the scrub resolves a field by XPath suffix, and a ' +
        'field it cannot find is reported rather than silently counted as clean.',
    );
  }

  if (!input.report.ok) {
    problems.push(
      `${input.report.violations.length} constraint class(es) violated across ${input.report.total} records: ` +
        input.report.violations.map((v) => `[${v.kind}] ${v.count} of ${input.report.total} — ${v.field}`).join('; '),
    );
    hints.push(SCRUB_HINT);
  }

  if (problems.length === 0) {
    const derivedNote = input.derivation
      ? `spec derived from ${input.derivation.questionsSeen} question(s), ${input.derivation.gatesParsed} gate(s)`
      : `no deliver app (${input.noDeliverAppReason})`;
    const scrubNote = input.scrub
      ? `; branch scrub cleared ${input.scrub.totalCleared} off-branch value(s)`
      : '';
    return {
      pass: true,
      detail: `0 violations across ${input.report.total} records (measured) — ${derivedNote}${scrubNote}`,
    };
  }

  return { pass: false, detail: problems.join('; '), auto_fix_hint: hints.join(' ') };
}
