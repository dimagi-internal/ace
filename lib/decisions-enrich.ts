/**
 * The deterministic half of the decisions review contract (schema v6,
 * `docs/decisions-contract.md`).
 *
 * The build memo used to tell a reviewer four things the register did not
 * (owner comparison on spark-facilitator/20261001-2208, 2026-10-03): which
 * values only THEY can settle, where each rule is enforced and at what scope,
 * which rows are ACE's own test harness, and which inherited rows are stale.
 * Those all have a right answer in run_state + decisions.yaml, so they are
 * computed here rather than left to model diligence:
 *
 *   - `stampRow`            row-local: `audience: internal` for harness rows,
 *                           `scope`/`enforcement` (+ a `plain` line) for rule
 *                           rows, `check_at` from a `Spot-check:` sentence.
 *                           Applied at the write boundary on every append.
 *   - `dedupeCrossSkill`    one question asked by two skills with one answer
 *                           (`learn-…-ampersand-verbatim` / `deliver-…`) folds
 *                           into one live row that cites both.
 *   - `deriveReviewAsks`    `review_ask: recommended-confirmation` on every
 *                           [PROPOSED] program parameter the build picked, every
 *                           machine-translated working language, every
 *                           enforcement `gap`, every OPEN row, and every open
 *                           residual in `run_state.phases.*.residuals` that a
 *                           person must decide (synthesizing a row when no row
 *                           carries it — the whole-group photo refusal lived
 *                           only in run_state on 20261001-2208).
 *
 * `enrichDecisionsLog` runs all three; it is idempotent (a second pass changes
 * nothing) and never touches a row a human already ruled on.
 *
 * Pure; no I/O. Callers: `lib/decisions-write.ts` (stampRow), the
 * `decisions_enrich` atom (mcp/decisions-server.ts), and
 * `scripts/backfill-decisions-contract.ts`.
 */

import { PHASE_DEFS } from './artifact-manifest.js';
import {
  spotCheckPlaceFromReasoning,
  classifyRuleRow,
  humanDate,
  isInternalDecision,
  joinAnd,
  languageName,
  normalizeQuestion,
  plainForRule,
  plainLanguageFindings,
  plainText,
  plainValueFor,
  rec,
  ruleOf,
  str,
} from './decision-review.js';
import {
  DECISIONS_SCHEMA_VERSION,
  type DecisionRow,
  type DecisionsLog,
} from './decisions-schema.js';

type Rec = Record<string, unknown>;

// ── Row-local stamps ───────────────────────────────────────────────────────

/**
 * Fill the review fields a row's own content decides. Never overwrites a
 * field the producer set. Returns the names of the fields it filled.
 */
export function stampRow(row: DecisionRow): string[] {
  const filled: string[] = [];
  if (row.audience === undefined && isInternalDecision(row)) {
    row.audience = 'internal';
    filled.push('audience');
  }
  const rule = classifyRuleRow(row as unknown as Rec);
  if (rule) {
    if (row.scope === undefined && row.enforcement === undefined) {
      row.scope = rule.scope;
      row.enforcement = rule.enforcement;
      filled.push('scope', 'enforcement');
    }
    if (row.plain === undefined) {
      row.plain = plainForRule(rule);
      filled.push('plain');
    }
  }
  if (row.plain_value === undefined) {
    const v = plainValueFor(row.override ?? row['ai-default'], `${row.question} ${row.source}`);
    if (v) {
      row.plain_value = v;
      filled.push('plain_value');
    }
  }
  if (row.check_at === undefined && row.reasoning) {
    const at = spotCheckPlaceFromReasoning(row.reasoning);
    if (at) {
      row.check_at = at;
      filled.push('check_at');
    }
  }
  return filled;
}

// ── Cross-skill duplicates ─────────────────────────────────────────────────

function effective(row: DecisionRow): string {
  return row.override ?? row['ai-default'];
}

export interface DedupeResult {
  /** `[kept id, folded id]` pairs. */
  folded: Array<[string, string]>;
}

/**
 * Fold live rows that ask the SAME question (normalized text) from DIFFERENT
 * skills with the SAME effective answer into the first of them. The folded
 * row is history (`superseded_by` the kept row); the kept row lists the other
 * skills in `also_raised_by`. Different answers are a real disagreement and
 * are left alone.
 */
export function dedupeCrossSkill(rows: DecisionRow[]): DedupeResult {
  const folded: Array<[string, string]> = [];
  const groups = new Map<string, DecisionRow[]>();
  for (const r of rows) {
    if (r.superseded_by !== undefined) continue;
    const k = `${normalizeQuestion(r.question)}\u0000${effective(r)}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  for (const group of groups.values()) {
    const skills = new Set(group.map((r) => r.skill));
    if (group.length < 2 || skills.size < 2) continue;
    const [kept, ...rest] = group;
    for (const dup of rest) {
      if (dup.skill === kept.skill) continue;
      dup.superseded_by = kept.id;
      kept.also_raised_by = [...new Set([...(kept.also_raised_by ?? []), dup.skill])];
      for (const f of ['plain', 'check_at', 'correct_looks_like'] as const) {
        if (kept[f] === undefined && dup[f] !== undefined) kept[f] = dup[f];
      }
      if (dup.check_at && kept.check_at && dup.check_at !== kept.check_at && !kept.check_at.includes(dup.check_at)) {
        kept.check_at = `${kept.check_at}; ${dup.check_at}`;
      }
      folded.push([kept.id, dup.id]);
    }
  }
  return { folded };
}

// ── Review asks ────────────────────────────────────────────────────────────

const ASK = 'recommended-confirmation' as const;

function isProposed(status: unknown): boolean {
  return /^proposed$/i.test(str(status));
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

function phases(runState: unknown): Rec {
  return rec(rec(runState).phases);
}

export function programParameters(runState: unknown): Rec {
  return rec(rec(rec(rec(phases(runState)['idea-to-design']).products).pdd).program_parameters);
}

function connectProducts(runState: unknown): Rec {
  return rec(rec(rec(phases(runState)['connect-setup']).products).connect);
}

/** run_state phase key (agent name) → the `<N>-<name>` tag decision rows carry. */
export function phaseTagFor(phaseKey: string): string | null {
  const def = PHASE_DEFS.find((p) => p.agentName === phaseKey || p.key === phaseKey);
  return def ? def.folder : null;
}

function ordinal(tag: string): number {
  return Number(tag.split('-')[0]);
}

/** A row a person already ruled on carries no ask — they decided. */
function humanRuled(row: DecisionRow): boolean {
  return row.status === 'overridden' || row.status === 'human-decided';
}

/**
 * The live row that carries a parameter: the latest-phase match wins (the
 * Phase 4 row holds the value the build actually configured; the Phase 1 row
 * only proposed it).
 */
function findTarget(rows: DecisionRow[], patterns: RegExp[]): DecisionRow | undefined {
  for (const re of patterns) {
    const hits = rows.filter((r) => r.superseded_by === undefined && re.test(r.id));
    if (hits.length > 0) return [...hits].sort((a, b) => ordinal(b.phase) - ordinal(a.phase))[0];
  }
  return undefined;
}

export interface ReviewAsk {
  /** Row id the ask lands on (existing or synthesized). */
  id: string;
  /** Why — becomes `confirm_reason`. */
  reason: string;
  /** `plain` to use when the target row has none. */
  plain: string;
  /** `plain_question` to use when the target row has none. */
  plainQuestion?: string;
  /** `plain_value` to use (overrides a mechanically formatted one). */
  plainValue?: string;
  /** The row to append when no existing row carries the value. */
  synthesize?: DecisionRow;
  /** What produced the ask, for the report. */
  basis: string;
}

function synthRow(fields: {
  id: string;
  phase: string;
  skill: string;
  question: string;
  value: string;
  options?: string[];
  source: string;
  plain: string;
  reason: string;
  check_at?: string;
  plain_question?: string;
  value_set_by?: 'ace' | 'external';
  evidence_basis?: 'stated' | 'inferred';
}): DecisionRow {
  const options = fields.options ?? [fields.value];
  return {
    id: fields.id,
    phase: fields.phase,
    skill: fields.skill,
    question: fields.question,
    'ai-default': fields.value,
    options: options.includes(fields.value) ? options : [fields.value, ...options],
    source: fields.source,
    status: 'ai-default',
    value_set_by: fields.value_set_by ?? 'external',
    evidence_basis: fields.evidence_basis ?? 'stated',
    plain: fields.plain,
    review_ask: ASK,
    confirm_reason: fields.reason,
    ...(fields.check_at ? { check_at: fields.check_at } : {}),
    ...(fields.plain_question ? { plain_question: fields.plain_question } : {}),
  } as DecisionRow;
}

function slug(text: string, words = 6): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
      .split(/\s+/)
      .filter((w) => w && !STOP.has(w))
      .slice(0, words)
      .join('-') || 'item'
  );
}

const STOP = new Set(['a', 'an', 'the', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'is', 'are', 'no', 'when', 'with', 'by', 'it', 'its', 'be']);

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

function overlap(a: string, b: string): number {
  const A = tokens(a);
  const B = tokens(b);
  if (A.size === 0 || B.size === 0) return 0;
  let n = 0;
  for (const t of A) if (B.has(t)) n++;
  return n / Math.min(A.size, B.size);
}

/** Text that says a PERSON must settle this, not a later build step. */
const HUMAN_DECISION =
  /\bdesign decision\b|\bdecision (?:for|belongs)\b|\bfor (?:the )?(?:partner|design owner|operator|programme owner|reviewer)\b|\b(?:to|must|should) decide\b|\bsign[- ]?off\b|\bnative[- ]speaker\b|\bneeds?[- ]review\b|\bunreviewed\b/i;

const TRANSLATION = /\btranslat|\bnative[- ]speaker\b|\bneeds[- ]review\b/i;

export interface OpenResidual {
  phaseKey: string;
  what: string;
  whereToApply: string;
}

/**
 * Open residuals a person must settle, from every phase's `residuals`
 * (`{what, where_to_apply}`) and `open_residuals` (strings), minus those a
 * later phase lists as resolved, de-duplicated across phases.
 */
export function openResiduals(runState: unknown): OpenResidual[] {
  const out: OpenResidual[] = [];
  const resolved: string[] = [];
  for (const block of Object.values(phases(runState)).map(rec)) {
    for (const [k, v] of Object.entries(block)) {
      if (/^residuals_resolved/.test(k) && Array.isArray(v)) resolved.push(...v.map(str));
    }
  }
  for (const [phaseKey, raw] of Object.entries(phases(runState))) {
    const block = rec(raw);
    const items: Array<{ what: string; where: string }> = [];
    if (Array.isArray(block.residuals)) {
      for (const r of block.residuals) {
        if (typeof r === 'string') items.push({ what: r, where: '' });
        else items.push({ what: str(rec(r).what), where: str(rec(r).where_to_apply) });
      }
    }
    if (Array.isArray(block.open_residuals)) for (const r of block.open_residuals) items.push({ what: str(r), where: '' });
    for (const it of items) {
      if (!it.what) continue;
      if (!HUMAN_DECISION.test(`${it.what} ${it.where}`)) continue;
      if (resolved.some((r) => overlap(r, it.what) >= 0.6)) continue;
      const dup = out.find((o) => overlap(o.what, it.what) >= 0.6);
      if (dup) {
        if (!dup.whereToApply && it.where) dup.whereToApply = it.where;
        continue;
      }
      out.push({ phaseKey, what: it.what, whereToApply: it.where });
    }
  }
  return out;
}

function skillFromResidual(text: string, phaseKey: string): string {
  const m = /\b([a-z]+(?:-[a-z]+)+?)-(?:eval|qa)\s+R\d+\b/.exec(text);
  if (m) return m[1];
  return phaseKey;
}

function sentence(s: string): string {
  const t = s.trim();
  return /[.?!]$/.test(t) ? t : `${t}.`;
}

/**
 * Every review ask the run's own records imply. See the module header for the
 * sources; `docs/decisions-contract.md § What earns a review_ask` for the rule.
 */
export function deriveReviewAsks(runState: unknown, rows: DecisionRow[]): ReviewAsk[] {
  const asks: ReviewAsk[] = [];
  const live = rows.filter((r) => r.superseded_by === undefined);
  const pp = programParameters(runState);
  const conn = connectProducts(runState);
  const pu = rec((Array.isArray(conn.payment_units) ? conn.payment_units : [])[0]);
  const band = rec(pp.payment_rate_band);
  const unit = str(band.unit) || 'unit of work';

  const param = (
    basis: string,
    patterns: RegExp[],
    reason: (target: DecisionRow | undefined) => string,
    plain: string,
    synth: () => DecisionRow,
    plainQuestion?: string,
    plainValue?: string,
  ) => {
    const target = findTarget(rows, patterns);
    if (target && humanRuled(target)) return;
    const r = reason(target);
    const extra = { plainQuestion, plainValue };
    if (target) asks.push({ id: target.id, reason: r, plain, basis, ...extra });
    else {
      const row = synth();
      if (plainQuestion) row.plain_question = plainQuestion;
      if (plainValue) row.plain_value = plainValue;
      asks.push({ id: row.id, reason: r, plain, synthesize: row, basis, ...extra });
    }
  };

  // (1) [PROPOSED] program parameters the build picked a value for.
  if (isProposed(band.status)) {
    const cur = str(pu.currency) || str(band.currency);
    const amt = num(pu.amount);
    const range =
      num(band.min) !== null && num(band.max) !== null ? `${fmt(num(band.min)!)}–${fmt(num(band.max)!)} ${cur}` : '';
    param(
      'program_parameters.payment_rate_band: PROPOSED',
      [/(^|-)payment-amount(-|$)/, /(^|-)payment-rate(-|$)/],
      () =>
        amt !== null
          ? `The design marks the worker rate as proposed${range ? ` (${range} per ${unit})` : ''}; the build uses ${fmt(amt)} ${cur} as a placeholder, and Connect pays whatever figure is set.`
          : `The design marks the worker rate as proposed${range ? ` (${range} per ${unit})` : ''}, not agreed.`,
      amt !== null
        ? `Each worker is paid ${fmt(amt)} ${cur} per ${unit}.`
        : `The worker rate is proposed as ${range || 'a band'} per ${unit}.`,
      () =>
        synthRow({
          id: 'confirm-payment-rate',
          phase: '1-design',
          skill: 'idea-to-pdd',
          question: 'Confirm the proposed worker payment rate',
          value: amt !== null ? `${fmt(amt)} ${cur}` : range || 'proposed band',
          source: 'PDD § Program Parameters (payment_rate_band, PROPOSED)',
          plain: `The worker rate is proposed as ${range || 'a band'} per ${unit}.`,
          reason: `The design marks the worker rate as proposed${range ? ` (${range} per ${unit})` : ''}, not agreed.`,
        }),
      `What should a worker be paid per ${unit}?`,
      amt !== null ? `${fmt(amt)} ${cur}` : range || undefined,
    );
  }
  const llo = rec(pp.llo_payment_per_visit);
  if (isProposed(llo.status)) {
    const amt = num(pu.org_amount) ?? num(llo.amount);
    const cur = str(pu.currency) || str(llo.currency);
    const fig = amt !== null ? `${fmt(amt)} ${cur}` : 'the proposed figure';
    param(
      'program_parameters.llo_payment_per_visit: PROPOSED',
      [/(^|-)org-amount(-|$)/, /(^|-)llo-payment/],
      () => `The design marks the payment to the implementing organisation (${fig} per ${unit}) as proposed, not agreed.`,
      `The implementing organisation is paid ${fig} per ${unit}.`,
      () =>
        synthRow({
          id: 'confirm-organisation-payment',
          phase: '1-design',
          skill: 'idea-to-pdd',
          question: 'Confirm the proposed payment to the implementing organisation',
          value: fig,
          source: 'PDD § Program Parameters (llo_payment_per_visit, PROPOSED)',
          plain: `The implementing organisation is paid ${fig} per ${unit}.`,
          reason: `The design marks the payment to the implementing organisation (${fig} per ${unit}) as proposed, not agreed.`,
        }),
      `What should the implementing organisation be paid per ${unit}?`,
      amt !== null ? fig : undefined,
    );
  }
  const budget = rec(pp.total_budget);
  if (isProposed(budget.status) && num(budget.amount) !== null) {
    const fig = `${fmt(num(budget.amount)!)} ${str(budget.currency)}`.trim();
    param(
      'program_parameters.total_budget: PROPOSED',
      [/(^|-)total-budget(-|$)/, /budget-plausibility/],
      (t) =>
        t && ordinal(t.phase) >= 4
          ? `The design marks the total budget (${fig}) as proposed; the Connect opportunity was created with this figure.`
          : `The design marks the total budget (${fig}) as proposed, not agreed.`,
      `The total budget is ${fig}.`,
      () =>
        synthRow({
          id: 'confirm-total-budget',
          phase: '1-design',
          skill: 'idea-to-pdd',
          question: 'Confirm the proposed total budget',
          value: fig,
          source: 'PDD § Program Parameters (total_budget, PROPOSED)',
          plain: `The total budget is ${fig}.`,
          reason: `The design marks the total budget (${fig}) as proposed, not agreed.`,
        }),
      'What is the total budget for delivery?',
      fig,
    );
  }
  if (isProposed(pp.opportunity_dates_status) && str(pp.opportunity_start_date) && str(pp.opportunity_end_date)) {
    const span = `${str(pp.opportunity_start_date)} to ${str(pp.opportunity_end_date)}`;
    const humanSpan = `${humanDate(str(pp.opportunity_start_date))} to ${humanDate(str(pp.opportunity_end_date))}`;
    param(
      'program_parameters.opportunity_dates_status: PROPOSED',
      [/(^|-)opportunity-dates(-|$)/, /(^|-)opportunity-end-date(-|$)/],
      () => `The design marks the delivery dates (${humanSpan}) as proposed. Workers earn nothing for work recorded before the start date.`,
      `Delivery runs from ${humanSpan}.`,
      () =>
        synthRow({
          id: 'confirm-delivery-dates',
          phase: '1-design',
          skill: 'idea-to-pdd',
          question: 'Confirm the proposed delivery dates',
          value: span,
          source: 'PDD § Program Parameters (opportunity dates, PROPOSED)',
          plain: `Delivery runs from ${humanSpan}.`,
          reason: `The design marks the delivery dates (${humanSpan}) as proposed. Workers earn nothing for work recorded before the start date.`,
        }),
      'When should delivery start and end?',
      humanSpan,
    );
  }

  // (2) Machine-translated working languages.
  const langs = Array.isArray(pp.working_language) ? (pp.working_language as unknown[]).map(str) : [];
  const runtimeDefault = str(pp.app_runtime_default_language) || 'en';
  const translated = langs.filter((l) => l && l !== runtimeDefault && l !== 'en');
  if (translated.length > 0) {
    const names = joinAnd(translated.map(languageName));
    const reason =
      `The ${names} text was produced by AI and has not been reviewed by a native speaker` +
      (runtimeDefault === 'en' ? '; a worker who switches language sees the unreviewed text.' : '; workers see it as soon as the apps are installed.');
    param(
      `program_parameters.working_language: ${translated.join(', ')}`,
      [/(^|-)working-language(-|$)/, /translation/],
      () => reason,
      `The apps are written in English, with ${names} translations made by AI.`,
      () =>
        synthRow({
          id: 'translation-sign-off',
          phase: '3-commcare',
          skill: 'pdd-to-deliver-app',
          question: `Have the ${names} translations been reviewed by a native speaker?`,
          value: 'Not yet reviewed',
          options: ['Not yet reviewed', 'Reviewed and signed off'],
          source: 'PDD § Program Parameters (working_language)',
          plain: `The apps are written in English, with ${names} translations made by AI.`,
          reason,
        }),
      `Have the ${names} translations been checked by a native speaker?`,
      undefined,
    );
  }

  // (3) Enforcement gaps.
  for (const r of live) {
    if (r.enforcement !== 'gap' || humanRuled(r)) continue;
    asks.push({
      id: r.id,
      reason: 'Nothing in this build enforces this rule yet; decide how it will be enforced before any worker is paid.',
      plain: r.plain ?? 'A rule the design needs is not enforced yet.',
      plainQuestion: ruleOf(r) ? `How will the rule "${ruleOf(r)}" be enforced?` : undefined,
      basis: 'enforcement: gap',
    });
  }
  const v = rec(conn.verification);
  const intended = rec(pp.verification_flags).form_field_rules;
  if (
    Array.isArray(intended) &&
    intended.length > 0 &&
    num(v.form_field_rules_saved) === 0 &&
    !asks.some((a) => a.basis === 'enforcement: gap')
  ) {
    const rules = joinAnd(intended.map((f) => `"${str(rec(f).field)} = ${str(rec(f).equals)}"`));
    const reason =
      `Connect saved none of the ${intended.length} payment rules the design asks it to hold, so it treats every ` +
      `submitted record as payable; decide how they will be enforced before any worker is paid.`;
    asks.push({
      id: 'payment-rules-not-saved',
      reason,
      plain: `The payment rules ${rules} are not held by Connect on this opportunity.`,
      basis: 'products.connect.verification.form_field_rules_saved: 0',
      synthesize: synthRow({
        id: 'payment-rules-not-saved',
        phase: '4-connect',
        skill: 'connect-opp-setup',
        question: 'How will the payment rules be enforced when Connect did not save them?',
        value: 'Not enforced yet',
        options: ['Not enforced yet', 'Enforced elsewhere'],
        source: 'run_state products.connect.verification',
        plain: `The payment rules ${rules} are not held by Connect on this opportunity.`,
        reason,
        value_set_by: 'external',
      }),
    });
  }

  // (4) Rows the build left OPEN.
  for (const r of live) {
    if (humanRuled(r)) continue;
    if (!/^OPEN\b/.test(effective(r)) && !/^OPEN\b/.test(str(r.reasoning))) continue;
    if (asks.some((a) => a.id === r.id)) continue;
    asks.push({
      id: r.id,
      reason: 'The build left this open for a person to decide.',
      plain: r.plain ?? sentence(plainText(r.question)),
      basis: 'OPEN',
    });
  }

  // (5) Open residuals a person must settle.
  for (const res of openResiduals(runState)) {
    const text = `${res.what} ${res.whereToApply}`;
    if (TRANSLATION.test(text) && asks.some((a) => /working_language/.test(a.basis))) continue;
    const tag = phaseTagFor(res.phaseKey) ?? '3-commcare';
    const what = plainText(res.what);
    const where = plainText(res.whereToApply);
    const id = `open-question-${slug(what)}`;
    const existing = rows.find((r) => r.id === id);
    if (existing && humanRuled(existing)) continue;
    const owner = /\bdesign decision for ([^;.]+?)(?:[;.]|$)/i.exec(where)?.[1]?.trim();
    const reason = owner
      ? `Only ${owner.replace(/\s*\/\s*/g, ' and ')} can decide how this is handled; as built, the app has no way to handle it.`
      : sentence(where || 'The build recorded no fix; a person must decide how this is handled');
    asks.push({
      id,
      reason,
      plain: sentence(`Open question: ${what}`),
      plainQuestion: `How should this be handled: ${what.replace(/[.?]$/, '')}?`,
      basis: `run_state phases.${res.phaseKey} residual`,
      synthesize: synthRow({
        plain_question: `How should this be handled: ${what.replace(/[.?]$/, '')}?`,
        id,
        phase: tag,
        skill: skillFromResidual(res.what, res.phaseKey),
        question: `${what.replace(/[.?]$/, '')} — how should this be handled?`,
        value: 'Not decided — built as described',
        options: ['Not decided — built as described', 'Change the build'],
        source: `run_state phases.${res.phaseKey}.residuals`,
        plain: sentence(`Open question: ${what}`),
        reason,
        value_set_by: 'external',
        evidence_basis: 'inferred',
      }),
    });
  }

  return asks;
}

// ── The whole pass ─────────────────────────────────────────────────────────

export interface EnrichReport {
  /** `<id>: <fields>` for every row a stamp filled. */
  stamped: string[];
  /** `[kept, folded]` cross-skill duplicates. */
  folded: Array<[string, string]>;
  /** ids that now carry `review_ask` (new this pass). */
  asked: string[];
  /** ids of rows synthesized this pass. */
  appended: string[];
  /** Live partner rows that still have no `plain` (a producer's job). */
  missingPlain: string[];
  /** `plain` / `confirm_reason` text that fails the plain-language lint. */
  jargon: string[];
  /**
   * The structural gate over every reviewer-visible row
   * (`auditDecisionsPlainLanguage`). `fail` is a FAIL for the phase-end
   * render (skills/decisions-render step 1.5) and a release blocker
   * (`assessDecisionsPlainLanguage`), not a warning.
   */
  plainLanguageGate: PlainLanguageGateReport;
}

export interface EnrichOptions {
  runState: unknown;
}

/**
 * Apply every deterministic part of the review contract to a log. Mutates a
 * COPY and returns it. Idempotent.
 */
export function enrichDecisionsLog(input: DecisionsLog, opts: EnrichOptions): { log: DecisionsLog; report: EnrichReport } {
  const log: DecisionsLog = JSON.parse(JSON.stringify(input));
  const report: EnrichReport = {
    stamped: [],
    folded: [],
    asked: [],
    appended: [],
    missingPlain: [],
    jargon: [],
    plainLanguageGate: { verdict: 'pass', findings: [] },
  };

  for (const row of log.decisions) {
    if (row.superseded_by !== undefined) continue;
    const filled = stampRow(row);
    if (filled.length) report.stamped.push(`${row.id}: ${filled.join(', ')}`);
  }

  report.folded = dedupeCrossSkill(log.decisions).folded;

  const byId = new Map(log.decisions.map((r) => [r.id, r]));
  for (const ask of deriveReviewAsks(opts.runState, log.decisions)) {
    let row = byId.get(ask.id);
    if (!row && ask.synthesize) {
      row = ask.synthesize;
      log.decisions.push(row);
      byId.set(row.id, row);
      report.appended.push(row.id);
      report.asked.push(row.id);
      continue;
    }
    if (!row || row.superseded_by !== undefined) continue;
    if (row.review_ask === undefined) {
      row.review_ask = ASK;
      row.confirm_reason = ask.reason;
      report.asked.push(row.id);
    }
    if (row.plain === undefined) row.plain = ask.plain;
    if (row.plain_question === undefined && ask.plainQuestion) row.plain_question = ask.plainQuestion;
    if (ask.plainValue) row.plain_value = ask.plainValue;
  }

  report.plainLanguageGate = auditDecisionsPlainLanguage(log);
  const failures = report.plainLanguageGate.findings;
  report.missingPlain = failures.filter((f) => f.field === 'plain' && f.finding === MISSING).map((f) => f.id);
  report.jargon = failures.filter((f) => f.finding !== MISSING).map((f) => `${f.id}.${f.field}: ${f.finding}`);

  const usesV6 = log.decisions.some((r) =>
    ['review_ask', 'plain', 'plain_question', 'plain_value', 'check_at', 'correct_looks_like', 'audience', 'scope', 'enforcement', 'also_raised_by'].some(
      (f) => (r as Rec)[f] !== undefined,
    ),
  );
  if (usesV6) log.schema_version = DECISIONS_SCHEMA_VERSION;
  return { log, report };
}

/** The live rows that carry a review ask — what a reviewer must confirm. */
export function reviewAskRows(log: DecisionsLog): DecisionRow[] {
  return log.decisions.filter((r) => r.superseded_by === undefined && r.review_ask !== undefined);
}

// ── The plain-language gate ────────────────────────────────────────────────

/** Fields ace-web renders on a partner row (ace-web `decisionDisplay`, DecisionDetailFields). */
export const REVIEWER_VISIBLE_FIELDS = [
  'plain',
  'plain_question',
  'plain_value',
  'confirm_reason',
  'check_at',
  'correct_looks_like',
] as const;

const MISSING = 'missing';

export interface PlainLanguageGateFailure {
  /** Row id. */
  id: string;
  /** The producer skill that owes the fix. */
  skill: string;
  field: (typeof REVIEWER_VISIBLE_FIELDS)[number];
  /** `missing`, or `<kind>: "<token>"` from `plainLanguageFindings`. */
  finding: string;
}

/** The gate's verdict: `fail` iff any finding. */
export interface PlainLanguageGateReport {
  verdict: 'pass' | 'fail';
  findings: PlainLanguageGateFailure[];
}

/**
 * Is this row hidden from a partner? `audience: internal`, or — when the
 * producer omitted `audience` — a recognisably test-harness row. ace-web hides
 * these by default (`DecisionsReview.tsx` `isInternal`); the strict write
 * contract uses the same test.
 */
export function isReviewerHidden(row: DecisionRow): boolean {
  return row.superseded_by !== undefined || row.audience === 'internal' || (row.audience === undefined && isInternalDecision(row));
}

/**
 * The plain-language gate over a whole decisions log — every live, partner-
 * facing row, as the public run-summary page renders it:
 *
 *  1. `plain` is present (ace-web leads with it; without it the raw build
 *     `question` is the row's headline);
 *  2. `plain_value` is present whenever the value a reader would see is
 *     itself jargon — the AI default (un-overridden) failing
 *     `plainLanguageFindings` (`payable_slot in key plus Phase 4 rule`);
 *  3. no reviewer-visible field carries a field id, `=` expression, snake_case
 *     identifier, run id, platform record id, issue number, "Phase N" or ACE
 *     jargon (`plainLanguageFindings`, whose identifier shapes are the shared
 *     table in `lib/pdd-description-plain-language.ts`).
 *
 * Returns every finding with row id + field + token; no findings = pass. The
 * reproducer is spark-facilitator/20261001-2208 (fixture:
 * `test/fixtures/decisions-plain/`).
 */
export function auditDecisionsPlainLanguage(log: Pick<DecisionsLog, 'decisions'>): PlainLanguageGateReport {
  const out: PlainLanguageGateFailure[] = [];
  for (const row of log.decisions) {
    if (isReviewerHidden(row)) continue;
    const at = { id: row.id, skill: row.skill };
    if (row.plain === undefined || !row.plain.trim()) out.push({ ...at, field: 'plain', finding: MISSING });
    const overridden = row.override !== undefined;
    if (!overridden && row.plain_value === undefined) {
      const valueFindings = plainLanguageFindings(row['ai-default']);
      if (valueFindings.length) out.push({ ...at, field: 'plain_value', finding: `${MISSING} (the option reads ${valueFindings[0]})` });
    }
    for (const field of REVIEWER_VISIBLE_FIELDS) {
      const text = (row as Record<string, unknown>)[field];
      if (typeof text !== 'string') continue;
      for (const finding of plainLanguageFindings(text)) out.push({ ...at, field, finding });
    }
  }
  return { verdict: out.length ? 'fail' : 'pass', findings: out };
}

/** One line per failure, for a QA detail or a refusal message. */
export function describePlainLanguageGate(failures: readonly PlainLanguageGateFailure[]): string {
  return failures.map((f) => `${f.id}.${f.field}: ${f.finding}`).join('; ');
}
