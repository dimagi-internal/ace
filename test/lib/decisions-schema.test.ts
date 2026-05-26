import { describe, expect, it } from "vitest";
import {
  DecisionRowSchema,
  DecisionRowStrictSchema,
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
      options: ["3–5", "10–15", "20+"],
      source: "idea.md §2; atomic-visit archetype norm",
      status: "ai-default",
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
      options: [],
      source: "x",
      status: "ai-default",
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
      options: [],
      source: "x",
      status: "ai-default",
    };
    expect(() => DecisionRowSchema.parse(row)).toThrow();
  });

  it("rejects an empty string in options", () => {
    const row = {
      id: "flw-count",
      phase: "1-design",
      skill: "idea-to-pdd",
      question: "Q?",
      "ai-default": "5–8",
      options: ["3–5", ""],
      source: "x",
      status: "ai-default",
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
      options: [],
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
      options: [],
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
      options: [],
      source: "x",
      status: "ai-default",
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
      options: [],
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
      options: [],
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
      options: [],
      source: "x",
      status: "ai-default",
    };
    expect(() => DecisionRowSchema.parse(row)).toThrow(/override/);
  });
});

describe("DecisionsLogSchema", () => {
  it("accepts a minimal valid log", () => {
    const log = {
      schema_version: 3,
      opportunity: "turmeric",
      run_id: "20260507-1733",
      generated_at: "2026-05-07T17:33:00Z",
      decisions: [],
    };
    expect(() => DecisionsLogSchema.parse(log)).not.toThrow();
  });

  it("rejects schema_version other than 3", () => {
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
      schema_version: 3,
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
          options: [],
          source: "x",
          status: "ai-default",
        },
        {
          id: "flw-count",  // duplicate
          phase: "1-design",
          skill: "idea-to-pdd",
          question: "Q?",
          "ai-default": "5–8",
          options: [],
          source: "x",
          status: "ai-default",
        },
      ],
    };
    expect(() => DecisionsLogSchema.parse(log)).toThrow(/duplicate/i);
  });
});

describe("parseDecisionsYaml", () => {
  it("parses a valid YAML string into a DecisionsLog", () => {
    const yaml = `
schema_version: 3
opportunity: turmeric
run_id: 20260507-1733
generated_at: "2026-05-07T17:33:00Z"
decisions:
  - id: flw-count
    phase: 1-design
    skill: idea-to-pdd
    question: How many FLWs?
    ai-default: "5–8"
    options: ["3–5", "10–15"]
    source: idea.md §2
    status: ai-default
`;
    const log = parseDecisionsYaml(yaml);
    expect(log.opportunity).toBe("turmeric");
    expect(log.decisions).toHaveLength(1);
    expect(log.decisions[0]!.id).toBe("flw-count");
    expect(log.decisions[0]!["ai-default"]).toBe("5–8");
  });

  it("parses an overridden row with override field", () => {
    const yaml = `
schema_version: 3
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
    options: ["5–8", "12"]
    source: idea.md §2
    status: overridden
`;
    const log = parseDecisionsYaml(yaml);
    expect(log.decisions[0]!.override).toBe("12");
    expect(log.decisions[0]!["ai-default"]).toBe("5–8");
  });

  it("parses reasoning and override_reasoning", () => {
    const yaml = `
schema_version: 3
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
    options: ["5–8", "12"]
    reasoning: Small pilot scope fits 5-8
    source: idea.md §2
    status: overridden
    override_reasoning: LLO has 12 trained agents already
`;
    const log = parseDecisionsYaml(yaml);
    expect(log.decisions[0]!.reasoning).toBe("Small pilot scope fits 5-8");
    expect(log.decisions[0]!.override_reasoning).toBe("LLO has 12 trained agents already");
  });

  it("throws a typed error on schema violation", () => {
    const yaml = `
schema_version: 3
opportunity: turmeric
run_id: 20260507-1733
generated_at: "2026-05-07T17:33:00Z"
decisions:
  - id: ""
    phase: 1-design
    skill: idea-to-pdd
    question: Q?
    ai-default: x
    options: []
    source: x
    status: ai-default
`;
    expect(() => parseDecisionsYaml(yaml)).toThrow(/decisions\.0\.id/);
  });

  it("rejects v1/v2 YAML without upgrade", () => {
    const yaml = `
schema_version: 2
opportunity: turmeric
run_id: 20260507-1733
generated_at: "2026-05-07T17:33:00Z"
decisions: []
`;
    expect(() => parseDecisionsYaml(yaml)).toThrow();
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
      options: ["3–5", "10–15"],
      source: "idea.md §2",
      status: "ai-default" as const,
    },
  ];

  it.each<[string, typeof oneDecision]>([
    ["one decision", oneDecision],
    ["empty array", []],
  ])("round-trips through parse with no data loss (%s)", (_label, decisions) => {
    const log = {
      schema_version: 3 as const,
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
      schema_version: 3 as const,
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
          options: ["5–8", "12"],
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
      schema_version: 3 as const,
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
          options: ["≥85%", "≥95%"],
          source: "stress-test verifiability dimension",
          status: "ai-default" as const,
        },
      ],
    };
    const yaml = serializeDecisionsLog(log);
    expect(yaml).toContain("≥90%");
    const parsed = parseDecisionsYaml(yaml);
    expect(parsed.decisions[0]!["ai-default"]).toBe("≥90%");
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
      options: [],
      source: "x",
      status: "ai-default" as const,
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
      options: ["5–8", "12"],
      source: "x",
      status: "overridden" as const,
    };
    expect(effectiveValue(row)).toBe("12");
  });
});

describe("DecisionRowStrictSchema (write-boundary invariants)", () => {
  it("accepts a row whose ai-default exactly matches one of the options", () => {
    const row = {
      id: "archetype-selection",
      phase: "1-design",
      skill: "idea-to-pdd",
      question: "Which delivery archetype best fits?",
      "ai-default": "atomic-visit",
      options: ["atomic-visit", "focus-group", "multi-stage"],
      source: "PDD § Intervention Design",
      status: "ai-default",
      reasoning: "Per-FLW per-POC visit, no group facilitation, no stage gates.",
    };
    expect(() => DecisionRowStrictSchema.parse(row)).not.toThrow();
  });

  it("rejects a row whose ai-default is a prose extension of an option label (budget-plausibility regression)", () => {
    const row = {
      id: "budget-plausibility",
      phase: "1-design",
      skill: "idea-to-pdd",
      question: "Is the budget plausible?",
      "ai-default": "USD 4,000 - USD 5,500 plausible at 240-product-capture floor",
      options: [
        "USD 4,000 - USD 5,500 (floor-anchored)",
        "USD 5,500 - USD 8,000 (stretch-anchored)",
        "USD 12,000+ (full-LLO-quoted)",
      ],
      source: "EOI cohort price band",
      status: "ai-default",
    };
    expect(() => DecisionRowStrictSchema.parse(row)).toThrow(
      /ai-default.*must be one of the strings in `options`/,
    );
  });

  it("rejects a row whose ai-default is a categorically different answer from options (named-downstream-consumer regression)", () => {
    const row = {
      id: "named-downstream-consumer",
      phase: "1-design",
      skill: "idea-to-pdd",
      question: "Is there a named downstream consumer?",
      "ai-default":
        "laboratory performance-testing arm of GiveWell malaria research portfolio",
      options: [
        "named lab + pre-committed action",
        "named portfolio consumer with implicit commitment",
        "no named consumer",
      ],
      source: "planning sheet",
      status: "ai-default",
    };
    expect(() => DecisionRowStrictSchema.parse(row)).toThrow(
      /ai-default.*must be one of the strings in `options`/,
    );
  });

  it("error message names the violating value and lists the options", () => {
    const row = {
      id: "x",
      phase: "1-design",
      skill: "s",
      question: "Q?",
      "ai-default": "wrong",
      options: ["a", "b", "c"],
      source: "src",
      status: "ai-default" as const,
    };
    const result = DecisionRowStrictSchema.safeParse(row);
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.issues[0].message;
      expect(msg).toContain('"wrong"');
      expect(msg).toContain('["a","b","c"]');
      expect(msg).toContain("reasoning");
    }
  });

  it("rejects an override that doesn't match one of the options", () => {
    const row = {
      id: "x",
      phase: "1-design",
      skill: "s",
      question: "Q?",
      "ai-default": "a",
      override: "z plus prose",
      options: ["a", "b", "c"],
      source: "src",
      status: "overridden",
    };
    expect(() => DecisionRowStrictSchema.parse(row)).toThrow(
      /override.*must be one of the strings in `options`/,
    );
  });

  it("accepts an override that exactly matches one of the options", () => {
    const row = {
      id: "x",
      phase: "1-design",
      skill: "s",
      question: "Q?",
      "ai-default": "a",
      override: "b",
      options: ["a", "b", "c"],
      source: "src",
      status: "overridden",
    };
    expect(() => DecisionRowStrictSchema.parse(row)).not.toThrow();
  });

  it("permissive DecisionRowSchema still accepts the legacy malformed shapes (read-path safety)", () => {
    // Legacy data from runs predating the strict invariant must continue to
    // parse — otherwise readers (decisions-render, decisions-sync, ace-web)
    // break when they encounter pre-fix decisions.yaml files.
    const legacyRow = {
      id: "budget-plausibility",
      phase: "1-design",
      skill: "idea-to-pdd",
      question: "Is the budget plausible?",
      "ai-default":
        "USD 4,000 - USD 5,500 plausible at 240-product-capture floor",
      options: [
        "USD 4,000 - USD 5,500 (floor-anchored)",
        "USD 5,500 - USD 8,000 (stretch-anchored)",
      ],
      source: "EOI cohort price band",
      status: "ai-default",
    };
    expect(() => DecisionRowSchema.parse(legacyRow)).not.toThrow();
  });
});
