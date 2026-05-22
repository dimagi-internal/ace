import { describe, expect, it } from "vitest";
import {
  DecisionRowSchema,
  DecisionsLogSchema,
  effectiveValue,
  parseDecisionsYaml,
  serializeDecisionsLog,
} from "../../lib/decisions-schema.js";

describe("DecisionRowSchema", () => {
  it("accepts a minimal valid row", () => {
    const row = {
      id: "flw-count",
      phase: "1-design",
      skill: "idea-to-pdd",
      question: "How many FLWs should the program target?",
      "ai-default": "5–8",
      options_considered: ["3–5", "10–15", "20+"],
      source: "idea.md §2; atomic-visit archetype norm",
      status: "applied",
    };
    expect(() => DecisionRowSchema.parse(row)).not.toThrow();
  });

  it.each([
    ["empty string", ""],
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
      "ai-default": "x",
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
      "ai-default": "x",
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
      "ai-default": "5–8",
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
      "ai-default": "x",
      options_considered: [],
      source: "x",
      status: "resolved",  // not in enum
    };
    expect(() => DecisionRowSchema.parse(row)).toThrow();
  });

  it("rejects `open` status (removed in v2)", () => {
    const row = {
      id: "flw-count",
      phase: "1-design",
      skill: "idea-to-pdd",
      question: "Q?",
      "ai-default": "x",
      options_considered: [],
      source: "x",
      status: "open",  // v1 enum value; no longer valid
    };
    expect(() => DecisionRowSchema.parse(row)).toThrow();
  });

  it("rejects a non-string ai-default", () => {
    const row = {
      id: "flw-count",
      phase: "1-design",
      skill: "idea-to-pdd",
      question: "Q?",
      "ai-default": 5,  // must be string
      options_considered: [],
      source: "x",
      status: "applied",
    };
    expect(() => DecisionRowSchema.parse(row)).toThrow();
  });

  it("rejects status=overridden without override field", () => {
    const row = {
      id: "x",
      phase: "1-design",
      skill: "idea-to-pdd",
      question: "Q?",
      "ai-default": "x",
      options_considered: [],
      source: "x",
      status: "overridden",
    };
    expect(() => DecisionRowSchema.parse(row)).toThrow(/override/);
  });

  it("accepts status=overridden with override field", () => {
    const row = {
      id: "x",
      phase: "1-design",
      skill: "idea-to-pdd",
      question: "Q?",
      "ai-default": "x",
      override: "y",
      options_considered: [],
      source: "x",
      status: "overridden",
    };
    expect(() => DecisionRowSchema.parse(row)).not.toThrow();
  });

  it("rejects status=applied with override field", () => {
    const row = {
      id: "x",
      phase: "1-design",
      skill: "idea-to-pdd",
      question: "Q?",
      "ai-default": "x",
      override: "y",
      options_considered: [],
      source: "x",
      status: "applied",
    };
    expect(() => DecisionRowSchema.parse(row)).toThrow(/override/);
  });
});

describe("DecisionsLogSchema", () => {
  it("accepts a minimal valid log", () => {
    const log = {
      schema_version: 2,
      opportunity: "turmeric",
      run_id: "20260507-1733",
      generated_at: "2026-05-07T17:33:00Z",
      decisions: [],
    };
    expect(() => DecisionsLogSchema.parse(log)).not.toThrow();
  });

  it("rejects schema_version other than 2", () => {
    const log = {
      schema_version: 1,
      opportunity: "turmeric",
      run_id: "20260507-1733",
      generated_at: "2026-05-07T17:33:00Z",
      decisions: [],
    };
    expect(() => DecisionsLogSchema.parse(log)).toThrow();
  });

  it("rejects duplicate decision IDs", () => {
    const log = {
      schema_version: 2,
      opportunity: "turmeric",
      run_id: "20260507-1733",
      generated_at: "2026-05-07T17:33:00Z",
      decisions: [
        {
          id: "flw-count",
          phase: "1-design",
          skill: "idea-to-pdd",
          question: "Q?",
          "ai-default": "5–8",
          options_considered: [],
          source: "x",
          status: "applied",
        },
        {
          id: "flw-count",  // duplicate
          phase: "1-design",
          skill: "idea-to-pdd",
          question: "Q?",
          "ai-default": "5–8",
          options_considered: [],
          source: "x",
          status: "applied",
        },
      ],
    };
    expect(() => DecisionsLogSchema.parse(log)).toThrow(/duplicate/i);
  });
});

describe("parseDecisionsYaml", () => {
  it("parses a valid YAML string into a DecisionsLog", () => {
    const yaml = `
schema_version: 2
opportunity: turmeric
run_id: 20260507-1733
generated_at: "2026-05-07T17:33:00Z"
decisions:
  - id: flw-count
    phase: 1-design
    skill: idea-to-pdd
    question: How many FLWs?
    ai-default: "5–8"
    options_considered: ["3–5", "10–15"]
    source: idea.md §2
    status: applied
`;
    const log = parseDecisionsYaml(yaml);
    expect(log.opportunity).toBe("turmeric");
    expect(log.decisions).toHaveLength(1);
    expect(log.decisions[0]!.id).toBe("flw-count");
    expect(log.decisions[0]!["ai-default"]).toBe("5–8");
  });

  it("parses an overridden row with override field", () => {
    const yaml = `
schema_version: 2
opportunity: turmeric
run_id: 20260507-1733
generated_at: "2026-05-07T17:33:00Z"
decisions:
  - id: flw-count
    phase: 1-design
    skill: idea-to-pdd
    question: How many FLWs?
    ai-default: "5–8"
    override: "12"
    options_considered: ["5–8", "12"]
    source: idea.md §2
    status: overridden
`;
    const log = parseDecisionsYaml(yaml);
    expect(log.decisions[0]!.override).toBe("12");
    expect(log.decisions[0]!["ai-default"]).toBe("5–8");
  });

  it("throws a typed error on schema violation", () => {
    const yaml = `
schema_version: 2
opportunity: turmeric
run_id: 20260507-1733
generated_at: "2026-05-07T17:33:00Z"
decisions:
  - id: ""  # empty id violates schema
    phase: 1-design
    skill: idea-to-pdd
    question: Q?
    ai-default: x
    options_considered: []
    source: x
    status: applied
`;
    expect(() => parseDecisionsYaml(yaml)).toThrow(/decisions\.0\.id/);
  });
});

describe("serializeDecisionsLog", () => {
  const oneDecision = [
    {
      id: "flw-count",
      phase: "1-design",
      skill: "idea-to-pdd",
      question: "How many FLWs?",
      "ai-default": "5–8",
      options_considered: ["3–5", "10–15"],
      source: "idea.md §2",
      status: "applied" as const,
    },
  ];

  it.each<[string, typeof oneDecision]>([
    ["one decision", oneDecision],
    ["empty array", []],
  ])("round-trips through parse with no data loss (%s)", (_label, decisions) => {
    const log = {
      schema_version: 2 as const,
      opportunity: "turmeric",
      run_id: "20260507-1733",
      generated_at: "2026-05-07T17:33:00Z",
      decisions,
    };
    const yaml = serializeDecisionsLog(log);
    const parsed = parseDecisionsYaml(yaml);
    expect(parsed).toEqual(log);
  });

  it("round-trips an overridden row preserving override + ai-default", () => {
    const log = {
      schema_version: 2 as const,
      opportunity: "turmeric",
      run_id: "20260507-1733",
      generated_at: "2026-05-07T17:33:00Z",
      decisions: [
        {
          id: "flw-count",
          phase: "1-design",
          skill: "idea-to-pdd",
          question: "How many FLWs?",
          "ai-default": "5–8",
          override: "12",
          options_considered: ["5–8", "12"],
          source: "idea.md §2",
          status: "overridden" as const,
        },
      ],
    };
    const yaml = serializeDecisionsLog(log);
    const parsed = parseDecisionsYaml(yaml);
    expect(parsed).toEqual(log);
    expect(parsed.decisions[0]!.override).toBe("12");
    expect(parsed.decisions[0]!["ai-default"]).toBe("5–8");
  });

  it("preserves non-ASCII characters (em dashes, en dashes)", () => {
    const log = {
      schema_version: 2 as const,
      opportunity: "turmeric",
      run_id: "20260507-1733",
      generated_at: "2026-05-07T17:33:00Z",
      decisions: [
        {
          id: "ai-photo-threshold",
          phase: "1-design",
          skill: "idea-to-pdd",
          question: "AI auto-accept confidence threshold?",
          "ai-default": "≥90%",
          options_considered: ["≥85%", "≥95%"],
          source: "stress-test verifiability dimension",
          status: "applied" as const,
        },
      ],
    };
    const yaml = serializeDecisionsLog(log);
    expect(yaml).toContain("≥90%");
    const parsed = parseDecisionsYaml(yaml);
    expect(parsed.decisions[0]!["ai-default"]).toBe("≥90%");
  });
});

describe("parseDecisionsYaml v1 → v2 upgrade", () => {
  it("upgrades a v1 applied row to v2 ai-default", () => {
    const yaml = `
schema_version: 1
opportunity: turmeric
run_id: 20260507-1733
generated_at: "2026-05-07T17:33:00Z"
decisions:
  - id: flw-count
    phase: 1-design
    skill: idea-to-pdd
    question: How many FLWs?
    default: "5–8"
    options_considered: ["3–5", "5–8"]
    source: idea.md
    status: applied
`;
    const log = parseDecisionsYaml(yaml);
    expect(log.schema_version).toBe(2);
    expect(log.decisions[0]!["ai-default"]).toBe("5–8");
    expect(log.decisions[0]!.status).toBe("applied");
    expect(log.decisions[0]!.override).toBeUndefined();
  });

  it("collapses v1 status=open to v2 status=applied", () => {
    const yaml = `
schema_version: 1
opportunity: turmeric
run_id: 20260507-1733
generated_at: "2026-05-07T17:33:00Z"
decisions:
  - id: foo
    phase: 1-design
    skill: idea-to-pdd
    question: Q?
    default: x
    options_considered: []
    source: idea.md
    status: open
`;
    const log = parseDecisionsYaml(yaml);
    expect(log.decisions[0]!.status).toBe("applied");
  });

  it("upgrades v1 overridden row by copying ai-default into override", () => {
    const yaml = `
schema_version: 1
opportunity: turmeric
run_id: 20260507-1733
generated_at: "2026-05-07T17:33:00Z"
decisions:
  - id: flw-count
    phase: 1-design
    skill: idea-to-pdd
    question: Q?
    default: "12"
    options_considered: ["5–8", "12"]
    source: idea.md
    status: overridden
`;
    const log = parseDecisionsYaml(yaml);
    expect(log.decisions[0]!["ai-default"]).toBe("12");
    expect(log.decisions[0]!.override).toBe("12");
    expect(log.decisions[0]!.status).toBe("overridden");
  });

  it("leaves v2 input unchanged (idempotent)", () => {
    const yaml = `
schema_version: 2
opportunity: turmeric
run_id: 20260507-1733
generated_at: "2026-05-07T17:33:00Z"
decisions:
  - id: foo
    phase: 1-design
    skill: idea-to-pdd
    question: Q?
    ai-default: x
    options_considered: []
    source: idea.md
    status: applied
`;
    const log = parseDecisionsYaml(yaml);
    expect(log.schema_version).toBe(2);
    expect(log.decisions[0]!["ai-default"]).toBe("x");
  });
});

describe("effectiveValue", () => {
  it("returns ai-default when no override", () => {
    const row = {
      id: "x",
      phase: "1-design",
      skill: "idea-to-pdd",
      question: "Q?",
      "ai-default": "5–8",
      options_considered: [],
      source: "x",
      status: "applied" as const,
    };
    expect(effectiveValue(row)).toBe("5–8");
  });

  it("returns override when present", () => {
    const row = {
      id: "x",
      phase: "1-design",
      skill: "idea-to-pdd",
      question: "Q?",
      "ai-default": "5–8",
      override: "12",
      options_considered: ["5–8", "12"],
      source: "x",
      status: "overridden" as const,
    };
    expect(effectiveValue(row)).toBe("12");
  });
});
