import { z } from "zod";
import yaml from "yaml";

/**
 * Canonical schema version for the decisions log.
 *
 * v3 (2026-05-24): separates reasoning from pickable values for
 * multiplayer editing. Fields: `options` (short scannable labels),
 * `reasoning` (AI's rationale), `override_reasoning` (human's
 * rationale when overriding), `source` (citation only).
 */
export const DECISIONS_SCHEMA_VERSION = 3 as const;

/**
 * One row in a per-run decisions log. Represents a load-bearing default
 * an ACE phase applied. When a human overrides via the
 * renderer + sync skills, the override value is stored in `override:`
 * and `ai-default:` is preserved as the AI's original proposal.
 *
 * Effective value = `override` if present else `ai-default`.
 *
 * v3 separates reasoning from pickable values for multiplayer editing:
 * - `options` (was `options_considered`): short, scannable labels
 * - `reasoning` (was `notes`): AI's rationale — why this option
 * - `override_reasoning`: human's rationale — why they overrode
 * - `source`: citation only (where the info came from), not reasoning
 *
 * See docs/superpowers/specs/2026-05-08-decisions-log-design.md § Schema
 * for the bar criterion that gates row creation.
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
    "ai-default": z
      .string()
      .min(1)
      .describe(
        "The AI's picked value as a literal string. MUST be one of the strings in `options`, exact-match. " +
          "Put rationale in `reasoning`, citations in `source`. Never put prose or explanations here — " +
          "the ace-web UI keys point-and-click overrides off exact string equality with one of the `options` pills.",
      ),
    override: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Human override value (only set when status=overridden). MUST be one of the strings in `options`, " +
          "exact-match. Put the human's rationale in `override_reasoning`.",
      ),
    options: z
      .array(z.string().min(1))
      .describe(
        "Short, scannable labels — the closed set of possible answers the AI considered. " +
          "Each label should be 1-8 words; put long rationale in `reasoning`, not in option labels.",
      ),
    reasoning: z
      .string()
      .optional()
      .describe(
        "The AI's rationale for picking the `ai-default` option — why this option over the alternatives. " +
          "All prose belongs here, never in `ai-default`.",
      ),
    source: z
      .string()
      .min(1)
      .describe(
        "Citation only — where the AI sourced the info (e.g. 'PDD § Evidence Model', 'EOI responses spreadsheet row 4'). " +
          "Not a place for rationale; use `reasoning` for that.",
      ),
    status: z.enum(["ai-default", "overridden"]),
    override_reasoning: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Human's rationale for overriding (only set when status=overridden). Mirrors `reasoning` on the AI side.",
      ),
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
 * Strict variant: enforces `ai-default ∈ options` and `override ∈ options`.
 *
 * Used at every write boundary (mcp/decisions-server.ts, lib/decisions-write.ts)
 * so the AI can't ship rows whose `ai-default` is prose-extension of an option
 * label or a categorically different answer than the `options` array. The
 * ace-web UI's point-and-click override pattern requires exact string equality
 * between `ai-default` (or `override`) and one of the option pills — without
 * this invariant, no pill renders as selected and clicking another pill can't
 * encode the override cleanly.
 *
 * Reads (`parseDecisionsYaml`, `DecisionsLogSchema`) keep using the permissive
 * `DecisionRowSchema` so legacy decisions.yaml files from runs predating this
 * check still parse. New writes are strict; old reads degrade gracefully.
 */
export const DecisionRowStrictSchema = DecisionRowSchema.superRefine(
  (row, ctx) => {
    if (!row.options.includes(row["ai-default"])) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `\`ai-default\` (${JSON.stringify(row["ai-default"])}) must be one of the strings in \`options\` ` +
          `(${JSON.stringify(row.options)}), exact-match. Put the rationale in \`reasoning\`, not in \`ai-default\`.`,
        path: ["ai-default"],
      });
    }
    if (row.override !== undefined && !row.options.includes(row.override)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `\`override\` (${JSON.stringify(row.override)}) must be one of the strings in \`options\` ` +
          `(${JSON.stringify(row.options)}), exact-match. Put the human's rationale in \`override_reasoning\`, not in \`override\`.`,
        path: ["override"],
      });
    }
  },
);

export type DecisionRowStrict = z.infer<typeof DecisionRowStrictSchema>;

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
 * - lineWidth: 0 — disables block-scalar folding so long `reasoning`
 *   paragraphs stay one-line and diffs are readable.
 * - aliasDuplicateObjects: false — suppresses YAML anchors/aliases
 *   that are valid but unreadable for human reviewers.
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
