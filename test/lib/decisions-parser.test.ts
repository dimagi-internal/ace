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

  it("extracts a single decision with AI-default + considered options", () => {
    const doc = makeDoc([
      { text: "Decisions Log — turmeric", style: "HEADING_1" },
      { text: "Phase 1 — Design", style: "HEADING_2" },
      { text: "archetype-selection", style: "HEADING_3" },
      { text: "Which delivery archetype best fits?", style: "NORMAL_TEXT" },
      { text: "  AI-default: atomic-visit" },
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
      value: "atomic-visit",
      options_considered: ["atomic-visit", "focus-group", "multi-stage"],
    });
  });

  it("treats Override as winning over AI-default when both present", () => {
    const doc = makeDoc([
      { text: "row-overridden", style: "HEADING_3" },
      { text: "  AI-default: 5–8" },
      { text: "  Override: 12" },
      { text: "  Status: overridden" },
    ]);
    const rows = parseDocumentStructure(doc);
    expect(rows[0]!.value).toBe("12");
  });

  it("uses AI-default when only AI-default is present (no Override)", () => {
    const doc = makeDoc([
      { text: "row-applied", style: "HEADING_3" },
      { text: "  AI-default: 5–8" },
      { text: "  Status: applied" },
    ]);
    const rows = parseDocumentStructure(doc);
    expect(rows[0]!.value).toBe("5–8");
  });

  it("extracts multiple decisions across multiple phases", () => {
    const doc = makeDoc([
      { text: "Phase 1 — Design", style: "HEADING_2" },
      { text: "row-a", style: "HEADING_3" },
      { text: "  AI-default: alpha" },
      { text: "row-b", style: "HEADING_3" },
      { text: "  AI-default: beta" },
      { text: "Phase 3 — CommCare", style: "HEADING_2" },
      { text: "row-c", style: "HEADING_3" },
      { text: "  AI-default: gamma" },
    ]);
    const rows = parseDocumentStructure(doc);
    expect(rows.map((r) => r.id)).toEqual(["row-a", "row-b", "row-c"]);
    expect(rows.map((r) => r.value)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("handles a row with no AI-default: line (undefined value)", () => {
    const doc = makeDoc([
      { text: "row-x", style: "HEADING_3" },
      { text: "Some question?", style: "NORMAL_TEXT" },
      { text: "  Source: idea.md" },
    ]);
    const rows = parseDocumentStructure(doc);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("row-x");
    expect(rows[0]!.value).toBeUndefined();
  });

  it("handles a row with AI-default but no Considered: section", () => {
    const doc = makeDoc([
      { text: "row-y", style: "HEADING_3" },
      { text: "  AI-default: solo-value" },
    ]);
    const rows = parseDocumentStructure(doc);
    expect(rows[0]!.value).toBe("solo-value");
    expect(rows[0]!.options_considered).toBeUndefined();
  });

  it("ignores trailing whitespace and the AI-default: indent", () => {
    const doc = makeDoc([
      { text: "row-z", style: "HEADING_3" },
      { text: "    AI-default:   spaced-value   " },
    ]);
    const rows = parseDocumentStructure(doc);
    expect(rows[0]!.value).toBe("spaced-value");
  });

  it("round-trips a DecisionsLog through render → parse without losing value/options", () => {
    const log: DecisionsLog = {
      schema_version: 2,
      opportunity: "turmeric",
      run_id: "20260507-1733",
      generated_at: "2026-05-07T17:33:00Z",
      decisions: [
        {
          id: "archetype-selection",
          phase: "1-design",
          skill: "idea-to-pdd",
          question: "Which delivery archetype?",
          "ai-default": "atomic-visit",
          options_considered: ["atomic-visit", "focus-group", "multi-stage"],
          source: "idea.md §1",
          status: "ai-default",
        },
        {
          id: "flw-count",
          phase: "1-design",
          skill: "idea-to-pdd",
          question: "How many FLWs?",
          "ai-default": "5–8",
          override: "12",
          options_considered: ["3–5", "5–8", "10–15", "12"],
          source: "idea.md §2",
          status: "overridden",
        },
      ],
    };

    const requests = renderDecisionsLog(log);
    const doc = simulateDocument(requests);
    const parsed = parseDocumentStructure(doc);

    expect(parsed.map((r) => r.id)).toEqual(["archetype-selection", "flw-count"]);
    expect(parsed[0]!.value).toBe("atomic-visit");
    expect(parsed[0]!.options_considered).toEqual([
      "atomic-visit",
      "focus-group",
      "multi-stage",
    ]);
    expect(parsed[1]!.value).toBe("12");
    expect(parsed[1]!.options_considered).toEqual(["3–5", "5–8", "10–15", "12"]);
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
