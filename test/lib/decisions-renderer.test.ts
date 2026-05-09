import { describe, expect, it } from "vitest";
import type { DecisionsLog } from "../../lib/decisions-schema.js";
import { renderDecisionsLog } from "../../lib/decisions-renderer.js";

const MINIMAL_LOG: DecisionsLog = {
  schema_version: 1,
  opportunity: "turmeric",
  run_id: "20260507-1733",
  generated_at: "2026-05-07T17:33:00Z",
  decisions: [
    {
      id: "archetype-selection",
      phase: "1-design",
      skill: "idea-to-pdd",
      question: "Which delivery archetype best fits the intervention?",
      default: "atomic-visit",
      options_considered: ["atomic-visit", "focus-group", "multi-stage"],
      source: "idea.md §1",
      status: "applied",
      notes: "Single per-FLW visit producing one structured delivery.",
    },
  ],
};

describe("renderDecisionsLog", () => {
  // audit: expect(arr.length).toBeGreaterThan(0). The very next test ('includes an insertText request for the title') makes a stronger structural claim
  it.skip("returns a non-empty array of Docs API requests", () => {
    const requests = renderDecisionsLog(MINIMAL_LOG);
    expect(Array.isArray(requests)).toBe(true);
    expect(requests.length).toBeGreaterThan(0);
  });

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

  it("includes a HEADING_2 paragraph style update for each phase header", () => {
    const requests = renderDecisionsLog(MINIMAL_LOG);
    const h2 = requests.filter(
      (r: any) =>
        "updateParagraphStyle" in r &&
        r.updateParagraphStyle?.paragraphStyle?.namedStyleType === "HEADING_2",
    );
    expect(h2).toHaveLength(1);
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

  it("groups decisions by phase with a HEADING_2 per phase", () => {
    const multiPhaseLog: DecisionsLog = {
      ...MINIMAL_LOG,
      decisions: [
        { ...MINIMAL_LOG.decisions[0]!, id: "row-a", phase: "1-design" },
        { ...MINIMAL_LOG.decisions[0]!, id: "row-b", phase: "1-design" },
        { ...MINIMAL_LOG.decisions[0]!, id: "row-c", phase: "2-commcare" },
      ],
    };
    const requests = renderDecisionsLog(multiPhaseLog);
    const h2 = requests.filter(
      (r: any) =>
        "updateParagraphStyle" in r &&
        r.updateParagraphStyle?.paragraphStyle?.namedStyleType === "HEADING_2",
    );
    expect(h2).toHaveLength(2);
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

  it("emphasizes status: open rows distinctly from status: applied", () => {
    const openLog: DecisionsLog = {
      ...MINIMAL_LOG,
      decisions: [
        {
          ...MINIMAL_LOG.decisions[0]!,
          id: "named-downstream-consumer",
          status: "open",
          notes: "No consumer named.",
        },
      ],
    };
    const requests = renderDecisionsLog(openLog);
    const statusText = requests.find(
      (r: any) =>
        "insertText" in r &&
        (r.insertText?.text?.includes("Status: OPEN") ||
          r.insertText?.text?.includes("OPEN — load-bearing")),
    );
    expect(statusText).toBeDefined();
  });
});
