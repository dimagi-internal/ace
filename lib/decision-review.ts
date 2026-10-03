/**
 * What a reviewer needs from a decision row — computed, not judged.
 *
 * `decisions.yaml` is the run's review surface (owner decision 2026-10-03:
 * "get rid of the build memo and improve decisions so it serves the same
 * purpose"). The build memo used to carry four things the register did not:
 * which choices a reviewer must confirm, where each rule is enforced and AT
 * WHAT SCOPE, which rows are ACE's own test harness, and plain wording for an
 * outside reader. The parts of that with a right answer live here, so every
 * producer, the write boundary (`lib/decisions-write.ts`), the enrichment pass
 * (`lib/decisions-enrich.ts`) and the backfill script share one computation.
 *
 * The rule-scope logic MOVED here from `lib/build-memo-compose.ts` (its
 * `ruleScope` / `enforcementPoints` / `rescopeRuleRow`). The case it exists
 * for: spark-facilitator/20260926-1800 credited the per-worker caps ("at most
 * 1 payable meeting per CBF per day", "total cap 21 per CBF") to app form
 * checks. Those checks are keyed on the COMMUNITY case, so they cannot bound a
 * worker across communities; only Connect's payment-unit `max_daily` /
 * `max_total` do. Scope is decidable from the rule text and the enforcement
 * point, so it is computed, not left to the producer.
 *
 * Field contract: `docs/decisions-contract.md`. Pure; no I/O.
 */

// ── Shared helpers ─────────────────────────────────────────────────────────

type Rec = Record<string, unknown>;

export function rec(v: unknown): Rec {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {};
}

export function str(v: unknown): string {
  if (v === null || v === undefined) return '';
  return typeof v === 'string' ? v.trim() : String(v);
}

export function joinAnd(xs: string[]): string {
  return xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

// ── Rule rows: scope and enforcement ───────────────────────────────────────

/**
 * connect-opp-setup's rule rows ask exactly this question. The quoted rule is
 * the PDD's wording, kept verbatim.
 */
export const RULE_QUESTION = /^Where is the PDD verification rule '(.+)' enforced\?$/;

/** The quoted PDD rule a rule row is about, or null for any other row. */
export function ruleOf(row: { question?: unknown }): string | null {
  const m = RULE_QUESTION.exec(str(row.question));
  return m ? m[1] : null;
}

export type RuleScope = 'per-worker' | 'per-case' | 'unscoped';

const WORKER_NOUN = '(?:CBF|worker|FLW|facilitator|user|enumerator|CHW|health worker|volunteer)s?';
const CASE_NOUN =
  '(?:community|communities|household|case|beneficiary|child|village|client|patient|mother|farmer|school)s?';

/** Is the rule a limit on a WORKER, or on one case (community, household…)? */
export function ruleScope(rule: string): RuleScope {
  if (new RegExp(`\\bper\\s+${WORKER_NOUN}\\b|_per_flw\\b`, 'i').test(rule)) return 'per-worker';
  if (new RegExp(`\\b(?:per|each|every)\\s+${CASE_NOUN}\\b`, 'i').test(rule)) return 'per-case';
  return 'unscoped';
}

export type PointKind =
  | 'connect-payment-unit'
  | 'connect-verification'
  | 'app-form'
  | 'off-platform'
  | 'not-applied'
  | 'unknown';

export interface EnforcementPoint {
  kind: PointKind;
  text: string;
}

/** The enforcement points a `Where applied` text names, in the order it names them. */
export function enforcementPoints(whereApplied: string): EnforcementPoint[] {
  const segs = whereApplied
    .split(/;\s+|\.\s+(?=[A-Z])|,?\s+(?:also|backed by)\s+/i)
    .map((s) => s.trim().replace(/^(?:also|and)\s+/i, '').trim())
    .filter(Boolean);
  const out: EnforcementPoint[] = [];
  for (const text of segs) {
    let kind: PointKind = 'unknown';
    if (/not configurable on connect\s*—\s*not applied/i.test(text)) kind = 'not-applied';
    else if (/not configurable on connect/i.test(text)) kind = 'off-platform';
    else if (/payment unit|max_daily|max_total|\bPU\b/i.test(text)) kind = 'connect-payment-unit';
    else if (/form_field_rules|deliver_unit_checks|submission window|verification rule/i.test(text))
      kind = 'connect-verification';
    else if (/\bCCZ\b|\bapp\b|\bform\b|date check|clamp|constraint|case list|entity_key|required bind/i.test(text))
      kind = 'app-form';
    out.push({ kind, text });
  }
  return out;
}

function caseNoun(text: string, fallback = 'record'): string {
  const m = new RegExp(`\\b(${CASE_NOUN})\\b`, 'i').exec(text);
  if (!m) return fallback;
  const n = m[1].toLowerCase();
  return n === 'communities' ? 'community' : n.replace(/s$/, '');
}

/** The contract's `scope` vocabulary (docs/decisions-contract.md). */
export type ContractScope = 'record' | 'entity' | 'worker' | 'programme';
/** The contract's `enforcement` vocabulary. */
export type ContractEnforcement = 'enforced' | 'by-design' | 'gap';

/**
 * A rule about a SHARE of all the work (a review sample, a call sample) holds
 * across the programme, not on one record.
 */
const PROGRAMME_RULE = /\d+\s*%|\bsample\b|\bof (?:all |the )?paid (?:meetings|visits|records)\b/i;

export function contractScope(rule: string): ContractScope {
  const s = ruleScope(rule);
  if (s === 'per-worker') return 'worker';
  if (s === 'per-case') return 'entity';
  return PROGRAMME_RULE.test(rule) ? 'programme' : 'record';
}

export interface RuleClassification {
  rule: string;
  scope: ContractScope;
  enforcement: ContractEnforcement;
  /** The enforcement points, per-worker scope corrected (payment limit first). */
  points: EnforcementPoint[];
  /**
   * Set when the producer credited a per-worker rule to an app check first.
   * Plain sentence; the scope correction the build memo used to make.
   */
  correction: string | null;
}

/**
 * Re-order a per-worker rule so its Connect payment-unit limit leads and the
 * app check is stated at its true (per-case) scope. Unchanged when nothing
 * needs correcting or there is no payment-unit point to lead with (a real gap
 * — `classifyRule` reports it as `gap`).
 */
export function rescopePoints(
  rule: string,
  points: EnforcementPoint[],
  defaultCase = 'record',
): { points: EnforcementPoint[]; correction: string | null } {
  if (ruleScope(rule) !== 'per-worker' || points[0]?.kind !== 'app-form') return { points, correction: null };
  const worker = points.filter((p) => p.kind === 'connect-payment-unit');
  if (worker.length === 0) return { points, correction: null };
  const rest = points.filter((p) => p.kind !== 'connect-payment-unit');
  const noun = caseNoun(`${rest.map((p) => p.text).join(' ')}`, defaultCase);
  return {
    points: [...worker, ...rest],
    correction:
      `The app check was listed first, but it only covers one ${noun}; ` +
      `Connect's payment limit is what holds this for each worker.`,
  };
}

/**
 * Scope + enforcement for one rule, from the rule text and where the producer
 * says it is applied (`ai-default` + `reasoning` of a rule row).
 *
 * - `gap`: the design needs the rule and nothing in the build holds it — a
 *   rule Connect refused (`Not configurable on Connect — not applied`), or a
 *   per-worker rule with no per-worker enforcement point.
 * - `by-design`: the design itself places the rule off the platform.
 * - `enforced`: a Connect rule, a Connect payment limit, or an app check holds
 *   it at its scope.
 *
 * Splitting `gap` from `by-design` is the point: on
 * spark-facilitator/20260926-1800 both read "Not configurable on Connect" and
 * the one real gap read as routine.
 */
export function classifyRule(rule: string, whereApplied: string, defaultCase = 'record'): RuleClassification {
  const raw = enforcementPoints(whereApplied);
  const { points, correction } = rescopePoints(rule, raw, defaultCase);
  const kinds = points.map((p) => p.kind);
  let enforcement: ContractEnforcement;
  if (kinds.includes('not-applied')) enforcement = 'gap';
  else if (kinds[0] === 'off-platform') enforcement = 'by-design';
  else if (ruleScope(rule) === 'per-worker' && !kinds.includes('connect-payment-unit')) enforcement = 'gap';
  else if (kinds.some((k) => k === 'connect-payment-unit' || k === 'connect-verification' || k === 'app-form'))
    enforcement = 'enforced';
  else enforcement = 'gap';
  return { rule, scope: contractScope(rule), enforcement, points, correction };
}

/** Classify a decision row, when it is a rule row. */
export function classifyRuleRow(row: Rec, defaultCase = 'record'): RuleClassification | null {
  const rule = ruleOf(row);
  if (!rule) return null;
  return classifyRule(rule, `${str(row['override'] ?? row['ai-default'])}. ${str(row.reasoning)}`, defaultCase);
}

const SCOPE_WORDS: Record<ContractScope, string> = {
  record: 'each record',
  entity: 'each case (one community, household or similar)',
  worker: 'each worker',
  programme: 'the programme as a whole',
};

function pointPhrase(p: EnforcementPoint): string {
  switch (p.kind) {
    case 'connect-payment-unit': {
      const daily = /max_daily\s*=?\s*:?\s*(\d+)/i.exec(p.text);
      const total = /max_total\s*=?\s*:?\s*(\d+)/i.exec(p.text);
      const parts = [
        daily ? `at most ${daily[1]} paid per worker per day` : '',
        total ? `at most ${total[1]} paid per worker in total` : '',
      ].filter(Boolean);
      return `Connect's payment limit${parts.length ? ` (${parts.join('; ')})` : ''}`;
    }
    case 'connect-verification':
      return 'a Connect payment rule';
    case 'app-form':
      return 'a check in the app';
    case 'off-platform':
      return 'a step outside Connect';
    default:
      return '';
  }
}

/**
 * The `plain` line for a rule row: what the rule limits and what holds it. The
 * quoted rule keeps the design's own words (quotes are exempt from the
 * plain-language lint).
 */
export function plainForRule(c: RuleClassification): string {
  const scopeWords = c.scope === 'entity' ? `each ${caseNoun(c.rule, 'case')}` : SCOPE_WORDS[c.scope];
  const head = `"${c.rule}" applies to ${scopeWords}`;
  if (c.enforcement === 'gap') return `${head}. Nothing in this build enforces it yet.`;
  if (c.enforcement === 'by-design') return `${head}. The design checks it outside Connect, by design.`;
  // One phrase per kind of enforcement point, the most specific one.
  const byKind = new Map<PointKind, string>();
  for (const p of c.points) {
    const phrase = pointPhrase(p);
    if (!phrase) continue;
    const prev = byKind.get(p.kind);
    if (!prev || phrase.length > prev.length) byKind.set(p.kind, phrase);
  }
  return `${head}, and is enforced by ${joinAnd([...byKind.values()].slice(0, 2)) || 'the build'}.`;
}

// ── Audience: ACE's own test harness is internal ───────────────────────────

/**
 * Skills whose rows are always about ACE's own test scaffolding (scenario
 * counts, smoke recipes, scroll methods), never about the programme.
 */
export const INTERNAL_SKILLS: ReadonlySet<string> = new Set([
  'app-test-cases',
  'app-screenshot-capture',
  'pdd-to-test-prompts',
  'pdd-to-app-journeys',
]);

/** Ids that name test-harness choices whatever skill wrote them. */
const INTERNAL_ID = /^(?:test-[a-z0-9-]+|[a-z0-9-]*smoke[a-z0-9-]*|[a-z0-9-]*-recipe[a-z0-9-]*|date-picker-[a-z0-9-]+|selector-[a-z0-9-]+)$/;

/**
 * Is this row ACE's test harness rather than a programme choice? The rows the
 * Spark memo moved out of its choices table (test-scenario-count,
 * test-archetype-coverage-rebuild, deliver-smoke-*,
 * date-picker-screen-scroll-method-rebuild, learn-smoke-long-lesson-walk) and
 * the OCS smoke-prompt count.
 */
export function isInternalDecision(row: { id?: unknown; skill?: unknown }): boolean {
  return INTERNAL_SKILLS.has(str(row.skill)) || INTERNAL_ID.test(str(row.id));
}

// ── Plain language ─────────────────────────────────────────────────────────

/** Text outside double-quoted spans — a quoted design rule keeps its own words. */
export function unquoted(text: string): string {
  return text.replace(/"[^"\n]*"|“[^”\n]*”/g, '""');
}

const JARGON: Array<[string, RegExp]> = [
  ['section reference (§)', /§/],
  ['issue reference', /\b(?:ace|ace-web|[\w-]+\/[\w-]+)#\d+\b|\bPR #\d+\b/],
  ['code identifier', /`[^`]*`|\b[a-z][a-z0-9]*_[a-z0-9_]+\b/],
  ['ACE build tag', /\[(?:ACE|FIXED|PROPOSED)\]/],
  ['ACE jargon', /\bPDD\b|\bdecisions\.yaml\b|\brun_state\b|\bCCZ\b|\bentity_id\b/],
  ['repo path', /\b(?:lib|skills|scripts|agents|mcp|bin)\/[\w./-]+/],
  ['skill name', /\b(?:pdd-to-[a-z-]+|connect-(?:opp|program)-setup|idea-to-pdd|app-test-cases|ocs-agent-setup|solicitation-create|[a-z]+(?:-[a-z]+)+-(?:eval|qa))\b/],
];

/**
 * Findings for text a programme partner reads (`plain`, `confirm_reason`):
 * no field ids, no §-refs, no ACE jargon. Quoted spans are exempt.
 */
export function plainLanguageFindings(text: string): string[] {
  const t = unquoted(text);
  const out: string[] = [];
  for (const [label, re] of JARGON) {
    const m = re.exec(t);
    if (m) out.push(`${label}: ${JSON.stringify(m[0])}`);
  }
  if (/\n/.test(text)) out.push('more than one line');
  return out;
}

/** Strip internal identifiers from producer text (best effort, for derived text). */
export function plainText(s: string): string {
  return s
    .replace(/\bentity_(?:key|id)\b/g, 'de-duplication key')
    .replace(/`[^`]*`/g, '')
    .replace(/\s*[—-]\s*[a-z]+(?:-[a-z]+)+(?:-(?:eval|qa))?\s+R\d+\b/g, '')
    .replace(/\b[a-z]+(?:-[a-z]+)+-(?:eval|qa)\b(?:\s+R\d+)?/g, '')
    .replace(/\([^()]*(?:_|#|\/|\brow \d)[^()]*\)/g, '')
    .replace(/\b[a-z][a-z0-9]*_[a-z0-9_]+\b/g, '')
    .replace(/\(\s*[,;\s]*\)/g, '')
    .replace(/\bCCZ\b/g, 'the app')
    .replace(/\bPDD\b/g, 'design')
    .replace(/\bthe awarded LLOs?\b/g, 'the implementing organisation')
    .replace(/\bLLOs\b/g, 'implementing organisations')
    .replace(/\bLLO\b/g, 'implementing organisation')
    .replace(/§\s*[\d.]+/g, '')
    .replace(/\bace#\d+\b/g, '')
    .replace(/\[(?:ACE|FIXED|PROPOSED)\]/g, '')
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/\(\s*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/[\s,;—-]+$/g, '')
    .trim();
}

/**
 * `check_at` from a producer's `Spot-check: <where>.` sentence — the
 * convention every build producer already writes inside `reasoning`.
 * Underscored field ids are spaced out so the place reads as words.
 */
export function spotCheckPlaceFromReasoning(reasoning: string): string | null {
  const m = /Spot-check:\s*(.+?)\s*\.?\s*$/s.exec(reasoning);
  if (!m) return null;
  const where = m[1].replace(/\s+/g, ' ').replace(/_/g, ' ').trim();
  return where || null;
}

// ── Values for display ─────────────────────────────────────────────────────

const CURRENCY = /\b(MWK|USD|KES|UGX|TZS|NGN|GHS|ZAR|ZMW|RWF|ETB|XOF|XAF|INR|BDT|EUR|GBP)\b/;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** `2026-11-02` → `2 November 2026`; anything else unchanged. */
export function humanDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : iso;
}

/**
 * `ai-default` as a reader sees it: `7500` → `7,500 MWK` (currency from the
 * row's own question/source when it names one), `3276000 MWK` → `3,276,000
 * MWK`, `2026-11-02 to 2027-02-26` → `2 November 2026 to 26 February 2027`.
 * Returns null when formatting would change nothing.
 */
export function plainValueFor(value: string, context = ''): string | null {
  const v = value.trim();
  let out = v;
  const bare = /^(\d{4,})$/.exec(v);
  const withCur = /^(\d{4,})\s+([A-Z]{3})$/.exec(v);
  if (withCur) out = `${Number(withCur[1]).toLocaleString('en-US')} ${withCur[2]}`;
  else if (bare) {
    const cur = CURRENCY.exec(context)?.[1];
    out = `${Number(bare[1]).toLocaleString('en-US')}${cur ? ` ${cur}` : ''}`;
  } else if (/\d{4}-\d{2}-\d{2}/.test(v)) {
    out = v.replace(/(?:PDD dates\s+)?(\d{4}-\d{2}-\d{2})/g, (_m, d: string) => humanDate(d));
  }
  out = out.replace(/\s*\[(?:PROPOSED|ACE|FIXED)\]/g, '').trim();
  return out === v ? null : out;
}

// ── Languages ──────────────────────────────────────────────────────────────

export const LANGUAGE_NAMES: Record<string, string> = {
  nya: 'Chichewa',
  ny: 'Chichewa',
  tum: 'Tumbuka',
  sw: 'Swahili',
  swa: 'Swahili',
  fr: 'French',
  fra: 'French',
  pt: 'Portuguese',
  por: 'Portuguese',
  hi: 'Hindi',
  hin: 'Hindi',
  am: 'Amharic',
  amh: 'Amharic',
  ha: 'Hausa',
  hau: 'Hausa',
  yo: 'Yoruba',
  yor: 'Yoruba',
  lg: 'Luganda',
  lug: 'Luganda',
  rw: 'Kinyarwanda',
  kin: 'Kinyarwanda',
  es: 'Spanish',
  spa: 'Spanish',
  ar: 'Arabic',
  ara: 'Arabic',
  bn: 'Bengali',
  ben: 'Bengali',
  so: 'Somali',
  som: 'Somali',
};

export function languageName(code: string): string {
  return LANGUAGE_NAMES[code] ?? code;
}

// ── Cross-skill duplicates ─────────────────────────────────────────────────

export function normalizeQuestion(q: string): string {
  return q
    .toLowerCase()
    .replace(/[^a-z0-9& ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
