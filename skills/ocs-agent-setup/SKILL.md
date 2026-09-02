---
name: ocs-agent-setup
description: >
  Clone the ACE OCS template into a per-opp chatbot, attach a RAG
  collection from PDD + training + app summaries, publish, return embed credentials.
disable-model-invocation: false
---

# OCS Agent Setup

Run end-to-end against the OCS MCP server (`mcp/ocs-server.ts`). Uses these
atoms: `ocs_list_chatbots`, `ocs_clone_chatbot`, `ocs_create_collection`,
`ocs_upload_collection_files`, `ocs_wait_for_collection_indexing`,
`ocs_set_chatbot_system_prompt`, `ocs_attach_knowledge`, `ocs_set_chatbot_tools`,
`ocs_publish_chatbot_version`, `ocs_get_chatbot_embed_info`.

Runs in Phase 5 as Step 1 under the `ocs-setup` agent. The agent handles
quality gating via the `ocs-chatbot-qa` → `ocs-chatbot-eval` pair (quick
+ deep) in subsequent steps, so this skill is now purely configuration —
no inline self-eval.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 1 | `1-design/idea-to-pdd.md` | RAG content + system prompt framing |
| Phase 3 | `runs/<run-id>/3-commcare/` (app summaries) | RAG content (app structure for the chatbot to answer "where do I find X" questions) |
| Phase 4 | `4-connect/connect-opp-setup.md` | opp framing for system prompt |

## Products

- `5-ocs/ocs-agent-setup.md` — chatbot identifiers (`experiment_id`, `version_number`, embed `public_id` + `embed_key`), plus `prior_run_bots:` (any same-opp bots from earlier runs, for `/ace:sweep ocs` disposal)

**Naming contract (ace#1017).** The per-opp chatbot is named
`ACE - <opp-name> (<run-id>)` — **run-scoped**, not opp-scoped. Every run
of an opp gets its own bot, indexed off that run's PDD and app summaries,
exactly as every run gets its own Connect opportunity and its own
collection. A bare `ACE - <opp-name>` is a legacy pre-#1017 bot; treat it
as a prior-run artifact, never as this run's.
- `5-ocs/ocs-setup_widget-handoff.md` — widget URL + embed credentials staged for Connect HITL paste-in
- `run_state.yaml.phases.ocs-setup.products.ocs_chatbot` — `{experiment_id, public_id, embed_key, admin_url, team_slug}` typed handoff. Sole writer.

## Modes

- **Default (full setup).** Run every step end-to-end. Re-runs against
  an opp that already has a state file short-circuit at Step 0 — they
  skip to Step 10 (retrieve embed) with zero OCS calls.
- **`--prompt-patch`** (cheap iteration after `ocs-chatbot-eval --quick`
  fails). Reuses the existing chatbot, collection, and uploaded files;
  recomposes the system prompt against the latest PDD, calls
  `ocs_set_chatbot_pipeline` with the new prompt, and publishes a new
  version. Skips clone (Step 3), create collection (Step 4), upload
  (Step 5), and the 5–10 minute re-index (Step 6). Use this when the
  RAG content didn't change but the prompt needs a tweak — the typical
  outcome of a `--quick` quality fail.

### The knowledge base is populated in Phase 6, not here

This skill creates and publishes the chatbot and emits `widget_url`. It does
**not** put the Phase 6 training documents into the RAG collection — that is
`ocs-knowledge-refresh`, dispatched as the last step of `qa-and-training`.

The split is deliberate and load-bearing. Bundling both halves here required
reading `6-qa-and-training/*` from Phase 5, before Phase 6 has run. That read
was made *tolerant of missing files* on 2026-05-15, which stopped the crash and
left the defect: nothing re-uploaded them afterwards, so **every opportunity's
chatbot shipped without the four documents its users ask about**, silently, for
months. Phase 5 now consumes nothing from Phase 6 at all, so the failure is not
expressible here. See `skills/ocs-knowledge-refresh/SKILL.md`.

## Sequencing contract — dependent OCS calls run STRICTLY serially (jjackson/ace#585)

Every OCS call below that consumes an identifier produced by an earlier
call (`create_collection` needs the cloned `experiment_id`; `upload`
needs `collection_id` + the returned `file_ids`; `set_chatbot_pipeline`
needs `pipeline_id`; `publish` / `get_chatbot_embed_info` need
`experiment_id`) MUST be issued **one at a time, each AFTER the producing
call's real result has flushed to context.** Do NOT batch dependent OCS
calls in a single parallel block. Under OCS/Drive result-delivery
latency, a real result can arrive several turns after its call; batching
dependents makes it tempting to "fill the gap" with an invented
placeholder id — the documented #1 Phase-5 derail (bednet-spot-check
20260530-2015: duplicate collections 486/487, 403 "Invalid widget embed
key" on placeholder `send_test_message`, and a `run_state` block written
with fabricated `experiment_id`/`public_id`/`embed_key`).

**NEVER fabricate, guess, or placeholder an OCS identifier.** Use only
IDs returned by a real, flushed tool result. If a result hasn't arrived,
WAIT for it — do not proceed with a stand-in. `classify_phase_writeback`
checks block *shape*, not ID realness, so a fabricated-but-well-formed
block passes structural validation; the only real guard is the live
round-trip gate in Step 11.5 below.

## Process

0. **Idempotency short-circuit (read state file first — runs before any
   OCS call).** Read `ACE/<opp-name>/runs/<run-id>/5-ocs/ocs-agent-setup.md`.
   - **State file absent.** Fresh setup. Continue to Step 1.
   - **State file present, `--prompt-patch` flag set.** Reuse the
     existing `experiment_id`, `collection_id`, and `pipeline_id`.
     Skip to Step 7 (recompose prompt) → Step 8
     (`ocs_set_chatbot_pipeline` with the new prompt and the existing
     collection list) → Step 9 (publish) → Step 10 (retrieve embed) →
     Step 11 (overwrite state file with the new `version_number`).
   - **State file present, no flag.** The chatbot is already
     configured; just refresh embed credentials. Skip to Step 10. Do
     NOT call `ocs_list_chatbots`, do NOT re-clone — the state file is
     authoritative.

   This step exists because Step 2's `ocs_list_chatbots` filter is the
   second-line idempotency check, not the first. A live OCS list call
   on every re-run wastes ~1s when the local artifact already has the
   answer; on a `--prompt-patch` re-run it would also walk the full
   pipeline (clone is a no-op when the bot exists, but the create
   collection / upload / wait-for-indexing branches re-fire and burn
   5–10 min) before the existing state would even be consulted.

1. **Read opportunity context from GDrive:**
   - PDD: `ACE/<opp-name>/runs/<run-id>/1-design/idea-to-pdd.md`
   - Opportunity details: `ACE/<opp-name>/runs/<run-id>/4-connect/connect-opp-setup.md`
   - App summaries: `ACE/<opp-name>/runs/<run-id>/3-commcare/`

2. **Check for existing chatbot via OCS list** (second-line idempotency
   — only reachable when Step 0 found no state file):

   **The bot name is RUN-SCOPED: `ACE - <opp-name> (<run-id>)`**
   (dimagi-internal/ace#1017). Filter by that **exact** string —
   including the run-id — never by `ACE - <opp-name>` alone.

   Why the run-id is load-bearing: a run-blind name match resumes the
   *previous* run's chatbot, reusing that run's collection, that run's
   uploaded files and that run's system prompt, then reporting Phase 5
   as configured. Its collection is indexed off a **superseded PDD and
   superseded app summaries**, which violates the phase-precondition
   rule (CLAUDE.md § "Phase preconditions are restored, not adapted" —
   Phase 5's precondition is "a chatbot whose knowledge base is *this
   run's* artifacts"). The failure is silent and downstream-expensive:
   Phase 6 training docs, `/ace:qa-deep`'s deep verdict, and the Phase 8
   activation gate all then measure a bot built from the wrong run's
   design. Live case: opp `hh-poverty-targeting` carried both
   `ACE - hh-poverty-targeting` (12517, built from a PDD a domain expert
   had already critiqued) and `ACE - hh-poverty-targeting (20260722-1341)`
   — a literal reading of the old filter resumed 12517.

   The check still earns its keep with the run-id in it: it stops a
   mid-run crash from re-cloning and orphaning a bot (there is no
   cleanup atom), while making a *different* run's bot correctly
   not-a-match.

   - Call `ocs_list_chatbots` and filter by `name == "ACE - <opp-name> (<run-id>)"`.
     The match needs `name`, `id` and `experiment_id` only, all of which the
     default (projected) row carries. As of ace#1901 the row does NOT carry
     `versions[]` — it carries `versions_summary`
     ({`count`, `published_version_number`}) instead, because on a mature team
     the full array overflowed the tool-result cap and the DEFAULT page
     returned nothing usable. `versions_summary.published_version_number` is
     the ace#891-correct published version; the row's own `version_number` is
     the WORKING counter and must not be written to the state file as
     "published". Anything else about versions comes from the
     `ocs_get_chatbot` call the next bullet already makes.
   - If found, **read the integer `experiment_id` from the matched entry** (returned alongside the UUID `id` as of 0.5.19), reconstruct the state file from `ocs_get_chatbot` to populate `collection_id` / `pipeline_id`, and skip to step 11. Do NOT clone — re-cloning leaves the prior bot orphaned in OCS, which has no MCP-side cleanup atom. The previous (pre-0.5.19) skill version had to clone a `-resume` variant because the integer id wasn't reachable from list results; that footgun is closed.
   - **Prior-run bots are NOT a match and MUST NOT be resumed.** If the
     list contains other `ACE - <opp-name>…` entries (bare, or carrying a
     different run-id), record them in the state file under
     `prior_run_bots:` with their experiment ids so `/ace:sweep ocs` can
     dispose of them, and continue to step 3.
   - Otherwise continue to step 3

3. **Clone the golden template:**
   - `ocs_clone_chatbot({ template_id: $OCS_GOLDEN_TEMPLATE_ID, new_name: "ACE - <opp-name> (<run-id>)" })`
     — run-scoped name, matching the Step 2 filter exactly (ace#1017).
   - Capture `{experiment_id, public_id, pipeline_id}`

3.5. **Post-clone liveness gate (mandatory — runs BEFORE the collection
    build, dimagi-internal/ace#1492).** A freshly cloned chatbot is not
    guaranteed to be able to generate. Prove it can, before spending
    5–10 minutes building and indexing a collection for it.

    - `ocs_get_chatbot_embed_info({ experiment_id })` for the new clone,
      then send ONE probe (`ocs_send_test_message(public_id, embed_key,
      "ping")`, or the raw widget handshake `POST /api/chat/start/` →
      `POST /api/chat/<sid>/message/` → `GET /api/chat/<sid>/<tid>/poll/`).
    - **On success:** continue to Step 4.
    - **On failure: probe `$OCS_GOLDEN_TEMPLATE_ID` the same way, in the
      same session, before reporting anything.** The two results together
      are the diagnosis; either one alone is misleading.

    | clone | golden | What it means | What to do |
    |---|---|---|---|
    | fail | fail | The TEAM's LLM provider key is dead or the platform is down (the ace#743 class) | Re-key the provider at `/a/<team>/service_providers/llm/<pk>/`. Re-cloning will not help. |
    | fail | **pass** | **The clone mechanism is broken** (ace#1492) | Halt the phase. Do **NOT** touch the prompt or the collections — they are not the cause, and `--prompt-patch` cannot fix this. File/escalate. |
    | pass | — | Healthy clone | Continue to Step 4. |

    This is an **observing** gate — it performs the call and branches on
    the real result. It is not a predictive guard and must never be
    reduced to one.

    Why it exists: without it, a dead clone is only discovered at the
    Phase 5 quick gate, *after* the collection build, and it presents
    there as a **quality** failure. The documented remedy at that point
    (`--prompt-patch` → re-run qa+eval → escalate) then aims the whole
    retry loop at the prompt, which is provably not the cause. On
    `bednet-check-2-visit/20260817-1720` that cost an entire phase
    budget: the prompt was rewritten twice, the per-opp collection was
    rebuilt from scratch, and the shared collection was swapped, before
    a virgin-clone control identified the clone itself. The 2×2 above is
    what that session had to derive by hand.

4. **Create a per-opp Collection:**
   - `ocs_create_collection({ name: "ACE <opp-name>", summary: "Knowledge base for <opp-name> — PDD, training, app summaries", is_index: true, is_remote_index: false })`
   - `llm_provider` and `embedding_model` default from `OCS_LLM_PROVIDER_ID` and `OCS_EMBEDDING_MODEL_ID` env vars (required for indexed collections)
   - Use `is_remote_index: false` (local index) — remote indexes crash with 500 on the connect-ace team
   - Capture `collection_id`

5. **Upload RAG files (PDD + source inputs + training + summaries).**

   The canonical KB recipe is **PDD + inputs + training + app summaries**
   (per [#106 finding 15](https://github.com/jjackson/ace/issues/106)).
   Indexing the source documents directly alongside the synthesized PDD
   gives the bot procedural fidelity for SOP-level questions where the PDD
   summary may have lost detail. The pre-fix recipe was PDD-only; that lost
   the original SOP wording.

   **SPREADSHEETS CANNOT BE INDEXED — convert, don't upload
   (dimagi-internal/ace#1296).** This collection is created `is_index: true`,
   and OCS applies a DIFFERENT allowlist to indexed collections
   (`apps/documents/views.py::add_collection_files` branches on
   `collection.is_index`): `file_search`, which contains **no** spreadsheet
   format. `.xls` / `.xlsx` / `.csv` are accepted only for NON-indexed media
   collections, which is what makes this easy to get wrong — the file type
   looks supported, and OCS's own `SUPPORTED_FILE_TYPES` constant does list it.
   OCS silently DROPS the rejects from an otherwise-successful multi-file POST,
   so pre-#1296 the loss surfaced only as a count mismatch naming a number and
   not a file.

   `ocs_upload_collection_files` now refuses the whole batch up front and names
   the offending files, so nothing lands and a corrected retry is clean. To
   index a workbook's content, upload a **text extract** of it (`.md` / `.txt`)
   — which is what ACE already does when it writes a structured extract
   alongside the source workbook.

   **NEVER INDEX THE DEEP-QA INSTRUMENT
   (`2-scenarios/pdd-to-test-prompts.md`) — hard exclusion, no archetype
   exemption (dimagi-internal/ace#1018).** That file is not neutral
   background: every entry is a question plus an
   `expected_answer_summary` that `ocs-chatbot-eval --deep` reads as
   **ground truth**. Indexing it makes the pipeline "plant the answer key
   in the bot's retrieval corpus → ask the bot those questions → grade it
   against the key it can retrieve." The deep verdict is not advisory —
   `agents/ocs-setup.md` states the Phase 9 `llo-launch` gate refuses to
   proceed without a fresh passing one — so the gate would then pass on
   evidence it should not. The contamination inflates exactly the
   dimensions the rubric weights most (Correctness 30%, Source usage 20%
   — the bot can cite the instrument itself) and is worst on adversarial
   prompts, which is where the instrument has the most value: a bot that
   can retrieve "expected: reports Q1 as open" is not being tested on
   judgment. The pre-#1018 rule indexed it always, justified as
   "simpler", trading a measurement guarantee for uniformity. Nothing
   else in this recipe depends on the file.

   The same rule generalizes: **do not index any artifact that a `-eval`
   skill declares as a ground-truth input.** Check the eval skills'
   `## Inputs` tables before adding a new file class here.
   `test/skills/kb-instrument-contamination.test.ts` pins the specific
   case.

   **NEVER INDEX A BASE64 PAYLOAD — strip every downloaded file before
   uploading it (dimagi-internal/ace#1827).** `exportAs: 'text/markdown'`
   (mandated below) inlines every embedded image in a native gdoc as a
   `data:image/...;base64,...` URI, so an illustrated document arrives at
   8–28x its prose size and that bulk lands in the retrieval corpus. Measured
   on `bednet-check-2-visit/20260828-0629`: the four-document training pack was
   **91% base64 by volume**, and its FLW guide exported at 264,538 bytes
   carrying ~9 KB of prose plus 16 screenshots. Nothing fails — the upload
   succeeds and indexing reports `ready: true, pending: 0` — the base64 chunks
   simply compete with real prose for the bot's retrieval slots on every
   question. This bites here as well as in `ocs-knowledge-refresh`: the PDD and
   anything under `inputs/` are native gdocs too, and an SOP with diagrams has
   exactly the same shape.

   After downloading every file (all of them via `writeToPath`, see below) and
   before the first `ocs_upload_collection_files` call, run one pass over the
   download directory:

   ```bash
   ACE_ROOT="${CLAUDE_PLUGIN_ROOT:-$(python3 -c "import json,os; d=json.load(open(os.path.expanduser('~/.claude/plugins/installed_plugins.json'))); print(d['plugins']['ace@ace'][0]['installPath'])")}"
   npx --prefix "$ACE_ROOT" tsx "$ACE_ROOT/scripts/strip-inline-data-uris.ts" <download-dir>
   ```

   It rewrites in place and prints one JSON line of per-file
   `{bytes_before, bytes_after, payloads_stripped}`. A non-zero exit means a
   payload survived a shape the stripper does not know about — do NOT upload;
   report it on ace#1827 with the file. The images themselves are not lost:
   they stay in the published Google Doc a human opens, which is also the copy
   `training-*-eval` counts images in (`docs_get` → `inlineObjects`), so the
   indexed copy never needed them.

   Do not hand-roll the strip inline. Both upload paths download with
   `writeToPath` precisely so the bytes never enter context, so there is no
   in-context text for a regex to run over — the pure helper is
   `lib/inline-data-uri.ts`, the runnable form is the script above, and
   `test/skills/ocs-upload-strips-data-uris.test.ts` pins both skills to it.

   Files to gather:
   - `00-program-contacts.md` — **GENERATED BY THIS STEP, not read from
     Drive.** The canonical contacts page: escalation address, ACE admin
     group, role→contact map. Compose it locally, write it to an absolute
     tmp path, and upload it with the rest. Shape + sourcing rules in the
     § "The generated contacts file" block below. This file is what makes
     the escalation address *retrievable* — without it the address exists
     only in the system prompt and the bot reproduces it from recall,
     which drifts (ace#1665).
   - `runs/<run-id>/1-design/idea-to-pdd.md` — synthesized PDD
   - `inputs/*` — every file in the opp's `inputs/` folder (SOPs,
     questionnaire templates, evidence packs). **Skip the spreadsheets
     themselves** and index their text extracts instead — see the
     conversion note above (ace#1296); an indexed collection rejects
     `.xls`/`.xlsx`/`.csv` outright.
     Use `drive_list_folder` + `drive_download_binary` for binary
     types (PDF, docx, xlsx — see also [#106 finding 4](https://github.com/jjackson/ace/issues/106));
     use `drive_read_file` for text files (markdown, plain text).

     **Pass `exportAs: 'text/markdown'` on every `drive_read_file` of a
     RENDERED gdoc** (the PDD and the Phase-6 training docs are all native
     Google Docs). The default `text/plain` export strips headings, bold and
     table syntax, so the collection would be indexed on a flattened,
     structure-less copy of the document.

     **Always pass `writeToPath` (an absolute tmp path) on both**, then hand
     that path to `ocs_upload_collection_files`' `file_path` — the bytes never
     enter your context, and for a large text file `drive_read_file` refuses
     the inline read outright. `drive_download_binary` without `writeToPath`
     returns base64 at ~1.33x the file size and is refused above ~30 KB.
     (Both params landed in dimagi-internal/ace#1027 / #1177; before that this
     step named a recipe the atoms could not express.)
   - `runs/<run-id>/3-commcare/*` — app structure summaries

   **The generated contacts file (`00-program-contacts.md`) — ace#1665.**
   Every other file in this recipe is *copied* from Drive; this one is
   *composed* here, because no upstream artifact carries the programme's
   contacts as a single retrievable page. It exists so that the escalation
   address has a **retrievable anchor in the collection** rather than
   living only in the composed system prompt. A value that only the prompt
   carries is reproduced from prompt recall, and retrieval cannot correct
   it when it drifts: on `hh-poverty-targeting/20260824-1404` (experiment
   13014, collection 566) a 73-prompt deep run emitted `ace@dimagi.com`
   twice and a wholly invented `pm@dimagi-ai.com` once, while 27 other
   entries were correct. Under `ocs-chatbot-eval` §
   `fabricated_operational_specifics` each of those clamps the entry to
   Fail. (Distinct from ace#1142, whose prompt-side anti-fabrication guard
   in `scripts/bootstrap-ocs-golden-template.ts` is working and must not
   be edited — a prompt guard cannot anchor a value with no retrievable
   source.)

   Exact expected shape — a title, the one-line quoting rule, one table,
   nothing else:

   ```markdown
   # Program contacts — <opp-name> (<run-id>)

   These are the only contacts published for this opportunity. Quote any
   address, name, or URL on this page verbatim. If a question needs a
   contact that is not listed here, say the programme has not published
   one and point to the ACE admin group.

   Never name this page, this file, or any other knowledge-base file in
   an answer. Give the address itself. The reader cannot open a file in
   this knowledge base.

   | Role | Contact | Where this value comes from |
   |---|---|---|
   | ACE admin group — escalation of last resort | ace@dimagi-ai.com | `config/agent.json` → `email` |
   | Network Manager / awarded LLO | <selected_llo.contact_email> | `run_state.yaml` → `phases.solicitation-management.products.selected_llo.contact_email` |
   | LLO organization | <selected_llo.org_slug> | `run_state.yaml` → `phases.solicitation-management.products.selected_llo.org_slug` |
   | Connect opportunity (worker-facing surface) | <opportunity_url> | `run_state.yaml` → `phases.connect-setup.products.connect.opportunity.url` |
   | Named programme contact(s) | <name — role — address> | the PDD, verbatim only |
   ```

   Sourcing rules, in force per row:

   - **The ACE admin group row is the only always-present row**, and its
     value is read from `config/agent.json` → `email` — not typed from
     memory and not copied from this SKILL.md. It is the one address the
     bot is always allowed to offer.
   - **Every other row is included only if its authoritative source
     resolves to a real value in THIS run.** Phase 5 normally runs before
     Phase 8, so `selected_llo` is usually absent — that is the expected
     case, and the LLO rows are then simply **omitted**. Do not write
     "TBD", "the Network Manager", a placeholder, or a plausible address:
     an omitted row makes the bot say the programme has not published one;
     a filled-in placeholder makes it hand an operator something to act on
     (CLAUDE.md § No inferred backstory).
   - **A PDD row is included only when the PDD states that person's
     contact verbatim.** A name with no address is not a contact row —
     it belongs in the prompt's "Name the Network Manager / LLO(s)"
     bullet, not here.
   - Write no other sections. Anything on this page is retrievable and
     will be quoted as authoritative.

   For each file, base64-encode the content (the upload atom takes
   base64). Upload in one call:

   - `ocs_upload_collection_files({ collection_id, files: [...] })`
   - Capture `file_ids`

   Note on PDF token cost: source PDFs can be large. OCS's indexer
   chunks them, but the embedding cost scales with content. If the
   inputs/ folder has >200 KB of PDF content, log an `[INFO]` line
   to `comms-log/observations.md` so the operator can audit.

6. **Wait for indexing:**
   - `ocs_wait_for_collection_indexing({ collection_id, timeout_sec: 300 })`
   - On timeout, escalate to human

7. **Compose the system prompt** from the PDD + opp details + escalation rules. The prompt MUST:
   - **Match the OCS variable rule for the collection list you'll attach in step 8.** OCS rejects pipeline saves that violate this rule (verified 2026-04-28 via live probe): the prompt must contain the literal template variable `{collection_index_summaries}` **iff** you will attach **2 or more** collections. Single or zero collections must NOT include the variable; multiple collections MUST include it. As of 0.6.10 the MCP pre-flights both directions and fails fast with a typed error.
     - **If `$OCS_SHARED_COLLECTION_ID` is set** (you'll attach `[shared, opp]`, length 2): include `{collection_index_summaries}` in a "Knowledge:" or "Reference:" section. The token is interpolated at runtime with one-line summaries of every attached collection.
     - **If `$OCS_SHARED_COLLECTION_ID` is unset** (you'll attach `[opp]` only, length 1): do NOT include the variable. Reference the opp-specific collection content directly in the prompt body.
   - Identify the chatbot as the ACE support bot for this specific opportunity
   - **State whether this bot is the primary or supplementary facilitator surface**, based on the PDD's `archetype:`. For `focus-group`, the bot is the **primary** training + post-session writing surface — there is no Learn app carrying training content (the Learn app is a one-form sentinel readiness gate; see `pdd-to-learn-app/SKILL.md § Archetypes § focus-group`). The prompt should say verbatim: *"You are the **primary** facilitator-training and post-session writing-guidance surface for this opportunity. The CommCare Learn app is a one-form readiness gate, not a training curriculum. Facilitator training content lives here (this chatbot) + the per-opp handbook gdoc."* For `atomic-visit` and `multi-stage`, the bot is supplementary to a real Learn app — say so explicitly so retrieval doesn't over-confidently answer training-content questions.
   - Name the Network Manager / LLO(s) and key dates
   - Summarize the intervention (from PDD)
   - **Tell the bot to escalate to the ACE admin group on specific
     triggers, and to take the address FROM `00-program-contacts.md` in
     the opp collection — never from memory (ace#1665) — and NEVER to
     name that file, or any internal artifact, to a user
     (dimagi-internal/ace#1891).** Do NOT restate the address inline in
     this composed prompt. Retrieval is the anchor: an address the prompt
     carries and the corpus does not is reproduced from recall, which
     drifted three times on one 73-prompt deep run (see § Step 5, "The
     generated contacts file").

     **Retrieval source and user-facing answer are two different
     things, and the first version of this instruction conflated them.**
     Telling the bot to quote *from a named file* invites it to name the
     file: across the 68-prompt deep run on
     `spark-facilitator/20260828-0703` the bot routed escalation to
     **the filename** in 7 entries (opp-20, opp-29, opp-42, opp-46,
     opp-52, opp-57, cg-2) — telling a field supervisor to consult
     `00-program-contacts.md`, which they cannot open — and in 2 of
     those it emitted the wrong domain from recall while doing it ("the
     contact is in `00-program-contacts.md`; if you do not have that
     file to hand, use `ace@dimagi.com`"). The deep verdict's own words:
     *"A supervisor cannot open a KB filename."*

     **The file stays. The naming stops.** The fix is NOT to inline the
     address in the prompt — that is precisely the recall path ace#1665
     closed, and the same run still drifted to `ace@dimagi.com` on
     opp-29 and opp-38 from prompt recall alone. Retrieval remains the
     authority; the prompt gains a presentation obligation.

     The composed prompt MUST say, as two obligations: *"Contacts for
     this opportunity — the ACE admin group's escalation address and
     every named contact — are in the opportunity knowledge base. Quote
     them verbatim from there. If a contact you need is not published,
     say the programme has not published one and offer the ACE admin
     group; never supply an address from general knowledge or vary the
     spelling of one."* and *"Give the reader the contact itself — the
     actual address. NEVER name a file, document, collection, config key
     or other internal artifact in an answer, and never tell the reader
     to look one up: internal file names are retrieval plumbing and the
     reader has no way to open them. If you cannot retrieve a contact,
     say so plainly — do not substitute a file name for an answer."*
     The golden template's own inline address
     (`scripts/bootstrap-ocs-golden-template.ts`, the ace#1142
     anti-fabrication guard) stays as written — it is the cold-start
     fallback for the window before the collection is attached and
     indexed, and `00-program-contacts.md` is the retrievable
     corroboration for it. Do not edit that guard.
   - Reference the relevant knowledge sources (the shared Connect collection and/or the opp-specific collection, matching what you'll attach in step 8)
   - **Make tagging a MANDATORY CLOSING STEP of every answer, with the
     two triggers written as TESTS — not as a description
     (dimagi-internal/ace#1646).** `ocs-chatbot-eval`'s deep rubric
     weights Tagging at 15%, and on a clean fully-passing 51-prompt deep
     run (`bednet-check-2-visit/20260825-1310`, experiment 13005) the bot
     scored **5.0/10** on that dimension — its weakest — purely from
     inconsistency: 5 of 8 expected tags missed, while defensible tags
     appeared on seven entries the instrument expected none for. It is
     not inability to tag; tagging was never triggered reliably. Every
     other high-consequence behaviour in this checklist got a mandatory,
     checkable instruction and held at 51/51. This one was written as a
     description, and it is the one that came back at 5.0.

     The composed prompt MUST therefore state, as an obligation:

     - **Every answer ends with a tag line** — either the applicable
       tag(s) or an explicit statement that none applies. Never silently
       omit it.
     - `[training-gap]` — apply when *the question reveals a worker did
       not absorb something the Learn app teaches, **and** the answer is
       in the knowledge base.*
     - `[product-feedback]` — apply when *the person is reporting a bug,
       **OR** the answer names a known limitation of the app or of
       Connect.*

     The second half of the `[product-feedback]` trigger is the
     load-bearing one. On that run, prompts 9 and 10 both *correctly
     volunteered a known product limitation* (a declining household
     still produces a case record; photo/GPS are out of scope and the
     Connect flags are refused) — precisely the trigger — and neither
     tagged it. The bot reached for the tag when someone **reported**
     something and not when it **volunteered** a limitation, so state
     both halves explicitly rather than relying on "per the golden
     template conventions".

     Why it is worth the prompt real estate even though it degrades no
     answer: these tags are how training gaps and product defects get
     routed out of live LLO conversations. A 60% miss rate on
     `[product-feedback]` means real limitation reports go unrouted once
     LLOs are on the bot.

8. **Patch the chatbot in one transactional call:**
   - Build the collection list:
     - `[$OCS_SHARED_COLLECTION_ID, collection_id]` if the env var is set (multi — prompt MUST have the variable per step 7)
     - `[collection_id]` if the env var is unset (single — prompt MUST NOT have the variable per step 7)

   **Shared-collection bleed warning** (per [#106 finding 14](https://github.com/jjackson/ace/issues/106)).
   When `$OCS_SHARED_COLLECTION_ID` is set, the shared collection (e.g.
   the Connect-general "NM Bot" collection 350) competes with the
   opp-specific collection for retrieval slots. On generic prompts
   ("how do I claim this opportunity?"), shared often outweighs
   opp-specific — the bot answers from the shared collection's stale
   exemplar opp ("6 modules") rather than the LEEP-specific Learn app
   ("8 modules"). The prompt SHOULD therefore explicitly steer
   retrieval toward opp-specific content for any
   identifier-bearing question:
   - In step 7's prompt, after the `{collection_index_summaries}`
     section, add: *"When answering questions about THIS specific
     opportunity (visit counts, module structure, payment unit
     details, FLW eligibility), prefer information from the
     opp-specific knowledge collection over the shared
     CommCare-Connect collection. The shared collection is for
     cross-opp Connect-product questions only."*
   - Future fix tracks: dropping the shared collection entirely for
     opp-specific bots is one option (would require recomposing the
     prompt to drop the variable per the cross-field invariant); a
     retrieval-weight knob in OCS is another. Until either ships, the
     prompt-side hint is the only ACE-side lever.

   - `ocs_set_chatbot_pipeline({ experiment_id, prompt, collection_index_ids: <built above>, max_results: 20, generate_citations: true })`
     One transactional save, prompt + collections in one POST. The bundled atom pre-flights the OCS cross-field rule (`{collection_index_summaries}` iff length>=2); a typed `PipelineValidationError` is raised if the merged state would violate it.

9. **Publish a version:**
   - `ocs_publish_chatbot_version({ experiment_id, description: "Initial ACE version for <opp-name>" })`
   - **Record the `version_number` it returns — that is the POST-publish
     published default** (ace#1828 made the atom read it back from the API
     instead of a page scrape that could lag the publish by one). Do **not**
     substitute `ocs_inspect_chatbot`'s top-level `version_number`: that is the
     working/next counter and runs ahead of the published one (observed 3 while
     the published default was 2). If you need to corroborate independently,
     the authoritative read is `ocs_inspect_chatbot({ public_id, version:
     'default' })` → `version_number`.
   - **`task_id: "none"` is not a signal.** It is present on a publish that did
     real work, so it says nothing about whether anything happened. If `source`
     comes back `home-page-badge`, the API read failed and the number is a
     scrape that may be stale — corroborate before writing it in Step 11.

10. **Retrieve embed credentials:**
    - `ocs_get_chatbot_embed_info({ experiment_id })`
    - Capture `{public_id, embed_key}`

11. **Write state file:** `ACE/<opp-name>/runs/<run-id>/5-ocs/ocs-agent-setup.md`
    - Fields: `experiment_id`, `public_id`, `embed_key`, `collection_id`, `pipeline_id`, `version_number`, `created_at`, optional `last_prompt_patched_at` (set by `--prompt-patch` re-runs), optional `last_reindexed_at` + refreshed `version_number` (written by `ocs-knowledge-refresh` in Phase 6; ABSENCE on a run whose Phase 6 completed means the chatbot never received the training docs)
    - This file is the source of truth for idempotency — Step 0 reads it before any OCS call

11.5. **Hard embed round-trip gate (mandatory — runs before the
    `run_state` writeback, jjackson/ace#585).** The IDs about to be written
    must correspond to a LIVE OCS object, not a value carried through a
    latency window. Re-call `ocs_get_chatbot_embed_info({ experiment_id })`
    fresh and assert the `public_id` + `embed_key` it returns are exactly
    the ones captured in Steps 10–11. If they do not round-trip — or that
    `public_id` does not resolve to a live chatbot via
    `ocs_inspect_chatbot({ public_id })` — **fail the phase loudly** with a
    typed error naming the mismatch; do NOT write `products.ocs_chatbot`.

    **Use `ocs_inspect_chatbot`, not `ocs_get_chatbot`, as the liveness read.**
    When REST carries no integer id, `ocs_get_chatbot` resolves one by scraping
    the team's chatbots table — so its verdict depends on a server-rendered
    template ACE does not own. `ocs_inspect_chatbot` reads the same object over
    REST v2 and is scrape-independent. ace#1561: an OCS template change (PR
    #4220) made that scrape resolve nothing, and this gate became unsatisfiable
    for every bot on the team while the bots themselves were fine.
    (Optional belt-and-suspenders: also confirm exactly one collection
    named `ACE <opp-name>` exists via `ocs_list_*` to catch the
    duplicate-collection symptom.) This is the structural backstop that
    `classify_phase_writeback` cannot provide — it validates shape, not
    whether the IDs are real. Only on a clean round-trip proceed to Step 12.

12. **Write `products.ocs_chatbot` to `run_state.yaml`** so downstream
    readers (ace-web summary, llo-onboarding, Connect handoff) can read
    the chatbot identity directly from typed state without parsing the
    widget-handoff markdown table.

    ```yaml
    phases:
      ocs-setup:
        products:
          ocs_chatbot:
            experiment_id: <UUID from Step 1>
            public_id: <from Step 10>
            embed_key: <from Step 10>
            team_slug: <OCS team slug — typically "connect-ace">
            admin_url: https://www.openchatstudio.com/a/<team_slug>/chatbots/<experiment_id>/
    ```

    Apply via `mcp__plugin_ace_ace-gdrive__update_yaml_file` with
    `merge: 'deep'` (partial patch of the `ocs-setup` phase child —
    `deep` preserves the phase's `status`/`steps`; `two-level` would
    drop them, #572/#587). Sole writer of `products.ocs_chatbot`. The
    `admin_url` is the OCS
    chatbot home page (auth-gated; useful for ACE operators with OCS
    access).

    **Also emit the PUBLIC chat URL** — build it with
    `buildOcsPublicChatUrl` from `lib/ocs-public-chat-url.ts`:

    ```
    https://www.openchatstudio.com/a/<team_slug>/chatbots/<public_id>/start/
    ```

    This is a real anonymous surface and it works — verified live
    2026-08-14 against `connect-ace`. It is what makes an ACE per-opp
    chatbot reachable by anyone you send the link to, with no OCS
    account. The route is TEAM-SCOPED (`apps/chatbots/urls.py:80`,
    mounted under `config/urls.py:88`'s `a/<slug:team_slug>/`), which is
    why probing `/chatbots/<public_id>/…` at the root 404s.

    Two things to know before you probe it (ace#1021):

    - **Carry cookies through the redirect.** `start_session_public`
      CREATES a session and 302s to `/s/<session_id>/chat/`, which is
      wrapped in `@verify_session_access_cookie` — a cookieless `curl`
      reads **404 on a perfectly working bot**. Use `curl -L -c jar -b
      jar` or a browser context.
    - **Publishing does NOT turn this URL on.** `start_session_public`
      resolves `resolve_published_or_working`, so an unpublished bot
      serves its working version here rather than 404ing. Publishing
      decides WHICH version answers, not whether the URL is live.
    - **The team's WEB channel must be enabled** — the one real gate,
      and the one live failure mode. `start_session_public` calls
      `_disabled_web_channel_response` before rendering the consent
      form (OCS #4230); if the team's `platform=WEB`
      `ExperimentChannel` has `enabled=False`, the URL returns the
      **503 maintenance page**, not a 404. It is a team-wide admin
      kill-switch, so flipping it takes down **every ACE per-opp chat
      URL at once** — `connect-ace` has such a channel
      (`connect-ace-web-channel`). If a handoff URL that used to work
      starts serving a maintenance page, check this before suspecting
      the bot (ace#1812).

    The old `/chatbots/embed/<public_id>/` path is genuinely gone — a
    410 stub since OCS #3540 (2026-08-03) — so do not emit it.

Quality gating (quick + deep qa→eval pairs) and Connect widget handoff
happen in subsequent steps of the `ocs-setup` agent, not in this skill.

## MCP Tools Used

- **OCS MCP (`ace-ocs`):** `ocs_list_chatbots`, `ocs_clone_chatbot`,
  `ocs_create_collection`, `ocs_upload_collection_files`,
  `ocs_wait_for_collection_indexing`, `ocs_set_chatbot_pipeline`,
  `ocs_publish_chatbot_version`, `ocs_get_chatbot_embed_info`.
- **Google Drive MCP (`ace-gdrive`):** `drive_read_file`,
  `drive_list_folder`, `drive_create_file`.

Authoring atoms route through Playwright (see
`mcp/ocs/capability-map.ts`); a live `/ace:ocs-login` session is
required.

## Mode Behavior

- **Auto:** Execute all steps. Surface errors with specific atom names.
- **Review:** Pause before step 3 (show composed prompt + file list) and before step 9 (show post-patch chatbot state before publishing a version).

## Dry-Run Behavior

When `--dry-run` is active:
- Every MCP atom call is logged to `ACE/<opp-name>/runs/<run-id>/5-ocs/ocs-agent-setup_dry-run-log.md` with atom name + args
- No HTTP goes out; atom responses are stubbed
- State tracks as `dry-run-success`

## Failure Modes

- `PipelineShapeError` — golden template invariant violated. Verify with `OCS_GOLDEN_TEMPLATE_ID` points at a template with exactly one `LLMResponseWithPrompt` node.
- `CollectionIndexingTimeoutError` — raise timeout; if persists, check OCS dashboard for the collection's indexing queue.
- `SessionExpiredError` — run `/ace:ocs-login` to re-authenticate.
- `HttpError 4xx` on clone — verify `OCS_GOLDEN_TEMPLATE_ID` and `OCS_TEAM_SLUG` env vars.
- Quality gate failure downstream — if `ocs-chatbot-eval --quick` or
  `--deep` scores below threshold in Phase 5, the usual fix is prompt
  engineering in step 7's composition. Re-run with `--prompt-patch`
  (skips the 5–10 min re-index since the RAG content didn't change),
  then re-run qa + eval. The `ocs-setup` agent's Phase 5 retry loop
  uses this mode automatically.

## Decisions Log

This skill writes load-bearing defaults to the per-run
`ACE/<opp-name>/runs/<run-id>/decisions.yaml`. The bar criterion and
schema live in `skills/idea-to-pdd/SKILL.md § Decisions Log Convention`
(canonical authority). The list below catalogs decisions that commonly
qualify under the bar for this phase — a working template, not a
required set. The skill applies the bar criterion and emits whatever
rows meet it; the catalog is a teaching device that improves over time.

### Common load-bearing decisions for Phase 5

| ID | Question | Map to surface |
|---|---|---|
| `system-prompt-baseline` | What baseline system prompt does the per-opp chatbot inherit (golden template default vs. customized for archetype)? | `ocs-chatbot-eval` rubric coverage |
| `rag-collection-scope` | What documents land in the per-opp RAG collection (golden defaults vs. opp-specific additions)? | `ocs-chatbot-eval` retrieval-quality dimension |
| `test-prompt-count` | How many test prompts feed the smoke-eval gate (default 5 quick, 90 deep)? | `pdd-to-test-prompts` output cardinality; deep vs shallow QA split |

The orchestrator's Phase Write-Back Verifier (`agents/ace-orchestrator.md`
§ Phase Write-Back Contract § Decisions log clause) enforces the
contract; the renderer (`skills/decisions-render`) regenerates the gdoc
at end of every phase.

Each row this skill writes uses `phase: 5-ocs` and
`skill: ocs-agent-setup`.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-09-01 | **Never name the contacts FILE to a user (dimagi-internal/ace#1891).** Step 7 told the bot to quote contacts *from a named file*, which invites the model to name the file: across the 68-prompt deep run on `spark-facilitator/20260828-0703` the bot routed escalation to `00-program-contacts.md` in **7 entries** (opp-20, opp-29, opp-42, opp-46, opp-52, opp-57, cg-2) — a file a field supervisor cannot open — and in 2 of those emitted the wrong domain from recall while doing it. The generated file STAYS (ace#1665: an address the prompt carries and the corpus does not is reproduced from recall, and the same run still drifted to `ace@dimagi.com` on opp-29/opp-38 from prompt recall alone — inlining the address would be more of that, not less). What changes is presentation: the composed prompt now carries a second obligation — give the reader the contact ITSELF, never a file/document/collection/config name, and say so plainly when retrieval comes up empty rather than substituting a filename for an answer. The generated page's own preamble carries the same rule, so retrieval reinforces it. *Enforced on the eval side:* `lib/internal-artifact-leak.ts` + `test/lib/internal-artifact-leak.test.ts` cap any response naming an internal artifact at <=6, with the seven verbatim responses as the fixture. | ACE team |
| 2026-08-29 | **The public-chat-URL gate this skill documented no longer exists upstream (ace#1812).** Step 10 said the URL "requires the PUBLISHED version to be public", `is_public` being `len(participant_allowlist) == 0`. OCS deleted both in #4275 (ADR-0057, merged 2026-08-26) — `gh search code --repo dimagi/open-chat-studio "is_public"` now returns zero hits repo-wide, while the same search for `participant_allowlist` returns 4 files, so the empty result is a real absence rather than an unindexed repo. `start_session_public` resolves `resolve_published_or_working`, so publishing is NOT a gate and an unpublished bot no longer 404s here. Replaced with the gate that IS live: the team's `platform=WEB` `ExperimentChannel` being enabled (#4230), which returns a **503** maintenance page and is a team-wide kill-switch taking down every ACE per-opp chat URL at once. Direction of the stale claim was benign — the removed gate only ever loosened access — which is why it survived three months undetected; the cost was that a future outage would have been triaged against a mechanism that is gone. *Enforced:* `test/skills/ocs-public-chat-gate-docs.test.ts`. | ACE team |
| 2026-05-05 | **Two idempotency improvements.** (1) New Step 0 reads the local state file (`runs/<run-id>/5-ocs/ocs-agent-setup.md`) before any OCS call — saves ~1s on a normal re-run and avoids the silent-pipeline-walk on `--prompt-patch` re-runs. (2) New `--prompt-patch` mode reuses the existing chatbot/collection/files, skipping clone + create-collection + upload + 5–10 min indexing wait, and just recomposes the prompt → calls `ocs_set_chatbot_pipeline` → publishes. This is the canonical Phase 5 retry path after `ocs-chatbot-eval --quick` flags a prompt issue (the previous skill prose said the agent should "retry prompt-patch" but no such mode existed — re-runs walked the full pipeline). | ACE team |
| 2026-05-08 | Add `## Decisions Log` section: 3 anchor rows (system-prompt-baseline, rag-collection-scope, test-prompt-count) + bar-criterion reference. Pairs with decisions-log PR #4 (Phase 3-10 writes). | ACE team (decisions-log PR #4) |
| 2026-05-15 | Add `2-scenarios/pdd-to-test-prompts.md` to the canonical KB recipe (Step 5); add archetype-aware "primary vs supplementary surface" line to the system-prompt composition checklist (Step 7) — for `focus-group`, the chatbot is the primary facilitator training + post-session writing surface. Make `6-qa-and-training/*` reads tolerant of missing files (Phase 6 may not have run yet in `/ace:run` flow). Prompted by `malaria-itn-fgd/20260514-2352` Phase 5 agent observations. | ACE team |
| 2026-08-18 | **New Step 3.5 — post-clone liveness gate, with a golden-template control.** Probe the fresh clone before building the collection; on failure probe `$OCS_GOLDEN_TEMPLATE_ID` too and branch on the 2×2 (both fail = team LLM key, the ace#743 class; clone fails + golden passes = the clone mechanism, ace#1492 — do NOT touch prompt or collections). Previously a dead clone surfaced only at the Phase 5 quick gate, *after* the 5–10 min collection build, and presented as a *quality* failure — so the documented remedy (`--prompt-patch` → re-run qa+eval) aimed the retry loop at the prompt, which cannot be the cause. On `bednet-check-2-visit/20260817-1720` that cost the whole phase budget before a virgin-clone control found it. Observing gate, not a predictive guard. | ACE team |
| 2026-08-25 | **Step 7: tagging is now a mandatory closing step with the two triggers stated as tests (dimagi-internal/ace#1646).** The composition checklist carried tagging as a single descriptive bullet ("use [training-gap] and [product-feedback] tags per the golden template conventions") with no obligation attached, and it is the one behaviour in that checklist that came back weak: 5.0/10 on the deep rubric's 15%-weighted Tagging dimension, 5 of 8 expected tags missed on a 51-prompt suite where content scored 49 Pass / 2 Warn / 0 Fail. Sharpest miss: two answers that correctly volunteered a known product limitation and did not tag it — the bot reached for `[product-feedback]` on a *reported* bug but not on a *volunteered* limitation, so both halves of that trigger are now spelled out. Validate with `--prompt-patch` (no re-index) plus a deep re-run. Observed on `bednet-check-2-visit/20260825-1310` Phase 5. | ACE team |
| 2026-08-26 | **Step 5 generates `00-program-contacts.md` into the KB; Step 7 points at it instead of restating the escalation address (dimagi-internal/ace#1665).** The recipe carried no file naming the programme's contacts, so `ace@dimagi-ai.com` lived only in the composed prompt — reproduced from recall, with no retrievable anchor for retrieval to correct. On `hh-poverty-targeting/20260824-1404` (experiment 13014, collection 566) a 73-prompt deep run emitted `ace@dimagi.com` twice and an invented `pm@dimagi-ai.com` once against 27 correct entries; under `ocs-chatbot-eval` § `fabricated_operational_specifics` each clamps to Fail. The contacts page sources the admin address from `config/agent.json` and OMITS any row whose authoritative source is absent in this run (usually the `selected_llo` rows, since Phase 5 precedes Phase 8) rather than filling a placeholder. The ace#1142 anti-fabrication guard in `scripts/bootstrap-ocs-golden-template.ts` is untouched and remains the cold-start fallback. Pinned by `test/skills/kb-contacts-present.test.ts`. | ACE team |
| 2026-09-01 | **Step 5: third upload constraint — strip embedded `data:` payloads before uploading (dimagi-internal/ace#1827).** `exportAs: 'text/markdown'` inlines every embedded image in a native gdoc as base64, so an illustrated document reaches the RAG index at 8-28x its prose size; on `bednet-check-2-visit/20260828-0629` the training pack was 91% base64 by volume and the FLW guide was 264,538 bytes for ~9 KB of prose. Every downloaded file now goes through `scripts/strip-inline-data-uris.ts` (pure helper `lib/inline-data-uri.ts`) before the first upload call. Note the export shape is a link-reference DEFINITION (`[image1]: <data:...>` + `![][image1]`), not the inline `![alt](data:...)` the issue proposed matching — that regex matches zero of the 16 payloads in the specimen. Pinned by `test/skills/ocs-upload-strips-data-uris.test.ts`. | ACE team |
