import { describe, expect, it } from "vitest";

import {
  DECISION_VOCABULARIES,
  checkVocabulary,
} from "../../lib/decision-vocabularies.js";
import { DecisionRowStrictSchema } from "../../lib/decisions-schema.js";

const base = {
  phase: "1-design",
  skill: "idea-to-pdd",
  question: "q",
  source: "s",
  status: "ai-default" as const,
  evidence_basis: "stated" as const,
  value_set_by: "ace" as const,
};

describe("checkVocabulary", () => {
  it("leaves an uncatalogued id alone — the bar criterion must stay open", () => {
    expect(
      checkVocabulary({ id: "some-novel-question", options: ["a", "b"], "ai-default": "a" }).ok,
    ).toBe(true);
  });

  it("accepts a SUBSET — not every archetype applies to every opp", () => {
    expect(
      checkVocabulary({
        id: "archetype-selection",
        options: ["atomic-visit", "focus-group"],
        "ai-default": "atomic-visit",
      }).ok,
    ).toBe(true);
  });

  it("rejects an invented member, which is the churn it closes", () => {
    const r = checkVocabulary({
      id: "solicitation-deadline",
      options: ["14 days (default)", "21 days"],
      "ai-default": "14 days (default)",
    });
    expect(r.ok).toBe(false);
    expect(r.issues.join()).toMatch(/declared vocabulary/);
  });

  it("names the real consequence in the error", () => {
    const r = checkVocabulary({
      id: "wo-ethics-scope",
      options: ["Operational-only, personal data collected"],
      "ai-default": "Operational-only, personal data collected",
    });
    expect(r.issues.join()).toMatch(/saved reviewer override/);
  });
});

describe("strict write schema", () => {
  it("rejects a catalogued row whose options were re-invented", () => {
    expect(() =>
      DecisionRowStrictSchema.parse({
        ...base,
        id: "solicitation-type",
        options: ["EOI (default)", "RFP"],
        "ai-default": "EOI (default)",
      }),
    ).toThrow(/declared vocabulary/);
  });

  it("accepts the anchored form", () => {
    expect(() =>
      DecisionRowStrictSchema.parse({
        ...base,
        id: "solicitation-type",
        options: ["EOI", "RFP", "custom"],
        "ai-default": "EOI",
      }),
    ).not.toThrow();
  });

  it("carries the specifics an enum would destroy, in params", () => {
    const row = DecisionRowStrictSchema.parse({
      ...base,
      id: "candidate-llo-roster",
      options: ["public-only", "named-plus-public"],
      "ai-default": "named-plus-public",
      params: { named: ["FOCCAD"], caveat: "source-attested Malawi delivery partner" },
    });
    expect((row.params as Record<string, unknown>).named).toEqual(["FOCCAD"]);
    // The compared value stays clean.
    expect(row["ai-default"]).toBe("named-plus-public");
  });
});

describe("the vocabularies themselves", () => {
  it("every declared default is internally consistent", () => {
    for (const [id, v] of Object.entries(DECISION_VOCABULARIES)) {
      expect(v.options.length, `${id} needs >= 2 real alternatives`).toBeGreaterThan(1);
      expect(new Set(v.options).size, `${id} has duplicate options`).toBe(v.options.length);
      expect(v.note.length, `${id} must record WHY these values`).toBeGreaterThan(20);
    }
  });

  it("does NOT anchor the decisions that are genuinely unenumerable", () => {
    // These are `value_set_by: external` — a number, a band or a named entity
    // that a solicitation response or contract fixes. Forcing them into an
    // enum would misrepresent them.
    for (const id of [
      "flw-count",
      "payment-rate",
      "wo-total-not-to-exceed-usd",
      "wo-period-of-performance",
      "budget-plausibility",
      "named-downstream-consumer",
    ]) {
      expect(DECISION_VOCABULARIES[id], `${id} must stay unanchored`).toBeUndefined();
    }
  });
});
