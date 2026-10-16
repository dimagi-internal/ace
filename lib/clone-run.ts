/**
 * lib/clone-run.ts — the pure half of `scripts/clone-run.ts` (ace#3021).
 *
 * `/ace:clone-to-new-workspace` used to be executed by an agent, step by step,
 * and its Connect step re-dispatched the whole Phase 4 agent (evals included):
 * hours of agent time for a copy whose every value is already recorded. Almost
 * nothing in a clone needs judgement — the source run_state carries the app
 * ids and released builds, the program and opportunity, payment units,
 * verification rules and the PDD numbers they came from; the target tenancy is
 * verified in Step 0. So a clone is ONE deterministic, idempotent, resumable
 * script. This module holds everything that can be decided without a network
 * call, so the decisions are unit-tested:
 *
 *  - `cloneSourceFromRunState` — what the source run recorded (transcribed,
 *    never re-derived);
 *  - `connectBuildSpec` — the program / opportunity / payment-unit /
 *    verification / test-user values Connect is re-built with in the target
 *    orgs, each with its provenance;
 *  - `planStages` — which stages a run still has to do, from the TARGET
 *    run_state's `clone:` block (resume);
 *  - `decideCreate` / `lookThenCreate` — the "a timeout is not a failure —
 *    look before retry" rule, as code: a create whose outcome is ambiguous is
 *    recorded `ambiguous`, and the next attempt LOOKS first and refuses to
 *    create blind;
 *  - `checkTenantWrite` — the tenancy guard's semantics for the writes the
 *    script makes outside MCP (where hooks/tenancy_guard.py cannot see them);
 *  - the products / release-summary / summary-url rewrites;
 *  - `rebuildLabs` — the Labs stage: a COPY into the clone's own labs
 *    program (§ 4c, ace#3020), scripted over the labs MCP's HTTP endpoint
 *    (injected `LabsCall`), resumable step by step; it never regenerates.
 *    Only workspace roles have no MCP atom (connect-labs#2572) — that step
 *    rides `scripts/labs-workspace-setup.ts` and alone can be left not-done;
 *  - `STAGE_BUDGETS` / `budgetBreaches` — the per-stage wall-clock guard.
 */

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { parseAppReleaseSummary, releasedBuild } from './app-release-record.js';
import { connectCountryName } from './program-locale.js';
import { labsIdsIn, labsRebuildSource, remapSyntheticProducts } from './clone-labs-rebuild.js';

// ── Stages ────────────────────────────────────────────────────────────

/**
 * The stages, in order. Each writes its own key under the TARGET run_state's
 * root `clone:` block; a key whose status is final is skipped on a rerun.
 */
export const STAGES = [
  'ace_web',          // ace-web copies the run's Drive folder into the target workspace
  'summary_url',      // target run's ace_web_summary_url → its own page
  'drive_ids',        // read-back: no copied file still names a source Drive id
  'hq',               // HQ: linked_app_copy from the RELEASED build, build, release, space-scoped key
  'release_summary',  // 3-commcare/app-release_summary.md re-recorded from the clone's builds
  'connect',          // program → invite → accept → opp held by NM org → PUs → rules → activate → test user
  'labs',             // ace#3020
  'ocs',              // kept: reviewed by its public link
  'asset_refs',       // § 4e: the copied prose names the clone's assets
  'readme',           // run README re-rendered from the rewritten run_state
] as const;
export type Stage = (typeof STAGES)[number];

/** A stage status that a rerun does not redo. */
const FINAL: Record<Stage, readonly string[]> = {
  ace_web: ['done'],
  summary_url: ['done'],
  drive_ids: ['done'],
  hq: ['done'],
  release_summary: ['done'],
  connect: ['done', 'kept-shared'],
  // A legacy `skipped: "Labs stays Dimagi-only"` is NOT final: ace#3020 found
  // it was wrong, so the stage is re-evaluated until it is really done.
  labs: ['done'],
  ocs: ['kept'],
  asset_refs: ['done'],
  readme: ['done'],
};

/**
 * Who executes each stage. Every one is the script: a stage handed back to an
 * agent ("agent-run") is how a 10-minute copy became hours (the Phase 4
 * re-dispatch, ace#3021; the Labs § 4c hand-off, ace#3020). The release path
 * is meant to stay fast — `test/lib/clone-run.test.ts` fails while any stage
 * says otherwise.
 */
export const STAGE_EXECUTOR: Record<Stage, 'script' | 'agent-run'> = {
  ace_web: 'script',
  summary_url: 'script',
  drive_ids: 'script',
  hq: 'script',
  release_summary: 'script',
  connect: 'script',
  labs: 'script',
  ocs: 'script',
  asset_refs: 'script',
  readme: 'script',
};

// ── Wall-clock budget (config/clone-budget.json) ─────────────────────

export interface CloneBudget {
  total_seconds: number;
  stages: Partial<Record<Stage, number>>;
}

/**
 * The defaults, mirrored by config/clone-budget.json (the file wins). Set from
 * what each stage costs when it works — ace-web's copy with its 8-way pool,
 * Connect's ~20 calls, the scripted Labs copy — so a breach means something got
 * slow, not that the budget was tight.
 *
 * ace_web (10 min) and the total (20 min) are ESTIMATES, not measurements
 * (ace#3092): ace-web#913 puts ~850 files at pool 8 at 6–8 min end to end
 * (~4.3 min pooled copy + serial folder creation + the id-rewrite pass), so the
 * first 5 min would have breached on every real clone — a budget that fires
 * every run is noise, and noise gets ignored. Once two real clones have run,
 * tune both from their recorded `seconds` (≈ the slower run + 25%), here and in
 * the file together.
 */
export const DEFAULT_CLONE_BUDGET: CloneBudget = {
  total_seconds: 20 * 60,
  stages: {
    ace_web: 10 * 60,
    summary_url: 30,
    drive_ids: 3 * 60,
    hq: 4 * 60,
    release_summary: 60,
    connect: 3 * 60,
    labs: 6 * 60,
    ocs: 10,
    asset_refs: 4 * 60,
    readme: 60,
  },
};

export function parseCloneBudget(raw: unknown): CloneBudget {
  const r = obj(raw);
  const stages: Partial<Record<Stage, number>> = { ...DEFAULT_CLONE_BUDGET.stages };
  for (const [k, v] of Object.entries(obj(r.stages))) {
    if (!isStage(k)) throw new Error(`clone-budget: unknown stage "${k}"`);
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`clone-budget: stages.${k} must be a positive number of seconds`);
    stages[k] = n;
  }
  const total = r.total_seconds === undefined ? DEFAULT_CLONE_BUDGET.total_seconds : Number(r.total_seconds);
  if (!Number.isFinite(total) || total <= 0) throw new Error('clone-budget: total_seconds must be a positive number');
  return { total_seconds: total, stages };
}

export interface BudgetBreach {
  stage: Stage | 'total';
  seconds: number;
  budget_seconds: number;
}

/**
 * Stages (that RAN this invocation — a skipped stage costs nothing) over their
 * budget, plus the whole run over `total_seconds`. A breach is recorded and
 * makes the script exit non-zero: a slow release is a defect to look at, not a
 * cost to absorb silently.
 */
export function budgetBreaches(results: Record<string, Record<string, unknown> | undefined>, totalSeconds: number, budget: CloneBudget): BudgetBreach[] {
  const out: BudgetBreach[] = [];
  for (const stage of STAGES) {
    const sec = Number(results[stage]?.seconds);
    const cap = budget.stages[stage];
    if (Number.isFinite(sec) && cap !== undefined && sec > cap) out.push({ stage, seconds: sec, budget_seconds: cap });
  }
  if (totalSeconds > budget.total_seconds) out.push({ stage: 'total', seconds: totalSeconds, budget_seconds: budget.total_seconds });
  return out;
}

export interface StageRecord {
  status?: string;
  reason?: string;
  [k: string]: unknown;
}
export type CloneBlock = Partial<Record<Stage, StageRecord>> & {
  from?: { workspace: string; opp: string; run: string };
  [k: string]: unknown;
};

export interface StagePlan {
  stage: Stage;
  action: 'run' | 'skip';
  why: string;
}

/**
 * Which stages still run. `only` restricts to named stages (an operator
 * re-running one); `redo` forces named stages even when final (e.g. 4e after
 * a re-capture). Everything else resumes from the `clone:` block.
 */
export function planStages(
  clone: CloneBlock | null | undefined,
  opts: { only?: readonly Stage[]; redo?: readonly Stage[] } = {},
): StagePlan[] {
  const block = clone ?? {};
  return STAGES.map((stage) => {
    if (opts.only?.length && !opts.only.includes(stage)) {
      return { stage, action: 'skip', why: 'not selected (--only)' };
    }
    if (opts.redo?.includes(stage)) return { stage, action: 'run', why: 'forced (--redo)' };
    const status = block[stage]?.status;
    if (status && FINAL[stage].includes(status)) {
      return { stage, action: 'skip', why: `already ${status}` };
    }
    return { stage, action: 'run', why: status ? `resuming from ${status}` : 'not started' };
  });
}

export function isStage(s: string): s is Stage {
  return (STAGES as readonly string[]).includes(s);
}

// ── Source transcription ─────────────────────────────────────────────

export interface SourceApp {
  kind: 'learn' | 'deliver';
  domain: string;
  hq_app_id: string;
  name: string;
  /** The RELEASED build the source was reviewed on (app-release summary first, ace#2702). */
  build_id: string | null;
  version: string | null;
  build_from: 'app-release_summary' | 'run_state' | 'none';
}

export interface SourceConnect {
  pm_org: string;
  holding_org: string;
  program_id: string;
  opportunity_id: string;
  opportunity_name: string;
  payment_units: Array<Record<string, unknown>>;
  verification: Record<string, unknown>;
  test_user_phone: string | null;
}

export interface CloneSource {
  opp: string;
  run_id: string;
  workspace: string | null;
  apps: { learn?: SourceApp; deliver?: SourceApp };
  connect: SourceConnect | null;
  program_parameters: Record<string, unknown>;
  pdd_description: string | null;
  ocs_public_url: string | null;
  problems: string[];
}

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const s = (v: unknown): string | null => (v === undefined || v === null || v === '' ? null : String(v));

/** Read what the source run recorded. Nothing is guessed; a gap is a `problem`. */
export function cloneSourceFromRunState(runState: unknown, releaseSummaryText: string | null): CloneSource {
  const rs = obj(runState);
  const phases = obj(rs.phases);
  const problems: string[] = [];
  const summary = parseAppReleaseSummary(releaseSummaryText);
  const appsBlock = obj(obj(obj(phases['commcare-setup']).products).apps);
  const apps: CloneSource['apps'] = {};
  for (const kind of ['learn', 'deliver'] as const) {
    const a = obj(appsBlock[kind]);
    const hq = s(a.hq_app_id);
    if (!hq) {
      problems.push(`phases.commcare-setup.products.apps.${kind}.hq_app_id is missing — the run cannot be cloned past the ace-web copy`);
      continue;
    }
    const domain = s(a.domain) ?? s(appsBlock.domain) ?? domainFromHqUrl(s(a.hq_url));
    if (!domain) problems.push(`phases.commcare-setup.products.apps.${kind}: no domain (nor hq_url) recorded`);
    const fromSummary = summary ? releasedBuild(summary, kind, { hq_app_id: hq }) : undefined;
    const fromRs = releasedBuild(null, kind, a);
    const rel = fromSummary ?? fromRs;
    if (!rel) problems.push(`apps.${kind}: no released build recorded (app-release_summary.md or run_state) — refusing to copy "latest saved"`);
    apps[kind] = {
      kind,
      domain: domain ?? '',
      hq_app_id: hq,
      name: s(a.name) ?? `${kind} app`,
      build_id: rel?.build_id ?? null,
      version: rel?.version ?? null,
      build_from: fromSummary ? 'app-release_summary' : fromRs ? 'run_state' : 'none',
    };
  }

  const c = obj(obj(obj(phases['connect-setup']).products).connect);
  let connect: SourceConnect | null = null;
  if (Object.keys(c).length) {
    const pm = s(c.pm_org_slug) ?? s(c.organization_slug);
    const holding = s(c.holding_org_slug) ?? pm;
    const programId = s(obj(c.program).id);
    const oppId = s(obj(c.opportunity).id);
    if (!pm || !programId || !oppId) {
      problems.push('phases.connect-setup.products.connect lacks pm_org_slug / program.id / opportunity.id');
    } else {
      connect = {
        pm_org: pm,
        holding_org: holding!,
        program_id: programId,
        opportunity_id: oppId,
        opportunity_name: s(obj(c.opportunity).name) ?? '',
        payment_units: Array.isArray(c.payment_units) ? (c.payment_units as Array<Record<string, unknown>>) : [],
        verification: obj(c.verification),
        test_user_phone: s(obj(c.ace_test_user).phone),
      };
    }
  }
  const pdd = obj(obj(obj(phases['idea-to-design']).products).pdd);
  return {
    opp: String(rs.opportunity ?? ''),
    run_id: String(rs.run_id ?? ''),
    workspace: s(rs.workspace),
    apps,
    connect,
    program_parameters: obj(pdd.program_parameters),
    pdd_description: s(pdd.description),
    ocs_public_url: s(obj(obj(obj(phases['ocs-setup']).products).ocs_chatbot).public_url),
    problems,
  };
}

function domainFromHqUrl(url: string | null): string | null {
  return url ? (/\/a\/([^/]+)\//.exec(url)?.[1] ?? null) : null;
}

// ── Connect build spec ───────────────────────────────────────────────

/** What the script read live from the SOURCE program/opportunity (read-only). */
export interface SourceConnectReads {
  program?: {
    name?: string; description?: string; delivery_type?: number | string; budget?: number;
    currency?: string; country?: string; start_date?: string; end_date?: string;
  };
  opportunity?: {
    name?: string; short_description?: string; description?: string; start_date?: string;
    end_date?: string; total_budget?: number; is_test?: boolean;
  };
  /** Fields of the source's program-scoped init-edit form (learn description, passing score). */
  init_form?: Record<string, string>;
  passing_score?: number | null;
  /** The source opportunity's deliver units (server_id + slug/name), to map onto the target's. */
  deliver_units?: Array<{ server_id?: number; id: number; slug?: string; name: string }>;
}

export interface ConnectBuildSpec {
  program: {
    name: string; description: string; delivery_type: number | string; budget: number;
    currency: string; country: string; start_date: string; end_date: string;
  };
  opportunity: {
    name: string; short_description: string; description: string; start_date: string;
    end_date: string; total_budget: number; is_test: boolean;
    learn_description: string; passing_score: number;
  };
  payment_units: Array<{
    name: string; amount: number; org_amount?: number; max_total: number; max_daily: number;
    /** SOURCE deliver-unit server ids — mapped onto the target's with `mapDeliverUnits`. */
    source_required_deliver_units: number[];
  }>;
  verification: {
    form_field_rules: Array<{ name: string; question_path: string; question_value: string; source_deliver_unit_id: number }>;
    form_submission_start?: string;
    form_submission_end?: string;
    /** duration in minutes per SOURCE deliver unit (or `null` = every unit). */
    durations: Array<{ source_deliver_unit_id: number | null; duration_minutes: number }>;
  };
  test_user_phone: string | null;
  /** Where each value came from — printed in the report. */
  provenance: Record<string, string>;
  problems: string[];
}

const num = (v: unknown): number | null => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const hhmmss = (v: unknown): string | undefined => {
  const t = s(v);
  if (!t) return undefined;
  return /^\d{1,2}:\d{2}$/.test(t) ? `${t.padStart(5, '0')}:00` : t;
};

/**
 * The values Connect is re-built with. Order of authority per field: the
 * source run_state's recorded products, then the PDD numbers the run recorded
 * (`phases.idea-to-design.products.pdd.program_parameters`), then what the
 * SOURCE Connect objects hold (read live — a transcription, not a derivation).
 * A field none of them carry is a `problem` and the stage refuses.
 */
export function connectBuildSpec(source: CloneSource, reads: SourceConnectReads, env: { e2ePhone?: string } = {}): ConnectBuildSpec {
  const problems: string[] = [];
  const prov: Record<string, string> = {};
  const pp = source.program_parameters;
  const c = source.connect;
  if (!c) problems.push('source run has no phases.connect-setup.products.connect');
  const pick = <T>(field: string, cands: Array<[string, T | null | undefined]>): T | undefined => {
    for (const [from, v] of cands) {
      if (v !== undefined && v !== null && v !== '' && !(typeof v === 'number' && v === 0 && field.endsWith('delivery_type'))) {
        prov[field] = from;
        return v as T;
      }
    }
    problems.push(`no recorded value for ${field}`);
    return undefined;
  };
  const p = reads.program ?? {};
  const o = reads.opportunity ?? {};
  const dt = obj(pp.connect_delivery_type);
  const countryAlpha3 = s(pp.opportunity_country);
  const program = {
    name: pick<string>('program.name', [['source program (live read)', p.name]]) ?? '',
    description: pick<string>('program.description', [['source program (live read)', p.description]]) ?? '',
    delivery_type: pick<number | string>('program.delivery_type', [
      ['pdd.program_parameters.connect_delivery_type.id', num(dt.id)],
      ['source program (live read)', p.delivery_type],
    ]) ?? '',
    budget: pick<number>('program.budget', [['source program (live read)', num(p.budget)], ['pdd.program_parameters.total_budget', num(pp.total_budget)]]) ?? 0,
    currency: pick<string>('program.currency', [['pdd.program_parameters.opportunity_currency', s(pp.opportunity_currency)], ['source program (live read)', p.currency]]) ?? '',
    country: pick<string>('program.country', [
      ['pdd.program_parameters.opportunity_country (connectCountryName)', countryAlpha3 ? connectCountryName(countryAlpha3) : null],
      ['source program (live read)', p.country && /^[A-Z]{3}$/.test(p.country) ? connectCountryName(p.country) : p.country],
    ]) ?? '',
    start_date: pick<string>('program.start_date', [['source program (live read)', p.start_date], ['pdd.program_parameters.opportunity_start_date', s(pp.opportunity_start_date)]]) ?? '',
    end_date: pick<string>('program.end_date', [['source program (live read)', p.end_date], ['pdd.program_parameters.opportunity_end_date', s(pp.opportunity_end_date)]]) ?? '',
  };
  const initForm = reads.init_form ?? {};
  const opportunity = {
    name: pick<string>('opportunity.name', [['run_state products.connect.opportunity.name', c?.opportunity_name], ['source opportunity (live read)', o.name]]) ?? '',
    short_description: pick<string>('opportunity.short_description', [['source opportunity (live read)', o.short_description], ['source init-edit form', s(initForm.short_description)]]) ?? '',
    description: pick<string>('opportunity.description', [['source opportunity (live read)', o.description], ['source init-edit form', s(initForm.description)]]) ?? '',
    start_date: pick<string>('opportunity.start_date', [['pdd.program_parameters.opportunity_start_date', s(pp.opportunity_start_date)], ['source opportunity (live read)', o.start_date]]) ?? '',
    end_date: pick<string>('opportunity.end_date', [['pdd.program_parameters.opportunity_end_date', s(pp.opportunity_end_date)], ['source opportunity (live read)', o.end_date]]) ?? '',
    total_budget: pick<number>('opportunity.total_budget', [['pdd.program_parameters.total_budget', num(pp.total_budget)], ['source opportunity (live read)', num(o.total_budget)]]) ?? 0,
    is_test: true,
    learn_description: pick<string>('opportunity.learn_description', [
      ['source init-edit form learn_app_description', s(initForm.learn_app_description)],
      ['pdd.description', source.pdd_description],
    ]) ?? '',
    passing_score: pick<number>('opportunity.passing_score', [
      ['pdd.program_parameters.learn_passing_score', num(pp.learn_passing_score)],
      ['source init-edit form (live read)', num(reads.passing_score)],
    ]) ?? 0,
  };
  if (opportunity.short_description.length > 50) {
    problems.push(`opportunity.short_description is ${opportunity.short_description.length} chars (Connect caps it at 50)`);
  }

  const payment_units = (c?.payment_units ?? []).map((u, i) => {
    const amount = num(u.amount);
    const max_total = num(u.max_total);
    const max_daily = num(u.max_daily);
    if (amount === null || max_total === null || max_daily === null || !s(u.name)) {
      problems.push(`payment_units[${i}] lacks name/amount/max_total/max_daily in run_state`);
    }
    const orgAmount = num(u.org_amount);
    return {
      name: s(u.name) ?? '',
      amount: amount ?? 0,
      ...(orgAmount !== null ? { org_amount: orgAmount } : {}),
      max_total: max_total ?? 0,
      max_daily: max_daily ?? 0,
      source_required_deliver_units: (Array.isArray(u.required_deliver_units) ? u.required_deliver_units : []).map(Number),
    };
  });
  if (c && !payment_units.length) problems.push('source run recorded no payment_units');
  prov.payment_units = 'run_state products.connect.payment_units';

  const v = c?.verification ?? {};
  const pv = obj(pp.verification_flags);
  const rules = (Array.isArray(v.form_field_rules) ? v.form_field_rules : []) as Array<Record<string, unknown>>;
  const form_field_rules = rules.map((r) => ({
    name: String(r.name ?? ''),
    question_path: String(r.question_path ?? ''),
    question_value: String(r.question_value ?? ''),
    source_deliver_unit_id: Number(r.deliver_unit_id),
  }));
  prov['verification.form_field_rules'] = 'run_state products.connect.verification.form_field_rules';
  const recordedChecks = (Array.isArray(v.deliver_unit_checks) ? v.deliver_unit_checks : []) as Array<Record<string, unknown>>;
  let durations: ConnectBuildSpec['verification']['durations'] = recordedChecks
    .filter((d) => num(d.duration_minutes) !== null)
    .map((d) => ({ source_deliver_unit_id: num(d.deliver_unit_id), duration_minutes: num(d.duration_minutes)! }));
  if (durations.length) prov['verification.duration'] = 'run_state products.connect.verification.deliver_unit_checks';
  else if (num(pv.duration_minutes) !== null) {
    durations = [{ source_deliver_unit_id: null, duration_minutes: num(pv.duration_minutes)! }];
    prov['verification.duration'] = 'pdd.program_parameters.verification_flags.duration_minutes';
  }
  const start = hhmmss(v.form_submission_start) ?? hhmmss(pv.form_submission_start);
  const end = hhmmss(v.form_submission_end) ?? hhmmss(pv.form_submission_end);
  if (start || end) {
    prov['verification.window'] = s(v.form_submission_start) ? 'run_state products.connect.verification' : 'pdd.program_parameters.verification_flags';
  }
  const phone = c?.test_user_phone ?? env.e2ePhone ?? null;
  prov.test_user_phone = c?.test_user_phone ? 'run_state products.connect.ace_test_user.phone' : env.e2ePhone ? 'ACE_E2E_PHONE' : 'none';
  return {
    program: program as ConnectBuildSpec['program'],
    opportunity,
    payment_units,
    verification: {
      form_field_rules,
      ...(start ? { form_submission_start: start } : {}),
      ...(end ? { form_submission_end: end } : {}),
      durations,
    },
    test_user_phone: phone,
    provenance: prov,
    problems,
  };
}

/**
 * Map SOURCE deliver-unit server ids onto the TARGET opportunity's. Connect
 * creates the target's deliver units from the copied Deliver app, so they
 * carry the same slugs (else names); a single unit on each side maps by
 * construction. An unmappable id throws — guessing a payment unit's deliver
 * unit would pay for the wrong form.
 */
export function mapDeliverUnits(
  sourceDus: Array<{ server_id?: number; id: number; slug?: string; name: string }>,
  targetDus: Array<{ server_id?: number; id: number; slug?: string; name: string }>,
): Map<number, number> {
  const out = new Map<number, number>();
  const sid = (d: { server_id?: number; id: number }) => d.server_id ?? d.id;
  if (sourceDus.length === 1 && targetDus.length === 1) {
    out.set(sid(sourceDus[0]), sid(targetDus[0]));
    return out;
  }
  for (const sd of sourceDus) {
    const t =
      (sd.slug ? targetDus.find((td) => td.slug && td.slug === sd.slug) : undefined) ??
      targetDus.find((td) => td.name === sd.name);
    if (t) out.set(sid(sd), sid(t));
  }
  return out;
}

export function mapDuIds(ids: number[], map: Map<number, number>, what: string): number[] {
  return ids.map((id) => {
    const t = map.get(id);
    if (t === undefined) {
      throw new Error(`${what}: source deliver unit ${id} has no counterpart on the target opportunity (mapped: ${[...map.keys()].join(', ') || 'none'})`);
    }
    return t;
  });
}

// ── "A timeout is not a failure — look before retry" ─────────────────

export interface CreateRecord {
  status?: 'pending' | 'ambiguous' | 'done';
  id?: string;
  at?: string;
  error?: string;
}

export type CreateDecision =
  | { action: 'adopt'; id: string }
  | { action: 'create' }
  | { action: 'refuse'; reason: string };

/**
 * What to do about one create. A FOUND object is always adopted. A create
 * that previously came back AMBIGUOUS (timeout / gateway error) and still
 * cannot be found is NOT retried blind: Connect's 504'd opportunity create on
 * the source run appeared ~2 minutes later (noora-health/20261015-1129), and
 * HQ's copy_app re-list "regularly exceeds the 30s timeout for a copy that
 * ALREADY SUCCEEDED" (commcare.ts createLinkedAppCopy). Only an operator who
 * has looked may pass `retryAmbiguous`.
 */
export function decideCreate(
  rec: CreateRecord | undefined,
  found: { id: string } | null,
  opts: { retryAmbiguous?: boolean } = {},
): CreateDecision {
  if (found) return { action: 'adopt', id: found.id };
  if (rec?.status === 'done' && rec.id) {
    return { action: 'refuse', reason: `recorded as created (${rec.id}) but the look-up cannot find it — investigate, do not re-create` };
  }
  if (rec?.status === 'ambiguous' && !opts.retryAmbiguous) {
    return {
      action: 'refuse',
      reason:
        `the previous create came back ambiguous at ${rec.at ?? '?'} (${rec.error ?? 'timeout'}) and the object is still not found. ` +
        'It may yet appear (a 504 can land minutes later). Re-run later; only after checking by hand pass --retry-ambiguous.',
    };
  }
  return { action: 'create' };
}

/** A transport-level failure whose server-side outcome is unknown. */
export function isAmbiguousError(err: unknown): boolean {
  const m = String((err as Error)?.message ?? err);
  return /timeout|timed out|ETIMEDOUT|ECONNRESET|socket hang up|EPIPE|\b50[234]\b|Gateway|ECONNABORTED|network/i.test(m);
}

export class AmbiguousCreateError extends Error {
  constructor(public step: string, public cause_message: string) {
    super(`${step}: create outcome unknown (${cause_message}); looked again and found nothing — recorded as ambiguous, NOT retried`);
    this.name = 'AmbiguousCreateError';
  }
}
export class RefusedCreateError extends Error {
  constructor(public step: string, reason: string) {
    super(`${step}: ${reason}`);
    this.name = 'RefusedCreateError';
  }
}

/**
 * look → decide → create, and on an ambiguous failure look again (`settle`
 * times, `settleMs` apart) before giving up WITHOUT a retry. `save` persists
 * the record after every transition, so a crash between create and record
 * leaves `ambiguous`, never a silent duplicate on the next run.
 */
export async function lookThenCreate(args: {
  step: string;
  record: CreateRecord | undefined;
  look: () => Promise<{ id: string } | null>;
  create: () => Promise<{ id: string }>;
  save: (rec: CreateRecord) => Promise<void>;
  retryAmbiguous?: boolean;
  settle?: number;
  settleMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => string;
}): Promise<{ id: string; adopted: boolean }> {
  const now = args.now ?? (() => new Date().toISOString());
  const sleep = args.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const found = await args.look();
  const d = decideCreate(args.record, found, { retryAmbiguous: args.retryAmbiguous });
  if (d.action === 'adopt') {
    await args.save({ status: 'done', id: d.id, at: now() });
    return { id: d.id, adopted: true };
  }
  if (d.action === 'refuse') throw new RefusedCreateError(args.step, d.reason);
  await args.save({ status: 'pending', at: now() });
  try {
    const made = await args.create();
    await args.save({ status: 'done', id: made.id, at: now() });
    return { id: made.id, adopted: false };
  } catch (err) {
    if (!isAmbiguousError(err)) throw err;
    const msg = String((err as Error)?.message ?? err).slice(0, 200);
    await args.save({ status: 'ambiguous', at: now(), error: msg });
    for (let i = 0; i < (args.settle ?? 4); i++) {
      await sleep(args.settleMs ?? 20_000);
      const again = await args.look();
      if (again) {
        await args.save({ status: 'done', id: again.id, at: now() });
        return { id: again.id, adopted: true };
      }
    }
    throw new AmbiguousCreateError(args.step, msg);
  }
}

// ── Tenancy guard (writes the script makes outside MCP) ──────────────

export interface Binding {
  workspace: string;
  opp: string;
  mode?: 'enforce' | 'warn';
  tenancy?: Record<string, string | null | undefined>;
  drive_root_folder_id?: string | null;
}

/**
 * Same semantics as hooks/tenancy_guard.py for the args config/tenancy-targets.json
 * maps: every tenant argument must equal one of its tenancy fields; a field
 * that is not set up refuses rather than guesses; `warn` mode reports instead
 * of refusing. `binding: null` = unbound (allowed — but the script always
 * binds before its first write).
 */
export function checkTenantWrite(
  binding: Binding | null,
  call: string,
  args: Array<{ arg: string; value: string | undefined; fields: string[] }>,
): { allow: boolean; problems: string[] } {
  if (!binding) return { allow: true, problems: [] };
  const problems: string[] = [];
  for (const a of args) {
    if (a.value === undefined) continue;
    const allowed = a.fields.map((f) => binding.tenancy?.[f]).filter((x): x is string => !!x);
    if (!allowed.length) {
      problems.push(`${call}: \`${a.arg}\` = ${a.value} — the bound opp's tenancy has no ${a.fields.join('/')} set up`);
    } else if (!allowed.includes(a.value)) {
      problems.push(`${call}: \`${a.arg}\` = ${a.value} is outside ${binding.workspace}/${binding.opp}'s tenancy (${a.fields.join('/')} = ${allowed.join(', ')})`);
    }
  }
  return { allow: problems.length === 0 || binding.mode === 'warn', problems };
}

// ── Rewrites ─────────────────────────────────────────────────────────

export function summaryUrl(aceWebBase: string, to: string, opp: string, run: string): string {
  return `${aceWebBase.replace(/\/+$/, '')}/opps/${to}/${opp}/runs/${run}/summary`;
}

export interface ClonedApp {
  hq_app_id: string;
  build_id: string;
  version: number | null;
  released_at: string;
}

/** `phases.commcare-setup.products.apps` for the target (Nova ids kept: same Nova source). */
export function hqProductsPatch(
  current: unknown,
  hqDomain: string,
  apps: { learn?: ClonedApp; deliver?: ClonedApp },
  hqBase = 'https://www.commcarehq.org',
): Record<string, unknown> {
  const cur = obj(current);
  const out: Record<string, unknown> = { ...cur, domain: hqDomain };
  for (const kind of ['learn', 'deliver'] as const) {
    const a = apps[kind];
    if (!a) continue;
    out[kind] = {
      ...obj(cur[kind]),
      domain: hqDomain,
      hq_app_id: a.hq_app_id,
      hq_url: `${hqBase.replace(/\/+$/, '')}/a/${hqDomain}/apps/view/${a.hq_app_id}/`,
      build_status: 'success',
      released_build_id: a.build_id,
      released_version: a.version,
    };
  }
  return out;
}

/** Re-record app-release_summary.md frontmatter from THIS clone's builds; the body is left for § 4e. */
export function rewriteReleaseSummary(
  text: string,
  apps: { learn?: ClonedApp; deliver?: ClonedApp },
): { text: string; changed: boolean } {
  const m = /^(﻿?)---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text);
  const fm = m ? (parseYaml(m[2]) as Record<string, unknown>) ?? {} : {};
  const body = m ? text.slice(m[0].length) : text;
  const appsFm = { ...obj(fm.apps) };
  for (const kind of ['learn', 'deliver'] as const) {
    const a = apps[kind];
    if (!a) continue;
    appsFm[`${kind}_app`] = {
      ...obj(appsFm[`${kind}_app`]),
      hq_app_id: a.hq_app_id,
      build_id: a.build_id,
      version: a.version,
      is_released: true,
      released_at: a.released_at,
    };
  }
  const next = { ...fm, apps: appsFm };
  const out = `---\n${stringifyYaml(next, { version: '1.1' }).trimEnd()}\n---\n${body}`;
  const before = m ? stringifyYaml(fm, { version: '1.1' }) : '';
  return { text: out, changed: before !== stringifyYaml(next, { version: '1.1' }) };
}

export interface ClonedConnect {
  pm_org: string;
  holding_org: string;
  hq_domain: string;
  program_id: string;
  application_id: string | null;
  opportunity_id: string;
  opportunity_name: string;
  connect_int_id?: number | null;
  payment_units: Array<Record<string, unknown>>;
  verification: Record<string, unknown>;
  test_user: Record<string, unknown> | null;
}

/** `phases.connect-setup.products.connect` for the target, in the shape Phase 4 writes. */
export function connectProductsPatch(c: ClonedConnect, connectBase = 'https://connect.dimagi.com'): Record<string, unknown> {
  const base = connectBase.replace(/\/+$/, '');
  return {
    domain: c.hq_domain,
    organization_slug: c.pm_org,
    pm_org_slug: c.pm_org,
    holding_org_slug: c.holding_org,
    org_mode: c.pm_org === c.holding_org ? 'self-managed' : 'pm-nm',
    program: { id: c.program_id, url: `${base}/a/${c.pm_org}/program/${c.program_id}/` },
    program_application_id: c.application_id,
    opportunity: {
      id: c.opportunity_id,
      name: c.opportunity_name,
      url: `${base}/a/${c.holding_org}/opportunity/${c.opportunity_id}/`,
      ...(c.connect_int_id ? { connect_int_id: c.connect_int_id } : {}),
    },
    payment_units: c.payment_units,
    verification: c.verification,
    ...(c.test_user ? { ace_test_user: c.test_user } : {}),
  };
}

/**
 * A target `products.connect` some earlier attempt already built IN THE
 * TARGET'S ORGS (e.g. the agent-driven Phase 4 re-dispatch of a clone that
 * was interrupted). The script adopts it — after live read-backs — instead
 * of building a second program and opportunity.
 */
export function adoptableTargetConnect(
  targetRunState: unknown,
  tenancy: { connect_pm_org?: string | null; connect_holding_org?: string | null },
  source: CloneSource,
): { program_id: string; opportunity_id: string; application_id: string | null } | null {
  const c = obj(obj(obj(obj(targetRunState).phases)['connect-setup']).products).connect;
  const cc = obj(c);
  const pm = s(cc.pm_org_slug) ?? s(cc.organization_slug);
  const holding = s(cc.holding_org_slug) ?? pm;
  const programId = s(obj(cc.program).id);
  const oppId = s(obj(cc.opportunity).id);
  if (!pm || !programId || !oppId) return null;
  if (pm !== tenancy.connect_pm_org || holding !== tenancy.connect_holding_org) return null;
  if (source.connect && (oppId === source.connect.opportunity_id || programId === source.connect.program_id)) return null;
  return { program_id: programId, opportunity_id: oppId, application_id: s(cc.program_application_id) };
}

/** Every product the clone rewrote must name the target's tenancy — the final read-back. */
export function productsPointAtTarget(
  targetRunState: unknown,
  tenancy: { hq_domain?: string | null; connect_pm_org?: string | null; connect_holding_org?: string | null },
  opts: { keepSharedConnect?: boolean } = {},
): string[] {
  const p = obj(obj(targetRunState).phases);
  const problems: string[] = [];
  const apps = obj(obj(obj(p['commcare-setup']).products).apps);
  for (const kind of ['learn', 'deliver']) {
    const d = s(obj(apps[kind]).domain) ?? domainFromHqUrl(s(obj(apps[kind]).hq_url));
    if (d && d !== tenancy.hq_domain) problems.push(`products.apps.${kind} is in ${d}, not ${tenancy.hq_domain}`);
  }
  if (!opts.keepSharedConnect) {
    const c = obj(obj(obj(p['connect-setup']).products).connect);
    if (Object.keys(c).length) {
      if ((s(c.pm_org_slug) ?? s(c.organization_slug)) !== tenancy.connect_pm_org) {
        problems.push(`products.connect.pm_org_slug is ${s(c.pm_org_slug)}, not ${tenancy.connect_pm_org}`);
      }
      if (s(c.holding_org_slug) && s(c.holding_org_slug) !== tenancy.connect_holding_org) {
        problems.push(`products.connect.holding_org_slug is ${s(c.holding_org_slug)}, not ${tenancy.connect_holding_org}`);
      }
      if (s(c.domain) && s(c.domain) !== tenancy.hq_domain) problems.push(`products.connect.domain is ${s(c.domain)}, not ${tenancy.hq_domain}`);
    }
  }
  return problems;
}

// ── The id/URL map a rewrite stage applied (content ledger) ─────────

export interface AppliedPair {
  from: string;
  to: string;
  kind?: string;
}

const HEX_ID_RE = /^[0-9a-f-]{16,}$/i;

/**
 * Every substitution `clone-asset-rewrite.ts`'s plan can make, as flat pairs
 * for the readiness content ledger (lib/release-readiness.ts): the asset pairs
 * (HQ space, app/build ids, Connect program/opportunity/org), each long hex
 * id's 8-char prefix (how prose abbreviates them — the rewrite matches those
 * too, lib/clone-asset-refs.ts `idPatterns`), the released versions, and the
 * re-pointed frames (old Drive id → live one). A pair the ledger lacks makes a
 * rewritten file read as changed — the safe direction — so this errs toward
 * completeness, never toward pairs the rewrite does not make.
 */
export function rewritePairsFromAssetPlan(plan: unknown): AppliedPair[] {
  const p = obj(plan);
  const out: AppliedPair[] = [];
  for (const raw of Array.isArray(p.pairs) ? p.pairs : []) {
    const x = obj(raw);
    const from = s(x.from);
    const to = s(x.to);
    if (!from || !to || from === to) continue;
    out.push({ from, to, kind: s(x.kind) ?? 'asset' });
    if (HEX_ID_RE.test(from) && from.length > 8 && x.kind !== 'opportunity_int') {
      out.push({ from: from.slice(0, 8), to: to.slice(0, 8), kind: `${s(x.kind) ?? 'asset'}_prefix` });
    }
  }
  for (const v of Object.values(obj(p.versions))) {
    const from = s(obj(v).from);
    const to = s(obj(v).to);
    if (from && to && from !== to) out.push({ from, to, kind: 'version' });
  }
  for (const [from, to] of Object.entries(obj(obj(p.frames).repointed))) {
    if (typeof to === 'string' && to && from !== to) out.push({ from, to, kind: 'frame' });
  }
  return out;
}

/** `clone-drive-readback.ts --plan`'s source → copy Drive ids, as pairs. */
export function rewritePairsFromDriveIdPlan(plan: unknown): AppliedPair[] {
  const pairs = obj(plan).pairs;
  if (Array.isArray(pairs)) {
    return pairs.map((x) => ({ from: String(obj(x).from ?? ''), to: String(obj(x).to ?? ''), kind: 'drive_id' })).filter((x) => x.from && x.to && x.from !== x.to);
  }
  return Object.entries(obj(obj(plan).id_map)).flatMap(([from, to]) => (typeof to === 'string' && to && to !== from ? [{ from, to, kind: 'drive_id' }] : []));
}

// ── Labs (ace#3020) ──────────────────────────────────────────────────

export interface LabsRebuildContext {
  source: CloneSource;
  sourceRunState: unknown;
  targetRunState: unknown;
  to: string;
  tenancy: Record<string, string | null | undefined>;
}

/** One labs MCP tool call: resolves to the tool's JSON result, throws on a tool error. */
export type LabsCall = (tool: string, args: Record<string, unknown>) => Promise<any>;

/** What the copy has done so far — persisted as `clone.labs.copy`, so a rerun resumes. */
export interface LabsCopyState {
  /** source labs id → copy id, for every id the products block names (one integer space). */
  id_map: Record<string, number>;
  steps: Record<string, unknown>;
}

export interface LabsCopyDeps {
  call: LabsCall;
  /** Persist progress after every step (and every partner). */
  save: (state: LabsCopyState) => Promise<void>;
  /**
   * § 4c step 6, workspace roles: there is no labs MCP atom for them
   * (connect-labs#2572), so this is `scripts/labs-workspace-setup.ts` over the
   * `/ace:labs-login` session. `ok: false` leaves ONLY this step not done.
   */
  workspace: (programId: number, llos: string[]) => Promise<{ ok: boolean; llos: string[]; detail: string }>;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
  /**
   * Steps whose earlier create came back ambiguous and the operator has
   * checked by hand (`--retry-ambiguous labs.registry,…`). Without it an
   * ambiguous create is never repeated — see `labsCreate`.
   */
  retryAmbiguous?: Set<string>;
  /** Look-again attempts after an ambiguous create (default 4, `lookThenCreate`'s). */
  settle?: number;
}

export interface LabsRebuildContext {
  source: CloneSource;
  sourceRunState: unknown;
  targetRunState: unknown;
  to: string;
  tenancy: Record<string, string | null | undefined>;
  /** `<opp>/<run-id>` of the clone (names the new org and registry, and the labs_context search). */
  opp?: string;
  run?: string;
  keepSharedConnect?: boolean;
  /** Without deps the stage can only say what it would do (unit tests of the plan, `--plan`). */
  deps?: LabsCopyDeps;
}

export class LabsCopyStepError extends Error {
  constructor(public step: string, message: string) {
    super(`labs ${step}: ${message}`);
    this.name = 'LabsCopyStepError';
  }
}

const int = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** The `products.synthetic` block of a run_state. */
export function syntheticProducts(runState: unknown): Record<string, unknown> {
  return obj(obj(obj(obj(obj(runState).phases)['synthetic-data-and-workflows']).products).synthetic);
}

/** Every page of `workflow_history_runs` (it pages at 10 — the first page alone silently graded 10 of 16 periods). */
export async function allHistoryRuns(call: LabsCall, args: Record<string, unknown>): Promise<Array<Record<string, any>>> {
  const out: Array<Record<string, any>> = [];
  let start: number | null = 0;
  for (let guard = 0; start !== null && guard < 200; guard++) {
    const r = obj(await call('workflow_history_runs', { ...args, generated_only: false, start_at: start, limit: 100 }));
    out.push(...(arr(r.runs) as Array<Record<string, any>>));
    start = r.done === false && r.next_start_at !== null && r.next_start_at !== undefined ? Number(r.next_start_at) : null;
  }
  return out;
}

/** Pair two run listings by `period_end`; returns the map and the source periods with no counterpart. */
export function mapRunsByPeriod(source: Array<Record<string, any>>, target: Array<Record<string, any>>): { map: Record<string, number>; missing: string[] } {
  const byEnd = new Map<string, number>();
  for (const r of target) {
    const id = int(r.run_id ?? r.id);
    if (id && r.period_end) byEnd.set(String(r.period_end).slice(0, 10), id);
  }
  const map: Record<string, number> = {};
  const missing: string[] = [];
  for (const r of source) {
    const id = int(r.run_id ?? r.id);
    const end = r.period_end ? String(r.period_end).slice(0, 10) : '';
    if (!id || !end) continue;
    const t = byEnd.get(end);
    if (t) map[String(id)] = t;
    else missing.push(end);
  }
  return { map, missing: [...new Set(missing)].sort() };
}

/**
 * The source definition's config minus every key whose value names a source
 * labs id (companion links, scope keys): those are the SOURCE's wiring, and
 * the template re-creates its own in the new program.
 */
export function portableConfig(config: unknown, sourceIds: ReadonlySet<number>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj(config))) {
    const named = numbersIn(v);
    if ([...named].some((id) => sourceIds.has(id))) continue;
    out[k] = v;
  }
  return out;
}

/** Every integer that could be a labs id in a value (numbers, and digit runs in strings). */
function numbersIn(v: unknown): Set<number> {
  const ids = new Set<number>();
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) n.forEach(walk);
    else if (n && typeof n === 'object') Object.values(n as Record<string, unknown>).forEach(walk);
    else if (typeof n === 'number' && Number.isInteger(n) && n >= 1000) ids.add(n);
    else if (typeof n === 'string') for (const m of n.matchAll(/(\d{4,})/g)) ids.add(Number(m[1]));
  };
  walk(v);
  return ids;
}

/** Indicator values of one saved run's snapshot, `{programInd, byLLO}` reduced to numbers — what a copy must reproduce. */
export function gradedFigures(run: Record<string, any>): Record<string, number | null> {
  const snap = obj(obj(obj(obj(run.data).snapshot).state).snapshot);
  const out: Record<string, number | null> = {};
  const num = (c: unknown) => (typeof obj(c).value === 'number' && Number.isFinite(obj(c).value as number) ? (obj(c).value as number) : null);
  for (const [k, c] of Object.entries(obj(snap.programInd))) out[`program.${k}`] = num(c);
  for (const row of arr(snap.byLLO)) {
    const r = obj(row);
    for (const [k, c] of Object.entries(obj(r.ind))) out[`llo.${String(r.llo)}.${k}`] = num(c);
  }
  return out;
}

/** Periods whose figures differ between the source's saved runs and the copy's (a copy reproduces every one). */
export function figureMismatches(source: Array<Record<string, any>>, target: Array<Record<string, any>>): string[] {
  const byEnd = new Map(target.map((r) => [String(r.period_end ?? '').slice(0, 10), gradedFigures(r)]));
  const out: string[] = [];
  for (const r of source) {
    const end = String(r.period_end ?? '').slice(0, 10);
    const want = gradedFigures(r);
    const got = byEnd.get(end);
    if (!got) {
      out.push(`${end}: no saved run in the copy`);
      continue;
    }
    for (const [k, v] of Object.entries(want)) {
      const g = got[k];
      if (v === null && (g === null || g === undefined)) continue;
      if (v === null || g === null || g === undefined || Math.abs(v - g) > 1e-9) out.push(`${end} ${k}: source ${v}, copy ${g ?? 'missing'}`);
    }
  }
  return out;
}

/**
 * Labs stage (`clone-to-new-workspace` § 4c, ace#3020) — SCRIPTED. It COPIES
 * the source's Phase 7 Labs build into ONE new labs program, never widening an
 * allowlist and never regenerating (owner, 2026-10-16):
 *
 *   records    `synthetic_clone_to_labs_only` per partner — the first WITHOUT
 *              `program_id` (its opp id becomes the program id), later ones
 *              with it (connect-labs#2574); counts read back against the source;
 *   registry   `semantic_registry_get` → ids retargeted → `semantic_registry_create`;
 *   report     the programme report from the SAME template with the source
 *              config (`workflow_create_from_template`; makes the worker-review
 *              companion), its visits pipeline given the source's schema;
 *   cohort     the new labs org's cohort, its members, and the opp reports
 *              (`benchmarks_create_opp_reports`, sharing the report's pipelines);
 *   history    `workflow_rebuild_history` over the SOURCE's window (same weeks)
 *              — computed from the copied records, no data generated;
 *   benchmarks one publish per saved run, oldest first, the last one last;
 *   verify     every period's graded figures equal the source's (a copy is
 *              checked AS a copy — stronger than re-reading the story);
 *   workspace  the new program as a labs workspace whose LLOs are the clone's
 *              Connect orgs (the one step with no MCP atom, connect-labs#2572);
 *   products   `remapSyntheticProducts` — refuses to leave a source id behind.
 *
 * Every step is recorded in `clone.labs.copy` and skipped on a rerun; a step
 * that fails leaves the stage `not-done` naming THAT step, so the next run (or
 * the operator, for the workspace session) resumes there. Without `deps` (no
 * labs token) the stage reports what is missing, never pretends.
 */
export async function rebuildLabs(ctx: LabsRebuildContext): Promise<StageRecord> {
  const synthetic = syntheticProducts(ctx.sourceRunState);
  if (!Object.keys(synthetic).length) {
    return { status: 'done', reason: 'source run has no Phase 7 synthetic products — nothing to rebuild' };
  }
  let src: ReturnType<typeof labsRebuildSource>;
  try {
    src = labsRebuildSource(ctx.sourceRunState);
  } catch (e) {
    // Phase 7 built SOMETHING, in a shape the copy does not know: never a silent
    // skip (#3020's defect) — say so; the shape gets scripted, not guessed at.
    return { status: 'not-done', step: 'source-shape', reason: `the source's Phase 7 products are not an ace-run cascade the scripted copy knows (${(e as Error).message}) — file it; never regenerate instead` };
  }
  if (!ctx.deps) {
    return { status: 'not-done', step: 'labs-token', reason: 'no labs MCP access (LABS_MCP_TOKEN — /ace:labs-token-mint): the scripted copy cannot run' };
  }
  const prior = obj(obj(obj(obj(ctx.targetRunState).clone).labs).copy);
  const state: LabsCopyState = {
    id_map: { ...(obj(prior.id_map) as Record<string, number>) },
    steps: { ...obj(prior.steps) },
  };
  try {
    return await copyLabs(ctx, src, synthetic, state, ctx.deps);
  } catch (e) {
    const step = e instanceof LabsCopyStepError ? e.step : 'unknown';
    await ctx.deps.save(state).catch(() => {});
    return { status: 'not-done', step, reason: `${(e as Error).message}`.slice(0, 600), copy: state };
  }
}

async function copyLabs(
  ctx: LabsRebuildContext,
  src: ReturnType<typeof labsRebuildSource>,
  synthetic: Record<string, unknown>,
  state: LabsCopyState,
  deps: LabsCopyDeps,
): Promise<StageRecord> {
  const { call, save } = deps;
  const log = deps.log ?? (() => {});
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const tag = `ace ${ctx.to}/${ctx.opp ?? ctx.source.opp}/${ctx.run ?? ctx.source.run_id}`;
  const cascade = obj(synthetic.cascade);
  const map = state.id_map;
  const steps = state.steps as Record<string, any>;
  const put = (from: unknown, to: unknown) => {
    const f = int(from);
    const t = int(to);
    if (f && t) map[String(f)] = t;
  };
  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    if (steps[name]?.done) return steps[name] as T;
    try {
      const out = (await fn()) as T & Record<string, unknown>;
      steps[name] = { ...(out as object), done: true };
      await save(state);
      log(`labs ${name}: done`);
      return steps[name] as T;
    } catch (e) {
      if (e instanceof LabsCopyStepError) throw e;
      throw new LabsCopyStepError(name, (e as Error).message);
    }
  };

  /**
   * The three Labs CREATES (registry, programme report, cohort) are
   * look-then-create (ace#3092 item 4). `step()` only marks a step done AFTER
   * its body returns, so a create that LANDS but whose response is lost (a
   * 502/504, a dropped socket, a crash before `save`) used to be repeated on
   * the rerun: a second registry / report / cohort in the clone's program.
   * Each is now found first by the clone-unique name it was made with, and
   * the create's progress is recorded in `steps.<name>_create`, so a rerun
   * ADOPTS what landed and an unresolved ambiguous create is refused until
   * the operator checks (`--retry-ambiguous labs.<name>`). Same semantics as
   * the Connect/HQ creates — "a timeout is not a failure; look before retry".
   */
  const labsCreate = (name: string, look: () => Promise<{ id: string } | null>, create: () => Promise<{ id: string }>) =>
    lookThenCreate({
      step: `labs.${name}`,
      record: steps[`${name}_create`] as CreateRecord | undefined,
      retryAmbiguous: deps.retryAmbiguous?.has(`labs.${name}`),
      settle: deps.settle,
      sleep,
      look: async () => {
        const rec = steps[`${name}_create`] as CreateRecord | undefined;
        if (rec?.status === 'done' && rec.id) return { id: rec.id };
        return look();
      },
      create,
      save: async (r) => {
        steps[`${name}_create`] = r;
        await save(state);
      },
    });
  /** At most one object of this name — two means a duplicate already exists; never guess which. */
  const oneNamed = (what: string, hits: Array<Record<string, any>>): { id: string } | null => {
    if (hits.length > 1) throw new Error(`${hits.length} ${what} — record the right one in clone.labs.copy.steps, then rerun`);
    const id = int(hits[0]?.id);
    return id ? { id: String(id) } : null;
  };

  const programName = s(cascade.program_name) ?? s(synthetic.program_name) ?? `${ctx.source.opp} programme`;
  const orgName = `${programName} partners (${tag})`;

  // 1. The records: one labs-only copy per partner, all in ONE new program.
  const records = await step('records', async () => {
    const copies = obj(steps.records_partial) as Record<string, number>;
    let programId = int(steps.program_id);
    for (const p of src.partners) {
      const key = String(p.source_opportunity_id);
      if (!copies[key]) {
        const r = obj(await call('synthetic_clone_to_labs_only', {
          source_opportunity_id: p.source_opportunity_id,
          label: p.label,
          org_name: orgName,
          program_name: programName,
          ...(programId ? { program_id: programId } : {}),
          allowed_domains: ['@dimagi.com', '@dimagi-ai.com'],
        }));
        const id = int(r.opportunity_id);
        if (!id) throw new Error(`synthetic_clone_to_labs_only(${key}) returned no opportunity_id`);
        copies[key] = id;
        programId ??= int(r.program_id) ?? id;
        steps.records_partial = copies;
        steps.program_id = programId;
        await save(state);
      }
      const [a, b] = await Promise.all([
        call('synthetic_local_records_count', { opportunity_id: p.source_opportunity_id }),
        call('synthetic_local_records_count', { opportunity_id: copies[key] }),
      ]);
      if (Number(obj(a).total ?? -1) !== Number(obj(b).total ?? -2)) {
        throw new Error(`partner ${p.label}: copy holds ${obj(b).total} records, source ${obj(a).total} — NOT a copy`);
      }
    }
    return { opportunities: copies, program_id: programId };
  });
  const newProgram = int(records.program_id)!;
  put(src.program_id, newProgram);
  for (const [f, t] of Object.entries(obj(records.opportunities))) put(f, t);
  const newOpps = src.partners.map((p) => map[String(p.source_opportunity_id)]);
  const sourceIds = new Set<number>([src.program_id, ...src.partners.map((p) => p.source_opportunity_id)]);

  // 2. The registry, copied and retargeted.
  if (src.registry_id) {
    const reg = await step('registry', async () => {
      const regProgram = int(obj(cascade.registry).program_id) ?? src.program_id;
      const got = obj(await call('semantic_registry_get', { registry_id: src.registry_id, program_id: regProgram }));
      const docs = remapSyntheticProducts({ properties_doc: got.properties_doc, indicators_doc: got.indicators_doc, deployment: got.deployment }, map).products as Record<string, unknown>;
      const regName = `${s(got.name) ?? 'registry'} (${tag})`;
      const made = await labsCreate(
        'registry',
        async () => {
          const { registries } = obj(await call('semantic_registry_list', { program_id: newProgram })) as { registries?: unknown };
          return oneNamed(`registries named "${regName}" in labs program ${newProgram}`, arr(registries).map(obj).filter((r) => r.name === regName));
        },
        async () => {
          const r = obj(await call('semantic_registry_create', {
            name: regName,
            description: s(got.description) ?? '',
            program_id: newProgram,
            is_shared: false,
            properties_doc: docs.properties_doc,
            indicators_doc: docs.indicators_doc,
            deployment: docs.deployment ?? {},
          }));
          const id = int(r.id ?? r.registry_id);
          if (!id) throw new Error('semantic_registry_create returned no id');
          return { id: String(id) };
        },
      );
      return { registry_id: int(made.id)!, adopted: made.adopted };
    });
    put(src.registry_id, reg.registry_id);
    sourceIds.add(src.registry_id);
  }

  // 3. The programme report, from the same template, with the source configuration.
  const pr = obj(cascade.programme_report);
  const srcPr = int(pr.workflow_id);
  if (!srcPr) throw new LabsCopyStepError('programme_report', 'the source records no cascade.programme_report.workflow_id');
  const report = await step('programme_report', async () => {
    const def = obj(await call('workflow_get', { workflow_id: srcPr, program_id: src.program_id, include_render_code: false }));
    const key = s(def.template_type);
    if (!key) throw new Error(`source workflow ${srcPr} has no template_type — cannot instantiate the same template`);
    const wfName = s(def.name);
    let made: Record<string, any> | null = null;
    const got = await labsCreate(
      'programme_report',
      async () => {
        // The program is this clone's own (step 1 made it), so a workflow of this
        // template — and this name, when the source has one — is this clone's.
        const { workflows } = obj(await call('workflow_list', { program_id: newProgram, kind: 'workflow' })) as { workflows?: unknown };
        const hits = arr(workflows).map(obj).filter((w) => w.template_type === key && (!wfName || w.name === wfName));
        return oneNamed(`"${key}" workflows${wfName ? ` named "${wfName}"` : ''} in labs program ${newProgram}`, hits);
      },
      async () => {
        made = obj(await call('workflow_create_from_template', {
          template_key: key,
          program_id: newProgram,
          opportunity_ids: newOpps,
          ...(map[String(src.registry_id)] ? { registry_source: { registry_id: map[String(src.registry_id)] } } : {}),
          ...(wfName ? { name: wfName } : {}),
          config: portableConfig(def.config, new Set([...sourceIds, srcPr, ...labsIdsIn(synthetic)])),
        }));
        const id = int(made.workflow_id);
        if (!id) throw new Error('workflow_create_from_template returned no workflow_id');
        return { id: String(id) };
      },
    );
    const id = int(got.id)!;
    let pipelineId: number | null;
    let companion: Record<string, any>;
    if (made) {
      const m = made as Record<string, any>;
      pipelineId = int(m.pipeline_id);
      companion = obj(obj(m.companions).worker_review);
    } else {
      // Adopted: the create's reply is gone, so read what it would have said.
      // Companion links live in the definition's config under their config key
      // (connect-labs `companion_links`); the pipeline is its visits source.
      const have = obj(await call('workflow_get', { workflow_id: id, program_id: newProgram, include_render_code: false }));
      const sources = arr(have.pipeline_sources).map(obj);
      pipelineId = int((sources.find((p) => p.alias === 'visits') ?? sources[0])?.pipeline_id);
      companion = obj(obj(have.config).worker_review);
    }
    return {
      workflow_id: id,
      pipeline_id: pipelineId,
      worker_review: { workflow_id: int(companion.workflow_id), run_id: int(companion.run_id) },
      source_pipeline_sources: arr(def.pipeline_sources),
      adopted: got.adopted,
    };
  });
  put(srcPr, report.workflow_id);
  const srcWr = obj(cascade.worker_review);
  put(srcWr.workflow_id, obj(report.worker_review).workflow_id);
  put(srcWr.run_id, obj(report.worker_review).run_id);
  put(obj(obj(synthetic.workflows).worker_review).workflow_id, obj(report.worker_review).workflow_id);

  // 3b. The visits pipeline carries the source's schema (the template's has Connect's base columns only).
  const srcPipe = int(cascade.visits_pipeline_id) ?? int(obj(arr(report.source_pipeline_sources).map(obj).find((p) => p.alias === 'visits')).pipeline_id);
  if (srcPipe) {
    const pipe = await step('pipeline', async () => {
      const def = obj(await call('workflow_get', { workflow_id: report.workflow_id, program_id: newProgram, include_render_code: false }));
      const srcAlias = s(obj(arr(report.source_pipeline_sources).map(obj).find((p) => int(p.pipeline_id) === srcPipe)).alias) ?? 'visits';
      const tgt = int(obj(arr(def.pipeline_sources).map(obj).find((p) => p.alias === srcAlias)).pipeline_id) ?? int(report.pipeline_id);
      if (!tgt) throw new Error(`the new report has no "${srcAlias}" pipeline`);
      const want = obj(await call('pipeline_get', { pipeline_id: srcPipe, program_id: src.program_id }));
      const have = obj(await call('pipeline_get', { pipeline_id: tgt, program_id: newProgram }));
      if (JSON.stringify(want.schema) !== JSON.stringify(have.schema)) {
        await call('pipeline_update_schema', { pipeline_id: tgt, program_id: newProgram, schema: want.schema, expected_version: have.version });
      }
      return { pipeline_id: tgt };
    });
    put(srcPipe, pipe.pipeline_id);
  }

  // 4. Cohort + opp reports (before history, so hand-down has somewhere to go).
  const srcCohort = int(cascade.cohort_id);
  if (srcCohort) {
    const cohort = await step('cohort', async () => {
      const lc = obj(await call('labs_context', { search: tag.replace(/^ace /, '') }));
      const org = arr(lc.organizations).map(obj).find((o) => o.name === orgName);
      const slug = s(org?.slug);
      if (!slug) throw new Error(`labs_context finds no organisation named "${orgName}" — read the slug, never derive it (ace#2522)`);
      const cohortName = `${programName} (${tag})`;
      const cohortMade = await labsCreate(
        'cohort',
        async () => {
          const { cohorts } = obj(await call('benchmarks_cohort_list', { organization_id: slug })) as { cohorts?: unknown };
          return oneNamed(`cohorts named "${cohortName}" in ${slug}`, arr(cohorts).map(obj).filter((c) => c.name === cohortName));
        },
        async () => {
          const c = obj(await call('benchmarks_cohort_create', { name: cohortName, organization_id: slug, min_peers: 2, min_denominator: 1, require_complete_series: false }));
          const id = int(c.id ?? c.cohort_id);
          if (!id) throw new Error('benchmarks_cohort_create returned no id');
          return { id: String(id) };
        },
      );
      const cid = int(cohortMade.id)!;
      // Adding members and making opp reports are idempotent (the latter
      // reports `skipped` for an opp that already has one), so an adopted
      // cohort just runs through them again.
      await call('benchmarks_cohort_add_opportunities', { cohort_id: cid, opportunity_ids: newOpps });
      const srcOppReport = int(obj(arr(cascade.opp_reports)[0]).workflow_id);
      const oppTemplate = srcOppReport
        ? s(obj(await call('workflow_get', { workflow_id: srcOppReport, opportunity_id: int(obj(arr(cascade.opp_reports)[0]).opportunity_id), include_render_code: false })).template_type)
        : null;
      const made = obj(await call('benchmarks_create_opp_reports', {
        cohort_id: cid,
        template_key: oppTemplate ?? 'indicator_opp_report',
        source_workflow_id: report.workflow_id,
        source_program_id: newProgram,
      }));
      const reports: Record<string, number> = {};
      for (const x of [...arr(made.created), ...arr(made.skipped)].map(obj)) {
        const o = int(x.opportunity_id);
        const w = int(x.workflow_id);
        if (o && w) reports[String(o)] = w;
      }
      return { cohort_id: cid, org_slug: slug, opp_reports: reports };
    });
    put(srcCohort, cohort.cohort_id);
    put(obj(cascade.benchmark_publications).cohort_id, cohort.cohort_id);
    for (const r of arr(cascade.opp_reports).map(obj)) {
      const newOpp = map[String(int(r.opportunity_id))];
      put(r.workflow_id, obj(cohort.opp_reports)[String(newOpp)]);
    }
  }

  // 5. Saved history over the SOURCE's window — computed from the copied records.
  const srcHistory = await allHistoryRuns(call, { definition_id: srcPr, program_id: src.program_id });
  if (srcHistory.length) {
    await step('history', async () => {
      const starts = srcHistory.map((r) => String(r.period_start ?? r.period_end ?? '').slice(0, 10)).filter(Boolean).sort();
      const ends = srcHistory.map((r) => String(r.period_end ?? '').slice(0, 10)).filter(Boolean).sort();
      const end = ends[ends.length - 1];
      let start: string | null = starts[0];
      for (let guard = 0; start && guard < 40; guard++) {
        let r = obj(await call('workflow_rebuild_history', { definition_id: report.workflow_id, program_id: newProgram, cadence: 'weekly', start, end, limit: 13 }));
        r = obj(await followJob(call, r, sleep));
        start = r.done === false ? s(r.next_start) : null;
      }
      return { start: starts[0], end };
    });
    const tgtHistory = await allHistoryRuns(call, { definition_id: report.workflow_id, program_id: newProgram });
    const runs = mapRunsByPeriod(srcHistory, tgtHistory);
    if (runs.missing.length) throw new LabsCopyStepError('history', `the copy has no saved run for ${runs.missing.join(', ')}`);
    Object.assign(map, runs.map);

    // The opp reports' handed-down runs (queued by the rebuild — give them a moment).
    for (const r of arr(cascade.opp_reports).map(obj)) {
      const srcW = int(r.workflow_id);
      const srcO = int(r.opportunity_id);
      const tgtW = srcW ? map[String(srcW)] : undefined;
      if (!srcW || !srcO || !tgtW) continue;
      const tgtO = map[String(srcO)];
      const want = await allHistoryRuns(call, { definition_id: srcW, opportunity_id: srcO });
      let got = mapRunsByPeriod(want, []);
      for (let i = 0; i < 10; i++) {
        got = mapRunsByPeriod(want, await allHistoryRuns(call, { definition_id: tgtW, opportunity_id: tgtO }));
        if (!got.missing.length) break;
        await sleep(30_000);
      }
      if (got.missing.length) throw new LabsCopyStepError('hand_down', `opp report ${tgtW} has no handed-down run for ${got.missing.join(', ')}`);
      Object.assign(map, got.map);
    }

    // 6. Benchmarks: one publish per saved run, oldest first; the latest last.
    const pubs = obj(cascade.benchmark_publications);
    const cohortId = map[String(srcCohort ?? 0)];
    if (cohortId && (int(pubs.first) || int(pubs.last))) {
      const pub = await step('benchmarks', async () => {
        const ordered = [...tgtHistory].filter((r) => int(r.run_id ?? r.id)).sort((a, b) => String(a.period_end).localeCompare(String(b.period_end)));
        const done = obj(steps.benchmarks_partial) as Record<string, number>;
        let retried = false;
        for (const r of ordered) {
          const runId = int(r.run_id ?? r.id)!;
          if (done[String(runId)]) continue;
          done[String(runId)] = await publishWithRetry(call, { cohort_id: cohortId, workflow_id: report.workflow_id, run_id: runId, program_id: newProgram }, sleep, () => { retried = true; });
          steps.benchmarks_partial = done;
          await save(state);
        }
        const last = ordered[ordered.length - 1];
        // A transient failure mid-sequence published out of order: the tab shows the
        // most recently PUBLISHED as-of, so the latest period goes last again.
        if (retried && last) done[String(int(last.run_id ?? last.id))] = await publishWithRetry(call, { cohort_id: cohortId, workflow_id: report.workflow_id, run_id: int(last.run_id ?? last.id)!, program_id: newProgram }, sleep, () => {});
        const ids = ordered.map((r) => done[String(int(r.run_id ?? r.id))]).filter(Boolean);
        return { first: ids[0], last: ids[ids.length - 1], count: ids.length };
      });
      put(pubs.first, pub.first);
      put(pubs.last, pub.last);
    }

    // 7. A copy is verified AS a copy: every period's graded figures equal the source's.
    await step('verify', async () => {
      const a = await allHistoryRuns(call, { definition_id: srcPr, program_id: src.program_id, include_snapshot: true });
      const b = await allHistoryRuns(call, { definition_id: report.workflow_id, program_id: newProgram, include_snapshot: true });
      const bad = figureMismatches(a, b);
      if (bad.length) throw new Error(`the copy's figures differ from the source's (${bad.length}): ${bad.slice(0, 5).join('; ')}`);
      return { periods: a.length };
    });
  }

  // 8. Workspace roles — the one step with no MCP atom (connect-labs#2572).
  const llos = ctx.keepSharedConnect ? [] : [ctx.tenancy.connect_holding_org, ctx.tenancy.connect_pm_org].filter((x): x is string => !!x);
  const ws = await step('workspace', async () => {
    if (!llos.length) return { llos: [] as string[] };
    const r = await deps.workspace(newProgram, [...new Set(llos)]);
    if (!r.ok) throw new Error(`workspace roles not set (${r.detail}) — needs the /ace:labs-login session; there is no labs MCP atom for workspace roles (connect-labs#2572). Run scripts/labs-workspace-setup.ts --program-id ${newProgram} ${llos.map((l) => `--llo ${l}`).join(' ')} and rerun`);
    return { llos: r.llos };
  });

  // 9. Rewrite the products; refuse to leave a source id behind.
  const remapped = remapSyntheticProducts(synthetic, Object.fromEntries(Object.entries(map).map(([k, v]) => [Number(k), v])));
  if (remapped.leftover.length) {
    throw new LabsCopyStepError('products', `source ids still referenced after the copy: ${remapped.leftover.join(', ')} — each needs a counterpart in clone.labs.copy.id_map`);
  }
  const prRun = map[String(int(pr.run_id) ?? 0)] ?? null;
  return {
    status: 'done',
    program_id: newProgram,
    org_slug: s(obj(steps.cohort).org_slug),
    opportunity_ids: newOpps,
    registry_id: map[String(src.registry_id ?? 0)] ?? null,
    programme_report: { workflow_id: report.workflow_id, run_id: prRun },
    workspace: { llos: arr(ws.llos) },
    from: { program_id: src.program_id, opportunity_ids: src.partners.map((p) => p.source_opportunity_id) },
    copy: state,
    synthetic: remapped.products,
  };
}

/** A long-running labs tool answers with a job reply; follow it with `job_status` to its result. */
export async function followJob(call: LabsCall, reply: unknown, sleep: (ms: number) => Promise<void>, maxPolls = 240): Promise<unknown> {
  let r = obj(reply);
  if (!r.job_id || r.poll_with !== 'job_status') return reply;
  for (let i = 0; i < maxPolls; i++) {
    await sleep(5_000);
    const st = obj(await call('job_status', { job_id: r.job_id }));
    if (st.state === 'succeeded') return st.result ?? {};
    if (st.state === 'failed' || st.state === 'cancelled') throw new Error(`job ${String(r.job_id)} ${String(st.state)}: ${String(st.error ?? st.status ?? '')}`);
    r = { ...r, ...st };
  }
  throw new Error(`job ${String(r.job_id)} still running after ${maxPolls} polls — rerun to resume`);
}

/** `benchmarks_publish` with up to 3 attempts on a transient (gateway / non-JSON) failure. */
async function publishWithRetry(call: LabsCall, args: Record<string, unknown>, sleep: (ms: number) => Promise<void>, onRetry: () => void): Promise<number> {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = obj(await call('benchmarks_publish', args));
      const id = int(r.publication_id);
      if (!id) throw new Error('benchmarks_publish returned no publication_id');
      return id;
    } catch (e) {
      if (attempt >= 3 || !isAmbiguousError(e) && !/non-JSON|Unexpected token|<html/i.test(String((e as Error).message))) throw e;
      onRetry();
      await sleep(10_000 * attempt);
    }
  }
}
