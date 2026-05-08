import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseDecisionsYaml } from "../../../lib/decisions-schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const FIXTURE = resolve(
  __dirname,
  "fixtures/turmeric-decisions.yaml",
);

describe("turmeric calibration fixture", () => {
  const yaml = readFileSync(FIXTURE, "utf-8");
  const log = parseDecisionsYaml(yaml);

  it("parses cleanly against DecisionsLogSchema", () => {
    expect(log.schema_version).toBe(1);
    expect(log.opportunity).toBe("turmeric");
  });

  it("contains the 14 calibrated Phase 1 row IDs", () => {
    const ids = log.decisions.map((d) => d.id).sort();
    expect(ids).toEqual([
      "ai-fallback-design",
      "ai-photo-threshold",
      "archetype-selection",
      "budget-plausibility",
      "candidate-llo-roster",
      "flw-count",
      "named-downstream-consumer",
      "payment-rate",
      "pilot-sample-size",
      "primary-metric-vs-goal",
      "solicitation-deadline",
      "solicitation-type",
      "verification-layers",
      "working-language",
    ]);
  });

  it("scopes every row to phase 1-design and skill idea-to-pdd", () => {
    for (const row of log.decisions) {
      expect(row.phase).toBe("1-design");
      expect(row.skill).toBe("idea-to-pdd");
    }
  });

  it("flags the two known load-bearing-but-unresolved rows as status: open", () => {
    const open = log.decisions.filter((d) => d.status === "open").map((d) => d.id);
    expect(open.sort()).toEqual(["ai-fallback-design", "named-downstream-consumer"]);
  });
});
