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

1.5. **Enrich the log first — `decisions_enrich` (REQUIRED, schema v6).** The
   decisions log is the run's review artifact (the build memo is retired), and
   the parts of it with a right answer are computed, not left to the producers:

   ```
   mcp__plugin_ace_ace-decisions__decisions_enrich
     { runFolderId: "<run-folder file ID from step 1>" }
   ```

   It reads `decisions.yaml` + `run_state.yaml` from the folder and stamps
   rule `scope`/`enforcement`, `audience: internal` on harness rows, folds
   cross-skill duplicates, and marks `review_ask: recommended-confirmation` on
   every `PROPOSED` program parameter the build configured, every
   machine-translated language, every enforcement gap, every `OPEN` row and
   every open residual a person must decide (`docs/decisions-contract.md §
   What earns a review_ask`). Idempotent; writes only on change. Carry its
   `reviewAsks` list into the pause summary's `Decisions Log:` line ("N to
   confirm before launch"), and treat a non-empty `missingPlain` / `jargon` as
   a `[WARN]` naming the producer skill — the producer owes `plain` on every
   partner-facing row (`skills/_decisions-review-fields.md`).

2. **Render via the `render_decisions_log` atom** (the canonical, single-call
   path). Pass the run-folder file ID; the atom reads `decisions.yaml` from it,
   renders the prose log via `lib/decisions-renderer.ts`, and find-or-updates
   `decisions.gdoc` in the same folder — read + render + clear + batchUpdate all
   happen server-side, so you never relay the generated Docs API JSON yourself:

   ```
   mcp__plugin_ace_ace-gdrive__render_decisions_log
     { runFolderFileId: "<run-folder file ID from step 1>" }
   ```

   Returns `{ gdocId, reused, requestCount, webViewLink }`. Each row renders an
   `AI-default:` line, an `Override:` line when the row is overridden, and a
   plain `Status: applied | overridden` line (see § Products for the exact
   shape). The schema is validated server-side (`lib/decisions-schema.ts §
   parseDecisionsYaml`); a malformed row throws with its dot-path.

   - **Do NOT** hand-render the rows through `drive_create_doc_from_markdown`
     or hand-relay `renderDecisionsLog` output through `docs_batch_update` —
     that was the ~65KB-per-phase manual relay this atom replaces (jjackson/ace#574).
   - `scripts/decisions-render.ts` (`runDecisionsRender`) is the library the
     atom wraps; its `import.meta.url === ...` CLI branch is still intentionally
     unwired (it needs a live Drive client). Don't shell out to the script.

3. **Confirm the gdoc URL** from the atom's `webViewLink` field. The orchestrator captures this URL for the pause summary's `Decisions Log:` line.

## Failure modes

- **decisions.yaml is missing**: the script throws with the run folder ID; the orchestrator's Phase Write-Back Verifier should have already created an empty decisions.yaml before this skill runs. If it didn't, the skill halts and surfaces the missing-file error to the operator.
- **Schema-invalid YAML**: the script throws with the dot-path of the offending field. The originating skill (whichever phase wrote the bad row) gets a hard fail; orchestrator surfaces it in the pause summary's BLOCKER list.
- **Docs API rate limit**: rare — the renderer makes one batch update per phase. Retry once after 30s; halt with actionable error if it fails again.

## MCP Tools Used

- Google Drive: `drive_list_folder` (step 1, resolve run folder), `render_decisions_log` (step 2, the single-call render)
- ace-decisions: `decisions_enrich` (step 1.5, the deterministic v6 review fields)

## Mode Behavior

- **Auto:** Run, no human pause. Stdout includes the gdoc URL for downstream skills.
- **Review:** Same as Auto — the renderer is deterministic, no human review of the rendering itself.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-05-08 | Initial skill — pairs with `lib/decisions-renderer.ts` and `scripts/decisions-render.ts`. Renders decisions.yaml as a prose Google Doc; idempotent; runs at end of every phase. | ACE team (decisions-log PR #2) |
| 2026-05-31 | Canonical path is now the `render_decisions_log` MCP atom (wraps `runDecisionsRender` server-side) — one call with the run-folder file ID instead of hand-relaying ~65KB of `docs_batch_update` JSON per phase (jjackson/ace#574). | ACE team |
| 2026-09-06 | **Stop routing concerns to a gate brief that does not exist (dimagi-internal/ace#1884).** 0.13.116 removed the per-skill gate-brief file class and the ace#1880 sweep removed the remaining `*.md` PATHS, but prose directives naming the gate brief as a DESTINATION survived in 15 files — a concern "surfaced in the gate brief" is surfaced nowhere. Repointed at the verdict YAML's `auto_surfaced` block, which is what the orchestrator actually renders the pause summary from. Gated by the new destination check in `test/skills/gate-brief-removal-complete.test.ts`. | ACE team |
| 2026-10-03 | **Step 1.5: `decisions_enrich` before the render (schema v6).** The decisions log replaced the build memo as the review artifact; the enrichment computes rule scope/enforcement, harness `audience`, cross-skill dedupe and every derived `review_ask`, and the Doc now opens with "To confirm before launch". Contract: `docs/decisions-contract.md`. | ACE team |
