# Decisions Log — PR #1: Schema + Phase 1 Write-Side — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the schema, helpers, and Phase 1 (`idea-to-pdd`) write-side of the ACE decisions log, producing a per-run `decisions.yaml` source-of-truth artifact with a calibrated set of ~14 Phase 1 rows.

**Architecture:** A Zod-validated YAML at `ACE/<opp>/runs/<run-id>/decisions.yaml`, written by `idea-to-pdd` during Phase 1. Schema lib lives in `lib/decisions-schema.ts` mirroring `lib/qa-types.ts` conventions (Zod schemas + types + YAML read/write helpers). The `idea-to-pdd` skill body gains a `## Decisions Log Convention` section enumerating the calibrated row set, the bar criterion, and the write contract — replacing the existing `## Open Questions Convention`. No renderer, no round-trip, no Phase 2–9 writes — those are PRs #2–4.

**Tech Stack:** TypeScript + Zod (matches `lib/qa-types.ts`), js-yaml for YAML (already in use), vitest for unit tests, Google Drive MCP atoms for runtime YAML write (`drive_create_file` with `findOrCreate` semantics — already in use across ACE skills). No new dependencies.

**Pre-flight:** This PR's spec ([`docs/superpowers/specs/2026-05-08-decisions-log-design.md`](../specs/2026-05-08-decisions-log-design.md)) recommends landing this PR after `idea-to-pdd`'s QA/Eval migration (PR #147 Phase 1 PR #1). If that migration has shipped at land time, also extend `idea-to-pdd-qa` with structural checks against `decisions.yaml` (called out as Task 9 below — skip if pre-migration, follow up if post-migration).

---

## Spec coverage map

| Spec section | Covered by |
|---|---|
| Schema (Zod + YAML) | Tasks 1–3 |
| Source of truth at `ACE/<opp>/runs/<run-id>/decisions.yaml` | Task 4 (skill body) |
| Bar criterion + scope | Task 4 (skill body) |
| Phase 1 calibration row set (~10–15 rows) | Task 4 (skill body) + Task 5 (fixture) |
| Phase 1 interaction (default + review modes) | Task 4 (skill body Mode Behavior) |
| Phase Write-Back Contract clause | Task 6 |
| Gate brief integration (`Decisions Log:` line) | Task 7 |
| Migration: retire `open-questions.md` | Task 4 (replaces `## Open Questions Convention`) |
| Coordination — `idea-to-pdd-qa` structural checks | Task 9 (conditional) |
| Renderer | OUT OF SCOPE — PR #2 |
| Phase 2–9 writes | OUT OF SCOPE — PR #3 |
| Round-trip sync | OUT OF SCOPE — PR #4 |

---

## File structure

**Create:**
- `lib/decisions-schema.ts` — Zod schemas (`DecisionRowSchema`, `DecisionsLogSchema`), exported types, YAML helpers (`parseDecisionsYaml`, `serializeDecisionsLog`).
- `test/lib/decisions-schema.test.ts` — unit tests for schema + helpers.
- `test/skills/idea-to-pdd/fixtures/turmeric-decisions.yaml` — hand-authored calibration fixture showing the expected Phase 1 row set for a turmeric-shaped input.
- `test/skills/idea-to-pdd/decisions-fixture.test.ts` — snapshot test asserting the fixture parses and contains all calibration row IDs.

**Modify:**
- `skills/idea-to-pdd/SKILL.md` — add `## Decisions Log Convention` section, update `## Process` step list, update `## Outputs`, update `## Mode Behavior`, retire `## Open Questions Convention`. Update `## Change Log`.
- `skills/idea-to-pdd/SKILL.md` (Gate Brief section) — replace `Open Questions Doc:` line with `Decisions Log:` line.
- `agents/ace-orchestrator.md` — add a clause to `## Phase Write-Back Contract` requiring `decisions.yaml` rows.
- `VERSION` — bumped via `scripts/version-bump.sh` at the end.
- `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` — auto-synced by the version-bump pre-commit hook.

**No deletes.** The current `open-questions.md` artifact path stops being created by `idea-to-pdd`, but no existing files are removed (existing runs' open-questions docs in Drive stay where they are).

---

## Tasks

### Task 1: Define the Zod schema and types

**Files:**
- Create: `lib/decisions-schema.ts`
- Test: `test/lib/decisions-schema.test.ts`

- [ ] **Step 1: Write the failing test.**

Create `test/lib/decisions-schema.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DecisionRowSchema, DecisionsLogSchema } from "../../lib/decisions-schema.js";

describe("DecisionRowSchema", () => {
  it("accepts a minimal valid row", () => {
    const row = {
      id: "flw-count",
      phase: "1-design",
      skill: "idea-to-pdd",
      question: "How many FLWs should the program target?",
      default: "5–8",
      options_considered: ["3–5", "10–15", "20+"],
      source: "idea.md §2; atomic-visit archetype norm",
      status: "applied",
    };
    expect(() => DecisionRowSchema.parse(row)).not.toThrow();
  });

  it("rejects an empty id", () => {
    const row = {
      id: "",
      phase: "1-design",
      skill: "idea-to-pdd",
      question: "Q?",
      default: "x",
      options_considered: [],
      source: "x",
      status: "applied",
    };
    expect(() => DecisionRowSchema.parse(row)).toThrow();
  });

  it("rejects an invalid status enum value", () => {
    const row = {
      id: "flw-count",
      phase: "1-design",
      skill: "idea-to-pdd",
      question: "Q?",
      default: "x",
      options_considered: [],
      source: "x",
      status: "resolved",  // not in v1 enum
    };
    expect(() => DecisionRowSchema.parse(row)).toThrow();
  });

  it("rejects a non-string default", () => {
    const row = {
      id: "flw-count",
      phase: "1-design",
      skill: "idea-to-pdd",
      question: "Q?",
      default: 5,  // must be string
      options_considered: [],
      source: "x",
      status: "applied",
    };
    expect(() => DecisionRowSchema.parse(row)).toThrow();
  });

  it("accepts an optional notes field", () => {
    const row = {
      id: "flw-count",
      phase: "1-design",
      skill: "idea-to-pdd",
      question: "Q?",
      default: "x",
      options_considered: [],
      source: "x",
      status: "applied",
      notes: "Atomic-visit norm.",
    };
    expect(() => DecisionRowSchema.parse(row)).not.toThrow();
  });
});

describe("DecisionsLogSchema", () => {
  it("accepts a minimal valid log", () => {
    const log = {
      schema_version: 1,
      opportunity: "turmeric",
      run_id: "20260507-1733",
      generated_at: "2026-05-07T17:33:00Z",
      decisions: [],
    };
    expect(() => DecisionsLogSchema.parse(log)).not.toThrow();
  });

  it("rejects schema_version other than 1", () => {
    const log = {
      schema_version: 2,
      opportunity: "turmeric",
      run_id: "20260507-1733",
      generated_at: "2026-05-07T17:33:00Z",
      decisions: [],
    };
    expect(() => DecisionsLogSchema.parse(log)).toThrow();
  });

  it("rejects duplicate decision IDs", () => {
    const log = {
      schema_version: 1,
      opportunity: "turmeric",
      run_id: "20260507-1733",
      generated_at: "2026-05-07T17:33:00Z",
      decisions: [
        {
          id: "flw-count",
          phase: "1-design",
          skill: "idea-to-pdd",
          question: "Q?",
          default: "5–8",
          options_considered: [],
          source: "x",
          status: "applied",
        },
        {
          id: "flw-count",  // duplicate
          phase: "1-design",
          skill: "idea-to-pdd",
          question: "Q?",
          default: "5–8",
          options_considered: [],
          source: "x",
          status: "applied",
        },
      ],
    };
    expect(() => DecisionsLogSchema.parse(log)).toThrow(/duplicate/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `npx vitest run test/lib/decisions-schema.test.ts`
Expected: FAIL with `Cannot find module '../../lib/decisions-schema.js'` (the schema file doesn't exist yet).

- [ ] **Step 3: Implement the schema.**

Create `lib/decisions-schema.ts`:

```ts
import { z } from "zod";

/**
 * One row in a per-run decisions log. Represents a load-bearing default
 * an ACE phase applied (or a load-bearing decision the AI flagged for
 * human attention while still proceeding with a default).
 *
 * See docs/superpowers/specs/2026-05-08-decisions-log-design.md § Schema
 * for field semantics and the bar criterion that gates row creation.
 */
export const DecisionRowSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/, {
    message: "id must be kebab-case (lowercase, digits, hyphens; cannot start with hyphen)",
  }),
  phase: z.string().regex(/^[1-9][0-9]*-[a-z][a-z-]*$/, {
    message: "phase must match <N>-<name> (e.g. 1-design, 2-commcare)",
  }),
  skill: z.string().min(1),
  question: z.string().min(1),
  default: z.string().min(1),
  options_considered: z.array(z.string()),
  source: z.string().min(1),
  status: z.enum(["applied", "overridden", "open"]),
  notes: z.string().optional(),
});

export type DecisionRow = z.infer<typeof DecisionRowSchema>;

/**
 * The full per-run log file shape. Stored at
 * ACE/<opp>/runs/<run-id>/decisions.yaml.
 */
export const DecisionsLogSchema = z
  .object({
    schema_version: z.literal(1),
    opportunity: z.string().min(1),
    run_id: z.string().min(1),
    generated_at: z.string().datetime({ offset: true }),
    decisions: z.array(DecisionRowSchema),
  })
  .superRefine((log, ctx) => {
    const seen = new Set<string>();
    for (const [index, row] of log.decisions.entries()) {
      if (seen.has(row.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate decision id: ${row.id}`,
          path: ["decisions", index, "id"],
        });
      }
      seen.add(row.id);
    }
  });

export type DecisionsLog = z.infer<typeof DecisionsLogSchema>;
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `npx vitest run test/lib/decisions-schema.test.ts`
Expected: PASS — all 8 assertions green.

- [ ] **Step 5: Commit.**

```bash
git add lib/decisions-schema.ts test/lib/decisions-schema.test.ts
git commit -m "lib: add Zod schema for decisions log

DecisionRow and DecisionsLog schemas with kebab-case id validation,
phase-name pattern, status enum (applied|overridden|open), and a
duplicate-id check via superRefine. Mirrors lib/qa-types.ts pattern.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Add YAML read/write helpers

**Files:**
- Modify: `lib/decisions-schema.ts`
- Modify: `test/lib/decisions-schema.test.ts`

- [ ] **Step 1: Write the failing test.**

Append to `test/lib/decisions-schema.test.ts`:

```ts
import { parseDecisionsYaml, serializeDecisionsLog } from "../../lib/decisions-schema.js";

describe("parseDecisionsYaml", () => {
  it("parses a valid YAML string into a DecisionsLog", () => {
    const yaml = `
schema_version: 1
opportunity: turmeric
run_id: 20260507-1733
generated_at: "2026-05-07T17:33:00Z"
decisions:
  - id: flw-count
    phase: 1-design
    skill: idea-to-pdd
    question: How many FLWs?
    default: "5–8"
    options_considered: ["3–5", "10–15"]
    source: idea.md §2
    status: applied
`;
    const log = parseDecisionsYaml(yaml);
    expect(log.opportunity).toBe("turmeric");
    expect(log.decisions).toHaveLength(1);
    expect(log.decisions[0]!.id).toBe("flw-count");
  });

  it("throws a typed error on schema violation", () => {
    const yaml = `
schema_version: 1
opportunity: turmeric
run_id: 20260507-1733
generated_at: "2026-05-07T17:33:00Z"
decisions:
  - id: ""  # empty id violates schema
    phase: 1-design
    skill: idea-to-pdd
    question: Q?
    default: x
    options_considered: []
    source: x
    status: applied
`;
    expect(() => parseDecisionsYaml(yaml)).toThrow(/decisions\.0\.id/);
  });

  it("throws on unparseable YAML", () => {
    expect(() => parseDecisionsYaml("not: : valid: yaml")).toThrow();
  });
});

describe("serializeDecisionsLog", () => {
  it("round-trips through parse with no data loss", () => {
    const log = {
      schema_version: 1 as const,
      opportunity: "turmeric",
      run_id: "20260507-1733",
      generated_at: "2026-05-07T17:33:00Z",
      decisions: [
        {
          id: "flw-count",
          phase: "1-design",
          skill: "idea-to-pdd",
          question: "How many FLWs?",
          default: "5–8",
          options_considered: ["3–5", "10–15"],
          source: "idea.md §2",
          status: "applied" as const,
        },
      ],
    };
    const yaml = serializeDecisionsLog(log);
    const parsed = parseDecisionsYaml(yaml);
    expect(parsed).toEqual(log);
  });

  it("preserves non-ASCII characters (em dashes, en dashes)", () => {
    const log = {
      schema_version: 1 as const,
      opportunity: "turmeric",
      run_id: "20260507-1733",
      generated_at: "2026-05-07T17:33:00Z",
      decisions: [
        {
          id: "ai-photo-threshold",
          phase: "1-design",
          skill: "idea-to-pdd",
          question: "AI auto-accept confidence threshold?",
          default: "≥90%",
          options_considered: ["≥85%", "≥95%"],
          source: "stress-test verifiability dimension",
          status: "applied" as const,
        },
      ],
    };
    const yaml = serializeDecisionsLog(log);
    expect(yaml).toContain("≥90%");
    const parsed = parseDecisionsYaml(yaml);
    expect(parsed.decisions[0]!.default).toBe("≥90%");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `npx vitest run test/lib/decisions-schema.test.ts`
Expected: FAIL with `parseDecisionsYaml is not a function` (or import resolution error).

- [ ] **Step 3: Implement the helpers.**

Append to `lib/decisions-schema.ts`:

```ts
import yaml from "js-yaml";

/**
 * Parse a YAML string into a validated DecisionsLog.
 * Throws ZodError with the offending path if validation fails.
 * Throws YAMLException if the YAML itself is unparseable.
 */
export function parseDecisionsYaml(input: string): DecisionsLog {
  const raw = yaml.load(input);
  return DecisionsLogSchema.parse(raw);
}

/**
 * Serialize a DecisionsLog into a YAML string suitable for writing to
 * ACE/<opp>/runs/<run-id>/decisions.yaml. Uses lineWidth: -1 so long
 * strings (notes paragraphs) don't get auto-folded — block-scalar
 * folding makes the file harder to diff and harder for humans to read.
 */
export function serializeDecisionsLog(log: DecisionsLog): string {
  // Validate before emitting — catches caller errors before we write.
  DecisionsLogSchema.parse(log);
  return yaml.dump(log, {
    lineWidth: -1,
    noRefs: true,
    sortKeys: false,
  });
}
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `npx vitest run test/lib/decisions-schema.test.ts`
Expected: PASS — all assertions green (now 13 total).

- [ ] **Step 5: Commit.**

```bash
git add lib/decisions-schema.ts test/lib/decisions-schema.test.ts
git commit -m "lib: add YAML read/write helpers for decisions log

parseDecisionsYaml + serializeDecisionsLog round-trip through
js-yaml with lineWidth: -1 so notes paragraphs stay readable in
diffs. Validates on both parse and serialize.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Author the calibration fixture

The fixture documents what `idea-to-pdd` should produce for a turmeric-shaped input. It serves as the row-set ground truth for Task 4's skill update and as a snapshot test target.

**Files:**
- Create: `test/skills/idea-to-pdd/fixtures/turmeric-decisions.yaml`
- Create: `test/skills/idea-to-pdd/decisions-fixture.test.ts`

- [ ] **Step 1: Write the fixture.**

Create `test/skills/idea-to-pdd/fixtures/turmeric-decisions.yaml`:

```yaml
schema_version: 1
opportunity: turmeric
run_id: 20260507-1733
generated_at: "2026-05-07T17:33:00Z"

decisions:
  - id: archetype-selection
    phase: 1-design
    skill: idea-to-pdd
    question: Which delivery archetype best fits the intervention?
    default: atomic-visit
    options_considered: ["atomic-visit", "focus-group", "multi-stage"]
    source: idea.md §1; one-FLW-one-delivery pattern
    status: applied
    notes: Single per-FLW visit producing one structured delivery.

  - id: flw-count
    phase: 1-design
    skill: idea-to-pdd
    question: How many FLWs should the program target?
    default: "5–8"
    options_considered: ["3–5", "5–8", "10–15", "20+"]
    source: idea.md §2; atomic-visit archetype norm at this geographic scope
    status: applied

  - id: budget-plausibility
    phase: 1-design
    skill: idea-to-pdd
    question: Is the stated budget plausible for the implied labor + AI infra?
    default: plausible
    options_considered: ["plausible", "too-low", "too-high"]
    source: idea-to-pdd-eval `resource_realism` dimension (PR #144)
    status: applied
    notes: |
      $1,500 / 8 FLWs / 30 visits ≈ $6.25/visit gross — covers stated $3 payment
      with margin for LLO ops + AI infra at recruitment-realistic rates.

  - id: payment-rate
    phase: 1-design
    skill: idea-to-pdd
    question: Per-visit payment rate to FLW?
    default: "$3.00"
    options_considered: ["$2.00", "$3.00", "$5.00"]
    source: idea.md §3; payment-rate convention for atomic-visit market surveys
    status: applied

  - id: pilot-sample-size
    phase: 1-design
    skill: idea-to-pdd
    question: Pilot sample size for AI calibration before full rollout?
    default: "30 photos"
    options_considered: ["20 photos", "30 photos", "50 photos", "100 photos"]
    source: stress-test verifiability dimension; calibration-set norm
    status: applied

  - id: ai-photo-threshold
    phase: 1-design
    skill: idea-to-pdd
    question: AI auto-accept confidence threshold for photo verification?
    default: "≥90%"
    options_considered: ["≥85%", "≥90%", "≥95%"]
    source: idea-to-pdd-eval `verifiability` rubric; Layer-B AI-check norm
    status: applied

  - id: ai-fallback-design
    phase: 1-design
    skill: idea-to-pdd
    question: Fallback for AI auto-reject — true validation harness or parallel sampling?
    default: parallel-sampling-N-percent
    options_considered:
      - "parallel-sampling-N-percent"
      - "stratified-validation-of-AI-output"
      - "no-fallback"
    source: idea-to-pdd-eval `fallback_validates_primary` dimension (PR #144)
    status: open
    notes: |
      Default is parallel sampling (N% human review of all submissions, independent
      of AI's classification). NOT a true validation harness — it samples a different
      population than the AI saw, so it doesn't validate per-decision accuracy.
      Flagged in gate brief; human edit recommended if ground-truth metrics matter.

  - id: named-downstream-consumer
    phase: 1-design
    skill: idea-to-pdd
    question: Is there a named downstream consumer with pre-committed action?
    default: none-named-proceed-with-caveat
    options_considered:
      - "named-consumer-with-MOU"
      - "named-consumer-no-MOU"
      - "none-named-proceed-with-caveat"
      - "none-named-halt"
    source: idea-to-pdd-eval `demand_reality` dimension (PR #144)
    status: open
    notes: |
      No consumer named in idea.md. Proceeding with default; flag in gate brief.
      Human edit recommended before Phase 7 solicitation publishes.

  - id: primary-metric-vs-goal
    phase: 1-design
    skill: idea-to-pdd
    question: Primary success metric — direct goal measurement or upstream proxy?
    default: proxy-of-goal
    options_considered: ["direct-goal", "proxy-of-goal", "tbd-during-pilot"]
    source: idea-to-pdd-eval `mission_alignment` dimension (PR #144)
    status: applied
    notes: Photo-quality pass rate is a proxy for "AI replaces human verification"; not the goal itself.

  - id: working-language
    phase: 1-design
    skill: idea-to-pdd
    question: Working language(s) for Learn + Deliver apps?
    default: "English only"
    options_considered: ["English only", "English + 1 local", "Multilingual (3+)"]
    source: idea.md does not specify; LLO directory shows English-fluent candidates
    status: applied

  - id: verification-layers
    phase: 1-design
    skill: idea-to-pdd
    question: Which evidence-model layers are in scope?
    default: "A + B"
    options_considered: ["A only", "A + B", "A + B + C"]
    source: pdd-template.md `## Evidence Model` section
    status: applied
    notes: Layer A self-report + Layer B AI photo-verification. Layer C (independent audit) deferred to Phase 8.

  - id: solicitation-type
    phase: 1-design
    skill: idea-to-pdd
    question: Solicitation type for Phase 7 publication?
    default: EOI
    options_considered: ["EOI", "RFP", "custom"]
    source: skills/idea-to-pdd `## Solicitation` section default
    status: applied

  - id: solicitation-deadline
    phase: 1-design
    skill: idea-to-pdd
    question: Solicitation response deadline (days from publish)?
    default: "14 days"
    options_considered: ["7 days", "14 days", "21 days", "30 days"]
    source: skills/idea-to-pdd `## Solicitation` section default
    status: applied

  - id: candidate-llo-roster
    phase: 1-design
    skill: idea-to-pdd
    question: Are PDD-named candidate LLOs in scope for direct invitation?
    default: any-LLO-via-public-solicitation
    options_considered:
      - "named-candidates-direct-invite"
      - "named-candidates-plus-public-solicitation"
      - "any-LLO-via-public-solicitation"
    source: idea.md §LLO Preference; LLO directory
    status: applied
    notes: idea.md does not name specific candidates; defaulting to public solicitation.
```

- [ ] **Step 2: Write the failing snapshot test.**

Create `test/skills/idea-to-pdd/decisions-fixture.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDecisionsYaml } from "../../../lib/decisions-schema.js";

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
```

- [ ] **Step 3: Run the test.**

Run: `npx vitest run test/skills/idea-to-pdd/decisions-fixture.test.ts`
Expected: PASS — fixture validates and matches the 14-row calibration set.

- [ ] **Step 4: Commit.**

```bash
git add test/skills/idea-to-pdd/fixtures/turmeric-decisions.yaml \
        test/skills/idea-to-pdd/decisions-fixture.test.ts
git commit -m "test: turmeric calibration fixture for idea-to-pdd decisions

14-row Phase 1 calibration set covering all four viability axes from
PR #144 (demand_reality, resource_realism, mission_alignment,
fallback_validates_primary) plus archetype, FLW count, payment rate,
pilot size, AI threshold, language, evidence layers, solicitation
defaults, and candidate-LLO roster. Two rows flagged status: open
(named consumer absent; AI fallback is parallel sampling not validation).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Update `skills/idea-to-pdd/SKILL.md`

This is the load-bearing change of PR #1: add the `## Decisions Log Convention` section, wire the write step into `## Process`, retire the old `## Open Questions Convention`, update outputs, gate brief, mode behavior, and change log.

**Files:**
- Modify: `skills/idea-to-pdd/SKILL.md`

- [ ] **Step 1: Update the `## Outputs` table.**

Find the existing `## Outputs` block (around lines 22–25):

```markdown
## Outputs

- `1-design/idea-to-pdd.md` — the PDD
- `1-design/idea-to-pdd_gate-brief.md` — gate brief consumed at the Phase 1 → 2 review pause
- `ACE/<opp-name>/open-questions.md` (Google Doc, optional) — when stress-test rubric surfaces unresolved questions
```

Replace with:

```markdown
## Outputs

- `1-design/idea-to-pdd.md` — the PDD
- `1-design/idea-to-pdd_gate-brief.md` — gate brief consumed at the Phase 1 → 2 review pause
- `ACE/<opp-name>/runs/<run-id>/decisions.yaml` — structured per-run decisions log (always emitted; see `## Decisions Log Convention` below)
```

- [ ] **Step 2: Update `## Process` to write `decisions.yaml` before drafting the PDD.**

Find the existing step 4 ("Draft the PDD with the **base sections** below…") and step 5 ("Self-evaluate (LLM-as-Judge)…").

Insert a new step 3a immediately after the existing step 3 ("Research and expand"):

```markdown
3a. **Author the decisions log.** Before drafting the PDD, populate
    `ACE/<opp-name>/runs/<run-id>/decisions.yaml` with the Phase 1 row
    set defined in `## Decisions Log Convention` below. Each row records
    a load-bearing default the skill is about to apply when drafting the
    PDD. Use the AI's best inference from the source material for each
    `default` value; mark `status: open` for any default the AI flags
    for human attention while still proceeding.

    The skill MUST emit a complete decisions.yaml even when source
    material answers most questions explicitly — every load-bearing row
    in the calibration set appears, with `status: applied` and the
    source-material citation.
```

Update step 4 (PDD draft) to reference the decisions.yaml as input:

Find step 4's opening:

```markdown
4. **Draft the PDD** with the **base sections** below, plus **archetype-specific additions** from `## Archetypes`:
```

Replace with:

```markdown
4. **Draft the PDD** with the **base sections** below, plus **archetype-specific additions** from `## Archetypes`. Use the values selected in step 3a's `decisions.yaml` as authoritative — every numeric or named-entity in the PDD body should match the corresponding row's `default`. If a re-run reads a `decisions.yaml` from a prior run with `status: overridden` rows (human edited via the renderer + sync skills landing in PRs #2–#4), use those overridden values instead.
```

- [ ] **Step 3: Add the `## Decisions Log Convention` section.**

Find the existing `## Open Questions Convention` section (starts around line 211 with `## Open Questions Convention`).

Replace the entire `## Open Questions Convention` section (from the heading down to the next top-level `## ` heading — should be `## Archetypes`) with:

```markdown
## Decisions Log Convention

Every Phase 1 run emits `ACE/<opp-name>/runs/<run-id>/decisions.yaml`
with a calibrated set of load-bearing default-decisions the skill applied
while drafting the PDD. The log is the per-run audit trail and the
human-iteration surface — humans edit it (via the renderer + sync skills
landing in PRs #2–#4) to redirect a subsequent run's PDD draft.

### Bar criterion — what counts as a row

Two filters, both must be true:

1. **Load-bearing.** A reasonable person could pick differently AND it
   materially shapes downstream phases or eval scores.
2. **Maps to a known surface.** The default ties to one of: an
   `*-eval` rubric dimension, an `*-qa` structural check, a Phase
   Write-Back field that downstream phases read, or a numeric / named
   entity surfaced in the PDD body.

Form-field-level choices, Connect program slugs, email copy, font sizes
— below the bar.

### Required Phase 1 row set

Every Phase 1 run MUST emit at least the rows below (calibrated
2026-05-08; ground truth fixture at
`test/skills/idea-to-pdd/fixtures/turmeric-decisions.yaml`). The
calibration set aligns with the four viability dimensions from PR #144
(`demand_reality`, `resource_realism`, `mission_alignment`,
`fallback_validates_primary`) plus the existing structural / archetype
dimensions.

| ID | Question | Map to surface |
|---|---|---|
| `archetype-selection` | Which delivery archetype best fits? | `archetype_coherence` eval dimension |
| `flw-count` | How many FLWs? | PDD `FLW Requirements` numeric |
| `budget-plausibility` | Is the budget plausible for implied labor + AI infra? | `resource_realism` (PR #144) |
| `payment-rate` | Per-visit payment rate to FLW? | PDD `FLW Requirements` numeric |
| `pilot-sample-size` | Pilot sample size for AI calibration? | `verifiability` rubric |
| `ai-photo-threshold` | AI auto-accept confidence threshold? | `verifiability` rubric |
| `ai-fallback-design` | True validation harness or parallel sampling? | `fallback_validates_primary` (PR #144) |
| `named-downstream-consumer` | Pre-committed downstream consumer? | `demand_reality` (PR #144) |
| `primary-metric-vs-goal` | Direct goal vs upstream proxy? | `mission_alignment` (PR #144) |
| `working-language` | Working language(s)? | PDD `Learn App Specification` named entity |
| `verification-layers` | Which evidence-model layers in scope? | PDD `Evidence Model` section |
| `solicitation-type` | Solicitation type (EOI/RFP/custom)? | PDD `Solicitation` section default |
| `solicitation-deadline` | Solicitation deadline? | PDD `Solicitation` section default |
| `candidate-llo-roster` | Named candidates or public-only? | `LLO Preference` named entity |

Skill body MAY add extra rows beyond this set when source material
surfaces additional load-bearing defaults; SHOULD NOT skip any row in
the required set. If a row is genuinely irrelevant for an opp (rare),
emit it with `status: applied` and a `notes` line explaining why the
default is structural rather than a real choice.

### Schema and write semantics

Schema is defined in `lib/decisions-schema.ts` (`DecisionsLogSchema`).
Required fields per row: `id`, `phase` (always `1-design` for this skill),
`skill` (always `idea-to-pdd`), `question`, `default`, `options_considered`,
`source`, `status`. Optional `notes`.

`status` values:
- `applied` — default in use; the AI's best inference from source material.
- `overridden` — human edited via renderer + sync skills (PRs #2–#4); not produced directly by this skill.
- `open` — load-bearing, the AI proceeded with a default but flags for human attention. Surfaces as `[WARN]` in the gate brief's `Auto-Surfaced Concerns`.

Write via `drive_create_file` (find-or-update semantics) at
`ACE/<opp-name>/runs/<run-id>/decisions.yaml`. The Drive MCP's parent
folder is the run-folder file ID resolved at run start.

### Status: `open` policy

A row is marked `status: open` when a load-bearing default exists but the
AI judges it likely-wrong without human confirmation. Examples:

- `named-downstream-consumer` is `none-named-proceed-with-caveat` AND
  the opp will publish a public solicitation in Phase 7.
- `ai-fallback-design` is `parallel-sampling-N-percent` AND the program
  needs ground-truth per-decision accuracy.

The AI proceeds with the default in either mode; review-mode pauses for
edit, default-mode ships the gate brief with `[WARN]` entries.
```

- [ ] **Step 4: Update the `## Gate Brief` section.**

Find the existing `## Gate Brief` section's bullet `- **Open Questions Doc:**`:

```markdown
- **Open Questions Doc:** if the skill produced an Open Questions doc
  (see `## Open Questions Convention` below), include its full Drive
  URL on its own line at the top of the gate brief, prefixed
  `Open Questions: <url>`. If no Open Questions doc was needed, omit
  this line entirely.
```

Replace with:

```markdown
- **Decisions Log:** the skill always emits `decisions.yaml`. Include
  its full Drive URL on its own line at the top of the gate brief,
  prefixed `Decisions Log: <url>`. (The renderer skill landing in
  PR #2 will also produce a human-readable gdoc rendering at one stable
  URL per run; until that lands, link the YAML directly.)
```

Find the `Auto-Surfaced Concerns` bullet and append:

```markdown
- **Open-status decisions:** every row in `decisions.yaml` with
  `status: open` produces a `[WARN]` entry naming the row's `id` and
  one-line `notes`. Example: `[WARN] named-downstream-consumer — no
  consumer named in idea.md; flag for human edit before Phase 7.`
```

- [ ] **Step 5: Update `## Mode Behavior`.**

Find:

```markdown
## Mode Behavior
- **Auto:** Write PDD, email summary to admin group, proceed
- **Review:** Write PDD, present for human review, wait for approval
```

Replace with:

```markdown
## Mode Behavior

- **Default (auto):** Author `decisions.yaml` (step 3a), draft PDD using
  those defaults, write PDD + gate brief, email summary to admin group,
  proceed. The decisions.yaml ships with the run; humans review post-hoc
  and re-run via `/ace:step idea-to-pdd <opp>/<run-id>` after editing if
  they want a different PDD.
- **Review:** Author `decisions.yaml` (step 3a), then **pause** before
  drafting the PDD. Emit an interim gate brief stating "Decisions log
  written; edit any defaults you want changed, then resume." On resume,
  re-read `decisions.yaml` and draft the PDD using the (possibly edited)
  values. Continue to PDD-final gate brief as today.
```

- [ ] **Step 6: Update the change log.**

Find the `## Change Log` table and append:

```markdown
| 2026-05-08 | Replace `## Open Questions Convention` with `## Decisions Log Convention`. Skill always emits `decisions.yaml` with the 14-row calibrated Phase 1 set covering archetype, FLW count, budget plausibility, payment rate, pilot size, AI threshold, AI fallback design, named consumer, primary-metric-vs-goal, language, evidence layers, solicitation defaults, candidate roster. Schema defined in `lib/decisions-schema.ts`; ground-truth fixture in `test/skills/idea-to-pdd/fixtures/turmeric-decisions.yaml`. Renderer + round-trip ship in PRs #2–#4. | ACE team |
```

- [ ] **Step 7: Verify the file parses cleanly.**

Run: `cat skills/idea-to-pdd/SKILL.md | head -1`
Expected: `---` (frontmatter intact).

Run: `grep -c "^## " skills/idea-to-pdd/SKILL.md`
Expected: a positive integer matching the section count after edits (no orphan headings).

Sanity-grep for stale references:

Run: `grep -n "open-questions\|Open Questions" skills/idea-to-pdd/SKILL.md`
Expected: zero matches (or only matches inside the change-log line that *describes* the retirement).

- [ ] **Step 8: Commit.**

```bash
git add skills/idea-to-pdd/SKILL.md
git commit -m "skill(idea-to-pdd): emit decisions.yaml with 14-row Phase 1 calibration

Replaces the optional open-questions.md (rubric-gated) with always-on
decisions.yaml at ACE/<opp>/runs/<run-id>/decisions.yaml. Phase 1 row
set spans archetype, FLW count, budget, payment rate, pilot size, AI
threshold, AI fallback, named consumer, primary metric, language,
evidence layers, solicitation defaults, candidate roster.

Aligns to the four viability dimensions added in PR #144 plus the
existing archetype/structural dimensions. Schema in lib/decisions-schema.ts;
ground-truth fixture in test/skills/idea-to-pdd/fixtures/turmeric-decisions.yaml.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Update the Phase Write-Back Contract in `agents/ace-orchestrator.md`

**Files:**
- Modify: `agents/ace-orchestrator.md`

- [ ] **Step 1: Locate the contract section.**

Run: `grep -n "Phase Write-Back Contract" agents/ace-orchestrator.md`

Note the line number — it's the start of the section we'll append to.

- [ ] **Step 2: Add the decisions-log clause.**

Open `agents/ace-orchestrator.md` at the line above. The section already
codifies "Every phase MUST write `phases.<phase>.{status, verdict,
completed_at, summary_artifact, steps}` to `run_state.yaml` on
completion …".

After the existing contract paragraph, append this new paragraph:

```markdown
**Decisions log clause (added 2026-05-08).** Every phase MUST also
append rows to `ACE/<opp>/runs/<run-id>/decisions.yaml` for any
load-bearing default the phase applied that meets the bar criterion
(see [`docs/superpowers/specs/2026-05-08-decisions-log-design.md`](../docs/superpowers/specs/2026-05-08-decisions-log-design.md) §
Scope). Each phase's primary writing skill owns the rows it writes.
The orchestrator stub-fills + warns post-phase if a phase wrote zero
rows AND the calibration set for that phase has any required rows.
PR #1 covers Phase 1 (`idea-to-pdd`); Phase 2–9 writes ship in PR #3.
```

- [ ] **Step 3: Sanity-grep.**

Run: `grep -n "decisions.yaml\|decisions log" agents/ace-orchestrator.md`
Expected: at least 1 match in the contract section.

- [ ] **Step 4: Commit.**

```bash
git add agents/ace-orchestrator.md
git commit -m "agents: extend Phase Write-Back Contract with decisions.yaml clause

Every phase MUST append rows to decisions.yaml for load-bearing defaults
meeting the bar criterion. Stub-fill + warn at orchestrator if a phase
emitted zero rows when its calibration set requires at least one. PR #1
covers Phase 1; Phase 2-9 writes ship in PR #3.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Run the full test suite

- [ ] **Step 1: Run `npm test`.**

Run: `npm test`
Expected: PASS — full vitest suite green. Existing tests unaffected; 17 new assertions added (8 schema + 5 helpers + 4 fixture) bring total to ~655.

- [ ] **Step 2: If anything fails, fix it.**

Common failure modes:
- Type errors in `lib/decisions-schema.ts` if Zod version mismatches what's in `package.json`. Fix: `grep "\"zod\":" package.json` to find the version, ensure code matches.
- `js-yaml` not imported. Fix: confirm `import yaml from "js-yaml"` works (it's already a dependency for other helpers).
- Snapshot test failure in `decisions-fixture.test.ts` if the fixture YAML has a typo. Fix: re-run with `-t` to see the offending row.

Once green, no commit needed (no edits) — proceed.

---

### Task 7: Version bump and PR

- [ ] **Step 1: Run the worktree-safe version bump.**

Run: `bash scripts/version-bump.sh`
Expected: `VERSION`, `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` all bumped by `+1` patch from `max(local, origin/main)`. Output prints the new version.

- [ ] **Step 2: Commit the version bump.**

```bash
git add VERSION package.json .claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "chore: bump version for decisions-log PR #1

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 3: Push the branch.**

Run: `git push -u origin emdash/questions-70lfu`
Expected: pushes the branch with all 7 commits (5 feature + 1 contract + 1 version).

- [ ] **Step 4: Open the PR.**

```bash
gh pr create --title "decisions-log PR #1: schema + Phase 1 write-side" --body "$(cat <<'EOF'
## Summary

First of four PRs landing the decisions-log architecture from
[`docs/superpowers/specs/2026-05-08-decisions-log-design.md`](docs/superpowers/specs/2026-05-08-decisions-log-design.md).

## What ships

- **`lib/decisions-schema.ts`** — Zod schemas (`DecisionRowSchema`, `DecisionsLogSchema`), exported types (`DecisionRow`, `DecisionsLog`), YAML helpers (`parseDecisionsYaml`, `serializeDecisionsLog`). Mirrors `lib/qa-types.ts` conventions.
- **`skills/idea-to-pdd/SKILL.md`** — replaces `## Open Questions Convention` with `## Decisions Log Convention`; skill now always emits `decisions.yaml` with the 14-row calibrated Phase 1 set covering all four viability dimensions from PR #144 (`demand_reality`, `resource_realism`, `mission_alignment`, `fallback_validates_primary`) plus archetype, FLW count, payment rate, pilot size, AI threshold, language, evidence layers, solicitation defaults, candidate roster.
- **`test/skills/idea-to-pdd/fixtures/turmeric-decisions.yaml`** — calibrated ground-truth fixture.
- **`test/skills/idea-to-pdd/decisions-fixture.test.ts`** — snapshot tests (4 assertions).
- **`agents/ace-orchestrator.md`** — Phase Write-Back Contract gains a decisions-log clause.

## What does NOT ship

- Renderer (gdoc rendering) — PR #2.
- Phase 2–9 writes — PR #3.
- Round-trip sync skill — PR #4.

## Coordination with QA/Eval migration

This PR's schema lib follows `lib/qa-types.ts` conventions. The spec recommends landing this PR after `idea-to-pdd`'s QA/Eval migration (PR #147 Phase 1 PR #1) so the structural QA checks for `decisions.yaml` (file presence, schema validity, per-phase row coverage) can land natively in `idea-to-pdd-qa`. If that migration has shipped, see `docs/superpowers/specs/2026-05-08-decisions-log-design.md § Coordination` and add the QA checks as a follow-up commit on this PR. If not yet shipped, those checks land alongside the migration PR.

## Test plan

- [ ] CI green
- [ ] `npm test` passes locally (~655 tests)
- [ ] Manual verification: `/ace:step idea-to-pdd <opp>/<run-id>` against an existing turmeric-shaped fixture produces a `decisions.yaml` with the 14 calibrated row IDs
- [ ] After merge: `/ace:update` + `/reload-plugins` to pick up the new schema

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 5: Note the PR URL.**

The PR command prints the URL. Save it for follow-up: after CI passes, `gh pr merge <number> --merge` (subject to branch protection — `clean-install` status check is required).

After merge, immediately run `/ace:update` + `/reload-plugins` in the active session per CLAUDE.md's "Plugin updates — NEVER locally patch" rule.

---

## Self-review pass

**Spec coverage** — every spec section in the table at the top of this plan has a task. The four sub-projects from the spec map to four PRs; this plan covers PR #1 only and explicitly notes PR #2–#4 as out of scope.

**Placeholder scan** — searched for `TBD`, `TODO`, `implement later`, `Add appropriate error handling`, `Similar to Task N`. None present. Every code step has the literal code; every command has the exact invocation; every file path is exact.

**Type consistency** — `DecisionRow` / `DecisionsLog` are the canonical names; used the same way in `lib/decisions-schema.ts`, the test files, and the SKILL.md prose. `parseDecisionsYaml` / `serializeDecisionsLog` are referenced consistently. Status enum values (`applied | overridden | open`) match across the schema definition, the test fixtures, the SKILL.md convention section, and the PR description.

**Spec → plan alignment** — the plan defers the structural QA checks (`idea-to-pdd-qa`) to a conditional follow-up because the QA/Eval migration of `idea-to-pdd` is the gating dependency, exactly as the spec's `## Coordination` section calls out. The plan also defers the eval rubric re-anchor (`deferred-decision-discipline` branch pointing at `decisions.yaml`) to a separate post-v1 PR per the spec's `### Eval rubric impact` non-goal.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-08-decisions-log-pr1.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
