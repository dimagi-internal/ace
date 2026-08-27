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
- Updates `5-ocs/ocs-agent-setup.md` with `last_reindexed_at`.

## Process

### Step 0: Preconditions — say what is missing, do not improvise

Read `5-ocs/ocs-agent-setup.md`.

- **Absent.** Phase 5 did not run or did not complete. **No-op with a loud
  note** — record `status: skipped` with the reason. Do NOT create a chatbot;
  that is Phase 5's job and doing it here would produce a bot with no
  widget-handoff and no smoke gate.
- **Present.** Take `experiment_id`, `collection_id`, `pipeline_id`.

Then read the four training documents. **Do not tolerate a missing one
silently** — that is the failure this skill exists to end. Record each missing
document by name in the product artifact and in the step record, upload the
ones that exist, and carry on. A partial refresh that says which documents are
missing is recoverable; a silent one is not.

### Step 1: Upload

`ocs_upload_collection_files({ collection_id, files: [...] })` with the training
documents that exist.

Two constraints carry over from `ocs-agent-setup § Step 5` and are not
restated in full here — read them there:

- **Spreadsheets cannot be indexed** (`is_index: true` collections use the
  `file_search` allowlist). Upload a text extract instead.
- **Never index `2-scenarios/pdd-to-test-prompts.md`** — it carries the deep-QA
  answer key, and indexing it makes the eval grade the bot on documents
  containing its own expected answers.

### Step 2: Wait for indexing

`ocs_wait_for_collection_indexing({ collection_id, timeout_sec: 300 })`.

This is the 5–10 minutes. It is the cost of the bot knowing its own training
material; do not skip it to save wall-clock, and do not report success before
it returns.

### Step 3: Publish

`ocs_publish_chatbot_version({ experiment_id })`. The prompt is unchanged —
this republish exists so the new collection contents are live. Capture the new
`version_number`.

### Step 4: Write back

Write the product artifact, and update `5-ocs/ocs-agent-setup.md` with
`last_reindexed_at` (ISO timestamp) and the new `version_number`.

**`last_reindexed_at` is the operator's check.** Its absence on a run whose
Phase 6 completed means the chatbot never received the training documents.

## Verdict

No paired `-eval`. The check is structural and lives in the product artifact:
documents uploaded vs. documents expected. A count mismatch is a `[WARN]` with
the missing filenames; zero uploaded when Phase 6 produced documents is a
`[BLOCKER]`.
