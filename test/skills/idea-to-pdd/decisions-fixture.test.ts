import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseDecisionsYaml } from "../../../lib/decisions-schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, "fixtures/turmeric-decisions.yaml");

// Five Phase 1 decisions feed `idea-to-pdd-eval`'s viability axis
// (PR #144). When a fixture covers them, the eval rubric has structured
// input for those dimensions instead of grading on PDD prose. They are
// NOT required by the schema or the runtime — this is a fixture-quality
// check that the turmeric fixture is a useful template.
const VIABILITY_AXIS_INPUTS = [
  "ai-fallback-design",
  "archetype-selection",
  "budget-plausibility",
  "named-downstream-consumer",
  "primary-metric-vs-goal",
];

describe("turmeric calibration fixture", () => {
  const yaml = readFileSync(FIXTURE, "utf-8");
  const log = parseDecisionsYaml(yaml);

  it("parses cleanly against DecisionsLogSchema", () => {
    expect(log.schema_version).toBe(2);
    expect(log.opportunity).toBe("turmeric");
  });

  it("scopes every row to phase 1-design and skill idea-to-pdd", () => {
    for (const row of log.decisions) {
      expect(row.phase).toBe("1-design");
      expect(row.skill).toBe("idea-to-pdd");
    }
  });

  it("covers the 5 viability-axis decisions idea-to-pdd-eval grades on", () => {
    // Fixture-quality check: a useful Phase 1 fixture surfaces the
    // decisions the eval rubric grades on. Not a runtime invariant.
    const ids = new Set(log.decisions.map((d) => d.id));
    for (const id of VIABILITY_AXIS_INPUTS) {
      expect(ids.has(id)).toBe(true);
    }
  });

  it("ensures every overridden row has populated notes and override", () => {
    const offenders = log.decisions
      .filter((d) => d.status === "overridden")
      .filter((d) => !d.override || (!d.notes || d.notes.trim().length === 0))
      .map((d) => d.id);
    expect(offenders).toEqual([]);
  });
});
