/**
 * The run-level record: outcome, lineage, typed blockers.
 *
 * Shapes here are taken from the 22 real runs of spark-facilitator and
 * hh-poverty-targeting, not invented — including the ones that are messy.
 */
import { describe, expect, it } from "vitest";

import {
  inferOutcome,
  parseBlockers,
  parseLineage,
  parseOutcome,
  parseRef,
} from "../../lib/run-record.js";

describe("parseOutcome", () => {
  it("accepts absence — every run predating the field is still valid", () => {
    expect(parseOutcome(undefined).ok).toBe(true);
    expect(parseOutcome(null).ok).toBe(true);
  });

  it("requires closed_by when a successor asserted the outcome", () => {
    const r = parseOutcome({ state: "superseded", determined_by: "next-run" });
    expect(r.ok).toBe(false);
    expect(r.issues.join()).toMatch(/closed_by/);
  });

  it("accepts a successor-asserted outcome with its evidence", () => {
    expect(
      parseOutcome({
        state: "superseded",
        determined_by: "next-run",
        closed_by: "20260728-0705",
        stopped_at: "commcare-setup/pdd-to-deliver-app",
      }).ok,
    ).toBe(true);
  });

  it("rejects an unknown state rather than passing prose through", () => {
    const r = parseOutcome({ state: "died", determined_by: "inferred" });
    expect(r.ok).toBe(false);
    expect(r.issues.join()).toMatch(/outcome.state/);
  });

  it("insists a reader can tell an asserted outcome from an inferred one", () => {
    const r = parseOutcome({ state: "abandoned" });
    expect(r.ok).toBe(false);
    expect(r.issues.join()).toMatch(/determined_by/);
  });
});

describe("parseLineage", () => {
  it("requires at least one relationship — an empty lineage claims nothing", () => {
    const r = parseLineage({ reason: "felt like it" });
    expect(r.ok).toBe(false);
    expect(r.issues.join()).toMatch(/supersedes.*forked_from/);
  });

  it("carries the WHY that prose keeps trying to hold", () => {
    // hh-poverty/20260728-0705 wrote exactly this as note text.
    const r = parseLineage({
      supersedes: "20260727-1406",
      reason: "Deliver app predates PR #999 — two live defects in the artifact",
    });
    expect(r.ok).toBe(true);
    expect(r.value?.reason).toMatch(/two live defects/);
  });

  // ace#2002 — a FIRST run supersedes nothing and is forked from nothing, and
  // had no legal way to say so: null failed the type check, omitting both
  // failed the check above, and omitting `lineage` entirely discarded the
  // `reason` that ace-orchestrator.md step 7b exists to capture. The only
  // encoding left was `supersedes: ""` — gaming the validator with a
  // meaningless string. Measured on poverty-graduation/20260905-0924, whose
  // run_state was invalid from run-init through Phase 1 while every boundary
  // fence returned green.
  it("accepts an explicit null ancestry — the first-run encoding", () => {
    const r = parseLineage({
      supersedes: null,
      forked_from: null,
      reason: "First run of this opp — exercises the componentized ingest path",
    });
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it("still rejects a reason with no ancestry statement at all", () => {
    // null is a STATEMENT ("considered, none"); absence is not. The test above
    // this block pins the same rule and must keep passing.
    const r = parseLineage({ reason: "first run" });
    expect(r.ok).toBe(false);
  });

  it("rejects a fork phase whose fork is explicitly null", () => {
    const r = parseLineage({ supersedes: null, forked_from: null, forked_at_phase: "commcare-setup" });
    expect(r.ok).toBe(false);
    expect(r.issues.join()).toMatch(/only meaningful with/);
  });

  it("rejects a non-string, non-null ancestry", () => {
    const r = parseLineage({ supersedes: 42, forked_from: null });
    expect(r.ok).toBe(false);
    expect(r.issues.join()).toMatch(/must be a string or null/);
  });

  it("rejects a fork phase with no fork", () => {
    const r = parseLineage({ supersedes: "x", forked_at_phase: "commcare-setup" });
    expect(r.ok).toBe(false);
    expect(r.issues.join()).toMatch(/only meaningful with/);
  });
});

describe("parseBlockers", () => {
  it("rejects the legacy scalar shape and names the twelve keys it replaces", () => {
    const r = parseBlockers("STALE MCP SUBPROCESS - resume in a fresh session");
    expect(r.ok).toBe(false);
    expect(r.issues.join()).toMatch(/halt_reason/);
  });

  it("accepts a typed blocker with a resolvable ref", () => {
    const r = parseBlockers([
      {
        class: "upstream-auth",
        at: "commcare-setup/step-0",
        ref: "github:dimagi-internal/ace#1624",
        as_of: "2026-08-25T03:08Z",
        state: "open",
      },
    ]);
    expect(r.ok).toBe(true);
  });

  it("REQUIRES as_of whenever a ref is given — a claim with no date cannot age out", () => {
    const r = parseBlockers([
      { class: "tooling", ref: "github:dimagi-internal/ace#1624", state: "open" },
    ]);
    expect(r.ok).toBe(false);
    expect(r.issues.join()).toMatch(/as_of is required/);
  });

  it("rejects an unresolvable ref", () => {
    const r = parseBlockers([
      { class: "tooling", ref: "ace#1624", as_of: "2026-08-25", state: "open" },
    ]);
    expect(r.ok).toBe(false);
    expect(r.issues.join()).toMatch(/<scheme>:<id>/);
  });

  it("rejects a free-text class — the enum is the whole point", () => {
    const r = parseBlockers([{ class: "nova was sad", state: "open" }]);
    expect(r.ok).toBe(false);
    expect(r.issues.join()).toMatch(/blockers\[0\].class/);
  });
});

describe("parseRef", () => {
  it.each([
    ["github:dimagi-internal/ace#1624", "github"],
    ["drive:1zAn0Srjmsu7", "drive"],
    ["gmail:19f86579142e6ba5", "gmail"],
    ["run:20260819-1435", "run"],
  ])("parses %s", (raw, scheme) => {
    expect(parseRef(raw)?.scheme).toBe(scheme);
  });

  it.each(["ace#1624", "github:", ":123", "nonsense"])("rejects %s", (raw) => {
    expect(parseRef(raw)).toBeNull();
  });
});

describe("inferOutcome — the half that needs no cooperation from a dead run", () => {
  const ps = (...st: string[]) =>
    st.map((status, i) => ({ ordinal: i + 1, name: `p${i + 1}`, status }));

  it("a superseded run is attributed to its successor", () => {
    const o = inferOutcome({
      phaseStates: ps("done", "done", "pending"),
      supersededBy: "20260728-0705",
      idleDays: 40,
      terminalPhase: 8,
    });
    expect(o.state).toBe("superseded");
    expect(o.determined_by).toBe("next-run");
    expect(o.closed_by).toBe("20260728-0705");
  });

  it("reaching the terminal phase reads as shipped", () => {
    const o = inferOutcome({
      phaseStates: ps("done", "done", "done", "done", "done", "done", "done", "done"),
      idleDays: 30,
      terminalPhase: 8,
    });
    expect(o.state).toBe("shipped");
  });

  it("an open blocker reads as halted, and carries its cause", () => {
    const o = inferOutcome({
      phaseStates: ps("done", "done", "in_progress"),
      blockers: [{ class: "upstream-auth", detail: "Nova bound needs-auth", state: "open" }],
      idleDays: 30,
      terminalPhase: 8,
    });
    expect(o.state).toBe("halted");
    expect(o.cause_class).toBe("upstream-auth");
    expect(o.cause).toMatch(/needs-auth/);
  });

  it("stopped short, nothing recorded, gone quiet = ABANDONED, named not guessed", () => {
    const o = inferOutcome({
      phaseStates: ps("done", "done", "pending"),
      idleDays: 32,
      terminalPhase: 8,
    });
    expect(o.state).toBe("abandoned");
    expect(o.determined_by).toBe("inferred");
    expect(o.stopped_at).toBe("p2");
  });

  it("a recent stop is not yet abandonment", () => {
    const o = inferOutcome({
      phaseStates: ps("done", "in_progress"),
      idleDays: 1,
      terminalPhase: 8,
    });
    expect(o.state).toBe("halted");
  });

  it("a run with nothing done at all still yields a usable outcome", () => {
    const o = inferOutcome({ phaseStates: ps("pending", "pending"), idleDays: 30, terminalPhase: 8 });
    expect(o.state).toBe("abandoned");
    expect(o.stopped_at).toBeUndefined();
  });
});
