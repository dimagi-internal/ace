/**
 * Shared primitives for the payment-unit-vs-`entity_id`-grain invariant.
 *
 * Connect resolves payable units by `entity_id`. A document may state a rate
 * per EVENT (per visit, per session, per form) while the opportunity's
 * `entity_id` grain makes the payable unit a worker-DAY — the two agree only
 * when there is exactly one event per worker per day, and disagree everywhere
 * else, multiplying every money number by the events-per-worker-day ratio.
 *
 * This module exists because the invariant has to hold in TWO documents, and
 * shipping it in one is how it re-entered the other:
 *
 *   - `idea-to-pdd-qa § payment_unit_matches_entity_grain` gates the PDD
 *     (dimagi-internal/ace#1420).
 *   - `pdd-to-work-order-qa § payment_unit_matches_entity_grain` gates the
 *     Work Order — the document that actually gets signed
 *     (dimagi-internal/ace#1946).
 *
 * On bednet-check-2-visit/20260902-1555 the PDD-side check DID fire and the
 * money was correctly re-derived per worker-day; `pdd-to-work-order` then put
 * the per-visit wording straight back into the Work Order and the work-order
 * QA returned 9/9 with the contradiction present. One implementation, two
 * callers, so the two documents can no longer disagree about what a payable
 * unit is.
 */

import { normalizeDriveExport } from './drive-export';

/** Terms that make a grain (or a rate unit) day-scoped. */
export const DAY_TERMS: readonly string[] = ['date', 'day', 'daily', 'calendar day', 'per day'];

/** Terms that make a rate unit per-event — finer than a day. */
export const EVENT_TERMS: readonly string[] = [
  'visit', 'session', 'form', 'submission', 'encounter', 'meeting',
  'interview', 'record', 'delivery', 'assessment', 'screening',
];

/**
 * Return the first term in `needles` that appears as a whole word (optionally
 * pluralised) in `haystack`, or `null`. Multi-word needles tolerate any run of
 * whitespace between their words.
 */
export function mentionsTerm(haystack: string, needles: readonly string[]): string | null {
  const h = haystack.toLowerCase();
  for (const n of needles) {
    if (new RegExp(`\\b${n.replace(/ /g, '\\s+')}s?\\b`).test(h)) return n;
  }
  return null;
}

/** How a stated rate unit relates to the grain that actually resolves payable units. */
export type GrainRelation =
  /** One or both operands are absent — nothing to compare. */
  | { kind: 'not-applicable' }
  /** The rate unit is itself day-scoped, so it matches a day grain by construction. */
  | { kind: 'unit-day-scoped'; unitDay: string }
  /** The grain is day-scoped and the rate unit is per-event: the defect. */
  | { kind: 'mismatch'; unitEvent: string; grainDay: string }
  /** No contradiction detectable between the two. */
  | { kind: 'consistent' };

/**
 * Classify a stated rate unit against the `entity_id` grain.
 *
 * Deliberately one-directional and conservative, per the binary-QA convention:
 * it fires ONLY on the unambiguous case (day-scoped grain, per-event rate) and
 * returns `consistent` for everything it cannot prove wrong.
 */
export function classifyGrainRelation(unit: string, grain: string): GrainRelation {
  const u = (unit ?? '').trim();
  const g = (grain ?? '').trim();
  if (!u || !g) return { kind: 'not-applicable' };

  // If the rate unit is ITSELF day-scoped ("per verified follow-up day"),
  // it already matches a day grain no matter what else it names.
  const unitDay = mentionsTerm(u, DAY_TERMS);
  if (unitDay) return { kind: 'unit-day-scoped', unitDay };

  const grainDay = mentionsTerm(g, DAY_TERMS);
  const unitEvent = mentionsTerm(u, EVENT_TERMS);
  if (grainDay && unitEvent) return { kind: 'mismatch', unitEvent, grainDay };

  return { kind: 'consistent' };
}

/**
 * Read one `| key | value |` row out of a `## Program Parameters`-style
 * markdown table, from anywhere in `text`.
 *
 * Section-extraction-free on purpose: the caller here is the WORK-ORDER QA
 * reading a PDD body it does not otherwise parse, and Program Parameters keys
 * are snake_case and unique within a PDD. Returns `null` when the row is
 * absent or its value is empty.
 *
 * **Normalises Drive markdown-export escaping first (dimagi-internal/ace#2398).**
 * Both callers are handed a Drive export of a NATIVE Google Doc — every PDD is
 * one since ace#1061 — and Drive's `text/markdown` exporter escapes
 * markdown-significant punctuation, so a snake_case key arrives as
 * `entity\_id\_grain` and the literal match silently returns null. That turned
 * `pdd-to-work-order-qa § payment_unit_matches_entity_grain` into a permanent
 * "not applicable" PASS on every run — ace#1946's check shipped inert for the
 * second time (the first was ace#2124). Normalising HERE rather than in each
 * caller fixes the class: the PDD-side check (ace#1420) and the work-order-side
 * check (ace#1946) share this function, and so will any future reader.
 *
 * What normalisation cannot rescue, and callers must know: a `text/plain`
 * export of a native gdoc drops the table structure entirely (one cell per
 * line, no pipes), so there is no row left to match. `--pdd` must therefore be
 * the MARKDOWN export even where the same skill reads its own artifact as
 * plain text.
 */
export function readProgramParameter(text: string, key: string): string | null {
  if (!text) return null;
  const normalized = normalizeDriveExport(text);
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^\\s*\\|\\s*\`?${escaped}\`?\\s*\\|([^|]*)\\|`, 'im');
  const m = normalized.match(re);
  if (!m) return null;
  const value = m[1].replace(/`/g, '').trim();
  return value.length > 0 ? value : null;
}
