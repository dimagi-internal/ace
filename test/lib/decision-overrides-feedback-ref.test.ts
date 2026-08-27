/**
 * Binding a reviewer's ruling by `feedback_ref`.
 *
 * The measured failure this closes: across 22 runs of spark-facilitator and
 * hh-poverty-targeting, 31 decision rows carried a `feedback_ref` (a reviewer
 * demonstrably shaped them) and `decision-overrides.yaml` bound exactly none
 * of them — because run-minted ids are not stable. One reviewer's 9 comments
 * were raised under 22 different ids; comment [g] alone appeared as
 * `consent-script-content`, `consent-script-contents` and
 * `consent-script-elements`.
 */
import { describe, expect, it } from "vitest";

import { applyDecisionOverrides } from "../../lib/decision-overrides.js";
import type { DecisionRow } from "../../lib/decisions-schema.js";

function row(over: Partial<DecisionRow> = {}): DecisionRow {
  return {
    id: "consent-script-elements",
    phase: "1-design",
    skill: "idea-to-pdd",
    question: "What must the consent script state?",
    "ai-default": "Six elements including data destination and no guarantee of selection",
    options: [
      "Six elements including data destination and no guarantee of selection",
      "Purpose and voluntariness only",
    ],
    source: "PDD §6",
    status: "ai-default",
    evidence_basis: "stated",
    value_set_by: "ace",
    ...over,
  } as DecisionRow;
}

const RULING = {
  id: "consent-script-content", // the id the ORIGINAL run minted
  feedback_ref: "20260727-sophie-feintuch/g",
  override: "Adds data destination and no selection guarantee",
  override_reasoning: "Both additions were missing from the previous build.",
  decided_by: "sophie.feintuch@example.org",
  decided_at: "2026-07-27",
};

describe("applyDecisionOverrides — feedback_ref binding", () => {
  it("binds a ruling to a row the run minted under a DIFFERENT id", () => {
    const r = applyDecisionOverrides(
      [row({ feedback_ref: "20260727-sophie-feintuch/g" })],
      [RULING],
    );
    expect(r.appliedByFeedbackRef).toEqual(["consent-script-elements"]);
    expect(r.applied).toEqual([]);
    expect(r.rows[0].status).toBe("human-decided");
    expect(r.rows[0].decided_by).toBe("sophie.feintuch@example.org");
    expect(r.rows[0].decided_at).toBe("2026-07-27");
  });

  it("keeps the run's own phrasing — it does NOT paste the old row's string in", () => {
    const r = applyDecisionOverrides(
      [row({ feedback_ref: "20260727-sophie-feintuch/g" })],
      [RULING],
    );
    expect(r.rows[0]["ai-default"]).toBe(
      "Six elements including data destination and no guarantee of selection",
    );
    // human-decided forbids `override`; the two paths stay separable.
    expect(r.rows[0].override).toBeUndefined();
    expect(r.rows[0].options).toHaveLength(2);
  });

  it("carries the reviewer's rationale across", () => {
    const r = applyDecisionOverrides(
      [row({ feedback_ref: "20260727-sophie-feintuch/g" })],
      [RULING],
    );
    expect(r.rows[0].override_reasoning).toBe(
      "Both additions were missing from the previous build.",
    );
  });

  it("an exact id match still wins and still replaces the value", () => {
    const r = applyDecisionOverrides(
      [row({ id: "consent-script-content", feedback_ref: "20260727-sophie-feintuch/g" })],
      [RULING],
    );
    expect(r.applied).toEqual(["consent-script-content"]);
    expect(r.appliedByFeedbackRef).toEqual([]);
    expect(r.rows[0].status).toBe("overridden");
    expect(r.rows[0].override).toBe("Adds data destination and no selection guarantee");
  });

  it("binds the SAME ruling to every row the run split it across", () => {
    // Comment [a] was raised as five different ids in one opp.
    const rows = [
      row({ id: "required-fields-policy", feedback_ref: "20260727-sophie-feintuch/a" }),
      row({ id: "required-field-scope", feedback_ref: "20260727-sophie-feintuch/a" }),
      row({ id: "roster-minimum-members", feedback_ref: "20260727-sophie-feintuch/a" }),
    ];
    const r = applyDecisionOverrides(rows, [
      { ...RULING, id: "required-vs-optional-fields", feedback_ref: "20260727-sophie-feintuch/a" },
    ]);
    expect(r.appliedByFeedbackRef).toHaveLength(3);
    expect(r.rows.every((x) => x.status === "human-decided")).toBe(true);
  });

  it("REFUSES to stamp human-decided without attribution", () => {
    const { decided_by: _b, decided_at: _a, ...anon } = RULING;
    const r = applyDecisionOverrides(
      [row({ feedback_ref: "20260727-sophie-feintuch/g" })],
      [anon],
    );
    expect(r.appliedByFeedbackRef).toEqual([]);
    expect(r.skippedUnattributed).toEqual(["20260727-sophie-feintuch/g"]);
    expect(r.rows[0].status).toBe("ai-default");
  });

  it("ignores a ruling whose feedback_ref no row carries", () => {
    const r = applyDecisionOverrides(
      [row({ feedback_ref: "20260727-sophie-feintuch/zzz" })],
      [RULING],
    );
    expect(r.appliedByFeedbackRef).toEqual([]);
    expect(r.rows[0].status).toBe("ai-default");
  });

  it("leaves rows carrying no feedback_ref alone", () => {
    const r = applyDecisionOverrides([row()], [RULING]);
    expect(r.appliedByFeedbackRef).toEqual([]);
    expect(r.rows[0]).toBe(r.rows[0]);
    expect(r.rows[0].status).toBe("ai-default");
  });

  it("a later review session supersedes an earlier one on the same ref", () => {
    const later = {
      ...RULING,
      id: "consent-script-v2",
      override_reasoning: "Superseded 2026-08-19.",
      decided_at: "2026-08-19",
    };
    const r = applyDecisionOverrides(
      [row({ feedback_ref: "20260727-sophie-feintuch/g" })],
      [RULING, later],
    );
    expect(r.rows[0].decided_at).toBe("2026-08-19");
    expect(r.rows[0].override_reasoning).toBe("Superseded 2026-08-19.");
  });
});
