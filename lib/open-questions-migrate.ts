/**
 * Fold an opp's legacy open-questions ledger into decision rows, once.
 *
 * Spec § 6 (docs/superpowers/specs/2026-10-04-open-questions-into-decisions-design.md,
 * owner-approved 2026-10-04). Every open ledger row lands in one of five
 * categories:
 *
 *   A  already a decision — a live decision row covers it. Nothing new unless
 *      the reviewer copies owner / needed_by / answer_channel onto it, which
 *      appends a row that `supersedes` it (the log is append-only).
 *   B  an implicit default the build took with no decision row — append one,
 *      with the default quoted from its source, plus a `review_ask`.
 *   C  not needed for this pilot — append a `status: deferred` row with
 *      `revisit_when`.
 *   D  not a decision (a chore, an upstream request, a factual partner input
 *      already asked in the solicitation) — print what to create; nothing is
 *      written to decisions.
 *   E  genuinely open and blocking — append a row with
 *      `review_ask: required-before` and `needed_by` (default `award`).
 *
 * The CLASSIFICATION is a human's call. `proposeClassification` is
 * deterministic — same id first, then text similarity against the live rows,
 * then keyword cues on the row's own `owner:` / `blocking:` fields — and it
 * prints its evidence so a person can confirm or correct it. It is never an
 * LLM. `buildMigration` takes the reviewed classification and produces the
 * rows to append, each validated by the strict write schema and the
 * outsider-text check from PR #2628 (`auditOutsiderText`).
 */

import { DecisionRowStrictSchema, NEEDED_BY, type DecisionRow, type DecisionsLog, type NeededBy } from './decisions-schema.js';
import { extractOpenSection, parseOpenRows, unescapeDriveMarkdown, type OpenQuestionsReadExport } from './open-questions-inline.js';
import { textOverlap } from './open-asks.js';
import { auditOutsiderText } from './pdd-description-plain-language.js';

export type MigrationCategory = 'A' | 'B' | 'C' | 'D' | 'E';

export const CATEGORY_MEANING: Record<MigrationCategory, string> = {
  A: 'already a decision',
  B: 'implicit default, not logged',
  C: 'not needed for this pilot (deferred)',
  D: 'not a decision (chore / upstream request / solicitation input)',
  E: 'genuinely open and blocking',
};

/** One open row of the legacy ledger, fields unescaped. */
export interface LedgerRow {
  id: string;
  question: string;
  owner: string | null;
  blocking: string | null;
  answeredWhere: string | null;
  raisedBy: string | null;
  latest: string | null;
  text: string;
}

const FIELD = /\*\*([A-Za-z\\_]+):\*\*/g;

/** Split a ledger row into its `**field:**` values. */
export function parseLedgerFields(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const marks = [...text.matchAll(FIELD)];
  marks.forEach((m, i) => {
    const name = m[1].replace(/\\/g, '').toLowerCase();
    const from = (m.index ?? 0) + m[0].length;
    const to = i + 1 < marks.length ? (marks[i + 1].index ?? text.length) : text.length;
    const value = unescapeDriveMarkdown(text.slice(from, to)).replace(/\s+/g, ' ').trim();
    if (!(name in out)) out[name] = value;
  });
  return out;
}

/** The ledger's open rows. Throws unless the `## Open` section resolves. */
export function readLedgerOpenRows(markdown: string, exportAs: OpenQuestionsReadExport = 'text/markdown'): LedgerRow[] {
  const outcome = extractOpenSection(markdown, exportAs);
  if (outcome.status !== 'ok' && outcome.status !== 'flattened-headings') {
    throw new Error(`the ledger's Open section did not resolve (${outcome.status}): ${outcome.reason}`);
  }
  return parseOpenRows(outcome.section).rows.map((r, i) => {
    const f = parseLedgerFields(r.text);
    return {
      id: f.id ?? r.id ?? `unidentified-row-${i + 1}`,
      question: f.question ?? '',
      owner: f.owner ?? null,
      blocking: f.blocking ?? f.blocks ?? null,
      answeredWhere: f.answered_where ?? null,
      raisedBy: f.raised_by ?? null,
      latest: f.latest ?? null,
      text: r.text,
    };
  });
}

// ── Proposals ──────────────────────────────────────────────────────────────

export interface MatchCandidate {
  decisionId: string;
  score: number;
  how: 'id' | 'text';
  /** What the decision row says, for the reviewer. */
  says: string;
}

export interface Proposal {
  ledgerId: string;
  question: string;
  owner: string | null;
  blocking: string | null;
  proposed: MigrationCategory;
  evidence: string[];
  candidates: MatchCandidate[];
}

/** At or above this a decision row is proposed as covering the ledger row (A). */
export const MATCH_THRESHOLD = 0.55;
/** At or above this a match wins even over a future-phase cue on the row's own `blocking:`. */
export const STRONG_MATCH = 0.75;

const INTERNAL_OWNER = /^(ace|operator|dimagi|connect(?: team)?|connect labs|ace team|ace engineering)$/i;
const CHORE = /\b(sweep|deactivate|clean ?up|delete|distribut\w*|send it|follow[- ]?up|re-?send|stale opportunit\w*|archive|rename)\b/i;
const UPSTREAM = /\b(nova|ocs|upstream|feature request|capability request|delivery[- ]type|connect (?:does not|doesn't|cannot|lacks)|item rotation|question rotation)\b/i;
const DEFERRED = /\b(expansion|expand\w*|post-pilot|future|later phase|phase 2 of the programme|before any instrumentation|non-blocking|rwanda|proposal development|after the pilot|end-state)\b/i;
const BLOCKING_AWARD = /\b(go\s*\/?\s*no[- ]?go|award\w*|solicitation deadline)\b/i;
const SOLICITATION_INPUT = /\b(application|solicitation response|in the solicitation|their response)\b/i;

function tokensOfId(id: string): string {
  return id.replace(/-/g, ' ');
}

function decisionText(row: DecisionRow): string {
  return [row.plain_question, row.plain, row.question, tokensOfId(row.id)].filter(Boolean).join(' ');
}

/** True when every named owner is internal (ACE, Operator, Dimagi, Connect team). */
export function ownerIsInternal(owner: string | null): boolean {
  if (!owner) return false;
  const parts = owner.split(/\s*(?:\/|,|&|\band\b|\+)\s*/i).map((p) => p.trim()).filter(Boolean);
  return parts.length > 0 && parts.every((p) => INTERNAL_OWNER.test(p));
}

/** Ranked candidate decision rows for one ledger row (live rows only). */
export function matchCandidates(row: LedgerRow, log: Pick<DecisionsLog, 'decisions'>, limit = 3): MatchCandidate[] {
  const live = log.decisions.filter((d) => d.superseded_by === undefined);
  const exact = live.find((d) => d.id === row.id);
  const scored = live
    .filter((d) => d !== exact)
    .map((d) => {
      const s = Math.max(
        textOverlap(row.question, decisionText(d)),
        textOverlap(tokensOfId(row.id), tokensOfId(d.id)),
      );
      return { decisionId: d.id, score: Math.round(s * 100) / 100, how: 'text' as const, says: d.plain ?? d.question };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || a.decisionId.localeCompare(b.decisionId))
    .slice(0, limit);
  return exact ? [{ decisionId: exact.id, score: 1, how: 'id', says: exact.plain ?? exact.question }, ...scored.slice(0, limit - 1)] : scored;
}

/**
 * Propose a category per row, with the evidence that produced it. Order of
 * tests: same id (A) → upstream request or internal chore (D) → a strongly
 * covering decision row (A) → the row's own `blocking:` defers it (C) → a
 * covering decision row (A) → a future-phase cue in the question (C) → a
 * factual partner input answered in the solicitation (D) → award-gating
 * `blocking:` (E) → B.
 */
export function proposeClassification(rows: readonly LedgerRow[], log: Pick<DecisionsLog, 'decisions'>): Proposal[] {
  return rows.map((row) => {
    const candidates = matchCandidates(row, log);
    const best = candidates[0];
    const evidence: string[] = [];
    const cue = `${row.question} ${row.blocking ?? ''}`;
    const p = (proposed: MigrationCategory): Proposal => ({
      ledgerId: row.id,
      question: row.question,
      owner: row.owner,
      blocking: row.blocking,
      proposed,
      evidence,
      candidates,
    });

    if (best?.how === 'id') {
      evidence.push(`a live decision row has the same id: ${best.decisionId}`);
      return p('A');
    }
    const chore = CHORE.exec(row.question);
    const upstream = UPSTREAM.exec(cue);
    if (upstream) {
      evidence.push(`upstream request: "${upstream[0]}"`);
      return p('D');
    }
    if (chore && (ownerIsInternal(row.owner) || /\bhow will\b|\bwho sends\b/i.test(row.question))) {
      evidence.push(`a chore for ${row.owner ?? 'an internal owner'}: "${chore[0]}"`);
      return p('D');
    }
    if (best && best.score >= STRONG_MATCH) {
      evidence.push(`decision row ${best.decisionId} covers it (overlap ${best.score}): ${best.says}`);
      return p('A');
    }
    const deferredGate = DEFERRED.exec(row.blocking ?? '');
    if (deferredGate) {
      evidence.push(`its own blocking field defers it: "${deferredGate[0]}" (blocking: ${row.blocking})`);
      if (best && best.score >= MATCH_THRESHOLD) evidence.push(`but decision row ${best.decisionId} overlaps ${best.score} — check it is not already decided`);
      return p('C');
    }
    if (best && best.score >= MATCH_THRESHOLD) {
      evidence.push(`decision row ${best.decisionId} covers it (overlap ${best.score}): ${best.says}`);
      return p('A');
    }
    const deferred = DEFERRED.exec(row.question);
    if (deferred) {
      evidence.push(`future-phase cue in the question: "${deferred[0]}"`);
      return p('C');
    }
    if (row.answeredWhere && SOLICITATION_INPUT.test(row.answeredWhere) && /\b(provide|share|confirm|what is|how many)\b/i.test(row.question)) {
      evidence.push(`a factual partner input answered in the solicitation: "${row.answeredWhere}"`);
      return p('D');
    }
    const award = BLOCKING_AWARD.exec(row.blocking ?? '');
    if (award) {
      evidence.push(`gates the award with no covering decision row: "${award[0]}"`);
      return p('E');
    }
    evidence.push(best ? `closest decision row ${best.decisionId} only overlaps ${best.score}` : 'no decision row overlaps it');
    return p('B');
  });
}

/** A fixed-width table for the terminal. */
export function renderProposals(proposals: readonly Proposal[]): string {
  const counts = new Map<MigrationCategory, number>();
  for (const pr of proposals) counts.set(pr.proposed, (counts.get(pr.proposed) ?? 0) + 1);
  const lines: string[] = [];
  lines.push(
    `PROPOSED classification — ${proposals.length} open rows (` +
      (['A', 'B', 'C', 'D', 'E'] as const).map((c) => `${c} ${counts.get(c) ?? 0}`).join(', ') +
      '). Deterministic; confirm or correct each before --apply.',
  );
  for (const pr of proposals) {
    lines.push('');
    lines.push(`[${pr.proposed}] ${pr.ledgerId} — ${CATEGORY_MEANING[pr.proposed]}`);
    lines.push(`    question: ${pr.question.length > 200 ? `${pr.question.slice(0, 197)}...` : pr.question}`);
    lines.push(`    owner: ${pr.owner ?? '—'} | blocking: ${pr.blocking ?? '—'}`);
    for (const e of pr.evidence) lines.push(`    evidence: ${e}`);
    for (const c of pr.candidates) lines.push(`    candidate: ${c.decisionId} (${c.how}, ${c.score}) — ${c.says.length > 140 ? `${c.says.slice(0, 137)}...` : c.says}`);
  }
  return lines.join('\n');
}

// ── The reviewed classification → rows ─────────────────────────────────────

/** Decision fields a reviewer supplies for a B / C / E row. */
export type ClassifiedRowFields = Partial<
  Pick<
    DecisionRow,
    | 'question'
    | 'ai-default'
    | 'options'
    | 'source'
    | 'reasoning'
    | 'plain'
    | 'plain_question'
    | 'plain_value'
    | 'confirm_reason'
    | 'owner'
    | 'needed_by'
    | 'answer_channel'
    | 'revisit_when'
    | 'phase'
    | 'skill'
    | 'evidence_basis'
    | 'value_set_by'
    | 'review_ask'
    | 'check_at'
    | 'correct_looks_like'
    | 'feedback_ref'
  >
> & { id?: string };

export interface ClassificationEntry {
  /** The ledger row id. */
  id: string;
  category: MigrationCategory;
  /** A: the live decision row that covers it. */
  decision_id?: string;
  /**
   * A: copied onto the decision (a superseding row is appended only when one
   * of these is new). `row` may supply reviewer text (`plain`, …) the old row
   * lacks, so the superseding row passes today's write contract.
   */
  owner?: string;
  needed_by?: NeededBy;
  answer_channel?: string;
  /** B / C / E: the row to append. */
  row?: ClassifiedRowFields;
  /** D: where it goes instead. */
  route?: 'task' | 'residual' | 'issue' | 'solicitation-question';
  note?: string;
}

export interface Classification {
  opp: string;
  run_id: string;
  rows: ClassificationEntry[];
}

export interface MigrationResult {
  /** Validated rows ready for `decisions_append_rows`. */
  rows: DecisionRow[];
  /** D rows: what to create instead. */
  actions: Array<{ id: string; route: string; note: string }>;
  /** ledger id → where it went, for the archive's mapping table. */
  mapping: Array<{ id: string; category: MigrationCategory; to: string }>;
  /** Anything that refused — `--apply` writes nothing while this is non-empty. */
  errors: string[];
}

const OUTSIDER_FIELDS = ['plain', 'plain_question', 'confirm_reason', 'revisit_when', 'plain_value'] as const;

function validate(row: DecisionRow, ledgerId: string, errors: string[]): boolean {
  const r = DecisionRowStrictSchema.safeParse(row);
  let ok = true;
  if (!r.success) {
    ok = false;
    for (const i of r.error.issues) errors.push(`${ledgerId} → ${row.id}.${i.path.join('.') || '<row>'}: ${i.message}`);
  }
  for (const f of OUTSIDER_FIELDS) {
    const text = row[f];
    if (typeof text !== 'string') continue;
    for (const issue of auditOutsiderText(text, 'outsider')) {
      ok = false;
      errors.push(`${ledgerId} → ${row.id}.${f}: reads as jargon to an outside owner (${issue.kind}: "${issue.token}")`);
    }
  }
  return ok;
}

function kebab(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'migrated-question';
}

/**
 * Turn a reviewed classification into rows. Pure; validates every row it
 * produces and refuses (via `errors`) rather than emitting a row the write
 * boundary or the plain-language gate would reject.
 */
export function buildMigration(args: {
  classification: Classification;
  ledger: readonly LedgerRow[];
  log: Pick<DecisionsLog, 'decisions'>;
  migratedOn: string;
}): MigrationResult {
  const out: MigrationResult = { rows: [], actions: [], mapping: [], errors: [] };
  const ledgerById = new Map(args.ledger.map((r) => [r.id, r]));
  const live = new Map(args.log.decisions.filter((d) => d.superseded_by === undefined).map((d) => [d.id, d]));
  const taken = new Set(args.log.decisions.map((d) => d.id));
  const seen = new Set<string>();

  for (const e of args.classification.rows) {
    if (seen.has(e.id)) {
      out.errors.push(`${e.id}: classified twice`);
      continue;
    }
    seen.add(e.id);
    const ledger = ledgerById.get(e.id);
    if (!ledger) {
      out.errors.push(`${e.id}: not an open row of this ledger`);
      continue;
    }
    const source = `Open-questions ledger row "${e.id}" (migrated ${args.migratedOn})`;

    if (e.category === 'D') {
      if (!e.route) out.errors.push(`${e.id}: category D needs a route (task | residual | issue | solicitation-question)`);
      out.actions.push({ id: e.id, route: e.route ?? '?', note: e.note ?? ledger.question });
      out.mapping.push({ id: e.id, category: 'D', to: `${e.route ?? '?'}${e.note ? `: ${e.note}` : ''}` });
      continue;
    }

    if (e.category === 'A') {
      const target = e.decision_id ? live.get(e.decision_id) : undefined;
      if (!target) {
        out.errors.push(`${e.id}: category A needs decision_id naming a LIVE decision row (got ${JSON.stringify(e.decision_id)})`);
        continue;
      }
      out.mapping.push({ id: e.id, category: 'A', to: target.id });
      const adds = {
        ...(e.owner && target.owner !== e.owner ? { owner: e.owner } : {}),
        ...(e.needed_by && target.needed_by !== e.needed_by ? { needed_by: e.needed_by } : {}),
        ...(e.answer_channel && target.answer_channel !== e.answer_channel ? { answer_channel: e.answer_channel } : {}),
      };
      if (Object.keys(adds).length === 0) continue;
      if (target.status !== 'ai-default') {
        // A person already ruled; there is nothing left to ask, and a caller
        // may not re-assert their ruling (ace#2307).
        continue;
      }
      const id = kebab(`${target.id}-ask`);
      if (taken.has(id)) continue; // idempotent: already migrated
      const { superseded_by: _s, also_raised_by: _a, inherited_from_run: _i, ...rest } = target;
      // The superseding row must pass today's write contract even when the
      // row it corrects predates it (a pre-v6 row has no `plain`): the
      // reviewer supplies the missing reviewer-facing text in `row`.
      const fill = e.row ?? {};
      const text = Object.fromEntries(
        (['plain', 'plain_question', 'plain_value', 'confirm_reason', 'check_at', 'correct_looks_like'] as const)
          .filter((k) => fill[k] !== undefined)
          .map((k) => [k, fill[k]]),
      );
      const row = { ...rest, ...text, ...adds, id, supersedes: target.id } as DecisionRow;
      if (row.review_ask === 'required-before' && row.needed_by === undefined) row.needed_by = 'award';
      if (validate(row, e.id, out.errors)) {
        out.rows.push(row);
        taken.add(id);
        out.mapping[out.mapping.length - 1].to = `${target.id} (owner/needed_by copied onto ${id})`;
      }
      continue;
    }

    // B / C / E — a new row.
    const f = e.row ?? {};
    const id = kebab(f.id ?? e.id);
    if (taken.has(id)) {
      out.mapping.push({ id: e.id, category: e.category, to: `${id} (already in the log)` });
      continue;
    }
    const value = f['ai-default'];
    if (!value) {
      out.errors.push(`${e.id}: category ${e.category} needs row["ai-default"] — the working default, quoted from its source`);
      continue;
    }
    const options = f.options && f.options.length ? f.options : [value];
    const row: DecisionRow = {
      id,
      phase: f.phase ?? '1-design',
      skill: f.skill ?? 'idea-to-pdd',
      question: f.question ?? ledger.question,
      'ai-default': value,
      options: options.includes(value) ? options : [value, ...options],
      source: f.source ?? source,
      status: e.category === 'C' ? 'deferred' : 'ai-default',
      evidence_basis: f.evidence_basis ?? 'inferred',
      value_set_by: f.value_set_by ?? 'external',
      ...(f.reasoning ? { reasoning: f.reasoning } : {}),
      ...(f.plain ? { plain: f.plain } : {}),
      ...(f.plain_question ? { plain_question: f.plain_question } : {}),
      ...(f.plain_value ? { plain_value: f.plain_value } : {}),
      ...(f.check_at ? { check_at: f.check_at } : {}),
      ...(f.correct_looks_like ? { correct_looks_like: f.correct_looks_like } : {}),
      ...(f.feedback_ref ? { feedback_ref: f.feedback_ref } : {}),
      ...(f.owner ? { owner: f.owner } : {}),
      ...(f.answer_channel ? { answer_channel: f.answer_channel } : {}),
    } as DecisionRow;
    if (e.category === 'C') {
      if (f.revisit_when) row.revisit_when = f.revisit_when;
      if (f.needed_by) row.needed_by = f.needed_by;
    } else {
      row.review_ask = e.category === 'E' ? 'required-before' : (f.review_ask ?? 'recommended-confirmation');
      if (f.confirm_reason) row.confirm_reason = f.confirm_reason;
      const nb = f.needed_by ?? (e.category === 'E' ? 'award' : undefined);
      if (nb) row.needed_by = nb;
    }
    if (validate(row, e.id, out.errors)) {
      out.rows.push(row);
      taken.add(id);
      out.mapping.push({ id: e.id, category: e.category, to: id });
    }
  }

  for (const r of args.ledger) {
    if (!seen.has(r.id)) out.errors.push(`${r.id}: open ledger row has no classification — every row must be decided before --apply`);
  }
  return out;
}

// ── Templates and the archive ──────────────────────────────────────────────

function neededByFrom(blocking: string | null): NeededBy | undefined {
  const b = blocking ?? '';
  if (BLOCKING_AWARD.test(b)) return 'award';
  if (/\bphase 9\b|go-live|go live|launch/i.test(b)) return 'go-live';
  if (/closeout/i.test(b)) return 'closeout';
  if (/extension|expansion/i.test(b)) return 'extension';
  return undefined;
}

function channelFrom(answeredWhere: string | null): string | undefined {
  const a = answeredWhere ?? '';
  if (/\bcall\b/i.test(a)) return 'call';
  if (/application|solicitation/i.test(a)) return 'solicitation:TODO';
  if (/review/i.test(a)) return 'review';
  return undefined;
}

/** Owner as a reader knows it: internal names dropped, the implementing organisation named plainly. */
export function ownerFrom(owner: string | null): string | undefined {
  if (!owner) return undefined;
  const parts = owner.split(/\s*\/\s*/).map((p) => p.trim()).filter((p) => p && !INTERNAL_OWNER.test(p));
  if (parts.length === 0) return 'dimagi';
  const named = parts.map((p) => (/\b(llo|implementing)/i.test(p) ? 'implementing-org' : p));
  return [...new Set(named)].join(' and ');
}

/** A classification file pre-filled from the proposals, for a human to complete. */
export function classificationTemplate(args: {
  opp: string;
  runId: string;
  proposals: readonly Proposal[];
  ledger: readonly LedgerRow[];
}): Classification {
  const byId = new Map(args.ledger.map((r) => [r.id, r]));
  return {
    opp: args.opp,
    run_id: args.runId,
    rows: args.proposals.map((p): ClassificationEntry => {
      const l = byId.get(p.ledgerId)!;
      const owner = ownerFrom(l.owner);
      const needed_by = neededByFrom(l.blocking);
      const answer_channel = channelFrom(l.answeredWhere);
      const note = `PROPOSED ${p.proposed}: ${p.evidence.join('; ')}`;
      if (p.proposed === 'A') {
        return { id: p.ledgerId, category: 'A', decision_id: p.candidates[0]?.decisionId, ...(owner ? { owner } : {}), ...(needed_by ? { needed_by } : {}), ...(answer_channel ? { answer_channel } : {}), note };
      }
      if (p.proposed === 'D') return { id: p.ledgerId, category: 'D', route: 'task', note };
      return {
        id: p.ledgerId,
        category: p.proposed,
        note,
        row: {
          question: l.question,
          plain_question: l.question,
          'ai-default': 'TODO — the default the build took, quoted from its source',
          source: 'TODO — where that default comes from',
          plain: 'TODO — one plain line saying what the build assumes',
          ...(p.proposed === 'C'
            ? { revisit_when: 'TODO — one plain sentence: when to raise it again' }
            : { confirm_reason: 'TODO — one plain sentence: why someone should confirm it' }),
          ...(owner ? { owner } : {}),
          ...(p.proposed === 'E' ? { needed_by: needed_by ?? 'award' } : needed_by ? { needed_by } : {}),
          ...(answer_channel && p.proposed !== 'C' ? { answer_channel } : {}),
        },
      };
    }),
  };
}

/** The archived ledger: a mapping table on top, the original ledger verbatim below. */
export function renderArchivedLedger(args: { original: string; mapping: MigrationResult['mapping']; migratedOn: string; runId: string }): string {
  const rows = args.mapping.map((m) => `| ${m.id} | ${m.category} — ${CATEGORY_MEANING[m.category]} | ${m.to.replace(/\|/g, '/')} |`);
  return [
    `# Open Questions (archived) — migrated ${args.migratedOn}`,
    '',
    `This ledger is retired. Its open rows were folded into the decisions log of run ${args.runId}; an open question is now a decision row with a review ask, and the decisions review is where it is answered. Kept for history only — nothing reads it.`,
    '',
    '| Ledger row | Became | Where |',
    '|---|---|---|',
    ...rows,
    '',
    '---',
    '',
    args.original.trim(),
    '',
  ].join('\n');
}

/** True when `x` is a `needed_by` value. */
export function asNeededBy(x: unknown): NeededBy | undefined {
  return typeof x === 'string' && (NEEDED_BY as readonly string[]).includes(x) ? (x as NeededBy) : undefined;
}
