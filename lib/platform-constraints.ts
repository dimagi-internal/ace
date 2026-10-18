/**
 * Connect platform constraints — the fast day-1 check of a PDD against how
 * Connect actually behaves (config/platform-constraints.yaml).
 *
 * ## Why
 *
 * kaduna-graduation/20261015-1411 (ace#3036) role-gated its 14 Learn modules
 * (9 FLW, 5 enumerator). Its PDD even asked the question — Flag F3, "Does
 * Connect require every Learn module to be completed?" — and parked it for "the
 * first device walk". Connect's source answers it in eight lines
 * (`OpportunityAccess.learn_progress`: completed / ALL LearnModules, and Learn is
 * complete only at 100%). The walk came after Phases 2-5 had built on the wrong
 * shape. This module turns those facts into a table lookup Phase 1 runs in
 * milliseconds, before `idea-to-pdd-eval`, so the restructuring decision is made
 * on day 1 instead of discovered on day 3.
 *
 * ## Shape
 *
 *   PDD § Program Parameters  ──deriveFacts──▶  facts  ──rule.when──▶  findings
 *                                                                 └─▶ decision rows
 *
 * Rules live in YAML so a new platform fact is a data change with a citation,
 * not code. The DERIVED facts (role count, "are any Learn modules hidden",
 * budget arithmetic) live here, in one function, because getting them subtly
 * wrong is silent — the YAML names them, never re-derives them.
 *
 * Pure: no network, no LLM. `loadPlatformConstraints()` reads one file once.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { SOURCE_CITATION_RE } from './decisions-schema.js';

// ── Types ────────────────────────────────────────────────────────────────

export type ConstraintSeverity = 'blocker' | 'warn';

export type FactValue = string | number | boolean | string[] | undefined;
export type Facts = Record<string, FactValue>;

export type PredicateOp =
  | 'eq' | 'ne' | 'in' | 'nin' | 'gt' | 'gte' | 'lt' | 'lte'
  | 'truthy' | 'falsy' | 'present' | 'absent';

export type Predicate =
  | { all: Predicate[] }
  | { any: Predicate[] }
  | { not: Predicate }
  | { fact: string; op: PredicateOp; value?: unknown };

export interface PlatformConstraintRule {
  id: string;
  severity: ConstraintSeverity;
  source: string[];
  fact: string;
  when: Predicate;
  question: string;
  plain_question: string;
  plain: string;
  options: string[];
  recommended: string;
  remedy: string;
}

export interface PlatformConstraintsConfig {
  connect_sha: string;
  rules: PlatformConstraintRule[];
}

export interface PlatformConstraintFinding {
  rule: PlatformConstraintRule;
  severity: ConstraintSeverity;
  /** The facts the rule's predicate read, with their values — the evidence. */
  evidence: Record<string, FactValue>;
}

// ── Loader ───────────────────────────────────────────────────────────────

const CONFIG_URL = new URL('../config/platform-constraints.yaml', import.meta.url);

/** Every fact name `deriveFacts` can produce. A rule naming anything else is a config error. */
export const KNOWN_FACTS = [
  'archetype',
  'worker_roles',
  'worker_role_count',
  'learn_module_visibility',
  'learn_modules_hidden_from_some_workers',
  'opportunity_structure',
  'learn_app_count',
  'deliver_app_count',
  'learn_apps_short_of_roles',
  'deliver_apps_short_of_roles',
  'payment_amounts_fractional',
  'daily_cap_per_flw',
  'payment_unit_count',
  'optional_only_payment_units',
  'mixed_optional_payment_units',
  'unpaid_deliver_forms_present',
  'entity_id_grain',
  'entity_grain_has_repeat_key',
  'paid_work_before_start',
  'budget_short_of_cohort',
  'passing_score_varies',
  'learn_app_reused',
  'learn_modules_change_after_launch',
  'verification_flags_request_auto_verify_cleared',
] as const;

function factNames(p: Predicate, out: Set<string> = new Set()): Set<string> {
  if ('all' in p) p.all.forEach((q) => factNames(q, out));
  else if ('any' in p) p.any.forEach((q) => factNames(q, out));
  else if ('not' in p) factNames(p.not, out);
  else out.add(p.fact);
  return out;
}

/** Structural validation; throws naming every problem. Exported for the config test. */
export function validatePlatformConstraints(cfg: PlatformConstraintsConfig): void {
  const problems: string[] = [];
  const seen = new Set<string>();
  const known = new Set<string>(KNOWN_FACTS);
  for (const r of cfg.rules ?? []) {
    const at = `rule ${r?.id ?? '?'}`;
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(r.id ?? '')) problems.push(`${at}: id must be kebab-case`);
    if (seen.has(r.id)) problems.push(`${at}: duplicate id`);
    seen.add(r.id);
    if (r.severity !== 'blocker' && r.severity !== 'warn') problems.push(`${at}: severity must be blocker|warn`);
    if (!Array.isArray(r.source) || r.source.length === 0) problems.push(`${at}: needs at least one source citation`);
    for (const s of r.source ?? []) {
      if (!SOURCE_CITATION_RE.test(s)) problems.push(`${at}: citation "${s}" is not <owner>/<repo>@<sha>:<path>:<line>`);
    }
    if (!Array.isArray(r.options) || r.options.length < 2) problems.push(`${at}: needs >= 2 remedy options`);
    if (!r.options?.includes(r.recommended)) problems.push(`${at}: recommended must be one of options`);
    for (const f of ['fact', 'question', 'plain_question', 'plain', 'remedy'] as const) {
      if (typeof r[f] !== 'string' || !r[f].trim()) problems.push(`${at}: missing ${f}`);
    }
    if (!r.when) problems.push(`${at}: missing when`);
    else for (const f of factNames(r.when)) if (!known.has(f)) problems.push(`${at}: unknown fact "${f}"`);
  }
  if (problems.length) throw new Error(`config/platform-constraints.yaml is invalid:\n  ${problems.join('\n  ')}`);
}

let cached: PlatformConstraintsConfig | undefined;

export function loadPlatformConstraints(path: string = fileURLToPath(CONFIG_URL)): PlatformConstraintsConfig {
  if (cached && path === fileURLToPath(CONFIG_URL)) return cached;
  const cfg = YAML.parse(readFileSync(path, 'utf8')) as PlatformConstraintsConfig;
  validatePlatformConstraints(cfg);
  if (path === fileURLToPath(CONFIG_URL)) cached = cfg;
  return cfg;
}

// ── Derived facts ────────────────────────────────────────────────────────

const MARKER = /\[[^\]]*\]/g;

function clean(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const s = v.replace(MARKER, '').trim();
  return s.length ? s : undefined;
}

function num(v: string | undefined): number | undefined {
  const s = clean(v);
  if (!s) return undefined;
  const m = s.replace(/(\d),(?=\d{3}\b)/g, '$1').match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : undefined;
}

function first(params: ReadonlyMap<string, string>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = clean(params.get(k));
    if (v !== undefined) return v;
  }
  return undefined;
}

const NONE = /^(none|no|n\/a|na|-|—|false|0)$/i;
const YES = /^(yes|true|y)\b/i;

function list(v: string | undefined): string[] {
  if (!v || NONE.test(v)) return [];
  return v.split(/\s*(?:[,;/]|\band\b)\s*/i).map((s) => s.trim()).filter(Boolean);
}

/**
 * `deliver_unit_map` grammar: `<payment unit>: <form>[?], <form>[?]; <unit>: ...`
 * — a trailing `?` marks an OPTIONAL deliver unit. Returns unit → [form, optional].
 */
export function parseDeliverUnitMap(v: string | undefined): Map<string, Array<{ form: string; optional: boolean }>> {
  const out = new Map<string, Array<{ form: string; optional: boolean }>>();
  const s = clean(v);
  if (!s) return out;
  for (const part of s.split(';')) {
    const m = part.match(/^\s*([^:]+?)\s*:\s*(.+)$/);
    if (!m) continue;
    const forms = m[2].split(',').map((f) => f.trim()).filter(Boolean)
      .map((f) => ({ form: f.replace(/\?$/, '').trim(), optional: f.endsWith('?') }));
    out.set(m[1].trim(), forms);
  }
  return out;
}

/**
 * The Connect checks automatic visit verification removes and clears (rule
 * verification-flags-off-under-auto-verify): the opportunity's GPS, duplicate
 * and location (minimum distance) flags, and a deliver unit's attachment
 * (photo) check. Matched as a whole word or as the leading/trailing part of a
 * snake_case id (`gps_within_radius`, `photo_required`), never inside a word.
 */
const AUTO_VERIFY_CLEARED_TERM =
  /(?<![a-z0-9])(?:gps|duplicates?|location|distance|radius|attachments?|photos?)(?![a-z0-9])/i;
/** A clause that negates itself declares the check OFF, not a request for it. */
const CLAUSE_NEGATION = /\b(?:no|not|off|none|without|false|disabled?)\b/i;
/** Clauses naming Connect settings automatic verification leaves alone. */
const KEPT_UNDER_AUTO_VERIFY = /^\s*(?:form[_ ]field[_ ]rules|duration|form[_ ]submission)/i;

/**
 * `verification_flags` asks for a check Connect clears under automatic visit
 * verification. Deliberately simple: split the value into clauses on `;`, `,`
 * and newlines; a clause counts when it names one of the cleared checks, does
 * not negate itself ("no photo check", "duplicate flag off"), and is not a
 * form-field-rule / duration / submission-window clause (those settings
 * survive). `undefined` when the row is absent.
 */
export function verificationFlagsRequestAutoVerifyCleared(v: string | undefined): boolean | undefined {
  const s = clean(v);
  if (s === undefined) return undefined;
  if (NONE.test(s)) return false;
  return s
    .split(/[;,\n]/)
    .some((c) => AUTO_VERIFY_CLEARED_TERM.test(c) && !CLAUSE_NEGATION.test(c) && !KEPT_UNDER_AUTO_VERIFY.test(c));
}

/** Visibility values that mean every worker sees every Learn module. */
const ALL_WORKERS = /^(all[- ]?workers|all|every[- ]?worker|everyone|ungated)$/i;

/**
 * Turn § Program Parameters (+ the declared archetype) into the facts the
 * rules read. Every fact is `undefined` when its inputs are absent, so a
 * rule over an undeclared value never fires on a guess.
 */
export function deriveFacts(params: ReadonlyMap<string, string>, archetype?: string): Facts {
  const roles = list(first(params, ['worker_roles']));
  // A role property, or a head-count for a second worker type, means more than
  // one role even when `worker_roles` was never written — kaduna declared
  // `role_property` and `enumerator_count`, not `worker_roles`.
  const secondRole =
    first(params, ['role_property']) !== undefined ||
    ['enumerator_count', 'supervisor_count', 'second_role_count'].some((k) => (num(params.get(k)) ?? 0) > 0);
  const workerRoleCount = roles.length > 0 ? roles.length : secondRole ? 2 : 1;

  const visibility = first(params, ['learn_module_visibility'])?.toLowerCase();
  const structureRaw = first(params, ['opportunity_structure'])?.toLowerCase();
  const structure = structureRaw === undefined ? undefined : /per[- ]?role/.test(structureRaw) ? 'per-role' : 'single';
  const learnApps = num(params.get('learn_app_count')) ?? 1;
  const deliverApps = num(params.get('deliver_app_count')) ?? 1;
  const perRoleApps = structure === 'per-role' && learnApps >= workerRoleCount;

  const hiddenCount = num(params.get('learn_hidden_modules')) ?? 0;
  const hidden =
    !perRoleApps &&
    ((visibility !== undefined && !ALL_WORKERS.test(visibility)) || hiddenCount > 0);

  const amounts = ['payment_rate_min', 'payment_rate_max', 'flw_payment_per_visit', 'llo_payment_per_visit', 'org_payment_per_visit']
    .map((k) => num(params.get(k)))
    .filter((n): n is number => n !== undefined);

  const dum = parseDeliverUnitMap(params.get('deliver_unit_map'));
  const optionalOnly = [...dum].filter(([, fs]) => fs.length > 0 && fs.every((f) => f.optional)).map(([u]) => u);
  const mixed = [...dum].filter(([, fs]) => fs.some((f) => f.optional) && fs.some((f) => !f.optional)).map(([u]) => u);
  const puCount = num(params.get('payment_unit_count')) ?? (dum.size > 0 ? dum.size : undefined);

  const unpaid = first(params, ['unpaid_deliver_forms']);
  const grain = first(params, ['entity_id_grain']);

  const start = first(params, ['opportunity_start_date']);
  const puStart = first(params, ['payment_unit_start_date']);
  const early =
    YES.test(first(params, ['paid_work_before_start']) ?? '') ||
    (start !== undefined && puStart !== undefined && /^\d{4}-\d{2}-\d{2}/.test(start) && /^\d{4}-\d{2}-\d{2}/.test(puStart) && puStart.slice(0, 10) > start.slice(0, 10));

  const flwPay = num(params.get('flw_payment_per_visit')) ?? num(params.get('payment_rate_min'));
  const lloPay = num(params.get('llo_payment_per_visit')) ?? num(params.get('org_payment_per_visit')) ?? 0;
  const budget = num(params.get('total_budget')) ?? num(params.get('total_budget_usd'));
  const target = num(params.get('campaign_target_visits'));
  const cohort = num(params.get('flw_count_max'));
  const cap = num(params.get('total_cap_per_flw'));
  let budgetShort: boolean | undefined;
  if (budget !== undefined && flwPay !== undefined) {
    const need = target !== undefined ? target * (flwPay + lloPay) : cohort !== undefined && cap !== undefined ? cohort * cap * (flwPay + lloPay) : undefined;
    if (need !== undefined) budgetShort = budget < need;
  }

  const scoreRaw = clean(params.get('learn_passing_score'));
  const scoreNumbers = scoreRaw ? scoreRaw.match(/\d+(?:\.\d+)?/g) ?? [] : [];
  const passingVaries =
    new Set(scoreNumbers).size > 1 || first(params, ['learn_passing_score_by_role']) !== undefined;

  return {
    archetype,
    worker_roles: roles.length ? roles : undefined,
    worker_role_count: workerRoleCount,
    learn_module_visibility: visibility,
    learn_modules_hidden_from_some_workers: hidden,
    opportunity_structure: structure,
    learn_app_count: learnApps,
    deliver_app_count: deliverApps,
    learn_apps_short_of_roles: learnApps < workerRoleCount,
    deliver_apps_short_of_roles: deliverApps < workerRoleCount,
    payment_amounts_fractional: amounts.some((n) => !Number.isInteger(n)),
    daily_cap_per_flw: num(params.get('daily_cap_per_flw')),
    payment_unit_count: puCount,
    optional_only_payment_units: optionalOnly.length ? optionalOnly : undefined,
    mixed_optional_payment_units: mixed.length ? mixed : undefined,
    unpaid_deliver_forms_present: unpaid !== undefined && !NONE.test(unpaid),
    entity_id_grain: grain,
    entity_grain_has_repeat_key:
      grain === undefined
        ? undefined
        : /\b(date|day|daily|week|month|period|round|visit (?:number|uuid|id)|number|uuid|session|tranche|cycle|sequence|trigger|activity key|instance)\b|\+/i.test(grain),
    paid_work_before_start: early,
    budget_short_of_cohort: budgetShort,
    passing_score_varies: passingVaries,
    learn_app_reused: /reuse|existing/i.test(first(params, ['learn_app_source']) ?? ''),
    learn_modules_change_after_launch: YES.test(first(params, ['learn_modules_change_after_launch']) ?? ''),
    verification_flags_request_auto_verify_cleared: verificationFlagsRequestAutoVerifyCleared(params.get('verification_flags')),
  };
}

// ── Evaluation ───────────────────────────────────────────────────────────

function isPresent(v: FactValue): boolean {
  return v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0);
}

function isTruthy(v: FactValue): boolean {
  return Array.isArray(v) ? v.length > 0 : Boolean(v);
}

export function evaluate(p: Predicate, facts: Facts, read: Record<string, FactValue> = {}): boolean {
  if ('all' in p) return p.all.every((q) => evaluate(q, facts, read));
  if ('any' in p) return p.any.some((q) => evaluate(q, facts, read));
  if ('not' in p) return !evaluate(p.not, facts, read);
  const v = facts[p.fact];
  read[p.fact] = v;
  switch (p.op) {
    case 'present': return isPresent(v);
    case 'absent': return !isPresent(v);
    case 'truthy': return isTruthy(v);
    case 'falsy': return !isTruthy(v);
    case 'eq': return v === p.value;
    case 'ne': return v !== p.value;
    case 'in': return Array.isArray(p.value) && p.value.includes(v);
    case 'nin': return Array.isArray(p.value) && !p.value.includes(v);
    case 'gt': return typeof v === 'number' && v > Number(p.value);
    case 'gte': return typeof v === 'number' && v >= Number(p.value);
    case 'lt': return typeof v === 'number' && v < Number(p.value);
    case 'lte': return typeof v === 'number' && v <= Number(p.value);
  }
}

export function checkPlatformConstraints(
  params: ReadonlyMap<string, string>,
  archetype?: string,
  cfg: PlatformConstraintsConfig = loadPlatformConstraints(),
): PlatformConstraintFinding[] {
  const facts = deriveFacts(params, archetype);
  const out: PlatformConstraintFinding[] = [];
  for (const rule of cfg.rules) {
    const evidence: Record<string, FactValue> = {};
    if (evaluate(rule.when, facts, evidence)) out.push({ rule, severity: rule.severity, evidence });
  }
  return out;
}

function show(v: FactValue): string {
  return Array.isArray(v) ? `[${v.join(', ')}]` : v === undefined ? 'absent' : String(v);
}

export function describeFinding(f: PlatformConstraintFinding): string {
  const ev = Object.entries(f.evidence).map(([k, v]) => `${k}=${show(v)}`).join(', ');
  return `[${f.severity.toUpperCase()}] ${f.rule.id}: ${f.rule.fact} (PDD: ${ev}; source: ${f.rule.source[0]})`;
}

// ── Findings → decision rows ─────────────────────────────────────────────

/** Row id for a rule's finding — stable, so a re-run supersedes rather than duplicates. */
export function platformDecisionId(ruleId: string): string {
  return `platform-${ruleId}`;
}

/**
 * The decisions.yaml row a finding becomes: the remedy options as `options`,
 * the safe default as `ai-default`, and — because the fact was read in source —
 * `kind: platform-behaviour` already `resolved_by: source` with the pinned
 * citation. A blocker is `required-before` go-live (the PDD as written cannot
 * launch); a warn is a `recommended-confirmation`.
 */
export function findingToDecisionRow(f: PlatformConstraintFinding): Record<string, unknown> {
  const r = f.rule;
  const blocker = f.severity === 'blocker';
  return {
    id: platformDecisionId(r.id),
    phase: '1-design',
    skill: 'idea-to-pdd-qa',
    kind: 'platform-behaviour',
    question: r.question,
    plain_question: r.plain_question,
    'ai-default': r.recommended,
    options: r.options,
    reasoning: `${r.fact} Remedy: ${r.remedy}`,
    source: r.source.join('; '),
    status: 'ai-default',
    value_set_by: 'ace',
    evidence_basis: 'stated',
    plain: r.plain,
    review_ask: blocker ? 'required-before' : 'recommended-confirmation',
    ...(blocker ? { needed_by: 'go-live' } : {}),
    confirm_reason: blocker
      ? 'The design as first written cannot work on the platform, so the build uses the safe choice until someone confirms it.'
      : 'The platform behaves in a way the design should confirm it expects.',
    owner: 'dimagi',
    answer_channel: 'review',
    resolved_by: 'source',
    resolution_citation: r.source.join('; '),
  };
}
