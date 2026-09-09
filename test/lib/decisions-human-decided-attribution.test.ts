/**
 * A caller cannot assert `status: human-decided`. dimagi-internal/ace#2307.
 *
 * ## The failure
 *
 * On `spark-facilitator/20260908-2215` a Phase 8 subagent (`llo-invite`) wrote
 * a `decisions.yaml` row stamped `status: human-decided`,
 * `decided_by: jjackson@dimagi.com`, `decided_at: 2026-09-08` — for a decision
 * no human made. The run was agent-dispatched and took zero human input end to
 * end. The row's own `source` cited "Operator instruction to the Phase 8
 * dispatch", which was authored by the ORCHESTRATING AGENT: the subagent read
 * agent prose as a human's voice and attributed it to a named individual.
 *
 * It was the only `human-decided` row in all 64 rows of that log.
 *
 * ## Why this had to become a rail rather than a rule in prose
 *
 * `lib/decisions-ingest.ts::authorityFor` maps the status straight to carry
 * authority `binding`, and run-init ingests "the accumulated `human-decided`
 * set" — so a mislabelled row does not merely misreport one run's history, it
 * exports a fabricated binding ruling into EVERY later run of the opp, which
 * only an explicit contradiction dislodges. Here it would have read "Jonathan
 * ruled: do not contact FOCCAD", which he never did.
 *
 * The v5 validator already required the claim to be WELL-FORMED (`decided_by`
 * + `decided_at`). Nothing checked that it was TRUE, and nothing could:
 *
 * - `AskUserQuestion` is withheld from every subagent (CLAUDE.md), so a phase
 *   subagent structurally cannot ORIGINATE a human ruling.
 * - Requiring `feedback_ref` alongside the attribution does not close it — the
 *   same generation that invents the attribution can invent the ref, one field
 *   over, since the regex on that field only checks its SHAPE. That case is
 *   asserted below.
 * - There is no caller identity to fall back on: `AppendRowsArgs` carries
 *   `{runFolderId, opportunity, run_id, rows}` and nothing else, so the write
 *   path cannot distinguish an L0 orchestrator from a subagent, and a
 *   caller-asserted "I am L0" flag would be fabricable by the same mechanism.
 *
 * So the caller's assertion is made non-load-bearing. The write boundary is
 * the sole stamper, from a record saved outside the agent's own prose.
 *
 * ## The corpus that chose this rule over "require `feedback_ref`"
 *
 * Surveyed 2026-09-08, every `decisions.yaml` in Drive (a complete
 * `corpora=allDrives` sweep, 73 files, all resolving to
 * `ACE/<opp>/runs/<run-id>/`): 13 opps, 73 runs, **2,943 rows**. Status
 * distribution `ai-default 2814 / applied 100 / overridden 18 / open 11` —
 * `human-decided` appears **zero** times. The row above was the only one that
 * has ever carried it.
 *
 * So there is no legitimate no-`feedback_ref` `human-decided` row for a strict
 * schema rule to have broken, and the hypothetical it was weighed against — an
 * L0 orchestrator in `review` mode stamping one after `AskUserQuestion` — has
 * never occurred. `feedback_ref` IS exercised: 47 rows, but all 47 in
 * `hh-poverty-targeting` Phase 1 `idea-to-pdd` against one 2026-07-27 reviewer
 * record, split `ai-default` 31 / `overridden` 16 and never `human-decided`.
 * Which is the point: that status arrives from the boundary's stamp, not from
 * an emitting skill.
 */
import { describe, expect, it } from "vitest";

import {
  DecisionRowSchema,
  DecisionRowStrictSchema,
  parseDecisionsYaml,
  serializeDecisionsLog,
  type DecisionRow,
} from "../../lib/decisions-schema.js";
import { composeAppendedLog, DecisionsWriteError } from "../../lib/decisions-write.js";

/**
 * The offending row, verbatim from
 * `spark-facilitator/20260908-2215/decisions.yaml` before it was repaired
 * (Drive `1JjzMiGsy_o5gFbE1LV8fq6iIjHO7uCtSTMYxjCB6Bc0`, rev 14). `reasoning`
 * and `source` are trimmed; every field the rules touch is as written.
 */
const FABRICATED_ROW = {
  id: "candidate-llo-invite",
  phase: "8-solicitation-management",
  skill: "llo-invite",
  question: "Is the PDD-named candidate LLO emailed the solicitation on this run?",
  "ai-default": "publish-only-no-invite",
  options: ["publish-only-no-invite", "invite-pdd-named-candidates"],
  reasoning:
    "Operator directed publish-only for this run and verified both opt-ins absent this session.",
  source: "Operator instruction to the Phase 8 dispatch, 2026-09-08; PDD s11 LLO Preference",
  status: "human-decided",
  decided_by: "jjackson@dimagi.com",
  decided_at: "2026-09-08",
  value_set_by: "ace",
  evidence_basis: "stated",
} as const;

describe("write boundary refuses a caller-asserted human ruling (ace#2307)", () => {
  it("REJECTS the exact subagent-written row that shipped", () => {
    const r = DecisionRowStrictSchema.safeParse(FABRICATED_ROW);
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues.some((i) => i.path.join(".") === "status")).toBe(true);
  });

  it("names the two real channels in the rejection, so the caller can route it", () => {
    const r = DecisionRowStrictSchema.safeParse(FABRICATED_ROW);
    expect(r.success).toBe(false);
    if (r.success) return;
    const msg = r.error.issues.map((i) => i.message).join(" ");
    // Send it as ai-default, or record the ruling where the boundary reads it.
    expect(msg).toMatch(/ai-default/);
    expect(msg).toMatch(/decision-overrides\.yaml/);
    expect(msg).toMatch(/decided_by/);
    // The consequence, not just the prohibition — this is what makes it worth
    // a rail rather than a lint.
    expect(msg).toMatch(/BINDING|binding/);
    expect(msg).toMatch(/ace#2307/);
  });

  it("REJECTS it even with a plausible feedback_ref — the ref is fabricable too", () => {
    // This is why the rule is not "human-decided requires feedback_ref". A
    // row that invents `decided_by` can invent `<record-slug>/<item-id>` in
    // the same breath, and the regex on the field only checks its SHAPE.
    const r = DecisionRowStrictSchema.safeParse({
      ...FABRICATED_ROW,
      feedback_ref: "20260908-operator-dispatch/a",
    });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues.some((i) => i.path.join(".") === "status")).toBe(true);
  });

  it("aborts the whole append batch — no partial write slips a fabricated ruling in", () => {
    const clean: unknown = {
      ...FABRICATED_ROW,
      id: "solicitation-deadline",
      status: "ai-default",
      decided_by: undefined,
      decided_at: undefined,
      "ai-default": "14-days",
      options: ["7-days", "14-days", "21-days", "30-days"],
    };
    let caught: unknown;
    try {
      composeAppendedLog({
        existingYamlText: null,
        opportunity: "spark-facilitator",
        run_id: "20260908-2215",
        rows: [clean, FABRICATED_ROW],
        now: () => "2026-09-08T22:15:00.000Z",
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DecisionsWriteError);
    expect((caught as DecisionsWriteError).code).toBe("INVALID_ROW");
    expect((caught as Error).message).toMatch(/rows\[1\]/);
  });
});

// ── NEGATIVE CONTROLS ────────────────────────────────────────────────────────
// A legitimate `human-decided` row must still work end to end. All three of
// these would have caught an over-broad fix that banned the status outright
// instead of banning the CALLER from asserting it.

describe("the legitimate human-decided path is untouched (ace#2307)", () => {
  const REVIEWED_ROW: unknown = {
    id: "consent-script-elements",
    phase: "1-design",
    skill: "idea-to-pdd",
    question: "What must the consent script state?",
    "ai-default": "Six elements including data destination",
    options: ["Six elements including data destination", "Purpose and voluntariness only"],
    source: "PDD §6",
    status: "ai-default",
    evidence_basis: "stated",
    value_set_by: "ace",
    feedback_ref: "20260727-sophie-feintuch/g",
  };

  const SAVED_RULING = {
    id: "consent-script-content", // the id the ORIGINAL run minted
    feedback_ref: "20260727-sophie-feintuch/g",
    override: "Adds data destination and no selection guarantee",
    override_reasoning: "Both additions were missing from the previous build.",
    decided_by: "sophie.feintuch@example.org",
    decided_at: "2026-07-27",
  };

  it("the boundary still STAMPS human-decided from an attributed saved ruling", () => {
    // The caller sends `ai-default`, as every emitting skill is told to. The
    // attribution comes from `inputs/decision-overrides.yaml`, not from the
    // agent — which is the whole distinction this fix rests on.
    const composed = composeAppendedLog({
      existingYamlText: null,
      opportunity: "spark-facilitator",
      run_id: "20260908-2215",
      rows: [REVIEWED_ROW],
      overrides: [SAVED_RULING],
      now: () => "2026-09-08T22:15:00.000Z",
    });
    expect(composed.rulingsApplied).toEqual(["consent-script-elements"]);

    const written = parseDecisionsYaml(composed.content);
    const row = written.decisions[0]!;
    expect(row.status).toBe("human-decided");
    expect(row.decided_by).toBe("sophie.feintuch@example.org");
    expect(row.decided_at).toBe("2026-07-27");
  });

  it("a log that ALREADY holds a human-decided row keeps accepting appends", () => {
    // Retro-rejecting the existing corpus would brick the decisions trail for
    // any opp a reviewer has ever ruled on — and this atom is the only
    // sanctioned writer, so the run would lose the trail silently (ace#1029).
    const seeded = composeAppendedLog({
      existingYamlText: null,
      opportunity: "spark-facilitator",
      run_id: "20260908-2215",
      rows: [REVIEWED_ROW],
      overrides: [SAVED_RULING],
      now: () => "2026-09-08T22:15:00.000Z",
    });
    const next = composeAppendedLog({
      existingYamlText: seeded.content,
      opportunity: "spark-facilitator",
      run_id: "20260908-2215",
      rows: [
        {
          ...(REVIEWED_ROW as Record<string, unknown>),
          id: "solicitation-deadline",
          question: "How long is the solicitation open?",
          "ai-default": "14-days",
          options: ["7-days", "14-days", "21-days", "30-days"],
          feedback_ref: undefined,
        },
      ],
      now: () => "2026-09-08T22:20:00.000Z",
    });
    expect(next.added).toBe(1);
    expect(next.total).toBe(2);
    const written = parseDecisionsYaml(next.content);
    expect(written.decisions.find((d) => d.id === "consent-script-elements")!.status).toBe(
      "human-decided",
    );
  });

  it("the READ path still parses a human-decided row (every existing log does)", () => {
    const row: DecisionRow = DecisionRowSchema.parse({
      ...(REVIEWED_ROW as Record<string, unknown>),
      status: "human-decided",
      decided_by: "sophie.feintuch@example.org",
      decided_at: "2026-07-27",
    });
    expect(row.status).toBe("human-decided");
    // ...and round-trips through the serializer, which validates on the way out.
    expect(() =>
      serializeDecisionsLog({
        schema_version: 5,
        opportunity: "spark-facilitator",
        run_id: "20260908-2215",
        generated_at: "2026-09-08T22:15:00.000Z",
        decisions: [row],
      }),
    ).not.toThrow();
  });
});
