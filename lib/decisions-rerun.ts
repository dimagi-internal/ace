/**
 * Inherited decision rows on a run that RE-RUNS a phase (a fork, or a clone
 * that rebuilds Phase 4 in place) must not stay live unless the re-run
 * re-affirmed them.
 *
 * ## Why
 *
 * `decisions_append_rows` is idempotent by id: a re-run producer that emits an
 * id the log already holds is SKIPPED. So an inherited row silently beats the
 * re-run's own choice, or — when the re-run reworded its id — sits live next
 * to it, both `ai-default`. spark-facilitator/20261001-2208 (forked from
 * 20260926-1800 at commcare-setup, then cloned into `spark`) carried 22 live
 * Phase 3 rows from the source build next to the rebuild's rows; one of them,
 * `deliver-latitude-payability-discriminator` ("add meeting_kind as 4th
 * part"), described a key the rebuild had replaced
 * (`deliver-latitude-payable-slot-key-component`), and nothing said so.
 *
 * ## Two moments, two functions
 *
 * - `retireForRerun` — BEFORE the phase re-runs. Every live row of the re-run
 *   phases moves to `<id>-<label>`, gets `superseded_by: <id>` and
 *   `inherited_from_run: <label>`. The canonical id is then free, so the
 *   re-run producer's append lands under it (re-affirming = writing it again),
 *   and a row the re-run never writes stays history. This is the TS mirror of
 *   ace-web's fork transform (`opp_forker.py::_retire_decision_rows`,
 *   ace#2582) — used by `clone-to-new-workspace` before it rebuilds Phase 4
 *   in place, and by `fork-run` when a fork came from a deploy older than
 *   ace-web's fix.
 * - `retireStaleInherited` — AFTER the fact, when the re-run already ran with
 *   the inherited rows live (every fork made before ace#2582). Inherited rows
 *   are retired onto the re-run row that replaced them (`successors`), kept
 *   live only when named in `reaffirmed`, and otherwise retired with the
 *   `retireForRerun` shape. Used by `scripts/backfill-decisions-contract.ts`.
 *
 * Human rulings (`overridden`, `human-decided`) are never retired: a person's
 * decision carries across the re-run.
 *
 * Pure; no I/O.
 */

import type { DecisionRow, DecisionsLog } from './decisions-schema.js';

function ordinal(tag: string): number {
  return Number(tag.split('-')[0]);
}

function humanRuled(row: DecisionRow): boolean {
  return row.status === 'overridden' || row.status === 'human-decided';
}

export interface RetireForRerunOptions {
  /** Retire live rows whose phase ordinal is at or after this one. */
  fromOrdinal?: number;
  /** …or exactly these phase tags (e.g. `['4-connect']`). */
  phaseTags?: readonly string[];
  /** The run the rows came from — the id suffix and `inherited_from_run`. */
  label: string;
  /** `inherited_from_run` when it differs from the id suffix (a clone: `<workspace>/<run>`). */
  inheritedFrom?: string;
}

export interface RetireReport {
  /** `[old id, new id]` for each retired row. */
  retired: Array<[string, string]>;
  /** ids of inherited rows left live. */
  keptLive: string[];
}

function inScope(row: DecisionRow, o: { fromOrdinal?: number; phaseTags?: readonly string[] }): boolean {
  if (o.phaseTags && o.phaseTags.includes(row.phase)) return true;
  if (o.fromOrdinal !== undefined && ordinal(row.phase) >= o.fromOrdinal) return true;
  return false;
}

/** Move a live row out of its canonical id onto `<id>-<label>`, as history. */
function retireRow(log: DecisionsLog, row: DecisionRow, label: string, target: string, inheritedFrom = label): string {
  const taken = new Set(log.decisions.map((d) => d.id));
  let next = `${row.id}-${label}`;
  for (let n = 2; taken.has(next); n++) next = `${row.id}-${label}-${n}`;
  // Anything that pointed at the old id now points at the moved row.
  for (const d of log.decisions) {
    if (d.supersedes === row.id) d.supersedes = next;
    if (d.superseded_by === row.id && d !== row) d.superseded_by = next;
  }
  row.id = next;
  row.superseded_by = target;
  row.inherited_from_run = inheritedFrom;
  return next;
}

/**
 * Retire every live inherited row of the phases about to re-run. Returns a
 * copy of the log and the moves made. A row already superseded is history and
 * left as is.
 */
export function retireForRerun(input: DecisionsLog, opts: RetireForRerunOptions): { log: DecisionsLog; report: RetireReport } {
  if (opts.fromOrdinal === undefined && !opts.phaseTags?.length) {
    throw new Error('retireForRerun: pass fromOrdinal or phaseTags');
  }
  const log: DecisionsLog = JSON.parse(JSON.stringify(input));
  const report: RetireReport = { retired: [], keptLive: [] };
  for (const row of [...log.decisions]) {
    if (!inScope(row, opts) || row.superseded_by !== undefined) continue;
    if (humanRuled(row)) {
      report.keptLive.push(row.id);
      continue;
    }
    const old = row.id;
    report.retired.push([old, retireRow(log, row, opts.label, old, opts.inheritedFrom)]);
  }
  return { log, report };
}

export interface RetireStaleOptions {
  /** ids the run inherited (the source run's ids for the re-run phases). */
  inheritedIds: ReadonlySet<string>;
  /** The re-run phases: only inherited rows in these are judged. */
  fromOrdinal?: number;
  phaseTags?: readonly string[];
  /** The source run id — suffix + `inherited_from_run` for a row retired without a successor. */
  label: string;
  /** inherited id → the re-run row that replaced it. */
  successors?: Readonly<Record<string, string>>;
  /** inherited ids the re-run re-affirmed (kept live, unchanged). */
  reaffirmed?: ReadonlySet<string>;
}

export interface RetireStaleReport {
  /** `[inherited id, successor id]`. */
  supersededBy: Array<[string, string]>;
  /** `[old id, new id]` — retired with no successor. */
  retired: Array<[string, string]>;
  keptLive: string[];
  /** successor ids that are not live rows of the log (mapping errors). */
  badSuccessors: string[];
}

/**
 * After a re-run already appended next to live inherited rows: mark every
 * inherited row the re-run did not re-affirm as superseded — onto its
 * successor when one is named, otherwise in the `retireForRerun` shape.
 */
export function retireStaleInherited(
  input: DecisionsLog,
  opts: RetireStaleOptions,
): { log: DecisionsLog; report: RetireStaleReport } {
  const log: DecisionsLog = JSON.parse(JSON.stringify(input));
  const report: RetireStaleReport = { supersededBy: [], retired: [], keptLive: [], badSuccessors: [] };
  const byId = new Map(log.decisions.map((d) => [d.id, d]));
  for (const row of [...log.decisions]) {
    if (!opts.inheritedIds.has(row.id) || row.superseded_by !== undefined) continue;
    if (!inScope(row, opts)) continue;
    if (humanRuled(row) || opts.reaffirmed?.has(row.id)) {
      report.keptLive.push(row.id);
      continue;
    }
    const succ = opts.successors?.[row.id];
    if (succ !== undefined) {
      const target = byId.get(succ);
      if (!target || target.superseded_by !== undefined || target.id === row.id) {
        report.badSuccessors.push(succ);
        continue;
      }
      row.superseded_by = succ;
      row.inherited_from_run = opts.label;
      report.supersededBy.push([row.id, succ]);
      continue;
    }
    const old = row.id;
    report.retired.push([old, retireRow(log, row, opts.label, old)]);
  }
  return { log, report };
}
