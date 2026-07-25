/**
 * Reviewer decision-overrides — the consume half of ace-web's
 * "Save to Drive" flow (dimagi-internal/ace-web#673, ace#933).
 *
 * ace-web's Phases tab → Decisions panel lets a reviewer durably save
 * decision overrides WITHOUT triggering a run, writing them to
 * `ACE/<opp>/inputs/decision-overrides.yaml`. This module owns the ACE-side
 * contract for that file: the read schema (schema_version 1) and the pure
 * transform that binds saved overrides onto decision rows as a run raises
 * them.
 *
 * Application point is the decisions write boundary
 * (`decisions_append_rows` → `composeAppendedLog`): every row any skill
 * emits passes through it, so overrides bind with zero per-skill changes.
 * Override rows whose `id` a run never raises are ignored by construction —
 * they simply never match (the file's rows are opp-level and cumulative
 * across review sessions, so unmatched ids are expected, not an error).
 *
 * Row identity is `id` alone. The file's `phase` / `question` / `ai_default`
 * are denormalized provenance snapshots from the SOURCE run (ace-web writes
 * the phase agent name, e.g. `idea-to-design`, not the decisions-log ordinal
 * `1-design`) — informational, never matched against.
 */

import yaml from "yaml";
import { z } from "zod";

import type { DecisionRow } from "./decisions-schema.js";

/** Canonical filename under `ACE/<opp>/inputs/`. Single source of truth. */
export const DECISION_OVERRIDES_FILENAME = "decision-overrides.yaml" as const;

/** Schema version this reader supports. ace-web writes v1. */
export const DECISION_OVERRIDES_SCHEMA_VERSION = 1 as const;

export type DecisionOverridesCode =
  | "MALFORMED_YAML"
  | "UNSUPPORTED_VERSION"
  | "MALFORMED_FILE";

/**
 * Loud, typed failure. A malformed overrides file means a reviewer's saved
 * intent would otherwise be silently dropped — per ACE's fail-loud
 * convention we halt the decisions write rather than ship a run that
 * ignores an expert's review.
 */
export class DecisionOverridesError extends Error {
  readonly code: DecisionOverridesCode;
  constructor(code: DecisionOverridesCode, message: string) {
    super(message);
    this.name = "DecisionOverridesError";
    this.code = code;
  }
}

/**
 * One override row. Only `id` + `override` are load-bearing;
 * everything else is provenance ace-web denormalizes so the file can
 * explain itself years later without resolving a run folder.
 */
export const DecisionOverrideRowSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    message:
      "id must be canonical kebab-case (matches the decisions-log row id it overrides)",
  }),
  override: z
    .string()
    .min(1)
    .describe(
      "The reviewer's chosen value. Applied verbatim as the decision row's `override`; " +
        "appended to the row's `options` if missing (strict-write invariant, ace#526).",
    ),
  override_reasoning: z.string().min(1).optional(),
  // Provenance snapshots from the source run — informational, never matched.
  phase: z.string().optional(),
  question: z.string().optional(),
  ai_default: z.string().optional(),
  decided_by: z.string().optional(),
  decided_at: z.string().optional(),
  source_run_id: z.string().optional(),
});

export type DecisionOverrideRow = z.infer<typeof DecisionOverrideRowSchema>;

export const DecisionOverridesFileSchema = z
  .object({
    schema_version: z.literal(DECISION_OVERRIDES_SCHEMA_VERSION),
    kind: z.literal("decision-overrides"),
    opp: z.string().min(1),
    updated_at: z.string().optional(),
    overrides: z.array(DecisionOverrideRowSchema),
  })
  .superRefine((file, ctx) => {
    const seen = new Set<string>();
    for (const [index, row] of file.overrides.entries()) {
      if (seen.has(row.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate override id: ${row.id} (ace-web merges by id, last write wins — duplicates mean the writer is broken)`,
          path: ["overrides", index, "id"],
        });
      }
      seen.add(row.id);
    }
  });

export type DecisionOverridesFile = z.infer<typeof DecisionOverridesFileSchema>;

/**
 * Parse `inputs/decision-overrides.yaml`. Throws DecisionOverridesError:
 * - MALFORMED_YAML: not parseable as YAML at all
 * - UNSUPPORTED_VERSION: schema_version this ACE build doesn't read
 *   (update the ACE plugin — ace-web shipped a newer writer)
 * - MALFORMED_FILE: YAML parses but violates the v1 schema
 */
export function parseDecisionOverridesYaml(input: string): DecisionOverridesFile {
  let raw: unknown;
  try {
    raw = yaml.parse(input);
  } catch (e) {
    throw new DecisionOverridesError(
      "MALFORMED_YAML",
      `decision-overrides.yaml is not valid YAML: ${(e as Error).message}`,
    );
  }
  const version = (raw as { schema_version?: unknown } | null)?.schema_version;
  if (version !== DECISION_OVERRIDES_SCHEMA_VERSION) {
    throw new DecisionOverridesError(
      "UNSUPPORTED_VERSION",
      `decision-overrides.yaml declares schema_version ${JSON.stringify(version)}; ` +
        `this ACE build reads schema_version ${DECISION_OVERRIDES_SCHEMA_VERSION} only. ` +
        `If ace-web shipped a newer writer, update the ACE plugin (/ace:update).`,
    );
  }
  const result = DecisionOverridesFileSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((it) => `${it.path.length > 0 ? it.path.join(".") : "<root>"}: ${it.message}`)
      .join("; ");
    throw new DecisionOverridesError(
      "MALFORMED_FILE",
      `decision-overrides.yaml does not match the v1 schema: ${issues}`,
    );
  }
  return result.data;
}

export interface ApplyOverridesResult {
  /** Transformed rows (same order as input; untouched rows pass through by reference). */
  rows: DecisionRow[];
  /** ids of rows an override actually bound to, in input-row order. */
  applied: string[];
}

/**
 * Bind saved overrides onto decision rows. Pure — input rows are not
 * mutated.
 *
 * For each row whose `id` matches an override:
 * - `override` + `status: overridden` + `override_reasoning` are set from
 *   the override row (the reviewer's word is the last word — it wins over
 *   whatever the emitting skill proposed).
 * - The override value is appended to `options` if missing, preserving the
 *   strict-write invariant `override ∈ options` (ace#526).
 * - A reaffirmed default (override == ai-default WITH reasoning) still
 *   applies: the value doesn't change but the reviewer's rationale carries.
 * - A no-op row (override == ai-default, no reasoning) is skipped — ace-web
 *   drops those on save (revert = absence), so one showing up means nothing
 *   to bind.
 *
 * Overrides whose `id` no input row carries are ignored (opp-level file,
 * cumulative across runs — unmatched ids are expected).
 */
export function applyDecisionOverrides(
  rows: DecisionRow[],
  overrides: DecisionOverrideRow[],
): ApplyOverridesResult {
  const byId = new Map<string, DecisionOverrideRow>();
  for (const o of overrides) byId.set(o.id, o);

  const applied: string[] = [];
  const out = rows.map((row) => {
    const o = byId.get(row.id);
    if (!o) return row;
    if (o.override === row["ai-default"] && o.override_reasoning === undefined) {
      return row;
    }
    applied.push(row.id);
    const next: DecisionRow = {
      ...row,
      options: row.options.includes(o.override)
        ? row.options
        : [...row.options, o.override],
      override: o.override,
      status: "overridden",
    };
    if (o.override_reasoning !== undefined) {
      next.override_reasoning = o.override_reasoning;
    }
    return next;
  });

  return { rows: out, applied };
}
