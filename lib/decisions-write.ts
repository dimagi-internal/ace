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

import {
  DecisionRowStrictSchema,
  DecisionsLogSchema,
  type DecisionRow,
  type DecisionsLog,
} from "./decisions-schema.js";

/** Canonical filename — single source of truth for the storage shim. */
export const DECISIONS_FILENAME = "decisions.yaml" as const;

export interface ComposeResult {
  /** Serialized YAML ready to write to Drive. */
  content: string;
  /** Rows actually appended this call (excludes ids already present). */
  added: number;
  /** Rows skipped because their `id` was already present in the log. */
  skipped: string[];
  /** Total rows in the resulting log. */
  total: number;
}

export type DecisionsWriteCode =
  | "INVALID_ROW"
  | "DUPLICATE_BATCH_ID"
  | "MALFORMED_YAML"
  | "MALFORMED_LOG"
  | "IDENTITY_MISMATCH"
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
 * - When `existingYamlText` is present, it MUST parse as a v3 log and its
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

  const log: DecisionsLog = loadOrSeedLog({
    existingYamlText,
    opportunity,
    run_id,
    generated_at: now(),
  });

  const existingIds = new Set(log.decisions.map((d) => d.id));
  const skipped: string[] = [];
  let added = 0;
  for (const row of parsedRows) {
    if (existingIds.has(row.id)) {
      skipped.push(row.id);
      continue;
    }
    log.decisions.push(row);
    existingIds.add(row.id);
    added++;
  }

  const finalCheck = DecisionsLogSchema.safeParse(log);
  if (!finalCheck.success) {
    throw new DecisionsWriteError(
      "INTERNAL_INVARIANT",
      `composed log failed final validation (this is a bug): ${formatIssues(finalCheck.error.issues)}`,
    );
  }

  const content = yaml.stringify(log, { lineWidth: 0, aliasDuplicateObjects: false });
  return { content, added, skipped, total: log.decisions.length };
}

interface LoadArgs {
  existingYamlText: string | null;
  opportunity: string;
  run_id: string;
  generated_at: string;
}

function loadOrSeedLog(args: LoadArgs): DecisionsLog {
  const { existingYamlText, opportunity, run_id, generated_at } = args;
  if (!existingYamlText || !existingYamlText.trim()) {
    return {
      schema_version: 3,
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
  const result = DecisionsLogSchema.safeParse(parsed);
  if (!result.success) {
    throw new DecisionsWriteError(
      "MALFORMED_LOG",
      `existing decisions.yaml does not match DecisionsLogSchema v3: ${formatIssues(result.error.issues)}`,
    );
  }
  const log = result.data;
  if (log.opportunity !== opportunity || log.run_id !== run_id) {
    throw new DecisionsWriteError(
      "IDENTITY_MISMATCH",
      `opportunity/run_id mismatch: existing log is ${log.opportunity}/${log.run_id}, call provided ${opportunity}/${run_id}`,
    );
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
