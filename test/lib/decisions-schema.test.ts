import { describe, expect, it } from "vitest";
import { DecisionRowSchema, DecisionsLogSchema } from "../../lib/decisions-schema.js";

describe("DecisionRowSchema", () => {
  it("accepts a minimal valid row", () => {
    const row = {
      id: "flw-count",
      phase: "1-design",
      skill: "idea-to-pdd",
      question: "How many FLWs should the program target?",
      default: "5–8",
      options_considered: ["3–5", "10–15", "20+"],
      source: "idea.md §2; atomic-visit archetype norm",
      status: "applied",
    };
    expect(() => DecisionRowSchema.parse(row)).not.toThrow();
  });

  it("rejects an empty id", () => {
    const row = {
      id: "",
      phase: "1-design",
      skill: "idea-to-pdd",
      question: "Q?",
      default: "x",
      options_considered: [],
      source: "x",
      status: "applied",
    };
    expect(() => DecisionRowSchema.parse(row)).toThrow();
  });

  it.each([
    ["uppercase letters", "Foo-bar"],
    ["leading hyphen", "-baz"],
    ["trailing hyphen", "flw-count-"],
    ["double hyphen", "foo--bar"],
    ["underscore", "foo_bar"],
    ["space", "foo bar"],
  ])("rejects an id with %s (%s)", (_label, id) => {
    const row = {
      id,
      phase: "1-design",
      skill: "idea-to-pdd",
      question: "Q?",
      default: "x",
      options_considered: [],
      source: "x",
      status: "applied",
    };
    expect(() => DecisionRowSchema.parse(row)).toThrow();
  });

  it.each([
    ["zero phase number", "0-design"],
    ["missing phase number", "design"],
    ["uppercase name", "1-Design"],
    ["trailing hyphen", "1-design-"],
  ])("rejects a phase with %s (%s)", (_label, phase) => {
    const row = {
      id: "flw-count",
      phase,
      skill: "idea-to-pdd",
      question: "Q?",
      default: "x",
      options_considered: [],
      source: "x",
      status: "applied",
    };
    expect(() => DecisionRowSchema.parse(row)).toThrow();
  });

  it("rejects an empty string in options_considered", () => {
    const row = {
      id: "flw-count",
      phase: "1-design",
      skill: "idea-to-pdd",
      question: "Q?",
      default: "5–8",
      options_considered: ["3–5", ""],
      source: "x",
      status: "applied",
    };
    expect(() => DecisionRowSchema.parse(row)).toThrow();
  });

  it("rejects an invalid status enum value", () => {
    const row = {
      id: "flw-count",
      phase: "1-design",
      skill: "idea-to-pdd",
      question: "Q?",
      default: "x",
      options_considered: [],
      source: "x",
      status: "resolved",  // not in v1 enum
    };
    expect(() => DecisionRowSchema.parse(row)).toThrow();
  });

  it("rejects a non-string default", () => {
    const row = {
      id: "flw-count",
      phase: "1-design",
      skill: "idea-to-pdd",
      question: "Q?",
      default: 5,  // must be string
      options_considered: [],
      source: "x",
      status: "applied",
    };
    expect(() => DecisionRowSchema.parse(row)).toThrow();
  });

  it("accepts an optional notes field", () => {
    const row = {
      id: "flw-count",
      phase: "1-design",
      skill: "idea-to-pdd",
      question: "Q?",
      default: "x",
      options_considered: [],
      source: "x",
      status: "applied",
      notes: "Atomic-visit norm.",
    };
    expect(() => DecisionRowSchema.parse(row)).not.toThrow();
  });
});

describe("DecisionsLogSchema", () => {
  it("accepts a minimal valid log", () => {
    const log = {
      schema_version: 1,
      opportunity: "turmeric",
      run_id: "20260507-1733",
      generated_at: "2026-05-07T17:33:00Z",
      decisions: [],
    };
    expect(() => DecisionsLogSchema.parse(log)).not.toThrow();
  });

  it("rejects schema_version other than 1", () => {
    const log = {
      schema_version: 2,
      opportunity: "turmeric",
      run_id: "20260507-1733",
      generated_at: "2026-05-07T17:33:00Z",
      decisions: [],
    };
    expect(() => DecisionsLogSchema.parse(log)).toThrow();
  });

  it("rejects duplicate decision IDs", () => {
    const log = {
      schema_version: 1,
      opportunity: "turmeric",
      run_id: "20260507-1733",
      generated_at: "2026-05-07T17:33:00Z",
      decisions: [
        {
          id: "flw-count",
          phase: "1-design",
          skill: "idea-to-pdd",
          question: "Q?",
          default: "5–8",
          options_considered: [],
          source: "x",
          status: "applied",
        },
        {
          id: "flw-count",  // duplicate
          phase: "1-design",
          skill: "idea-to-pdd",
          question: "Q?",
          default: "5–8",
          options_considered: [],
          source: "x",
          status: "applied",
        },
      ],
    };
    expect(() => DecisionsLogSchema.parse(log)).toThrow(/duplicate/i);
  });
});
