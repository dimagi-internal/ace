import { z } from "zod";
import yaml from "yaml";

import { checkVocabulary } from "./decision-vocabularies.js";
import { isInternalDecision, plainLanguageFindings } from "./decision-review.js";

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
 *
 * v6 (2026-10-03): the decisions log IS the review artifact — the per-run
 * build memo is retired (owner decision 2026-10-03: "get rid of the build memo
 * and improve decisions so it serves the same purpose"). Rows carry what the
 * memo used to: `review_ask` + `confirm_reason` (what a person with authority
 * should confirm before launch), `plain` (one line for a programme partner),
 * `check_at` + `correct_looks_like` (where to spot-check and what right looks
 * like), `audience` (`internal` for ACE's own test harness), and on rule rows
 * `scope` + `enforcement`. Field contract: `docs/decisions-contract.md` — ace-web
 * renders against it, so the field NAMES are fixed. All are optional on read;
 * `plain` is REQUIRED on new strict writes of partner-facing rows.
 *
 * The plain-language contract (every reviewer-visible row): `plain` present,
 * `plain_value` present whenever the AI default is itself jargon, and no
 * reviewer-visible field (`plain`, `plain_question`, `plain_value`,
 * `confirm_reason`, `check_at`, `correct_looks_like`) carrying a field id,
 * `=` expression, snake_case identifier, run id, platform record id, issue
 * number or "Phase N" — quoted or not. Per row at the write boundary below;
 * over the whole log by `auditDecisionsPlainLanguage` (lib/decisions-enrich.ts),
 * which gates the phase-end render and release readiness.
 *
 * v6 additions (2026-10-04, additive — the version number does not move, so
 * every v6 reader keeps parsing): the open-questions ledger is folded into the
 * decisions log (`docs/superpowers/specs/2026-10-04-open-questions-into-decisions-design.md`,
 * owner-approved 2026-10-04). An open question is a decision whose default
 * someone outside ACE should confirm, so the ask lives on the row:
 * `owner` (who must answer), `needed_by` (`award` | `go-live` | `closeout` |
 * `extension`), `answer_channel` (`review` | `solicitation:<question-id>` |
 * `call`); `status: deferred` + `revisit_when` for a question this pilot does
 * not need answered; and `review_ask: required-before`, which REQUIRES
 * `needed_by` and is the only ask that gates anything (release readiness, and
 * `solicitation-review` refuses to award while a `needed_by: award` one is
 * unanswered). `revisit_when` is held to the plain-language gate.
 */
export const DECISIONS_SCHEMA_VERSION = 6 as const;

/**
 * Schema versions a reader will accept. New writes seed `DECISIONS_SCHEMA_VERSION`;
 * reads degrade gracefully across the supported set so a log started under an
 * older writer keeps parsing after a version bump.
 */
export const SUPPORTED_SCHEMA_VERSIONS = [3, 4, 5, 6] as const;

/** The v6 review fields (docs/decisions-contract.md). */
export const REVIEW_FIELDS = [
  "review_ask",
  "confirm_reason",
  "plain",
  "check_at",
  "correct_looks_like",
  "audience",
  "scope",
  "enforcement",
  "also_raised_by",
  "plain_question",
  "plain_value",
  "owner",
  "needed_by",
  "answer_channel",
  "revisit_when",
] as const;

/** `review_ask` values. `required-before` is the only one that gates anything. */
export const REVIEW_ASKS = ["recommended-confirmation", "required-before"] as const;
export type ReviewAskKind = (typeof REVIEW_ASKS)[number];

/** `needed_by` — when an ask's answer is needed, as a lifecycle gate a reader understands. */
export const NEEDED_BY = ["award", "go-live", "closeout", "extension"] as const;
export type NeededBy = (typeof NEEDED_BY)[number];

/** `answer_channel`: `review` | `call` | `solicitation:<question-id>`. */
export const ANSWER_CHANNEL_RE = /^(review|call|solicitation:[A-Za-z0-9][A-Za-z0-9_.-]*)$/;

/** The solicitation question id an `answer_channel` names, or null. */
export function solicitationQuestionId(channel: string | undefined): string | null {
  const m = /^solicitation:(.+)$/.exec(channel ?? "");
  return m ? m[1] : null;
}

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
          "one. A row carrying this is HISTORY: consumers must resolve to the row that does not carry it. " +
          "Also stamped by ace-web's fork (ace#2582) on a row INHERITED from the source run for a phase " +
          "the fork re-runs: the row is moved to `<id>-<source-run-id>` and points at its own canonical " +
          "`<id>`, which the re-run producer then appends — so the target may be absent until that phase " +
          "re-runs. Absent-target is legal here; the row is history either way.",
      ),
    inherited_from_run: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Set by ace-web's fork, never by an emitting skill (ace#2582). The SOURCE run a forked run " +
          "inherited this row from, on a row the fork RETIRED because this run re-runs its phase. " +
          "Always paired with `superseded_by`: the row is kept for the audit trail, never live. " +
          "Declared here so it survives every re-serialization of the log by `decisions_append_rows`.",
      ),
    status: z
      .enum(["ai-default", "human-decided", "overridden", "deferred"])
      .describe(
        "WHO settled this row. Send `ai-default` on a new row (or `deferred`, below) — `human-decided` and `overridden` are " +
          "stamped by the write boundary from a saved reviewer record, and a caller-asserted " +
          "`human-decided` is REJECTED (ace#2307: a subagent cannot reach a human, so asserting one " +
          "ruled fabricates a binding ruling). " +
          "`ai-default`: ACE chose — its standing judgment, freely re-decidable by a later run. " +
          "`human-decided`: a named person ruled and `ai-default` holds THEIR answer; carries FORWARD " +
          "as binding into later runs. Stamped by `applyDecisionOverrides` when the row's " +
          "`feedback_ref` matches an ATTRIBUTED ruling in `inputs/decision-overrides.yaml`, which is " +
          "where a real human ruling belongs; never written by an emitting skill. " +
          "`overridden`: ACE proposed `ai-default` and a human replaced it via the override path, " +
          "which keeps both values. " +
          "`deferred`: a question this pilot does not need answered (a future phase, an expansion) — " +
          "`ai-default` holds the working assumption and `revisit_when` says when to raise it again. Rendered " +
          "collapsed, never as an ask; carries no `review_ask`. " +
          "Note this axis is about AUTHORSHIP only — it never gates or blocks a run. " +
          "Whether a value is ACE's to set at all is `value_set_by`, a separate question.",
      ),
    decided_by: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Email (or stable identifier) of the person whose ruling this row records. " +
          "REQUIRED when `status: human-decided` — but NOT a field a caller sets: the write boundary " +
          "copies it from the attributed ruling saved in `inputs/decision-overrides.yaml` (ace#2307). " +
          "Pair with `feedback_ref` when the ruling came from a logged review record so the feedback " +
          "ledger can join the two.",
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
    params: z
      .record(z.unknown())
      .optional()
      .describe(
        "Specifics an enum cannot hold, kept OUT of the compared value. `named: [FOCCAD]` for " +
          "candidate-llo-roster, `caveat: 'pending Nigerian data-protection confirmation'` for " +
          "wo-data-storage-region, `key_fields: [...]` for duplicate-detection-key. " +
          "Testing an enum-only design against 22 real runs is what surfaced this: wo-ethics-scope " +
          "had 17 phrasings of ONE answer, but two carried a real caveat an enum would have deleted, " +
          "and candidate-llo-roster's phrasings hid WHICH org was named. `ai-default` is the part " +
          "that gets compared, diffed and overridden; `params` is the part that would otherwise be " +
          "smuggled into it as prose.",
      ),
    // ── v6 review fields (docs/decisions-contract.md) ─────────────────────
    review_ask: z
      .enum(REVIEW_ASKS)
      .optional()
      .describe(
        "`recommended-confirmation`: the run is BUILT on this value, but someone with authority should " +
          "confirm it before launch — a placeholder for a [PROPOSED] design parameter, a value outside ACE's " +
          "authority, a machine translation awaiting native-speaker sign-off, an enforcement gap, or an open " +
          "design question. Never blocks a run. " +
          "`required-before`: the same, but the answer is needed before the lifecycle gate in `needed_by` — " +
          "REQUIRES `needed_by`. Still never blocks a phase; `validate-release-readiness` reports an unanswered " +
          "one as a blocker, and `solicitation-review` refuses `award_response` while a `needed_by: award` one is " +
          "unanswered. Use it only where no working default is safe to build on (an answer that changes who can " +
          "be awarded, or what the award commits to). Absent = no ask. Requires `confirm_reason`.",
      ),
    confirm_reason: z
      .string()
      .min(1)
      .optional()
      .describe(
        "One plain sentence saying why the value needs confirming (e.g. 'The design marks the rate as proposed; " +
          "the build uses 7,500 MWK as a placeholder.'). Required with `review_ask`; only valid with it.",
      ),
    plain: z
      .string()
      .min(1)
      .optional()
      .describe(
        "One line, in plain language, for a programme partner who has never seen ACE: what was chosen. " +
          "No field ids, snake_case identifiers, `=` expressions, run ids, platform record ids, issue numbers, " +
          "'Phase N', section-references or ACE jargon (PDD, CCZ, skill names) — quoting does not exempt them; a " +
          "quoted design rule keeps its own WORDS only. Required on new partner-facing rows.",
      ),
    check_at: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Where to spot-check it, as a path a reviewer can follow (e.g. 'Deliver app › Community Meeting Record › meeting photo').",
      ),
    correct_looks_like: z
      .string()
      .min(1)
      .optional()
      .describe(
        "The observation at `check_at` that means the choice was built right (e.g. 'The form cannot be saved without a photo').",
      ),
    audience: z
      .enum(["partner", "internal"])
      .optional()
      .describe(
        "`internal` for ACE's own test-harness and build-infrastructure rows (scenario counts, smoke recipes, " +
          "scroll methods) — kept in the log, hidden from partner views. Absent = `partner`. The write " +
          "boundary stamps `internal` on rows `isInternalDecision` recognises.",
      ),
    scope: z
      .enum(["record", "entity", "worker", "programme"])
      .optional()
      .describe(
        "Rule rows only: what one application of the rule limits — one submitted `record`, one tracked " +
          "`entity` (a community, household), one `worker`, or the `programme` as a whole (a review sample). " +
          "Paired with `enforcement`.",
      ),
    enforcement: z
      .enum(["enforced", "by-design", "gap"])
      .optional()
      .describe(
        "Rule rows only: `enforced` (a Connect rule, payment limit or app check holds it at its scope), " +
          "`by-design` (the design places it off the platform on purpose), `gap` (the design needs it and " +
          "nothing in the build holds it). A per-worker rule held only by an app check is a `gap`: app " +
          "checks are keyed on one case. Paired with `scope`.",
      ),
    plain_question: z
      .string()
      .min(1)
      .optional()
      .describe(
        "The question in words a programme partner would ask (e.g. 'What should a facilitator be paid per verified meeting?'). " +
          "Partner views show it instead of `question`, which is written for the build. Same plain-language rules as `plain`.",
      ),
    plain_value: z
      .string()
      .min(1)
      .optional()
      .describe(
        "The effective value formatted for a reader (e.g. '7,500 MWK' for an `ai-default` of '7500'). Partner views show it " +
          "instead of `ai-default`, which stays the exact option string the override UI keys on. Required (by the " +
          "plain-language gate, `auditDecisionsPlainLanguage`) whenever the AI default itself is jargon " +
          "(e.g. 'payable_slot in key plus Phase 4 rule'). Same plain-language rules as `plain`.",
      ),
    owner: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Who must answer this row's ask: `partner` | `implementing-org` | `dimagi`, or free text naming them " +
          "(e.g. 'Spark M&E'). Distinct from `value_set_by`, which is who sets the value. Set on a row that carries " +
          "`review_ask` or `status: deferred` when the sources do not settle who answers.",
      ),
    needed_by: z
      .enum(NEEDED_BY)
      .optional()
      .describe(
        "When the answer is needed, as a lifecycle gate a reader understands: `award` (before an implementing " +
          "organisation is awarded), `go-live`, `closeout`, `extension`. REQUIRED with `review_ask: required-before`; " +
          "optional (informational) with `recommended-confirmation`. Replaces the retired ledger's 'Before Phase N'.",
      ),
    answer_channel: z
      .string()
      .regex(ANSWER_CHANNEL_RE, {
        message: "answer_channel must be `review`, `call`, or `solicitation:<question-id>`",
      })
      .optional()
      .describe(
        "Where the answer arrives: `review` (the decisions review in ace-web, saved to " +
          "`inputs/decision-overrides.yaml`), `call` (a call with Dimagi), or `solicitation:<question-id>` (a " +
          "question in the published solicitation — the awarded response's answer closes the ask).",
      ),
    revisit_when: z
      .string()
      .min(1)
      .optional()
      .describe(
        "One plain sentence saying when a deferred question should be raised again (e.g. 'When the programme " +
          "expands to Rwanda.'). Only valid with `status: deferred`, and required on a new deferred row. Same " +
          "plain-language rules as `plain`.",
      ),
    also_raised_by: z
      .array(z.string().min(1))
      .optional()
      .describe(
        "Other skills that raised the SAME question with the same answer. Set by the enrichment pass when it " +
          "folds a cross-skill duplicate into this row (the duplicate is marked `superseded_by` this row).",
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
    if (row.review_ask !== undefined && row.confirm_reason === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "`review_ask` requires `confirm_reason` — one plain sentence saying why someone should confirm this value",
        path: ["confirm_reason"],
      });
    }
    if (row.review_ask === undefined && row.confirm_reason !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "`confirm_reason` is only valid with `review_ask`",
        path: ["confirm_reason"],
      });
    }
    if (row.review_ask === "required-before" && row.needed_by === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "`review_ask: required-before` requires `needed_by` (award | go-live | closeout | extension) — the gate the answer is needed before",
        path: ["needed_by"],
      });
    }
    if (row.revisit_when !== undefined && row.status !== "deferred") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "`revisit_when` is only valid on status=deferred",
        path: ["revisit_when"],
      });
    }
    if (row.status === "deferred") {
      if (row.review_ask !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "status=deferred must not carry `review_ask` — a deferred question is not needed for this pilot and renders collapsed, never as an ask",
          path: ["review_ask"],
        });
      }
      if (row.override !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "status=deferred must not have `override`",
          path: ["override"],
        });
      }
    }
    if ((row.scope === undefined) !== (row.enforcement === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "`scope` and `enforcement` describe a rule row together — set both or neither",
        path: [row.scope === undefined ? "scope" : "enforcement"],
      });
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
    // v5.2 (ace#2307): a CALLER may not assert `human-decided`. The write
    // boundary is the only thing that stamps it.
    //
    // `human-decided` is an attribution claim, and `lib/decisions-ingest.ts`
    // maps it straight to carry-authority `binding` — so a mislabelled row
    // does not merely misreport history, it exports a ruling into every later
    // run of the opp that only an explicit contradiction dislodges. The base
    // schema above already enforces that the claim is WELL-FORMED
    // (`decided_by` + `decided_at` present). Nothing could check that it was
    // TRUE, and on spark-facilitator/20260908-2215 a Phase 8 subagent read
    // agent-authored dispatch prose as a human's voice and stamped
    // `decided_by: <a real person>` for a decision that run's operator never
    // made — the run took zero human input end to end.
    //
    // Requiring `feedback_ref` alongside it would not close this: the same
    // generation that invented the attribution can invent the ref, and the
    // regex on that field only checks its SHAPE. And there is no
    // caller-identity check to fall back on — `AppendRowsArgs`
    // (mcp/decisions-server.ts) carries `{runFolderId, opportunity, run_id,
    // rows}` and nothing else, so the write path cannot tell an L0
    // orchestrator from a phase subagent, and a caller-asserted "I am L0"
    // flag would be fabricable by the identical mechanism.
    //
    // So the caller's assertion is made non-load-bearing instead. The two
    // real channels both survive, because both stamp the status AFTER this
    // parse or never pass through it at all:
    //   1. `applyDecisionOverrides` (lib/decision-overrides.ts) stamps
    //      `human-decided` when a row's `feedback_ref` matches an ATTRIBUTED
    //      ruling saved in `inputs/decision-overrides.yaml` — the attribution
    //      comes from the saved record, not from the emitting agent, and an
    //      unattributed match is refused rather than stamped anonymously.
    //   2. A ruling made live (an L0 orchestrator in `review` mode holding
    //      `AskUserQuestion`) is recorded in `inputs/decision-overrides.yaml`
    //      with `decided_by`/`decided_at`, where it binds automatically and
    //      is opp-level and cumulative — strictly better than a per-run row,
    //      and joinable by the feedback ledger. A ruling that exists only in
    //      an agent's transcript is not a record any consumer can see.
    // Reads keep the permissive `DecisionRowSchema`, so every existing log —
    // including the rows the boundary stamped — still parses. Calibrated
    // against every decisions.yaml in Drive (2026-09-08: 13 opps, 73 runs,
    // 2,943 rows) — `human-decided` appeared ZERO times outside the
    // fabricated row, so no legitimate case is being broken here.
    if (row.status === "human-decided") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "`status: human-decided` cannot be written by a caller — it is an attribution claim that " +
          "`lib/decisions-ingest.ts` carries forward as BINDING into every later run, so an agent " +
          "asserting it fabricates a ruling nobody made (dimagi-internal/ace#2307). Send this row as " +
          "`status: ai-default` with your own reasoning. To record a real human ruling, put it in the " +
          "opp's `inputs/decision-overrides.yaml` with `decided_by` + `decided_at` (ace-web's Phases " +
          "tab → Decisions panel writes that file); the write boundary then stamps `human-decided` " +
          "from that saved record and reports it in `rulingsApplied`.",
        path: ["status"],
      });
    }
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
    // v5.1: a catalogued decision must draw its options from the declared
    // vocabulary. An override binds by exact string match, and the option set
    // was being regenerated 9-11 times across 10-12 runs — so a saved
    // reviewer decision could not match even in principle.
    {
      const v = checkVocabulary(row);
      for (const issue of v.issues) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue, path: ["options"] });
      }
    }
    // v6: the decisions log is the review artifact (the build memo is retired).
    // A partner-facing row must say what it chose in words a programme
    // partner can read. ACE's own test-harness rows are exempt — they are
    // `audience: internal`, which the write boundary stamps from
    // `isInternalDecision` when the caller omits it.
    {
      const internal = row.audience === "internal" || (row.audience === undefined && isInternalDecision(row));
      if (!internal && row.plain === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "`plain` is required on every new partner-facing decision row (schema v6) — one line, in plain " +
            "language, saying what was chosen, for a reader who has never seen ACE. No field ids, section-refs or " +
            "ACE jargon. For a test-harness row send `audience: internal` instead. Contract: " +
            "docs/decisions-contract.md.",
          path: ["plain"],
        });
      }
      // Every field ace-web renders on a partner row is held to the same lint
      // (the whole-log gate is `auditDecisionsPlainLanguage` in
      // lib/decisions-enrich.ts; this is its per-row half at the write boundary).
      for (const field of ["plain", "confirm_reason", "plain_question", "plain_value", "check_at", "correct_looks_like", "revisit_when"] as const) {
        const text = row[field];
        if (text === undefined) continue;
        const findings = plainLanguageFindings(text);
        if (findings.length > 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              `\`${field}\` must read for a programme partner (docs/decisions-contract.md): ` +
              `${findings.join("; ")}. Quote a design rule in double quotes to keep its own words.`,
            path: [field],
          });
        }
      }
    }
    // v6 (2026-10-04): a deferred row says when to raise it again.
    if (row.status === "deferred" && row.revisit_when === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "a new `status: deferred` row requires `revisit_when` — one plain sentence saying when to raise the question again",
        path: ["revisit_when"],
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
          `(v3 legacy has no \`evidence_basis\`; v4 has no \`value_set_by\`; v5 has no review fields); ` +
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
  // version: '1.1' — same YAML-1.1-safe fix as lib/decisions-write.ts and
  // mcp/google-drive-server.ts (ace#2296, ace#2299). Confirmed the
  // `(value, replacer, options)` overload still applies `options` when
  // `replacer` is `null` (node_modules/yaml/dist/public-api.d.ts).
  return yaml.stringify(log, null, {
    lineWidth: 0,
    aliasDuplicateObjects: false,
    version: '1.1',
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
