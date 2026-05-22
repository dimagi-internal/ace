import { z } from "zod";
import yaml from "yaml";

/**
 * Canonical schema version for the decisions log. Bump when introducing
 * a breaking change; pair with a migration in `migrations/`.
 *
 * v2 (2026-05-22): rename `default:` field to `ai-default:`; add optional
 * `override:` field; drop `open` from status enum. See
 * docs/superpowers/specs/2026-05-22-fork-decisions-modes-design.md.
 */
export const DECISIONS_SCHEMA_VERSION = 2 as const;

/**
 * One row in a per-run decisions log. Represents a load-bearing default
 * an ACE phase applied. When a human overrides via the
 * renderer + sync skills, the override value is stored in `override:`
 * and `ai-default:` is preserved as the AI's original proposal.
 *
 * Effective value = `override` if present else `ai-default`.
 *
 * See docs/superpowers/specs/2026-05-08-decisions-log-design.md § Schema
 * for the bar criterion that gates row creation; v2 schema is
 * documented in docs/superpowers/specs/2026-05-22-fork-decisions-modes-design.md.
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
    status: z.enum(["applied", "overridden"]),
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
    if (row.status === "applied" && row.override !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "status=applied must not have `override` field",
        path: ["override"],
      });
    }
  });

export type DecisionRow = z.infer<typeof DecisionRowSchema>;

/**
 * The full per-run log file shape. Stored at
 * ACE/<opp>/runs/<run-id>/decisions.yaml.
 *
 * See docs/superpowers/specs/2026-05-08-decisions-log-design.md § Schema
 * for field semantics.
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
 */
export function parseDecisionsYaml(input: string): DecisionsLog {
  const raw = yaml.parse(input);
  const result = DecisionsLogSchema.safeParse(raw);
  if (!result.success) {
    const paths = result.error.issues
      .map((issue) => issue.path.join("."))
      .join(", ");
    throw new Error(`decisions log validation failed: ${paths}`);
  }
  return result.data;
}

/**
 * Serialize a DecisionsLog into a YAML string suitable for writing to
 * ACE/<opp>/runs/<run-id>/decisions.yaml.
 *
 * - lineWidth: 0 — the `yaml` package disables block-scalar folding when
 *   lineWidth is 0 or negative; long `notes` paragraphs stay one-line so
 *   diffs are readable.
 * - aliasDuplicateObjects: false — suppresses `&ref_0`/`*ref_0` YAML
 *   anchors when two decisions share an identical `notes` or option
 *   string. Anchors are valid YAML but unreadable for human reviewers.
 */
export function serializeDecisionsLog(log: DecisionsLog): string {
  // Validate before emitting — catches caller errors before we write.
  DecisionsLogSchema.parse(log);
  return yaml.stringify(log, null, {
    lineWidth: 0,
    aliasDuplicateObjects: false,
  });
}

/**
 * Effective value for a row: the override if present, else the AI default.
 * Use whenever consumers need the "current" value rather than the
 * AI's original proposal.
 */
export function effectiveValue(row: DecisionRow): string {
  return row.override ?? row["ai-default"];
}
