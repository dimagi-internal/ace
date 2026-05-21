---
name: program-input-sweep
description: >
  Read a messy working folder in Drive, compare its contents to a set of
  opportunity `inputs/` folders, and write a single review-friendly Google
  Doc proposing per-opp adds/replaces/removes plus net-new opps. Drives
  the `/ace:program-update` propose+apply flow. Lifecycle-adjacent — not
  part of `/ace:run`.
disable-model-invocation: true
---

# Program Input Sweep

A program team moves fast on a related set of opportunities (malaria EOIs, COVID interventions, etc.) — the working folder fills up, but each opp's `inputs/` lags behind. This skill diffs source against opp state and proposes the moves.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Operator | `<source-folder-id>` — Drive folder ID of the messy working folder | what to classify |
| Operator (optional) | one or more `<opp-slug>` args | which opps to sweep |
| Drive | `ACE_DRIVE_ROOT_FOLDER_ID` | discover candidate opps when no slugs given; verify slug collision when proposing `CREATE_OPP` |
| Drive | `ACE/<slug>/opp.yaml` for each target | classifier context — `display_name`, `tags`, any existing PDD pointer |
| Drive | `ACE/<slug>/inputs/` listing for each target | staleness diff — what's there now |

## Products

- A native-formatted Google Doc named `Proposed input updates — <source-folder-name> — YYYY-MM-DD HHMM`, written to `ACE/ai-input-creation-runs/` (not the source folder — that's the program team's working area, not ACE's audit space). The doc IS the proposal — no sibling YAML/JSON state file. Find-or-create the `ai-input-creation-runs/` subfolder under `ACE_DRIVE_ROOT_FOLDER_ID` on every run; it accumulates one doc per propose+apply cycle as the durable audit trail.

## Process

1. **Read source folder tree.**
   - `drive_list_folder` at the source folder ID. For any nested folder that looks opp-relevant by name (heuristic: folder name overlaps with an opp slug or a candidate program shorthand), recurse one level. Don't blindly recurse — large repos like `Contracts/` or `videos/` would balloon the read.
   - For each file: capture `id`, `name`, `mimeType`, `modifiedTime`, parent folder name.
   - For gdocs and `.docx`: `drive_read_file` to grab body text (truncate to ~10k chars per doc for classification; classifier doesn't need the whole RFI).
   - For sheets: `sheets_list_tabs` + `sheets_info` to grab tab names and header rows. Read full tab content only if a tab looks opp-relevant.
   - For other binaries (PDF, images): record metadata only; surface in `Unmapped` if classifier can't place them.

2. **Resolve target opp set.**
   - If slugs passed: read each `ACE/<slug>/opp.yaml` and `ACE/<slug>/inputs/`.
   - If no slugs: list `ACE_DRIVE_ROOT_FOLDER_ID`, read each child opp's `opp.yaml`, score each opp's `display_name + tags` for overlap with the source folder name (lowercase token Jaccard is fine), keep the top N (≥0.2 score). Surface the auto-picked set in the proposal's `Targets` section so the operator can prune by deleting lines.

3. **Classify each source artifact.**
   - For each source file (or sheet-tab), classify against the resolved opp set as one of:
     - `whole-doc-applies-to: [<slug>, ...]` — whole content is relevant; emit one `ADD_SHORTCUT` per target slug. If the slug list is empty, mark Unmapped.
     - `partial-applies-to: { <slug>: [<sections|tab-names>], ... }` — content is mixed (RFI, multi-tab sheet); emit one `ADD_DERIVED_DOC` per target slug with only the relevant slices extracted. The extracted-content block in the doc is the canonical content — apply uses it as-edited.
     - `proposes-new-opp: { slug, display_name, tags }` — the artifact is opp-shaped (a dedicated EOI form, a per-opp tab in a planning sheet with no matching opp) and no target slug covers it. Emit a `CREATE_OPP` plus the follow-on `ADD_*` actions that populate the new opp's `inputs/`.
     - `unmapped` — the classifier can't place it; emit under `Unmapped` with a note explaining why and any low-confidence candidates considered.
   - Tag each emitted action with `Confidence: HIGH | MEDIUM | LOW` based on classifier certainty.

4. **Diff against current opp inputs.**
   - For each target opp, list current `inputs/` files.
   - Staleness signals: filename prefix `OLD -` / `OLD_`, an existing input whose source-doc-id (resolvable when the input is a Drive shortcut) matches a source file that classifier marks as relevant but whose body has changed materially, an existing input whose name closely matches a newer source doc with a different ID.
   - Emit `REPLACE_FILE` for each detected staleness pair (existing → new).
   - Emit `REMOVE_FILE` only for explicit signals (the `OLD -` prefix is the strongest). Don't auto-remove on staleness-by-content alone — that's `REPLACE_FILE`.

5. **Build the proposal doc.**
   - Emit the proposal as a markdown string (the natural format for LLM-authored content). Use `#`/`##`/`###` for top sections / actions / sub-fields, `**bold**` for emphasis, `[text](url)` for source links, fenced ``` blocks for proposed `opp.yaml` bodies, `-` lists for bullets.
   - **Render the proposal statelessly.** Describe what the propose pass observes right now — counts, target opps, action proposals, unmapped items. Do NOT reference "prior runs", "what was just applied", "this verifies idempotence", etc. A second invocation against an already-populated state should produce a doc with `0` actions in each category — that's the empty-diff signal — not a meta-commentary on the previous run. The operator decides whether to look at the audit trail of past propose docs in `ACE/ai-input-creation-runs/`; the skill itself doesn't reach across runs.
   - Find-or-create the `ai-input-creation-runs/` folder under `ACE_DRIVE_ROOT_FOLDER_ID`, then call `drive_create_doc_from_markdown` with `{ name, markdown, parentFolderId: <ai-input-creation-runs-id> }`. Drive's import service converts headings, bold/italic, lists, links, code fences, and tables to native Doc runs — the Docs outline sidebar populates because the converted paragraphs use `HEADING_1/2/3` named styles. Apply (Phase 2) reads the resulting gdoc back via `docs_get` and parses by paragraph style, not by markdown markers.
   - Markdown structure (Drive converts to native gdoc with these styles):
     ```markdown
     # <opp-slug> (existing | NEW — will be created)
     <one-line context paragraph: today's inputs/, notable gaps>

     ## CREATE_OPP <slug>
     ### Proposed opp.yaml
     ```yaml
     opportunity: <slug>
     display_name: …
     tags: […]
     ```
     ### Rationale
     <paragraph>
     ### Confidence: HIGH | MEDIUM | LOW

     ## ADD_SHORTCUT <slug>: <short identifier>
     ### Source
     [<source doc title>](<drive url>)
     id: <file-id>
     ### Rationale
     <paragraph>
     ### Confidence: HIGH | MEDIUM | LOW

     ## ADD_DERIVED_DOC <slug>: <short identifier>
     ### Source
     [<source doc/sheet title>](<drive url>), section/tab/row reference
     ### Proposed name
     <derived doc name>
     ### Rationale
     ### Confidence
     ### Extracted content
     <one or more paragraphs of clean content — the canonical body. Operator edits here are the apply input.>

     ## REPLACE_FILE <slug>: <existing name> → <new name>
     ### Existing
     [<file name>](<drive url>) (id: <file-id>)
     ### Replace with
     <either "shortcut to <source>" with link, or a full ADD_DERIVED_DOC-style sub-block>
     ### Rationale
     ### Confidence

     ## REMOVE_FILE <slug>: <name>
     ### File
     ### Rationale
     ### Confidence

     # Unmapped
     <one-line note: "Excluded by skill rule — not surfaced: meeting notes, comms drafts, LLO/MoU interview templates, Slack/email exports.">

     ## UNMAPPED: <source file name>
     ### Source
     ### Why unmapped
     ### Low-confidence candidates
     ```
   - Per-opp grouping (one H1 per target opp, all of that opp's actions as H2 children) reads better than action-type grouping because operator review is opp-by-opp.

6. **Report.** Print the proposal doc's Drive URL and a one-line summary (`N new opps, M shortcuts, K derived, P replace, Q remove, R unmapped`). Stop.

## Apply phase (`--apply <proposal-doc-id>`)

Apply is mechanical — see the slash command for the action-execution order. Two rules worth restating in the skill body:

- **Doc-as-edited wins.** Whatever's in the proposal doc at apply time is the input. The skill does NOT re-classify, re-extract, or re-derive. If the operator edited an `Extracted content` block, the edited text is what lands in the new derived doc.
- **Deleted actions are skipped, silently.** No log of "you rejected these." The applied-state block at the bottom of the doc lists only what ran.

## Conventions

- Slugs follow ACE convention: lowercase kebab, program-prefixed (`malaria-itn-iptsc`, never bare `iptsc`).
- `CREATE_OPP` writes the minimum viable `opp.yaml`: `opportunity`, `display_name`, `tags`, `created_at`. No `connect:` block — that's populated by Phase 4 `connect-program-setup` on first run.
- Derived-doc names are explicit about the source and the slice: `RFI excerpts — <slug> relevant sections`, `Planning sheet — <slug> tab`. The operator can rename in the proposal doc before apply.
- Extracted-content blocks are markdown that Drive converts to native runs (headings, bold, lists, links). Apply re-reads the gdoc via `docs_get`, walks paragraphs by `namedStyleType`, and emits the derived doc body as markdown again via the same `drive_create_doc_from_markdown` atom — round-trip preserves formatting.

## Excluded artifact classes (skip entirely — not even surface in `Unmapped`)

Opp `inputs/` is what Phase 1 PDD synthesis consumes verbatim. Low-fidelity meta-artifacts pollute the PDD with stale, partial, or one-sided views. The classifier MUST recognize and skip these classes outright:

- **Meeting notes** — names like `Meeting notes - …`, `Notes from …`, `1:1 with …`, `Standup …`. Content is perspective-bound and often contradicts later decisions.
- **Comms drafts / email templates** — `Comms draft - …`, `Email template …`, `Outreach copy …`. Process artifacts, not intervention content.
- **LLO/MoU interview guides for our own discovery process** — `Interview Guide — LLOs - MoU`, `LLO discovery questions`. These guide how *we* engage candidate partners — not content about the intervention itself. (FGD guides for *the intervention's research* — like `ITN FGD Guide` — are different and ARE inputs.)
- **Slack/email exports, screenshots of chats, retro notes** — same reason.

If a new artifact name doesn't obviously fit one of these excluded classes but reads as meta/process rather than content, **prefer default-skip over default-include** and note it in the propose-pass log (not the proposal doc). When in doubt the operator can always add a manual `ADD_SHORTCUT` line in a re-run.

## Anti-patterns

- **Don't sync the whole RFI into every opp.** The `partial-applies-to` extraction is non-negotiable when the source has cross-cutting structure. Polluting opp inputs with irrelevant program-wide content confuses downstream Phase 1 PDD synthesis.
- **Don't infer "the source changed, the input is stale" without evidence.** Body diffing is fragile. Prefer explicit signals (`OLD -` prefix, a clearly-newer source doc with a different ID and a near-identical name) and emit `REPLACE_FILE` only for those.
- **Don't propose `REMOVE_FILE` on the strength of "I didn't find a source match." ** Absence of a source match is not evidence the file is stale — it might be a hand-curated input the operator added for a reason. Leave it alone unless an explicit staleness signal fires.
- **Don't surface excluded-class artifacts in `Unmapped`.** Unmapped is for "I couldn't decide which opp this belongs to" — not for "this isn't an input at all." Pushing meeting-notes-style artifacts into Unmapped tempts the operator to claim them; better to drop silently.
