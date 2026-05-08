import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseDecisionsYaml } from "../../../lib/decisions-schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, "fixtures/turmeric-decisions.yaml");

const ANCHOR_IDS = [
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
    expect(log.schema_version).toBe(1);
    expect(log.opportunity).toBe("turmeric");
  });

  it("scopes every row to phase 1-design and skill idea-to-pdd", () => {
    for (const row of log.decisions) {
      expect(row.phase).toBe("1-design");
      expect(row.skill).toBe("idea-to-pdd");
    }
  });

  it("contains every anchor row from the Phase 1 anchor list", () => {
    const ids = new Set(log.decisions.map((d) => d.id));
    for (const anchor of ANCHOR_IDS) {
      expect(ids.has(anchor)).toBe(true);
    }
  });

  it("ensures every status: open row has populated notes", () => {
    const openRowsWithoutNotes = log.decisions
      .filter((d) => d.status === "open")
      .filter((d) => !d.notes || d.notes.trim().length === 0)
      .map((d) => d.id);
    expect(openRowsWithoutNotes).toEqual([]);
  });
});
