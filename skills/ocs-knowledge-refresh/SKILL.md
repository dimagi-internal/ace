---
name: ocs-knowledge-refresh
description: >
  Add the Phase 6 training documents to the per-opp chatbot's RAG collection
  and republish it. The second half of OCS setup, owned by Phase 6 because
  that is where its inputs are produced. Runs as the last step of
  qa-and-training.
disable-model-invocation: false
---

# OCS Knowledge Refresh

Uploads the Phase 6 training documents into the chatbot's existing RAG
collection, waits for indexing, and publishes a new chatbot version.

Uses: `ocs_upload_collection_files`, `ocs_wait_for_collection_indexing`,
`ocs_publish_chatbot_version`, `ocs_get_chatbot_embed_info`.

## Why this is a separate skill from `ocs-agent-setup`

`ocs-agent-setup` used to do both halves. That created a **cycle** in the
dataflow graph, because the two halves have different inputs:

| Half | Needs | Available in |
|---|---|---|
| Create + publish the bot → emits `widget_url` | PDD, app summaries, opp details | Phase 5 |
| Populate the knowledge base | the four training documents | Phase 6 |

Phase 6's guides embed the `widget_url` from the first half; the first half's
collection wants the documents from Phase 6. Bundled into one step that runs in
Phase 5, that is unsatisfiable — and the way it was papered over is instructive:
Phase 5 read `6-qa-and-training/*` **tolerantly**, so the files being absent was
not an error. Nothing re-uploaded them afterwards, so **every opportunity's
chatbot shipped without the four documents its users ask about**, and every
check stayed green (the tolerant read succeeds, the collection indexes cleanly,
and Phase 5's smoke gate asks three universal Connect questions that need none
of them).

Splitting the node at its real dependency seam removes the cycle rather than
working around it. Phase 5 now consumes nothing from Phase 6, this skill
consumes nothing from Phase 5 except the state file it wrote, and the pipeline
is a plain DAG:

    5. ocs-agent-setup (create + publish)  →  widget_url
    6. training-* (consume widget_url)     →  the four documents
    6. ocs-knowledge-refresh               →  documents into the collection

A first-class step, not a corrective second pass. `ocs-agent-setup --reindex`
(0.13.1022–0.13.1026) was the fix-up version of this and is retired.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 5 | `runs/<run-id>/5-ocs/ocs-agent-setup.md` | `experiment_id`, `collection_id`, `pipeline_id` |
| Phase 6 | `runs/<run-id>/6-qa-and-training/training-llo-guide.md` | RAG content |
| Phase 6 | `runs/<run-id>/6-qa-and-training/training-flw-guide.md` | RAG content |
| Phase 6 | `runs/<run-id>/6-qa-and-training/training-faq.md` | RAG content |
| Phase 6 | `runs/<run-id>/6-qa-and-training/training-quick-reference.md` | RAG content |

## Products

- `runs/<run-id>/6-qa-and-training/ocs-knowledge-refresh.md` — which documents
  were uploaded, the resulting collection file count, and the published
  `version_number`.
- Updates `5-ocs/ocs-agent-setup.md` with `last_reindexed_at` and the refreshed
  `version_number`.
- Writes `phases.ocs-setup.products.ocs_chatbot.knowledge_sources` (plus
  `last_reindexed_at` and the refreshed `version_number`) to `run_state.yaml`.
  **This skill is the only producer of `knowledge_sources`** — ace-web's public
  run-summary page is the consumer. See Step 4.

  **This is a cross-phase write, and it is deliberate.** `ocs-agent-setup` is
  the declared producer of that file; a Phase 6 skill appending two fields to it
  is the one place this skill reaches outside its own phase. It is a *write*,
  not a read, so it creates no `qa-and-training -> ocs` dependency and no cycle
  — `lib/artifact-manifest.ts` models producers and consumers, and has no way to
  express it, which is why it is stated here instead. The fields live with the
  chatbot's other identifiers because that is where an operator looks for
  chatbot state, and `ocs-agent-setup § Products` declares both as optional
  fields written from Phase 6. If this ever becomes a read as well, it is a
  cycle again — split it before it does.

## Process

### Step 0: Preconditions — say what is missing, do not improvise

Read `5-ocs/ocs-agent-setup.md`.

- **Absent.** Phase 5 did not run or did not complete. **No-op with a loud
  note** — record `status: skipped` with the reason. Do NOT create a chatbot;
  that is Phase 5's job and doing it here would produce a bot with no
  widget-handoff and no smoke gate.
- **Present.** Take `experiment_id`, `collection_id`, `pipeline_id`.

**Then check `last_reindexed_at` before uploading anything — this skill is
re-run.** Phase 6 is retried, `/ace:step ocs-knowledge-refresh` is a supported
manual entry point, `/ace:iterate` targets phases 3+4+6 by default, and a fork
replays the tail of a run. `ocs_upload_collection_files` **appends**; it does
not replace. Uploading the same four documents into the same collection a
second time leaves duplicates in the index — worse retrieval, a second 5–10
minute indexing wait, and a file count that no longer means what the product
artifact says it means.

- **`last_reindexed_at` absent** → first pass. Continue.
- **`last_reindexed_at` present, and every training document is older than it**
  (compare Drive `modifiedTime`) → **no-op.** Record `status: skipped` with
  `reason: already-current` and the existing `version_number`. Do not re-upload
  and do not re-index.
- **`last_reindexed_at` present but a training document is NEWER** → the
  documents changed after the last refresh, so the collection is stale.
  **Delete the previously-uploaded training files from the collection first**
  (`ocs_download_file` is not needed; list the collection and remove the four
  by filename), then continue from Step 1. Appending on top of the old copies
  is the failure this branch exists to prevent.

`ocs-agent-setup § Step 0` short-circuits the same way on a re-run; this skill
did not until 0.13.1037.

Then read the four training documents. **Do not tolerate a missing one
silently** — that is the failure this skill exists to end. Record each missing
document by name in the product artifact and in the step record, upload the
ones that exist, and carry on. A partial refresh that says which documents are
missing is recoverable; a silent one is not.

### Step 1: Upload

`ocs_upload_collection_files({ collection_id, files: [...] })` with the training
documents that exist.

Download each document with `drive_read_file({exportAs: 'text/markdown',
writeToPath: <abs tmp path>})` into ONE directory, then — before any upload
call — run the strip pass over that directory:

```bash
ACE_ROOT="${CLAUDE_PLUGIN_ROOT:-$(python3 -c "import json,os; d=json.load(open(os.path.expanduser('~/.claude/plugins/installed_plugins.json'))); print(d['plugins']['ace@ace'][0]['installPath'])")}"
npx --prefix "$ACE_ROOT" tsx "$ACE_ROOT/scripts/strip-inline-data-uris.ts" <download-dir>
```

It rewrites in place and prints one JSON line of per-file
`{bytes_before, bytes_after, payloads_stripped}`. **Record those numbers in the
product artifact.** A non-zero exit means a payload survived a shape the
stripper does not know about — do NOT upload; report it on
dimagi-internal/ace#1827 with the file.

Three constraints carry over from `ocs-agent-setup § Step 5` and are not
restated in full here — read them there:

- **Spreadsheets cannot be indexed** (`is_index: true` collections use the
  `file_search` allowlist). Upload a text extract instead.
- **Never index `2-scenarios/pdd-to-test-prompts.md`** — it carries the deep-QA
  answer key, and indexing it makes the eval grade the bot on documents
  containing its own expected answers.
- **Never index a base64 payload.** `exportAs: 'text/markdown'` inlines every
  embedded image as a `data:` URI, so an illustrated guide arrives at 8–28x its
  prose size and that bulk becomes indexed retrieval content. On
  `bednet-check-2-visit/20260828-0629` the four-document pack was **91% base64
  by volume** and the FLW guide alone was 264,538 bytes carrying ~9 KB of prose
  (16 screenshots). Nothing failed — the upload succeeded and indexing reported
  `ready: true, pending: 0` — the chunks just competed with real prose for the
  bot's `max_results` retrieval slots. `scripts/strip-inline-data-uris.ts` above
  is the fix; it is mandatory, not advisory. The images are not lost: they live
  in the published Google Doc the reader opens, which is also what
  `training-*-eval` counts (`docs_get` → `inlineObjects`), so stripping the
  uploaded copy costs nothing downstream.

### Step 2: Wait for indexing

`ocs_wait_for_collection_indexing({ collection_id, timeout_sec: 300 })`.

This is the 5–10 minutes. It is the cost of the bot knowing its own training
material; do not skip it to save wall-clock, and do not report success before
it returns.

### Step 3: Publish

`ocs_publish_chatbot_version({ experiment_id })`. The prompt is unchanged —
this republish exists so the new collection contents are live. Capture the new
`version_number`.

**That return is the POST-publish published default.** Before ace#1828 it was a
page scrape that could lag the publish by one, and on
`bednet-check-2-visit/20260828-0629` it did: the atom returned 2 for a publish
that created 3, and this step's write-back would have put a stale version into
`run_state.yaml`. The atom now reads it back from the API. Two things still
worth knowing:

- **`task_id: "none"` is not a signal.** It is present on a publish that did
  real work. A return whose number looks unchanged is not evidence of a no-op —
  do not republish to chase it.
- **If `source` comes back `home-page-badge`,** the API read failed and the
  number is the old scrape. Corroborate with
  `ocs_inspect_chatbot({ public_id, version: 'default' })` → `version_number`
  before writing it in Step 4. That call is also the independent authority in
  general — but read it under `version: 'default'`, never the top-level
  `version_number`, which is the working/next counter and runs ahead.

### Step 4: Write back

Write the product artifact, and update `5-ocs/ocs-agent-setup.md` with
`last_reindexed_at` (ISO timestamp) and the new `version_number`.

**`last_reindexed_at` is the operator's check.** Its absence on a run whose
Phase 6 completed means the chatbot never received the training documents.

Then write **`knowledge_sources`** into
`run_state.yaml` → `phases.ocs-setup.products.ocs_chatbot` — a list of short
human-readable phrases naming what the bot was actually given:

```
update_yaml_file(run_state_file_id, merge: 'deep',
  validateAs: {kind: 'phase-products', phase: 'ocs-setup'},
  patch: {phases: {'ocs-setup': {products: {ocs_chatbot: {
    version_number: <new>,
    last_reindexed_at: <iso>,
    knowledge_sources: [
      'the design doc',
      'the training pack (LLO manager guide, FLW training guide, FAQ, and quick reference card)',
      'the Learn and Deliver app guides',
      ...
    ]}}}}})
```

**This is the only producer of that field, and it is load-bearing.** ace-web's
public run-summary page reads it (`apps/opps/summary.py :: _knowledge_sources`,
accepting `knowledge_sources` / `knowledge` / `indexed_sources`) and renders
*"Ask questions about this opportunity. It was given &lt;list&gt;."* Until
ace-web#740 that sentence was a **hard-coded** claim — *"Trained on the design
doc, training pack, and app guides"* — derived from nothing, and on
`spark-facilitator/20260820-0817` it was false: the collection held 16 files
and **none** of the training pack. ace-web made it data precisely because this
skill makes the claim true for some runs and leaves it false for others, and a
constant string cannot tell them apart.

So the field is not decoration — it is the evidence for a claim an external
partner reads. Omit it and the page correctly falls back to saying nothing
about what the bot knows, which is honest but throws away the whole point of
having run the refresh. Write it in the same call that records
`last_reindexed_at`.

**Phrases, not filenames.** They are rendered into an English sentence for a
reader with no ACE context, so `'the training pack (LLO manager guide, FLW
training guide, FAQ, and quick reference card)'` reads correctly where
`'19-training-quick-reference.md'` does not. Group related files; keep the list
to ~5 entries. Describe only what is **actually indexed** — a document you
skipped (see Step 0) must not appear here.

*Enforced:* `ocs_chatbot` is `.passthrough()` in `lib/phase-products-schema.ts`,
so `validateAs` accepts the field rather than rejecting it as drift.

## Verdict

No paired `-eval`. The check is structural and lives in the product artifact:
documents uploaded vs. documents expected. A count mismatch is a `[WARN]` with
the missing filenames; zero uploaded when Phase 6 produced documents is a
`[BLOCKER]`.
