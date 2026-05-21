---
description: Propose updates to opp `inputs/` folders (and propose net-new opps) from a messy working source folder in Drive. Two phases — propose (default) and `--apply <proposal-doc-id>`.
argument-hint: <source-folder-id> [<opp-slug>...] | --apply <proposal-doc-id>
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion, mcp__plugin_ace_ace-gdrive__drive_list_folder, mcp__plugin_ace_ace-gdrive__drive_read_file, mcp__plugin_ace_ace-gdrive__drive_create_file, mcp__plugin_ace_ace-gdrive__drive_create_doc_from_markdown, mcp__plugin_ace_ace-gdrive__drive_create_folder, mcp__plugin_ace_ace-gdrive__drive_create_shortcut, mcp__plugin_ace_ace-gdrive__drive_trash_file, mcp__plugin_ace_ace-gdrive__drive_diagnose, mcp__plugin_ace_ace-gdrive__docs_get, mcp__plugin_ace_ace-gdrive__sheets_info, mcp__plugin_ace_ace-gdrive__sheets_read, mcp__plugin_ace_ace-gdrive__sheets_list_tabs]
---

# /ace:program-update — Propose Updates to Opp Inputs From a Messy Source Folder

When a program team is moving fast on a related set of opportunities (e.g. malaria, with multiple EOI tracks + shared RFI + partner docs), the source-of-truth working folder fills up with documents while each opp's `inputs/` folder goes stale. This skill reads the messy source folder and proposes:

- **Net-new opps** (a clearly opp-shaped artifact exists in the source — an EOI form, a per-opp tab in a planning sheet — but no `ACE/<slug>/` folder yet)
- **Add shortcut** (a whole source doc applies to one or more existing opps)
- **Add derived doc** (a large multi-opp doc — RFI, planning sheet with per-opp tabs — should land in `inputs/` only as the per-opp **excerpt**, never as a shortcut to the whole thing; we do NOT want irrelevant content confusing the opp inputs)
- **Replace file** (an existing input is explicitly stale — e.g. filename prefixed `OLD -`, or a clearly-newer version exists in the source)
- **Remove file** (existing input no longer relevant)

The propose pass produces a single review-friendly Google Doc; you edit it (delete unwanted actions, tweak extracted content, fix slugs/names); then `--apply` executes whatever's still listed.

## Phase 1 — propose

```
/ace:program-update <source-folder-id> [<opp-slug>...]
```

Read by the propose pass (read-only):

- The source folder tree (recursive list; doc bodies for likely-relevant docs; sheet tab names + first row of each tab).
- For each named opp: `ACE/<slug>/opp.yaml`, current `ACE/<slug>/inputs/` listing, doc bodies of each existing input (to gauge staleness vs source).
- If no opp slugs passed: list `ACE_DRIVE_ROOT_FOLDER_ID` and pick candidates whose `opp.yaml.tags` or `display_name` overlap with the source folder's name. Surface them up top in the proposal as a candidate target list so the operator can prune.

Writes (one artifact):

- A native-formatted Google Doc in the source folder, named `Proposed input updates — YYYY-MM-DD HHMM`, with one `Heading 1` per section: `Summary`, `Targets`, `Actions`, `Unmapped`. Each action is a `Heading 2` of the form `<ACTION_TYPE> <opp-slug>` so `--apply` can parse the doc top-to-bottom.

Render contract (important — Drive renders gdocs natively, not raw markdown):

- Build the proposal as a markdown string and call `drive_create_doc_from_markdown` (Drive's native import service converts `#`/`##`/`###` to real Heading 1/2/3 paragraphs — the Docs outline sidebar populates correctly. `**bold**`, `[text](url)`, `-` lists, ``` fenced blocks all convert too).
- For extracted content blocks (the meat of `ADD_DERIVED_DOC` actions), render as plain markdown paragraphs under a `### Extracted content` heading. Apply reads these back via `docs_get`, walks paragraphs by `namedStyleType`, and re-emits via the same atom — no separate plain-text or code-fence handling needed.
- Source file references render as a `### Source` sub-heading followed by a markdown link `[<doc title>](<drive url>)` and an `id: <file-id>` line.

## Phase 2 — apply

```
/ace:program-update --apply <proposal-doc-id>
```

1. `docs_get` the proposal doc.
2. Walk its element list top-to-bottom. Every `Heading 2` whose text starts with one of `CREATE_OPP `, `ADD_SHORTCUT `, `ADD_DERIVED_DOC `, `REPLACE_FILE `, `REMOVE_FILE ` opens an action block. Everything until the next `Heading 2` is that action's body.
3. Parse the body's `Source`, `Name`, `Rationale`, `Existing`, and (for `ADD_DERIVED_DOC`) `Extracted content` sections. Use the doc content **as-edited** at apply time — never re-derive.
4. Execute in this order (so dependent actions see the new state):
   1. All `CREATE_OPP` actions — `drive_create_folder` for `<slug>`, `inputs/`, `runs/`, then `drive_create_file` for `opp.yaml` with the proposed YAML body.
   2. All `ADD_SHORTCUT` actions — `drive_create_shortcut` from the source file ID into the target opp's `inputs/`.
   3. All `ADD_DERIVED_DOC` actions — `drive_create_doc_from_markdown` into target `inputs/` (gdoc, body = the markdown extracted content). Drive renders the markdown natively so the derived doc has proper headings/lists/links just like the proposal doc.
   4. All `REPLACE_FILE` actions — emit the new shortcut/derived-doc first, then `drive_trash_file` the old one. (Drive trash is reversible.)
   5. All `REMOVE_FILE` actions — `drive_trash_file`.
5. Append an `Applied YYYY-MM-DD HHMM` section at the bottom of the proposal doc summarizing what ran, with links to the new artifacts. Actions deleted from the doc before apply are simply absent from the applied list — no record kept of "you skipped this," consistent with the doc-as-source-of-truth model.

## What this does NOT do

- No edits to existing opp content other than `inputs/`. `opp.yaml`, `runs/`, `eval-calibration/` etc. are untouched.
- No `/ace:run` side effects. No Phase activation, no Connect calls, no OCS calls.
- No upstream-doc edits. The source folder is read-only from this skill's perspective except for the proposal doc itself.

## Conventions

- **Stateless.** No `.program-update-state.yaml` or any sibling state file. Each propose run re-derives everything from the live state of source folder + current opp inputs. If you ran it yesterday and applied changes, today's run sees the new state and only proposes new deltas.
- **Shortcuts preferred for whole-doc adds; derived docs only when the source is partially-relevant.** Whole-doc relevance is the common case; a derived doc costs an extra Drive object plus a re-derivation when the source doc changes.
- **Multi-target adds explicit.** If a single source doc applies to opps A and B, the proposal emits **two `ADD_SHORTCUT` actions** (one per target). One header per action keeps `--apply` parsing trivial and lets you prune one without affecting the other.
- **Confidence rendered, not gated.** The classifier emits HIGH/MEDIUM/LOW confidence on each proposed action. Low-confidence proposals are still emitted (under their normal `ADD_*` heading) so the operator only has to delete-to-reject; the `Confidence` line lets you eyeball where to look hardest. Truly ambiguous source docs go to the `Unmapped` section instead.

## Implementation notes (for the skill body, not the operator)

- Reading sheet structure: `sheets_list_tabs` + `sheets_info` are cheap enough to call per-sheet; only call `sheets_read` on tabs that look opp-relevant from the tab name.
- Reading docs: `drive_read_file` returns body text for gdocs and `.docx` files. PDF source docs aren't readable inline — surface them in `Unmapped` with a note.
- Slug proposal for `CREATE_OPP`: kebab-case, prefix with the program shorthand inferred from the source folder name (`malaria-itn-iptsc`, not `iptsc`). Verify the slug doesn't collide with an existing ACE root child before proposing.
- Folder list pagination: `drive_list_folder` returns up to a page; if the source folder has > ~30 top-level items, the skill should descend into subfolders one at a time rather than buffering the whole tree.
