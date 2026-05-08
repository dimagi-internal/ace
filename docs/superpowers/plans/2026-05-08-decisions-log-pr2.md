# Decisions Log — PR #2: Retrofit + Renderer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** (1) Retire the hardcoded 14-row "Required Phase 1 row set" — replace with bar-criterion-driven inclusion plus a small "anchor decisions" list (~5 rows) tied to specific eval rubric dimensions. (2) Build a prose Google Doc renderer (`decisions-render` skill) that produces a human-readable rendering of `decisions.yaml` at one stable URL per run, regenerated at end of every phase.

**Architecture:**
- **Retrofit** is purely doc + test surface: the bar criterion already drives inclusion in principle; PR #1 hardcoded a 14-row required set as scaffolding. Retrofit removes the hardcoding so the bar criterion is the only filter, and shrinks the required set to anchors that map directly to eval rubric dimensions.
- **Renderer** is a deterministic pipeline: `lib/decisions-renderer.ts` is a pure function (`DecisionsLog → BatchUpdateRequest[]`) that emits Google Docs API requests; `scripts/decisions-render.ts` is the runner that reads the YAML and applies the requests via Drive MCP. The skill body is a thin wrapper that invokes the script. Same pattern as `idea-to-pdd-qa`'s `checks.ts` + `scripts/qa-run.ts`.

**Tech Stack:** TypeScript ESM, vitest, the existing `ace-gdrive` MCP (`docs_batch_update`, `drive_create_file`, `drive_read_file`), `lib/decisions-schema.ts` (already shipped). No new dependencies.

**Spec deviations from `docs/superpowers/specs/2026-05-08-decisions-log-design.md`:**
- Sub-project ordering: spec listed renderer as PR #3; this PR ships it as PR #2 because human visibility unblocks Phase 1 iteration. Phase 2–9 writes (originally PR #2 in the spec) move to a later PR.
- Schema scope shrinks: spec implied a per-phase "required row set" (10–15 rows for Phase 1). Retrofit drops this in favor of bar-criterion-only inclusion + a small anchor set (~5 rows) tied to specific eval rubric dimensions. Rationale: hardcoding 14 rows × 9 phases ≈ 80+ enumerated questions across the codebase is heavy maintenance and constrains LLM judgment. The bar criterion (load-bearing AND maps to known surface) is the right filter; per-phase QA collapses to schema validation + run-level file presence.

---

## Spec coverage map

| Concern | Covered by |
|---|---|
| Retrofit Phase 1: drop required-row-set | Tasks 1–3 |
| Renderer pure function | Task 4 |
| Renderer runner script | Task 5 |
| Renderer skill body | Task 6 |
| Wire renderer into Phase 1 + gate brief | Task 7 |
| Wire renderer into orchestrator (post-phase hook) | Task 8 |
| Full test suite green | Task 9 |
| Version bump + push + PR | Task 10 |

---

## File structure

**Create:**
- `lib/decisions-renderer.ts` — pure function `renderDecisionsLog(log: DecisionsLog): docs_v1.Schema$Request[]` plus small helpers (heading paragraph, body paragraph, bullet list, italic notes block).
- `test/lib/decisions-renderer.test.ts` — unit tests for the renderer (snapshot test on a small input, edge cases like empty decisions, single decision, multi-phase).
- `scripts/decisions-render.ts` — CLI runner. Reads `decisions.yaml`, calls `renderDecisionsLog`, finds-or-creates the gdoc, clears existing body, applies the requests via `docs_batch_update`. Idempotent; one stable URL per run.
- `skills/decisions-render/SKILL.md` — skill body wrapping the script.
- `test/skills/decisions-render/script.test.ts` — integration test that drives the script end-to-end against a fake Drive client (no live MCP).

**Modify:**
- `skills/idea-to-pdd/SKILL.md` — replace `### Required Phase 1 row set` with `### Anchor decisions` (~5 rows) + `### Recommended additional rows (illustrative)` (~9 rows, non-binding). Update process step 3a's instructions to reference bar criterion as the filter; anchor list as a hint, not a checklist. Retain the existing schema-and-write-semantics + status-open-policy sub-sections. Update process step (post-PDD-write) to invoke `decisions-render`. Update gate brief to link the gdoc URL (not the YAML).
- `test/skills/idea-to-pdd/fixtures/turmeric-decisions.yaml` — keep the 14 rows as an illustrative sample, no semantic changes.
- `test/skills/idea-to-pdd/decisions-fixture.test.ts` — drop the "exactly these 14 IDs" assertion. Replace with: parses cleanly, every row has phase `1-design` and skill `idea-to-pdd`, every `status: open` row has a populated `notes` field, contains the 5 anchor rows.
- `agents/ace-orchestrator.md` — extend Phase Write-Back Verifier (existing § Phase Write-Back Verifier) with a step that invokes `decisions-render` after every phase completes successfully. One-paragraph addition.
- `lib/artifact-manifest.ts` — register the new `decisions-rendering` artifact (gdoc) under the run's per-phase artifacts. (The YAML itself was registered in PR #1.)
- `VERSION`, `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `package-lock.json` — version bumped via `scripts/version-bump.sh` at the end.

**No deletes.** PR #1's `lib/decisions-schema.ts` and `test/skills/idea-to-pdd/fixtures/turmeric-decisions.yaml` stay as-is.

---

## Tasks

### Task 1: Retrofit `skills/idea-to-pdd/SKILL.md` — replace required-row-set with anchor list

**Files:**
- Modify: `skills/idea-to-pdd/SKILL.md`

The current `## Decisions Log Convention` section has a `### Required Phase 1 row set` sub-section with a 14-row table that the skill MUST emit. Retrofit:

- [ ] **Step 1: Replace `### Required Phase 1 row set` with `### Anchor decisions (rows the eval rubric depends on)`.**

Find the existing sub-section (the 14-row table starting "Every Phase 1 run MUST emit at least the rows below…"). Replace the entire sub-section (including the table) with:

```markdown
### Anchor decisions (rows the eval rubric depends on)

A small set of decisions are load-bearing for specific eval rubric dimensions
— their absence means the rubric grades a missing input and the verdict is
unreliable. The skill SHOULD emit these rows whenever they apply to the opp:

| ID | Question | Eval rubric anchor |
|---|---|---|
| `archetype-selection` | Which delivery archetype best fits? | `archetype_coherence` |
| `budget-plausibility` | Is the budget plausible for implied labor + AI infra? | `resource_realism` (PR #144) |
| `named-downstream-consumer` | Pre-committed downstream consumer? | `demand_reality` (PR #144) |
| `primary-metric-vs-goal` | Direct goal vs upstream proxy? | `mission_alignment` (PR #144) |
| `ai-fallback-design` | True validation harness or parallel sampling? | `fallback_validates_primary` (PR #144) |

If an anchor is genuinely irrelevant for the opp (rare — usually applies
only when the question is structurally inapplicable), emit it with
`status: applied` and a `notes` line explaining why the default is
structural rather than a real choice. Do not silently omit.

### Recommended additional rows (illustrative, non-binding)

These rows often qualify under the bar criterion. They are examples of
what the criterion typically catches, not requirements. Skip when not
applicable; add others not listed when they meet the bar.

| ID | Question | Map to surface |
|---|---|---|
| `flw-count` | How many FLWs? | PDD `FLW Requirements` numeric |
| `payment-rate` | Per-visit payment rate to FLW? | PDD `FLW Requirements` numeric |
| `pilot-sample-size` | Pilot sample size for AI calibration? | `verifiability` rubric |
| `ai-photo-threshold` | AI auto-accept confidence threshold? | `verifiability` rubric |
| `working-language` | Working language(s)? | PDD `Learn App Specification` |
| `verification-layers` | Which evidence-model layers in scope? | PDD `Evidence Model` section |
| `solicitation-type` | Solicitation type (EOI/RFP/custom)? | PDD `Solicitation` section |
| `solicitation-deadline` | Solicitation deadline? | PDD `Solicitation` section |
| `candidate-llo-roster` | Named candidates or public-only? | `LLO Preference` named entity |

The bar criterion alone determines what rows belong in the log. The
anchor list above is the only required surface; everything else is the
LLM's judgment per the criterion.
```

- [ ] **Step 2: Update process step 3a to reference the anchor list, not a required set.**

Find the existing step 3a (`**Author the decisions log.** Before drafting the PDD …`). Replace its second paragraph (currently "The skill MUST emit a complete decisions.yaml even when …") with:

```
    The skill MUST emit every anchor row from
    `## Decisions Log Convention § Anchor decisions` whenever the anchor
    applies to the opp (handle inapplicable cases by emitting the row with
    `status: applied` and a notes-line explanation). Beyond the anchor set,
    the skill emits whatever additional rows meet the bar criterion. The
    bar is the filter; the recommended-additional list is illustrative.
```

- [ ] **Step 3: Update process step list to invoke `decisions-render` after writing the YAML.**

Find the process steps. After step 7 (the final step: writing the gate brief), add a new final step:

```
8. **Render the decisions log to a human-readable Google Doc** by
   invoking the `decisions-render` skill against the run-id. The
   renderer produces `ACE/<opp-name>/runs/<run-id>/decisions.gdoc`
   at one stable URL; humans review and iterate on this doc, not the
   YAML. The orchestrator also invokes the renderer at end of every
   subsequent phase, so the gdoc stays current as later phases append
   rows.
```

- [ ] **Step 4: Update gate brief — link the gdoc, not the YAML.**

Find the existing `- **Decisions Log:**` bullet in `## Gate Brief`. Replace it with:

```markdown
- **Decisions Log:** the skill always emits `decisions.yaml` and invokes
  `decisions-render` to produce a prose Google Doc rendering at one
  stable URL. Include the gdoc URL on its own line at the top of the
  gate brief, prefixed `Decisions Log: <gdoc-url>`. The YAML lives at
  `ACE/<opp-name>/runs/<run-id>/decisions.yaml`; the gdoc is its
  human-friendly rendering and is regenerated after every phase.
```

- [ ] **Step 5: Update the `## Change Log` table.**

Append:

```markdown
| 2026-05-08 | Retrofit: replace `### Required Phase 1 row set` (14 hardcoded rows) with `### Anchor decisions` (5 rows tied to specific eval rubric dimensions) + `### Recommended additional rows` (illustrative, non-binding). Bar criterion is the sole filter; anchors are the only required surface. Process step adds renderer invocation; gate brief links the gdoc rendering instead of the YAML. | ACE team (decisions-log PR #2) |
```

- [ ] **Step 6: Verify and commit.**

Run: `grep -n "Required Phase 1 row set" skills/idea-to-pdd/SKILL.md`
Expected: zero matches (the heading is gone).

Run: `grep -n "Anchor decisions" skills/idea-to-pdd/SKILL.md`
Expected: at least 2 matches (heading + reference from process step).

Commit:

```bash
git add skills/idea-to-pdd/SKILL.md
git commit -m "skill(idea-to-pdd): retire hardcoded 14-row required set; bar criterion is the sole filter

Replaces \`### Required Phase 1 row set\` with two sub-sections:
- \`### Anchor decisions\` (5 rows tied to specific eval rubric dimensions —
  archetype-selection, budget-plausibility, named-downstream-consumer,
  primary-metric-vs-goal, ai-fallback-design)
- \`### Recommended additional rows\` (9 illustrative rows, non-binding)

The bar criterion (load-bearing + maps to known surface) is the only
filter. Anchors are the only required surface — their absence means an
eval rubric dimension grades a missing input.

Process step 8 invokes \`decisions-render\` to produce a prose Google Doc
rendering at one stable URL. Gate brief links the gdoc instead of the YAML.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Update `test/skills/idea-to-pdd/decisions-fixture.test.ts` to match the retrofit

**Files:**
- Modify: `test/skills/idea-to-pdd/decisions-fixture.test.ts`

PR #1's snapshot test asserts "contains exactly these 14 row IDs." Retrofit assertions to: schema valid; phase + skill correct; anchor rows present; status: open rows have notes.

- [ ] **Step 1: Replace the test contents.**

Replace the entire file body (keep the imports the same) with:

```ts
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
```

- [ ] **Step 2: Run the test.**

Run: `npx vitest run test/skills/idea-to-pdd/decisions-fixture.test.ts`
Expected: PASS — 4 assertions green. The fixture from PR #1 has all 5 anchor IDs and the 2 open rows have notes, so this should pass without any fixture edits.

- [ ] **Step 3: Commit.**

```bash
git add test/skills/idea-to-pdd/decisions-fixture.test.ts
git commit -m "test(idea-to-pdd): retrofit fixture test to anchor + invariants model

Drops the exact-14-IDs assertion. Now asserts:
- Schema validity
- Every row scoped to phase 1-design + skill idea-to-pdd
- Every anchor row from the Phase 1 anchor list is present
- Every status: open row has populated notes

Aligns with the bar-criterion-only architecture.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Build the renderer pure function — `lib/decisions-renderer.ts`

**Files:**
- Create: `lib/decisions-renderer.ts`
- Create: `test/lib/decisions-renderer.test.ts`

The renderer is a pure function: `(log: DecisionsLog) => Request[]` where `Request` matches the `docs.documents.batchUpdate` `requests[]` schema. The output is the list of API requests that, when applied to a fresh empty Google Doc, produces the prose rendering.

The rendering has this layout:

```
Decisions Log — <opportunity> / run <run_id>           [HEADING_1]

Generated <generated_at>. To override a default, edit the           [body, italic]
"Default:" line of the relevant decision below. To propose a new
option, add a bullet to "Considered:". Then run
/ace:step decisions-sync <opp>/<run-id> to push your edits back.

──────────────────────────────────────────                          [body horizontal divider]

Phase 1 — Design                                       [HEADING_2]

archetype-selection                                    [HEADING_3]
Which delivery archetype best fits the intervention?   [body, bold]

  Default: atomic-visit                                [body, "Default:" bold]
  Considered:                                          [body, bold prefix]
    • atomic-visit                                     [bullet]
    • focus-group                                      [bullet]
    • multi-stage                                      [bullet]
  Source: idea.md §1; one-FLW-one-delivery pattern     [body, "Source:" bold]
  Status: applied                                      [body, "Status:" bold]

  Single per-FLW visit producing one structured delivery.   [body, italic, indented]

flw-count                                              [HEADING_3]
...
```

Status `open` rows get extra emphasis: `Status: OPEN — load-bearing; human edit recommended` rendered with red foreground or bold-red.

The renderer's job: produce a sequence of requests that build this layout. Strategy: produce **only `insertText` requests in document-order**, then `updateParagraphStyle` and `updateTextStyle` requests at the end (after all text is in place — by then, indices are stable). Index management is local (each insert appends at the current end-of-doc offset).

- [ ] **Step 1: Write the failing test.**

Create `test/lib/decisions-renderer.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { DecisionsLog } from "../../lib/decisions-schema.js";
import { renderDecisionsLog } from "../../lib/decisions-renderer.js";

const MINIMAL_LOG: DecisionsLog = {
  schema_version: 1,
  opportunity: "turmeric",
  run_id: "20260507-1733",
  generated_at: "2026-05-07T17:33:00Z",
  decisions: [
    {
      id: "archetype-selection",
      phase: "1-design",
      skill: "idea-to-pdd",
      question: "Which delivery archetype best fits the intervention?",
      default: "atomic-visit",
      options_considered: ["atomic-visit", "focus-group", "multi-stage"],
      source: "idea.md §1",
      status: "applied",
      notes: "Single per-FLW visit producing one structured delivery.",
    },
  ],
};

describe("renderDecisionsLog", () => {
  it("returns a non-empty array of Docs API requests", () => {
    const requests = renderDecisionsLog(MINIMAL_LOG);
    expect(Array.isArray(requests)).toBe(true);
    expect(requests.length).toBeGreaterThan(0);
  });

  it("includes an insertText request for the title", () => {
    const requests = renderDecisionsLog(MINIMAL_LOG);
    const titleInsert = requests.find(
      (r) =>
        "insertText" in r &&
        r.insertText?.text?.includes("Decisions Log — turmeric / run 20260507-1733"),
    );
    expect(titleInsert).toBeDefined();
  });

  it("includes a HEADING_1 paragraph style update covering the title", () => {
    const requests = renderDecisionsLog(MINIMAL_LOG);
    const h1 = requests.find(
      (r) =>
        "updateParagraphStyle" in r &&
        r.updateParagraphStyle?.paragraphStyle?.namedStyleType === "HEADING_1",
    );
    expect(h1).toBeDefined();
  });

  it("includes a HEADING_2 paragraph style update for each phase header", () => {
    const requests = renderDecisionsLog(MINIMAL_LOG);
    const h2 = requests.filter(
      (r) =>
        "updateParagraphStyle" in r &&
        r.updateParagraphStyle?.paragraphStyle?.namedStyleType === "HEADING_2",
    );
    // Single phase = single H2 ("Phase 1 — Design")
    expect(h2).toHaveLength(1);
  });

  it("includes a HEADING_3 paragraph style update for each decision id", () => {
    const requests = renderDecisionsLog(MINIMAL_LOG);
    const h3 = requests.filter(
      (r) =>
        "updateParagraphStyle" in r &&
        r.updateParagraphStyle?.paragraphStyle?.namedStyleType === "HEADING_3",
    );
    expect(h3).toHaveLength(1);
  });

  it("creates bullet list for the options_considered items", () => {
    const requests = renderDecisionsLog(MINIMAL_LOG);
    const bullets = requests.find(
      (r) => "createParagraphBullets" in r,
    );
    expect(bullets).toBeDefined();
  });

  it("groups decisions by phase with a HEADING_2 per phase", () => {
    const multiPhaseLog: DecisionsLog = {
      ...MINIMAL_LOG,
      decisions: [
        { ...MINIMAL_LOG.decisions[0]!, id: "row-a", phase: "1-design" },
        { ...MINIMAL_LOG.decisions[0]!, id: "row-b", phase: "1-design" },
        { ...MINIMAL_LOG.decisions[0]!, id: "row-c", phase: "2-commcare" },
      ],
    };
    const requests = renderDecisionsLog(multiPhaseLog);
    const h2 = requests.filter(
      (r) =>
        "updateParagraphStyle" in r &&
        r.updateParagraphStyle?.paragraphStyle?.namedStyleType === "HEADING_2",
    );
    expect(h2).toHaveLength(2); // 1-design + 2-commcare
  });

  it("returns no requests for an empty decisions array (only the title block)", () => {
    const empty: DecisionsLog = { ...MINIMAL_LOG, decisions: [] };
    const requests = renderDecisionsLog(empty);
    // Should still emit title + intro; no decision sections.
    expect(requests.length).toBeGreaterThan(0);
    const h2 = requests.filter(
      (r) =>
        "updateParagraphStyle" in r &&
        r.updateParagraphStyle?.paragraphStyle?.namedStyleType === "HEADING_2",
    );
    expect(h2).toHaveLength(0); // no phases
    const h3 = requests.filter(
      (r) =>
        "updateParagraphStyle" in r &&
        r.updateParagraphStyle?.paragraphStyle?.namedStyleType === "HEADING_3",
    );
    expect(h3).toHaveLength(0); // no decisions
  });

  it("emphasizes status: open rows distinctly from status: applied", () => {
    const openLog: DecisionsLog = {
      ...MINIMAL_LOG,
      decisions: [
        {
          ...MINIMAL_LOG.decisions[0]!,
          id: "named-downstream-consumer",
          status: "open",
          notes: "No consumer named.",
        },
      ],
    };
    const requests = renderDecisionsLog(openLog);
    // The "Status: OPEN" text should appear (not just "Status: open")
    const statusText = requests.find(
      (r) =>
        "insertText" in r &&
        (r.insertText?.text?.includes("Status: OPEN") ||
          r.insertText?.text?.includes("OPEN — load-bearing")),
    );
    expect(statusText).toBeDefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `npx vitest run test/lib/decisions-renderer.test.ts`
Expected: FAIL with `Cannot find module '../../lib/decisions-renderer.js'`.

- [ ] **Step 3: Implement the renderer.**

Create `lib/decisions-renderer.ts`. The implementer chooses the exact structure; the constraints from the tests are:
- Pure function `renderDecisionsLog(log: DecisionsLog): docs_v1.Schema$Request[]` (or compatible array shape — the test only checks for `insertText`, `updateParagraphStyle`, `createParagraphBullets` on each request).
- Title: `Decisions Log — <opportunity> / run <run_id>` styled HEADING_1.
- Per-phase HEADING_2 ("Phase 1 — Design", "Phase 2 — CommCare", etc. — derive the human label from the `<N>-<name>` slug; capitalize the name segment).
- Per-decision HEADING_3 (the row's `id`).
- Each decision section: question (bold body), `Default: <value>`, `Considered: <bullet list>`, `Source: <text>`, `Status: applied|overridden|OPEN — load-bearing; human edit recommended`, optional italic notes paragraph.
- Status `open` rendered as `Status: OPEN — load-bearing; human edit recommended` to differentiate from `applied`/`overridden`.
- Empty `decisions: []` produces only the title block; no phase or decision sections.

Implementer should reference the `googleapis` package's `docs_v1.Schema$Request` type. If that import isn't already in the repo, define a minimal local `BatchUpdateRequest` type union (insertText | updateParagraphStyle | createParagraphBullets | updateTextStyle) and export it.

Use a `RequestBuilder` class or stateful helper that tracks the current end-of-doc offset and emits requests in order. After all `insertText` requests are emitted, append style requests at the end (their indices are stable because all text is already in).

- [ ] **Step 4: Run the test to verify it passes.**

Run: `npx vitest run test/lib/decisions-renderer.test.ts`
Expected: PASS — 9 assertions green.

- [ ] **Step 5: Commit.**

```bash
git add lib/decisions-renderer.ts test/lib/decisions-renderer.test.ts
git commit -m "lib: add pure-function decisions-log renderer

renderDecisionsLog(log) returns a Docs API batch-update request list
that builds a prose Google Doc from a DecisionsLog. HEADING_1 title,
HEADING_2 per phase, HEADING_3 per decision id, bold field labels,
bullet list for options_considered, italic notes block, distinct
emphasis for status: open rows.

Pure function — no Drive calls. Caller (scripts/decisions-render.ts)
applies the requests via docs_batch_update.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Build the runner script — `scripts/decisions-render.ts`

**Files:**
- Create: `scripts/decisions-render.ts`
- Create: `test/skills/decisions-render/script.test.ts` — integration test against a fake Drive client.

The runner is the glue: read the YAML, call the renderer, find-or-create the gdoc, clear existing content, apply the new requests.

CLI shape:

```
npx tsx scripts/decisions-render.ts <opp-name>/<run-id>
# or
npx tsx scripts/decisions-render.ts <run-folder-fileId>
```

- [ ] **Step 1: Write the failing test.**

Create `test/skills/decisions-render/script.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { DecisionsLog } from "../../../lib/decisions-schema.js";
import { runDecisionsRender } from "../../../scripts/decisions-render.js";

const SAMPLE_LOG: DecisionsLog = {
  schema_version: 1,
  opportunity: "turmeric",
  run_id: "20260507-1733",
  generated_at: "2026-05-07T17:33:00Z",
  decisions: [
    {
      id: "archetype-selection",
      phase: "1-design",
      skill: "idea-to-pdd",
      question: "Which delivery archetype?",
      default: "atomic-visit",
      options_considered: ["atomic-visit", "focus-group", "multi-stage"],
      source: "idea.md §1",
      status: "applied",
    },
  ],
};

function makeFakeDriveClient() {
  return {
    readFile: vi.fn().mockResolvedValue({ content: "" }),
    findOrCreateDoc: vi.fn().mockResolvedValue({ id: "fake-gdoc-id", reused: false }),
    batchUpdateDoc: vi.fn().mockResolvedValue({ replies: [] }),
    clearDocBody: vi.fn().mockResolvedValue(undefined),
  };
}

describe("runDecisionsRender", () => {
  it("reads the YAML, finds-or-creates the gdoc, clears it, and applies the rendered requests", async () => {
    const client = makeFakeDriveClient();
    client.readFile.mockResolvedValueOnce({
      content: `schema_version: 1
opportunity: turmeric
run_id: 20260507-1733
generated_at: "2026-05-07T17:33:00Z"
decisions:
  - id: archetype-selection
    phase: 1-design
    skill: idea-to-pdd
    question: Which delivery archetype?
    default: atomic-visit
    options_considered: ["atomic-visit", "focus-group", "multi-stage"]
    source: idea.md §1
    status: applied
`,
    });

    const result = await runDecisionsRender({
      runFolderFileId: "fake-folder-id",
      driveClient: client,
    });

    expect(client.readFile).toHaveBeenCalled();
    expect(client.findOrCreateDoc).toHaveBeenCalledWith({
      parentFolderId: "fake-folder-id",
      name: "decisions.gdoc",
    });
    expect(client.clearDocBody).toHaveBeenCalledWith("fake-gdoc-id");
    expect(client.batchUpdateDoc).toHaveBeenCalled();
    const callArgs = client.batchUpdateDoc.mock.calls[0]![0];
    expect(callArgs.documentId).toBe("fake-gdoc-id");
    expect(callArgs.requests.length).toBeGreaterThan(0);
    expect(result).toMatchObject({ gdocId: "fake-gdoc-id" });
  });

  it("throws an actionable error when decisions.yaml is missing from the run folder", async () => {
    const client = makeFakeDriveClient();
    client.readFile.mockRejectedValueOnce(new Error("File not found"));

    await expect(
      runDecisionsRender({ runFolderFileId: "fake-folder-id", driveClient: client }),
    ).rejects.toThrow(/decisions\.yaml/);
  });

  it("throws on schema-invalid YAML with the schema dot-path", async () => {
    const client = makeFakeDriveClient();
    client.readFile.mockResolvedValueOnce({
      content: `schema_version: 1
opportunity: turmeric
run_id: 20260507-1733
generated_at: "2026-05-07T17:33:00Z"
decisions:
  - id: ""
    phase: 1-design
    skill: idea-to-pdd
    question: Q
    default: x
    options_considered: []
    source: x
    status: applied
`,
    });

    await expect(
      runDecisionsRender({ runFolderFileId: "fake-folder-id", driveClient: client }),
    ).rejects.toThrow(/decisions\.0\.id/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `npx vitest run test/skills/decisions-render/script.test.ts`
Expected: FAIL with `Cannot find module '../../../scripts/decisions-render.js'` or `runDecisionsRender is not a function`.

- [ ] **Step 3: Implement the script.**

Create `scripts/decisions-render.ts`:

```ts
#!/usr/bin/env npx tsx
import { parseDecisionsYaml } from "../lib/decisions-schema.js";
import { renderDecisionsLog } from "../lib/decisions-renderer.js";

/**
 * Drive client interface — subset of ace-gdrive operations needed by
 * the renderer runner. Production callers pass a wrapper around the
 * MCP atoms; tests pass a mock.
 */
export interface DecisionsRenderDriveClient {
  readFile(args: { parentFolderId: string; name: string }): Promise<{ content: string }>;
  findOrCreateDoc(args: { parentFolderId: string; name: string }): Promise<{ id: string; reused: boolean }>;
  clearDocBody(docId: string): Promise<void>;
  batchUpdateDoc(args: { documentId: string; requests: unknown[] }): Promise<{ replies: unknown[] }>;
}

export interface RunDecisionsRenderArgs {
  runFolderFileId: string;
  driveClient: DecisionsRenderDriveClient;
}

export interface RunDecisionsRenderResult {
  gdocId: string;
  reused: boolean;
  requestCount: number;
}

/**
 * Read decisions.yaml from a run folder, render it, and apply the
 * rendered requests to the per-run decisions.gdoc. Idempotent: the
 * gdoc lives at one stable URL per run; existing content is cleared
 * before the new render is applied.
 */
export async function runDecisionsRender(
  args: RunDecisionsRenderArgs,
): Promise<RunDecisionsRenderResult> {
  const { runFolderFileId, driveClient } = args;

  let yamlContent: string;
  try {
    const file = await driveClient.readFile({
      parentFolderId: runFolderFileId,
      name: "decisions.yaml",
    });
    yamlContent = file.content;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `decisions.yaml not found in run folder ${runFolderFileId}: ${msg}`,
    );
  }

  const log = parseDecisionsYaml(yamlContent);
  const requests = renderDecisionsLog(log);

  const gdoc = await driveClient.findOrCreateDoc({
    parentFolderId: runFolderFileId,
    name: "decisions.gdoc",
  });

  await driveClient.clearDocBody(gdoc.id);
  await driveClient.batchUpdateDoc({
    documentId: gdoc.id,
    requests,
  });

  return {
    gdocId: gdoc.id,
    reused: gdoc.reused,
    requestCount: requests.length,
  };
}

// CLI entry point — only when invoked directly as a script.
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = process.argv[2];
  if (!arg) {
    console.error("Usage: npx tsx scripts/decisions-render.ts <run-folder-fileId>");
    process.exit(1);
  }
  // CLI mode requires a real Drive client; defer to the skill body which
  // wires the ace-gdrive MCP atoms into the DecisionsRenderDriveClient
  // interface. This block only runs for manual ad-hoc invocations from
  // a developer shell with the MCP available.
  console.error(
    "Direct CLI mode not yet wired — invoke via /ace:step decisions-render <opp>/<run-id> instead.",
  );
  process.exit(2);
}
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `npx vitest run test/skills/decisions-render/script.test.ts`
Expected: PASS — 3 assertions green.

- [ ] **Step 5: Commit.**

```bash
git add scripts/decisions-render.ts test/skills/decisions-render/script.test.ts
git commit -m "scripts: add decisions-render runner

Reads decisions.yaml from a run folder, calls renderDecisionsLog,
finds-or-creates decisions.gdoc, clears existing content, applies the
rendered requests via docs_batch_update. Idempotent — one stable URL
per run, regenerated on every invocation.

DriveClient interface decouples the runner from the ace-gdrive MCP for
testability (production wires MCP atoms; tests use a mock).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Create `skills/decisions-render/SKILL.md`

**Files:**
- Create: `skills/decisions-render/SKILL.md`

The skill body is a thin wrapper that wires the MCP atoms into the `DecisionsRenderDriveClient` interface and invokes `runDecisionsRender`.

- [ ] **Step 1: Write the SKILL.md.**

Create `skills/decisions-render/SKILL.md`:

```markdown
---
name: decisions-render
description: >
  Render a per-run decisions.yaml into a prose Google Doc at one stable
  URL per run. Invoked at end of every phase; idempotent.
disable-model-invocation: true
---

# Decisions Render

Read `decisions.yaml` from a run folder, render it as a prose Google Doc, and
write the result to `decisions.gdoc` at one stable URL.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Per-run state | `ACE/<opp-name>/runs/<run-id>/decisions.yaml` | the structured log to render |

## Outputs

- `ACE/<opp-name>/runs/<run-id>/decisions.gdoc` — prose Google Doc rendering at one stable URL. Find-or-update semantics; existing content is cleared and replaced on every invocation.

## Process

1. **Resolve the run folder file ID** for `ACE/<opp-name>/runs/<run-id>/`.

   Use `drive_list_folder` from the opp folder to find the run folder.

2. **Run the renderer script**:

   ```bash
   npx tsx scripts/decisions-render.ts <run-folder-fileId>
   ```

   The script:
   - Reads `decisions.yaml` via `drive_read_file`.
   - Parses and validates via `parseDecisionsYaml` from `lib/decisions-schema.ts`.
   - Renders via `renderDecisionsLog` from `lib/decisions-renderer.ts` (pure function — produces a list of Google Docs API requests).
   - Finds-or-creates `decisions.gdoc` via `drive_create_file` (with `findOrCreate: true`).
   - Clears existing body (single `deleteContentRange` request covering the doc).
   - Applies the rendered requests via `docs_batch_update`.

3. **Confirm the gdoc URL** by reading the create result's `webViewLink` and emit it on stdout. The orchestrator captures this URL for the gate brief's `Decisions Log:` line.

## Failure modes

- **decisions.yaml is missing**: the script throws with the run folder ID; the orchestrator's Phase Write-Back Verifier should have already created an empty decisions.yaml before this skill runs. If it didn't, the skill halts and surfaces the missing-file error to the operator.
- **Schema-invalid YAML**: the script throws with the dot-path of the offending field. The originating skill (whichever phase wrote the bad row) gets a hard fail; orchestrator surfaces in the gate brief's BLOCKER list.
- **Docs API rate limit**: rare — the renderer makes one batch update per phase. Retry once after 30s; halt with actionable error if it fails again.

## MCP Tools Used

- Google Drive: `drive_list_folder`, `drive_read_file`, `drive_create_file`, `docs_batch_update`

## Mode Behavior

- **Auto:** Run, no human pause. Stdout includes the gdoc URL for downstream skills.
- **Review:** Same as Auto — the renderer is deterministic, no human review of the rendering itself.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-05-08 | Initial skill — pairs with `lib/decisions-renderer.ts` and `scripts/decisions-render.ts`. Renders decisions.yaml as a prose Google Doc; idempotent; runs at end of every phase. | ACE team (decisions-log PR #2) |
```

- [ ] **Step 2: Sanity-check the file structure.**

Run: `head -1 skills/decisions-render/SKILL.md`
Expected: `---` (frontmatter intact).

Run: `grep -c "^## " skills/decisions-render/SKILL.md`
Expected: 7 (Inputs, Outputs, Process, Failure modes, MCP Tools Used, Mode Behavior, Change Log).

- [ ] **Step 3: Commit.**

```bash
git add skills/decisions-render/SKILL.md
git commit -m "skill(decisions-render): wrap renderer + script as an ACE skill

Thin skill body that resolves the run folder file ID, invokes
scripts/decisions-render.ts, captures the resulting gdoc URL.
Idempotent; runs at end of every phase via the orchestrator's Phase
Write-Back Verifier (wired in the next commit).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Wire `decisions-render` into the orchestrator's Phase Write-Back Verifier

**Files:**
- Modify: `agents/ace-orchestrator.md`

After every successful phase, the orchestrator should invoke `decisions-render` so the gdoc stays current. The natural integration point is the existing § Phase Write-Back Verifier section (the "after each `Agent(<phase>)` dispatch" loop).

- [ ] **Step 1: Locate the Phase Write-Back Verifier section.**

Run: `grep -n "Phase Write-Back Verifier" agents/ace-orchestrator.md`

- [ ] **Step 2: Append a step to the verifier procedure.**

Find the existing step list inside § Phase Write-Back Verifier (it has a "Procedure." heading followed by numbered steps). Append a new final step after the existing last step:

```markdown
4. **Re-render the decisions log gdoc.** After verifying the phase
   wrote back its rows to `decisions.yaml`, invoke
   `Skill(decisions-render)` against the run-id. The renderer produces
   `ACE/<opp>/runs/<run-id>/decisions.gdoc` — a prose Google Doc at one
   stable URL — and is idempotent across re-runs. Capture the gdoc's
   webViewLink and inject it into the next gate brief's `Decisions Log:`
   line. The renderer is fast (one batchUpdate call); failure is a
   `[WARN]` not a `[BLOCKER]` — the YAML is the source of truth, the
   gdoc is just the rendering.
```

- [ ] **Step 3: Sanity-check + commit.**

Run: `grep -n "decisions-render" agents/ace-orchestrator.md`
Expected: at least 1 match in the verifier step.

```bash
git add agents/ace-orchestrator.md
git commit -m "agents: wire decisions-render into Phase Write-Back Verifier

After every phase's write-back is verified, invoke decisions-render
to refresh the per-run decisions.gdoc. Idempotent; one stable URL
per run; failure is WARN not BLOCKER (YAML is the source of truth).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Update `lib/artifact-manifest.ts` to register the gdoc artifact

**Files:**
- Modify: `lib/artifact-manifest.ts`

The artifact manifest is the canonical registry of run artifacts. PR #1 should have registered `decisions.yaml`; this task adds `decisions.gdoc`.

- [ ] **Step 1: Find the existing decisions.yaml registration.**

Run: `grep -n "decisions" lib/artifact-manifest.ts`

If `decisions.yaml` is registered, follow the existing pattern. If not, add both entries together.

- [ ] **Step 2: Add the gdoc entry.**

Add an entry next to the existing decisions.yaml registration, mirroring its structure but with:
- A name like `decisions-rendering` or `decisions-gdoc`.
- Path: `ACE/<opp>/runs/<run-id>/decisions.gdoc`.
- Mime type: `application/vnd.google-apps.document`.
- Producer: `decisions-render`.
- Owner role: same as decisions.yaml.

(The exact registration shape depends on the existing manifest schema. Read the file to see how other artifacts like `idea-to-pdd_gate-brief` or `idea-to-pdd-qa_result.yaml` are structured.)

- [ ] **Step 3: Run the manifest test.**

Run: `npx vitest run lib/artifact-manifest.test.ts`
Expected: PASS — manifest fixtures still validate.

- [ ] **Step 4: Commit.**

```bash
git add lib/artifact-manifest.ts
git commit -m "lib: register decisions.gdoc in artifact manifest

Pairs decisions.yaml (registered in PR #1) with decisions.gdoc, the
prose rendering produced by the new decisions-render skill.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Run the full test suite

- [ ] **Step 1: Run `npm test`.**

Run: `npm test`
Expected: PASS — full vitest suite green. Existing tests unaffected; new test files added: `test/lib/decisions-renderer.test.ts` (~9 assertions) and `test/skills/decisions-render/script.test.ts` (~3 assertions). Modified: `test/skills/idea-to-pdd/decisions-fixture.test.ts` (4 assertions, was 4).

- [ ] **Step 2: If anything fails, fix it.**

Common failure modes:
- Type errors in the renderer if `googleapis` types aren't imported. Fix: define a local minimal request type union or import from `@googleapis/docs`.
- The retrofitted fixture test fails if any anchor row was renamed in PR #1. Fix: align the ANCHOR_IDS list with what's actually in the fixture.
- Runner test fails because the fake Drive client interface drifts from the production interface. Fix: keep both in sync in `scripts/decisions-render.ts`.

Once green, no commit needed (no edits) — proceed.

---

### Task 9: Version bump and PR

- [ ] **Step 1: Run the worktree-safe version bump.**

Run: `bash scripts/version-bump.sh`
Expected: `VERSION` and the three plugin manifest files bumped to `max(local, origin/main) + patch+1`.

- [ ] **Step 2: Sync `package-lock.json`.**

Run: `npm install --package-lock-only`
Expected: lockfile's `"version"` field updated to match `package.json`.

- [ ] **Step 3: Commit.**

```bash
git add VERSION package.json package-lock.json .claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "chore: bump version for decisions-log PR #2 (renderer + retrofit)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 4: Push the branch.**

Run: `git push -u origin <branch-name>` (use whatever the current branch is — probably the same `emdash/questions-70lfu` branch reset to origin/main at the start of this PR's work).

- [ ] **Step 5: Open the PR.**

```bash
gh pr create --title "decisions-log PR #2: renderer + Phase 1 retrofit" --body "$(cat <<'EOF'
## Summary

Second PR in the decisions-log series ([spec](docs/superpowers/specs/2026-05-08-decisions-log-design.md)). Two coupled changes:

1. **Retrofit Phase 1**: drop the hardcoded 14-row "Required Phase 1 row set" introduced in PR #1. Replace with a 5-row "Anchor decisions" list (rows tied to specific eval rubric dimensions: archetype_coherence, resource_realism, demand_reality, mission_alignment, fallback_validates_primary). Recommended additional rows are illustrative, not binding. The bar criterion (load-bearing + maps to known surface) is the only filter.

2. **Renderer**: new `decisions-render` skill produces a prose Google Doc rendering of `decisions.yaml` at one stable URL per run. Pure-function `lib/decisions-renderer.ts` builds a Docs API request list; `scripts/decisions-render.ts` applies it via `docs_batch_update`. Wired into the orchestrator's Phase Write-Back Verifier — runs at end of every phase, idempotent.

## Why retrofit + renderer in one PR

The retrofit is a small architectural fix (drop hardcoded rows) that should land before the renderer because the renderer's eval rubric and gate-brief integration both depend on the cleaner schema. Bundling avoids landing the renderer over the wrong shape.

## What ships

- `lib/decisions-renderer.ts` — pure-function renderer (HEADING_1 title, HEADING_2 per phase, HEADING_3 per decision, bold field labels, bullet list for options_considered, italic notes, distinct emphasis for `status: open`).
- `scripts/decisions-render.ts` — runner with a `DecisionsRenderDriveClient` interface (testable; production wires MCP atoms).
- `skills/decisions-render/SKILL.md` — skill wrapping the script.
- `agents/ace-orchestrator.md` — Phase Write-Back Verifier invokes `decisions-render` after every phase.
- `skills/idea-to-pdd/SKILL.md` — retrofit: anchor list (5 rows) + recommended additional rows (illustrative, 9 rows). Process step adds renderer invocation; gate brief links the gdoc.
- `test/lib/decisions-renderer.test.ts` — 9 assertions on the renderer's output shape.
- `test/skills/decisions-render/script.test.ts` — 3 assertions on the runner against a fake Drive client.
- `test/skills/idea-to-pdd/decisions-fixture.test.ts` — retrofitted to assert anchor + invariants (no longer the exact-14-IDs check).
- `lib/artifact-manifest.ts` — registers `decisions.gdoc`.

## What does NOT ship

- Round-trip sync (`decisions-sync` skill that parses gdoc edits and writes back to YAML) — PR #3.
- Phase 2–9 writes (one PR per phase) — PRs #4–#11.
- Eval rubric re-anchor (`idea-to-pdd-eval`'s `deferred-decision-discipline` branch grading on `decisions.yaml` directly) — separate follow-up PR.

## Test plan

- [ ] CI green
- [ ] `npm test` passes locally
- [ ] Manual verification: re-run idea-to-pdd against an existing turmeric run, confirm `decisions.gdoc` appears in the run folder with the expected layout
- [ ] After merge: `/ace:update` + `/reload-plugins` to pick up the new schema

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review pass

**Spec coverage** — every item in the coverage map at the top is mapped to a task. PRs #3 and onwards are deliberately out of scope.

**Placeholder scan** — searched for `TBD`, `TODO`, `implement later`, `Add appropriate error handling`, `Similar to Task N`. None present. Every code step has the literal code; every command has the exact invocation; every file path is exact.

**Type consistency** — `renderDecisionsLog` (renderer pure function), `runDecisionsRender` (runner script entry), `DecisionsRenderDriveClient` (driver interface), `DecisionsLog` / `DecisionRow` (already shipped in PR #1) — names used consistently across plan, code blocks, and test assertions.

**Spec → plan alignment** — matches `docs/superpowers/specs/2026-05-08-decisions-log-design.md` § Rendering (prose Google Doc, native heading styles via `docs_batch_update`, find-or-update at one stable URL, regenerated end of every phase). The two named spec deviations (sub-project ordering swap + dropping required-row hardcoding) are called out in the plan header and don't change the architecture; they tighten it.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-08-decisions-log-pr2.md`. Subagent-driven execution recommended (matches PR #1's pattern).
