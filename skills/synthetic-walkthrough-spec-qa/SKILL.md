---
name: synthetic-walkthrough-spec-qa
description: >
  Structural QA on per-persona walkthrough spec YAMLs produced by
  synthetic-walkthrough-spec. Zod-schema primitive + cross-field checks.
  Binary pass/fail. Catches malformed specs before canopy:walkthrough.
disable-model-invocation: true
---

# Synthetic Walkthrough Spec QA

Structural correctness checks on
`7-synthetic/synthetic-walkthrough-spec_<persona>.yaml`, the per-persona
walkthrough specs authored by `synthetic-walkthrough-spec` and consumed
by `synthetic-walkthrough-run` → `canopy:walkthrough`.

`canopy:walkthrough` validates the spec at its boundary, but boundary
validation is slow + costly to discover (one full headless-browser run).
This QA gives faster failure + structured `auto_fix_hint` per check so
the orchestrator can drive a tight regen loop without spawning a
walkthrough.

Zod is the primary primitive — schema + cross-field invariants. All
checks are static, all run in <100ms via `checks.ts`. No LLM.

See `skills/_qa-template.md` for the shared QA contract (verdict YAML
format, auto-fix protocol, static-vs-LLM rules).

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 7 producer | `7-synthetic/synthetic-walkthrough-spec_<persona>.yaml` | the spec under structural check |

This QA runs once per persona-spec emitted (typically 2 — `prospective-llo`,
`funder` — plus any opp-overlay personas). The orchestrator dispatches
this skill per spec; QA results land alongside the spec they cover.

## Products

- `7-synthetic/synthetic-walkthrough-spec_<persona>-qa_result.yaml` — QA result per `lib/qa-types.ts`

## Checks

| # | id | type | description | auto-fix on fail |
|---|---|---|---|---|
| 1 | `spec_yaml_parses` | static | File parses as a YAML mapping | re-emit valid YAML — likely truncated mid-write or hand-edit broke quoting |
| 2 | `required_top_level_keys` | static | Top-level required keys: `name`, `narrative`, `base_url`, `personas`, `scenes` (`auth` is OPTIONAL per upstream — omit for public pages) | re-emit the spec with missing top-level keys; see synthetic-walkthrough-spec/SKILL.md step 4 for the canonical shape |
| 3 | `scenes_array_well_formed` | static | `scenes` is an array of ≥4 scenes; each scene has `persona`, `title`, `show`, `impressive_because` (`ai_quality` is OPTIONAL per upstream) | regenerate scenes with all required fields populated |
| 4 | `scene_personas_resolvable` | static | Every `scenes[].persona` matches a key in `personas` (canopy validation parity) | fix scene persona keys to match a key in `personas`, or add the persona |
| 5 | `ai_quality_assertions_falsifiable` | static | Each scene's `ai_quality` field is non-empty, non-trivial (not "looks good", not "the page should be nice"); references something concrete an AI judge can check (number, named element, threshold) | rewrite ai_quality assertions to be falsifiable (e.g. "KPI panel must show ≥3 named FLWs with archetype labels visible"); generic phrases get rejected |
| 6 | `persona_pain_points_documented` | static | Each persona under `personas` has `intro` (canopy uses this for scoring rubric anchoring); empty/missing intro fails | populate `personas[<key>].intro` with one sentence describing the persona's perspective and what they care about |
| 7 | `scene_titles_unique` | static | Across the spec's `scenes[]`, scene titles are unique (canopy uses titles as scene identifiers; collisions confuse the slideshow + score table) | rename colliding scene titles |

The static check functions live at `skills/synthetic-walkthrough-spec-qa/checks.ts` as importable TS. Every check returns a `QACheckResult` (`{pass, detail?, auto_fix_hint?}`) per `lib/qa-types.ts`.

**Adding a check:** append to the `CHECKS` array in `checks.ts`, add a row to the table above (matching `id`), add a unit test in `test/skills/synthetic-walkthrough-spec-qa/checks.test.ts`.

**Note on shape.** The "actions / expected / screenshots" shape sometimes used in canopy walkthrough specs maps onto the higher-level `scenes[]` contract canopy validates: each scene's `show` field describes what to capture, `impressive_because` is the expected wow, and `ai_quality` is the assertion. Per-scene screenshot uniqueness is achieved via scene-title uniqueness (canopy derives the screenshot filename from title) — check 7 covers it.

## Process

1. **Read the spec artifact** from Drive:
   `drive_read_file(file_id=<spec drive id>)`.

2. **Save to a local temp path** so the CLI runner can read it.
   `Bash: TMP=$(mktemp); drive content saved to $TMP`.

3. **Run all checks** via the generic CLI runner:
   `Bash: npx tsx scripts/qa-run.ts --skill synthetic-walkthrough-spec-qa --artifact "$TMP" --target "<opp-name>:<persona>" --capture-path "7-synthetic/synthetic-walkthrough-spec_<persona>.yaml"`.

   The runner imports `CHECKS` from `skills/synthetic-walkthrough-spec-qa/checks.ts`,
   runs each check via `lib/qa-runner.ts`, and prints a fully-shaped
   `QAResult` YAML to stdout.

4. **Write the QA result** to Drive at
   `7-synthetic/synthetic-walkthrough-spec_<persona>-qa_result.yaml` via
   `drive_create_file`.

5. **Return the verdict** to the orchestrator:
   - `pass` → walkthrough run can proceed
   - `fail` → orchestrator attempts auto-fix using `failures[].auto_fix_hint`; re-runs `synthetic-walkthrough-spec` then re-runs this skill
   - `incomplete` → spec missing entirely; halt with operator-actionable error

## Auto-fix protocol

See `skills/_qa-template.md § Auto-fix protocol` for the canonical contract. Briefly:

- Default 2 auto-fix attempts per QA run.
- On fail, orchestrator passes each `auto_fix_hint` to `synthetic-walkthrough-spec` with explicit "fix this and re-emit" instructions.
- Re-run QA after each attempt. If still failing after 2 attempts, halt with `verdict: incomplete` and surface the unresolved failures + hints.

QA is **necessary but not sufficient**. A passing QA result means the spec is structurally gradable, NOT that the walkthrough will be impressive — `synthetic-walkthrough-spec-eval` grades scene quality + persona-anchoring; canopy:visual-judge grades each rendered scene.

## MCP Tools Used

- Google Drive: `drive_read_file`, `drive_create_file`
- Bash: `npx tsx scripts/qa-run.ts ...` (runs static checks via `lib/qa-runner.ts`)

## Mode Behavior

- **Auto:** Run checks, write QA result, return verdict.
- **Review:** Same as Auto. QA is binary — there's no human pause-and-review step.

## Dry-Run Behavior

When `--dry-run` is active:
- All reads happen normally (read-only).
- The QA result IS written (it's an internal artifact, not an external comm).
- State tracks as `dry-run-success`.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-05-09 | Initial skill — closes the deferred has-QA row in `_qa-decisions.md` for `synthetic-walkthrough-spec`. Seven static checks anchored on a Zod schema mirror of the canopy:walkthrough spec contract: YAML parse, required top-level keys, scenes array shape (≥4 scenes with required fields), scene-persona resolvability, ai_quality falsifiability, persona intros documented, scene-title uniqueness. | ACE team |
| 2026-05-09 | **Cross-checked Zod against upstream** at `canopy/plugins/canopy/skills/walkthrough/SKILL.md § Walkthrough Spec Format` (canopy v0.2.87). Two drift fixes: (1) `auth` is OPTIONAL — upstream explicitly says "omit for public pages"; earlier draft put it in `REQUIRED_TOP_LEVEL_KEYS` and would have failed on every public-page walkthrough. (2) `scenes[].ai_quality` is OPTIONAL — example marks it `# optional`; earlier draft required it. Added a positive-case test for an `ai_quality`-omitted scene to lock in the contract. Also added discriminator check for `auth.type` (`url` or `command`) when `auth` is present. | ACE team |
