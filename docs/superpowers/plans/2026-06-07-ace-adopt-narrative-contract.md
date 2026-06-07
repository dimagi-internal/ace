# ACE Adopts the Narrative Contract — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use `- [ ]`.

**Goal:** Make ACE (the plugin + ace-web) consume the canonical narrative/eval contract instead of hand-maintained copies — generate TS types from canopy's published JSON Schema, and have the ACE video skills *invoke* canopy's validators + `visual-judge` rather than reimplementing the methodology.

**Architecture:** Vendor canopy's canonical narrative JSON Schema into each ACE repo and generate TS types from it (so `lib/verdict-schema.ts` and the new `narrative`/`evidence`/`gap` types are generated, not written). Wire the video authoring skills to call the canopy Python validators via CLI and `canopy:visual-judge` per beat — the "orchestrate canopy capabilities on top" model.

**Tech Stack:** TypeScript (ACE plugin `lib/`, ace-web `frontend/`), Python (ace-web Django `apps/videos`), Markdown skills. `json-schema-to-typescript` for codegen.

**DEPENDS ON:** `2026-06-07-canopy-narrative-substrate.md` landed in `jjackson/canopy` — i.e. the canonical schema exists at `scripts/narrative/schema/json/` on canopy `main`. Do not start before that merges.

**Repos:** `jjackson/ace-web` (codegen + Django + frontend) and the ACE plugin (`lib/verdict-schema.ts`, video skills). Separate branches/PRs.

---

## Task 1: Generate `Verdict` + narrative TS types from the canopy schema (ACE plugin)

**Files:**
- Create: `scripts/sync-narrative-schema.sh` (vendor + codegen)
- Create: `lib/generated/narrative-contract.ts` (generated — gitignored-from-edits, committed)
- Modify: `lib/verdict-schema.ts` (re-export the generated `Verdict`; keep ACE-only helpers)
- Modify: `package.json` (devDep `json-schema-to-typescript`; `gen:narrative` script)

- [ ] **Step 1:** Add a sync script that copies the canopy JSON Schema into the ACE plugin and codegens TS. It resolves the canopy checkout the same way DDD skills do (`$HOME/emdash-projects/canopy` or the marketplace mirror):

```bash
#!/usr/bin/env bash
# scripts/sync-narrative-schema.sh — vendor canopy's canonical narrative
# JSON Schema and regenerate lib/generated/narrative-contract.ts.
set -euo pipefail
CANOPY="${CANOPY_REPO:-$HOME/emdash-projects/canopy}"
[ -d "$CANOPY/scripts/narrative/schema/json" ] || CANOPY="$HOME/.claude/plugins/marketplaces/canopy"
SRC="$CANOPY/scripts/narrative/schema/json"
[ -d "$SRC" ] || { echo "canopy narrative schema not found at $SRC — is the canopy substrate PR merged?"; exit 1; }
mkdir -p lib/generated/schema
cp "$SRC"/*.json lib/generated/schema/
# Codegen one barrel from the vendored schemas.
npx json-schema-to-typescript -i 'lib/generated/schema/*.json' -o lib/generated/narrative-contract.ts --bannerComment '// GENERATED from canopy scripts/narrative/schema/json — do not edit. Run npm run gen:narrative.'
echo "regenerated lib/generated/narrative-contract.ts"
```

Add to `package.json` scripts: `"gen:narrative": "bash scripts/sync-narrative-schema.sh"` and devDependency `json-schema-to-typescript`.

- [ ] **Step 2:** Run `npm run gen:narrative`; commit `lib/generated/`.

- [ ] **Step 3:** Replace the hand-written `Verdict` shape in `lib/verdict-schema.ts` with a re-export of the generated type, keeping any ACE-only helper functions:

```ts
// lib/verdict-schema.ts
export type { Verdict, Dimension } from "./generated/narrative-contract";
// ... keep ACE-specific helpers (e.g. verdict aggregation) below, now typed
// against the generated Verdict so they can't drift from the canonical shape.
```

- [ ] **Step 4:** `npm test` + `npx tsc --noEmit`. Fix any call sites where the generated `Verdict` field names differ from the old hand-written ones (this surfaces the drift the contract is meant to kill). **Commit.**

---

## Task 2: ace-web consumes the contract (frontend types + backend validation)

**Files:**
- Modify: `frontend/package.json` (extend the existing `gen:api` pattern with a `gen:narrative` step), `frontend/src/api/` (generated narrative types)
- Modify (optional): `apps/videos/` — validate stored narrative/verdict data against the JSON Schema (Python can `jsonschema`-validate or import canopy's pydantic if canopy is added as a dep)

- [ ] **Step 1:** Mirror Task 1's codegen in `frontend/` so the React side imports generated narrative/verdict/scene types (the review UI in Stage 5 consumes these). Commit the generated file.
- [ ] **Step 2 (optional):** In `apps/videos`, when storing a narrative/verdict run-package payload, validate it against the vendored JSON Schema (`jsonschema.validate`) so malformed AI output is rejected at the boundary — the same discipline canopy-web's `request_json` envelope relies on. **Commit.**

---

## Task 3: Wire the video skills to invoke canopy capabilities (ACE plugin)

**Files:**
- Modify: `skills/partnership-angles/SKILL.md`, `skills/video-spec-eval/SKILL.md` (and the per-beat eval path), and/or a new `skills/video-narrative/SKILL.md`

- [ ] **Step 1:** Where the video authoring flow today flags grounding via `[TBD]` + rubric prose, add a call to canopy's validators on the structured narrative — e.g. `(cd "$CANOPY" && uv run python -m scripts.ddd.narrative_coherence "$NARRATIVE_YAML")` and `... scripts.ddd.spec_qa ...` — and gate on the returned `Verdict` (resolve `$CANOPY` with the DDD-skill pattern). This gives the video pipeline the falsifiability + outcome-leakage + provenance checks for free.
- [ ] **Step 2:** Add a per-beat visual judge: after a render produces per-beat frames, dispatch `canopy:visual-judge` per beat with a video rubric (ACE Phase 6 already calls `visual-judge` — reuse that invocation shape). This closes the "eval judges narration text, never the frames" gap.
- [ ] **Step 3:** Update `test/skill-atom-references.test.ts` / skill docs as needed; run `npm test`. **Commit.**

---

## Done criteria
- `lib/verdict-schema.ts` (+ ace-web frontend) types are **generated** from canopy's JSON Schema; no hand-maintained duplicate `Verdict`.
- `npm run gen:narrative` reproducibly regenerates from the vendored schema; drift is impossible (regen + diff in CI).
- The video skills invoke canopy's `narrative_coherence` / `spec_qa` validators and `visual-judge` per beat, instead of duplicating the methodology in TS.

## Note
Keep a TS implementation ONLY for any validator that must run in-process in the Remotion render pipeline (per spec §4b); test it against fixtures generated from canopy's Python side so the two can't diverge.
