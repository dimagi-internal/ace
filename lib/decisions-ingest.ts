/**
 * Run-init ingest: what a new run inherits from the run before it.
 *
 * ## The rule, and why it is asymmetric
 *
 * `decisions.yaml` stays PER-RUN. A new run does not share a ledger with its
 * predecessor; it ingests from it. What it inherits is weighted by WHERE the
 * decision came from, never by how recent it is:
 *
 * - **`human-decided` BINDS.** A person ruled. It carries forward as
 *   authoritative and a run that wants to change it must say so explicitly.
 * - **`ai-default` ADVISES.** ACE chose it; a later run may freely decide
 *   better. This is deliberate: `duplicate-detection-key` genuinely improved
 *   across runs (a naive fixed 15m radius became a ranked accuracy-weighted
 *   proximity queue). A binding ledger would have frozen the worse version.
 *   Prior AI decisions are evidence, not authority.
 * - **`needs-*` / unresolved carries as an OPEN QUESTION**, never collapsed
 *   into a confident-looking guess.
 * - **`superseded` does not travel at all.** It is history in the run that
 *   had it.
 *
 * ## Anti-cruft: one run back, not all of them
 *
 * Only the immediately-prior run is read, plus the accumulated human-decided
 * set. Reading N runs deep is how six runs of stale AI reasoning accumulate —
 * and that is not hypothetical: on 2026-08-19 the operator manually reset
 * `hh-poverty-targeting/open-questions.md` to "human-authored decisions and
 * human-owned open questions only", deleting everything ACE had raised or
 * re-derived across the previous six runs, "so this run derives its own
 * findings from inputs/ rather than inheriting six runs of prior ACE
 * reasoning". This function is that rule, executed automatically.
 *
 * An AI default that stops being re-derived simply falls out. No expiry
 * logic, no pruning job.
 */
import type { DecisionRow } from "./decisions-schema.js";

/** How much authority an inherited row carries into the new run. */
export const CARRY_AUTHORITIES = ["binding", "advisory", "open", "none"] as const;
export type CarryAuthority = (typeof CARRY_AUTHORITIES)[number];

export interface InheritedDecision {
  id: string;
  question: string;
  /** The prior run's effective value. */
  value: string;
  authority: CarryAuthority;
  /** Run the decision is inherited FROM. */
  from_run: string;
  /** Present on binding rows — who ruled, and when. */
  decided_by?: string;
  decided_at?: string;
  feedback_ref?: string;
  /** One line of the prior reasoning. Advisory context, deliberately compact. */
  why?: string;
}

export interface IngestResult {
  inherited: InheritedDecision[];
  /** Ids that did not travel, with the reason — a dropped decision should be visible. */
  dropped: { id: string; reason: string }[];
}

function authorityFor(row: DecisionRow): CarryAuthority {
  if (row.superseded_by !== undefined) return "none";
  switch (row.status) {
    case "human-decided":
      return "binding";
    case "overridden":
      // An operator override of a run-control gate is about THAT run's
      // execution, not a durable design ruling. It advises, it does not bind.
      return "advisory";
    case "ai-default":
      return "advisory";
    default:
      return "advisory";
  }
}

/** First sentence, capped — a digest, not the whole row. */
function digest(reasoning: string | undefined): string | undefined {
  if (!reasoning) return undefined;
  const first = reasoning.split(/(?<=[.!?])\s/)[0] ?? reasoning;
  return first.length > 240 ? `${first.slice(0, 237)}...` : first;
}

/**
 * Build the inheritance a new run starts from.
 *
 * @param priorRun    The immediately-prior run's decisions. NOT the full history.
 * @param priorRunId  Its run id, stamped onto every inherited row.
 * @param humanDecided Accumulated human rulings from earlier runs (opp-level).
 *                     These bind regardless of how long ago they were made —
 *                     a person's ruling does not decay just because ACE has
 *                     run since.
 */
export function ingestPriorRun(
  priorRun: DecisionRow[],
  priorRunId: string,
  humanDecided: { row: DecisionRow; runId: string }[] = [],
): IngestResult {
  const inherited: InheritedDecision[] = [];
  const dropped: { id: string; reason: string }[] = [];
  const seen = new Set<string>();

  // Human rulings first: they bind, and they must not be shadowed by a later
  // ai-default re-derivation of the same question.
  for (const { row, runId } of humanDecided) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    inherited.push({
      id: row.id,
      question: row.question,
      value: row.override ?? row["ai-default"],
      authority: "binding",
      from_run: runId,
      decided_by: row.decided_by,
      decided_at: row.decided_at,
      feedback_ref: row.feedback_ref,
      why: digest(row.override_reasoning ?? row.reasoning),
    });
  }

  for (const row of priorRun) {
    if (seen.has(row.id)) continue;
    const authority = authorityFor(row);
    if (authority === "none") {
      dropped.push({ id: row.id, reason: "superseded within its own run — history, not state" });
      continue;
    }
    seen.add(row.id);
    inherited.push({
      id: row.id,
      question: row.question,
      value: row.override ?? row["ai-default"],
      authority,
      from_run: priorRunId,
      decided_by: row.decided_by,
      decided_at: row.decided_at,
      feedback_ref: row.feedback_ref,
      why: digest(row.override_reasoning ?? row.reasoning),
    });
  }

  return { inherited, dropped };
}

/**
 * Does a new run's proposed row conflict with something a human settled?
 *
 * Returns null when the row is free to differ. Non-null means the run is
 * about to overwrite a human ruling and must either honour it or record an
 * explicit revision — the check that stops a reviewer's decision quietly
 * drifting back, which is what happened to all six of one reviewer's rulings
 * across the seven runs that followed hers.
 */
export function conflictsWithRuling(
  proposed: Pick<DecisionRow, "id" | "ai-default"> & { feedback_ref?: string },
  inherited: InheritedDecision[],
): InheritedDecision | null {
  const binding = inherited.filter((d) => d.authority === "binding");
  const match =
    binding.find((d) => d.id === proposed.id) ??
    (proposed.feedback_ref
      ? binding.find((d) => d.feedback_ref === proposed.feedback_ref)
      : undefined);
  if (!match) return null;
  return match.value === proposed["ai-default"] ? null : match;
}
