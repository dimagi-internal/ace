import { describe, expect, it } from "vitest";
import { mergeDecisions } from "../../lib/decisions-sync.js";
import type { DecisionsLog } from "../../lib/decisions-schema.js";

const baseLog: DecisionsLog = {
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
      options_considered: ["3–5", "5–8", "10–15"],
      source: "idea.md §2",
      status: "ai-default",
    },
  ],
};

describe("mergeDecisions", () => {
  it("preserves the YAML when parsed rows match it exactly", () => {
    const parsed = [
      { id: "archetype-selection", value: "atomic-visit", options_considered: ["atomic-visit", "focus-group", "multi-stage"] },
      { id: "flw-count", value: "5–8", options_considered: ["3–5", "5–8", "10–15"] },
    ];
    const { merged, report } = mergeDecisions(parsed, baseLog);
    expect(merged).toEqual(baseLog);
    expect(report.defaultsOverridden).toEqual([]);
    expect(report.optionsAdded).toEqual([]);
  });

  it("populates override and flips status to overridden when human edits the value", () => {
    const parsed = [
      { id: "flw-count", value: "12", options_considered: ["3–5", "5–8", "10–15"] },
    ];
    const { merged, report } = mergeDecisions(parsed, baseLog);
    const flw = merged.decisions.find((d) => d.id === "flw-count")!;
    expect(flw["ai-default"]).toBe("5–8");
    expect(flw.override).toBe("12");
    expect(flw.status).toBe("overridden");
    expect(report.defaultsOverridden).toEqual([
      { id: "flw-count", from: "5–8", to: "12" },
    ]);
  });

  it("does NOT mutate ai-default on override", () => {
    const parsed = [
      { id: "flw-count", value: "12", options_considered: ["3–5", "5–8", "10–15"] },
    ];
    const { merged } = mergeDecisions(parsed, baseLog);
    const flw = merged.decisions.find((d) => d.id === "flw-count")!;
    expect(flw["ai-default"]).toBe("5–8");
  });

  it("clears override and reverts to applied when parsed matches ai-default", () => {
    const startLog: DecisionsLog = {
      ...baseLog,
      decisions: [
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
    const parsed = [
      { id: "flw-count", value: "5–8", options_considered: ["3–5", "5–8", "10–15", "12"] },
    ];
    const { merged, report } = mergeDecisions(parsed, startLog);
    const flw = merged.decisions.find((d) => d.id === "flw-count")!;
    expect(flw.status).toBe("ai-default");
    expect(flw.override).toBeUndefined();
    expect(report.defaultsOverridden).toEqual([
      { id: "flw-count", from: "12", to: "5–8" },
    ]);
  });

  it("appends new Considered bullets that aren't in YAML", () => {
    const parsed = [
      { id: "archetype-selection", value: "atomic-visit", options_considered: ["atomic-visit", "focus-group", "multi-stage", "novel-archetype"] },
    ];
    const { merged, report } = mergeDecisions(parsed, baseLog);
    const arch = merged.decisions.find((d) => d.id === "archetype-selection")!;
    expect(arch.options_considered).toContain("novel-archetype");
    expect(report.optionsAdded).toEqual([
      { id: "archetype-selection", option: "novel-archetype" },
    ]);
  });

  it("does NOT delete options that are missing from parsed", () => {
    const parsed = [
      { id: "archetype-selection", value: "atomic-visit", options_considered: ["atomic-visit", "multi-stage"] },
    ];
    const { merged } = mergeDecisions(parsed, baseLog);
    const arch = merged.decisions.find((d) => d.id === "archetype-selection")!;
    expect(arch.options_considered).toContain("focus-group");
  });

  it("reports parsed rows not matched in YAML (warns; doesn't add)", () => {
    const parsed = [
      { id: "ghost-row", value: "abc", options_considered: ["abc"] },
    ];
    const { merged, report } = mergeDecisions(parsed, baseLog);
    expect(merged.decisions).toHaveLength(2);
    expect(report.parsedNotInYaml).toEqual(["ghost-row"]);
  });

  it("reports YAML rows not present in parsed (warns; preserves)", () => {
    const parsed = [
      { id: "archetype-selection", value: "atomic-visit", options_considered: ["atomic-visit"] },
    ];
    const { merged, report } = mergeDecisions(parsed, baseLog);
    expect(merged.decisions).toHaveLength(2);
    expect(report.yamlNotInParsed).toEqual(["flw-count"]);
  });

  it("ignores parsed rows with undefined value (no override applied)", () => {
    const parsed = [
      { id: "flw-count" },
    ];
    const { merged, report } = mergeDecisions(parsed, baseLog);
    const flw = merged.decisions.find((d) => d.id === "flw-count")!;
    expect(flw["ai-default"]).toBe("5–8");
    expect(flw.status).toBe("ai-default");
    expect(flw.override).toBeUndefined();
    expect(report.defaultsOverridden).toEqual([]);
  });
});
