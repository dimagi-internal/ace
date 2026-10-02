//
// The DETERMINISTIC half of the run's build memo (`skills/build-memo`).
//
// build-memo-eval graded spark-facilitator/20260926-1800's memo 6.2 `warn`
// (2026-10-01). Five of its findings were not judgement calls — each had a
// right answer that run_state, decisions.yaml and the producers' own tables
// already held, and the composer (an LLM pass) got wrong:
//
//   (a) the memo was titled "run 20260925-1536" — the fork's SOURCE run. A
//       fork copies `4-connect/` whole, and with it a memo composed for a
//       different run; nothing re-derived the label from `run_state.run_id`.
//   (b) the per-worker caps ("at most 1 payable meeting per CBF per day",
//       "total cap 21 per CBF") were credited to app form checks. Those
//       checks are keyed on the COMMUNITY case, so they cannot bound a worker
//       across communities; only Connect's payment-unit `max_daily` /
//       `max_total` do. Scope is decidable from the rule text and the
//       enforcement point, so it is checked here, not judged.
//   (c) the body was written for ACE: skill names, decision ids, issue
//       numbers, file paths and un-glossed abbreviations.
//   (d) nothing told the reviewer what THEY must decide.
//   (e) the one real enforcement gap (Connect refused the verification rules,
//       `form_field_rules_saved: 0`, ace#2419) shared its label — "Not
//       configurable on Connect" — with rules the design places off the
//       platform on purpose.
//
// This module renders the parts with a right answer (header, "Decisions you
// own", "Known limitations", the rule-enforcement table, the appendix) and
// CHECKS the composed memo for each defect. The plain-language account of the
// build's choices stays the composer's job; `checkReviewerLanguage` gates it.
//
// Pure. Every check returns `{ ok, findings, detail }`.

// ── Shared helpers ─────────────────────────────────────────────────────────

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {};
}

function str(v: unknown): string {
  if (v === null || v === undefined) return '';
  return typeof v === 'string' ? v.trim() : String(v);
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function fmtNum(n: number): string {
  return n.toLocaleString('en-US');
}

function phases(runState: unknown): Rec {
  return rec(rec(runState).phases);
}

function connectProducts(runState: unknown): Rec {
  return rec(rec(rec(phases(runState)['connect-setup']).products).connect);
}

function programParameters(runState: unknown): Rec {
  return rec(rec(rec(rec(phases(runState)['idea-to-design']).products).pdd).program_parameters);
}

export interface MemoFinding {
  kind: string;
  detail: string;
}

export interface MemoReport {
  ok: boolean;
  findings: MemoFinding[];
  detail: string;
}

function report(findings: MemoFinding[], okDetail: string): MemoReport {
  return {
    ok: findings.length === 0,
    findings,
    detail: findings.length === 0 ? okDetail : findings.map((f) => `${f.kind}: ${f.detail}`).join('; '),
  };
}

/** The memo body a reviewer reads: everything before the appendix. */
export function memoBody(memo: string): string {
  const m = /^## Appendix\b/m.exec(memo);
  return m ? memo.slice(0, m.index) : memo;
}

// ── (a) Run identity ───────────────────────────────────────────────────────

const RUN_ID = /\b\d{8}-\d{4}\b/;

/** The CURRENT run id. Throws — a memo without one cannot be labelled. */
export function memoRunId(runState: unknown): string {
  const id = str(rec(runState).run_id);
  if (!RUN_ID.test(id)) throw new Error(`build-memo: run_state.run_id is missing or malformed (${JSON.stringify(id)})`);
  return id;
}

/** `# Build memo — <name> · run <run_id>`, always from run_state, never carried. */
export function renderMemoTitle(runState: unknown, displayName: string): string {
  const name = displayName.trim();
  if (!name) throw new Error('build-memo: display name is required for the title');
  return `# Build memo — ${name} · run ${memoRunId(runState)}`;
}

const PHASE_LABEL: Record<string, string> = {
  'idea-to-design': 'design',
  'scenarios-and-acceptance': 'test-scenario',
  'commcare-setup': 'app build',
  'connect-setup': 'Connect setup',
  'ocs-setup': 'chatbot setup',
  'qa-and-training': 'QA and training',
  'synthetic-data-and-workflows': 'demo data',
  'solicitation-management': 'solicitation',
  'execution-management': 'launch',
  closeout: 'closeout',
};
const PHASE_ORDER = Object.keys(PHASE_LABEL);

/**
 * One plain sentence on where this run came from. A fork's memo is the place a
 * reviewer most needs it: the apps they are asked to check may have been
 * built in another run.
 */
export function renderRunProvenance(runState: unknown): string {
  const id = memoRunId(runState);
  const src = str(rec(runState).forked_from);
  if (!src) return `This memo describes run ${id}.`;
  const at = str(rec(runState).forked_from_phase);
  const label = PHASE_LABEL[at];
  const builtBefore =
    at && PHASE_ORDER.indexOf(at) > PHASE_ORDER.indexOf('connect-setup')
      ? ' The apps and the Connect setup described here were built in that run and copied over unchanged.'
      : '';
  return (
    `This memo describes run ${id}, which was started as a copy (fork) of run ${src}` +
    (label ? `, re-running from the ${label} step onward.` : '.') +
    builtBefore
  );
}

/**
 * Every run label in the memo names the CURRENT run. A label is `run <id>` or
 * `<opportunity>/<id>`. The one other id allowed is the fork source, on a line
 * that says it is the source (`renderRunProvenance`). An opportunity NAME that
 * embeds a run id is not a label and is not matched.
 */
export function checkMemoRunLabel(memo: string, runState: unknown): MemoReport {
  const findings: MemoFinding[] = [];
  let id: string;
  try {
    id = memoRunId(runState);
  } catch (e) {
    return report([{ kind: 'no-run-id', detail: (e as Error).message }], '');
  }
  const opp = str(rec(runState).opportunity);
  const src = str(rec(runState).forked_from);
  const title = memo.split('\n').find((l) => /^# /.test(l)) ?? '';
  if (!title.includes(`run ${id}`)) {
    findings.push({ kind: 'title-wrong-run', detail: `title ${JSON.stringify(title)} does not name run ${id}` });
  }
  const label = new RegExp(
    `\\brun\\s+(\\d{8}-\\d{4})\\b${opp ? `|\\b${opp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\/(\\d{8}-\\d{4})\\b` : ''}`,
    'gi',
  );
  memo.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(label)) {
      const other = m[1] ?? m[2];
      if (other === id) continue;
      if (other === src && /\b(fork|copy|copied)\b/i.test(line)) continue;
      findings.push({ kind: 'foreign-run-label', detail: `line ${i + 1} names run ${other}, not ${id}: ${line.trim().slice(0, 120)}` });
    }
  });
  return report(findings, `every run label names ${id}`);
}

// ── (b) Where each rule is enforced, and at what scope ─────────────────────

export interface RuleRow {
  /** The rule as the PDD states it (quoted by the producer). */
  rule: string;
  pddSection: string;
  /** The producer's `Where applied` cell (or a decision's category + reasoning). */
  whereApplied: string;
  evidence: string;
  /** `phase4-table` (connect-opp-setup's memo section) or a decision row id. */
  source: string;
}

function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && line[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (c === '|') {
      cells.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  cells.push(cur.trim());
  return cells.slice(1, -1);
}

/**
 * The rows of connect-opp-setup's `Verification rules — where each is
 * applied` table, from its memo section (or any document quoting it).
 */
export function parsePhase4RuleTable(markdown: string): RuleRow[] {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => /^#{2,5}\s+Verification rules — where each is applied/.test(l));
  if (start < 0) return [];
  let i = start + 1;
  while (i < lines.length && !lines[i].trim().startsWith('|')) {
    if (/^#{1,5}\s/.test(lines[i])) return [];
    i++;
  }
  const header = splitRow(lines[i] ?? '').map((h) => h.toLowerCase());
  const col = (re: RegExp) => header.findIndex((h) => re.test(h));
  const cRule = col(/^rule/);
  const cSec = col(/pdd/);
  const cWhere = col(/where applied/);
  const cEv = col(/evidence/);
  if (cRule < 0 || cWhere < 0) return [];
  const rows: RuleRow[] = [];
  for (i += 2; i < lines.length && lines[i].trim().startsWith('|'); i++) {
    const c = splitRow(lines[i]);
    const cell = c[cRule] ?? '';
    const quoted = /^"([^"]+)"/.exec(cell);
    rows.push({
      rule: quoted ? quoted[1] : cell,
      pddSection: cSec >= 0 ? c[cSec] ?? '' : '',
      whereApplied: c[cWhere] ?? '',
      evidence: cEv >= 0 ? c[cEv] ?? '' : '',
      source: 'phase4-table',
    });
  }
  return rows;
}

/**
 * The LIVE decision rows: a row carrying `superseded_by` is history — a later
 * row corrected it — and must not drive the memo. A forked run inherits its
 * source's Phase 3/4 rows and corrects them with `supersedes:`; reading the
 * superseded ones surfaced a resolved OPEN ambiguity as a "Decision you own"
 * (spark-facilitator/20261001-2208, ace#2578).
 */
export function liveDecisionRows(decisions: readonly unknown[]): unknown[] {
  return decisions.filter((d) => rec(d).superseded_by === undefined);
}

/** Rule rows from connect-opp-setup's decision rows (`connect-rule-*`). */
export function ruleRowsFromDecisions(decisions: readonly unknown[]): RuleRow[] {
  const rows: RuleRow[] = [];
  for (const raw of liveDecisionRows(decisions)) {
    const d = rec(raw);
    const m = /^Where is the PDD verification rule '(.+)' enforced\?$/.exec(str(d.question));
    if (!m) continue;
    rows.push({
      rule: m[1],
      pddSection: str(d.source),
      whereApplied: `${str(d['ai-default'])}. ${str(d.reasoning)}`.trim(),
      evidence: '',
      source: str(d.id),
    });
  }
  return rows;
}

export type RuleScope = 'per-worker' | 'per-case' | 'unscoped';

const WORKER_NOUN = '(?:CBF|worker|FLW|facilitator|user|enumerator|CHW|health worker|volunteer)s?';
const CASE_NOUN = '(?:community|communities|household|case|beneficiary|child|village|client|patient|mother|farmer|school)s?';

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

/** The enforcement points a `Where applied` cell names, in the order it names them. */
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
    else if (/form_field_rules|deliver_unit_checks|submission window/i.test(text)) kind = 'connect-verification';
    else if (/\bCCZ\b|\bapp\b|\bform\b|date check|clamp|constraint|case list|entity_key|required bind/i.test(text)) kind = 'app-form';
    out.push({ kind, text });
  }
  return out;
}

/**
 * A per-worker rule must name a per-worker enforcement point FIRST — on
 * Connect, that is a payment unit's `max_daily` / `max_total`. An app form
 * check is keyed on the case the form is filled against, so crediting it with
 * a per-worker cap overstates it (spark-facilitator/20260926-1800 rows 47/48).
 * An app check may still be listed second, as supporting evidence.
 */
export function checkEnforcementScope(rows: readonly RuleRow[]): MemoReport {
  const findings: MemoFinding[] = [];
  for (const r of rows) {
    if (ruleScope(r.rule) !== 'per-worker') continue;
    const pts = enforcementPoints(r.whereApplied);
    const first = pts[0]?.kind;
    if (first === 'not-applied' || first === 'off-platform' || first === 'connect-payment-unit') continue;
    const hasWorkerPoint = pts.some((p) => p.kind === 'connect-payment-unit');
    findings.push({
      kind: hasWorkerPoint ? 'per-worker-rule-credited-to-app-check' : 'per-worker-rule-without-worker-enforcement',
      detail:
        `"${r.rule}" (${r.source}) is a per-worker rule but its enforcement is given as ` +
        `"${pts[0]?.text ?? r.whereApplied}"` +
        (hasWorkerPoint
          ? ' — an app check is keyed on one case; the Connect payment unit limit is what bounds a worker'
          : ' — nothing named bounds a worker across cases'),
    });
  }
  return report(findings, `${rows.length} rule row(s); every per-worker rule names a per-worker enforcement point first`);
}

function caseNoun(text: string, fallback = 'record'): string {
  const m = new RegExp(`\\b(${CASE_NOUN})\\b`, 'i').exec(text);
  if (!m) return fallback;
  const n = m[1].toLowerCase();
  return n === 'communities' ? 'community' : n.replace(/s$/, '');
}

/**
 * Re-order a per-worker rule so its Connect payment-unit limit leads and the
 * app check is stated at its true (per-case) scope. Returns the row unchanged
 * when nothing needs correcting, or when there is no payment-unit point to
 * lead with (that is a real gap — `checkEnforcementScope` reports it).
 */
export function rescopeRuleRow(row: RuleRow, defaultCase = 'record'): { row: RuleRow; correction: string | null } {
  if (ruleScope(row.rule) !== 'per-worker') return { row, correction: null };
  const pts = enforcementPoints(row.whereApplied);
  if (pts[0]?.kind !== 'app-form') return { row, correction: null };
  const worker = pts.filter((p) => p.kind === 'connect-payment-unit');
  if (worker.length === 0) return { row, correction: null };
  const app = pts.filter((p) => p.kind === 'app-form');
  const noun = caseNoun(`${app.map((p) => p.text).join(' ')} ${row.evidence}`, defaultCase);
  const whereApplied =
    worker.map((p) => p.text).join('; ') +
    ` (per worker). Supporting only: ${app.map((p) => p.text).join('; ')} — keyed on one ${noun}, so it does not limit a worker across ${noun === 'community' ? 'communities' : `${noun}s`}.`;
  return {
    row: { ...row, whereApplied },
    correction: `"${row.rule}": the producer credited "${app[0].text}" first; corrected to the Connect payment unit limit (per worker), with the app check kept as per-${noun} support.`,
  };
}

// ── (e) Known limitations ──────────────────────────────────────────────────

export interface Limitation {
  rule: string;
  kind: 'gap' | 'by-design';
  /** Plain-language: where it is enforced (by-design) or why it is not (gap). */
  text: string;
  refs: string[];
}

export interface LimitationSummary {
  gaps: Limitation[];
  byDesign: Limitation[];
  /** Verification rules the design asks Connect to hold. */
  rulesIntended: number;
  /** What Connect persisted (`form_field_rules_saved`), when recorded. */
  rulesSaved: number | null;
  /** The recorded reason, verbatim — for the appendix only. */
  rawReason: string;
}

/** Strip the internal identifiers from a producer cell for the memo body. */
export function plainText(s: string): string {
  return s
    .replace(/\bentity_(?:key|id)\b/g, 'de-duplication key')
    .replace(/`[^`]*`/g, '')
    .replace(/\([^()]*(?:_|#|\/|\brow \d)[^()]*\)/g, '')
    .replace(/\b[a-z][a-z0-9]*_[a-z0-9_]+\b/g, '')
    .replace(/\(\s*[,;\s]*\)/g, '')
    .replace(/\bCCZ\b/g, 'the app')
    .replace(/\bace#\d+\b/g, '')
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/\(\s*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/[\s,;—-]+$/g, '')
    .trim();
}

const GAP_CONSEQUENCE =
  'Until this is fixed, Connect treats every submitted record as payable work, up to the per-worker payment ' +
  'limits — including records these rules should exclude.';

/** What the run recorded as the way forward for a refused rule, in plain words. */
function plainGapOptions(raw: string): string {
  if (/phase 9|LLO opportunity|implementing organisation/i.test(raw)) {
    return (
      'The way forward the build recorded: set these rules on the implementing organisation\'s own opportunity at ' +
      'launch — or have Connect changed so this opportunity can hold them.'
    );
  }
  return '';
}

function plainNotAppliedReason(raw: string): string {
  if (!raw) return 'Connect did not save this rule for this opportunity.';
  if (/self-managed|is_opportunity_pm|requesting org != holding org/i.test(raw)) {
    return (
      'Connect refused to save verification rules on this opportunity, because it is managed by the same ' +
      'organisation that runs the programme; Connect only accepts them on an opportunity run by a separate ' +
      'implementing organisation.'
    );
  }
  return 'Connect did not save this rule for this opportunity.';
}

/**
 * Split every rule Connect does not enforce into a REAL gap (the design needs
 * it and nothing holds it) and rules the design itself places off Connect.
 * One label for both — "Not configurable on Connect" — is what let the gap
 * read as routine on spark-facilitator/20260926-1800.
 */
export function knownLimitations(runState: unknown, rows: readonly RuleRow[]): LimitationSummary {
  const v = rec(connectProducts(runState).verification);
  const rawReason = str(v.not_applied_reason);
  const intendedFlags = rec(programParameters(runState).verification_flags).form_field_rules;
  const intended = Array.isArray(intendedFlags) ? intendedFlags : [];
  const saved = num(v.form_field_rules_saved);
  const gaps: Limitation[] = [];
  const byDesign: Limitation[] = [];
  for (const r of rows) {
    const pts = enforcementPoints(r.whereApplied);
    if (pts.some((p) => p.kind === 'not-applied')) {
      gaps.push({
        rule: r.rule,
        kind: 'gap',
        text: `${plainNotAppliedReason(rawReason)} ${GAP_CONSEQUENCE}`,
        refs: [r.source],
      });
    } else if (pts[0]?.kind === 'off-platform') {
      const where = /applied (?:in|elsewhere)\s*\.?\s*(.*)$/i.exec(pts[0].text)?.[1] ?? '';
      const rest = pts.slice(1).map((p) => p.text).join('; ');
      byDesign.push({ rule: r.rule, kind: 'by-design', text: plainText(where || rest) || 'outside Connect', refs: [r.source] });
    }
  }
  if (gaps.length === 0 && intended.length > 0 && saved === 0) {
    for (const f of intended) {
      const fr = rec(f);
      gaps.push({
        rule: `${str(fr.field)} = ${str(fr.equals)}`,
        kind: 'gap',
        text: `${plainNotAppliedReason(rawReason)} ${GAP_CONSEQUENCE}`,
        refs: ['run_state: products.connect.verification'],
      });
    }
  }
  return { gaps, byDesign, rulesIntended: intended.length, rulesSaved: saved, rawReason };
}

export function renderKnownLimitations(lim: LimitationSummary): string {
  const out = ['## Known limitations — read first', ''];
  if (lim.gaps.length === 0) {
    out.push('**Not enforced anywhere yet:** none — every rule the design requires has an enforcement point.');
  } else {
    out.push(
      `**Not enforced anywhere yet — real gaps.** These are rules the design requires that nothing in this build ` +
        `enforces.` +
        (lim.rulesSaved !== null && lim.rulesIntended > 0
          ? ` Connect saved ${lim.rulesSaved} of the ${lim.rulesIntended} verification rules the design asks it to hold.`
          : ''),
      '',
    );
    const byText = new Map<string, string[]>();
    for (const g of lim.gaps) byText.set(g.text, [...(byText.get(g.text) ?? []), g.rule]);
    for (const [text, rules] of byText) out.push(`- ${joinAnd(rules.map((r) => `"${r}"`))} — ${text}`);
  }
  if (lim.byDesign.length > 0) {
    out.push(
      '',
      '**Checked outside Connect by design — not gaps.** The design itself places these off the platform:',
      '',
    );
    for (const b of lim.byDesign) out.push(`- "${b.rule}" — ${b.text}.`);
  }
  return out.join('\n');
}

// ── (d) Decisions you own ──────────────────────────────────────────────────

export interface ReviewerAsk {
  ask: string;
  why: string;
  /** Internal references — rendered in the appendix, never the body. */
  refs: string[];
}

const LANGUAGE_NAMES: Record<string, string> = {
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

function isProposed(status: unknown): boolean {
  return /^proposed$/i.test(str(status));
}

function joinAnd(xs: string[]): string {
  return xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

/**
 * The decisions the REVIEWER owns, from what the run recorded:
 *  - every program parameter the PDD marks PROPOSED that the build had to pick
 *    a value for (rate, organisation payment, budget, dates);
 *  - every real enforcement gap (one ask per shared cause);
 *  - every non-default working language, whose text is machine-translated and
 *    shown to workers until a speaker signs it off;
 *  - every Phase 3/4 decision row the build left OPEN.
 */
export function decisionsYouOwn(
  runState: unknown,
  decisions: readonly unknown[],
  lim: LimitationSummary,
): ReviewerAsk[] {
  const asks: ReviewerAsk[] = [];
  const pp = programParameters(runState);
  const conn = connectProducts(runState);
  const pus = Array.isArray(conn.payment_units) ? (conn.payment_units as unknown[]).map(rec) : [];
  const pu = pus[0] ?? {};
  const build = liveDecisionRows(decisions).map(rec).filter((d) => /^(3-commcare|4-connect)$/.test(str(d.phase)));
  const idsMatching = (re: RegExp) => build.map((d) => str(d.id)).filter((id) => re.test(id));

  const band = rec(pp.payment_rate_band);
  if (isProposed(band.status) && num(pu.amount) !== null) {
    const cur = str(pu.currency) || str(band.currency);
    const unit = str(band.unit) || 'unit of work';
    const range =
      num(band.min) !== null && num(band.max) !== null
        ? ` The design proposes ${fmtNum(num(band.min)!)}–${fmtNum(num(band.max)!)} ${cur}; the build uses ${fmtNum(num(pu.amount)!)} as a placeholder.`
        : ' The design gives no agreed rate; the build uses this figure as a placeholder.';
    asks.push({
      ask: `Accept or replace the worker payment of ${fmtNum(num(pu.amount)!)} ${cur} per ${unit}.`,
      why: `${range.trim()} Connect pays whatever figure is set here.`,
      refs: ['program_parameters.payment_rate_band', ...idsMatching(/payment-amount|payment-rate/)],
    });
  }
  const llo = rec(pp.llo_payment_per_visit);
  if (isProposed(llo.status) && num(pu.org_amount) !== null) {
    asks.push({
      ask: `Confirm the payment to the implementing organisation of ${fmtNum(num(pu.org_amount)!)} ${str(pu.currency) || str(llo.currency)} per ${str(band.unit) || 'unit of work'}.`,
      why: 'The design marks it as proposed, not agreed.',
      refs: ['program_parameters.llo_payment_per_visit'],
    });
  }
  const budget = rec(pp.total_budget);
  if (isProposed(budget.status) && num(budget.amount) !== null) {
    asks.push({
      ask: `Confirm the total budget of ${fmtNum(num(budget.amount)!)} ${str(budget.currency)}.`,
      why: 'The design marks it as proposed; the Connect opportunity was created with this figure.',
      refs: ['program_parameters.total_budget', ...idsMatching(/budget/)],
    });
  }
  if (isProposed(pp.opportunity_dates_status) && str(pp.opportunity_start_date) && str(pp.opportunity_end_date)) {
    asks.push({
      ask: `Confirm the delivery dates, ${str(pp.opportunity_start_date)} to ${str(pp.opportunity_end_date)}.`,
      why: 'The design marks them as proposed. Workers earn nothing for work recorded before the start date.',
      refs: ['program_parameters.opportunity_start_date', ...idsMatching(/opportunity-dates|end-date/)],
    });
  }

  const openRows = build.filter((d) => /^OPEN\b/.test(str(d.reasoning)) || /^OPEN\b/.test(str(d['ai-default'])));
  const verificationOpen = openRows.filter((d) => /verification|form[-_ ]field[-_ ]rules/i.test(`${str(d.id)} ${str(d.question)}`));
  if (lim.gaps.length > 0) {
    asks.push({
      ask: `Decide how ${joinAnd(lim.gaps.map((g) => `"${g.rule}"`))} will be enforced before any worker is paid.`,
      why: [
        'Connect cannot hold them on this opportunity (see Known limitations).',
        plainGapOptions(lim.rawReason),
        'This must be settled before launch.',
      ]
        .filter(Boolean)
        .join(' '),
      refs: [...new Set([...lim.gaps.flatMap((g) => g.refs), ...verificationOpen.map((d) => str(d.id))])],
    });
  }

  const langs = Array.isArray(pp.working_language) ? (pp.working_language as unknown[]).map(str) : [];
  const runtimeDefault = str(pp.app_runtime_default_language) || 'en';
  const translated = langs.filter((l) => l && l !== runtimeDefault && l !== 'en');
  if (translated.length > 0) {
    const names = translated.map((l) => LANGUAGE_NAMES[l] ?? l);
    asks.push({
      ask: `Have a native speaker review the machine-translated ${joinAnd(names)} text in both apps, and sign it off.`,
      why:
        'The translations were produced by AI and have not been reviewed by a speaker. ' +
        (runtimeDefault === 'en'
          ? 'The apps open in English; a worker who switches language sees the unreviewed text.'
          : 'Workers see them as soon as the apps are installed.'),
      refs: translated.map((l) => `program_parameters.working_language: ${l}`),
    });
  }

  for (const d of openRows) {
    if (verificationOpen.includes(d) && lim.gaps.length > 0) continue;
    asks.push({ ask: `Resolve: ${str(d.question)}`, why: plainText(str(d.reasoning).replace(/^OPEN\s*—\s*/, '')), refs: [str(d.id)] });
  }
  return asks;
}

export function renderDecisionsYouOwn(asks: readonly ReviewerAsk[]): string {
  const out = ['## Decisions you own', ''];
  if (asks.length === 0) {
    out.push('None — the build took no proposed value or open question that needs your decision.');
    return out.join('\n');
  }
  out.push('These are yours to make; the build could not settle them. Each is explained further down.', '');
  asks.forEach((a, i) => out.push(`${i + 1}. **${a.ask}** ${a.why}`));
  return out.join('\n');
}

// ── (c) Plain language ─────────────────────────────────────────────────────

/**
 * Abbreviations an outside reviewer may not know. A memo may use one only
 * where it is explained (`CBF (community-based facilitator)`, `… (CBF)`, or a
 * `CBF — …` entry in the Terms line).
 */
export const REVIEWER_ABBREVIATIONS = ['CCZ', 'CBF', 'FCAP', 'DU', 'PU', 'LLO', 'FLW', 'PDD', 'HQ', 'OCS', 'SEDO', 'FIYP'] as const;

/**
 * Expansions the PDD itself states, as `Expansion Words (ABBR)` — so the
 * Terms line quotes the partner's own words rather than ACE's guess.
 */
export function glossaryFromPdd(pddText: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of pddText.matchAll(/((?:[A-Z][A-Za-z'’-]*\s+){1,6})\(([A-Z]{2,6})(s?)\)/g)) {
    const abbr = m[2];
    const plural = m[3] === 's';
    const words = m[1].trim().split(/\s+/);
    const initials = abbr.split('');
    // keep the trailing words whose initials spell the abbreviation
    const tail = words.slice(-initials.length);
    const exp = tail.map((w) => w[0]).join('').toUpperCase() === abbr ? tail.join(' ') : '';
    if (exp && !out[abbr]) out[abbr] = plural ? exp.replace(/s$/, '') : exp;
  }
  return out;
}

export function renderTermsLine(text: string, glossary: Record<string, string>): string {
  const used = REVIEWER_ABBREVIATIONS.filter((a) => new RegExp(`\\b${a}s?\\b`).test(text) && glossary[a]);
  if (used.length === 0) return '';
  return `**Terms:** ${used.map((a) => `${a} — ${glossary[a]}`).join('; ')}.`;
}

export interface LanguageOptions {
  /** Skill directory names; a body that names one is written for ACE. */
  skillNames?: readonly string[];
  /** decisions.yaml ids; a body that cites one is written for ACE. */
  decisionIds?: readonly string[];
}

const INTERNAL_PATTERNS: Array<[string, RegExp]> = [
  ['issue-reference', /\b(?:ace|ace-web|[\w-]+\/[\w-]+)#\d+\b|\bPR #\d+\b/g],
  ['repo-path', /\b(?:lib|skills|scripts|agents|mcp|bin)\/[\w./-]+/g],
  ['run-folder-path', /\b\d-[a-z][a-z-]*\/[\w.-]+/g],
  ['run-state-key', /\bdecisions\.yaml\b|\brun_state(?:\.yaml)?\b|\bproducts\.[a-z_]+(?:\.[a-z_]+)*/g],
  ['decision-id', /\b[a-z0-9]+-(?:rule|latitude|ambiguity)-[a-z0-9-]+\b/g],
];

const MINOR_WORDS = new Set(['of', 'and', 'the', 'for', 'to', 'in', 'on', 'a', 'an']);

/**
 * Is `abbr` explained somewhere in `text`? Three forms count: an expansion in
 * parentheses after it (`CBF (community-based facilitator)`), a Terms entry
 * (`CBF — community-based facilitator`), or the expansion before it whose
 * initials spell it (`Facilitated Collective Action Process (FCAP)`). A bare
 * parenthetical — "captured at enrolment (CCZ)" — is a citation, not a gloss.
 */
export function isGlossed(text: string, abbr: string): boolean {
  if (new RegExp(`\\b${abbr}s?\\s+\\((?:the |a |an )?[A-Za-z][a-z]+[ -][A-Za-z]`).test(text)) return true;
  if (new RegExp(`\\b${abbr}\\s+—\\s+[A-Za-z][a-z]+[ -][A-Za-z]`).test(text)) return true;
  for (const m of text.matchAll(new RegExp(`\\(${abbr}s?\\)`, 'g'))) {
    const words = text
      .slice(Math.max(0, m.index - 120), m.index)
      .split(/[\s-]+/)
      .filter((w) => /^[A-Za-z]/.test(w) && !MINOR_WORDS.has(w.toLowerCase()));
    const initials = words.slice(-abbr.length).map((w) => w[0].toUpperCase()).join('');
    if (initials === abbr) return true;
  }
  return false;
}

/** Text outside double-quoted spans — a quoted PDD rule keeps the partner's own words. */
function unquoted(line: string): string {
  return line.replace(/"[^"\n]*"|“[^”\n]*”/g, '""');
}

/**
 * The memo BODY (before `## Appendix`) must read for a partner who has never
 * seen ACE: no skill names, decision ids, issue numbers, file paths or
 * run-state keys, no code identifiers outside quotes, and no un-explained
 * abbreviation. The appendix is where those references go.
 */
export function checkReviewerLanguage(memo: string, opts: LanguageOptions = {}): MemoReport {
  const body = memoBody(memo);
  const findings: MemoFinding[] = [];
  const seen = new Set<string>();
  const add = (kind: string, token: string, line: number) => {
    const key = `${kind}:${token}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ kind, detail: `line ${line}: ${token}` });
  };
  const skillRe =
    opts.skillNames && opts.skillNames.length
      ? new RegExp(`(?<![\\w/-])(?:${[...opts.skillNames].sort((a, b) => b.length - a.length).map((s) => s.replace(/[-]/g, '\\-')).join('|')})(?![\\w-])`, 'g')
      : /\b(?:pdd-to-[a-z-]+|connect-(?:opp|program)-setup|[a-z]+(?:-[a-z]+)*-(?:eval|qa))\b/g;
  const ids = new Set(opts.decisionIds ?? []);
  body.split('\n').forEach((raw, i) => {
    const line = unquoted(raw);
    for (const [kind, re] of INTERNAL_PATTERNS) for (const m of line.matchAll(re)) add(kind, m[0], i + 1);
    for (const m of line.matchAll(skillRe)) if (m[0].includes('-')) add('skill-name', m[0], i + 1);
    for (const m of line.matchAll(/`[^`\n]+`/g)) add('code-identifier', m[0], i + 1);
    for (const m of line.matchAll(/\b[a-z][a-z0-9]*_[a-z0-9_]+\b/g)) add('code-identifier', m[0], i + 1);
    for (const m of line.matchAll(/\b[a-z0-9]+(?:-[a-z0-9]+){2,}\b/g)) if (ids.has(m[0])) add('decision-id', m[0], i + 1);
  });
  for (const a of REVIEWER_ABBREVIATIONS) {
    const use = new RegExp(`\\b${a}s?\\b`);
    if (!use.test(body)) continue;
    if (!isGlossed(body, a)) {
      const line = body.split('\n').findIndex((l) => use.test(l)) + 1;
      add('unexplained-abbreviation', a, line);
    }
  }
  return report(findings, 'memo body is free of internal references and un-explained abbreviations');
}

// ── (d)+(e) The reviewer frame is present, near the top ────────────────────

/**
 * `Known limitations` (when the run has a real gap) and `Decisions you own`
 * are among the first sections a reviewer meets, and every real gap is named
 * in the limitations section — the memo's version of build-memo-eval's hard
 * gate (a rule Connect does not hold must never read as enforced).
 */
export function checkMemoReviewerFrame(memo: string, lim: LimitationSummary, asks: readonly ReviewerAsk[]): MemoReport {
  const body = memoBody(memo);
  const findings: MemoFinding[] = [];
  const headings = [...body.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
  const pos = (re: RegExp) => headings.findIndex((h) => re.test(h));
  const dyo = pos(/^Decisions you own\b/);
  const kl = pos(/^Known limitations\b/);
  if (dyo < 0) findings.push({ kind: 'no-decisions-you-own', detail: 'no "## Decisions you own" section' });
  else if (dyo > 2) findings.push({ kind: 'decisions-you-own-buried', detail: `"Decisions you own" is section ${dyo + 1}; it must be among the first three` });
  if (lim.gaps.length > 0) {
    if (kl < 0) findings.push({ kind: 'no-known-limitations', detail: `${lim.gaps.length} real gap(s) and no "## Known limitations" section` });
    else if (kl > 2) findings.push({ kind: 'known-limitations-buried', detail: `"Known limitations" is section ${kl + 1}; it must be among the first three` });
    else {
      const start = body.indexOf(`## ${headings[kl]}`);
      const next = body.indexOf('\n## ', start + 3);
      const section = body.slice(start, next < 0 ? undefined : next);
      for (const g of lim.gaps) {
        if (!section.includes(g.rule)) findings.push({ kind: 'gap-not-stated', detail: `"${g.rule}" is not named under Known limitations` });
      }
      if (lim.byDesign.length > 0 && !/by design/i.test(section)) {
        findings.push({ kind: 'gap-and-by-design-conflated', detail: 'Known limitations does not separate real gaps from rules placed off Connect by design' });
      }
    }
  }
  if (dyo >= 0) {
    const start = body.indexOf('## Decisions you own');
    const next = body.indexOf('\n## ', start + 3);
    const section = body.slice(start, next < 0 ? undefined : next);
    const listed = (section.match(/^\d+\.\s/gm) ?? []).length;
    if (listed < asks.length) findings.push({ kind: 'asks-missing', detail: `"Decisions you own" lists ${listed} of the ${asks.length} decisions the run left to the reviewer` });
  }
  return report(findings, 'Known limitations and Decisions you own lead the memo and are complete');
}

// ── The frame ──────────────────────────────────────────────────────────────

function pointLabel(p: EnforcementPoint, rule: string, defaultCase = 'record'): string {
  switch (p.kind) {
    case 'connect-payment-unit': {
      const daily = /max_daily\s*=?\s*:?\s*(\d+)/i.exec(p.text);
      const total = /max_total\s*=?\s*:?\s*(\d+)/i.exec(p.text);
      const parts = [
        daily ? `pays at most ${daily[1]} per worker per day` : '',
        total ? `pays at most ${total[1]} per worker in total` : '',
      ].filter(Boolean);
      return `Connect payment limit${parts.length ? ` — ${parts.join('; ')}` : ''}`;
    }
    case 'connect-verification':
      return 'Connect verification rule';
    case 'app-form':
      // State the case an app check is keyed on only where scope is the point:
      // a per-case rule, or app support listed under a per-worker rule.
      return ruleScope(rule) === 'unscoped'
        ? 'A check in the app'
        : `A check in the app (per ${caseNoun(`${p.text} ${rule}`, defaultCase)})`;
    case 'off-platform': {
      const where = /applied (?:in|elsewhere)\s*\.?\s*(.*)$/i.exec(p.text)?.[1] ?? '';
      return `Outside Connect, by design${where ? `: ${plainText(where)}` : ''}`;
    }
    case 'not-applied':
      return '**Not enforced** — see Known limitations';
    default:
      return plainText(p.text);
  }
}

function scopeLabel(rule: string): string {
  const s = ruleScope(rule);
  if (s === 'per-worker') return 'each worker';
  if (s === 'per-case') return `each ${caseNoun(rule)}`;
  return 'each record';
}

/** `| # | Rule | Applies to | Enforced by |`, plain, with per-worker scopes corrected. */
export function renderEnforcementTable(rows: readonly RuleRow[]): { markdown: string; corrections: string[] } {
  const corrections: string[] = [];
  // The case an app check is keyed on, when a row does not say: the case the
  // per-case rules of this programme name most often (a community, a household).
  const nouns = rows.filter((r) => ruleScope(r.rule) === 'per-case').map((r) => caseNoun(r.rule));
  const defaultCase =
    [...nouns].sort((a, b) => nouns.filter((n) => n === b).length - nouns.filter((n) => n === a).length)[0] ?? 'record';
  const out = [
    '## Where each rule is enforced',
    '',
    'Each rule is quoted from the design. "Applies to" is the rule\'s scope; the enforcement named first is the one that actually holds it at that scope.',
    '',
    '| # | Rule (from the design) | Applies to | Enforced by |',
    '|---|---|---|---|',
  ];
  rows.forEach((raw, i) => {
    const { row, correction } = rescopeRuleRow(raw, defaultCase);
    if (correction) corrections.push(correction);
    const pts = enforcementPoints(row.whereApplied).filter((p) => p.kind !== 'unknown' || !/^supporting only/i.test(p.text));
    const lead = pts[0] ? pointLabel(pts[0], row.rule, defaultCase) : 'NOT STATED';
    const support = pts
      .slice(1)
      .filter((p) => p.kind !== pts[0]?.kind && p.kind !== 'unknown')
      .map((p) => pointLabel(p, row.rule, defaultCase));
    const enforced = support.length ? `${lead}. Also: ${support.join('; ')}` : lead;
    out.push(`| ${i + 1} | "${row.rule.replace(/\|/g, '\\|')}" | ${scopeLabel(row.rule)} | ${enforced.replace(/\|/g, '\\|')} |`);
  });
  return { markdown: out.join('\n'), corrections };
}

export interface FrameInput {
  runState: unknown;
  decisions: readonly unknown[];
  /** connect-opp-setup's memo section (or the whole connect-opp-setup.md). */
  phase4Section: string;
  /** The PDD's text, for the abbreviations it glosses. */
  pddText?: string;
  displayName: string;
}

export interface MemoFrame {
  title: string;
  intro: string;
  knownLimitations: string;
  decisionsYouOwn: string;
  enforcement: string;
  appendix: string;
  limitations: LimitationSummary;
  asks: ReviewerAsk[];
  rules: RuleRow[];
  corrections: string[];
  glossary: Record<string, string>;
}

/**
 * Render every deterministic part of the memo. The composer inserts its
 * plain-language account of the build's choices between `enforcement` and
 * `appendix`, and the producers' verbatim sections inside the appendix.
 */
export function composeMemoFrame(input: FrameInput): MemoFrame {
  const tableRules = parsePhase4RuleTable(input.phase4Section);
  const rules = tableRules.length > 0 ? tableRules : ruleRowsFromDecisions(input.decisions);
  const limitations = knownLimitations(input.runState, rules);
  const asks = decisionsYouOwn(input.runState, input.decisions, limitations);
  const { markdown: enforcement, corrections } = renderEnforcementTable(rules);
  const glossary = input.pddText ? glossaryFromPdd(input.pddText) : {};
  const title = renderMemoTitle(input.runState, input.displayName);
  const kl = renderKnownLimitations(limitations);
  const dyo = renderDecisionsYouOwn(asks);
  const terms = renderTermsLine([kl, dyo, enforcement].join('\n'), glossary);
  const links = renderWhereToFind(input.runState);
  const intro = [
    'This memo explains what was built for this programme, what you need to decide, and where to check the build. ' +
      'It is written so you can review it without opening the apps first, then spot-check the places it names.',
    '',
    renderRunProvenance(input.runState),
    ...(links ? ['', links] : []),
    ...(terms ? ['', terms] : []),
  ].join('\n');

  const v = rec(connectProducts(input.runState).verification);
  const appendix = [
    '## Appendix — references for the build team',
    '',
    `- Run: ${str(rec(input.runState).opportunity)}/${memoRunId(input.runState)}` +
      (str(rec(input.runState).forked_from) ? ` (forked from ${str(rec(input.runState).forked_from)} at ${str(rec(input.runState).forked_from_phase)})` : ''),
    `- Connect verification: form_field_rules_saved: ${str(v.form_field_rules_saved) || 'not recorded'}` +
      (limitations.rawReason ? `; not_applied_reason: ${limitations.rawReason.replace(/\s+/g, ' ')}` : ''),
    ...asks.map((a, i) => `- Decision ${i + 1} sources: ${a.refs.join(', ') || '—'}`),
    ...limitations.gaps.map((g) => `- Gap "${g.rule}": ${g.refs.join(', ')}`),
    ...limitations.byDesign.map((b) => `- By design "${b.rule}": ${b.refs.join(', ')}`),
    ...corrections.map((c) => `- Scope corrected from the producer: ${c}`),
  ].join('\n');

  return {
    title,
    intro,
    knownLimitations: kl,
    decisionsYouOwn: dyo,
    enforcement,
    appendix,
    limitations,
    asks,
    rules,
    corrections,
    glossary,
  };
}

/**
 * Where the reviewer opens each thing the memo talks about — the apps on
 * CommCare HQ and the Connect opportunity and programme — from the URLs the
 * producers recorded, plus the opportunity's name (on a fork it still carries
 * the source run's id, which a reviewer searching Connect needs to know).
 */
export function renderWhereToFind(runState: unknown): string {
  const apps = rec(rec(rec(phases(runState)['commcare-setup']).products).apps);
  const conn = connectProducts(runState);
  const opp = rec(conn.opportunity);
  const prog = rec(conn.program);
  const items: string[] = [];
  for (const [k, label] of [['learn', 'Learn app'], ['deliver', 'Deliver app']] as const) {
    const url = str(rec(apps[k]).hq_url);
    if (url) items.push(`[${label}](${url})`);
  }
  if (str(opp.url)) {
    const flags = [opp.is_test === true ? 'a test opportunity' : '', str(opp.status) ? `status ${str(opp.status)}` : '']
      .filter(Boolean)
      .join(', ');
    items.push(`[Connect opportunity](${str(opp.url)})${str(opp.name) ? ` — named "${str(opp.name)}"` : ''}${flags ? ` (${flags})` : ''}`);
  }
  if (str(prog.url)) items.push(`[Connect programme](${str(prog.url)})`);
  return items.length ? `**Where to find things:** ${items.join('; ')}.` : '';
}

/** Title, intro, limitations, asks and the rule table, in reading order. */
export function renderFrameHead(f: MemoFrame): string {
  return [f.title, '', f.intro, '', f.knownLimitations, '', f.decisionsYouOwn, '', f.enforcement].join('\n');
}

export interface MemoCheckInput {
  memo: string;
  runState: unknown;
  decisions: readonly unknown[];
  phase4Section: string;
  skillNames?: readonly string[];
}

/** Every deterministic gate on a composed memo, by name. */
export function runMemoChecks(input: MemoCheckInput): Record<string, MemoReport> {
  const tableRules = parsePhase4RuleTable(input.phase4Section);
  const rules = tableRules.length > 0 ? tableRules : ruleRowsFromDecisions(input.decisions);
  const lim = knownLimitations(input.runState, rules);
  const asks = decisionsYouOwn(input.runState, input.decisions, lim);
  const memoRules = parsePhase4RuleTable(memoBody(input.memo));
  return {
    run_label: checkMemoRunLabel(input.memo, input.runState),
    reviewer_language: checkReviewerLanguage(input.memo, {
      skillNames: input.skillNames,
      decisionIds: input.decisions.map((d) => str(rec(d).id)).filter(Boolean),
    }),
    reviewer_frame: checkMemoReviewerFrame(input.memo, lim, asks),
    // the memo's OWN statement of where rules are enforced, when it carries one
    enforcement_scope: checkEnforcementScope(memoRules.length > 0 ? memoRules : memoEnforcementRows(input.memo)),
  };
}

/** Rows of the memo's own `Where each rule is enforced` table. */
export function memoEnforcementRows(memo: string): RuleRow[] {
  const body = memoBody(memo);
  const start = body.indexOf('## Where each rule is enforced');
  if (start < 0) return [];
  const end = body.indexOf('\n## ', start + 3);
  const rows: RuleRow[] = [];
  for (const line of body.slice(start, end < 0 ? undefined : end).split('\n')) {
    if (!/^\|\s*\d+\s*\|/.test(line)) continue;
    const c = splitRow(line);
    // rendered labels map back onto the classifier's vocabulary
    const where = (c[3] ?? '')
      .replace(/^Connect payment limit/i, 'Connect payment unit')
      .replace(/^A check in the app/i, 'CCZ check')
      .replace(/^Outside Connect, by design/i, 'Not configurable on Connect — applied in')
      .replace(/^\*\*Not enforced\*\*/i, 'Not configurable on Connect — not applied')
      .replace(/\.\s*Also:\s*/i, '; also ');
    rows.push({ rule: (c[1] ?? '').replace(/^"|"$/g, ''), pddSection: '', whereApplied: where, evidence: '', source: `memo row ${c[0]}` });
  }
  return rows;
}
