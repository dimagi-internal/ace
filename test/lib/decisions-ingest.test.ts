/**
 * Run-init ingest — the asymmetric carry.
 *
 * The behaviours pinned here are the ones the 22-run audit showed missing:
 * a human ruling that binds, an AI default that stays freely re-decidable,
 * and a history that does not accumulate.
 */
import { describe, expect, it } from "vitest";

import { conflictsWithRuling, ingestPriorRun } from "../../lib/decisions-ingest.js";
import type { DecisionRow } from "../../lib/decisions-schema.js";

function row(over: Partial<DecisionRow> = {}): DecisionRow {
  return {
    id: "archetype-selection",
    phase: "1-design",
    skill: "idea-to-pdd",
    question: "Which delivery archetype?",
    "ai-default": "atomic-visit",
    options: ["atomic-visit", "focus-group"],
    source: "idea.md",
    status: "ai-default",
    evidence_basis: "stated",
    value_set_by: "ace",
    ...over,
  } as DecisionRow;
}

const ruling = row({
  id: "gps-on-non-payable-outcomes",
  question: "Is GPS captured on non-payable outcomes?",
  "ai-default": "GPS on every outcome",
  options: ["GPS on every outcome", "payable only"],
  status: "human-decided",
  decided_by: "sophie.feintuch@example.org",
  decided_at: "2026-07-27",
  feedback_ref: "20260727-sophie-feintuch/c",
  reasoning: "In the previous build GPS was relevance-gated. It must be unconditional.",
});

describe("ingestPriorRun", () => {
  it("a human ruling BINDS and keeps its attribution", () => {
    const r = ingestPriorRun([], "20260813-1612", [{ row: ruling, runId: "20260727-1406" }]);
    const d = r.inherited[0];
    expect(d.authority).toBe("binding");
    expect(d.decided_by).toBe("sophie.feintuch@example.org");
    expect(d.from_run).toBe("20260727-1406");
    expect(d.feedback_ref).toBe("20260727-sophie-feintuch/c");
  });

  it("an AI default only ADVISES — the next run may decide better", () => {
    // duplicate-detection-key genuinely improved across runs. Binding it
    // would have frozen the worse version.
    const r = ingestPriorRun([row({ id: "duplicate-detection-key" })], "20260813-1612");
    expect(r.inherited[0].authority).toBe("advisory");
  });

  it("an operator run-control override advises rather than binds", () => {
    const r = ingestPriorRun(
      [row({ status: "overridden", override: "focus-group", override_reasoning: "dry-run test" })],
      "20260731-0656",
    );
    expect(r.inherited[0].authority).toBe("advisory");
    expect(r.inherited[0].value).toBe("focus-group");
  });

  it("a superseded row does not travel, and says why", () => {
    const r = ingestPriorRun([row({ superseded_by: "archetype-selection-v2" })], "20260813-1612");
    expect(r.inherited).toHaveLength(0);
    expect(r.dropped[0].reason).toMatch(/history, not state/);
  });

  it("a human ruling is not shadowed by a later ai-default on the same question", () => {
    const rederived = row({
      id: "gps-on-non-payable-outcomes",
      "ai-default": "payable only",
      options: ["GPS on every outcome", "payable only"],
    });
    const r = ingestPriorRun([rederived], "20260813-1612", [
      { row: ruling, runId: "20260727-1406" },
    ]);
    expect(r.inherited).toHaveLength(1);
    expect(r.inherited[0].authority).toBe("binding");
    expect(r.inherited[0].value).toBe("GPS on every outcome");
  });

  it("carries a DIGEST of the prior reasoning, not the whole row", () => {
    const long = row({
      reasoning: "First sentence explaining it. " + "Second sentence with detail. ".repeat(20),
    });
    const r = ingestPriorRun([long], "20260813-1612");
    expect(r.inherited[0].why).toBe("First sentence explaining it.");
  });

  it("reads ONE run back — the caller passes one run, so history cannot pile up", () => {
    // The anti-cruft rule is structural: the signature takes a single prior
    // run. The operator had to do this by hand on 2026-08-19.
    const r = ingestPriorRun([row(), row({ id: "b" }), row({ id: "c" })], "20260819-1435");
    expect(r.inherited.every((d) => d.from_run === "20260819-1435")).toBe(true);
  });
});

describe("conflictsWithRuling", () => {
  const inherited = ingestPriorRun([], "r", [{ row: ruling, runId: "20260727-1406" }]).inherited;

  it("flags a run about to overwrite a human ruling", () => {
    const c = conflictsWithRuling(
      { id: "gps-on-non-payable-outcomes", "ai-default": "payable only" },
      inherited,
    );
    expect(c?.decided_by).toBe("sophie.feintuch@example.org");
  });

  it("stays quiet when the run agrees with the ruling", () => {
    expect(
      conflictsWithRuling(
        { id: "gps-on-non-payable-outcomes", "ai-default": "GPS on every outcome" },
        inherited,
      ),
    ).toBeNull();
  });

  it("catches the conflict even when the run RENAMED the decision", () => {
    // The whole failure mode: 9 comments raised under 22 different ids.
    const c = conflictsWithRuling(
      {
        id: "gps-capture-scope",
        "ai-default": "payable only",
        feedback_ref: "20260727-sophie-feintuch/c",
      },
      inherited,
    );
    expect(c?.id).toBe("gps-on-non-payable-outcomes");
  });

  it("does not flag a decision nobody ruled on", () => {
    expect(conflictsWithRuling({ id: "flw-count", "ai-default": "12" }, inherited)).toBeNull();
  });

  it("does not flag against an advisory row", () => {
    const advisory = ingestPriorRun([row()], "r").inherited;
    expect(
      conflictsWithRuling({ id: "archetype-selection", "ai-default": "focus-group" }, advisory),
    ).toBeNull();
  });
});
