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
 *    program (§ 4c, ace#3020). The copy is agent-run (MCP atoms, not this
 *    script), so the stage reports `not-done: run § 4c` until the agent
 *    records `clone.labs.status: done`; it never regenerates.
 */

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { parseAppReleaseSummary, releasedBuild } from './app-release-record.js';
import { connectCountryName } from './program-locale.js';

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

// ── Labs (ace#3020) ──────────────────────────────────────────────────

export interface LabsRebuildContext {
  source: CloneSource;
  sourceRunState: unknown;
  targetRunState: unknown;
  to: string;
  tenancy: Record<string, string | null | undefined>;
}

/**
 * Labs stage (`clone-to-new-workspace` § 4c, ace#3020). The design: COPY the
 * source's Phase 7 records into labs-only opps in ONE new program
 * (`synthetic_clone_to_labs_only`), copy its registry and instantiate the same
 * report templates there with the source configuration, then make the program
 * a labs workspace whose LLOs are the clone's Connect orgs — no allowlist is
 * ever widened, and nothing is regenerated (owner, 2026-10-16).
 *
 * The copy is possible (connect-labs#2574 shipped `program_id` on
 * `synthetic_clone_to_labs_only`) but is made through labs MCP atoms, which
 * this script cannot call. So the stage records an explicit `not-done`
 * pointing the agent at § 4c — never a silent skip (the old "Labs stays
 * Dimagi-only" was #3020's defect), never a false "atom gap" (ace#3038), and
 * never a regeneration standing in for the copy. Once the agent records
 * `clone.labs.status: done`, the planner treats the stage as final.
 */
export async function rebuildLabs(ctx: LabsRebuildContext): Promise<StageRecord> {
  const synthetic = obj(obj(obj(obj(ctx.sourceRunState).phases)['synthetic-data-and-workflows']).products).synthetic;
  if (!Object.keys(obj(synthetic)).length) {
    return { status: 'done', reason: 'source run has no Phase 7 synthetic products — nothing to rebuild' };
  }
  return {
    status: 'not-done',
    reason: 'labs copy is agent-run: do clone-to-new-workspace § 4c by hand (synthetic_clone_to_labs_only, first partner without program_id, later partners with it), then record clone.labs.status: done — never regenerated instead',
  };
}
