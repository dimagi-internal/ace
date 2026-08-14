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
  evidence_basis: "stated" as const,
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
  evidence_basis: "inferred" as const,
};

describe("composeAppendedLog — seeding a new log", () => {
  it("seeds schema_version=4 + opportunity + run_id + generated_at when text is null", () => {
    const result = composeAppendedLog({
      existingYamlText: null,
      opportunity: "bednet-spot-check",
      run_id: "20260525-2013",
      rows: [VALID_ROW],
      now: NOW_PINNED,
    });

    const parsed = parseDecisionsYaml(result.content);
    expect(parsed.schema_version).toBe(4);
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

  // Since ace#1029 the two halves of "identity" are treated differently:
  // OPPORTUNITY drift stays fatal (appending one opp's decisions to another's
  // log is data loss); RUN_ID drift is warn-and-adopt, because a seeded log
  // inherits the parent's label and the run FOLDER is the authority. The
  // adopt half is covered in the ace#1029 suite below.
  it("rejects opportunity drift against an existing log", () => {
    const seeded = seed();
    let thrown: unknown;
    try {
      composeAppendedLog({
        existingYamlText: seeded,
        opportunity: "other-opp",
        run_id: "20260525-2013",
        rows: [WO_ROW],
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(DecisionsWriteError);
    expect((thrown as DecisionsWriteError).code).toBe("IDENTITY_MISMATCH");
    expect((thrown as Error).message).toMatch(/opportunity mismatch/);
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

describe("composeAppendedLog — reviewer decision-overrides (ace#933)", () => {
  const OVERRIDE = {
    id: "archetype-selection",
    override: "focus-group",
    override_reasoning: "Village-level enrollment; atomic-visit triples FLW days.",
  };

  it("binds a matching override onto a raised row", () => {
    const result = composeAppendedLog({
      existingYamlText: null,
      opportunity: "bednet-spot-check",
      run_id: "20260525-2013",
      rows: [VALID_ROW, WO_ROW],
      overrides: [OVERRIDE],
      now: NOW_PINNED,
    });
    expect(result.overridesApplied).toEqual(["archetype-selection"]);
    const parsed = parseDecisionsYaml(result.content);
    expect(parsed.decisions[0]).toMatchObject({
      status: "overridden",
      override: "focus-group",
      override_reasoning: OVERRIDE.override_reasoning,
      "ai-default": "atomic-visit",
    });
    expect(parsed.decisions[1].status).toBe("ai-default");
  });

  it("appends an out-of-set override value to options (strict invariant holds)", () => {
    const result = composeAppendedLog({
      existingYamlText: null,
      opportunity: "bednet-spot-check",
      run_id: "20260525-2013",
      rows: [VALID_ROW],
      overrides: [{ id: "archetype-selection", override: "door-to-door-census" }],
      now: NOW_PINNED,
    });
    const parsed = parseDecisionsYaml(result.content);
    expect(parsed.decisions[0].options).toContain("door-to-door-census");
    expect(parsed.decisions[0].override).toBe("door-to-door-census");
  });

  it("still strict-validates the emitted row BEFORE the override binds", () => {
    const bad = { ...VALID_ROW, "ai-default": "not-an-option" };
    expect(() =>
      composeAppendedLog({
        existingYamlText: null,
        opportunity: "bednet-spot-check",
        run_id: "20260525-2013",
        rows: [bad],
        overrides: [OVERRIDE],
        now: NOW_PINNED,
      }),
    ).toThrowError(DecisionsWriteError);
  });

  it("does not report overrides for rows skipped as already present", () => {
    const seeded = composeAppendedLog({
      existingYamlText: null,
      opportunity: "bednet-spot-check",
      run_id: "20260525-2013",
      rows: [VALID_ROW],
      now: NOW_PINNED,
    }).content;
    const result = composeAppendedLog({
      existingYamlText: seeded,
      opportunity: "bednet-spot-check",
      run_id: "20260525-2013",
      rows: [VALID_ROW, WO_ROW],
      overrides: [OVERRIDE],
      now: NOW_PINNED,
    });
    expect(result.skipped).toEqual(["archetype-selection"]);
    expect(result.overridesApplied).toEqual([]);
    // The already-present row keeps its original (non-overridden) shape.
    const parsed = parseDecisionsYaml(result.content);
    expect(parsed.decisions[0].status).toBe("ai-default");
  });

  it("ignores override ids the batch never raises and reports empty applied", () => {
    const result = composeAppendedLog({
      existingYamlText: null,
      opportunity: "bednet-spot-check",
      run_id: "20260525-2013",
      rows: [WO_ROW],
      overrides: [OVERRIDE],
      now: NOW_PINNED,
    });
    expect(result.overridesApplied).toEqual([]);
    expect(result.added).toBe(1);
  });

  it("omitting overrides keeps the legacy result shape working", () => {
    const result = composeAppendedLog({
      existingYamlText: null,
      opportunity: "bednet-spot-check",
      run_id: "20260525-2013",
      rows: [VALID_ROW],
      now: NOW_PINNED,
    });
    expect(result.overridesApplied).toEqual([]);
  });
});

describe("DECISIONS_FILENAME", () => {
  it("is the canonical run-folder name", () => {
    expect(DECISIONS_FILENAME).toBe("decisions.yaml");
  });
});

// ---------------------------------------------------------------------------
// dimagi-internal/ace#1029 — a SEEDED run inherits the parent run's
// decisions.yaml header verbatim, and two fields in it block every append for
// the entire run:
//
//   run_id: 20260706-0649                            <- the SEED's run, not this one
//   generated_at: 2026-07-06 13:53:07.331000+00:00   <- not ISO-8601
//
// Hit live in Phase 4 of bednet-spot-check/20260728-2222 (seeded_from
// 20260706-0649). `decisions_append_rows` is the ONLY sanctioned way to write
// the log ("do not hand-construct YAML and do not write decisions.yaml via
// update_yaml_file"), so the run silently lost its whole decisions trail —
// Phases 4..10 would each have failed the same way.
//
// The header is PROVENANCE METADATA. It must never be able to brick every
// decision write for a run.
// ---------------------------------------------------------------------------

/** The inherited header exactly as observed on Drive, plus one seeded row. */
const SEEDED_LOG = [
  "schema_version: 4",
  "opportunity: bednet-spot-check",
  "run_id: 20260706-0649",
  "generated_at: 2026-07-06 13:53:07.331000+00:00",
  "decisions:",
  "  - id: archetype-selection",
  "    phase: 1-design",
  "    skill: idea-to-pdd",
  "    question: Which delivery archetype best fits the intervention?",
  '    "ai-default": atomic-visit',
  "    options:",
  "      - atomic-visit",
  "    source: idea.md §1",
  "    status: ai-default",
  "    evidence_basis: stated",
  "",
].join("\n");

describe("composeAppendedLog — inherited/seeded header (ace#1029)", () => {
  const appendToSeeded = () =>
    composeAppendedLog({
      existingYamlText: SEEDED_LOG,
      opportunity: "bednet-spot-check",
      run_id: "20260728-2222", // THIS run, not the seed's
      rows: [WO_ROW],
      now: NOW_PINNED,
    });

  it("appends despite BOTH inherited defects, and keeps the seeded row", () => {
    const result = appendToSeeded();
    expect(result.added).toBe(1);
    const parsed = parseDecisionsYaml(result.content);
    expect(parsed.decisions).toHaveLength(2);
    expect(parsed.decisions.map((d) => d.id)).toContain("archetype-selection");
  });

  it("normalizes the non-ISO generated_at to ISO-8601 rather than failing the batch", () => {
    const parsed = parseDecisionsYaml(appendToSeeded().content);
    // Same instant, canonical spelling — the value is provenance, so it is
    // repaired, not discarded.
    expect(parsed.generated_at).toBe("2026-07-06T13:53:07.331Z");
    expect(() => DecisionsLogSchema.parse(parsed)).not.toThrow();
  });

  it("adopts THIS run's run_id and warns, instead of throwing IDENTITY_MISMATCH", () => {
    const result = appendToSeeded();
    const parsed = parseDecisionsYaml(result.content);
    // The log lives in runs/20260728-2222/, so the folder — not the copied
    // header — is the authority on which run it belongs to.
    expect(parsed.run_id).toBe("20260728-2222");
    expect(result.warnings.join(" ")).toMatch(/20260706-0649/);
    expect(result.warnings.join(" ")).toMatch(/20260728-2222/);
  });

  it("STILL throws on an opportunity mismatch — that guard is the data-loss one", () => {
    expect(() =>
      composeAppendedLog({
        existingYamlText: SEEDED_LOG,
        opportunity: "some-other-opp",
        run_id: "20260728-2222",
        rows: [WO_ROW],
        now: NOW_PINNED,
      }),
    ).toThrow(DecisionsWriteError);
  });

  it("still rejects a generated_at that is not a timestamp at all", () => {
    // The fix is scoped to parseable-but-non-ISO. A header that carries no
    // recoverable instant is genuinely corrupt and must stay loud.
    const corrupt = SEEDED_LOG.replace(
      "generated_at: 2026-07-06 13:53:07.331000+00:00",
      "generated_at: not-a-timestamp",
    );
    expect(() =>
      composeAppendedLog({
        existingYamlText: corrupt,
        opportunity: "bednet-spot-check",
        run_id: "20260728-2222",
        rows: [WO_ROW],
        now: NOW_PINNED,
      }),
    ).toThrow(/MALFORMED_LOG|generated_at/);
  });

  it("leaves a healthy log's header untouched and warns about nothing", () => {
    const healthy = SEEDED_LOG.replace(
      "run_id: 20260706-0649",
      "run_id: 20260728-2222",
    ).replace(
      "generated_at: 2026-07-06 13:53:07.331000+00:00",
      "generated_at: 2026-07-06T13:53:07.331Z",
    );
    const result = composeAppendedLog({
      existingYamlText: healthy,
      opportunity: "bednet-spot-check",
      run_id: "20260728-2222",
      rows: [WO_ROW],
      now: NOW_PINNED,
    });
    const parsed = parseDecisionsYaml(result.content);
    expect(parsed.generated_at).toBe("2026-07-06T13:53:07.331Z");
    expect(result.warnings).toEqual([]);
  });
});
