# Fork decisions modes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace fork modes `with-feedback` / `empty` with `keep-overrides-only` / `keep-all`. Rename `default:` → `ai-default:` in decisions schema, add optional `override:`, drop `open` status.

**Architecture:** Ships across two repos. **PR 1 (this repo)**: schema v2, parser/renderer/sync libs, migration doc, skill docs. **PR 2 (ace-web sibling)**: fork.py mode handling + decisions filter, ForkDialog UI. Plus a **one-time Drive rewrite script** the operator runs once between PRs to upgrade existing `decisions.yaml` files.

**Tech Stack:** TypeScript (ESM, vitest, zod, yaml), Python/Django (ace-web), React/TS (ace-web frontend).

**Spec:** `docs/superpowers/specs/2026-05-22-fork-decisions-modes-design.md`.

---

## PR 1: ACE plugin — schema v2 + libs + skill docs

### Task 1: Update `lib/decisions-schema.ts`

**Files:**
- Modify: `lib/decisions-schema.ts`

- [ ] **Step 1: Bump schema version + rewrite `DecisionRowSchema`**

Replace the existing `DecisionRowSchema` + version constant:

```typescript
export const DECISIONS_SCHEMA_VERSION = 2 as const;

export const DecisionRowSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    message: "id must be canonical kebab-case (lowercase alphanumeric segments separated by single hyphens)",
  }),
  phase: z.string().regex(/^[1-9][0-9]*-[a-z]+(-[a-z]+)*$/, {
    message: "phase must match <N>-<kebab-name> (e.g. 1-design, 3-commcare)",
  }),
  skill: z.string().min(1),
  question: z.string().min(1),
  "ai-default": z.string().min(1),
  override: z.string().min(1).optional(),
  options_considered: z.array(z.string().min(1)),
  source: z.string().min(1),
  status: z.enum(["applied", "overridden"]),
  notes: z.string().optional(),
}).superRefine((row, ctx) => {
  if (row.status === "overridden" && row.override === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "status=overridden requires `override` field",
      path: ["override"],
    });
  }
  if (row.status === "applied" && row.override !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "status=applied must not have `override` field",
      path: ["override"],
    });
  }
});
```

The new `superRefine` enforces the override-status invariant.

The `DecisionsLogSchema`'s `schema_version` literal must update to `2`.

- [ ] **Step 2: Run schema tests; expect failures (intentional)**

```bash
npx vitest run test/lib/decisions-schema.test.ts
```

Expected: tests fail because fixtures use the old field name. Capture the count.

- [ ] **Step 3: Update `test/lib/decisions-schema.test.ts`**

Replace every `default:` in row literals with `"ai-default":` and bump every `schema_version: 1` to `schema_version: 2`. Drop the test that expected `status: open` to validate. Add a new test:

```typescript
it("rejects status=overridden without override field", () => {
  const row = {
    id: "x",
    phase: "1-design",
    skill: "idea-to-pdd",
    question: "Q?",
    "ai-default": "x",
    options_considered: [],
    source: "x",
    status: "overridden",
  };
  expect(() => DecisionRowSchema.parse(row)).toThrow();
});

it("accepts status=overridden with override field", () => {
  const row = {
    id: "x",
    phase: "1-design",
    skill: "idea-to-pdd",
    question: "Q?",
    "ai-default": "x",
    override: "y",
    options_considered: [],
    source: "x",
    status: "overridden",
  };
  expect(() => DecisionRowSchema.parse(row)).not.toThrow();
});

it("rejects status=applied with override field", () => {
  const row = {
    id: "x",
    phase: "1-design",
    skill: "idea-to-pdd",
    question: "Q?",
    "ai-default": "x",
    override: "y",
    options_considered: [],
    source: "x",
    status: "applied",
  };
  expect(() => DecisionRowSchema.parse(row)).toThrow();
});
```

- [ ] **Step 4: Run schema tests; expect pass**

```bash
npx vitest run test/lib/decisions-schema.test.ts
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add lib/decisions-schema.ts test/lib/decisions-schema.test.ts
git commit -m "feat(decisions): schema v2 — rename default→ai-default, add override, drop open"
```

---

### Task 2: Update `lib/decisions-sync.ts` merge semantics

**Files:**
- Modify: `lib/decisions-sync.ts`
- Modify: `test/lib/decisions-sync.test.ts`

- [ ] **Step 1: Update `ParsedDecisionRow` consumer + merge**

In `lib/decisions-sync.ts`, change `mergeRow` so that when the parsed gdoc row's value differs from the YAML's effective value, we set `override:` and flip status — we do NOT touch `ai-default:`:

```typescript
function mergeRow(
  yamlRow: DecisionRow,
  parsedRow: ParsedDecisionRow | undefined,
  report: ChangeReport,
): DecisionRow {
  if (!parsedRow) return yamlRow;

  let updated: DecisionRow = yamlRow;
  const effectiveYaml = yamlRow.override ?? yamlRow["ai-default"];

  if (parsedRow.value !== undefined && parsedRow.value !== effectiveYaml) {
    // Override path: ai-default stays, override gets set/updated, status flips.
    if (parsedRow.value === yamlRow["ai-default"]) {
      // Parsed value matches the AI default — clear any prior override.
      updated = { ...updated, status: "applied" };
      delete (updated as Partial<DecisionRow>).override;
    } else {
      updated = {
        ...updated,
        override: parsedRow.value,
        status: "overridden",
      };
    }
    report.defaultsOverridden.push({
      id: yamlRow.id,
      from: effectiveYaml,
      to: parsedRow.value,
    });
  }

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

Note `parsedRow.value` — we're renaming `parsedRow.default` → `parsedRow.value` in `lib/decisions-parser.ts` (Task 3) to avoid the misleading name. Confirm the import name remains `ParsedDecisionRow`.

- [ ] **Step 2: Update sync tests**

In `test/lib/decisions-sync.test.ts`, rewrite fixtures:
- All YAML rows use `"ai-default":` key.
- All `ParsedDecisionRow` literals use `value:` instead of `default:`.
- Add a case: gdoc value matches yaml ai-default → row reverts to status=applied with override cleared.

- [ ] **Step 3: Run sync tests**

```bash
npx vitest run test/lib/decisions-sync.test.ts
```

Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add lib/decisions-sync.ts test/lib/decisions-sync.test.ts
git commit -m "feat(decisions): sync writes to override field; ai-default is immutable"
```

---

### Task 3: Update `lib/decisions-parser.ts`

**Files:**
- Modify: `lib/decisions-parser.ts`
- Modify: `test/lib/decisions-parser.test.ts`

- [ ] **Step 1: Rename ParsedDecisionRow field + add Override label parsing**

```typescript
export type ParsedDecisionRow = {
  id: string;
  value?: string;      // renamed from `default`
  options_considered?: string[];
};
```

In the body of `parseDocumentStructure`, replace the literal `"Default: "` scan with a scan that accepts EITHER `"AI-default: "` or `"Override: "` and sets `row.value` to whichever appears LAST in the section (override wins because the renderer emits it after AI-default). Use two-pass: read both lines, pick override if present, else AI-default.

Simplest path: track both `aiDefault` and `override` locally, then `row.value = override ?? aiDefault` when committing the section.

```typescript
type Acc = {
  id: string;
  aiDefault?: string;
  override?: string;
  considered?: string[];
};

// In the loop:
const AI_DEFAULT_RE = /^AI-default:\s*(.*)$/;
const OVERRIDE_RE = /^Override:\s*(.*)$/;
const m1 = text.match(AI_DEFAULT_RE);
if (m1) { acc.aiDefault = m1[1].trim(); continue; }
const m2 = text.match(OVERRIDE_RE);
if (m2) { acc.override = m2[1].trim(); continue; }

// On commit:
const value = acc.override ?? acc.aiDefault;
rows.push({ id: acc.id, value, options_considered: acc.considered });
```

- [ ] **Step 2: Update parser tests**

In `test/lib/decisions-parser.test.ts`:
- Replace all `"Default: "` strings in test inputs with `"AI-default: "`.
- Add a test where input has both `"AI-default: "` and `"Override: "` lines — assert `value === <override>`.
- Replace assertions checking `row.default` with `row.value`.

- [ ] **Step 3: Run parser tests**

```bash
npx vitest run test/lib/decisions-parser.test.ts
```

Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add lib/decisions-parser.ts test/lib/decisions-parser.test.ts
git commit -m "feat(decisions): parser handles AI-default + Override labels; row field renamed to value"
```

---

### Task 4: Update `lib/decisions-renderer.ts`

**Files:**
- Modify: `lib/decisions-renderer.ts`
- Modify: `test/lib/decisions-renderer.test.ts`

- [ ] **Step 1: Render AI-default + Override + drop open emphasis**

In `lib/decisions-renderer.ts`, where the current renderer emits the `"Default: "` line, change to `"AI-default: "`. When `row.override` is present, emit a SECOND line immediately below: `"Override: <override>"`.

Remove any code path that emphasizes `status: open` rows (the comment header says "OPEN gets emphasis"). The status enum no longer contains `open`.

The status line continues to read `"Status: applied"` or `"Status: overridden"`. No emphasis needed.

- [ ] **Step 2: Update renderer tests**

In `test/lib/decisions-renderer.test.ts`:
- Rewrite the existing `status: open` test (line ~100) — remove the test entirely, since `open` is no longer valid. Validation now rejects it; the renderer never sees one.
- Update text-content assertions: `"AI-default: "` instead of `"Default: "`.
- Add a test: row with `override:` set renders both `AI-default: <x>` AND `Override: <y>` lines, in that order, each as its own paragraph.

- [ ] **Step 3: Run renderer tests**

```bash
npx vitest run test/lib/decisions-renderer.test.ts
```

Expected: all green.

- [ ] **Step 4: Run all lib tests**

```bash
npx vitest run test/lib/decisions-*.test.ts
```

Expected: all four files green.

- [ ] **Step 5: Commit**

```bash
git add lib/decisions-renderer.ts test/lib/decisions-renderer.test.ts
git commit -m "feat(decisions): renderer emits AI-default + Override labels"
```

---

### Task 5: Update YAML fixtures used by skill tests

**Files:**
- Modify: `test/skills/idea-to-pdd/fixtures/turmeric-decisions.yaml`
- Modify: `test/skills/pdd-to-work-order-qa/fixtures/good-decisions.yaml`
- Modify: `test/skills/pdd-to-work-order-qa/fixtures/missing-wo-decisions.yaml`
- Modify: `test/skills/pdd-to-work-order-qa/fixtures/gdoc-decisions.txt` (if applicable)

- [ ] **Step 1: Mechanical replace across YAML fixtures**

In each `*.yaml` fixture file:
1. `schema_version: 1` → `schema_version: 2`
2. Every `    default: <value>` line → `    ai-default: <value>`
3. Any row with `status: open` → `status: applied` (the row gains no new fields; `open` collapses into `applied`).

Verify no row has both `status: overridden` AND no `override:` field after the rewrite. If any do, add an explicit `override: <prior-default-value>` and move the original `default:` value to `options_considered` if it isn't already there.

- [ ] **Step 2: Update gdoc text fixtures**

In `test/skills/pdd-to-work-order-qa/fixtures/gdoc-decisions.txt` (and any sibling gdoc text fixtures): rename `"Default: "` lines to `"AI-default: "`. If any row's status is `overridden`, add an `"Override: <value>"` line immediately below the AI-default line.

- [ ] **Step 3: Run affected skill tests**

```bash
npx vitest run test/skills/idea-to-pdd test/skills/pdd-to-work-order-qa test/skills/decisions-sync test/skills/decisions-render
```

Expected: all green. If any test fails because the fixture renaming missed something, fix the fixture (not the test).

- [ ] **Step 4: Commit**

```bash
git add test/skills/
git commit -m "test: migrate decisions fixtures to schema v2 (ai-default + drop open)"
```

---

### Task 6: Write the Drive migration doc + script

**Files:**
- Create: `migrations/0.13.X-decisions-v2.md` (replace X with the actual next-patch version)
- Create: `scripts/migrate-decisions-v2.ts`

- [ ] **Step 1: Determine next version**

```bash
cat VERSION
```

Note the current version. The migration filename uses the version this PR ships under. We'll bump it in Task 9; for now use a placeholder `0.13.NEXT` in the filename and fix once VERSION is bumped.

- [ ] **Step 2: Write the migration doc**

Create `migrations/0.13.NEXT-decisions-v2.md`:

```markdown
# Migration: 0.13.NEXT — decisions schema v2

**Date:** 2026-05-22

## What changed

- `decisions.yaml` schema version bumped from 1 to 2.
- Per-row field rename: `default:` → `ai-default:`.
- Per-row optional field added: `override:` (populated only when status=overridden).
- Status enum: `open` removed. Old `open` rows fold into `applied`.

## Action required

Once: run `npx tsx scripts/migrate-decisions-v2.ts` against the live Drive
tree. The script walks `ACE/*/runs/*/decisions.yaml`, rewrites each file
in place, and prints a per-file report. Idempotent — files already at v2
are skipped.

For each row:
1. Rename `default:` key → `ai-default:`.
2. If `status: open` → set `status: applied`.
3. Bump `schema_version: 1` → `2`.
4. If existing row had status=overridden, the prior YAML had the
   override value in `default:`. We can't recover the original
   AI-default from a v1 file (it was destroyed at override time and
   pushed into options_considered). Migration policy: keep the
   overridden value in the new `ai-default:` field AND keep
   status=overridden, but ALSO set `override:` to the same value (the
   audit trail is lossy for pre-migration overrides; this is
   acceptable since the renderer + UI now show both fields the same).
   A FYI line is printed for each such row so the operator knows
   which to manually re-edit if they want the original AI-default
   restored from `options_considered`.

## In-flight runs

Runs mid-`/ace:run` when this lands: the orchestrator reads
`decisions.yaml` on every phase. If the file is post-migration but the
plugin version is pre-migration, validation fails. Always run
`/ace:update` before continuing a run after this version ships.

## Rollback

Restore Drive folder from snapshot. There's no programmatic downgrade —
the schema-v2 → v1 conversion would have to guess where v1's `default:`
should land (`ai-default` or the now-removed `override`), and there's
no reliable rule.
```

- [ ] **Step 3: Write the migration script**

Create `scripts/migrate-decisions-v2.ts`:

```typescript
/**
 * One-shot migration: rewrite every ACE/<opp>/runs/<run-id>/decisions.yaml
 * on Drive from schema v1 to v2.
 *
 * v1 row:                            v2 row (applied):
 *   default: "X"            →          ai-default: "X"
 *   status: applied                    status: applied
 *
 * v1 row (open):                     v2 row:
 *   default: "X"            →          ai-default: "X"
 *   status: open                       status: applied
 *
 * v1 row (overridden):               v2 row (best-effort; lossy):
 *   default: "Y" (was the human       ai-default: "Y"
 *                value, original AI    override: "Y"
 *                value lost into       status: overridden
 *                options_considered)
 *
 * Run:
 *   npx tsx scripts/migrate-decisions-v2.ts [--dry-run]
 *
 * Idempotent: v2 files are skipped.
 */
import { google } from "googleapis";
import yaml from "yaml";
// ... (use the existing Drive auth helper used by other scripts/*.ts)
```

Full skeleton:

```typescript
import { listDecisionsFiles, fetchYaml, writeYaml } from "./_drive-helpers.js";

interface V1Row {
  id: string;
  phase: string;
  skill: string;
  question: string;
  default: string;
  options_considered: string[];
  source: string;
  status: "applied" | "overridden" | "open";
  notes?: string;
}

interface V1Log {
  schema_version: 1;
  opportunity: string;
  run_id: string;
  generated_at: string;
  decisions: V1Row[];
}

interface V2Row {
  id: string;
  phase: string;
  skill: string;
  question: string;
  "ai-default": string;
  override?: string;
  options_considered: string[];
  source: string;
  status: "applied" | "overridden";
  notes?: string;
}

interface V2Log {
  schema_version: 2;
  opportunity: string;
  run_id: string;
  generated_at: string;
  decisions: V2Row[];
}

function migrateRow(r: V1Row): V2Row {
  const status: "applied" | "overridden" =
    r.status === "open" ? "applied" : r.status;
  const v2: V2Row = {
    id: r.id,
    phase: r.phase,
    skill: r.skill,
    question: r.question,
    "ai-default": r.default,
    options_considered: r.options_considered,
    source: r.source,
    status,
  };
  if (status === "overridden") {
    v2.override = r.default;
  }
  if (r.notes !== undefined) v2.notes = r.notes;
  return v2;
}

function migrateLog(v1: V1Log): V2Log {
  return {
    schema_version: 2,
    opportunity: v1.opportunity,
    run_id: v1.run_id,
    generated_at: v1.generated_at,
    decisions: v1.decisions.map(migrateRow),
  };
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const files = await listDecisionsFiles();
  for (const f of files) {
    const raw = await fetchYaml(f.id);
    const parsed = yaml.parse(raw);
    if (parsed?.schema_version === 2) {
      console.log(`SKIP ${f.path} (already v2)`);
      continue;
    }
    if (parsed?.schema_version !== 1) {
      console.log(`SKIP ${f.path} (unknown version ${parsed?.schema_version})`);
      continue;
    }
    const v2 = migrateLog(parsed as V1Log);
    const out = yaml.stringify(v2, { lineWidth: 0, aliasDuplicateObjects: false });
    if (dryRun) {
      console.log(`DRY-RUN would rewrite ${f.path}`);
    } else {
      await writeYaml(f.id, out);
      console.log(`REWROTE ${f.path}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
```

The `_drive-helpers.js` import refers to a small helper file we'll create only if no equivalent exists. Check first:

```bash
ls scripts/ | grep -i drive
```

If a Drive helper already exists (e.g. `decisions-sync.ts` does Drive reads), refactor the helper functions out of it into `scripts/_drive-helpers.ts` for reuse. Otherwise inline the auth + Drive calls directly into `migrate-decisions-v2.ts` modeled on `scripts/decisions-sync.ts`.

- [ ] **Step 4: Commit (script + doc)**

```bash
git add scripts/migrate-decisions-v2.ts migrations/0.13.NEXT-decisions-v2.md
git commit -m "feat(decisions): migration script for schema v1→v2"
```

(Filename will be renamed to the actual version in Task 9.)

---

### Task 7: Update skill docs

**Files:**
- Modify: `skills/idea-to-pdd/SKILL.md`
- Modify: `skills/decisions-render/SKILL.md`
- Modify: `skills/decisions-sync/SKILL.md`
- Modify: `skills/fork-run/SKILL.md`

- [ ] **Step 1: `skills/idea-to-pdd/SKILL.md` — three sites**

- Line ~117: `material for each \`default\` value` → `material for each \`ai-default\` value`. Drop the sentence about `status: open` (since open is removed).
- Line ~125: `every numeric or named-entity in the PDD body should match the corresponding row's \`default\`` → `every numeric or named-entity in the PDD body should match the corresponding row's \`override\` if present else \`ai-default\``. Keep the "if a re-run reads…" continuation; reword the override sentence slightly to reflect the new override semantics.
- Line ~343: in the "Required fields per row" list, `\`question\`, \`default\`, \`options_considered\`` → `\`question\`, \`ai-default\`, optional \`override\`, \`options_considered\``.
- The "Status values" subsection: drop the `open` bullet entirely. Update `applied` description to "default in use; the AI's best inference from source material" (unchanged). Update `overridden` to "human edited via renderer + sync skills; the override value is stored in the `override:` field, AI default preserved in `ai-default:`".
- The "Status: `open` policy" subsection (lines ~355–366): delete entirely.

- [ ] **Step 2: `skills/decisions-render/SKILL.md`**

In the section that describes the gdoc layout (the comment block in `lib/decisions-renderer.ts` itself describes it; the SKILL doc should match): mention that each row now renders `AI-default:` and (when present) `Override:`. The "Status: open" emphasis line is gone.

- [ ] **Step 3: `skills/decisions-sync/SKILL.md`**

Line ~25: rewrite the `Products` bullet:

```markdown
- `ACE/<opp-name>/runs/<run-id>/decisions.yaml` — updated in place. Rows where the human changed the effective value get `status: overridden` and the new value stored in `override:` (the original `ai-default:` is preserved). New `Considered:` bullets are appended.
```

Change report example: replace `Default: <old> → <new>` with `Value: <old> → <new>` since the field rename is internal — the report describes the effective change.

- [ ] **Step 4: `skills/fork-run/SKILL.md`**

Rewrite the `Inputs` section's `mode` description:

```markdown
- `mode` (required) — one of:
  - `keep-overrides-only` — copies upstream-of-fork step folders + `run_state.yaml` + a FILTERED `decisions.yaml` containing only rows where `status == overridden` and `phase < fork-phase`. AI defaults from upstream are dropped so downstream phases re-derive them.
  - `keep-all` — same as `keep-overrides-only` but the `decisions.yaml` filter keeps ALL upstream rows regardless of status. Use when you want full continuity.

Both modes require `feedback` (non-empty free-text explaining the reason for the fork; recorded in the new run's working-session as the seed user message).
```

Drop the `empty` mode + `with-feedback` mode references. In the error-code list, `code: invalid-mode` now means "not one of keep-overrides-only/keep-all"; the rest is unchanged.

Update the `## Known issues` section: both the run-id format and `state.yaml` rename are now ace-web-side fixed (they shipped 2026-05-14 per `apps/opps/fork.py` docstring). Replace with a one-paragraph "Known issues: none open against current ace-web. Filed: …" or delete the section.

- [ ] **Step 5: Commit**

```bash
git add skills/idea-to-pdd/SKILL.md skills/decisions-render/SKILL.md skills/decisions-sync/SKILL.md skills/fork-run/SKILL.md
git commit -m "docs(skills): decisions schema v2 + fork mode rename"
```

---

### Task 8: Run full test suite

- [ ] **Step 1: Run vitest end-to-end**

```bash
npm test
```

Expected: all green. If anything outside the decisions code path fails, it's a regression — fix at the source. Common suspects:
- `test/mcp/registration-coverage.test.ts` snapshot count (unrelated, but bump if tools changed).
- Any test that reads `decisions.yaml` indirectly via skills.

- [ ] **Step 2: Commit if any test-only fixups landed**

```bash
git status   # check for residual changes
git add -A
git commit -m "test: residual fixups for decisions schema v2" || true
```

---

### Task 9: Version bump + PR

- [ ] **Step 1: Bump VERSION**

```bash
bash scripts/version-bump.sh --rebase-first
```

This script handles VERSION + plugin.json + marketplace.json + package.json atomically and rebases against origin/main.

- [ ] **Step 2: Rename migration file**

The migration file was created as `0.13.NEXT-decisions-v2.md`. Rename to the actual version:

```bash
NEW_VERSION=$(cat VERSION)
git mv migrations/0.13.NEXT-decisions-v2.md "migrations/${NEW_VERSION}-decisions-v2.md"
```

Update any references to the old filename in the migration doc body and skill docs (grep `0.13.NEXT`).

- [ ] **Step 3: Commit + push**

```bash
git add migrations/
git commit -m "chore: rename migration file to ${NEW_VERSION}"
git push -u origin HEAD
```

- [ ] **Step 4: Open PR + arm auto-merge**

```bash
gh pr create \
  --title "feat(decisions): schema v2 + fork mode rename (keep-overrides-only / keep-all)" \
  --body "$(cat <<'EOF'
## Summary
- Bumps decisions schema to v2. Renames `default:` → `ai-default:`, adds optional `override:`, drops `open` from status enum.
- Updates parser/renderer/sync libs + all decisions fixtures.
- Ships `scripts/migrate-decisions-v2.ts` for one-shot Drive rewrite.
- Updates `fork-run` skill doc to describe new modes (`keep-overrides-only`, `keep-all`); actual fork-endpoint changes ship separately in ace-web.

Design: `docs/superpowers/specs/2026-05-22-fork-decisions-modes-design.md`
Plan: `docs/superpowers/plans/2026-05-22-fork-decisions-modes.md`

## Test plan
- [x] `npm test` green
- [ ] After merge: run `npx tsx scripts/migrate-decisions-v2.ts --dry-run` against live Drive; review report; then run without --dry-run.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"

PR=$(gh pr list --head "$(git branch --show-current)" --json number --jq '.[0].number')
gh pr merge "$PR" --auto --merge
```

- [ ] **Step 5: Wait for merge + `/ace:update`**

After the PR lands (auto-merge fires once `clean-install` passes), back in this session:

```
/ace:update
```

This pulls the merged code into the running plugin cache so subsequent commands run on the new version. MCP code didn't change, so no Claude restart needed.

---

## Operator step (between PRs): run the migration

This is NOT a code task — operator-driven.

- [ ] Run `npx tsx scripts/migrate-decisions-v2.ts --dry-run` from a session where the Drive auth is live. Inspect the report.
- [ ] Run without `--dry-run`. Confirm files now show `schema_version: 2` and `ai-default:` keys when spot-checked.

Once Drive is migrated, PR 2 can land safely.

---

## PR 2: ace-web — fork.py + ForkDialog

Files in the ace-web sibling repo at `~/emdash-projects/ace-web/`.

### Task 10: Refactor `apps/opps/fork.py` mode handling

**Files:**
- Modify: `~/emdash-projects/ace-web/apps/opps/fork.py`

- [ ] **Step 1: Update mode validation**

In `fork_run()`:

```python
ALLOWED_MODES = ("keep-overrides-only", "keep-all")

if mode not in ALLOWED_MODES:
    raise ForkError("invalid-mode", f"invalid mode {mode!r}")
if not feedback:
    raise ForkError("feedback-required", "feedback is required for all forks")
```

Remove the `if mode == "with-feedback" and not feedback` branch.

- [ ] **Step 2: Always copy artifacts + run_state.yaml**

Today the with-feedback branch does this and the empty branch writes a minimal `run_state.yaml`. Replace the if/else with the with-feedback path unconditionally:

```python
_copy_upstream_steps(
    drive=drive,
    src_run=src_run,
    dst_run_folder_id=new_run_folder_id,
    fork_ordinal=fork_ordinal,
)
src_state = next(
    (
        f for f in drive.list_files(src_run.id)
        if f.name == "run_state.yaml"
    ),
    None,
)
if src_state is not None:
    content = drive.get_content(src_state.id, src_state.mime_type).content
    drive.upload_file(
        new_run_folder_id, "run_state.yaml", content,
        src_state.mime_type or "application/yaml",
    )
_copy_filtered_decisions(
    drive=drive,
    src_run=src_run,
    dst_run_folder_id=new_run_folder_id,
    fork_ordinal=fork_ordinal,
    mode=mode,
)
```

- [ ] **Step 3: Add `_copy_filtered_decisions` helper**

```python
def _copy_filtered_decisions(
    *,
    drive: DriveClient,
    src_run: DriveFile,
    dst_run_folder_id: str,
    fork_ordinal: int,
    mode: str,
) -> None:
    """Copy decisions.yaml from source run to destination, filtering rows
    by mode. Rows with phase ordinal >= fork_ordinal are always dropped
    (those phases will re-run). In `keep-overrides-only` mode, only
    `status: overridden` rows are kept among the upstream rows."""
    import re
    import yaml

    src_decisions = next(
        (
            f for f in drive.list_files(src_run.id)
            if f.name == "decisions.yaml"
        ),
        None,
    )
    if src_decisions is None:
        return  # source run never wrote decisions.yaml; nothing to copy.

    raw = drive.get_content(src_decisions.id, src_decisions.mime_type).content
    text = raw.decode("utf-8") if isinstance(raw, (bytes, bytearray)) else raw
    log = yaml.safe_load(text) or {}
    rows = log.get("decisions", [])

    phase_re = re.compile(r"^([1-9][0-9]*)-")
    filtered = []
    for r in rows:
        m = phase_re.match(str(r.get("phase", "")))
        if not m:
            continue
        if int(m.group(1)) >= fork_ordinal:
            continue
        if mode == "keep-overrides-only" and r.get("status") != "overridden":
            continue
        filtered.append(r)

    log["decisions"] = filtered
    out = yaml.safe_dump(log, sort_keys=False)
    drive.upload_file(
        dst_run_folder_id, "decisions.yaml", out, "application/yaml",
    )
```

- [ ] **Step 4: Update the seeded user message**

In the `transaction.atomic()` block, the user message is always the "feedback" variant now:

```python
user_text = (
    f"Rerun /ace:step {from_skill} for {slug} ({mode} fork) "
    f"with feedback: {feedback}"
)
user_source = "opps-fork-feedback"
```

Drop the `if mode == "with-feedback"` branch + the empty-fork user_text.

- [ ] **Step 5: Update module docstring**

The first docstring paragraph describes the two old modes. Rewrite:

```python
"""Fork a run: create a new run folder, copy artifacts upstream of the
fork point, create a new working session seeded with feedback.

Both modes copy upstream-of-fork step folders + run_state.yaml + a
filtered decisions.yaml. They differ only in decisions filtering:

- keep-overrides-only: only `status: overridden` rows upstream of fork
  carry forward. AI defaults are dropped so downstream phases re-derive.
- keep-all: all upstream rows carry forward regardless of status.

Rows at or downstream of the fork-phase are always dropped — those
phases re-run and re-append their own decisions.
...
"""
```

- [ ] **Step 6: Commit**

```bash
cd ~/emdash-projects/ace-web
git checkout -b fork-decisions-modes
git add apps/opps/fork.py
git commit -m "feat(opps): fork modes keep-overrides-only / keep-all"
```

---

### Task 11: Update fork tests

**Files:**
- Modify: `~/emdash-projects/ace-web/apps/opps/tests/test_fork.py`

- [ ] **Step 1: Replace mode-specific tests**

Rewrite the test functions. Use the patterns from the existing tests; only mode values + assertions change.

- `test_fork_with_feedback_creates_new_run` → `test_fork_keep_all_creates_new_run` with `"mode": "keep-all"`. Assertions unchanged except: also verify the new run's `decisions.yaml` exists (the fixture's source run must have one — add it to `malaria_pilot_structured_tree()` if absent; see Step 2).
- `test_fork_empty_creates_minimal_run` → delete. Empty mode is gone.
- `test_fork_with_feedback_requires_feedback` → `test_fork_requires_feedback`. Use `"mode": "keep-all"` without a `feedback` key; expect 400 `feedback-required`. Add a second case for `"mode": "keep-overrides-only"` ditto.
- `test_fork_unknown_skill_returns_404` → unchanged in structure; update mode value to `"keep-all"`.

Add three new tests:

```python
def test_fork_invalid_mode_returns_400(authed_client, seeded_opp):
    fake = seeded_opp
    with _patches(fake):
        resp = authed_client.get("/api/opps/malaria-pilot")
        run_id = resp.json()["data"]["current_run"]["run_id"]
        from_skill = resp.json()["data"]["current_run"]["steps"][0]["skill_name"]
        resp = authed_client.post(
            f"/api/opps/malaria-pilot/runs/{run_id}/fork",
            data=json.dumps({
                "from_skill": from_skill,
                "mode": "with-feedback",  # legacy mode — now rejected
                "feedback": "x",
            }),
            content_type="application/json",
        )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "invalid-mode"


def test_fork_keep_overrides_only_filters_to_overridden(authed_client, seeded_opp):
    """Source run's decisions.yaml has a mix of applied + overridden rows.
    keep-overrides-only fork copies ONLY the overridden ones."""
    fake = seeded_opp
    # ... (depends on fixture having a decisions.yaml with mixed statuses;
    # see Step 2 for the fixture update)
    with _patches(fake):
        resp = authed_client.get("/api/opps/malaria-pilot")
        snap = resp.json()["data"]
        run_id = snap["current_run"]["run_id"]
        from_skill = snap["current_run"]["steps"][-1]["skill_name"]
        resp = authed_client.post(
            f"/api/opps/malaria-pilot/runs/{run_id}/fork",
            data=json.dumps({
                "from_skill": from_skill,
                "mode": "keep-overrides-only",
                "feedback": "wipe ai defaults",
            }),
            content_type="application/json",
        )
    assert resp.status_code == 201
    new_run_id = resp.json()["data"]["new_run_id"]

    runs_id = fake.folder_id("ACE/malaria-pilot/runs")
    new_run_folder_id = next(
        f.id for f in fake.list_files(runs_id) if f.name == new_run_id
    )
    decisions_file = next(
        (f for f in fake.list_files(new_run_folder_id) if f.name == "decisions.yaml"),
        None,
    )
    assert decisions_file is not None
    import yaml as _y
    raw = fake.get_content(decisions_file.id, decisions_file.mime_type).content
    parsed = _y.safe_load(raw.decode("utf-8") if isinstance(raw, (bytes, bytearray)) else raw)
    statuses = {r["status"] for r in parsed["decisions"]}
    assert statuses == {"overridden"}, parsed["decisions"]


def test_fork_keep_all_preserves_all_upstream_decisions(authed_client, seeded_opp):
    """keep-all fork copies every upstream-of-fork row regardless of status."""
    fake = seeded_opp
    # similar to above but assert at least one row is applied AND at least one is overridden
    # ... use seeded_opp's fixture decisions
```

- [ ] **Step 2: Update fixture `malaria_pilot_structured_tree()`**

In `~/emdash-projects/ace-web/apps/opps/tests/fixtures/fake_drive.py` (or wherever the fixture builder lives), ensure the source run has a `decisions.yaml` file with at least:
- Two rows in an upstream phase (phase ordinal < the last step's ordinal): one `status: applied`, one `status: overridden` (with an `override:` field).
- One row at or downstream of the last step's phase to verify the downstream-drop behavior.

If the fixture builder doesn't already write decisions.yaml, add a small block:

```python
DECISIONS_FIXTURE = """schema_version: 2
opportunity: malaria-pilot
run_id: 2026-04-06-002
generated_at: "2026-04-06T00:00:00Z"
decisions:
  - id: bed-net-color
    phase: 1-design
    skill: idea-to-pdd
    question: What color of bed net?
    ai-default: blue
    options_considered: [blue, green]
    source: idea.md
    status: applied
  - id: flw-count
    phase: 1-design
    skill: idea-to-pdd
    question: How many FLWs?
    ai-default: "5-8"
    override: "12"
    options_considered: ["5-8", "12", "20+"]
    source: idea.md
    status: overridden
  - id: downstream-decision
    phase: 6-qa-and-training
    skill: app-test-cases
    question: How many test prompts?
    ai-default: "10"
    options_considered: ["10", "20"]
    source: pdd
    status: applied
"""
```

…and have the builder upload it into the source run folder.

- [ ] **Step 3: Run tests**

```bash
cd ~/emdash-projects/ace-web
pytest apps/opps/tests/test_fork.py -v
```

Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add apps/opps/tests/
git commit -m "test(opps): fork modes — keep-overrides-only + keep-all"
```

---

### Task 12: Update `ForkDialog.tsx`

**Files:**
- Modify: `~/emdash-projects/ace-web/frontend/src/components/opps/ForkDialog.tsx`

- [ ] **Step 1: Replace radio options**

```tsx
const [mode, setMode] = useState<"keep-overrides-only" | "keep-all">("keep-all");
```

In the JSX, replace the two existing radio blocks with:

```tsx
<label className="flex items-start gap-2 text-sm">
  <input
    type="radio"
    checked={mode === "keep-all"}
    onChange={() => setMode("keep-all")}
    className="mt-1"
  />
  <div>
    <div>Keep all decisions</div>
    <div className="text-xs text-muted-foreground">
      Upstream artifacts copied. All decisions made so far carry forward — both AI defaults and your overrides.
    </div>
  </div>
</label>
<label className="flex items-start gap-2 text-sm">
  <input
    type="radio"
    checked={mode === "keep-overrides-only"}
    onChange={() => setMode("keep-overrides-only")}
    className="mt-1"
  />
  <div>
    <div>Keep only my overrides</div>
    <div className="text-xs text-muted-foreground">
      Upstream artifacts copied. Only your explicit overrides carry forward; AI defaults are dropped so phases can re-derive them.
    </div>
  </div>
</label>
```

The feedback textarea is no longer conditionally rendered — show it always. Required for both modes:

```tsx
<textarea
  value={feedback}
  onChange={(e) => setFeedback(e.target.value)}
  rows={4}
  placeholder="What should change about this step's output?"
  className="rounded border border-border bg-card p-2 text-xs"
/>
```

Update `canSubmit`:

```tsx
const canSubmit = !busy && feedback.trim().length > 0;
```

- [ ] **Step 2: Update the `forkRun` API call**

The `mode` field is still a string; no shape change. Just ensure the TypeScript type passed matches the new union.

- [ ] **Step 3: Manual test (visual + happy-path)**

Run the dev server and open a fork dialog:

```bash
cd ~/emdash-projects/ace-web
# whatever the standard dev-server command is for ace-web
```

Verify the two radio labels render with the new copy and the feedback box is always visible. Submit a keep-all fork against a real opp's run and confirm 201 + redirect.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/opps/ForkDialog.tsx
git commit -m "feat(ui): fork dialog with keep-overrides-only / keep-all modes"
```

---

### Task 13: PR + merge (ace-web)

- [ ] **Step 1: Push + PR**

```bash
cd ~/emdash-projects/ace-web
git push -u origin fork-decisions-modes
gh pr create \
  --title "feat(opps): fork modes — keep-overrides-only / keep-all + decisions filter" \
  --body "$(cat <<'EOF'
## Summary
- Replaces fork modes `with-feedback`/`empty` with `keep-overrides-only`/`keep-all`. Both copy artifacts; differ in how `decisions.yaml` is filtered.
- Always require `feedback` (matches today's with-feedback behavior).
- Adds `_copy_filtered_decisions` helper applying phase-ordinal + status filter.
- Updates `ForkDialog.tsx` with new radio options + always-visible feedback box.
- Pairs with ACE plugin schema v2 (already merged) — assumes Drive `decisions.yaml` files are post-migration.

## Test plan
- [x] `pytest apps/opps/tests/test_fork.py` green
- [ ] Manual: fork an opp via the dialog with `keep-all`; verify new run has full `decisions.yaml`.
- [ ] Manual: fork with `keep-overrides-only`; verify new `decisions.yaml` contains only `status: overridden` rows.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 2: Arm auto-merge if applicable**

If ace-web has the same auto-merge convention:

```bash
PR=$(gh pr list --head fork-decisions-modes --json number --jq '.[0].number')
gh pr merge "$PR" --auto --merge
```

Otherwise wait for human review.

---

## Self-review

- **Spec coverage**: all four spec sections (schema, modes, surface area, roll-out) have tasks. ✓
- **Placeholders**: `0.13.NEXT` filename placeholder is intentional (resolved in Task 9 step 2). No other TBDs. ✓
- **Type consistency**: `ParsedDecisionRow.default` renamed to `ParsedDecisionRow.value` in Task 3; consumer (`mergeRow` in Task 2) reads `parsedRow.value`. ✓
- **Function/method consistency**: `_copy_filtered_decisions` defined in Task 10 Step 3, called in Step 2. ✓
- **Task ordering**: schema before consumers; libs before fixtures; fixtures before full test run; version bump after all changes. ✓
