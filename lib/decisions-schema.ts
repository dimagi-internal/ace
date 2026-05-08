import { z } from "zod";
import yaml from "yaml";

/**
 * Canonical schema version for the decisions log. Bump when introducing
 * a breaking change; pair with a migration in `migrations/`.
 */
export const DECISIONS_SCHEMA_VERSION = 1 as const;

/**
 * One row in a per-run decisions log. Represents a load-bearing default
 * an ACE phase applied (or a load-bearing decision the AI flagged for
 * human attention while still proceeding with a default).
 *
 * See docs/superpowers/specs/2026-05-08-decisions-log-design.md § Schema
 * for field semantics and the bar criterion that gates row creation.
 */
export const DecisionRowSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    message: "id must be canonical kebab-case (lowercase alphanumeric segments separated by single hyphens)",
  }),
  phase: z.string().regex(/^[1-9][0-9]*-[a-z]+(-[a-z]+)*$/, {
    message: "phase must match <N>-<kebab-name> (e.g. 1-design, 2-commcare)",
  }),
  skill: z.string().min(1),
  question: z.string().min(1),
  default: z.string().min(1),
  options_considered: z.array(z.string().min(1)),
  source: z.string().min(1),
  status: z.enum(["applied", "overridden", "open"]),
  notes: z.string().optional(),
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
