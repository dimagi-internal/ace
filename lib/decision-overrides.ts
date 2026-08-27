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
 * One superseded state of an override row. ace-web pushes the prior row
 * onto the winner's `history` (newest first) whenever a row is rewritten,
 * so last-write-wins loses nothing and any change is undoable from the UI.
 *
 * Loose on purpose: ace-web omits empty fields, and this reader must never
 * be the reason a reviewer's saved intent fails to load.
 */
export const DecisionOverrideHistorySchema = z.object({
  override: z.string().optional(),
  override_reasoning: z.string().optional(),
  decided_by: z.string().optional(),
  decided_by_name: z.string().optional(),
  decided_by_verified: z.boolean().optional(),
  decided_at: z.string().optional(),
  source_run_id: z.string().optional(),
});

export type DecisionOverrideHistoryEntry = z.infer<
  typeof DecisionOverrideHistorySchema
>;

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
  // --- Bind by the REVIEW ITEM, not just the row id (v5 decisions) --------
  // A reviewer rules on a QUESTION; the run mints an id for it. Those ids are
  // not stable: across 22 runs of two opps, one reviewer's 9 comments were
  // raised under 22 DIFFERENT ids — [g] alone appeared as
  // `consent-script-content`, `consent-script-contents` and
  // `consent-script-elements`, differing by a pluralization. Binding on `id`
  // alone therefore CANNOT carry a review ruling to the next run, which is
  // why `decision-overrides.yaml` had never bound a single reviewer decision.
  // `feedback_ref` is the stable key: it names the reviewer's own comment.
  feedback_ref: z
    .string()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*\/[a-z0-9]+(-[a-z0-9]+)*$/, {
      message: "feedback_ref must be `<record-slug>/<item-id>` (e.g. `20260727-sophie-feintuch/c`)",
    })
    .optional(),
  // Provenance snapshots from the source run — informational, never matched.
  phase: z.string().optional(),
  question: z.string().optional(),
  ai_default: z.string().optional(),
  decided_by: z.string().optional(),
  decided_at: z.string().optional(),
  source_run_id: z.string().optional(),
  // --- Identity + reversibility (ace-web PR #714, additive at v1) ---
  // ace-web now writes these on every row. They were previously STRIPPED
  // here (a non-strict zod object drops what it doesn't declare), which is
  // safe for BINDING — `applyDecisionOverrides` needs only `id` +
  // `override` — but makes the row unreadable as an ACT: who changed it,
  // and whether that identity was authenticated or typed into a public
  // page. `lib/feedback-ledger.ts` derives a reviewer's EDITS from these,
  // and its whole safety property is that a self-reported name can never
  // be mistaken for a verified one — so the flag has to survive the parse.
  decided_by_name: z.string().optional(),
  decided_by_verified: z.boolean().optional(),
  history: z.array(DecisionOverrideHistorySchema).optional(),
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
  /** ids of rows an override bound to BY ID — a value replacement. */
  applied: string[];
  /**
   * ids of rows bound BY `feedback_ref` — the same reviewer ruling reaching a
   * row the run minted under a different id. These are stamped
   * `status: human-decided` and keep the run's own phrasing of the value; see
   * `applyDecisionOverrides` for why the value is deliberately not replaced.
   */
  appliedByFeedbackRef: string[];
  /**
   * feedback_refs that matched a row but could not be stamped because the
   * override carries no `decided_by` / `decided_at`. `human-decided` is an
   * attribution claim — refusing to make it anonymously is the point.
   */
  skippedUnattributed: string[];
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
 * Overrides whose `id` no input row carries fall back to matching on
 * `feedback_ref` — see below. Ones that match neither are ignored (opp-level
 * file, cumulative across runs — unmatched entries are expected).
 *
 * ## Why there are two match keys
 *
 * `id` is the precise key and wins when it matches. But run-minted ids are
 * NOT stable: measured across 22 runs of spark-facilitator and
 * hh-poverty-targeting, one reviewer's 9 comments were raised under 22
 * different ids, three of them for a single comment. So id-only binding
 * silently drops a reviewer's ruling the moment the next run words the
 * question differently — which is exactly what happened: 31 rows carried a
 * `feedback_ref` and not one ever reached `decision-overrides.yaml`.
 *
 * ## Why a feedback_ref match does NOT replace the value
 *
 * An id match is row-to-row: same question, same option vocabulary, so the
 * saved value drops in cleanly. A feedback_ref match is question-to-question
 * across differently-worded rows — the saved string belongs to the OLD row's
 * vocabulary ("Adds data destination and no selection guarantee") and the new
 * row phrases the same answer its own way ("Six elements including data
 * destination..."). Forcing the old string in would assert a value the run
 * never reasoned about.
 *
 * So a feedback_ref match stamps `status: human-decided` with the reviewer's
 * attribution and carries their rationale, while leaving `ai-default` as the
 * run wrote it. That says the true thing — a named person settled this
 * question, here is what they said — without putting words in the run's
 * mouth. `human-decided` also forbids `override`, so the two paths stay
 * cleanly separable downstream.
 */
export function applyDecisionOverrides(
  rows: DecisionRow[],
  overrides: DecisionOverrideRow[],
): ApplyOverridesResult {
  const byId = new Map<string, DecisionOverrideRow>();
  const byFeedbackRef = new Map<string, DecisionOverrideRow>();
  for (const o of overrides) {
    byId.set(o.id, o);
    // Last writer wins per ref, matching the id map's semantics. The file is
    // cumulative, so a later review session supersedes an earlier one.
    if (o.feedback_ref !== undefined) byFeedbackRef.set(o.feedback_ref, o);
  }

  const applied: string[] = [];
  const appliedByFeedbackRef: string[] = [];
  const skippedUnattributed: string[] = [];

  const out = rows.map((row) => {
    // --- 1. Exact id match: the reviewer's value replaces the AI's. --------
    const o = byId.get(row.id);
    if (o) {
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
    }

    // --- 2. Same review item, different row id: carry the RULING, not the
    //        string. See the note above.
    if (row.feedback_ref === undefined) return row;
    const f = byFeedbackRef.get(row.feedback_ref);
    if (!f) return row;

    // `human-decided` is an attribution claim. v5's validator requires
    // decided_by + decided_at, and asserting a human ruled without being able
    // to say WHICH human is exactly the failure this whole field exists to
    // fix — so refuse rather than stamp it anonymously.
    if (f.decided_by === undefined || f.decided_at === undefined) {
      skippedUnattributed.push(row.feedback_ref);
      return row;
    }

    appliedByFeedbackRef.push(row.id);
    const next: DecisionRow = {
      ...row,
      status: "human-decided",
      decided_by: f.decided_by,
      decided_at: f.decided_at,
    };
    if (f.override_reasoning !== undefined) {
      next.override_reasoning = f.override_reasoning;
    }
    return next;
  });

  return { rows: out, applied, appliedByFeedbackRef, skippedUnattributed };
}
