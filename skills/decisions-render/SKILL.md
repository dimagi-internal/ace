---
name: decisions-render
description: >
  Render a per-run decisions.yaml into a prose Google Doc at one stable
  URL per run. Invoked at end of every phase; idempotent.
disable-model-invocation: false
---

# Decisions Render

Read `decisions.yaml` from a run folder, render it as a prose Google Doc, and
write the result to `decisions.gdoc` at one stable URL.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Per-run state | `ACE/<opp-name>/runs/<run-id>/decisions.yaml` | the structured log to render |

## Products

- `ACE/<opp-name>/runs/<run-id>/decisions.gdoc` — prose Google Doc rendering at one stable URL. Find-or-update semantics; existing content is cleared and replaced on every invocation. Each row renders an `AI-default:` line and, when the row is overridden, an `Override:` line immediately below it. The status line is plain text (`Status: applied` or `Status: overridden`).

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
