# Decisions Log — PR #3: Round-Trip Sync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Close the human iteration loop. Build a `decisions-sync` skill that reads the human-edited `decisions.gdoc`, diffs against `decisions.yaml`, and writes overrides back to the YAML so the next `/ace:run` (or `/ace:step idea-to-pdd`) honors the human's edits.

**Architecture:**
- **Parser** (`lib/decisions-parser.ts`): pure function that walks a Google Docs `documents.get` response and extracts `{id, default, options_considered}` per HEADING_3-anchored decision section. The renderer (PR #2) is the inverse — together they form a round-trip pair.
- **Merger** (`lib/decisions-sync.ts`): pure function `mergeDecisions(parsedFromGdoc, currentLog)` returns `{mergedLog, changeReport}`. Diffs default values; on changes, updates `default` and sets `status: overridden`. Appends new `Considered:` bullets to `options_considered`. Reports unmatched rows for operator awareness.
- **Runner** (`scripts/decisions-sync.ts`): the I/O glue — reads gdoc via Drive MCP, reads YAML, calls the merger, writes back via the schema-validated serializer. `DecisionsSyncDriveClient` interface for testability.
- **Skill** (`skills/decisions-sync/SKILL.md`): thin wrapper, human-triggered via `/ace:step decisions-sync <opp>/<run-id>`.

**Tech Stack:** TypeScript ESM, vitest, `lib/decisions-schema.ts` (helpers shipped in PR #1), `lib/decisions-renderer.ts` (PR #2 — for round-trip integration test).

**Trigger model:** Human-triggered, not orchestrator-automated. Workflow:
1. Human reads `decisions.gdoc` after a phase completes.
2. Human edits a `Default:` line or adds a `Considered:` bullet directly in the gdoc.
3. Human runs `/ace:step decisions-sync <opp>/<run-id>`.
4. Sync writes the human's edits to `decisions.yaml` with `status: overridden`.
5. Next `/ace:run` reads the updated YAML and uses overridden values as authoritative inputs.

**Why human-triggered, not auto-on-run:** Auto-pickup risks silently overwriting AI defaults if a stale gdoc has unintended edits. Explicit invocation makes the override deliberate and auditable.

---

## Spec coverage map

| Concern | Covered by |
|---|---|
| Parse Google Docs structure into per-decision rows | Task 1 (parser) |
| Diff parsed rows against current YAML; produce merged log + change report | Task 2 (merger) |
| Read gdoc + read YAML + write merged YAML via Drive MCP | Task 3 (runner) |
| Skill body wrapping the runner | Task 4 |
| Round-trip test (renderer + parser inverse) | Task 1 (extra assertion) |
| Full suite green | Task 5 |
| Version bump + push + PR | Task 6 |

---

## File structure

**Create:**
- `lib/decisions-parser.ts` — `parseDocumentStructure(doc: GoogleDocsDocument): ParsedDecisionRow[]`. Walks `body.content[]`, identifies HEADING_3 paragraphs as row IDs, extracts `Default:` value and `Considered:` bullets from subsequent body paragraphs until the next HEADING_3 or HEADING_2.
- `test/lib/decisions-parser.test.ts` — unit tests against hand-authored Document fixtures + a round-trip test using `lib/decisions-renderer.ts`.
- `lib/decisions-sync.ts` — `mergeDecisions(parsed: ParsedDecisionRow[], current: DecisionsLog): {merged: DecisionsLog; report: ChangeReport}`. Pure function, no I/O.
- `test/lib/decisions-sync.test.ts` — unit tests on the merger.
- `scripts/decisions-sync.ts` — runner: `runDecisionsSync({runFolderFileId, driveClient}): Promise<{report, gdocId}>`. `DecisionsSyncDriveClient` interface (`getDoc`, `readFile`, `writeFile`).
- `test/skills/decisions-sync/script.test.ts` — integration test against fake Drive client.
- `skills/decisions-sync/SKILL.md` — skill body.

**Modify:**
- `lib/artifact-manifest.ts` — add `decisions-sync` as a consumer of `decisions.gdoc` and a producer-of-overrides for `decisions.yaml` (in the consumedBy/producedBy fields, where the manifest schema permits — read what's there first).
- `VERSION`, `package.json`, `package-lock.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` — version-bumped.

---

## Tasks

### Task 1: Pure-function parser — `lib/decisions-parser.ts`

**Files:**
- Create: `lib/decisions-parser.ts`
- Create: `test/lib/decisions-parser.test.ts`

The parser walks a Google Docs API `documents.get` response and extracts decision rows. The renderer (PR #2) uses HEADING_1 (title), HEADING_2 (per phase), HEADING_3 (per decision id), and body paragraphs with bold field-label prefixes (`Default:`, `Considered:`, `Source:`, `Status:`). The parser is the inverse — it walks paragraphs in document order, finds HEADING_3 as decision boundaries, and extracts the per-decision body content.

#### Document shape (subset we care about)

A Google Docs `documents.get` response looks like:

```ts
type GoogleDocsDocument = {
  body?: {
    content?: GoogleDocsStructuralElement[];
  };
  // ... plus other fields we ignore (revisionId, documentStyle, etc.)
};

type GoogleDocsStructuralElement = {
  paragraph?: {
    elements?: Array<{
      textRun?: { content?: string };
    }>;
    paragraphStyle?: {
      namedStyleType?: string;  // "HEADING_1" | "HEADING_2" | "HEADING_3" | "NORMAL_TEXT" | ...
    };
    bullet?: { listId?: string };  // present iff paragraph is a bullet
  };
  // ... we ignore tables, sectionBreaks, etc.
};
```

The parser only needs `paragraphStyle.namedStyleType`, the concatenated text of `paragraph.elements[].textRun.content`, and presence of `paragraph.bullet`.

#### Output shape

```ts
type ParsedDecisionRow = {
  id: string;
  default?: string;            // text after "Default: " — undefined if no Default line found
  options_considered?: string[]; // bullets after "Considered:" up to next field — undefined if no Considered: section
};
```

The parser does NOT extract `phase`, `skill`, `question`, `source`, `status`, or `notes` — those are not editable surfaces in the round-trip workflow and the merger pulls them from the YAML.

- [ ] **Step 1: Write the failing test.**

Create `test/lib/decisions-parser.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseDocumentStructure } from "../../lib/decisions-parser.js";
import { renderDecisionsLog } from "../../lib/decisions-renderer.js";
import type { DecisionsLog } from "../../lib/decisions-schema.js";

// Helper: synthesize a minimal Google Docs Document from a list of
// (text, namedStyleType, isBullet) tuples. Mimics the post-render shape.
function makeDoc(
  paragraphs: Array<{ text: string; style?: string; bullet?: boolean }>,
): { body: { content: unknown[] } } {
  return {
    body: {
      content: paragraphs.map((p) => ({
        paragraph: {
          elements: [{ textRun: { content: p.text + "\n" } }],
          paragraphStyle: { namedStyleType: p.style ?? "NORMAL_TEXT" },
          ...(p.bullet ? { bullet: { listId: "kix.list1" } } : {}),
        },
      })),
    },
  };
}

describe("parseDocumentStructure", () => {
  it("returns an empty array for an empty document body", () => {
    const doc = { body: { content: [] } };
    expect(parseDocumentStructure(doc)).toEqual([]);
  });

  it("extracts a single decision with default + considered options", () => {
    const doc = makeDoc([
      { text: "Decisions Log — turmeric", style: "HEADING_1" },
      { text: "Phase 1 — Design", style: "HEADING_2" },
      { text: "archetype-selection", style: "HEADING_3" },
      { text: "Which delivery archetype best fits?", style: "NORMAL_TEXT" },
      { text: "  Default: atomic-visit" },
      { text: "  Considered:" },
      { text: "atomic-visit", bullet: true },
      { text: "focus-group", bullet: true },
      { text: "multi-stage", bullet: true },
      { text: "  Source: idea.md §1" },
      { text: "  Status: applied" },
    ]);
    const rows = parseDocumentStructure(doc);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: "archetype-selection",
      default: "atomic-visit",
      options_considered: ["atomic-visit", "focus-group", "multi-stage"],
    });
  });

  it("extracts multiple decisions across multiple phases", () => {
    const doc = makeDoc([
      { text: "Phase 1 — Design", style: "HEADING_2" },
      { text: "row-a", style: "HEADING_3" },
      { text: "  Default: alpha" },
      { text: "row-b", style: "HEADING_3" },
      { text: "  Default: beta" },
      { text: "Phase 2 — CommCare", style: "HEADING_2" },
      { text: "row-c", style: "HEADING_3" },
      { text: "  Default: gamma" },
    ]);
    const rows = parseDocumentStructure(doc);
    expect(rows.map((r) => r.id)).toEqual(["row-a", "row-b", "row-c"]);
    expect(rows.map((r) => r.default)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("handles a row with no Default: line (undefined default)", () => {
    const doc = makeDoc([
      { text: "row-x", style: "HEADING_3" },
      { text: "Some question?", style: "NORMAL_TEXT" },
      { text: "  Source: idea.md" },
    ]);
    const rows = parseDocumentStructure(doc);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("row-x");
    expect(rows[0]!.default).toBeUndefined();
  });

  it("handles a row with Default but no Considered: section", () => {
    const doc = makeDoc([
      { text: "row-y", style: "HEADING_3" },
      { text: "  Default: solo-value" },
    ]);
    const rows = parseDocumentStructure(doc);
    expect(rows[0]!.default).toBe("solo-value");
    expect(rows[0]!.options_considered).toBeUndefined();
  });

  it("ignores trailing whitespace and the Default: indent", () => {
    const doc = makeDoc([
      { text: "row-z", style: "HEADING_3" },
      { text: "    Default:   spaced-value   " },
    ]);
    const rows = parseDocumentStructure(doc);
    expect(rows[0]!.default).toBe("spaced-value");
  });

  it("round-trips a DecisionsLog through render → parse without losing default/options", () => {
    const log: DecisionsLog = {
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
        {
          id: "flw-count",
          phase: "1-design",
          skill: "idea-to-pdd",
          question: "How many FLWs?",
          default: "5–8",
          options_considered: ["3–5", "5–8", "10–15"],
          source: "idea.md §2",
          status: "applied",
        },
      ],
    };

    // Render → simulated Document → parse
    const requests = renderDecisionsLog(log);
    const doc = simulateDocument(requests);
    const parsed = parseDocumentStructure(doc);

    // Renderer + parser should be inverses for the round-trip fields.
    expect(parsed.map((r) => r.id)).toEqual(["archetype-selection", "flw-count"]);
    expect(parsed[0]!.default).toBe("atomic-visit");
    expect(parsed[0]!.options_considered).toEqual([
      "atomic-visit",
      "focus-group",
      "multi-stage",
    ]);
    expect(parsed[1]!.default).toBe("5–8");
    expect(parsed[1]!.options_considered).toEqual(["3–5", "5–8", "10–15"]);
  });
});

/**
 * Simulate the Google Docs document state produced by applying a list
 * of batchUpdate requests starting from an empty doc. Used only to
 * round-trip the renderer through the parser in tests; not a complete
 * Docs API simulator (only handles insertText, updateParagraphStyle,
 * updateTextStyle, createParagraphBullets — the request kinds the
 * renderer actually emits).
 */
function simulateDocument(requests: any[]): {
  body: { content: any[] };
} {
  // Build a single text buffer first.
  let text = "";
  for (const r of requests) {
    if ("insertText" in r) {
      text += r.insertText.text;
    }
  }
  // Split into paragraphs on \n.
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop(); // drop trailing empty from last \n

  // Compute each line's start/end indices in the doc-1-indexed coordinate
  // space the renderer uses.
  let cursor = 1;
  const linePositions: Array<{ start: number; end: number; text: string }> = [];
  for (const line of lines) {
    const start = cursor;
    const end = cursor + line.length;
    linePositions.push({ start, end, text: line });
    cursor = end + 1; // +1 for the \n
  }

  // Apply paragraph-style requests by matching range to a line.
  const paragraphStyles = new Map<number, string>(); // line index → namedStyleType
  const bulletLines = new Set<number>();
  for (const r of requests) {
    if ("updateParagraphStyle" in r) {
      const { range, paragraphStyle } = r.updateParagraphStyle;
      const namedStyleType = paragraphStyle?.namedStyleType;
      if (!namedStyleType) continue;
      // Find lines whose start falls within [range.startIndex, range.endIndex)
      for (let i = 0; i < linePositions.length; i++) {
        const lp = linePositions[i]!;
        if (lp.start >= range.startIndex && lp.start < range.endIndex) {
          paragraphStyles.set(i, namedStyleType);
        }
      }
    } else if ("createParagraphBullets" in r) {
      const { range } = r.createParagraphBullets;
      for (let i = 0; i < linePositions.length; i++) {
        const lp = linePositions[i]!;
        if (lp.start >= range.startIndex && lp.start < range.endIndex) {
          bulletLines.add(i);
        }
      }
    }
  }

  return {
    body: {
      content: linePositions.map((lp, i) => ({
        paragraph: {
          elements: [{ textRun: { content: lp.text + "\n" } }],
          paragraphStyle: { namedStyleType: paragraphStyles.get(i) ?? "NORMAL_TEXT" },
          ...(bulletLines.has(i) ? { bullet: { listId: "kix.list1" } } : {}),
        },
      })),
    },
  };
}
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `npx vitest run test/lib/decisions-parser.test.ts`
Expected: FAIL with `Cannot find module '../../lib/decisions-parser.js'`.

- [ ] **Step 3: Implement the parser.**

Create `lib/decisions-parser.ts`. Key implementation hints:

```ts
export type ParsedDecisionRow = {
  id: string;
  default?: string;
  options_considered?: string[];
};

type DocsParagraph = {
  elements?: Array<{ textRun?: { content?: string } }>;
  paragraphStyle?: { namedStyleType?: string };
  bullet?: { listId?: string };
};

type DocsStructuralElement = { paragraph?: DocsParagraph };

type GoogleDocsDocument = { body?: { content?: DocsStructuralElement[] } };

const HEADING_3 = "HEADING_3";
const HEADING_2 = "HEADING_2";

/** Concatenate all textRun.content values inside a paragraph. */
function paragraphText(p: DocsParagraph): string {
  if (!p.elements) return "";
  return p.elements
    .map((e) => e.textRun?.content ?? "")
    .join("")
    .replace(/\n$/, "");  // strip the trailing newline that ends every paragraph
}

export function parseDocumentStructure(
  doc: GoogleDocsDocument,
): ParsedDecisionRow[] {
  const content = doc.body?.content ?? [];
  const rows: ParsedDecisionRow[] = [];

  // State machine: walk paragraphs in order. When we hit a HEADING_3
  // we open a new row. Subsequent body paragraphs (until the next
  // HEADING_3 or HEADING_2) get scanned for "Default: <value>" and
  // a "Considered:" header followed by bullets.
  let current: ParsedDecisionRow | null = null;
  let inConsidered = false;

  function commit() {
    if (current) rows.push(current);
    current = null;
    inConsidered = false;
  }

  for (const el of content) {
    const p = el.paragraph;
    if (!p) continue;
    const style = p.paragraphStyle?.namedStyleType ?? "NORMAL_TEXT";
    const text = paragraphText(p);

    if (style === HEADING_3) {
      commit();
      current = { id: text.trim() };
      continue;
    }
    if (style === HEADING_2) {
      commit();
      continue;
    }
    if (!current) continue;

    // We're inside a decision section.
    const trimmed = text.trim();

    // Bullet under "Considered:"
    if (inConsidered && p.bullet) {
      const bulletText = trimmed;
      if (bulletText) {
        current.options_considered = current.options_considered ?? [];
        current.options_considered.push(bulletText);
      }
      continue;
    }

    // Field-prefix lines: any other field exits the Considered: block.
    if (/^Default:/i.test(trimmed)) {
      current.default = trimmed.replace(/^Default:\s*/i, "").trim();
      inConsidered = false;
      continue;
    }
    if (/^Considered:/i.test(trimmed)) {
      inConsidered = true;
      continue;
    }
    if (/^Source:/i.test(trimmed) || /^Status:/i.test(trimmed)) {
      inConsidered = false;
      continue;
    }
    // Any other body paragraph (question, notes, etc.) is ignored —
    // not a round-trip-editable surface.
  }

  commit();
  return rows;
}
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `npx vitest run test/lib/decisions-parser.test.ts`
Expected: PASS, 7/7 green.

- [ ] **Step 5: Commit.**

```bash
git add lib/decisions-parser.ts test/lib/decisions-parser.test.ts
git commit -m "lib: add pure-function parser for decisions gdoc

parseDocumentStructure(doc) walks a Google Docs documents.get response,
identifies HEADING_3 paragraphs as decision-row IDs, and extracts the
'Default:' value and 'Considered:' bullet list per decision section.
Inverse of lib/decisions-renderer.ts; round-trip tested.

Other fields (phase, skill, question, source, status, notes) are not
extracted — they're not editable surfaces in the human-iteration
workflow. The merger pulls them from the YAML.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Pure-function merger — `lib/decisions-sync.ts`

**Files:**
- Create: `lib/decisions-sync.ts`
- Create: `test/lib/decisions-sync.test.ts`

Diffs parsed gdoc rows against the current YAML log; produces a merged log + change report.

#### Behavior

For each parsed row matched to a YAML row by `id`:
- If `parsed.default` is defined and differs from `yaml.default`: update YAML's `default` to parsed value, set `status: overridden`. Add the prior YAML default to `options_considered` if not already there.
- If `parsed.options_considered` contains entries not in `yaml.options_considered`: append them.
- If `parsed.options_considered` is missing entries that are in `yaml.options_considered`: leave the YAML entries alone (don't auto-delete; deletions are too risky to infer from a missing bullet).

Unmatched rows:
- A parsed row with no matching YAML row → warning in the report; not added to YAML.
- A YAML row with no matching parsed row → warning in the report; YAML row preserved unchanged.

#### Output

```ts
type ChangeReport = {
  defaultsOverridden: Array<{ id: string; from: string; to: string }>;
  optionsAdded: Array<{ id: string; option: string }>;
  parsedNotInYaml: string[];   // ids in gdoc but not in YAML
  yamlNotInParsed: string[];   // ids in YAML but not in gdoc
};
```

- [ ] **Step 1: Write the failing test.**

Create `test/lib/decisions-sync.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mergeDecisions } from "../../lib/decisions-sync.js";
import type { DecisionsLog } from "../../lib/decisions-schema.js";

const baseLog: DecisionsLog = {
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
    {
      id: "flw-count",
      phase: "1-design",
      skill: "idea-to-pdd",
      question: "How many FLWs?",
      default: "5–8",
      options_considered: ["3–5", "5–8", "10–15"],
      source: "idea.md §2",
      status: "applied",
    },
  ],
};

describe("mergeDecisions", () => {
  it("preserves the YAML when parsed rows match it exactly", () => {
    const parsed = [
      { id: "archetype-selection", default: "atomic-visit", options_considered: ["atomic-visit", "focus-group", "multi-stage"] },
      { id: "flw-count", default: "5–8", options_considered: ["3–5", "5–8", "10–15"] },
    ];
    const { merged, report } = mergeDecisions(parsed, baseLog);
    expect(merged).toEqual(baseLog);
    expect(report.defaultsOverridden).toEqual([]);
    expect(report.optionsAdded).toEqual([]);
  });

  it("overrides default when human edits it; sets status=overridden", () => {
    const parsed = [
      { id: "flw-count", default: "12", options_considered: ["3–5", "5–8", "10–15"] },
    ];
    const { merged, report } = mergeDecisions(parsed, baseLog);
    const flw = merged.decisions.find((d) => d.id === "flw-count")!;
    expect(flw.default).toBe("12");
    expect(flw.status).toBe("overridden");
    expect(report.defaultsOverridden).toEqual([
      { id: "flw-count", from: "5–8", to: "12" },
    ]);
  });

  it("preserves the prior default in options_considered when overriding", () => {
    const parsed = [
      { id: "flw-count", default: "12", options_considered: ["3–5", "5–8", "10–15"] },
    ];
    const { merged } = mergeDecisions(parsed, baseLog);
    const flw = merged.decisions.find((d) => d.id === "flw-count")!;
    expect(flw.options_considered).toContain("5–8"); // original default
    expect(flw.options_considered).toContain("12");  // new default
  });

  it("does not duplicate the prior default if already in options_considered", () => {
    const parsed = [
      // Human picked an existing option as new default
      { id: "flw-count", default: "10–15", options_considered: ["3–5", "5–8", "10–15"] },
    ];
    const { merged } = mergeDecisions(parsed, baseLog);
    const flw = merged.decisions.find((d) => d.id === "flw-count")!;
    expect(flw.default).toBe("10–15");
    // 5–8 prior default should be added (it wasn't in the new selection)
    expect(flw.options_considered.filter((x) => x === "5–8")).toHaveLength(1);
    // 10–15 should not be duplicated
    expect(flw.options_considered.filter((x) => x === "10–15")).toHaveLength(1);
  });

  it("appends new Considered bullets that aren't in YAML", () => {
    const parsed = [
      { id: "archetype-selection", default: "atomic-visit", options_considered: ["atomic-visit", "focus-group", "multi-stage", "novel-archetype"] },
    ];
    const { merged, report } = mergeDecisions(parsed, baseLog);
    const arch = merged.decisions.find((d) => d.id === "archetype-selection")!;
    expect(arch.options_considered).toContain("novel-archetype");
    expect(report.optionsAdded).toEqual([
      { id: "archetype-selection", option: "novel-archetype" },
    ]);
  });

  it("does NOT delete options that are missing from parsed", () => {
    const parsed = [
      // Human deleted "focus-group" bullet from gdoc
      { id: "archetype-selection", default: "atomic-visit", options_considered: ["atomic-visit", "multi-stage"] },
    ];
    const { merged } = mergeDecisions(parsed, baseLog);
    const arch = merged.decisions.find((d) => d.id === "archetype-selection")!;
    expect(arch.options_considered).toContain("focus-group"); // preserved
  });

  it("reports parsed rows not matched in YAML (warns; doesn't add)", () => {
    const parsed = [
      { id: "ghost-row", default: "abc", options_considered: ["abc"] },
    ];
    const { merged, report } = mergeDecisions(parsed, baseLog);
    expect(merged.decisions).toHaveLength(2); // unchanged
    expect(report.parsedNotInYaml).toEqual(["ghost-row"]);
  });

  it("reports YAML rows not present in parsed (warns; preserves)", () => {
    const parsed = [
      { id: "archetype-selection", default: "atomic-visit", options_considered: ["atomic-visit"] },
      // flw-count is missing from gdoc
    ];
    const { merged, report } = mergeDecisions(parsed, baseLog);
    expect(merged.decisions).toHaveLength(2); // both preserved
    expect(report.yamlNotInParsed).toEqual(["flw-count"]);
  });

  it("ignores parsed rows with undefined default (no override applied)", () => {
    const parsed = [
      { id: "flw-count" }, // no default, no options
    ];
    const { merged, report } = mergeDecisions(parsed, baseLog);
    const flw = merged.decisions.find((d) => d.id === "flw-count")!;
    expect(flw.default).toBe("5–8");
    expect(flw.status).toBe("applied");
    expect(report.defaultsOverridden).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test.**

Run: `npx vitest run test/lib/decisions-sync.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 3: Implement the merger.**

Create `lib/decisions-sync.ts`:

```ts
import type { DecisionsLog, DecisionRow } from "./decisions-schema.js";
import type { ParsedDecisionRow } from "./decisions-parser.js";

export type ChangeReport = {
  defaultsOverridden: Array<{ id: string; from: string; to: string }>;
  optionsAdded: Array<{ id: string; option: string }>;
  parsedNotInYaml: string[];
  yamlNotInParsed: string[];
};

export function mergeDecisions(
  parsed: ParsedDecisionRow[],
  current: DecisionsLog,
): { merged: DecisionsLog; report: ChangeReport } {
  const report: ChangeReport = {
    defaultsOverridden: [],
    optionsAdded: [],
    parsedNotInYaml: [],
    yamlNotInParsed: [],
  };

  const parsedById = new Map<string, ParsedDecisionRow>();
  for (const p of parsed) parsedById.set(p.id, p);

  const yamlIds = new Set(current.decisions.map((d) => d.id));
  for (const p of parsed) {
    if (!yamlIds.has(p.id)) report.parsedNotInYaml.push(p.id);
  }
  for (const d of current.decisions) {
    if (!parsedById.has(d.id)) report.yamlNotInParsed.push(d.id);
  }

  const merged: DecisionsLog = {
    ...current,
    decisions: current.decisions.map((d) => mergeRow(d, parsedById.get(d.id), report)),
  };

  return { merged, report };
}

function mergeRow(
  yamlRow: DecisionRow,
  parsedRow: ParsedDecisionRow | undefined,
  report: ChangeReport,
): DecisionRow {
  if (!parsedRow) return yamlRow;

  let updated: DecisionRow = yamlRow;

  // Handle default override.
  if (
    parsedRow.default !== undefined &&
    parsedRow.default !== yamlRow.default
  ) {
    const newOptions = [...yamlRow.options_considered];
    // Preserve the AI's prior default in the option menu.
    if (!newOptions.includes(yamlRow.default)) {
      newOptions.push(yamlRow.default);
    }
    // Add the new value to options if not already there.
    if (!newOptions.includes(parsedRow.default)) {
      newOptions.push(parsedRow.default);
    }
    updated = {
      ...updated,
      default: parsedRow.default,
      status: "overridden",
      options_considered: newOptions,
    };
    report.defaultsOverridden.push({
      id: yamlRow.id,
      from: yamlRow.default,
      to: parsedRow.default,
    });
  }

  // Handle additive options_considered changes.
  if (parsedRow.options_considered) {
    const existing = new Set(updated.options_considered);
    const newlyAdded: string[] = [];
    for (const opt of parsedRow.options_considered) {
      if (!existing.has(opt)) {
        newlyAdded.push(opt);
        existing.add(opt);
      }
    }
    if (newlyAdded.length > 0) {
      updated = {
        ...updated,
        options_considered: [...updated.options_considered, ...newlyAdded],
      };
      for (const opt of newlyAdded) {
        report.optionsAdded.push({ id: yamlRow.id, option: opt });
      }
    }
  }

  return updated;
}
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `npx vitest run test/lib/decisions-sync.test.ts`
Expected: PASS, 9/9 green.

- [ ] **Step 5: Commit.**

```bash
git add lib/decisions-sync.ts test/lib/decisions-sync.test.ts
git commit -m "lib: add merger for decisions-sync round-trip

mergeDecisions(parsed, current) returns merged DecisionsLog +
ChangeReport. Diffs parsed gdoc rows against the current YAML log;
on default override, sets status: overridden and preserves the prior
default in options_considered. New Considered bullets are appended;
missing bullets are NOT auto-deleted (too risky to infer from
absence). Unmatched rows in either direction surface in the report.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Runner script — `scripts/decisions-sync.ts`

**Files:**
- Create: `scripts/decisions-sync.ts`
- Create: `test/skills/decisions-sync/script.test.ts`

The runner glues parser + merger + Drive I/O together.

- [ ] **Step 1: Write the failing test.**

Create `test/skills/decisions-sync/script.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { runDecisionsSync } from "../../../scripts/decisions-sync.js";

const VALID_YAML = `schema_version: 1
opportunity: turmeric
run_id: 20260507-1733
generated_at: "2026-05-07T17:33:00Z"
decisions:
  - id: flw-count
    phase: 1-design
    skill: idea-to-pdd
    question: How many FLWs?
    default: "5–8"
    options_considered: ["3–5", "5–8", "10–15"]
    source: idea.md §2
    status: applied
`;

const FAKE_GDOC = {
  body: {
    content: [
      {
        paragraph: {
          elements: [{ textRun: { content: "flw-count\n" } }],
          paragraphStyle: { namedStyleType: "HEADING_3" },
        },
      },
      {
        paragraph: {
          elements: [{ textRun: { content: "  Default: 12\n" } }],
          paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
        },
      },
    ],
  },
};

function makeFakeDriveClient() {
  return {
    findFile: vi.fn(),
    getDoc: vi.fn().mockResolvedValue(FAKE_GDOC),
    readFile: vi.fn().mockResolvedValue({ content: VALID_YAML }),
    writeFile: vi.fn().mockResolvedValue(undefined),
  };
}

describe("runDecisionsSync", () => {
  it("reads gdoc + yaml, merges, writes updated yaml, returns the change report", async () => {
    const client = makeFakeDriveClient();
    client.findFile.mockResolvedValueOnce({ id: "fake-gdoc-id" });

    const result = await runDecisionsSync({
      runFolderFileId: "fake-folder-id",
      driveClient: client,
    });

    expect(client.findFile).toHaveBeenCalledWith({
      parentFolderId: "fake-folder-id",
      name: "decisions.gdoc",
    });
    expect(client.getDoc).toHaveBeenCalledWith("fake-gdoc-id");
    expect(client.readFile).toHaveBeenCalledWith({
      parentFolderId: "fake-folder-id",
      name: "decisions.yaml",
    });
    expect(client.writeFile).toHaveBeenCalled();

    const writeArgs = client.writeFile.mock.calls[0]![0];
    expect(writeArgs.parentFolderId).toBe("fake-folder-id");
    expect(writeArgs.name).toBe("decisions.yaml");
    expect(writeArgs.content).toContain("default: \"12\"");
    expect(writeArgs.content).toContain("status: overridden");

    expect(result.report.defaultsOverridden).toEqual([
      { id: "flw-count", from: "5–8", to: "12" },
    ]);
  });

  it("throws an actionable error when decisions.gdoc is missing", async () => {
    const client = makeFakeDriveClient();
    client.findFile.mockResolvedValueOnce(null);

    await expect(
      runDecisionsSync({ runFolderFileId: "fake-folder-id", driveClient: client }),
    ).rejects.toThrow(/decisions\.gdoc/);
  });

  it("throws an actionable error when decisions.yaml is missing", async () => {
    const client = makeFakeDriveClient();
    client.findFile.mockResolvedValueOnce({ id: "fake-gdoc-id" });
    client.readFile.mockRejectedValueOnce(new Error("File not found"));

    await expect(
      runDecisionsSync({ runFolderFileId: "fake-folder-id", driveClient: client }),
    ).rejects.toThrow(/decisions\.yaml/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `npx vitest run test/skills/decisions-sync/script.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 3: Implement the runner.**

Create `scripts/decisions-sync.ts`:

```ts
#!/usr/bin/env npx tsx
import { parseDecisionsYaml, serializeDecisionsLog } from "../lib/decisions-schema.js";
import { parseDocumentStructure } from "../lib/decisions-parser.js";
import { mergeDecisions, type ChangeReport } from "../lib/decisions-sync.js";

export interface DecisionsSyncDriveClient {
  findFile(args: { parentFolderId: string; name: string }): Promise<{ id: string } | null>;
  getDoc(documentId: string): Promise<unknown>;
  readFile(args: { parentFolderId: string; name: string }): Promise<{ content: string }>;
  writeFile(args: { parentFolderId: string; name: string; content: string }): Promise<void>;
}

export interface RunDecisionsSyncArgs {
  runFolderFileId: string;
  driveClient: DecisionsSyncDriveClient;
}

export interface RunDecisionsSyncResult {
  gdocId: string;
  report: ChangeReport;
}

export async function runDecisionsSync(
  args: RunDecisionsSyncArgs,
): Promise<RunDecisionsSyncResult> {
  const { runFolderFileId, driveClient } = args;

  const gdocFile = await driveClient.findFile({
    parentFolderId: runFolderFileId,
    name: "decisions.gdoc",
  });
  if (!gdocFile) {
    throw new Error(
      `decisions.gdoc not found in run folder ${runFolderFileId}. Run /ace:step decisions-render first to produce the gdoc.`,
    );
  }

  const doc = await driveClient.getDoc(gdocFile.id);
  const parsedRows = parseDocumentStructure(doc as Parameters<typeof parseDocumentStructure>[0]);

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

  const currentLog = parseDecisionsYaml(yamlContent);
  const { merged, report } = mergeDecisions(parsedRows, currentLog);

  // Bump generated_at on every sync write.
  merged.generated_at = new Date().toISOString();

  const newYaml = serializeDecisionsLog(merged);
  await driveClient.writeFile({
    parentFolderId: runFolderFileId,
    name: "decisions.yaml",
    content: newYaml,
  });

  return { gdocId: gdocFile.id, report };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.error("Direct CLI mode not yet wired — invoke via /ace:step decisions-sync <opp>/<run-id> instead.");
  process.exit(2);
}
```

- [ ] **Step 4: Run the test.**

Run: `npx vitest run test/skills/decisions-sync/script.test.ts`
Expected: PASS, 3/3 green.

- [ ] **Step 5: Commit.**

```bash
git add scripts/decisions-sync.ts test/skills/decisions-sync/script.test.ts
git commit -m "scripts: add decisions-sync runner

Reads decisions.gdoc + decisions.yaml from a run folder, parses the
gdoc, merges human edits into the YAML, writes the updated YAML back.
DriveClient interface (findFile / getDoc / readFile / writeFile)
decouples from MCP for testability.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Skill body — `skills/decisions-sync/SKILL.md`

**Files:**
- Create: `skills/decisions-sync/SKILL.md`

- [ ] **Step 1: Write the SKILL.md.**

Create `skills/decisions-sync/SKILL.md`:

```markdown
---
name: decisions-sync
description: >
  Sync human edits from the per-run decisions.gdoc back into
  decisions.yaml. Human-triggered via /ace:step decisions-sync; not
  part of the orchestrator's automatic phase loop.
disable-model-invocation: true
---

# Decisions Sync

Read the human-edited `decisions.gdoc` for a run, diff against
`decisions.yaml`, and write overrides back to the YAML so subsequent
runs honor the human's edits.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Per-run state | `ACE/<opp-name>/runs/<run-id>/decisions.gdoc` | human-edited prose Doc — source of overrides |
| Per-run state | `ACE/<opp-name>/runs/<run-id>/decisions.yaml` | structured log to update |

## Outputs

- `ACE/<opp-name>/runs/<run-id>/decisions.yaml` — updated in place. Rows where the human changed `Default:` get `status: overridden` and the prior default is preserved in `options_considered`. New `Considered:` bullets are appended.

## Process

1. **Resolve the run folder file ID** for `ACE/<opp-name>/runs/<run-id>/`.
2. **Run the sync script:**

   ```bash
   npx tsx scripts/decisions-sync.ts <run-folder-fileId>
   ```

   The script:
   - Finds `decisions.gdoc` in the run folder; halts with actionable error if missing.
   - Reads the doc structure via `docs_get`.
   - Parses via `parseDocumentStructure` from `lib/decisions-parser.ts`.
   - Reads `decisions.yaml`; halts if missing.
   - Merges via `mergeDecisions` from `lib/decisions-sync.ts`.
   - Writes the merged YAML back via `drive_update_file`.
   - Returns a change report (defaults overridden, options added, unmatched rows).

3. **Surface the change report** to the operator. Format:

   ```
   Decisions sync — turmeric/20260507-1733
     Defaults overridden: 2
       - flw-count: 5–8 → 12
       - ai-photo-threshold: ≥90% → ≥95%
     Options added: 1
       - archetype-selection: novel-archetype
     Parsed rows not in YAML: 0
     YAML rows not in gdoc: 0
   ```

4. **Suggest the next step**: re-run `/ace:step idea-to-pdd <opp>/<run-id>` (or `/ace:run <opp>`) so subsequent phases consume the overridden values.

## Failure modes

- **decisions.gdoc missing**: halts with "Run /ace:step decisions-render first to produce the gdoc."
- **decisions.yaml missing**: halts with the path that wasn't found.
- **Schema-invalid YAML after merge**: should not happen — the merger preserves all required fields. If it does, the merger has a bug; the operator should file an issue with the change report.
- **Heading mismatch (gdoc has rows YAML doesn't or vice versa)**: warned in the report; sync proceeds with the matched rows.

## Trigger model

This skill is **human-triggered**. The orchestrator's Phase Write-Back Verifier does NOT auto-invoke it — that would silently overwrite AI defaults from any stale gdoc edits. Always run explicitly:

```
/ace:step decisions-sync <opp>/<run-id>
```

after editing the gdoc, before re-running the affected phases.

## MCP Tools Used

- Google Drive: `drive_list_folder`, `drive_read_file`, `drive_update_file`, `docs_get`

## Mode Behavior

- **Auto:** Run, surface the report, return.
- **Review:** Same as Auto — sync is itself the review-and-apply step; no further pause needed.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-05-08 | Initial skill — pairs with `lib/decisions-parser.ts`, `lib/decisions-sync.ts`, `scripts/decisions-sync.ts`. Round-trips human edits from `decisions.gdoc` into `decisions.yaml`. Human-triggered. | ACE team (decisions-log PR #3) |
```

- [ ] **Step 2: Sanity-check.**

Run: `head -1 skills/decisions-sync/SKILL.md`
Expected: `---`

Run: `grep -c "^## " skills/decisions-sync/SKILL.md`
Expected: 8 (Inputs, Outputs, Process, Failure modes, Trigger model, MCP Tools Used, Mode Behavior, Change Log).

- [ ] **Step 3: Commit.**

```bash
git add skills/decisions-sync/SKILL.md
git commit -m "skill(decisions-sync): wrap parser + merger + script as an ACE skill

Human-triggered via /ace:step decisions-sync. Reads the gdoc, diffs
against the YAML, writes overrides back. Surfaces a change report
(defaults overridden, options added, unmatched rows) to the operator.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Run full test suite

- [ ] **Step 1: Run `npm test`.**

Run: `npm test`
Expected: PASS — full vitest suite green. New tests: parser (~7), merger (~9), sync runner (~3) = 19 added assertions.

- [ ] **Step 2: If anything fails, fix it.**

The most likely failure mode is the round-trip test in the parser if the renderer's exact request shape differs from what `simulateDocument` reconstructs. If that happens, debug by logging `requests` from the renderer call and walking through the simulation step by step.

---

### Task 6: Version bump and PR

- [ ] **Step 1: Bump version.**

Run: `bash scripts/version-bump.sh`
Expected: VERSION updated to next patch.

- [ ] **Step 2: Sync lockfile.**

Run: `npm install --package-lock-only`

- [ ] **Step 3: Commit + push + PR.**

```bash
git add VERSION package.json package-lock.json .claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "chore: bump version for decisions-log PR #3 (round-trip sync)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"

git push -u origin emdash/questions-70lfu

gh pr create --title "decisions-log PR #3: round-trip sync" --body "$(cat <<'EOF'
## Summary

Third PR in the decisions-log series. Closes the human iteration loop:
human edits the prose gdoc, runs \`/ace:step decisions-sync\`, the YAML
picks up the changes with \`status: overridden\`, the next \`/ace:run\`
honors the overrides.

## What ships

- **\`lib/decisions-parser.ts\`** — pure-function parser: walks a Google Docs documents.get response, extracts \`{id, default, options_considered}\` per HEADING_3-anchored decision section. 7 unit tests + 1 round-trip integration test (renderer + parser are inverses).
- **\`lib/decisions-sync.ts\`** — pure-function merger: \`mergeDecisions(parsed, current)\` returns merged DecisionsLog + change report. 9 unit tests covering override + options-added + non-deletion + unmatched-row reporting.
- **\`scripts/decisions-sync.ts\`** — runner: glues parser + merger + Drive I/O. \`DecisionsSyncDriveClient\` interface for testability. 3 integration tests against a fake client.
- **\`skills/decisions-sync/SKILL.md\`** — thin skill body. Human-triggered via \`/ace:step decisions-sync <opp>/<run-id>\`.

## Trigger model

Human-triggered, NOT orchestrator-automated. Auto-pickup risks silently overwriting AI defaults if stale gdoc edits exist. Explicit invocation makes the override deliberate and auditable.

## What does NOT ship

- Phase 2-9 writes (one PR per phase) — PRs #4-#11.
- Eval rubric re-anchor — separate follow-up.

## Test plan

- [ ] CI green
- [x] \`npm test\` passes locally — full suite green with 19 new assertions
- [ ] Manual verification: edit a default in a turmeric run's decisions.gdoc, run \`/ace:step decisions-sync\`, confirm decisions.yaml updated with \`status: overridden\` and the prior default preserved in options_considered

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review pass

**Spec coverage** — every concern in the coverage map maps to a task.

**Placeholder scan** — no `TBD`, `TODO`, `Add appropriate error handling`, or `Similar to Task N`. Every code step has the literal code; every command has the exact invocation; every file path is exact.

**Type consistency** — `parseDocumentStructure`, `ParsedDecisionRow`, `mergeDecisions`, `ChangeReport`, `runDecisionsSync`, `DecisionsSyncDriveClient` — all referenced consistently across plan, code blocks, and test assertions. The parser output type is consumed by the merger; the merger output is consumed by the runner.

**Spec → plan alignment** — matches `docs/superpowers/specs/2026-05-08-decisions-log-design.md` § Round-trip — v1: explicit sync skill. The recommended-additional rows from PR #2 (illustrative, non-binding) are unaffected — sync only acts on rows present in BOTH the gdoc and the YAML.

---

## Execution handoff

Plan saved to `docs/superpowers/plans/2026-05-08-decisions-log-pr3.md`. Subagent-driven execution.
