/**
 * The run-init procedure must actually INVOKE the ingest, not merely
 * describe it in the reference.
 *
 * ACE has been burned by exactly this before: per orchestrator-reference
 * § Decisions log clause, "Documented catalogs without a matching per-step
 * bullet produced silent zero-write failures across Phase 2–9 on the
 * malaria-itn-app run (jjackson/ace#399); the catalog alone is not
 * load-bearing." The AGENT FILE's per-step bullet is what the dispatched
 * subagent treats as its checklist.
 *
 * `lib/decisions-ingest.ts` and `lib/run-record.ts` shipped with full test
 * coverage and nothing calling them. This test fails if that regresses.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const ORCHESTRATOR = readFileSync("agents/ace-orchestrator.md", "utf8");
const RUN_INIT = ORCHESTRATOR.slice(
  ORCHESTRATOR.indexOf("## Starting a New Opportunity"),
);

describe("run-init wires the decisions ingest", () => {
  it("names ingestPriorRun as a step, not just in the reference", () => {
    expect(RUN_INIT).toMatch(/ingestPriorRun/);
    expect(RUN_INIT).toMatch(/lib\/decisions-ingest\.ts/);
  });

  it("states the asymmetric carry rather than leaving it to memory", () => {
    // The rule is the whole point: binding a human ruling but NOT an AI
    // default is what keeps a reviewer's decision from being re-derived,
    // while still letting ACE decide better next time.
    expect(RUN_INIT).toMatch(/human-decided/);
    expect(RUN_INIT).toMatch(/advisory/);
  });

  it("pins the one-run-back anti-cruft rule", () => {
    expect(RUN_INIT).toMatch(/one\s*\n?\s*run back|one run back/i);
  });

  it("requires the conflict check before writing a decision", () => {
    expect(RUN_INIT).toMatch(/conflictsWithRuling/);
  });

  it("closes out the run this one replaces", () => {
    // A killed run cannot write its own epitaph; the successor must.
    expect(RUN_INIT).toMatch(/outcome/);
    expect(RUN_INIT).toMatch(/determined_by: next-run/);
    expect(RUN_INIT).toMatch(/lineage/);
  });

  it("keeps the run-init steps sequentially numbered", () => {
    // A duplicated or skipped number is how a step gets silently dropped
    // when the next person inserts one.
    const nums = [...RUN_INIT.matchAll(/^(\d+)\. \*\*/gm)]
      .map((m) => Number(m[1]))
      .slice(0, 10);
    expect(nums).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});
