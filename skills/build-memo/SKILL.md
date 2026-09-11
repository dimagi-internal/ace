---
name: build-memo
description: >
  Compose the run's build memo — the review artifact — from the Learn, Deliver and Phase 4 memo sections. Runs last in Phase 4.
disable-model-invocation: false
---

# Build memo

Compose ONE programme-level build memo per run: the document a human reviews
**instead of every screen**, then spot-checks the apps against.

Poverty-graduation's Targeting PDD §11 [FIXED] names it as a compilation target
and defines its job: *"a build memo listing every place ACE exercised [ACE]
latitude and every ambiguity it hit in [FIXED] material. The build memo is the
review artifact: humans review the memo and spot-check the apps, rather than
reviewing every screen."* Learn PDD §6(5) specifies the Learn part.

Until ace#2371 no run delivered one. The producing skills wrote to "the build
memo" 76 times across 8 files, but nothing assembled or published it: the
Deliver half lived unnamed inside `pdd-to-deliver-app_summary.md`, the Learn
half was composed in-context and never written to Drive, and Phase 4 had no memo
content at all. The design author therefore reviewed every screen — exactly the
cost the memo exists to remove.

## Where this runs, and why there

`agents/connect-setup.md` Step 3, after `connect-opp-setup`. §11's compilation
targets are the Learn app, the Deliver app, the opportunity configuration, the
verification flags, and this memo. The end of Phase 4 is the earliest point the
first four all exist, so it is the earliest point the memo can be complete.

It runs on **every** run, not only on runs whose PDD names a build memo, and
`4-connect/build-memo.md` is `required: true` in `lib/artifact-manifest.ts`, so
the Phase 4 boundary fence's `verify_phase_artifacts(phase='connect')` fails a
run that reaches the boundary without it. A conditional requirement would need
a detector deciding whether a PDD "names a build memo", and a detector that
misses is the silent pass this skill was built to end. On a run whose PDD does
not name one, the memo still carries the only place each verification rule is
mapped to where it is enforced.

## Inputs

| Source | Artifact | What is read |
|---|---|---|
| Phase 3 | `3-commcare/pdd-to-deliver-app_summary.md` | the section headed `## Build memo` (older runs: any heading containing "build memo", e.g. "Deliver app — build memo") and every sub-table under it |
| Phase 3 | `3-commcare/pdd-to-learn-app_build-memo.md` | the whole file, including `## Framework gaps (Learn PDD §6(5))` |
| Phase 4 | `4-connect/connect-opp-setup.md` | the section headed `## Build memo — opportunity configuration and verification` |
| Run root | `decisions.yaml` | rows whose `phase` is `3-commcare` or `4-connect` |
| Phase 1 | the PDD set — `products.pdd`, plus on a componentized run `products.components[].pdd_file_id` and `products.program_level[].file_id` | ONLY to quote the sentence(s) that name the build memo, with document + section. Never to derive a row. |

## Products

- `4-connect/build-memo.md` — the memo, a rendered Google Doc at one stable
  per-run path, shared anyone-with-link at `role: 'commenter'` so the reviewer
  can anchor comments (`skills/feedback-ledger`'s `gdoc-comments` channel).
- `4-connect/build-memo.source.md` — the same bytes as a plain `text/markdown`
  file, for `run-surface-audit`'s DOC-FIDELITY check.
- `run_state.yaml` → `phases.connect-setup.products.connect.build_memo`
  `{file_id, title, web_view_link, complete, gaps[]}` — the link every review
  surface reads. This skill is the sole writer of that key; `connect-opp-setup`
  owns the rest of `products.connect`.

## Where a reviewer reads it

On the run's ace-web summary page (`run_state.yaml` top-level
`ace_web_summary_url`), not in Drive. ace-web is the human surface for a run
and Drive is ACE's storage (`CLAUDE.md § Conventions`, ace#2378). The Doc is
the storage copy and the place to anchor a comment; it is not the entry point.
So every reviewer-facing reference gives the run page first and the Doc link
as a deep link under it.

**The memo is not delivered until ace-web renders it.** Rendering its content
on the summary page is ace-web#767, open as of 2026-09-11. Until that ships,
a close-out or reply says the page does not show the memo yet, and gives the
Doc as the stopgap. It must not present the Doc as the review surface.

## The one rule: compose, never re-derive

The memo is a collation. Every row and every paragraph comes from a producer's
own section, quoted or lightly reformatted, and names which producer it came
from. If a producer said nothing, the memo **says** that producer said nothing.

Never fill a gap from the PDD, from the apps, or from your own reading of
either. That would be a second, unreviewed authoring pass wearing the memo's
name — and the memo is precisely the thing a reviewer trusts *instead of*
looking. A gap stated plainly is correct output; a gap papered over is the
defect.

## Process

0. **Anchor to the phase folder.** Use the `phaseFolderId` `connect-setup`
   threads in (the `4-connect` folder). If it was not threaded, resolve it with
   `drive_create_folder({name: '4-connect', parentFolderId: <runFolderId>,
   findOrCreate: true})`. Never write to the run-folder root: the fence walks
   `4-connect/`.

1. **Read the inputs.** For each row of the Inputs table, record one of:
   `present`, `absent` (file not in Drive), or `section missing` (file present,
   named section not in it). These are the Completeness table in step 2.

2. **Compose the memo to a LOCAL FILE** at an absolute scratch path — never
   inline (ace#1780; a programme memo quoting two app memos routinely exceeds
   40,000 characters). Use exactly this structure:

   ```markdown
   # Build memo — <opp display name> · run <run-id>

   <One paragraph. What this document is. Then EITHER the sentence(s) in this
   run's PDD set that name the build memo, quoted, with document and section —
   OR, verbatim: "No PDD in this run names a build memo; it is composed as the
   standing Phase 4 review artifact.">

   **How to review:** work through section 1. Each row says where to
   spot-check it in the apps or on Connect. Sections 2–4 are the producers'
   own memos, for context.

   ## 1. Every [ACE] latitude taken and every [FIXED] ambiguity hit

   | # | Kind | PDD section | What ACE did | Where to spot-check | From |
   |---|---|---|---|---|---|

   ## 2. Deliver app

   ## 3. Learn app

   ## 4. Opportunity configuration and verification flags

   ## 5. Completeness

   | Input | Status | If not present |
   |---|---|---|
   ```

   **Section 1 — one row per item, no merging, no dropping.**
   - One row per `[ACE]` latitude and per `[FIXED]` ambiguity in the Deliver,
     Learn and Phase 4 sections, plus one row per `decisions.yaml` row from
     phase `3-commcare` or `4-connect`. When a `decisions.yaml` row and a memo
     row record the same choice, keep ONE row and cite both in `From`.
   - `Kind`: `[ACE] latitude`, `[FIXED] ambiguity`, `open item`, or `decision`
     — as the producer labelled it. A row the producer filed under "open" /
     "not resolved" is an `open item`.
   - `PDD section`: exactly as the producer cited it. A row whose producer
     cited no section reads `NOT CITED by <producer>` — never a section you
     inferred.
   - `Where to spot-check`: the app + form/field, or the Connect setting, the
     producer named; `—` when it named none.
   - `From`: `Deliver memo`, `Learn memo`, `Phase 4 memo`, or
     `decisions.yaml: <id>`.
   - A run with no rows writes one row reading `None recorded by any producer`
     — never an empty table, which reads as "nothing happened" when it may mean
     "nothing was written down".

   **Sections 2–4** carry each producer's section verbatim, headings demoted
   one level. Section 3 MUST show the Learn PDD §6(5) framework-gap list, or the
   Learn memo's own explicit statement of why none applies. Section 4 MUST
   show one row per PDD verification rule with a non-empty `Where applied`
   cell — **"Not configurable on Connect" is a valid answer and must be stated,
   never omitted** (`connect_set_verification_flags` refuses `duplicate`, `gps`
   and `gps_radius_meters`, ace#1013). Render a blank `Where applied` cell as
   `NOT STATED by connect-opp-setup` and list it as a gap.

   **An absent or section-missing input** replaces that section's body with:
   `ABSENT — <path> (<section>) was not in Drive when this memo was composed.`
   plus the Completeness row. Do not reconstruct it. Name the fix in the
   Completeness row: re-run the producer that owns the section
   (`/ace:step <producer> <opp>/<run-id>`), then `/ace:step build-memo
   <opp>/<run-id>`. For the Learn memo, re-running `pdd-to-learn-app` rebuilds
   the app, so say so rather than recommending it casually.

3. **Render it:** `drive_create_doc_from_markdown({name: 'build-memo.md',
   localFilePath: <the step-2 file>, parentFolderId: <phaseFolderId>})`. The
   default find-or-create reuses the same document on a re-run, so the URL is
   stable per run and a re-compose updates it in place.

4. **Persist the source — the SAME LOCAL FILE, written twice.** Write the
   exact bytes to `4-connect/build-memo.source.md` via `drive_upload_binary`
   with `mimeType: 'text/markdown'`, `localFilePath` pointing at the step-2
   file, and the same `parentFolderId`. NOT `drive_create_doc_from_markdown`
   and NOT `drive_create_file` for this copy — both always create a Google Doc
   and destroy the bytes the DOC-FIDELITY check compares (ace#1991).

5. **Share it for review:** `drive_set_anyone_with_link({fileId: <step-3 id>,
   role: 'commenter'})`. A private memo 401s for the reviewer it was written
   for (ace#902, ace#1843), and a `reader` link opens but cannot be commented
   on, which silently empties the feedback loop.

6. **Write the link into run state:**
   `update_yaml_file` on the run's `run_state.yaml` with `merge: 'deep'` and
   `validateAs: { kind: 'phase-products', phase: 'connect-setup' }`:

   ```yaml
   phases:
     connect-setup:
       products:
         connect:
           build_memo:
             file_id: <step-3 id>
             title: Build memo
             web_view_link: <step-3 webViewLink>
             complete: <true iff every Completeness row is present>
             gaps: [<one short string per non-present input or NOT STATED cell>]
   ```

   `deep`, never `two-level` — this is a partial patch of `products.connect`,
   and `two-level` would drop the opportunity block `connect-opp-setup` wrote.

7. **Return** the link, `complete`, and `gaps[]` to `connect-setup`, which
   puts them in `connect-setup_summary.md`.

## Failure behaviour

- **Missing producer sections do not stop the memo.** They are stated in it
  and recorded in `gaps[]`. The memo existing-with-gaps is loud; the memo not
  existing is silent to every reader but the fence.
- **A write that fails (steps 3–6) is a hard error** — return it; do not
  report the memo written. The Phase 4 fence then sees `4-connect/build-memo.md`
  missing and re-dispatches `Skill(build-memo)`; this skill never touches
  Connect, so the fence's external-resource override (no re-mint of an
  opportunity) does not apply to it.

## MCP Tools Used

- **ace-gdrive:** `drive_read_file`, `drive_list_folder`, `drive_create_folder`,
  `drive_create_doc_from_markdown`, `drive_upload_binary`,
  `drive_set_anyone_with_link`, `update_yaml_file`.

## Mode Behavior

- **Auto / default:** compose, publish, return. Not a pause point.
- **Review:** identical; at the next pause the orchestrator surfaces the run's
  ace-web page, with the memo Doc under it (§ Where a reviewer reads it).

## Dry-Run Behavior

Compose the memo to `comms-log/dry-run-build-memo.md` only; no Doc, no share,
no `run_state.yaml` write.

## Change Log

| Date | Change | Author |
|---|---|---|
| 2026-09-11 | Initial version (ace#2371). The programme-level build memo every poverty-graduation PDD names as its review artifact had never been delivered: 76 skill writes to "the build memo", no artifact. Composes the Deliver `## Build memo` section, the Learn build memo (now actually written to Drive), and a new Phase 4 section mapping every PDD verification rule to where it is applied. Declared `required: true`, so the Phase 4 fence fails a run without it. *Enforced:* `test/skills/build-memo-contract.test.ts`. | ACE team |
| 2026-09-11 | **The reviewer reads the memo on ace-web, not in Drive** (ace#2378). Added § Where a reviewer reads it: the run's summary page is the entry point and the Doc is storage behind it. The memo counts as delivered only once ace-web renders it (ace-web#767, open). Before this, the close-out put the Doc link directly under the summary URL, so a Drive-only artifact counted as delivered while the reviewer's surface could not show it. | ACE team |
