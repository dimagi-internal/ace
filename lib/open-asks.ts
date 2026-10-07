/**
 * Open asks — a FILTER over a run's decisions log, and the one gate an ask can
 * carry. There is no separate store: "open asks" is never written anywhere, it
 * is computed from `decisions.yaml` every time it is needed (operator decision
 * 2026-10-07, ace#2757 — "why isn't that just a filter of decisions").
 *
 * The open-questions ledger is retired (owner decision 2026-10-04,
 * `docs/superpowers/specs/2026-10-04-open-questions-into-decisions-design.md`):
 * an open question is a decision row whose default someone outside ACE should
 * confirm (`review_ask`), or one this pilot does not need answered
 * (`status: deferred`). This module computes, purely:
 *
 *   - `openAsks`               THE predicate — the live rows with an unanswered
 *                              `review_ask` or `status: deferred`. Every reader
 *                              (decisions_open_asks, Phase 1's carried check,
 *                              release readiness, solicitation-review) goes
 *                              through it;
 *   - `requiredBeforeBlockers` unanswered `review_ask: required-before` rows —
 *                              the only ask that gates anything. Release
 *                              readiness reports each as a blocker, and
 *                              `solicitation-review` refuses `award_response`
 *                              while a `needed_by: award` one is open;
 *   - `checkOpenAsksCarried`   did this run re-derive every ask the PREVIOUS
 *                              run's decisions log left open? A dropped ask
 *                              becomes a run residual (`missingAskResiduals`)
 *                              — it is never re-inserted with the old value.
 *   - `previousRunId`          which sibling run folder is "the previous run".
 *
 * "Answered" means a person ruled: the row is `overridden` / `human-decided`,
 * or a saved ruling in `inputs/decision-overrides.yaml` binds to it (a ruling
 * saved after the row was written has not been stamped onto it yet, so the
 * overrides are applied here before anything is counted).
 */

import {
  NEEDED_BY,
  solicitationQuestionId,
  type DecisionRow,
  type DecisionsLog,
  type NeededBy,
} from './decisions-schema.js';
import { applyDecisionOverrides, type DecisionOverrideRow } from './decision-overrides.js';

/** A person ruled on this row. */
export function isAnswered(row: DecisionRow): boolean {
  return row.status === 'overridden' || row.status === 'human-decided';
}

/** A live row whose `review_ask` nobody has answered yet. */
export function isUnansweredAsk(row: DecisionRow): boolean {
  return row.superseded_by === undefined && row.review_ask !== undefined && !isAnswered(row);
}

/** A live row still asking something: an unanswered ask, or a deferred question. */
export function isOpenAsk(row: DecisionRow): boolean {
  if (row.superseded_by !== undefined) return false;
  return isUnansweredAsk(row) || row.status === 'deferred';
}

/** The log's rows with every saved ruling bound (a ruling saved after a row was written counts). */
function withRulings(rows: DecisionRow[], overrides: readonly DecisionOverrideRow[] | undefined): DecisionRow[] {
  if (!overrides || overrides.length === 0) return rows;
  return applyDecisionOverrides(rows, [...overrides]).rows;
}

export interface OpenAsksOptions {
  /** The opp's `inputs/decision-overrides.yaml` rows, when the file exists. */
  overrides?: readonly DecisionOverrideRow[] | null;
}

/** Live rows still asking something, in log order. */
export function openAsks(log: Pick<DecisionsLog, 'decisions'>, opts: OpenAsksOptions = {}): DecisionRow[] {
  return withRulings(log.decisions, opts.overrides ?? undefined).filter(isOpenAsk);
}

// ── The required-before gate ───────────────────────────────────────────────

export interface RequiredBeforeAsk {
  id: string;
  skill: string;
  needed_by: NeededBy;
  /** What a reader is asked: `plain_question` → `plain` → `question`. */
  question: string;
  confirm_reason?: string;
  owner?: string;
  answer_channel?: string;
}

function toAsk(row: DecisionRow): RequiredBeforeAsk {
  return {
    id: row.id,
    skill: row.skill,
    needed_by: (row.needed_by ?? 'go-live') as NeededBy,
    question: row.plain_question ?? row.plain ?? row.question,
    ...(row.confirm_reason ? { confirm_reason: row.confirm_reason } : {}),
    ...(row.owner ? { owner: row.owner } : {}),
    ...(row.answer_channel ? { answer_channel: row.answer_channel } : {}),
  };
}

export interface RequiredBeforeOptions extends OpenAsksOptions {
  /** Only asks needed before this gate. Omit for every `required-before` ask. */
  neededBy?: NeededBy;
  /**
   * Solicitation question ids the chosen response answered (non-empty). A
   * `required-before` ask whose `answer_channel` is `solicitation:<id>` for one
   * of these is closed by that response rather than blocking.
   */
  answeredSolicitationQuestions?: readonly string[];
}

export interface RequiredBeforeResult {
  /** Unanswered — each one refuses the award / blocks release. */
  blocking: RequiredBeforeAsk[];
  /** Closed by the chosen solicitation response's answer. */
  closedBySolicitation: RequiredBeforeAsk[];
}

/** Unanswered `review_ask: required-before` rows. */
export function requiredBeforeBlockers(
  log: Pick<DecisionsLog, 'decisions'>,
  opts: RequiredBeforeOptions = {},
): RequiredBeforeResult {
  const answeredQ = new Set(opts.answeredSolicitationQuestions ?? []);
  const out: RequiredBeforeResult = { blocking: [], closedBySolicitation: [] };
  for (const row of openAsks(log, opts)) {
    if (row.review_ask !== 'required-before') continue;
    if (opts.neededBy && row.needed_by !== opts.neededBy) continue;
    const q = solicitationQuestionId(row.answer_channel);
    if (q !== null && answeredQ.has(q)) out.closedBySolicitation.push(toAsk(row));
    else out.blocking.push(toAsk(row));
  }
  return out;
}

/** One line per blocking ask, for a refusal message. */
export function describeRequiredBefore(asks: readonly RequiredBeforeAsk[]): string {
  return asks
    .map((a) => `${a.id} (needed before ${a.needed_by}${a.owner ? `, answered by ${a.owner}` : ''}): ${a.question}`)
    .join('; ');
}

// ── Nothing dropped between runs ───────────────────────────────────────────

const STOP = new Set(['a', 'an', 'the', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'is', 'are', 'be', 'it', 'its', 'with', 'by', 'this', 'that', 'should', 'what', 'which', 'who', 'how', 'will', 'does', 'do']);

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

/** Token overlap over the smaller set, 0..1. */
export function textOverlap(a: string, b: string): number {
  const A = tokens(a);
  const B = tokens(b);
  if (A.size === 0 || B.size === 0) return 0;
  let n = 0;
  for (const t of A) if (B.has(t)) n++;
  return n / Math.min(A.size, B.size);
}

function askText(row: DecisionRow): string {
  return [row.plain_question, row.plain, row.question].filter(Boolean).join(' ');
}

/** At or above this overlap a re-worded row counts as the same ask. */
export const CARRIED_OVERLAP = 0.6;

export interface CarriedMatch {
  priorId: string;
  matchedId: string;
  how: 'id' | 'feedback_ref' | 'text';
  /** The ask was answered (a person ruled) — carried and closed. */
  answered: boolean;
}

export interface CarriedCheck {
  priorRunId: string;
  carried: CarriedMatch[];
  /** Prior asks this run has no row for. Each becomes a run residual. */
  missing: DecisionRow[];
  /** Prior asks raised by a phase this run has not reached yet. */
  notYetDue: string[];
}

function ordinal(phase: string): number {
  const n = Number(phase.split('-')[0]);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Compare the previous run's open asks with this run's log. The previous run's
 * asks are computed from ITS decisions log through the same `openAsks` filter
 * — there is no stored list. A prior ask is CARRIED when this run has a row
 * for it — same id, same `feedback_ref`, or a re-worded question
 * (`textOverlap ≥ CARRIED_OVERLAP`) — whatever that row now says (re-derived,
 * answered, or deferred). Values are never inherited: a missing ask is
 * reported, not re-inserted. Run independence holds — the previous log is read
 * only to check that nothing was dropped.
 *
 * `throughOrdinal` limits the check to asks raised by phases this run has
 * completed (Phase 1 checks only `1-*` asks; run end checks all of them).
 */
export function checkOpenAsksCarried(args: {
  prior: { runId: string; log: Pick<DecisionsLog, 'decisions'> };
  log: Pick<DecisionsLog, 'decisions'>;
  throughOrdinal?: number;
  overrides?: readonly DecisionOverrideRow[] | null;
}): CarriedCheck {
  const rows = withRulings(args.log.decisions, args.overrides ?? undefined);
  const live = rows.filter((r) => r.superseded_by === undefined);
  // What the previous run LEFT open — its log as written, without rulings saved
  // since: an ask answered after that run still has to be re-derived by this
  // one, or the answer has no row to bind to.
  const priorAsks = openAsks(args.prior.log);
  const out: CarriedCheck = { priorRunId: args.prior.runId, carried: [], missing: [], notYetDue: [] };
  for (const ask of priorAsks) {
    if (args.throughOrdinal !== undefined && ordinal(ask.phase) > args.throughOrdinal) {
      out.notYetDue.push(ask.id);
      continue;
    }
    let hit: { row: DecisionRow; how: CarriedMatch['how'] } | undefined;
    const byId = live.find((r) => r.id === ask.id) ?? rows.find((r) => r.id === ask.id);
    if (byId) hit = { row: byId, how: 'id' };
    if (!hit && ask.feedback_ref) {
      const byRef = live.find((r) => r.feedback_ref === ask.feedback_ref);
      if (byRef) hit = { row: byRef, how: 'feedback_ref' };
    }
    if (!hit) {
      let best: DecisionRow | undefined;
      let score = 0;
      for (const r of live) {
        const s = textOverlap(askText(ask), askText(r));
        if (s > score) {
          score = s;
          best = r;
        }
      }
      if (best && score >= CARRIED_OVERLAP) hit = { row: best, how: 'text' };
    }
    if (hit) out.carried.push({ priorId: ask.id, matchedId: hit.row.id, how: hit.how, answered: isAnswered(hit.row) });
    else out.missing.push(ask);
  }
  return out;
}

export interface MissingAskResidual {
  what: string;
  where_to_apply: string;
}

/**
 * One `phases.<phase>.residuals` entry per dropped ask, in the shape
 * `openResiduals` (lib/decisions-enrich.ts) reads. The wording names it a
 * design decision for its owner, so `decisions_enrich` raises it as an ask on
 * this run — with this run's "not decided" value, never the old one.
 */
export function missingAskResiduals(check: CarriedCheck): MissingAskResidual[] {
  return check.missing.map((ask) => {
    const q = (ask.plain_question ?? ask.plain ?? ask.question).trim();
    const owner = ask.owner ?? 'the programme owner';
    return {
      what: `An open question from the previous run was dropped: ${q}`,
      where_to_apply: `${ask.skill} should raise it again as a decision row, or record why it no longer applies; design decision for ${owner}.`,
    };
  });
}

/** True when `x` is a `needed_by` value. */
export function isNeededBy(x: unknown): x is NeededBy {
  return typeof x === 'string' && (NEEDED_BY as readonly string[]).includes(x);
}

// ── Which run is "the previous run" ────────────────────────────────────────

/** A run folder name: `YYYYMMDD-HHMM`, optionally suffixed. Archived `superseded-*` attempts never match. */
const RUN_FOLDER = /^[0-9]{8}-[0-9]{4}/;

/**
 * The sibling run folders older than `current`, newest first — the candidates
 * for "the previous run" (the caller takes the first one that has a
 * decisions.yaml). Names that are not run ids (archived `superseded-*`
 * attempts, stray files) are ignored.
 */
export function previousRunCandidates(siblingNames: readonly string[], current: string): string[] {
  return siblingNames
    .filter((n) => RUN_FOLDER.test(n) && n < current)
    .sort()
    .reverse();
}
