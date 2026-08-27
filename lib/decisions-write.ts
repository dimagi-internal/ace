/**
 * Pure-function composer for per-run decisions.yaml.
 *
 * The MCP `decisions_append_rows` tool (mcp/decisions-server.ts) handles
 * the Drive read/write; this module owns the schema-validated mutation:
 *
 *   existing YAML (or empty)  ──►  validate + dedupe + append  ──►  new YAML
 *
 * Schema authority is `lib/decisions-schema.ts`. Every row goes through
 * `DecisionRowStrictSchema.parse` before it touches the log (enforces
 * `ai-default` and `override` are exact-match members of `options`,
 * load-bearing for the ace-web point-and-click override UX); the final log is
 * re-validated via `DecisionsLogSchema.parse` before serialization — so a
 * call that succeeds is guaranteed to leave the file readable by every
 * downstream consumer (decisions-render, decisions-sync, ace-web parser).
 */

import yaml from "yaml";
import { z } from "zod";

import {
  DECISIONS_SCHEMA_VERSION,
  DecisionRowStrictSchema,
  DecisionsLogSchema,
  type DecisionRow,
  type DecisionsLog,
} from "./decisions-schema.js";
import {
  applyDecisionOverrides,
  type DecisionOverrideRow,
} from "./decision-overrides.js";

/** Canonical filename — single source of truth for the storage shim. */
export const DECISIONS_FILENAME = "decisions.yaml" as const;

export interface ComposeResult {
  /** Serialized YAML ready to write to Drive. */
  content: string;
  /**
   * Non-fatal repairs made to an inherited header (ace#1029). Empty on a
   * healthy log. Surfaced by `decisions_append_rows` so a silent repair is
   * still visible to the operator — the point is that the run keeps its
   * decisions trail, not that the damage goes unmentioned.
   */
  warnings: string[];
  /** Rows actually appended this call (excludes ids already present). */
  added: number;
  /** Rows skipped because their `id` was already present in the log. */
  skipped: string[];
  /** Total rows in the resulting log. */
  total: number;
  /**
   * ids of appended rows that a reviewer override (from
   * `inputs/decision-overrides.yaml`, ace#933) bound to. Rows skipped as
   * already-present are never counted here.
   */
  overridesApplied: string[];
  /** Rows stamped `human-decided` because a saved ruling matched their
   * `feedback_ref` rather than their id. Reported separately so a run can see
   * that a reviewer's decision reached a row it had renamed. */
  rulingsApplied: string[];
  /** feedback_refs that matched but carried no `decided_by`/`decided_at`, so
   * the attribution claim was refused. Surfaced rather than swallowed — a
   * silently-dropped reviewer ruling is the exact failure this closes. */
  rulingsSkippedUnattributed: string[];
}

export type DecisionsWriteCode =
  | "INVALID_ROW"
  | "DUPLICATE_BATCH_ID"
  | "MALFORMED_YAML"
  | "MALFORMED_LOG"
  | "IDENTITY_MISMATCH"
  // ace#1421 — supersession, validated at the write boundary.
  | "SELF_SUPERSEDES"
  | "DANGLING_SUPERSEDES"
  | "ALREADY_SUPERSEDED"
  | "INTERNAL_INVARIANT";

export class DecisionsWriteError extends Error {
  readonly code: DecisionsWriteCode;
  constructor(code: DecisionsWriteCode, message: string) {
    super(message);
    this.name = "DecisionsWriteError";
    this.code = code;
  }
}

export interface ComposeArgs {
  /** Existing decisions.yaml contents. Empty / whitespace seeds a new log. */
  existingYamlText: string | null;
  /** Opp slug (e.g. `bednet-spot-check`). */
  opportunity: string;
  /** Run id (e.g. `20260525-2013`). */
  run_id: string;
  /** Rows to append. Each is validated via `DecisionRowStrictSchema`. */
  rows: unknown[];
  /**
   * Reviewer overrides from the opp's `inputs/decision-overrides.yaml`
   * (parsed via `parseDecisionOverridesYaml`). Applied to matching batch
   * rows AFTER strict validation and BEFORE the append: matching rows get
   * `override` + `status: overridden` + `override_reasoning`, with the
   * override value appended to `options` if missing. Override ids the batch
   * never raises are ignored. Omit / null when no overrides file exists.
   */
  overrides?: DecisionOverrideRow[] | null;
  /**
   * Override for `generated_at` when seeding a new log. Tests pin this so
   * fixtures are stable; production callers leave it unset.
   */
  now?: () => string;
}

/**
 * Append rows to (or seed) a decisions log. Pure function — no I/O.
 *
 * Behavior:
 * - Every input row is `DecisionRowStrictSchema.parse`d first. A single invalid
 *   row aborts the entire batch (no partial writes).
 * - Intra-batch duplicate `id`s throw — they always indicate a caller bug.
 * - Rows whose `id` is already present in the existing log are SKIPPED
 *   silently, so a re-run of the same skill (e.g. orchestrator retry) is
 *   idempotent.
 * - When `existingYamlText` is empty / null, a fresh log header is seeded
 *   from `opportunity` + `run_id` + `now()`.
 * - When `existingYamlText` is present, it MUST parse as a v3/v4 log and its
 *   `opportunity` / `run_id` MUST match the caller. Any mismatch is a
 *   structural error — silently overwriting another opp's log would be a
 *   data-loss bug.
 * - The composed log is re-validated before serialization, guaranteeing
 *   downstream consumers can parse it.
 */
export function composeAppendedLog(args: ComposeArgs): ComposeResult {
  const { existingYamlText, opportunity, run_id, rows } = args;
  const now = args.now ?? (() => new Date().toISOString());

  const parsedRows: DecisionRow[] = rows.map((row, i) => {
    // Strict variant on the write boundary: rejects rows whose `ai-default`
    // (or `override`) isn't in `options`. The ace-web UI's point-and-click
    // override pattern needs exact string equality with one of the option
    // pills, so this invariant is load-bearing for the UX. Permissive reads
    // (parseDecisionsYaml) keep the base `DecisionRowSchema` for legacy data.
    const r = DecisionRowStrictSchema.safeParse(row);
    if (!r.success) {
      throw new DecisionsWriteError(
        "INVALID_ROW",
        `rows[${i}] failed schema validation: ${formatIssues(r.error.issues)}`,
      );
    }
    return r.data;
  });

  const batchSeen = new Set<string>();
  for (const row of parsedRows) {
    if (batchSeen.has(row.id)) {
      throw new DecisionsWriteError(
        "DUPLICATE_BATCH_ID",
        `duplicate id within batch: ${row.id}`,
      );
    }
    batchSeen.add(row.id);
  }

  // Bind reviewer overrides (ace-web's inputs/decision-overrides.yaml) onto
  // the strictly-validated batch. Post-transform rows keep the strict
  // invariant by construction (the override value is appended to `options`).
  const overridden = applyDecisionOverrides(parsedRows, args.overrides ?? []);

  const warnings: string[] = [];
  const log: DecisionsLog = loadOrSeedLog(
    { existingYamlText, opportunity, run_id, generated_at: now() },
    warnings,
  );

  const existingIds = new Set(log.decisions.map((d) => d.id));
  const skipped: string[] = [];
  const overridesApplied: string[] = [];
  const rulingsApplied: string[] = [];
  const appliedIds = new Set(overridden.applied);
  const rulingIds = new Set(overridden.appliedByFeedbackRef);
  let added = 0;
  for (const row of overridden.rows) {
    if (existingIds.has(row.id)) {
      skipped.push(row.id);
      continue;
    }
    log.decisions.push(row);
    existingIds.add(row.id);
    if (appliedIds.has(row.id)) overridesApplied.push(row.id);
    if (rulingIds.has(row.id)) rulingsApplied.push(row.id);
    added++;
  }

  // ── Supersession (ace#1421) ─────────────────────────────────────────────
  // A row declaring `supersedes: X` stamps `superseded_by` onto X, so the log
  // keeps the wrong value and its reasoning while the live value is
  // unambiguous. Validated at the write boundary, like the options/ai-default
  // invariant above — a dangling reference here is worse than a rejected
  // write, because the consumer contract is "look up the canonical id and use
  // it as-is".
  const byId = new Map(log.decisions.map((d) => [d.id, d]));
  for (const row of overridden.rows) {
    const target = row.supersedes;
    if (target === undefined) continue;
    // Only act for rows we actually appended; a skipped (already-present) row
    // has already had its effect applied on the run that first wrote it.
    if (skipped.includes(row.id)) continue;

    if (target === row.id) {
      throw new DecisionsWriteError(
        "SELF_SUPERSEDES",
        `row ${row.id} declares supersedes: ${target} — a row cannot supersede itself`,
      );
    }
    const predecessor = byId.get(target);
    if (predecessor === undefined) {
      throw new DecisionsWriteError(
        "DANGLING_SUPERSEDES",
        `row ${row.id} declares supersedes: ${target}, which is not in the log or this batch. ` +
          `Append the row you are correcting first, or fix the id.`,
      );
    }
    if (
      predecessor.superseded_by !== undefined &&
      predecessor.superseded_by !== row.id
    ) {
      throw new DecisionsWriteError(
        "ALREADY_SUPERSEDED",
        `row ${target} is already superseded by ${predecessor.superseded_by}; ` +
          `${row.id} cannot also supersede it. Supersede ${predecessor.superseded_by} instead ` +
          `so the chain stays single-valued.`,
      );
    }
    predecessor.superseded_by = row.id;
  }

  const finalCheck = DecisionsLogSchema.safeParse(log);
  if (!finalCheck.success) {
    throw new DecisionsWriteError(
      "INTERNAL_INVARIANT",
      `composed log failed final validation (this is a bug): ${formatIssues(finalCheck.error.issues)}`,
    );
  }

  const content = yaml.stringify(log, { lineWidth: 0, aliasDuplicateObjects: false });
  return {
    content,
    warnings,
    added,
    skipped,
    total: log.decisions.length,
    overridesApplied,
    rulingsApplied,
    rulingsSkippedUnattributed: overridden.skippedUnattributed,
  };
}

interface LoadArgs {
  existingYamlText: string | null;
  opportunity: string;
  run_id: string;
  generated_at: string;
}

/**
 * Repair a parseable-but-non-ISO `generated_at` in place (ace#1029).
 *
 * A SEEDED run inherits the parent's header verbatim, and the seeding path
 * (outside this repo) re-emits the timestamp in Python's `str(datetime)` shape
 * — space separator, 6-digit microseconds, `+00:00` — which
 * `z.string().datetime({offset: true})` rejects. That made a provenance field
 * able to reject EVERY decision write for the whole run, and since this atom is
 * the only sanctioned writer, the run lost its decisions trail silently.
 *
 * Scope is deliberately narrow: only a value carrying a recoverable instant is
 * rewritten. A header with no parseable timestamp is genuinely corrupt and is
 * left alone so schema validation still fails loud.
 */
function normalizeGeneratedAt(parsed: unknown, warnings: string[]): void {
  if (!parsed || typeof parsed !== "object") return;
  const obj = parsed as Record<string, unknown>;
  const raw = obj.generated_at;
  const asString =
    raw instanceof Date ? raw.toISOString() : typeof raw === "string" ? raw : undefined;
  if (asString === undefined) return;
  if (ISO_DATETIME.safeParse(asString).success) return; // already canonical — leave byte-identical
  const parsedDate = new Date(asString);
  if (Number.isNaN(parsedDate.getTime())) return; // unrecoverable — let the schema reject it
  obj.generated_at = parsedDate.toISOString();
  warnings.push(
    `repaired non-ISO generated_at in the existing decisions.yaml: ` +
      `${JSON.stringify(asString)} -> ${JSON.stringify(obj.generated_at)} ` +
      `(inherited header, dimagi-internal/ace#1029)`,
  );
}

const ISO_DATETIME = z.string().datetime({ offset: true });

function loadOrSeedLog(args: LoadArgs, warnings: string[]): DecisionsLog {
  const { existingYamlText, opportunity, run_id, generated_at } = args;
  if (!existingYamlText || !existingYamlText.trim()) {
    return {
      schema_version: DECISIONS_SCHEMA_VERSION,
      opportunity,
      run_id,
      generated_at,
      decisions: [],
    };
  }
  let parsed: unknown;
  try {
    parsed = yaml.parse(existingYamlText);
  } catch (e) {
    throw new DecisionsWriteError(
      "MALFORMED_YAML",
      `existing decisions.yaml is not valid YAML: ${(e as Error).message}`,
    );
  }
  normalizeGeneratedAt(parsed, warnings);
  const result = DecisionsLogSchema.safeParse(parsed);
  if (!result.success) {
    throw new DecisionsWriteError(
      "MALFORMED_LOG",
      `existing decisions.yaml does not match DecisionsLogSchema (v3/v4): ${formatIssues(result.error.issues)}`,
    );
  }
  const log = result.data;
  // OPPORTUNITY mismatch stays fatal: silently appending this opp's decisions
  // to another opp's log is the data-loss bug this guard exists for.
  if (log.opportunity !== opportunity) {
    throw new DecisionsWriteError(
      "IDENTITY_MISMATCH",
      `opportunity mismatch: existing log is ${log.opportunity}/${log.run_id}, call provided ${opportunity}/${run_id}`,
    );
  }
  // RUN_ID mismatch is warn-and-adopt (ace#1029). The log's LOCATION —
  // runs/<run-id>/decisions.yaml — is the authority on which run it belongs
  // to; a seeded copy's inherited `run_id` is just a stale label, and treating
  // it as fatal bricked every write for the run rather than fixing the label.
  if (log.run_id !== run_id) {
    warnings.push(
      `adopted run_id ${run_id} for a decisions.yaml whose header claimed ` +
        `${log.run_id} (inherited from the seed run; the run folder is the ` +
        `authority, dimagi-internal/ace#1029)`,
    );
    log.run_id = run_id;
  }
  return log;
}

interface ZodLikeIssue {
  path: (string | number)[];
  message: string;
}

function formatIssues(issues: readonly ZodLikeIssue[]): string {
  return issues
    .map((it) => `${it.path.length > 0 ? it.path.join(".") : "<root>"}: ${it.message}`)
    .join("; ");
}
