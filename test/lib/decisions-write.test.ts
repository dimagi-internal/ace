import { describe, expect, it } from "vitest";
import yaml from "yaml";

import {
  DECISIONS_FILENAME,
  DecisionsWriteError,
  composeAppendedLog,
} from "../../lib/decisions-write.js";
import {
  DecisionsLogSchema,
  parseDecisionsYaml,
} from "../../lib/decisions-schema.js";

const NOW_PINNED = () => "2026-05-25T20:13:04Z";

const VALID_ROW = {
  id: "archetype-selection",
  phase: "1-design",
  skill: "idea-to-pdd",
  question: "Which delivery archetype best fits the intervention?",
  "ai-default": "atomic-visit",
  options: ["atomic-visit", "focus-group", "multi-stage"],
  source: "idea.md §1",
  status: "ai-default" as const,
  reasoning: "Single per-FLW visit producing one structured delivery.",
};

const WO_ROW = {
  id: "wo-period-of-performance",
  phase: "1-design",
  skill: "pdd-to-work-order",
  question: "what dates bound the work",
  "ai-default": "2026-05-22 to 2026-07-31",
  options: ["2026-05-22 to 2026-07-31"],
  source: "pdd-timeline",
  status: "ai-default" as const,
};

describe("composeAppendedLog — seeding a new log", () => {
  it("seeds schema_version=3 + opportunity + run_id + generated_at when text is null", () => {
    const result = composeAppendedLog({
      existingYamlText: null,
      opportunity: "bednet-spot-check",
      run_id: "20260525-2013",
      rows: [VALID_ROW],
      now: NOW_PINNED,
    });

    const parsed = parseDecisionsYaml(result.content);
    expect(parsed.schema_version).toBe(3);
    expect(parsed.opportunity).toBe("bednet-spot-check");
    expect(parsed.run_id).toBe("20260525-2013");
    expect(parsed.generated_at).toBe("2026-05-25T20:13:04Z");
    expect(parsed.decisions).toHaveLength(1);
    expect(parsed.decisions[0].id).toBe("archetype-selection");
    expect(result).toMatchObject({ added: 1, skipped: [], total: 1 });
  });

  it("treats empty/whitespace text the same as null", () => {
    const result = composeAppendedLog({
      existingYamlText: "  \n  ",
      opportunity: "bednet-spot-check",
      run_id: "20260525-2013",
      rows: [VALID_ROW],
      now: NOW_PINNED,
    });
    const parsed = parseDecisionsYaml(result.content);
    expect(parsed.decisions).toHaveLength(1);
    expect(result.added).toBe(1);
  });
});

describe("composeAppendedLog — appending to an existing log", () => {
  function seed() {
    return composeAppendedLog({
      existingYamlText: null,
      opportunity: "bednet-spot-check",
      run_id: "20260525-2013",
      rows: [VALID_ROW],
      now: NOW_PINNED,
    }).content;
  }

  it("appends new rows while preserving file-level header fields", () => {
    const seeded = seed();
    const result = composeAppendedLog({
      existingYamlText: seeded,
      opportunity: "bednet-spot-check",
      run_id: "20260525-2013",
      rows: [WO_ROW],
    });
    const parsed = parseDecisionsYaml(result.content);
    expect(parsed.decisions.map((d) => d.id)).toEqual([
      "archetype-selection",
      "wo-period-of-performance",
    ]);
    expect(parsed.generated_at).toBe("2026-05-25T20:13:04Z");
    expect(result).toMatchObject({ added: 1, skipped: [], total: 2 });
  });

  it("idempotently skips rows whose id is already in the log", () => {
    const seeded = seed();
    const result = composeAppendedLog({
      existingYamlText: seeded,
      opportunity: "bednet-spot-check",
      run_id: "20260525-2013",
      rows: [VALID_ROW, WO_ROW],
    });
    expect(result.added).toBe(1);
    expect(result.skipped).toEqual(["archetype-selection"]);
    expect(result.total).toBe(2);
    const parsed = parseDecisionsYaml(result.content);
    expect(parsed.decisions).toHaveLength(2);
  });

  it("rejects opportunity / run_id drift against an existing log", () => {
    const seeded = seed();
    expect(() =>
      composeAppendedLog({
        existingYamlText: seeded,
        opportunity: "other-opp",
        run_id: "20260525-2013",
        rows: [WO_ROW],
      }),
    ).toThrowError(/IDENTITY_MISMATCH|opportunity\/run_id mismatch/);
  });

  it("rejects a malformed existing log (the bednet-spot-check shape)", () => {
    const broken = yaml.stringify({
      opportunity: "bednet-spot-check",
      run_id: "20260525-2013",
      decisions: [
        {
          id: "wo-001",
          phase: "idea-to-design",
          skill: "pdd-to-work-order",
          decision: "Payment rate set to TBD",
          rationale: "Not specified in idea.md",
        },
      ],
    });
    let err: DecisionsWriteError | undefined;
    try {
      composeAppendedLog({
        existingYamlText: broken,
        opportunity: "bednet-spot-check",
        run_id: "20260525-2013",
        rows: [VALID_ROW],
      });
    } catch (e) {
      err = e as DecisionsWriteError;
    }
    expect(err).toBeInstanceOf(DecisionsWriteError);
    expect(err!.code).toBe("MALFORMED_LOG");
    expect(err!.message).toMatch(/schema_version|question|ai-default/);
  });
});

describe("composeAppendedLog — row validation", () => {
  it("rejects a row missing a required field with the row index in the message", () => {
    const bad = { ...VALID_ROW } as Record<string, unknown>;
    delete bad["ai-default"];
    let err: DecisionsWriteError | undefined;
    try {
      composeAppendedLog({
        existingYamlText: null,
        opportunity: "bednet-spot-check",
        run_id: "20260525-2013",
        rows: [VALID_ROW, bad],
        now: NOW_PINNED,
      });
    } catch (e) {
      err = e as DecisionsWriteError;
    }
    expect(err?.code).toBe("INVALID_ROW");
    expect(err?.message).toContain("rows[1]");
    expect(err?.message).toContain("ai-default");
  });

  it("rejects a row using the hallucinated `decision` field name", () => {
    const hallucinated = {
      id: "wo-001",
      phase: "idea-to-design",
      skill: "pdd-to-work-order",
      decision: "Payment rate set to TBD",
      rationale: "Smoke test — no rate needed",
    };
    let err: DecisionsWriteError | undefined;
    try {
      composeAppendedLog({
        existingYamlText: null,
        opportunity: "bednet-spot-check",
        run_id: "20260525-2013",
        rows: [hallucinated],
        now: NOW_PINNED,
      });
    } catch (e) {
      err = e as DecisionsWriteError;
    }
    expect(err?.code).toBe("INVALID_ROW");
  });

  it("rejects ordinal-less phase like `idea-to-design`", () => {
    const bad = { ...VALID_ROW, phase: "idea-to-design" };
    let err: DecisionsWriteError | undefined;
    try {
      composeAppendedLog({
        existingYamlText: null,
        opportunity: "x",
        run_id: "y",
        rows: [bad],
        now: NOW_PINNED,
      });
    } catch (e) {
      err = e as DecisionsWriteError;
    }
    expect(err?.code).toBe("INVALID_ROW");
    expect(err?.message).toMatch(/phase/);
  });

  it("rejects duplicate ids within a batch", () => {
    const dup = { ...VALID_ROW };
    expect(() =>
      composeAppendedLog({
        existingYamlText: null,
        opportunity: "x",
        run_id: "y",
        rows: [VALID_ROW, dup],
        now: NOW_PINNED,
      }),
    ).toThrowError(/DUPLICATE_BATCH_ID|duplicate id within batch: archetype-selection/);
  });

  it("validates that the composed output round-trips through DecisionsLogSchema", () => {
    const result = composeAppendedLog({
      existingYamlText: null,
      opportunity: "bednet-spot-check",
      run_id: "20260525-2013",
      rows: [VALID_ROW, WO_ROW],
      now: NOW_PINNED,
    });
    expect(() => DecisionsLogSchema.parse(yaml.parse(result.content))).not.toThrow();
  });
});

describe("DECISIONS_FILENAME", () => {
  it("is the canonical run-folder name", () => {
    expect(DECISIONS_FILENAME).toBe("decisions.yaml");
  });
});
