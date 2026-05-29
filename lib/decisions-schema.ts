import { z } from "zod";
import yaml from "yaml";

/**
 * Canonical schema version for the decisions log.
 *
 * v3 (2026-05-24): separates reasoning from pickable values for
 * multiplayer editing. Fields: `options` (short scannable labels),
 * `reasoning` (AI's rationale), `override_reasoning` (human's
 * rationale when overriding), `source` (citation only).
 *
 * v4 (2026-05-29): every row declares its `evidence_basis`
 * (`stated` | `inferred` | `conflicting`) so a reviewer can tell, at a
 * glance, whether a default is sourced, extrapolated, or a resolution of
 * disagreeing source signals. When `conflicting`, `conflict_signals`
 * enumerates the competing readings — the silent-conflict-resolution
 * failure mode (e.g. ITN "visited twice" vs. a one-instrument spec) is
 * now structurally surfaced instead of buried in prose. Both fields are
 * OPTIONAL on the permissive read schema (pre-v4 logs lack them) and
 * REQUIRED on every new write (DecisionRowStrictSchema).
 */
export const DECISIONS_SCHEMA_VERSION = 4 as const;

/**
 * Schema versions a reader will accept. New writes seed `DECISIONS_SCHEMA_VERSION`;
 * reads degrade gracefully across the supported set so a log started under an
 * older writer keeps parsing after a version bump.
 */
export const SUPPORTED_SCHEMA_VERSIONS = [3, 4] as const;

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
    evidence_basis: z
      .enum(["stated", "inferred", "conflicting"])
      .optional()
      .describe(
        "How well-grounded this default is in the source material. " +
          "`stated`: the value is directly stated in a source input. " +
          "`inferred`: extrapolated beyond what any source states (a reasoned default the source did not specify). " +
          "`conflicting`: the source signals disagree and this row RESOLVES that conflict — `conflict_signals` must enumerate the competing readings. " +
          "Optional on the permissive read schema for back-compat with pre-v4 logs; REQUIRED on every new write (DecisionRowStrictSchema).",
      ),
    conflict_signals: z
      .array(z.string().min(1))
      .optional()
      .describe(
        "The competing source readings this decision had to resolve — one entry per signal, each ideally citing where it came from " +
          "(e.g. 'Exploration App § Visit structure: one instrument' / 'Exploration App § Open-Q4: households visited twice'). " +
          "Required (>= 2 entries) when `evidence_basis: conflicting`; omit otherwise. Put the resolution rationale in `reasoning`.",
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
    // v4: every new row must declare how grounded the default is. This is the
    // forcing function that stops Phase-1 from silently resolving a contested
    // fork and presenting it as a confident single-cited default.
    if (row.evidence_basis === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "`evidence_basis` is required on every new decision row — one of: " +
          "'stated' (value is directly in a source), 'inferred' (extrapolated beyond any source), " +
          "or 'conflicting' (resolves disagreeing sources; set `conflict_signals`).",
        path: ["evidence_basis"],
      });
    }
    if (row.evidence_basis === "conflicting") {
      if (!row.conflict_signals || row.conflict_signals.length < 2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "`evidence_basis: conflicting` requires `conflict_signals` with at least 2 entries — " +
            "enumerate the competing source readings you resolved. Put the resolution rationale in `reasoning`.",
          path: ["conflict_signals"],
        });
      }
    } else if (row.conflict_signals !== undefined && row.conflict_signals.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "`conflict_signals` is only valid when `evidence_basis: conflicting`. " +
          "For a 'stated' or 'inferred' default, omit it (put any nuance in `reasoning`).",
        path: ["conflict_signals"],
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
    schema_version: z
      .union([z.literal(3), z.literal(4)])
      .describe(
        "Decisions-log schema version. Reads accept v3 (legacy, no `evidence_basis`) and v4; " +
          "new logs are seeded at v4 (DECISIONS_SCHEMA_VERSION).",
      ),
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
