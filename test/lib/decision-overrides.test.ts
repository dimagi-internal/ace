import { describe, expect, it } from "vitest";

import {
  DECISION_OVERRIDES_FILENAME,
  DecisionOverridesError,
  applyDecisionOverrides,
  parseDecisionOverridesYaml,
} from "../../lib/decision-overrides.js";
import type { DecisionRow } from "../../lib/decisions-schema.js";

const VALID_FILE = `
schema_version: 1
kind: decision-overrides
opp: hh-poverty-targeting
updated_at: 2026-07-24T15:02:11Z
overrides:
  - id: archetype-selection
    phase: idea-to-design
    question: Which delivery archetype best fits the intervention?
    ai_default: atomic-visit
    override: focus-group
    override_reasoning: >-
      Village-level enrollment means one facilitator meets 8-12 households
      together; atomic-visit would triple the FLW day count.
    decided_by: expert@partner.org
    decided_at: 2026-07-24T14:58:02Z
    source_run_id: 20260722-1341
`;

function makeRow(overrides: Partial<DecisionRow> = {}): DecisionRow {
  return {
    id: "archetype-selection",
    phase: "1-design",
    skill: "idea-to-pdd",
    question: "Which delivery archetype best fits the intervention?",
    "ai-default": "atomic-visit",
    options: ["atomic-visit", "focus-group", "multi-stage"],
    source: "idea.md §1",
    status: "ai-default",
    evidence_basis: "stated",
    ...overrides,
  } as DecisionRow;
}

describe("DECISION_OVERRIDES_FILENAME", () => {
  it("matches the canonical ace-web filename", () => {
    expect(DECISION_OVERRIDES_FILENAME).toBe("decision-overrides.yaml");
  });
});

describe("parseDecisionOverridesYaml", () => {
  it("parses a valid schema_version 1 file", () => {
    const parsed = parseDecisionOverridesYaml(VALID_FILE);
    expect(parsed.schema_version).toBe(1);
    expect(parsed.kind).toBe("decision-overrides");
    expect(parsed.opp).toBe("hh-poverty-targeting");
    expect(parsed.overrides).toHaveLength(1);
    expect(parsed.overrides[0]).toMatchObject({
      id: "archetype-selection",
      override: "focus-group",
      decided_by: "expert@partner.org",
      source_run_id: "20260722-1341",
    });
  });

  it("tolerates provenance `phase` values that are not ordinal-format", () => {
    // ace-web writes the phase agent name (e.g. `idea-to-design`), not the
    // decisions-log ordinal format (`1-design`). Row identity is `id` alone.
    const parsed = parseDecisionOverridesYaml(VALID_FILE);
    expect(parsed.overrides[0].phase).toBe("idea-to-design");
  });

  it("rejects an unsupported schema_version with an actionable message", () => {
    const input = VALID_FILE.replace("schema_version: 1", "schema_version: 2");
    expect(() => parseDecisionOverridesYaml(input)).toThrowError(
      DecisionOverridesError,
    );
    try {
      parseDecisionOverridesYaml(input);
    } catch (e) {
      expect((e as DecisionOverridesError).code).toBe("UNSUPPORTED_VERSION");
      expect((e as Error).message).toContain("schema_version 2");
    }
  });

  it("rejects unparseable YAML with MALFORMED_YAML", () => {
    try {
      parseDecisionOverridesYaml("overrides: [unclosed");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as DecisionOverridesError).code).toBe("MALFORMED_YAML");
    }
  });

  it("rejects a row missing `override` with MALFORMED_FILE", () => {
    const input = `
schema_version: 1
kind: decision-overrides
opp: hh-poverty-targeting
overrides:
  - id: archetype-selection
`;
    try {
      parseDecisionOverridesYaml(input);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as DecisionOverridesError).code).toBe("MALFORMED_FILE");
    }
  });

  it("rejects duplicate override ids", () => {
    const input = `
schema_version: 1
kind: decision-overrides
opp: hh-poverty-targeting
overrides:
  - id: archetype-selection
    override: focus-group
  - id: archetype-selection
    override: multi-stage
`;
    try {
      parseDecisionOverridesYaml(input);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as DecisionOverridesError).code).toBe("MALFORMED_FILE");
      expect((e as Error).message).toContain("archetype-selection");
    }
  });
});

describe("applyDecisionOverrides", () => {
  it("applies a matching override: status, override value, reasoning", () => {
    const { rows, applied } = applyDecisionOverrides(
      [makeRow()],
      parseDecisionOverridesYaml(VALID_FILE).overrides,
    );
    expect(applied).toEqual(["archetype-selection"]);
    expect(rows[0]).toMatchObject({
      status: "overridden",
      override: "focus-group",
    });
    expect(rows[0].override_reasoning).toContain("Village-level enrollment");
    // ai-default preserved as the AI's original proposal.
    expect(rows[0]["ai-default"]).toBe("atomic-visit");
  });

  it("appends the override value to options when missing (strict-write invariant, ace#526)", () => {
    const row = makeRow({ options: ["atomic-visit", "multi-stage"] });
    const { rows } = applyDecisionOverrides(
      [row],
      [{ id: "archetype-selection", override: "focus-group" }],
    );
    expect(rows[0].options).toEqual([
      "atomic-visit",
      "multi-stage",
      "focus-group",
    ]);
    expect(rows[0].override).toBe("focus-group");
  });

  it("does not duplicate an option already present", () => {
    const { rows } = applyDecisionOverrides(
      [makeRow()],
      [{ id: "archetype-selection", override: "focus-group" }],
    );
    expect(rows[0].options).toEqual([
      "atomic-visit",
      "focus-group",
      "multi-stage",
    ]);
  });

  it("carries a reaffirmed default (override == ai-default with reasoning)", () => {
    const { rows, applied } = applyDecisionOverrides(
      [makeRow()],
      [
        {
          id: "archetype-selection",
          override: "atomic-visit",
          override_reasoning: "Reviewed against field ops; the default holds.",
        },
      ],
    );
    expect(applied).toEqual(["archetype-selection"]);
    expect(rows[0]).toMatchObject({
      status: "overridden",
      override: "atomic-visit",
      override_reasoning: "Reviewed against field ops; the default holds.",
    });
  });

  it("skips a no-op row (override == ai-default, no reasoning)", () => {
    const { rows, applied } = applyDecisionOverrides(
      [makeRow()],
      [{ id: "archetype-selection", override: "atomic-visit" }],
    );
    expect(applied).toEqual([]);
    expect(rows[0].status).toBe("ai-default");
    expect(rows[0].override).toBeUndefined();
  });

  it("ignores override ids the batch never raises", () => {
    const { rows, applied } = applyDecisionOverrides(
      [makeRow()],
      [{ id: "never-raised", override: "whatever" }],
    );
    expect(applied).toEqual([]);
    expect(rows[0]).toEqual(makeRow());
  });

  it("leaves non-matching rows untouched and does not mutate inputs", () => {
    const original = makeRow();
    const untouched = makeRow({ id: "some-other-decision" });
    const input = [original, untouched];
    const { rows } = applyDecisionOverrides(
      input,
      parseDecisionOverridesYaml(VALID_FILE).overrides,
    );
    expect(rows[1]).toEqual(untouched);
    // Purity: the caller's row objects are not mutated in place.
    expect(original.status).toBe("ai-default");
    expect(original.override).toBeUndefined();
    expect(input[0]).toBe(original);
  });
});

/**
 * ace-web PR #714 added `decided_by_name`, `decided_by_verified` and
 * `history` to every override row, additively at schema_version 1. This
 * reader is non-strict, so it PARSED fine and silently STRIPPED all three —
 * harmless for binding (`applyDecisionOverrides` needs `id` + `override`
 * only), fatal for the feedback ledger's edit derivation, whose safety
 * property is that a self-reported name is never mistaken for a verified one.
 */
describe("identity + history fields (ace-web PR #714)", () => {
  const FILE = `
schema_version: 1
kind: decision-overrides
opp: spark-facilitator
overrides:
  - id: photo-required
    override: "yes"
    override_reasoning: A supervisor cannot verify a visit without one.
    ai_default: "no"
    decided_by: sfeintuch@dimagi-associate.com
    decided_by_name: Sophie Feintuch
    decided_by_verified: true
    decided_at: 2026-07-28T09:00:00Z
    history:
      - override: "no"
        decided_by_name: Anne
        decided_by_verified: false
        decided_at: 2026-07-27T09:00:00Z
`;

  it("keeps the identity fields instead of stripping them", () => {
    const row = parseDecisionOverridesYaml(FILE).overrides[0];
    expect(row.decided_by_name).toBe("Sophie Feintuch");
    expect(row.decided_by_verified).toBe(true);
  });

  it("keeps history, so a superseded value stays recoverable", () => {
    const [entry] = parseDecisionOverridesYaml(FILE).overrides[0].history ?? [];
    expect(entry.override).toBe("no");
    expect(entry.decided_by_verified).toBe(false);
  });

  it("still parses a row written before those fields existed", () => {
    const row = parseDecisionOverridesYaml(`
schema_version: 1
kind: decision-overrides
opp: o
overrides:
  - id: a
    override: b
`).overrides[0];
    expect(row.decided_by_verified).toBeUndefined();
    expect(row.history).toBeUndefined();
  });

  it("binds exactly as before — identity is read-side only", () => {
    const rows: DecisionRow[] = [
      {
        id: "photo-required",
        phase: "1-design",
        question: "Photo?",
        options: ["no"],
        "ai-default": "no",
        reasoning: "r",
        status: "ai-default",
      } as DecisionRow,
    ];
    const { applied, rows: out } = applyDecisionOverrides(
      rows,
      parseDecisionOverridesYaml(FILE).overrides,
    );
    expect(applied).toEqual(["photo-required"]);
    expect(out[0].override).toBe("yes");
  });
});
