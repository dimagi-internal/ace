import { describe, expect, it } from "vitest";
import { parseDocumentStructure } from "../../lib/decisions-parser.js";
import { renderDecisionsLog } from "../../lib/decisions-renderer.js";
import type { DecisionsLog } from "../../lib/decisions-schema.js";

function makeDoc(
  paragraphs: Array<{ text: string; style?: string; bullet?: boolean }>,
): Parameters<typeof parseDocumentStructure>[0] {
  return {
    body: {
      content: paragraphs.map((p) => ({
        paragraph: {
          elements: [{ textRun: { content: p.text + "\n" } }],
          paragraphStyle: { namedStyleType: p.style ?? "NORMAL_TEXT" },
          ...(p.bullet ? { bullet: { listId: "kix.list1" } } : {}),
        },
      })),
    },
  };
}

describe("parseDocumentStructure", () => {
  it("returns an empty array for an empty document body", () => {
    const doc = { body: { content: [] } };
    expect(parseDocumentStructure(doc)).toEqual([]);
  });

  it("extracts a single decision with default + considered options", () => {
    const doc = makeDoc([
      { text: "Decisions Log — turmeric", style: "HEADING_1" },
      { text: "Phase 1 — Design", style: "HEADING_2" },
      { text: "archetype-selection", style: "HEADING_3" },
      { text: "Which delivery archetype best fits?", style: "NORMAL_TEXT" },
      { text: "  Default: atomic-visit" },
      { text: "  Considered:" },
      { text: "atomic-visit", bullet: true },
      { text: "focus-group", bullet: true },
      { text: "multi-stage", bullet: true },
      { text: "  Source: idea.md §1" },
      { text: "  Status: applied" },
    ]);
    const rows = parseDocumentStructure(doc);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: "archetype-selection",
      default: "atomic-visit",
      options_considered: ["atomic-visit", "focus-group", "multi-stage"],
    });
  });

  it("extracts multiple decisions across multiple phases", () => {
    const doc = makeDoc([
      { text: "Phase 1 — Design", style: "HEADING_2" },
      { text: "row-a", style: "HEADING_3" },
      { text: "  Default: alpha" },
      { text: "row-b", style: "HEADING_3" },
      { text: "  Default: beta" },
      { text: "Phase 3 — CommCare", style: "HEADING_2" },
      { text: "row-c", style: "HEADING_3" },
      { text: "  Default: gamma" },
    ]);
    const rows = parseDocumentStructure(doc);
    expect(rows.map((r) => r.id)).toEqual(["row-a", "row-b", "row-c"]);
    expect(rows.map((r) => r.default)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("handles a row with no Default: line (undefined default)", () => {
    const doc = makeDoc([
      { text: "row-x", style: "HEADING_3" },
      { text: "Some question?", style: "NORMAL_TEXT" },
      { text: "  Source: idea.md" },
    ]);
    const rows = parseDocumentStructure(doc);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("row-x");
    expect(rows[0]!.default).toBeUndefined();
  });

  it("handles a row with Default but no Considered: section", () => {
    const doc = makeDoc([
      { text: "row-y", style: "HEADING_3" },
      { text: "  Default: solo-value" },
    ]);
    const rows = parseDocumentStructure(doc);
    expect(rows[0]!.default).toBe("solo-value");
    expect(rows[0]!.options_considered).toBeUndefined();
  });

  it("ignores trailing whitespace and the Default: indent", () => {
    const doc = makeDoc([
      { text: "row-z", style: "HEADING_3" },
      { text: "    Default:   spaced-value   " },
    ]);
    const rows = parseDocumentStructure(doc);
    expect(rows[0]!.default).toBe("spaced-value");
  });

  it("round-trips a DecisionsLog through render → parse without losing default/options", () => {
    const log: DecisionsLog = {
      schema_version: 1,
      opportunity: "turmeric",
      run_id: "20260507-1733",
      generated_at: "2026-05-07T17:33:00Z",
      decisions: [
        {
          id: "archetype-selection",
          phase: "1-design",
          skill: "idea-to-pdd",
          question: "Which delivery archetype?",
          default: "atomic-visit",
          options_considered: ["atomic-visit", "focus-group", "multi-stage"],
          source: "idea.md §1",
          status: "applied",
        },
        {
          id: "flw-count",
          phase: "1-design",
          skill: "idea-to-pdd",
          question: "How many FLWs?",
          default: "5–8",
          options_considered: ["3–5", "5–8", "10–15"],
          source: "idea.md §2",
          status: "applied",
        },
      ],
    };

    const requests = renderDecisionsLog(log);
    const doc = simulateDocument(requests);
    const parsed = parseDocumentStructure(doc);

    expect(parsed.map((r) => r.id)).toEqual(["archetype-selection", "flw-count"]);
    expect(parsed[0]!.default).toBe("atomic-visit");
    expect(parsed[0]!.options_considered).toEqual([
      "atomic-visit",
      "focus-group",
      "multi-stage",
    ]);
    expect(parsed[1]!.default).toBe("5–8");
    expect(parsed[1]!.options_considered).toEqual(["3–5", "5–8", "10–15"]);
  });
});

function simulateDocument(
  requests: any[],
): Parameters<typeof parseDocumentStructure>[0] {
  let text = "";
  for (const r of requests) {
    if ("insertText" in r) text += r.insertText.text;
  }
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();

  let cursor = 1;
  const linePositions: Array<{ start: number; end: number; text: string }> = [];
  for (const line of lines) {
    const start = cursor;
    const end = cursor + line.length;
    linePositions.push({ start, end, text: line });
    cursor = end + 1;
  }

  const paragraphStyles = new Map<number, string>();
  const bulletLines = new Set<number>();
  for (const r of requests) {
    if ("updateParagraphStyle" in r) {
      const { range, paragraphStyle } = r.updateParagraphStyle;
      const namedStyleType = paragraphStyle?.namedStyleType;
      if (!namedStyleType) continue;
      for (let i = 0; i < linePositions.length; i++) {
        const lp = linePositions[i]!;
        if (lp.start >= range.startIndex && lp.start < range.endIndex) {
          paragraphStyles.set(i, namedStyleType);
        }
      }
    } else if ("createParagraphBullets" in r) {
      const { range } = r.createParagraphBullets;
      for (let i = 0; i < linePositions.length; i++) {
        const lp = linePositions[i]!;
        if (lp.start >= range.startIndex && lp.start < range.endIndex) {
          bulletLines.add(i);
        }
      }
    }
  }

  return {
    body: {
      content: linePositions.map((lp, i) => ({
        paragraph: {
          elements: [{ textRun: { content: lp.text + "\n" } }],
          paragraphStyle: { namedStyleType: paragraphStyles.get(i) ?? "NORMAL_TEXT" },
          ...(bulletLines.has(i) ? { bullet: { listId: "kix.list1" } } : {}),
        },
      })),
    },
  };
}
