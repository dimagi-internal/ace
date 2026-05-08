import { describe, expect, it } from "vitest";
import { mergeDecisions } from "../../lib/decisions-sync.js";
import type { DecisionsLog } from "../../lib/decisions-schema.js";

const baseLog: DecisionsLog = {
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

describe("mergeDecisions", () => {
  it("preserves the YAML when parsed rows match it exactly", () => {
    const parsed = [
      { id: "archetype-selection", default: "atomic-visit", options_considered: ["atomic-visit", "focus-group", "multi-stage"] },
      { id: "flw-count", default: "5–8", options_considered: ["3–5", "5–8", "10–15"] },
    ];
    const { merged, report } = mergeDecisions(parsed, baseLog);
    expect(merged).toEqual(baseLog);
    expect(report.defaultsOverridden).toEqual([]);
    expect(report.optionsAdded).toEqual([]);
  });

  it("overrides default when human edits it; sets status=overridden", () => {
    const parsed = [
      { id: "flw-count", default: "12", options_considered: ["3–5", "5–8", "10–15"] },
    ];
    const { merged, report } = mergeDecisions(parsed, baseLog);
    const flw = merged.decisions.find((d) => d.id === "flw-count")!;
    expect(flw.default).toBe("12");
    expect(flw.status).toBe("overridden");
    expect(report.defaultsOverridden).toEqual([
      { id: "flw-count", from: "5–8", to: "12" },
    ]);
  });

  it("preserves the prior default in options_considered when overriding", () => {
    const parsed = [
      { id: "flw-count", default: "12", options_considered: ["3–5", "5–8", "10–15"] },
    ];
    const { merged } = mergeDecisions(parsed, baseLog);
    const flw = merged.decisions.find((d) => d.id === "flw-count")!;
    expect(flw.options_considered).toContain("5–8");
    expect(flw.options_considered).toContain("12");
  });

  it("does not duplicate the prior default if already in options_considered", () => {
    const parsed = [
      { id: "flw-count", default: "10–15", options_considered: ["3–5", "5–8", "10–15"] },
    ];
    const { merged } = mergeDecisions(parsed, baseLog);
    const flw = merged.decisions.find((d) => d.id === "flw-count")!;
    expect(flw.default).toBe("10–15");
    expect(flw.options_considered.filter((x) => x === "5–8")).toHaveLength(1);
    expect(flw.options_considered.filter((x) => x === "10–15")).toHaveLength(1);
  });

  it("appends new Considered bullets that aren't in YAML", () => {
    const parsed = [
      { id: "archetype-selection", default: "atomic-visit", options_considered: ["atomic-visit", "focus-group", "multi-stage", "novel-archetype"] },
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
      { id: "archetype-selection", default: "atomic-visit", options_considered: ["atomic-visit", "multi-stage"] },
    ];
    const { merged } = mergeDecisions(parsed, baseLog);
    const arch = merged.decisions.find((d) => d.id === "archetype-selection")!;
    expect(arch.options_considered).toContain("focus-group");
  });

  it("reports parsed rows not matched in YAML (warns; doesn't add)", () => {
    const parsed = [
      { id: "ghost-row", default: "abc", options_considered: ["abc"] },
    ];
    const { merged, report } = mergeDecisions(parsed, baseLog);
    expect(merged.decisions).toHaveLength(2);
    expect(report.parsedNotInYaml).toEqual(["ghost-row"]);
  });

  it("reports YAML rows not present in parsed (warns; preserves)", () => {
    const parsed = [
      { id: "archetype-selection", default: "atomic-visit", options_considered: ["atomic-visit"] },
    ];
    const { merged, report } = mergeDecisions(parsed, baseLog);
    expect(merged.decisions).toHaveLength(2);
    expect(report.yamlNotInParsed).toEqual(["flw-count"]);
  });

  it("ignores parsed rows with undefined default (no override applied)", () => {
    const parsed = [
      { id: "flw-count" },
    ];
    const { merged, report } = mergeDecisions(parsed, baseLog);
    const flw = merged.decisions.find((d) => d.id === "flw-count")!;
    expect(flw.default).toBe("5–8");
    expect(flw.status).toBe("applied");
    expect(report.defaultsOverridden).toEqual([]);
  });
});
