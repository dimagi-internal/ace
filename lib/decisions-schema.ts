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
 *
 * v5 (2026-08-26): decisions carry their PROVENANCE and their RESOLUTION
 * OWNER, so settled judgment survives across runs.
 *
 * - `status` gains `human-decided`: a named person ruled on this during
 *   review and `ai-default` holds THEIR answer. Distinct from `overridden`,
 *   which is the point-and-click path where ACE proposed one value and a
 *   human replaced it (`ai-default` keeps ACE's proposal, `override` holds
 *   the human's). A ruling that arrives as INPUT — a review doc, an email —
 *   has no ACE proposal to preserve, and inventing a counterfactual one is
 *   fiction. Measured on 22 runs of spark-facilitator + hh-poverty-targeting:
 *   31 rows carried `feedback_ref` (a reviewer demonstrably shaped them) and
 *   all 31 were stamped `ai-default`, so nothing entered
 *   `decision-overrides.yaml` and every one of those rulings was re-derived
 *   from scratch on the next run.
 *
 * - `value_set_by` records whether the value is ACE's to set (`ace`) or
 *   arrives later from outside (`external`) — a negotiated rate, a contract
 *   date, a cohort size fixed at deployment. ACE still emits its best
 *   estimate and keeps going either way; nothing blocks and there is no
 *   escalation path. The flag only says whether the value is a decision or
 *   a projection, so a later run re-deriving it differently is expected
 *   rather than drift. ACE already made this distinction in prose —
 *   hh-poverty run 20260702-1456 wrote "Deferred to deployment (Annex B);
 *   negotiated via solicitation response" INSIDE `ai-default` on four rows,
 *   all of which had become confident numbers within a few runs.
 *
 * All three fields are OPTIONAL on the permissive read schema (pre-v5 logs
 * lack them). `value_set_by` is REQUIRED on new strict writes.
 */
export const DECISIONS_SCHEMA_VERSION = 5 as const;

/**
 * Schema versions a reader will accept. New writes seed `DECISIONS_SCHEMA_VERSION`;
 * reads degrade gracefully across the supported set so a log started under an
 * older writer keeps parsing after a version bump.
 */
export const SUPPORTED_SCHEMA_VERSIONS = [3, 4, 5] as const;

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
    supersedes: z
      .string()
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
      .optional()
      .describe(
        "Id of an earlier row this one CORRECTS. The write boundary stamps `superseded_by` on that " +
          "row, so the log keeps both the wrong value and its reasoning (the point of an audit log) " +
          "while making the live value unambiguous. Must name a row that already exists in the log " +
          "or earlier in the same batch — a dangling reference is rejected.",
      ),
    superseded_by: z
      .string()
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
      .optional()
      .describe(
        "Set by `decisions_append_rows`, never by an emitting skill. Names the row that replaced this " +
          "one. A row carrying this is HISTORY: consumers must resolve to the row that does not carry it.",
      ),
    status: z
      .enum(["ai-default", "human-decided", "overridden"])
      .describe(
        "WHO settled this row. " +
          "`ai-default`: ACE chose — its standing judgment, freely re-decidable by a later run. " +
          "`human-decided`: a named person ruled during review and `ai-default` holds THEIR answer; " +
          "requires `decided_by` + `decided_at`, and carries FORWARD as binding into later runs. " +
          "`overridden`: ACE proposed `ai-default` and a human replaced it via the override path, " +
          "which keeps both values. " +
          "Note this axis is about AUTHORSHIP only — it never gates or blocks a run. " +
          "Whether a value is ACE's to set at all is `value_set_by`, a separate question.",
      ),
    decided_by: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Email (or stable identifier) of the person whose ruling this row records. " +
          "REQUIRED when `status: human-decided`. Pair with `feedback_ref` when the ruling " +
          "came from a logged review record so the feedback ledger can join the two.",
      ),
    decided_at: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}([T ].*)?$/, {
        message: "decided_at must be an ISO date (YYYY-MM-DD) or ISO timestamp",
      })
      .optional()
      .describe(
        "When the person ruled. REQUIRED when `status: human-decided`. This is the ruling's own " +
          "date, not the run's — a ruling from a prior run keeps its original date when carried forward.",
      ),
    value_set_by: z
      .enum(["ace", "external"])
      .optional()
      .describe(
        "WHO ultimately sets this value — orthogonal to `status`, which records who settled it here. " +
          "`ace`: ACE's judgment to make from the source material (archetype, verification layers, " +
          "solicitation type). " +
          "`external`: the real value is fixed later by someone else — a negotiated rate in a " +
          "solicitation response, dates on contract execution, an FLW count set at deployment. " +
          "ACE STILL fills `ai-default` with its best estimate and proceeds; this flag does not " +
          "block, escalate, or defer anything. It marks the value as a PROJECTION so downstream " +
          "phases do not cite it as settled and a later run re-deriving it differently reads as " +
          "expected rather than as drift. " +
          "Optional on the permissive read schema for pre-v5 logs; REQUIRED on new writes.",
      ),
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
    feedback_ref: z
      .string()
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*\/[a-z0-9]+(-[a-z0-9]+)*$/, {
        message:
          "feedback_ref must be `<record-slug>/<item-id>` (e.g. `20260727-sophie-feintuch/c`)",
      })
      .optional()
      .describe(
        "Provenance stamp: the external-review item that caused this row, as `<record-slug>/<item-id>`. " +
          "Set ONLY when a reviewer's comment drove the decision. The feedback ledger joins on this field " +
          "(see `lib/feedback-ledger.ts`) to answer 'where did my comment go?' — a decision made in response " +
          "to review feedback and left unstamped renders as UNROUTED in the ledger, which is the intended " +
          "loud failure. Note the ledger is a DERIVED view: this field is the only write-side obligation.",
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
    if (row.status === "human-decided") {
      if (row.decided_by === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "status=human-decided requires `decided_by` — an unattributed ruling cannot be carried forward or re-escalated",
          path: ["decided_by"],
        });
      }
      if (row.decided_at === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "status=human-decided requires `decided_at`",
          path: ["decided_at"],
        });
      }
      if (row.override !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "status=human-decided must not have `override` — the human's answer IS `ai-default`. Use status=overridden when ACE proposed a value a human then replaced.",
          path: ["override"],
        });
      }
    }
    if (row.status !== "human-decided" && row.decided_by !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "`decided_by` is only valid on status=human-decided",
        path: ["decided_by"],
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
    // v5: every new row must declare whether the value is ACE's to set or
    // arrives later from outside. This does NOT gate the run — ACE fills its
    // best estimate and proceeds either way. It exists so a projection is not
    // read downstream as a settled decision, and so the re-derivation of a
    // projection on the next run is legible as expected rather than as drift.
    if (row.value_set_by === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "`value_set_by` is required on every new decision row — 'ace' (ACE's judgment to make " +
          "from the source material) or 'external' (the real value is fixed later by a solicitation " +
          "response, a contract, or deployment; ACE's value is its best estimate and still ships).",
        path: ["value_set_by"],
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
    // Derived from SUPPORTED_SCHEMA_VERSIONS rather than restated as a literal
    // union — the two had already drifted apart once (the union still said
    // [3, 4] after the constant moved on), which fails as an opaque
    // "schema_version: Invalid input" from deep inside a write.
    schema_version: z
      .union(
        SUPPORTED_SCHEMA_VERSIONS.map((v) => z.literal(v)) as unknown as [
          z.ZodLiteral<number>,
          z.ZodLiteral<number>,
          ...z.ZodLiteral<number>[],
        ],
      )
      .describe(
        `Decisions-log schema version. Reads accept ${SUPPORTED_SCHEMA_VERSIONS.join(", ")} ` +
          `(v3 legacy has no \`evidence_basis\`; v4 has no \`value_set_by\`); ` +
          `new logs are seeded at v${DECISIONS_SCHEMA_VERSION} (DECISIONS_SCHEMA_VERSION).`,
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

/**
 * Rows that are still LIVE — i.e. not corrected by a later row.
 *
 * ace#1421. `decisions.yaml` is append-only and `decisions_append_rows` is
 * idempotent-by-id, so a row can never be edited in place. That is the right
 * write semantic, but without supersession a mid-run correction leaves the log
 * holding the wrong value AND the right one, both `status: ai-default`, with
 * nothing machine-readable saying which wins.
 *
 * That is a correctness problem, not tidiness: `pdd-to-work-order § Process`
 * step 3(a) tells the next skill to look up a canonical id and "use that value
 * as-is", which on bednet-check-2-visit/20260814-2019 would have resolved
 * `payment-rate` to a superseded per-visit band and put it into the Phase 4
 * payment unit and a contractual document.
 */
export function liveDecisions(log: DecisionsLog): DecisionRow[] {
  return log.decisions.filter((d) => d.superseded_by === undefined);
}

/**
 * Resolve an id to the row that is actually live, following the supersession
 * chain. Returns undefined when the id is absent.
 *
 * Prefer this over a bare `.find(d => d.id === wanted)` in any consumer that
 * reads a canonical id — that is exactly the lookup that returns history.
 */
export function resolveDecision(
  log: DecisionsLog,
  id: string,
): DecisionRow | undefined {
  const byId = new Map(log.decisions.map((d) => [d.id, d]));
  let row = byId.get(id);
  const seen = new Set<string>();
  while (row?.superseded_by !== undefined) {
    if (seen.has(row.id)) return row; // cycle guard; the writer rejects these
    seen.add(row.id);
    const next = byId.get(row.superseded_by);
    if (next === undefined) return row; // dangling; the writer rejects these
    row = next;
  }
  return row;
}
