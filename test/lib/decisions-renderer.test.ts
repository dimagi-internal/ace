import { describe, expect, it } from "vitest";
import type { DecisionsLog } from "../../lib/decisions-schema.js";
import { renderDecisionsLog } from "../../lib/decisions-renderer.js";

const MINIMAL_LOG: DecisionsLog = {
  schema_version: 2,
  opportunity: "turmeric",
  run_id: "20260507-1733",
  generated_at: "2026-05-07T17:33:00Z",
  decisions: [
    {
      id: "archetype-selection",
      phase: "1-design",
      skill: "idea-to-pdd",
      question: "Which delivery archetype best fits the intervention?",
      "ai-default": "atomic-visit",
      options_considered: ["atomic-visit", "focus-group", "multi-stage"],
      source: "idea.md §1",
      status: "ai-default",
      notes: "Single per-FLW visit producing one structured delivery.",
    },
  ],
};

describe("renderDecisionsLog", () => {
  it("includes an insertText request for the title", () => {
    const requests = renderDecisionsLog(MINIMAL_LOG);
    const titleInsert = requests.find(
      (r: any) =>
        "insertText" in r &&
        r.insertText?.text?.includes("Decisions Log — turmeric / run 20260507-1733"),
    );
    expect(titleInsert).toBeDefined();
  });

  it("includes a HEADING_1 paragraph style update covering the title", () => {
    const requests = renderDecisionsLog(MINIMAL_LOG);
    const h1 = requests.find(
      (r: any) =>
        "updateParagraphStyle" in r &&
        r.updateParagraphStyle?.paragraphStyle?.namedStyleType === "HEADING_1",
    );
    expect(h1).toBeDefined();
  });

  it("includes a HEADING_3 paragraph style update for each decision id", () => {
    const requests = renderDecisionsLog(MINIMAL_LOG);
    const h3 = requests.filter(
      (r: any) =>
        "updateParagraphStyle" in r &&
        r.updateParagraphStyle?.paragraphStyle?.namedStyleType === "HEADING_3",
    );
    expect(h3).toHaveLength(1);
  });

  it("creates a bullet list for the options_considered items", () => {
    const requests = renderDecisionsLog(MINIMAL_LOG);
    const bullets = requests.find((r: any) => "createParagraphBullets" in r);
    expect(bullets).toBeDefined();
  });

  it("emits an AI-default: line for every decision", () => {
    const requests = renderDecisionsLog(MINIMAL_LOG);
    const aiDefaultInsert = requests.find(
      (r: any) =>
        "insertText" in r &&
        r.insertText?.text?.includes("AI-default: atomic-visit"),
    );
    expect(aiDefaultInsert).toBeDefined();
  });

  it("emits NO Override: line when row.override is undefined", () => {
    const requests = renderDecisionsLog(MINIMAL_LOG);
    const override = requests.find(
      (r: any) =>
        "insertText" in r &&
        r.insertText?.text?.includes("Override:"),
    );
    expect(override).toBeUndefined();
  });

  it("emits both AI-default: AND Override: lines when row.override is set", () => {
    const overriddenLog: DecisionsLog = {
      ...MINIMAL_LOG,
      decisions: [
        {
          ...MINIMAL_LOG.decisions[0]!,
          id: "flw-count",
          "ai-default": "5-8",
          override: "12",
          status: "overridden",
        },
      ],
    };
    const requests = renderDecisionsLog(overriddenLog);
    const ai = requests.findIndex(
      (r: any) =>
        "insertText" in r && r.insertText?.text?.includes("AI-default: 5-8"),
    );
    const ov = requests.findIndex(
      (r: any) =>
        "insertText" in r && r.insertText?.text?.includes("Override: 12"),
    );
    expect(ai).toBeGreaterThanOrEqual(0);
    expect(ov).toBeGreaterThanOrEqual(0);
    // Override line is emitted after AI-default in document order.
    expect(ov).toBeGreaterThan(ai);
  });

  it.each([
    ["1 phase, 1 decision (MINIMAL_LOG)", () => MINIMAL_LOG, 1],
    ["2 phases, 3 decisions", () => ({
      ...MINIMAL_LOG,
      decisions: [
        { ...MINIMAL_LOG.decisions[0]!, id: "row-a", phase: "1-design" },
        { ...MINIMAL_LOG.decisions[0]!, id: "row-b", phase: "1-design" },
        { ...MINIMAL_LOG.decisions[0]!, id: "row-c", phase: "3-commcare" },
      ],
    } as DecisionsLog), 2],
  ] as const)("emits one HEADING_2 per distinct phase (%s)", (_label, build, expected) => {
    const requests = renderDecisionsLog(build());
    const h2 = requests.filter(
      (r: any) =>
        "updateParagraphStyle" in r &&
        r.updateParagraphStyle?.paragraphStyle?.namedStyleType === "HEADING_2",
    );
    expect(h2).toHaveLength(expected);
  });

  it("returns just the title block for an empty decisions array", () => {
    const empty: DecisionsLog = { ...MINIMAL_LOG, decisions: [] };
    const requests = renderDecisionsLog(empty);
    expect(requests.length).toBeGreaterThan(0);
    const h2 = requests.filter(
      (r: any) =>
        "updateParagraphStyle" in r &&
        r.updateParagraphStyle?.paragraphStyle?.namedStyleType === "HEADING_2",
    );
    expect(h2).toHaveLength(0);
    const h3 = requests.filter(
      (r: any) =>
        "updateParagraphStyle" in r &&
        r.updateParagraphStyle?.paragraphStyle?.namedStyleType === "HEADING_3",
    );
    expect(h3).toHaveLength(0);
  });
});
