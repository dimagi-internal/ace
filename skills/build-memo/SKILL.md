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

## On a forked run

A fork copies every phase before its fork point whole, so a run forked after
Phase 4 starts with its SOURCE run's memo in `4-connect/` — and, because
ace-web carries each copied phase's `products` block verbatim, with
`products.connect.build_memo` still pointing at the source run's Doc.
Observed on `spark-facilitator/20260926-1800` (forked from 20260925-1536 at
`synthetic-data-and-workflows`): the memo was titled "run 20260925-1536", and
the run's `build_memo.file_id` was the source's Doc, not the copy in its own
`4-connect/`. Neither is fixed by renaming: re-run this skill on the fork
(`/ace:step build-memo <opp>/<fork-run-id>`). The re-compose re-renders the
title from the fork's `run_id`, find-or-creates the Doc in the fork's own
`4-connect/`, and step 6 repoints `build_memo` at it. `skills/fork-run`
step 6b does this after every fork past Phase 4.

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

**The memo is not delivered until ace-web renders it — and ace-web now does.**
Since ace-web#768 (merged and deployed 2026-09-11, closing ace-web#767) the
summary page carries the memo as CONTENT, as the first section of the
Overview: its text in place, any `gaps[]` under a "This memo is incomplete"
banner above it, and the Doc as a secondary "Open in Google Docs" link. The
page reads it from the `products.connect.build_memo` pointer this skill
writes, so there is nothing more to wire. A close-out or reply names the
page as where to read the memo and gives the Doc only as the deep link to
comment in. What proves it landed is `run-surface-audit`, not a claim: a memo
the run recorded that the page does not show is `MISSING-ARTIFACT`, gaps the
page dropped are `MEMO-GAPS-HIDDEN`, and a memo whose text the page could not
read is `MEMO-BODY-UNREAD`.

## The one rule: compose, never re-derive

The memo is a collation. Every row and every paragraph comes from a producer's
own section, quoted or lightly reformatted, and names which producer it came
from. If a producer said nothing, the memo **says** that producer said nothing.

Never fill a gap from the PDD, from the apps, or from your own reading of
either. That would be a second, unreviewed authoring pass wearing the memo's
name — and the memo is precisely the thing a reviewer trusts *instead of*
looking. A gap stated plainly is correct output; a gap papered over is the
defect.

Two things are NOT re-derivation, and the memo needs both. **Rewording** a
producer's row into plain language for an outside reviewer — the producers
write for ACE, the memo is read by a programme partner. And the frame's
**scope correction** (`lib/build-memo-compose.ts` `rescopeRuleRow`): when a
producer credits a per-worker cap to a per-case app check, the frame leads
with the enforcement point the producer ALSO named (the payment-unit limit)
and records the correction in the appendix. It never invents an enforcement
point the producer did not name — a per-worker rule with no per-worker point
fails `--check` and is a gap to state.

## Process

0. **Anchor to the phase folder.** Use the `phaseFolderId` `connect-setup`
   threads in (the `4-connect` folder). If it was not threaded, resolve it with
   `drive_create_folder({name: '4-connect', parentFolderId: <runFolderId>,
   findOrCreate: true})`. Never write to the run-folder root: the fence walks
   `4-connect/`.

1. **Read the inputs.** For each row of the Inputs table, record one of:
   `present`, `absent` (file not in Drive), or `section missing` (file present,
   named section not in it). These are the Completeness table in step 2. Save
   `run_state.yaml`, `decisions.yaml`, `4-connect/connect-opp-setup.md` and the
   PDD (default `text/plain` export) to local scratch files with `writeToPath`
   — step 2 runs a script over them.

2. **Compose the memo to a LOCAL FILE** at an absolute scratch path — never
   inline (ace#1780; a programme memo quoting two app memos routinely exceeds
   40,000 characters).

   **2a. Render the deterministic frame first.** Every part of the memo that
   has a right answer is rendered by `lib/build-memo-compose.ts`, not written
   by hand — the title, the intro, "Known limitations", "Decisions you own",
   "Where each rule is enforced" and the appendix of internal references:

   ```bash
   node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/build-memo-compose.ts" \
     --run-state <run_state.yaml> --decisions <decisions.yaml> --phase4 <connect-opp-setup.md> \
     --pdd <pdd.txt> --display-name "<opp display name>" --frame <scratch dir>
   ```

   It writes `<scratch dir>/head.md`, `appendix.md` and `frame.json`. Use them
   verbatim. Why each part is generated rather than composed — every one was
   wrong on `spark-facilitator/20260926-1800` (build-memo-eval 6.2 `warn`):

   - **The title and run label come from `run_state.run_id`, on EVERY
     compose.** A fork copies `4-connect/` whole, so a forked run starts with
     its source's memo, titled with the SOURCE run id — that run's memo read
     "run 20260925-1536" on run 20260926-1800. The memo is re-composed per run
     and never inherits a label; a fork names its source once, as provenance.
   - **Each rule is credited to the enforcement point that holds it at its
     scope.** A per-worker rule (a daily or total cap per worker) is held by
     Connect's payment unit `max_daily` / `max_total`; an app form check is
     keyed on the case the form is filled against (a community, a household),
     so it cannot bound a worker across cases. The frame leads each per-worker
     rule with the payment-unit limit, keeps the app check as per-case support,
     and lists each correction it made in the appendix.
   - **Known limitations come first and separate a real gap from a rule
     off-platform by design.** A rule the design needs that nothing enforces
     (Connect refused the verification rules on a self-managed opportunity,
     ace#2419, so `form_field_rules_saved: 0`) is a real gap; Layer B review,
     Layer C calls, location-for-review-only are placed off Connect by the
     design itself. One label for both made the gap read as routine.
   - **Decisions you own** lists what only the reviewer can settle: every
     PROPOSED program parameter the build had to pick a value for (rate,
     organisation payment, budget, dates), each real enforcement gap, sign-off
     of machine-translated languages, and every Phase 3/4 decision left OPEN.

   **2b. Write the account of the build, in plain language,** and assemble:

   ```markdown
   <head.md, verbatim: title · intro · Known limitations · Decisions you own ·
    Where each rule is enforced>

   ## What was built, and the choices the build made

   <What was built: each app with its released version, the Connect
   opportunity with its payment line, caps, dates and budget — as recorded.>

   | # | What the build chose, and why | Where to check | What correct looks like |
   |---|---|---|---|

   <appendix.md, verbatim>

   ### Appendix B — Deliver app build notes, verbatim
   ### Appendix C — Learn app build notes, verbatim
   ### Appendix D — Connect setup notes, verbatim
   ### Appendix E — Completeness

   | Input | Status | If not present |
   |---|---|---|
   ```

   **The choices table — one row per item, no merging, no dropping.**
   - One row per `[ACE]` latitude and per `[FIXED]` ambiguity in the Deliver,
     Learn and Phase 4 sections, plus one row per `decisions.yaml` row from
     phase `3-commcare` or `4-connect`. When a `decisions.yaml` row and a memo
     row record the same choice, keep ONE row. Two kinds of item go to the
     appendix instead of the table, each still listed: rule-enforcement rows
     (already in "Where each rule is enforced") and ACE's own test-harness
     choices (smoke-test recipes, scroll gestures, test scenario counts) — a
     partner cannot act on them.
   - **Plain language, for a programme partner who has never seen ACE.** The
     body — everything before `## Appendix` — carries no skill names,
     `decisions.yaml` ids, issue or PR numbers, file paths, run-state keys or
     code identifiers (field ids like `date_of_meeting`, `entity_key`). Name a
     question by its on-screen label, a screen by its title. Explain every
     abbreviation where it is used (`community-based facilitator (CBF)`) or
     avoid it; the frame's **Terms:** line glosses the ones the PDD defines.
     Rewording a producer's row into plain words is composition; adding a fact
     the producer did not record is re-derivation.
   - `Where to check`: the app → screen, or the Connect page, the producer
     named; `—` when it named none (and say so in "What correct looks like").
   - `What correct looks like`: what the reviewer should see there.
   - The provenance of each row — producer, `decisions.yaml` id, PDD section
     exactly as the producer cited it, or `NOT CITED by <producer>` when it
     cited none — goes in the appendix as one line per row number, never in the
     body.
   - A run with no rows writes one row reading `None recorded by any producer`
     — never an empty table, which reads as "nothing happened" when it may mean
     "nothing was written down".

   **Appendices B–D** carry each producer's section verbatim, headings demoted
   to `####`. Drop a producer's own "Run <opp>/<id>" header line — on a fork it
   names the source run; the frame's intro states provenance once. Appendix C
   MUST show the Learn PDD §6(5) framework-gap list, or the Learn memo's own
   explicit statement of why none applies. Appendix D MUST show one row per PDD
   verification rule with a non-empty `Where applied` cell —
   **"Not configurable on Connect" is a valid answer and must be stated, never
   omitted** (`connect_set_verification_flags` refuses `duplicate`, `gps` and
   `gps_radius_meters`, ace#1013). Render a blank `Where applied` cell as
   `NOT STATED by connect-opp-setup` and list it as a gap.

   **An absent or section-missing input** replaces that appendix's body with:
   `ABSENT — <path> (<section>) was not in Drive when this memo was composed.`
   plus the Completeness row, and a line under Known limitations naming what
   is missing. Do not reconstruct it. Name the fix in the Completeness row:
   re-run the producer that owns the section (`/ace:step <producer>
   <opp>/<run-id>`), then `/ace:step build-memo <opp>/<run-id>`. For the Learn
   memo, re-running `pdd-to-learn-app` rebuilds the app, so say so rather than
   recommending it casually.

   **2c. Gate the composed memo before it is published:**

   ```bash
   node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/build-memo-compose.ts" \
     --run-state <run_state.yaml> --decisions <decisions.yaml> --phase4 <connect-opp-setup.md> \
     --check <memo.md>
   ```

   Exit 0 is required. Four checks: `run_label` (every run label names
   `run_state.run_id`), `reviewer_language` (the body is plain and every
   abbreviation explained), `reviewer_frame` (Known limitations and Decisions
   you own lead the memo and are complete), `enforcement_scope` (no per-worker
   rule credited to a per-case app check). A finding is fixed in the memo and
   re-checked — never suppressed by moving body text into the appendix to
   dodge the language check, since the body is what a reviewer reads.

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
| 2026-10-01 | **The memo is written for an outside reviewer, and its deterministic parts are generated (build-memo-eval 6.2 `warn` on spark-facilitator/20260926-1800).** Five findings had right answers the run already held: (a) the title named the fork's SOURCE run — the memo is now re-composed per run with the title from `run_state.run_id`, and § On a forked run documents that a fork also carries the source's `build_memo` pointer; (b) the per-worker caps (1 per CBF per day, 21 per CBF) were credited to per-COMMUNITY app checks — the frame leads every per-worker rule with Connect's payment-unit `max_daily` / `max_total` and states the app check at its per-case scope; (c) the body was full of skill names, decision ids, issue numbers, paths and un-glossed abbreviations — the body is plain language, provenance moves to an appendix, and a **Terms:** line glosses what the PDD defines; (d) a "Decisions you own" section now leads (placeholder rate, proposed terms, the unenforced rule, translation sign-off, open items); (e) "Known limitations" states the real gap (`form_field_rules_saved: 0`, ace#2419) apart from rules off Connect by design. New `lib/build-memo-compose.ts` + `scripts/build-memo-compose.ts` (`--frame` renders, `--check` gates; exit 0 required before publish). Memo structure is now head → "What was built, and the choices the build made" → appendix (producer sections B–D, Completeness E). *Enforced:* `test/lib/build-memo-compose.test.ts` (fixtures captured from that run, including a regenerated memo that passes all four checks). | ACE team |
| 2026-09-11 | Initial version (ace#2371). The programme-level build memo every poverty-graduation PDD names as its review artifact had never been delivered: 76 skill writes to "the build memo", no artifact. Composes the Deliver `## Build memo` section, the Learn build memo (now actually written to Drive), and a new Phase 4 section mapping every PDD verification rule to where it is applied. Declared `required: true`, so the Phase 4 fence fails a run without it. *Enforced:* `test/skills/build-memo-contract.test.ts`. | ACE team |
| 2026-09-11 | **The reviewer reads the memo on ace-web, not in Drive** (ace#2378). Added § Where a reviewer reads it: the run's summary page is the entry point and the Doc is storage behind it. The memo counts as delivered only once ace-web renders it (ace-web#767, open). Before this, the close-out put the Doc link directly under the summary URL, so a Drive-only artifact counted as delivered while the reviewer's surface could not show it. | ACE team |
| 2026-09-11 | **ace-web renders the memo** (ace-web#768, closing ace-web#767). § Where a reviewer reads it no longer tells a close-out to say the page cannot show the memo: the page carries its text as the first Overview section, gaps above it. `run-surface-audit` registers the new `build_memo` payload section (it had been reporting it as unaudited on every run) and now checks it: `MISSING-ARTIFACT` when the run made a memo the page does not show, `MEMO-GAPS-HIDDEN` when recorded gaps do not reach the page, `MEMO-INCOMPLETE` / `MEMO-BODY-UNREAD` as improvements. | ACE team |
