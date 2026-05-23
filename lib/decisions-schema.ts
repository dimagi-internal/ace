import { z } from "zod";
import yaml from "yaml";

/**
 * Canonical schema version for the decisions log. Bump when introducing
 * a breaking change; pair with a migration in `migrations/`.
 *
 * v2 (2026-05-23): rename `default:` → `ai-default:`, add optional
 * `override:`, status enum is now `ai-default | overridden`.
 */
export const DECISIONS_SCHEMA_VERSION = 2 as const;

/**
 * One row in a per-run decisions log. Represents a load-bearing default
 * an ACE phase applied. When a human overrides via the workbench or
 * Slack, the override value is stored in `override:` and `ai-default:`
 * is preserved as the AI's original proposal.
 *
 * Effective value = `override` if present, else `ai-default`.
 */
export const DecisionRowSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
      message:
        "id must be canonical kebab-case (lowercase alphanumeric segments separated by single hyphens)",
    }),
    phase: z.string().regex(/^[1-9][0-9]*-[a-z]+(-[a-z]+)*$/, {
      message: "phase must match <N>-<kebab-name> (e.g. 1-design, 3-commcare)",
    }),
    skill: z.string().min(1),
    question: z.string().min(1),
    "ai-default": z.string().min(1),
    override: z.string().min(1).optional(),
    options_considered: z.array(z.string().min(1)),
    source: z.string().min(1),
    status: z.enum(["ai-default", "overridden"]),
    notes: z.string().optional(),
  })
  .superRefine((row, ctx) => {
    if (row.status === "overridden" && row.override === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "status=overridden requires `override` field",
        path: ["override"],
      });
    }
    if (row.status === "ai-default" && row.override !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "status=ai-default must not have `override` field",
        path: ["override"],
      });
    }
  });

export type DecisionRow = z.infer<typeof DecisionRowSchema>;

/**
 * The full per-run log file shape. Stored at
 * ACE/<opp>/runs/<run-id>/decisions.yaml.
 */
export const DecisionsLogSchema = z
  .object({
    schema_version: z.literal(DECISIONS_SCHEMA_VERSION),
    opportunity: z.string().min(1),
    run_id: z.string().min(1),
    generated_at: z.string().datetime({ offset: true }),
    decisions: z.array(DecisionRowSchema),
  })
  .superRefine((log, ctx) => {
    const seen = new Set<string>();
    for (const [index, row] of log.decisions.entries()) {
      if (seen.has(row.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate decision id: ${row.id}`,
          path: ["decisions", index, "id"],
        });
      }
      seen.add(row.id);
    }
  });

export type DecisionsLog = z.infer<typeof DecisionsLogSchema>;

/**
 * Parse a YAML string into a validated DecisionsLog.
 * Throws an Error whose message lists the dot-paths of each offending
 * field (e.g. "decisions.0.id") if validation fails.
 * Throws YAMLParseError if the YAML itself is unparseable.
 *
 * Transparently upgrades v1-shape input to v2 in memory so live runs
 * survive the schema bump without an explicit migration pass.
 */
export function parseDecisionsYaml(input: string): DecisionsLog {
  const raw = yaml.parse(input);
  const upgraded = maybeUpgradeFromV1(raw);
  const result = DecisionsLogSchema.safeParse(upgraded);
  if (!result.success) {
    const paths = result.error.issues
      .map((issue) => issue.path.join("."))
      .join(", ");
    throw new Error(`decisions log validation failed: ${paths}`);
  }
  return result.data;
}

/**
 * In-memory upgrade of a v1 decisions log to v2.
 *
 * v1 row:                   v2 row:
 *   default: X        →        ai-default: X
 *   status: applied   →        status: ai-default
 *   status: open      →        status: ai-default
 *   status: overridden →       status: overridden + override: X
 */
function maybeUpgradeFromV1(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const log = raw as { schema_version?: unknown; decisions?: unknown };
  if (log.schema_version !== 1) return raw;
  if (!Array.isArray(log.decisions)) return raw;

  const upgradedRows = log.decisions.map((r) => {
    if (typeof r !== "object" || r === null) return r;
    const row = r as Record<string, unknown>;
    const out: Record<string, unknown> = { ...row };

    if ("default" in out && !("ai-default" in out)) {
      out["ai-default"] = out["default"];
      delete out["default"];
    }

    if (out["status"] !== "overridden") {
      out["status"] = "ai-default";
    }

    if (out["status"] === "overridden" && !("override" in out)) {
      const aiDefault = out["ai-default"];
      if (typeof aiDefault === "string") {
        out["override"] = aiDefault;
      }
    }

    return out;
  });

  return { ...log, schema_version: 2, decisions: upgradedRows };
}

/**
 * Serialize a DecisionsLog into a YAML string suitable for writing to
 * ACE/<opp>/runs/<run-id>/decisions.yaml.
 *
 * - lineWidth: 0 — disables block-scalar folding so diffs are readable.
 * - aliasDuplicateObjects: false — suppresses YAML anchors.
 */
export function serializeDecisionsLog(log: DecisionsLog): string {
  DecisionsLogSchema.parse(log);
  return yaml.stringify(log, null, {
    lineWidth: 0,
    aliasDuplicateObjects: false,
  });
}

/**
 * Effective value for a row: the override if present, else the AI default.
 */
export function effectiveValue(row: DecisionRow): string {
  return row.override ?? row["ai-default"];
}
