---
name: idea-to-pdd
description: >
  Develop a Program Design Doc (PDD) for a Connect intervention from
  source material. Iterates a 5-question stress-test rubric until approved.
disable-model-invocation: false
---

# Idea to PDD

Take an initial idea and iterate on it to produce a complete Program Design Doc (PDD) that specifies a Connect application.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Operator | `ACE/<opp-name>/runs/<run-id>/inputs-manifest.yaml` | frozen pointer-set to source material captured at run-start |
| Operator | each `file_id` in the manifest | source content (PDFs, docs, sheets, markdown) |
| Prior runs | `ACE/<opp-name>/open-questions.md` § `## Open` (opp ROOT, durable across runs; passed inline at handoff when the orchestrator's bounds allow — ace#1487) | questions ALREADY raised/verified for this opp — read them back before raising your own (ace#1201). `## Archive` is never read back |
| Reviewer | comment threads on the PRIOR run's PDD, via `drive_list_comments` | what a domain expert asked for IN PLACE, anchored to the section they were reading |

## Products

- `1-design/idea-to-pdd.md` — the PDD
<!-- 0.13.116: legacy `1-design/idea-to-pdd_gate-brief.md` removed.
Pause-time summary at the Phase 1→3 Pause Point is composed by the
orchestrator from the per-skill QA + eval verdicts on the fly. -->

- `ACE/<opp-name>/runs/<run-id>/decisions.yaml` — structured per-run decisions log (always emitted; see `## Decisions Log Convention` below)
- `run_state.yaml.phases.idea-to-design.products.pdd` — `{title, description, file_id}` typed handoff for downstream readers (ace-web summary, future skills) so they don't need to parse the PDD body. This skill is the sole writer. (Pre-2026-05-26: `phases.design.products.pdd` — moved under the actual phase block to satisfy `lib/run-state-validator.ts` which requires every top-level `phases.*` key to be a phase block with `status`; see bednet-spot-check Phase 1 finding.)

## Process

1. **Read source material** for the PDD.

   Phase 1 synthesizes a PDD from whatever the human curated into
   `ACE/<opp-name>/inputs/`. The orchestrator captures a frozen
   pointer-set at run-start as
   `runs/<run-id>/inputs-manifest.yaml`. There is no
   required filename inside `inputs/` — anything goes (PDFs, docx,
   sheets, markdown notes, prior-pass drafts).

   **This skill never fetches source material itself.** Inputs are
   human-curated into Drive, and sourcing is an operator act upstream of
   the pipeline. If the official instrument is behind a login (a PPI/PMT
   portal, a Box-hosted resource page), the operator sources it once per
   `playbook/integrations/external-sourcing.md` — which records the Box
   failure ladder so it isn't re-derived — and drops the file in
   `inputs/`. See dimagi-internal/ace#890.

   **Read the opp's durable `open-questions.md` too** (opp ROOT, not under
   `inputs/`, so it is NOT in the manifest — the orchestrator passes its
   `file_id` inline at handoff; if it wasn't passed, resolve it via
   `resolve_opp_path` and read it when present). It carries questions prior
   runs already raised — and, in some rows, ANSWERS a prior run verified.
   Before adding a question of your own, check whether it is already there.

   **Read it with `exportAs: 'text/markdown'`** — it is a converted gdoc (see
   § The durable open-questions doc), and `drive_read_file`'s default
   `text/plain` export strips the `##` markers and flattens its tables to one
   cell per line, so `## Open` stops resolving and the question rows run
   together. Take the section from `extractOpenSection`
   (`lib/open-questions-inline.ts`), which excludes `## Archive`
   structurally and refuses a heading-stripped read instead of guessing at it.

   **Read the reviewer's COMMENTS on the prior run's PDD** — `drive_list_comments`
   on that PDD's `file_id`. ACE publishes the PDD as a Google Doc so reviewers can
   comment on it; those comments are review input exactly like an `inputs/` document.
   Treat each unresolved thread as a requirement to honour or to disposition
   explicitly. Use `quoted_text` to bind a comment to the section it sits on, and
   check that section against the comment before you rewrite it — a comment whose
   `quoted_text` no longer matches anything in your draft is the signature of the
   ace#979 regression class, where a fix was reverted while the disposition table
   still claimed it honoured. `resolved: true` means someone closed the thread in
   Drive, NOT that the build honoured it.

   **A COMMENT IS AN INBOX, NOT A STORE — convert it or lose it.** Every run writes a
   NEW PDD document (`runs/<run-id>/1-design/idea-to-pdd.md` has a fresh `file_id` per
   run — verified: `20260813-1612` is `14RRcWZH…`, `20260819-1435` is `1sKoXbVvEN…`).
   So a comment lives on a document no later run produces. This step reads the PRIOR
   run's PDD, which means an unconverted comment is read exactly ONCE, at run N+1, and
   is gone by N+2 — silently, with nothing reporting the loss. Comments accumulating
   on a superseded document are not a durable review record and must never be treated
   as one.

   So for EVERY comment you read, before the phase ends, carry its substance into
   durable **opp-level** state (which every future run re-reads) and then close the
   thread:

   1. **Write it into the opp's feedback record** — `ACE/<opp>/feedback/<YYYYMMDD>-<reviewer>.yaml`,
      verbatim, per `skills/feedback-ledger`. That file is opp-level and is the ledger's
      denominator, so once an item is there a later run that drops it renders as
      **UNROUTED** instead of vanishing. A comment that never reaches this file is not
      UNROUTED — it is absent, and the ledger cannot accuse what it was never told about.
   2. **Route the substance to its durable home**: a requirement → this run's PDD body
      (and it must survive into every later PDD); a question → `open-questions.md` §
      `## Open` (opp root); a choice → a `decisions.yaml` row, or
      `inputs/decision-overrides.yaml` when the reviewer's answer must bind future runs.
   3. **Reply and resolve** — `drive_reply_to_comment` with `action: 'resolve'`, naming
      WHERE it landed (the record slug + item id, the question row, the decision id).
      The thread then becomes an audit trail pointing at the durable record rather than
      being the record. Never resolve a thread whose substance is not yet carried
      forward: that destroys the only remaining copy.

   Do not ask the reviewer to maintain this themselves — deleting a comment once it is
   incorporated, or hand-editing the resolution into the body, is the reviewer doing by
   hand what this step exists to do, and it costs them the audit trail.

   **Read `## Open` ONLY.** The doc has exactly two sections (§ The durable
   open-questions doc below). `## Archive` is closed history — never read it
   back, never reason from it, never carry its rows into the PDD.

   **The orchestrator may pass less than the whole section, or nothing at
   all** (dimagi-internal/ace#1487): on a `/ace:iterate` fixture opp the
   ledger is not passed at all, and above the inline cap only the most recent
   `## Open` rows arrive with the `file_id`. That is deliberate — do NOT go
   fetch the rest to "be thorough". Reconcile against what you were given, and
   if the handoff said the inline was truncated or skipped, say so in the PDD's
   open-questions section rather than implying full coverage.

   For every pre-existing question **in `## Open` that you were passed**, this
   run must state one of:
   **resolves** (this run answers it — record the answer + evidence),
   **carries forward** (still open), or **contradicts** (this run's finding
   disagrees with a recorded, verified answer). A contradiction is LOUD:
   surface it in the PDD's open-questions section AND at the Phase 1→2 pause
   summary — never silently overwrite the prior answer. On
   `hh-poverty-targeting/20260812-1613` two items were contradicted with no
   signal at all, because the file was written every run and read by none
   (ace#1201).

   **Resolving a question MOVES it, it does not annotate it.** A row you
   resolve is removed from `## Open` and appended to `## Archive` with
   `resolved_at` / `resolved_by` / `resolution_note`. Never annotate in place
   ("RESOLVED 2026-05-03 by …") — that is exactly what made this doc grow
   without bound.

   Read `ACE/<opp-name>/runs/<run-id>/inputs-manifest.yaml`
   first via `drive_read_file`. The manifest shape is:

   ```yaml
   opportunity: <opp>
   run_id: <runId>
   captured_at: <ISO>
   inputs:
     - file_id: <id>
       name: <name>
       mime_type: <mime>
   ```

   For each entry, read its content **by type** — do not assume
   `drive_read_file` handles everything (it REFUSES binary formats —
   xlsx, zip/`.ccz`, images — with a typed `unsupported_binary_mimetype`
   error, so a naive read silently drops the file's content, not just
   its formatting). Dispatch on the entry's `mime_type` (and, for a
   `.ccz`, the filename extension — its mime is often a generic
   `application/zip` / `application/octet-stream`):

   - **Text-extractable** — Google Docs
     (`application/vnd.google-apps.document`), PDF (`application/pdf`),
     `text/*` (markdown, plain text), CSV / JSON / YAML / XML, and most
     Word (`.docx`) formats → `drive_read_file(file_id=<id>)`.
   - **Google Forms** (`application/vnd.google-apps.form`) →
     `get_google_form_definition(formId=<id>)` — `drive_read_file`
     returns nothing for a Form.
   - **Spreadsheets** — a Google Sheet
     (`application/vnd.google-apps.spreadsheet`) → read its tabs via
     `sheets_list_tabs` + `sheets_batch_read`. A native `.xlsx`
     (`…spreadsheetml.sheet`) → `drive_read_file` refuses it, so either
     read a sibling text/gdoc rendering of the same workbook if the
     human dropped one in (that rendering is authoritative — skip the
     raw file) or `drive_download_binary(file_id=<id>,
     writeToPath="/tmp/ace-pdd-inputs/<name>.xlsx")` and parse the file
     on disk (unzip → `xl/sharedStrings.xml` + `xl/worksheets/*.xml`)
     with a short Bash/python step. **Always pass `writeToPath`** — an
     `.xlsx` over ~30 KB is refused inline with `oversized_binary`, and
     base64 through context costs ~1.33x the file for no benefit when a
     Bash step is going to read the file anyway.
   - **An existing CommCare app (`.ccz`)** → parse it — see step 1b.
     This is ground truth (a real built app), not a notes file.
   - **Images / audio / other true binaries with no extractable text**
     → log the file by name ("supporting file present in `inputs/` —
     reference by name where it matters") and continue. **Do not halt**
     on these — the human dropped them in for downstream skills.

   Track each read's success/failure.

   If `inputs-manifest.yaml` is missing, **stop and return an
   actionable error**:

   "Phase 1 has no source material — `inputs-manifest.yaml` (at the
   run-folder root) is missing. The orchestrator should have written
   the manifest at run-start. Re-run `/ace:run <opp-name>` so the
   manifest is captured from `ACE/<opp-name>/inputs/`."

   Do not invent source material or proceed without source content.

1a. **Pre-flight Drive accessibility — halt on permission failures.**

    The reads in step 1 surface permission failures implicitly, but
    surface them ALL as a single actionable error before any
    synthesis work — a session-interrupting OAuth dance turns into a
    30-second share-with-the-SA fix.

    Track every entry from `inputs-manifest.yaml` whose
    `drive_read_file` returned a permission error.

    If any read failed with a permission error, **stop and return an
    actionable error listing every inaccessible doc**:

    "The following files are not accessible to the ACE service
    account:
      - `<file_id>` (`<name>` from inputs/)
      - …
    Share each with
    `ace-service-account@connect-labs.iam.gserviceaccount.com`
    (Viewer is sufficient) and re-run `/ace:step idea-to-pdd
    <opp>/<run-id>`. If a doc is shared only with your personal
    account and cannot be re-shared with the service account, use
    `read_personal_drive_doc` (when available) as a fallback."

    Why: a recent design-review session was cancelled mid-run
    because the LEEP data sheet wasn't shared with the SA.

1b. **Existing CommCare app (`.ccz`) inputs — parse the app, design around it.**

    A `.ccz` in `inputs/` is an EXISTING CommCare application the partner
    already runs (e.g. Spark's FCAP app). It is authoritative ground
    truth about what forms exist and what each collects — so do NOT just
    "reference it by name," parse it and let it shape the design. (ACE
    has never had a `.ccz` input before this capability landed; the
    partner's built app is the highest-signal input there is.)

    Parse recipe — the download differs from `app-release-qa` (which
    pulls the CCZ from HQ by `app_id`); a Drive-sourced CCZ is fetched
    with `drive_download_binary`. The unzip + XForm parse is identical:

    1. `drive_download_binary(file_id=<id>,
       writeToPath="/tmp/ace-pdd-ccz/<name>.ccz")` → the atom writes the
       bytes to disk and returns `{path, size}`, no base64. **`writeToPath`
       is required in practice**: a CCZ is a zipped CommCare app, so it is
       essentially always over the ~30 KB inline ceiling and an omitted
       `writeToPath` fails with `oversized_binary`. Verify the file starts
       with the zip magic `PK\x03\x04` (`head -c4`); if not, log
       `ccz-download-failed` and fall back to logging the file by name (do
       not halt the whole PDD).
    2. Unzip the file at `path` (Bash/python `zipfile`). Read `suite.xml` at the zip root
       and parse it for `<menu>` / `<entry>` → the per-form XForm paths
       (`modules-N/forms-M.xml`) and their display names.
    3. For each form XForm, extract: the form title, its question labels
       + bind types (`<input>` / `<select1>` / `<select>` / `<upload>`
       and `<bind type=…>`), and any CommCare Connect markers
       (`deliver` / `module` / `task` / `assessment`, in either the
       default `xmlns="http://commcareconnect.com/…"` form or the legacy
       `learn:`-prefixed form).
    4. Summarize into your synthesis: the menu/module map, the per-form
       field inventory (labels + types), and where Connect markers
       already exist.

    Then **design AROUND it**: when an existing app is present, the PDD
    is a Connect program that REUSES this app as the delivery substrate,
    not a spec for a net-new build. Identify and state explicitly in the
    PDD (a) which existing form(s) are the per-visit delivery record a
    Connect deliver-unit verifies + pays on, (b) which forms map to Learn
    modules / assessments, and (c) what (if anything) is genuinely
    net-new. Make the reused-vs-new split explicit so downstream phases
    build the delta, not a duplicate app. If NO `.ccz` is present, this
    step is a **no-op** — design the app from the other inputs as usual.

2. **Determine the delivery archetype** (see `## Archetypes` below). The archetype shapes the section list and the questions you ask in step 3. If the same subject is visited more than once and the visits are not interchangeable, pick `longitudinal-visits` — NOT `atomic-visit` (which has no entity to track) and NOT `multi-stage` (which stages the programme, not the entity). Reserve `multi-stage` for a programme whose stages use *different archetypes* (e.g., focus groups in Stage 1, atomic visits in Stage 2), assigning an archetype to each stage.

3. **Research and expand** the idea:
   - What health/development problem does this address?
   - What is the intervention mechanism?
   - Who are the target beneficiaries?
   - What data needs to be collected (Learn app)?
   - What services need to be delivered (Deliver app)?
   - For non–`atomic-visit` archetypes, also work through the archetype-specific questions in `## Archetypes`.

3a. **Author the decisions log.** Before drafting the PDD, populate
    `ACE/<opp-name>/runs/<run-id>/decisions.yaml` with rows that meet the
    bar criterion in `## Decisions Log Convention` below. Each row
    records a load-bearing default the skill is about to apply when
    drafting the PDD. Use the AI's best inference from the source
    material for each `ai-default` value; status is `ai-default` (the AI
    proceeded with its default).

    See `## Decisions Log Convention § Common load-bearing decisions for
    Phase 1` for a working template of decisions that often qualify under
    the bar. Use it to guide judgment, not as a checklist — emit what
    meets the bar, skip what doesn't, add others when warranted.

4. **Draft the PDD** with the **base sections** below, plus **archetype-specific additions** from `## Archetypes`. Use the values selected in step 3a's `decisions.yaml` as authoritative — every numeric or named-entity in the PDD body should match the corresponding row's effective value (`override` if present else `ai-default`). If a re-run reads a `decisions.yaml` from a prior run with `status: overridden` rows (human edited via the renderer + sync skills), use the `override` value instead of the `ai-default`.

   **Base sections (all archetypes):**
   - **Document metadata** — the PDD's identifying facts (archetype, opportunity,
     run id, status, sources) go at the very top as a RENDERED block, one bold-label
     line per fact — e.g. `**Archetype:** atomic-visit`, `**Opportunity:** <slug>`,
     `**Run:** <run-id>`, `**Status:** …`, `**Sources:** …`. Do **NOT** emit a raw
     `---` YAML frontmatter block: the PDD is written as a native Google Doc
     (step 6), where `---` renders as a horizontal rule and the keys render as a
     wall of `key: value` noise above the title — the first thing a partner sees.
     Nothing parses the frontmatter: `idea-to-pdd-qa` check 2
     (`archetype_declared_and_valid`) reads the archetype from frontmatter **or**
     the body, and the bold-label form satisfies the body branch.
   - **Archetype** — declared in the metadata block, repeated as the first heading
   - **Problem Statement** — what problem this solves
   - **Intervention Design** — how the intervention works
   - **Learn App Specification** — what FLWs need to learn (data collection, facilitation, etc., depending on archetype)
   - **Deliver App Specification** — what FLWs deliver (forms, sessions, etc., depending on archetype)
   - **Target Population** — beneficiary criteria, expected reach
   - **FLW Requirements** — number of FLWs, skills needed, geographic distribution
   - **LLO Preference** — preferred or known LLOs to execute, from LLO Directory
   - **Solicitation** — Phase 8 publishes a solicitation to labs.connect.dimagi.com so LLOs respond. All three fields are optional; defaults apply if omitted. Always ask once: "do you want a custom solicitation type (EOI vs RFP), a non-default deadline (default 14 days), or a custom response template?" If not, leave the section with default placeholders (the `solicitation-create` skill reads them as defaults).
   - **Success Metrics** — how to measure if the intervention worked
   - **Evidence Model** — Layer A / B / C verification plan (see `## Evidence Model` in `templates/pdd-template.md`)
   - **Timeline** — expected duration of the opportunity
   - **Program Parameters** — the typed handoff table. A `| Key | Value |` table
     of every decision THIS document makes that a LATER phase must apply
     verbatim and that cannot be applied in the artifact this phase produces:
     `learn_passing_score`, `assessment_items`, `payment_rate_min` /
     `payment_rate_max` / `payment_rate_currency` / `payment_rate_unit`,
     `daily_cap_per_flw`, `total_cap_per_flw`, `flw_count_min` /
     `flw_count_max`, `expected_reach_min` / `expected_reach_max`,
     `entity_id_grain`, `entity_state_taxonomy`, `cap_rationale`. Take the
     canonical key vocabulary and the per-key guidance from `## Program
     Parameters` in `templates/pdd-template.md` — snake_case keys, unknown keys
     allowed, omit a row only when this PDD genuinely does not decide it.
     Prose elsewhere in the PDD is **not** a handoff: a later phase has to
     notice it, and when it does not the value silently falls back to a skill
     default. **Machine-checked** — a missing section fails
     `idea-to-pdd-qa § all_required_sections_present` and a missing or
     incoherent table fails `§ program_parameters_coherent`, both blockers.
     Step 7.5 writes the SAME values again as the `program_parameters` block in
     `run_state.yaml`; author this table first and transcribe it there, so the
     body and the state block cannot diverge.

4a. **Spec for deployability, not just topic presence.** `[ai-iteration: 2026-05-29]` The downstream
    build skills faithfully transcribe the PDD, and the app evals now
    **hard-fail** a build that is structurally complete but undeployable
    (see `docs/superpowers/specs/2026-05-29-eval-fitness-gap.md` — the
    ITN run produced a topic-complete app that an expert had to
    substantially rebuild). A PDD that only *names* topics produces a
    faithfully-thin app. So when the source material or evidence model
    *implies* any of the following, the **Deliver/Learn App
    Specification and Evidence Model MUST spec it explicitly** — don't
    leave it for Nova to infer (it won't):

    **ZEROTH — mark every app-spec statement as a REQUIREMENT or a
    MECHANISM. This governs everything else in 4a.** Specificity is the
    point of this step; *unmarked* specificity is what costs runs. Two
    different kinds of sentence live in the app specs and they must not
    read alike:

    - A **requirement** is an observable program fact that must hold in the
      built app. It is **binding**: it flows into the Work Order and the
      Phase-6 training materials, downstream evals grade against it, and a
      build that does not satisfy it has failed. *"A household that declines
      consent must never appear on the follow-up list and must never be
      payable."*
    - A **mechanism** is how CommCare/Connect/Nova achieves it. It is
      **advisory**: Phase 3 may implement it differently, and doing so is a
      normal build choice, **not a deviation**, and needs no PDD correction.
      *"…by ending the form without creating a case."*

    Write requirements as prose the program owner would recognise. Where a
    mechanism is genuinely useful to suggest, mark it explicitly — a
    `Mechanism (advisory):` prefix, or a `> **Requirement, not mechanism**`
    callout naming the requirement and leaving the how to the build. Field
    names, types, constraints, case write-backs, and the data model ARE
    requirements (they define the instrument); module/form partitioning,
    marker placement, `entity_id` construction, case-operation ordering, and
    anything phrased as "the app enforces X by doing Y" are mechanisms.

    **Never escalate a requirement into a mechanism.** This is the specific
    failure this rule exists to stop. On `bednet-check-2-visit/20260813-2313`
    the source brief said `consent_given` was *"required, must be yes to
    proceed"* — a requirement, and an ambiguous one. Phase 1 rendered it as
    *"a `no` ends the form without creating a case"* — an invented mechanism,
    unbuildable (a registration form creates its primary case
    unconditionally; a conditional `add_case_operations` create is accepted
    but adds a SECOND case). Because it read as binding, Phase 3 finding it
    unbuildable became a deviation from an approved design document that had
    already reached the Work Order, and cost a mid-run PDD correction
    (dimagi-internal/ace#1294). The requirement itself was satisfiable and
    was satisfied — by gating the later questions on consent and filtering
    the follow-up case list. Had the mechanism been marked advisory, nothing
    downstream would ever have been wrong.

    When you are unsure which one a sentence is, ask: **would a program
    owner who has never heard of CommCare recognise this as part of their
    program?** If yes it is a requirement; if it only makes sense to someone
    building the app, it is a mechanism.

    **FIRST — check every mechanism against the must-not-assert list.**
    Before specifying any **enforcement or verification** mechanism (a gate,
    a threshold that refuses something, a control that "the app enforces"),
    check it against `skills/_app-component-library.md § Mechanisms a PDD
    must not assert` — **both tables**. A listed mechanism **MUST NOT be
    asserted as enforced or delivered.** Where the design intent is still
    wanted, either:

    - state the **buildable approximation and name the residual** — the
      shape `gps-accuracy-capture` models ("each fix's accuracy is captured
      and submitted; readings worse than 50 m are flagged and down-weighted
      in dedup" — observability, stated honestly, not enforcement); or
    - raise it as an **open question** for a human, rather than asserting a
      control ACE will not deliver this cycle.

    This is a hard check, not a style note, because the PDD's sentence flows
    **verbatim into the Work Order** and into the Phase-6 training
    materials. Three mechanisms have now shipped into all three documents
    while being inert in the built app (ace#995, ace#1006, ace#1121) — and
    Phase 3 discovering it at build time does not retro-correct the
    documents that already went out. The bullets below are the per-topic
    instances of this rule; the list is the enumerable version, and it is the
    list that gets checked.

    **Say WHY correctly.** Table A is closed at the platform surface; Table B
    is buildable but outside ACE's toolchain today. The PDD behaviour is the
    same for both — don't assert it — but the wording is not. Writing "the
    platform cannot do X" about a Table B mechanism puts a false constraint
    into a document that will outlive it, and forecloses a capability request
    someone should be making. If you are not certain which table a mechanism
    is in, say "ACE does not build this today" rather than "this is
    impossible."

    - **Capture fidelity.** If the Evidence Model implies a GPS/location
      radius, spec **accuracy-aware GPS** (a stated target accuracy, the
      accuracy value submitted on every visit, an on-screen advisory),
      not a bare "capture GPS."

      **A stated GPS accuracy tolerance MUST NOT be written as an
      enforced control** (dimagi-internal/ace#1006). It is unenforceable
      on both surfaces: Nova rejects `validate` on `kind: geopoint`, and
      Connect's verification-flags form no longer carries `gps` /
      `gps_radius_meters` (ace#1013). So the Evidence Model must phrase
      it as what it is — e.g. *"each fix's accuracy is captured and
      submitted; readings worse than 50 m are flagged to the FLW and
      down-weighted in dedup"* — and must NOT say "rejected", "must be
      ≤ 50 m to submit", "the app enforces", or "Connect enforces". The
      same sentence flows verbatim into the Work Order, so a PDD that
      overstates the control puts a promise ACE cannot keep into a
      contractual document. If the design genuinely needs a hard gate,
      raise it as an **open question** rather than asserting it.

      If an answer is enumerable, spec it as a **select with the option
      list** (+ "Other, specify"), not free text. Prefer bucketed ranges
      over raw integers where field-reliable.
    - **Data quality.** Spec the **constraints**: numeric bounds and
      cross-field checks on counts, phone-format expectations, free-text
      length caps, and which fields are required-for-credit.

      **A per-row qualifier and an aggregate over the same repeat MUST
      agree** (dimagi-internal/ace#1123). If the PDD asks a
      confirmation / eligibility / membership question on each row of a
      repeat, then every aggregate the PDD derives from that repeat —
      `count()`, `sum()`, a band, a score — MUST reference the
      qualifier in its predicate: write
      `count(/data/<repeat>[<qualifier> = 'yes'])`, never a bare
      `count(/data/<repeat>)`. A PDD that names a per-row confirmation
      **and** an unfiltered aggregate over the same nodeset is
      self-contradictory on its face, and the contradiction is
      detectable without any domain knowledge — so check it before the
      PDD ships. The build follows the data-quality table, so the
      unfiltered version wins: the app asks the FLW a required question
      and then throws the answer away. On `hh-poverty-targeting` v2.1
      that field was the roster's membership confirmation and the
      aggregate was household size — **31 of 102 attainable PPI points
      across a sharp band boundary**, so one wrongly-retained member
      moved the score 21 points, and the FLW's honest answer changed
      nothing. If the intended reading really is "non-members are never
      entered", then **drop the per-row confirmation** — do not leave
      both in the document.

      Same failure family as the dead-`now()` (ace#995) and the
      unenforceable GPS gate (ace#1006): a control that reads as
      configured in the PDD, the Work Order and the training materials,
      and does nothing in the built app.
    - **Case persistence.** For multi-visit / follow-up designs, spec
      **which observations each follow-up visit writes back to the
      case** (the whole point of a follow-up is to record change).
    - **Assessment enforcement.** If FLWs must pass a readiness gate,
      spec a **pre-test + post-test**, the threshold, the item count
      (enough to test the curriculum), and that the result experience is
      pass/fail-conditional — not "a quiz exists."

      **Do NOT spec a randomized or per-attempt item draw**
      (dimagi-internal/ace#1121, ace#1213) — and be precise about why. "12
      items served per attempt from a bank of 30, fresh draw each retake" is
      **Table B**: it is expressible in XForms (a seeded `once(random())`
      driving selection from a lookup-table/fixture nodeset, or hidden
      questions gated on `relevant`), and Connect scores a fixed-size draw
      normally — 12 of 30 served keeps the denominator at 12, so a
      `passing_score` works as usual. What is missing is a **Nova authoring
      primitive** for it, plus the complexity of the fixture/relevance
      machinery. So: spec **one fixed bank sized for the gate** (plus a
      distinct pre-test bank where a baseline is wanted), and **do not write
      that rotation is impossible** — it is not.

      If retake-resistance genuinely matters — and note that unlimited
      re-attempts against a fixed bank means a worker can pass by memorising
      the answers, which softens the Deliver-unlock gate on every retry —
      raise it as an **open question**, consider whether unlimited
      re-attempts is the right policy, and where the program really needs
      rotation, file it as a **Nova capability request**.

      **Any worked assessment item the PDD emits MUST be labelled
      ILLUSTRATIVE** (dimagi-internal/ace#1120). A PDD specifies the
      assessment *blueprint* — bank size, items served per attempt, stem
      format, distractor rules, the discrimination target. A specific
      quiz item is build content, not design. So if you include a worked
      example at all, mark it in the PDD text as *"illustrative of the
      required shape — Phase 3 authors the bank and may harden or
      discard this item"*, and never as mandated content. Two reasons,
      both measured: an item authored here is never cold-read-tested
      (all three of `hh-poverty-targeting` v2.1's worked items were
      guessed cold by both independent blind probes), and worked items
      **anchor the tone** of the other ~21 items Phase 3 authors, so a
      guessable model teaches the builder to write guessable items.
      Asserting *why* an item discriminates does not make it so — v2.1's
      stated rationale for its compound item was rejected on sight by
      both probes.
    - **Working language.** If the program runs in a non-English
      language, state it as a **Working language** line in the Learn and
      Deliver App Specifications, with its CommCare language code — it is
      real design context, it drives the training materials, the
      facilitator briefing, the per-opp OCS chatbot and the solicitation's
      language requirement, **and as of 2026-08-17 it is also delivered in
      the app.** Nova shipped a real per-language channel, so ACE builds
      the app's strings in the working language on top of an
      always-complete English source (standing decision 2026-08-17,
      PR #1463, superseding ace#968/#1391 — see `_app-component-library.md §
      app-language-layer`). What the PDD may now assert: labels, choices,
      hints and assessment items appear in the working language, and the
      app carries English as its source language. What it must still NOT
      assert: that the translations are **professionally or
      native-speaker reviewed** at delivery — ACE authors them, Nova marks
      them `needs-review`, and review is a normal downstream obligation
      exactly like review of the English copy, not a completed step. Also
      do not promise an in-app language-*selector question*; language
      choice is CommCare's own runtime affordance. English remains the
      runtime default for now, so if the design depends on an FLW seeing
      the working language first, raise that as an **open question**
      rather than asserting it.

    These become `decisions.yaml` rows where they meet the bar (§
    Decisions Log Convention). This is the upstream half of the
    eval-fitness fix: a thin PDD is the root cause, a deployable PDD is
    the cure.

5. **Self-evaluate (LLM-as-Judge) — Stress-Test Rubric.** Run the rubric defined in `## Rule provenance — human rulings vs AI iteration

**Not every rule in this file is a durable learning.** ACE iterates hard: about
half of the last 200 commits carry a `Co-Authored-By: Claude` trailer, so a large
share of the rules here were written by an AI mid-cycle, to fix a problem that
may since have moved. Others are human rulings — an operator deciding how ACE
should behave. **Those two things read identically today, and they should not.**

### The three classes

- **`[human: <name>, <date>]` — a human ruling. Honor it diligently.** Follow it
  even when it is inconvenient, and *especially* when following it makes a build
  harder. Do not reinterpret it to make a phase pass, do not narrow it to the
  case in front of you, and do not quietly drop it. If it appears to conflict
  with something else, **surface the conflict rather than picking a side.** A
  human ruling that an agent has silently optimised away is the single most
  expensive kind of drift in this repo, because the human has no way to see it
  happened.
- **`[ai-iteration: <date>]` — added by an AI during an improvement cycle.**
  Presumed useful, **not sacred.** It encodes what was true when it was written.
  If it is now causing harm, contradicts a human ruling, or was written for a
  problem that has since changed shape, it is **fair game to revise** — but say
  so explicitly, cite the evidence, and change it in the open rather than
  ignoring it in place.
- **`unmarked` — provenance not established. Treat as `ai-iteration`.** This is
  the default and most of this file is currently in it. Tag rules as you touch
  them rather than in a big retrofit. **Do not promote an unmarked rule to
  `human` on a hunch** — confirm with the operator, then tag it so the next
  reader does not have to ask again.

**Precedence: a human ruling beats an AI-iteration rule, always.** Two human
rulings that genuinely conflict go to the operator — do not arbitrate them.

### Establishing provenance when it is not tagged

The signal already exists in git history and cannot be faked after the fact:

```bash
scripts/rule-provenance.sh "<distinctive phrase from the rule>" [path...]
```

It reports `human`, `ai-iteration`, or `unmarked`. Two things make this less
obvious than it looks, and the script encodes both:

1. **Git authorship is useless here.** Every commit carries the operator's name,
   including AI-authored ones. The `Co-Authored-By: Claude` trailer is the only
   authorship signal in the history.
2. **The trailer is a one-way signal.** Present → reliably AI. *Absent → proves
   nothing*: measured 2026-08-14, **45 of the last 300 non-merge commits carry no
   trailer** and sampled ones are plainly AI-written. So a missing trailer yields
   `unmarked`, never `human`. Inferring "human" from a missing trailer would
   sanctify stale AI rules — the exact failure this section exists to prevent.
3. **A trailer tells you who TYPED the rule, not whose DECISION it was.** An AI
   transcribing an operator ruling carries the trailer while the rule is
   genuinely human. So the script checks the **rule text itself** for a human
   citation first (`Operator ruling (Jon, 2026-08-13)`, `(Jon, 2026-07-01)`,
   `standing operator directive` — how this repo already records them), and that
   outranks the trailer.

Merge commits are skipped: a PR merge carries no trailer regardless of who wrote
the work, and would otherwise read as human.

### Why this section exists

Both rules that collided on `bednet-check-2-visit/20260813-2313` turned out to be
AI-authored during heavy iteration, and neither was marked:

| Rule | Commit | Provenance |
|---|---|---|
| Step 4a "spec for deployability, not just topic presence" | `336039b1`, 2026-05-29 | `ai-iteration` |
| `pdd-to-learn-app` "Connect's `passing_score` is ALWAYS 80" | `d6c26e86`, 2026-05-23 | `ai-iteration` |

The second one is the instructive case. The PDD specified a 6-of-6 gate
(`passing_score: 100`) sourced directly from the operator's brief; the build
skill said *always 80*. Read as equally authoritative, that is an unresolvable
standoff, and picking 80 would have let 5-of-6 through and defeated the gate the
brief asked for. Read with provenance, it is not close: a source-stated program
decision beats a generalisation an AI wrote while fixing a different bug. The run
picked 100 and was right to — but it had to reason its way there from scratch,
and a headless run might not have.

**Applying this in practice:** when you hit a conflict between what the source
material says and what a rule in a skill file says, check the rule's provenance
before deciding. If the rule is `ai-iteration` and the source is explicit, the
source wins and you note the override. If the rule is `[human: …]`, honor it and
raise the conflict.

## LLM-as-Judge Rubric` below against the drafted PDD. If **two or more** checks grade other than `pass`, the PDD is **not approved** — iterate on the weak sections and re-run before proceeding.

6. **Write the PDD** to `1-design/idea-to-pdd.md` **as a NATIVE Google Doc via
   `drive_create_doc_from_markdown`** — NOT `drive_create_file` with a `text/*`
   mimeType (dimagi-internal/ace#1061). The PDD is the only artifact in this
   pipeline whose purpose is to be *argued with* by a human: the entire
   feedback → ledger → next-run loop starts with a domain expert leaving
   ANCHORED comments on it. A `text/markdown` upload renders in Drive's
   plain-text previewer — no comment gutter, no suggesting mode, no way to
   anchor to a section — and the failure is silent, because every content check
   still passes. It regressed exactly that way between two runs of the same opp
   six days apart (9 anchored comments → zero). `idea-to-pdd-qa` check 7
   (`pdd_is_native_google_doc`) is the structural backstop. **FIRST resolve-or-create the phase subfolder** — `drive_create_folder({name: '1-design', parentFolderId: <runFolderId>, findOrCreate: true})` — and use the returned id as `parentFolderId` for this write **and** for the QA + eval verdicts and the phase summary. Do NOT pass the run-folder id directly as the write parent: that lands the artifact flat at the run root and fails the Phase boundary's `verify_phase_artifacts` (it walks `1-design/`; jjackson/ace#623). `decisions.yaml` is the exception — it stays at the run-folder root. Include the stress-test rubric results as a `## Stress Test Results` appendix at the bottom of the PDD, so downstream skills (and humans) can see what was caught and what was waived.

6b. **Persist the PDD's source markdown — the same string, written twice.**
   Immediately after step 6's render, write the EXACT bytes you passed to
   `drive_create_doc_from_markdown` to `1-design/idea-to-pdd.source.md` via
   `drive_create_file` with `mimeType: 'text/markdown'` (same
   `parentFolderId` as step 6). **NOT `drive_create_doc_from_markdown`** —
   rendering the source copy converts it to a Doc as well and destroys the
   very bytes this step exists to preserve, which reproduces the defect while
   looking like the fix.

   Why it is not optional: the renderer CONSUMES its input. Once the Doc
   exists the markdown you composed exists nowhere, and the `.md` in
   `idea-to-pdd.md` is display text, not a file — `drive_list_folder` over a
   finished run's `1-design/` returns it as
   `application/vnd.google-apps.document` with no sibling markdown. That
   leaves `run-surface-audit`'s `DOC-FIDELITY-UNVERIFIED` — the only check
   that compares what was PUBLISHED against what was WRITTEN, and the only one
   that could have caught a document silently losing content with every other
   check green (ace#1418) — permanently unresolvable, because its
   `--doc-source` remediation has nothing real to point at. One extra call
   turns a blocking gate from decorative into operable.

   This is a plain companion file, not a second deliverable: it is never
   shared, never linked, and never read by a human. Do NOT share it
   anyone-with-link. (ace#1687 half 2; declared `sourcePersisted` in
   `lib/artifact-manifest.ts`, enforced by
   `test/lib/source-persisted-artifacts.test.ts`.)

<!-- 0.13.116: gate-brief write step removed. The orchestrator composes a
pause-time summary from this skill's QA verdict (idea-to-pdd-qa) +
eval verdict (idea-to-pdd-eval) at the Phase 1→3 Pause Point. -->

7.5. **Write the `products.pdd` block to `run_state.yaml`** so
   downstream readers (ace-web's summary page in particular) don't
   have to fetch and regex the PDD body.

   - `title`: the friendly intervention name from the PDD's H1 / opening
     line (e.g. "Turmeric Market Survey"). Strip trailing punctuation
     and any Google Docs comment markers (`[a][b]`).
   - `description`: a one-paragraph plain-prose overview, ~1–3
     sentences, lifted from the PDD's `## Overview` (or `## Summary` /
     `## Abstract`) section. Strip markdown bold/italic wrappers; keep
     content as a single line.
   - `file_id`: the Drive `fileId` returned by Step 6's
     `drive_create_doc_from_markdown`.
   - `program_parameters`: the typed handoff block — **every PDD decision
     that a LATER phase must apply verbatim and that cannot be applied in
     the artifact this phase produces.** Prose in the PDD body is not a
     handoff: a later phase has to notice it, and when it doesn't the value
     silently falls back to a skill default. Emit every key you can
     determine; omit one only when the PDD genuinely does not decide it.

     These are the SAME decisions the PDD body's `## Program Parameters`
     table carries (step 4). Author that table first and transcribe it here —
     the body table is what `idea-to-pdd-qa` reads, this block is what
     downstream phases read, and the two must agree.

     | Key | Applied by | Failure if it defaults instead |
     |---|---|---|
     | `learn_passing_score` | Phase 4 `connect_create_opportunity.learn_app.passing_score` | Nova exposes no `passing_score` slot — `connect.assessment` carried only `{id, user_score}` when the Learn build read it back (repro: run `bednet-check-2-visit/20260813-2313`, Nova app `53583a46-298a-4a02-857a-bb86cd8e9a75`) — so a PDD gate of 100% silently becomes the skill's default 80 and 5-of-6 passes |
     | `payment_rate_band` | Phase 4 payment unit; Phase 8 solicitation | The band reads as an agreed price, or the awarded rate is applied without reference to it |
     | `daily_cap` / `total_cap` | Phase 4 opportunity config | Caps that do not match the PDD's stated economics |
     | `entity_id_grain` | Phase 3 `pdd-to-deliver-app`; Phase 4 payment unit | A payment grain chosen per-run rather than per-design |

     ```yaml
     program_parameters:
       learn_passing_score: 100
       payment_rate_band: { currency: USD, min: 1.00, max: 2.50, unit: "verified follow-up visit" }
       daily_cap: 5
       total_cap: 30
       entity_id_grain: "worker username + follow-up visit date"
       # Only when the PDD mandates an EXACT assessment item count — see below.
       assessment_coverage_deviation:
         accepted_max_ratio: 0.31
         reason: "D-1: the gate certifies two payment-model facts and is not a competence certification"
     ```

   **If the PDD mandates an EXACT assessment item count, check it is
   satisfiable before writing it (ace#1250).** Enumerate the Deliver app's
   **high-consequence operations** and the **counter-intuitive rules** the
   same way `pdd-to-learn-app-eval § 5c` step 2 does, then run
   `checkCoverageFeasibility` from `lib/assessment-coverage-feasibility.ts`.
   Coverage is the fraction of those two sets carrying ≥1 qualifying item,
   **counter-intuitive weighted double**, and it must reach **0.50** or the
   dimension hard-gates at ≤3.

   A mandate below that ceiling **pre-commits Phase 3 to a `fail` and the
   builder is graded down for obeying its brief.** It also cannot be repaired
   downstream: the auto-fix loop is capped at one round against an immovable
   number, and it pins `/ace:iterate` at 0% on the opp forever, because the
   loop's clean gate requires `pdd-to-learn-app-eval == pass`.

   **Before declaring a shortfall, check whether your blueprint PAIRS items
   (ace#1433).** The helper assumes one entry per item unless told otherwise,
   and that under-estimates the ceiling whenever a single question genuinely
   *requires* two rules — the qualifying test is "does answering REQUIRE the
   rule", and one item can require two. On
   `bednet-check-2-visit/20260814-2019` the helper declared 0.667 the ceiling
   and the built 6-item bank measured **0.867**; the PDD had already written
   "reaching the next band would require 7 items, which the source forbids".
   If your blueprint table pairs rules on an item — an item whose key is
   unreachable knowing only one of them — pass `maxEntriesPerItem` and
   `pairedItems` (how many of the mandated items are paired, NOT all of them)
   and re-read the ceiling before reaching for a deviation. A spurious
   deviation is exactly the escape hatch ace#1250 built the channel to keep
   honest.

   Two legitimate resolutions, in order of preference:

   1. **Mandate at least `minimumItems`** — the number the check returns.
   2. **Declare the shortfall.** Write `assessment_coverage_deviation` with
      an `accepted_max_ratio` the mandate can actually reach and a `reason`
      saying why the narrow scope is correct. `pdd-to-learn-app-eval` grades
      the dimension against the declared ceiling and surfaces a `[WARN]`
      instead of a `[BLOCKER]`. A deviation claiming MORE coverage than the
      item count permits, or carrying no reason, is refused — that is an
      escape hatch, not a decision.

   Live: `bednet-check-2-visit/20260813-2333` mandated "exactly 2 questions"
   against 3 counter-intuitive rules + 7 high-consequence operations →
   weighted coverage 4/13 = 0.31 → dimension 3.0 → `[BLOCKER]` → overall 7.52
   → `fail`. It needed 4 items, or the deviation it had already argued in
   prose as D-1 but had no channel to declare.

   ```yaml
   phases:
     design:
       products:
         pdd:
           title: "Turmeric Market Survey"
           description: "FLWs visit markets to photograph turmeric vendors..."
           file_id: <fileId>
           program_parameters:
             learn_passing_score: 100
             daily_cap: 5
   ```

   Apply via `mcp__plugin_ace_ace-gdrive__update_yaml_file` with
   `merge: 'deep'` on the current run's `run_state.yaml`. This skill is
   the sole writer of `products.pdd`, but the `design` phase block also
   carries `status`/`steps` and a sibling `products.work_order` (written
   by `pdd-to-work-order`) — so this must be a `deep` partial-patch, not
   `two-level` (which would replace the whole `design` block). #572/#587.

8. **Render the decisions log to a human-readable Google Doc** by
   invoking the `decisions-render` skill against the run-id. The
   renderer produces `ACE/<opp-name>/runs/<run-id>/decisions.gdoc`
   at one stable URL; humans review and iterate on this doc, not the
   YAML. The orchestrator also invokes the renderer at end of every
   subsequent phase, so the gdoc stays current as later phases append
   rows.

## LLM-as-Judge Rubric

Run this 5-question stress test against the drafted PDD. Each check is **pass / partial / fail**. If **two or more** checks are anything other than `pass`, the PDD is **not approved** — iterate on the weak sections and re-run the stress test before outputting.

Background and worked examples live in `docs/examples/pdd-stress-test-observations.md`. Quote specific evidence from the PDD when grading; do not grade in the abstract.

1. **Executability** — *Could an LLO read this PDD on day one and start work without asking clarifying questions?*
   Common failure modes: recruitment criteria unspecified (how is "under-vaccinated" determined? self-report vs. card vs. records), language and translation not addressed, facilitator/FLW skill level not stated, consent process missing, venue selection unspecified, participant compensation not mentioned.

   **REQUIRED — walk the form flow for ANSWERABILITY, screen by screen
   (dimagi-internal/ace#1211).** Being fully *specified* is not the same as
   being *answerable*. For each screen in the § Deliver App form flow, in order,
   confirm every field on it can be answered from what the worker knows or has
   observed **at that point in the real-world sequence**. A field whose value is
   a function of a LATER screen's answer fails this check — regardless of
   whether a recode or a relevance condition patches it downstream.

   **The recode is the tell.** A spec that assigns a value and then reassigns it
   later is asserting the first assignment was premature. On
   `hh-poverty-targeting/20260812-2034` the flow asked `visit_outcome` as a
   `select1` on screen 2 — before eligibility (4) and consent (5) — then recoded
   it on screen 6, and this self-eval graded Executability **pass** while
   *citing* §6.1 approvingly ("specified screen by screen with relevance
   conditions"). That is ace#979 reintroduced against a binding reviewer
   correction which had supplied the fix verbatim:

   ```
   visit_outcome = if(occupied='no','vacant',
                   if(eligible_respondent='no','no_eligible_respondent',
                   if(consent='no','refused','completed')))
   ```

   Catching it here is worth more than catching it downstream: Phase 3 builds
   forms directly from this section, so a miss ships a form an FLW cannot
   complete in order. Four gates missed it on that run and only Phase 2 caught
   it, incidentally.

2. **Verifiability** — *For every claimed output, is there a concrete artifact we can collect and check?*
   Common failure modes: "summary of key themes" with no format/length/template, photo capture without standardization protocol (lighting, angle, distance, color reference), self-reported education delivery with no audit mechanism, qualitative outputs with no path from raw data to AI-ingestable form.

3. **Measurability** — *Are success criteria defined for this stage, with units and targets?*
   Common failure modes: success described as "improved understanding" with no metric, sampling cap stated but no target, no per-segment or per-region targets, primary vs. secondary metrics not separated.

4. **Stage-gate clarity** — *For multi-stage PDDs, what must be true at the end of this stage to proceed to the next?*
   Common failure modes: Stage 1 → Stage 2 transition undefined, no explicit "go / no-go / iterate" criteria, downstream stage references findings the upstream stage isn't required to produce.

5. **Resource realism** — *Are the LLO's capabilities matched to what's being asked, **and does the money match the work?***
   Common failure modes: focus-group facilitation skill assumed without training, ~50 participants to recruit across 6 segments with no recruitment plan, FLW asked to make subjective research judgments (Q12/Q13-style) the artifact should answer instead, photo/data quality dependencies on equipment LLOs may not have.

   **Cost the labour, not just the capability.** This half is mandatory and
   was missing until 2026-08-14: the question asked only whether the LLO
   *could* do the work, never whether the rate covers it, so a PDD with
   uncosted labour could pass 5/5. Compute and state, in the PDD:

   - **Gross earnings per working day** at the proposed rate and daily cap.
   - **Effective earnings per day of TOTAL field time** whenever any visit
     type, travel leg, or preparation step is unpaid. Divide by all the time
     the work actually takes, not just the payable units.
   - The gap between those two numbers, stated plainly, when unpaid work is
     a material share of the day.

   Grade `partial` at best when unpaid work is material and the PDD never
   computes its effect; grade `fail` when effective earnings fall below a
   plausible local floor and the PDD does not acknowledge it. Where no
   geography is named there is no market floor to compare against — say so
   rather than assuming the rate is fine, and carry it as an open question.

   Worked failure (`bednet-check-2-visit/20260813-2313`): R2 makes
   registration unpaid while registration is the heavier visit, so roughly
   half of a worker's field time earned nothing. Stated gross was
   USD 5.00–12.50/day; effective was USD 2.50–6.25. The PDD self-graded
   this check `pass` and the independent eval scored `resource_realism`
   6.5 — a 1.88-point self-eval gap concentrated entirely here.

**Grading anchors (worked examples):**

The vaccine-hesitancy PDD at `docs/examples/pdd-vaccine-hesitancy.md` is the canonical "fail" case. Expected grades:
- Executability: **fail** — recruitment, language, facilitation, consent, venue all underspecified
- Verifiability: **fail** — "summary of key themes" output spec is too thin to verify
- Measurability: **partial** — Stage 2 has metrics, Stage 1 does not
- Stage-gate clarity: **fail** — Stage 1 → Stage 2 transition undefined
- Resource realism: **partial** — facilitation skill assumed; ~48-person recruit unscoped

The turmeric-market-survey PDD at `docs/examples/pdd-turmeric-market-survey.md` is the canonical "near-pass" case. Expected grades:
- Executability: **partial** — "market" is free text but the cap depends on market identity
- Verifiability: **partial** — photo standardization protocol missing; vendor education self-report unverifiable
- Measurability: **partial** — caps stated, sampling targets missing
- Stage-gate clarity: **pass** — single stage
- Resource realism: **pass** — atomic-visit pattern is well-matched to FLW capability

Both PDDs fail the rubric in their current form. Surface specific failures and either (a) iterate on the PDD to fix them, or (b) in review mode, hand off to a human with the failure list attached.

<!-- 0.13.116: ## Gate Brief section removed. The orchestrator composes
a pause-time summary at the Phase 1→3 Pause Point from this skill's
QA verdict + eval verdict directly (per `agents/ace-orchestrator.md §
Pause Points`). The producer no longer authors a separate gate-brief
artifact. -->

## The durable open-questions doc

`ACE/<opp-name>/open-questions.md` lives at the opp ROOT and is durable
across runs (ace#1201). It is **not** append-only: it has a **bounded
shape**, and it is this skill's job to keep it in that shape every run.

**Exactly two sections, in this order, and no others:**

```markdown
# Open Questions — <opp-name>

## Open

- **id:** rate-band-source
  **question:** What is the authoritative source for the per-visit rate band?
  **raised_by:** 20260812-1613
  **owner:** operator
  **answered_where:** solicitation responses

## Archive

- **id:** deliver-app-photo-capture
  **question:** Should photo capture be camera-only?
  **raised_by:** 20260714-0902
  **owner:** ACE
  **resolved_at:** 2026-08-17T14:02:00Z
  **resolved_by:** idea-to-pdd (run 20260817-1531)
  **resolution_note:** app-hq-settings applies appearance="acquire"; settled.
```

Rules:

- **`## Open` is the live work list.** Only genuinely-unanswered questions
  live here. It is the ONLY section any reader — this skill, the
  orchestrator, a human — reads back.
- **`## Archive` is closed history.** It is **never read back and never
  inlined** at phase handoff. It exists so the audit trail survives without
  weighing on every future run.
- **Resolution MOVES a row; it never annotates one in place.** Remove the row
  from `## Open`, append it verbatim to `## Archive`, and add exactly three
  fields: `resolved_at`, `resolved_by`, `resolution_note`. Nothing else
  changes, so the archived row still reads as the question it was.
- **Never delete a row.** Archiving is the only removal from `## Open`.
- **Contradictions stay in `## Open`.** A run that contradicts a recorded
  answer does not archive it — it records the contradiction on the live row
  and surfaces it loudly (§ Process step 1).
- **It is published CONVERTED, and therefore read back as markdown.** Write it
  with `drive_create_doc_from_markdown` so Drive renders real headings and real
  tables — a `run-surface-audit` flags a doc that shows the reader raw `##` and
  pipe characters as `DOC-LITERAL-MARKDOWN`. The matching read is
  `drive_read_file(..., exportAs: 'text/markdown')` plus `extractOpenSection`:
  the default `text/plain` export of a converted doc has no `##` markers and no
  table rows, so it cannot be parsed for `## Open` at all.

This mirrors the `archive:` convention `run_state.yaml`'s `open_questions:`
list already follows — see `agents/orchestrator-reference.md § Cruft
management — `archive:` block convention`, whose three `resolved_*` fields
are the same three used here.

**Why the shape is a contract and not a style note (ace#1487).** Annotating
resolved rows in place made this doc grow monotonically —
`bednet-check-2-visit` reached 26,577 chars across three runs — while
§ Process step 1 mandates a read-back statement for every pre-existing
question, so Phase 1's cost grew linearly with the ledger forever. On the
`/ace:iterate` fixture opp the inherited history then leaked into the PDD:
a 43,003-char PDD from a 15,449-char brief, carrying rates, cohort sizes and
programme ceilings the brief never states. The orchestrator now bounds the
READ (`lib/open-questions-inline.ts` — fixture opps skip the inline entirely;
everyone else gets `## Open` capped at `OPEN_QUESTIONS_INLINE_CAP_CHARS`);
this section bounds the WRITE, so the live list stays small enough that the
cap is rarely the thing doing the work.

## Decisions Log (rendered)

The skill always emits `decisions.yaml` and invokes `decisions-render`
to produce a prose Google Doc rendering at one stable URL
(`ACE/<opp-name>/runs/<run-id>/decisions.gdoc`). The YAML lives at
`ACE/<opp-name>/runs/<run-id>/decisions.yaml`; the gdoc is its
human-friendly rendering and is regenerated after every phase. The
orchestrator's pause-time summary at the Phase 1→3 Pause Point
includes a `Decisions Log: <gdoc-url>` line.

## Decisions Log Convention

Every Phase 1 run emits `ACE/<opp-name>/runs/<run-id>/decisions.yaml`
with a calibrated set of load-bearing default-decisions the skill applied
while drafting the PDD. The log is the per-run audit trail and the
human-iteration surface — humans edit it (via the renderer + sync skills
landing in PRs #2–#4) to redirect a subsequent run's PDD draft.

### Bar criterion — what counts as a row

Two filters, both must be true:

1. **Load-bearing.** A reasonable person could pick differently AND it
   materially shapes downstream phases or eval scores.
2. **Maps to a known surface.** The default ties to one of: an
   `*-eval` rubric dimension, an `*-qa` structural check, a Phase
   Write-Back field that downstream phases read, or a numeric / named
   entity surfaced in the PDD body.

Form-field-level choices, Connect program slugs, email copy, font sizes
— below the bar.

### Common load-bearing decisions for Phase 1

These rows commonly qualify under the bar criterion for Phase 1 — a
working template, not a required set. The skill applies the bar
criterion and emits whatever rows meet it; this catalog is a teaching
device that improves over time as we learn from runs. Five rows are
marked `(eval input)` because `idea-to-pdd-eval`'s viability axis
(PR #144) grades on those specific decisions — when they're present in
the log, the rubric has structured input instead of grading on PDD
prose.

The catalog branches on archetype. The **base table** rows fit every
archetype; the per-archetype tables below it add rows that are
load-bearing for that archetype and meaningless for others (e.g.
`ai-photo-threshold` doesn't apply to FGDs; `submission-window`
doesn't apply to atomic visits). Emit base rows on every run, plus
the matching archetype's rows; skip a row when it's not applicable
to the opp; add others not listed when they meet the bar.

**Base (all archetypes):**

| ID | Question | Map to surface |
|---|---|---|
| `archetype-selection` | Which delivery archetype best fits? | `archetype_coherence` (eval input) |
| `budget-plausibility` | Is the budget plausible for implied labor + AI infra? | `resource_realism` (eval input, PR #144) |
| `named-downstream-consumer` | Pre-committed downstream consumer? | `demand_reality` (eval input, PR #144) |
| `primary-metric-vs-goal` | Direct goal vs upstream proxy? | `mission_alignment` (eval input, PR #144) |
| `ai-fallback-design` | True validation harness or parallel sampling? | `fallback_validates_primary` (eval input, PR #144) |
| `flw-count` | How many FLWs? | PDD `FLW Requirements` numeric |
| `working-language` | Working language(s) + CommCare language code? Who reviews the translations? | PDD `Learn App Specification` |
| `verification-layers` | Which evidence-model layers in scope? | PDD `Evidence Model` section |
| `solicitation-type` | Solicitation type (EOI/RFP/custom)? | PDD `Solicitation` section |
| `solicitation-deadline` | Solicitation deadline? | PDD `Solicitation` section |
| `candidate-llo-roster` | Named candidates or public-only? | `LLO Preference` named entity |

**These base rows are `value_set_by: external` — always.** Their real value is
fixed by a solicitation response, a contract, or deployment, never by ACE:
`flw-count`, `payment-rate`, `budget-plausibility`, `named-downstream-consumer`,
plus the work-order rows `wo-period-of-performance` and
`wo-total-not-to-exceed-usd`. Still emit your best estimate as `ai-default` and
keep going — but tag them `external` so the estimate is not read downstream as a
commitment. Measured across 22 runs of two opps, these are precisely the rows
that produced a different confident-looking number on nearly every run.

Everything else in the base table is `value_set_by: ace`.

**`atomic-visit` (additive):**

| ID | Question | Map to surface |
|---|---|---|
| `payment-rate` | Per-visit payment rate band (range, not fixed) to propose to the LLO. The PDD captures a target range or anchor + rationale; the actual rate is **negotiated via the solicitation response** where the LLO proposes a number with justification. | PDD `FLW Requirements` numeric (range or band) |
| `pilot-sample-size` | Pilot sample size for AI calibration? | `verifiability` rubric |
| `ai-photo-threshold` | AI auto-accept confidence threshold? | `verifiability` rubric |
| `gps-verification-radius` | Acceptable GPS radius (meters) for visit-at-location? | `verifiability` rubric |
| `duplicate-detection-key` | What constitutes a duplicate? (vendor id, GPS bucket, household id) | PDD `Evidence Model` Layer A |
| `per-visit-daily-cap` | Daily / weekly cap per FLW? | PDD `FLW Requirements` numeric |

**`longitudinal-visits` (additive):**

| ID | Question | Map to surface |
|---|---|---|
| `longitudinal-entity` | What entity is followed over time, and what case type represents it? | PDD `Entity Lifecycle` |
| `entity-registration-path` | Registered by a separate form, by the first visit, or already existing in the partner's system? | PDD `Entity Lifecycle` + `pdd-to-deliver-app` case ops |
| `visit-sequence-and-cadence` | Expected visits, their order, and the interval — including any change in cadence across the arc. | PDD `Entity Lifecycle` |
| `payability-against-history` | Is the same activity twice payable? An out-of-order visit? A per-entity cap over a window? **Never leave unanswered** — silence degrades Layer A to "any visit counts" (ace#1462). | PDD `Evidence Model` Layer A |
| `payment-unit-entity-id` | The Connect dedup business key expressing the row above. Default for this archetype: `concat(<case_id>, '-', <activity_code>)` = one payment per activity per entity. Never the case id alone (that would pay once per entity, ever). | `connect-opp-setup` Connect form; `pdd-to-deliver-app` §entity_id |
| `case-state-read-write` | What each visit preloads from the case and writes back. | `pdd-to-deliver-app` case ops |
| `visit-ownership` | Payable only from the FLW who owns the case, or from any FLW? | PDD `Evidence Model` Layer A |
| `progression-affects-payment` | Does a stalled entity affect payment, or is progression monitored only? | PDD `Evidence Model` + `Success Metrics` |
| `entity-completion` | What "complete" means for an entity, and what happens to the case then. | PDD `Entity Lifecycle` |
| `payment-rate` | Per-visit payment rate band (range, not fixed) to propose to the LLO — same negotiation principle as `atomic-visit`. | PDD `FLW Requirements` numeric |

**`focus-group` (additive):**

| ID | Question | Map to surface |
|---|---|---|
| `payment-unit-model` | Per-session attestation-form payment via Connect deliver_unit (default) vs per-month invoice via Connect web (rare)? | PDD `Budget` + `connect-opp-setup` payment unit |
| `per-session-rate` | Per-verified-session rate band (range, not fixed) for facilitator + notetaker. Same negotiation principle as `payment-rate` — PDD captures a range with rationale; LLO proposes a number in their solicitation response and explains why. The awarded LLO's proposed rate becomes the actual `connect.deliver_unit` payment_unit amount at Phase 4 setup time. | PDD `FLW Requirements` numeric (range or band) |
| `facilitator-training-stipend` | Flat training stipend on **practice-session-pass** (coordinator-graded audio review). Note: not Learn-app completion — focus-group archetype has no Learn app. | PDD `FLW Requirements` numeric |
| `gdoc-content-template` | What sections / fields should the facilitator's gdoc contain? Default: the PDD's Output Specification verbatim. Where does the gdoc template live (a template URL the facilitator copies, or a free-text starting point)? | PDD `Output Specification` |
| `participant-compensation-cap-usd` | Per-participant compensation USD-equivalent cap? | PDD `Budget` numeric |
| `submission-window` | Hours between session end and **attestation form** submission. Gdoc submission window may differ — default: same. | PDD `Evidence Model` Layer A |
| `audio-min-duration` | Minimum audio duration for a session, captured out-of-band (audio is not in the CommCare form). Tracked for coordinator gdoc review, not for Layer A. | PDD `Facilitation Protocol` |
| `audio-consent-fallback` | What happens when one participant declines audio recording? (Audio is out-of-band — this is a facilitator protocol decision, not a CommCare form behavior.) | PDD `Facilitation Protocol` |
| `gps-verification-radius` | Acceptable GPS radius (meters) for the attestation form's `gps` field to clear Layer A as "at the planned venue"? | PDD `Evidence Model` Layer A + `connect-opp-setup` verification flags |
| `gdoc-submission-window` | Hours allowed between attestation submission and gdoc receipt (coordinator follow-up trigger). Default: same as `submission-window`. | PDD `Evidence Model` Layer B + coordinator workflow |
| `notetaker-required` | Is a separate notetaker required? Always / when audio recording / never? | PDD `Facilitation Protocol` |
| `venue-acceptable-list` | Which venue types are acceptable / disallowed? | PDD `Facilitation Protocol` |
| `site-selection` | Sites pre-named in PDD, or deferred to solicitation review? | PDD `Target Population` + `solicitation-review` |
| `payment-unit-entity-id` | `entity_id` is a business key (Connect's dedup grain), never the case id. Default `concat(username, today())` = one paid session/facilitator/day; if ≥2 sessions/day per facilitator, override to a finer-grained business key (e.g. `concat(username, '-', session_date, '-', venue)`). Affects payment collapse. | `connect-opp-setup` Connect form; `pdd-to-deliver-app` §entity_id |
| `saturation-early-stop` | Threshold + sign-off for stopping the pilot before the planned session count? | PDD `Success Metrics` |

**`multi-stage` (additive):**

| ID | Question | Map to surface |
|---|---|---|
| `stage-gate-criteria` | What must be true at the end of stage N to proceed to N+1? | PDD `Stage Gate` per stage |
| `per-stage-archetype` | Which archetype for each stage? | Per-stage Archetype declaration |
| `stage-launch-policy` | Does stage N+1 launch before stage N is fully reviewed, or after? | PDD `Timeline` |

The bar criterion alone determines what rows belong in the log — the
tables above are teaching templates that improve over time.

### Schema and write semantics

Schema is defined in `lib/decisions-schema.ts` (`DecisionRowSchema` /
`DecisionRowStrictSchema` / `DecisionsLogSchema`, v4). Do not
hand-construct YAML — call the `decisions_append_rows` MCP atom
(ace-decisions server). The atom's input schema is
`DecisionRowStrictSchema` (the strict write-boundary variant), so
unknown / misspelled field names AND violations of the load-bearing
invariants below are rejected at the call boundary before they touch
Drive.

**`rows:` is the ATOM ARGUMENT, not the file's top-level key.** The
`decisions_append_rows` call takes `rows: [...]` (the array of new rows
to append), but the persisted `decisions.yaml` is keyed `decisions:` at
top level — `DecisionsLogSchema` in `lib/decisions-schema.ts` is
`{ schema_version, decisions: [...] }`. `decisions-render` /
`render_decisions_log` and ace-web's parser read `decisions:` and reject
a file whose top-level key is `rows:`. Do not confuse the two: the atom
example below shows `rows:` because that is the argument name; the file
on Drive uses `decisions:`.

**If `decisions_append_rows` is unavailable this session** — the
`ace-decisions` MCP failed to bind at session start (the same
session-binding class as the ace-mobile / Nova gotchas; confirm by
checking whether any `decisions_*` atom resolves via `ToolSearch`) — then
the atom path is closed and you must hand-write `decisions.yaml` in the
**persisted** shape (top-level `decisions:`, NOT `rows:`):

```yaml
schema_version: 4
decisions:
  - id: archetype-selection
    phase: 1-design
    skill: idea-to-pdd
    question: Which delivery archetype best fits the intervention?
    ai-default: atomic-visit
    options: [atomic-visit, longitudinal-visits, focus-group, multi-stage]
    source: idea.md §1
    status: ai-default
    evidence_basis: stated
    value_set_by: ace
    reasoning: Single per-FLW visit producing one structured delivery.
```

Each row obeys the identical field contract documented below; only the
container key differs from the atom argument (`decisions:` list in the
file, `rows:` array in the atom call). Prefer the atom whenever it
resolves — hand-writing skips the strict write-boundary validation, so
re-validate against `DecisionsLogSchema` mentally before saving. (This
exact `rows:`-vs-`decisions:` confusion bit a hand-written fallback when
`ace-decisions` was unbound — jjackson/ace#782.)

**The `value_set_by` contract (load-bearing, v5).** Every row MUST also
declare `value_set_by`: `ace` or `external`. It answers a different
question from `evidence_basis` — not *how well-grounded is this default*
but *whose value is it in the end*.

- **`ace`** — ACE's judgment to make from the source material. Archetype
  selection, verification layers, solicitation type. A reviewer may
  override it; a later run may decide it better.
- **`external`** — the real value gets fixed later by someone else: a
  rate negotiated in a solicitation response, dates set on contract
  execution, an FLW count set at deployment.

**`external` does not defer, escalate, or block anything.** ACE still
picks a value, still writes it as `ai-default`, and the run still
proceeds — exactly as before. `"open"` is still not a valid `status`,
and there is deliberately no `needs-human`. The flag exists so a
downstream phase does not cite a projection as a settled commitment, and
so a later run re-deriving it differently reads as *expected* rather
than as drift.

**Why it was added.** Measured across 22 runs of two opportunities,
`flw-count`, `payment-rate`, `wo-period-of-performance` and
`wo-total-not-to-exceed-usd` produced a different confident-looking
answer on nearly every run. ACE had originally got this right and had
nowhere to put it: hh-poverty run `20260702-1456` wrote *"Deferred to
deployment (Annex B); negotiated via solicitation response"* **inside
the `ai-default` string** on four rows. Prose in a value field is
invisible to every consumer, so within a few runs all four had become
specific numbers.

Note the name: **`value_set_by`, not `resolved_by`** — `resolved_by`
already means something else in this skill (which run closed an
open-question, § Open questions), and the collision would be silent.

**The `evidence_basis` contract (load-bearing, v4).** Every row MUST
declare `evidence_basis`: one of `stated`, `inferred`, or `conflicting`.
This is the forcing function that stops Phase 1 from silently resolving a
contested fork and presenting it as a confident, single-cited default —
the highest-leverage failure mode in the whole lifecycle, since every
downstream phase builds on the PDD.

- **`stated`** — the chosen value is directly stated in a source input.
  `source` cites where.
- **`inferred`** — no source states it; this is a reasoned default the
  AI extrapolated. Say so in `reasoning`. (The cadence "visited twice"
  was stated in the ITN source; the *distinct Visit-2 form content* ACE
  then built was `inferred` — and should have been tagged as such.)
- **`conflicting`** — the source signals **disagree**, and this row
  resolves the conflict. You MUST populate `conflict_signals` with **≥ 2
  entries**, one per competing reading, each citing where it came from.
  Put *why this resolution won* in `reasoning`. Canonical case: the ITN
  app-spec described **one** visit instrument (Sections 1–6) yet
  separately said households are **"visited twice"** — a genuine conflict
  that was silently resolved into two distinct forms with no audit trail.

When in doubt between `stated` and `inferred`, prefer `inferred` — and if
*any* source pulls against the default, it is `conflicting`, not
`inferred`. Do not omit `conflict_signals` on a `conflicting` row, and do
not attach them to a non-conflicting one; both are rejected at the write
boundary.

**The `ai-default` contract (load-bearing).** Every row's `ai-default`
MUST be one of the literal strings in its `options` array, exact-match.
Same for `override` when `status: overridden`. Rationale goes in
`reasoning` (AI side) or `override_reasoning` (human side); citations
go in `source`. Never put prose, qualifications, or rationale into
`ai-default` itself.

Why this matters: ace-web's decisions UI renders each option as a
clickable pill, highlights the pill whose text matches the row's
effective value (`override` if present else `ai-default`), and lets the
human override by simply clicking another pill. The frontend keys the
selection off exact string equality, so any prose extension or
categorical drift in `ai-default` leaves no pill highlighted and breaks
the click-to-override flow. The Zod schema's rejection message names
both the violating value and the expected `options` array so the agent
can self-correct on retry.

The pattern is: pick the option whose text best fits the answer, copy
that string verbatim into `ai-default`, and put the explanation in
`reasoning`. If none of the options fits, the `options` set is wrong —
add another option that matches what the AI is trying to say. Sibling
skills (`pdd-to-work-order`, `connect-opp-setup`, `ocs-agent-setup`,
`synthetic-narrative-plan`, `solicitation-create`, `app-test-cases`,
`pdd-to-deliver-app`) inherit this contract via this canonical doc —
no copy-paste needed in their own SKILLs.

Tool call (idiomatic shape for this skill):

```
decisions_append_rows({
  runFolderId: <run-folder file_id resolved at run start>,
  opportunity: <opp-slug>,
  run_id: <run-id>,
  rows: [
    {
      id: "archetype-selection",
      phase: "1-design",
      skill: "idea-to-pdd",
      question: "Which delivery archetype best fits the intervention?",
      "ai-default": "atomic-visit",
      options: ["atomic-visit", "longitudinal-visits", "focus-group", "multi-stage"],
      source: "idea.md §1; one-FLW-one-delivery pattern",
      status: "ai-default",
      evidence_basis: "stated",
      value_set_by: "ace",
      reasoning: "Single per-FLW visit producing one structured delivery."
    },
    {
      id: "visit-cadence-and-form-model",
      phase: "1-design",
      skill: "idea-to-pdd",
      question: "How many visits per household, and is each a distinct form?",
      "ai-default": "Two distinct forms (V1 + V2)",
      options: ["One instrument administered twice", "Two distinct forms (V1 + V2)"],
      source: "ITN Exploration App doc",
      status: "ai-default",
      evidence_basis: "conflicting",
      conflict_signals: [
        "Exploration App § Visit structure: describes ONE instrument (Sections 1-6); no distinct Visit-2 content",
        "Exploration App § Open-Q4 + Photos: households are 'visited twice' / 'across both visits'"
      ],
      reasoning: "Source confirms a two-visit cadence but never specifies distinct Visit-2 content; picked two forms to model retention, flagging that the Visit-2 content is inferred, not sourced."
    },
    ...
  ]
})
```

The atom seeds a fresh v4 log header (`schema_version`, `opportunity`,
`run_id`, `generated_at`) on the first call and is idempotent: rows
whose `id` is already in the log are silently skipped and returned in
`skipped[]`, so a retry never duplicates rows.

This skill writes only `status: "ai-default"` rows. `overridden` rows
appear when a prior run's human edits carry forward via the fork
endpoint's `keep-all` or `keep-overrides-only` mode. The canonical
worked fixture is `test/skills/idea-to-pdd/fixtures/turmeric-decisions.yaml`
— useful as a reference shape, not as something to copy into Drive.

## Archetypes

ACE skills branch on the PDD's declared `archetype:` field. This skill generates archetype-appropriate sections during step 4 (Draft).

### `atomic-visit` (default)
The PDD describes one FLW visit producing one structured delivery (photo + GPS + form). Use the base sections as-is. Examples: turmeric market survey, household-level data collection.

**Additional questions to answer in step 3:**
- What is the exact form structure (every field, every type)?
- What's the standardization protocol for any photo/measurement (lighting, angle, distance, color reference)?
- What's the per-FLW and per-location daily cap?
- How is duplicate detection handled (vendor ID, stall number, GPS resolution)?

### `longitudinal-visits`

The PDD describes **repeat visits to a durable entity over time** — a
community, household, patient, farm, savings group — where the entity
persists between visits, carries state, and the visits are ordered. This
is CommCare case management: a case type, a registration form, and
follow-up forms against a case list.

The paid unit is still one visit producing one structured delivery, as in
`atomic-visit`. **What differs is that a visit's validity can depend on
the entity's history** — whether this activity has already been
delivered to this entity, whether the sequence is advancing, whether the
visit came from the FLW who owns the case.

**Choose this over `atomic-visit`** whenever the same subject is visited
more than once and the visits are not interchangeable. The tell is that
someone in the program can ask *"is this community/household on track?"*
— a question `atomic-visit` cannot answer, because it has no entity to
track. `atomic-visit`'s duplicate-detection question is framed purely
cross-sectionally ("vendor id, GPS bucket, household id" — *is this the
same subject as some other submission*); it cannot express *duplicate
within this entity's own sequence*.

**Choose this over `multi-stage`** whenever the entities progress
**independently and asynchronously** through the same activity type.
`multi-stage` stages the *program*: one clock, the whole cohort advances
together through a management go/no-go gate, and it builds one Learn app,
one Deliver app and one payment unit **per stage**. `longitudinal-visits`
stages the *entity*: N clocks running at their own pace, one Learn app,
one Deliver app and one payment unit for the whole arc, and the gate is
data written by the visits themselves. Same word "stage", different
subject — picking `multi-stage` for an entity-asynchronous program builds
a fan-out of apps nobody needs and announces "Stage 2 is live" to a
cohort that is not uniformly in Stage 2.

**The `entity_id` lever — read this before writing the Evidence Model.**
Connect's payment dedup grain is `entity_id`, an arbitrary business key
(see `payment-unit-entity-id` in the decisions table). That is what makes
this archetype implementable today with no new platform capability:

- `atomic-visit` sets it cross-sectionally — `concat(username, today())`
  = one paid visit per FLW per day.
- **`longitudinal-visits` sets it to entity + sequence position** — e.g.
  `concat(<case_id>, '-', <activity_code>)` = one payment per activity
  per entity, for the life of the case. A repeat of the same activity on
  the same entity collapses to a single payment automatically.

If the Evidence Model does not say which longitudinal facts Layer A
reads, this archetype degrades silently into `atomic-visit` — the PDD
prose stays longitudinal-aware while the payment predicate quietly
becomes "any visit counts." That is a real, measured failure
(`spark-facilitator/20260813-2126`, ace#1462), and it is the specific
thing this archetype exists to prevent.

**Additional questions to answer in step 3:**

- **The entity**: what is followed over time, what case type represents
  it, and what identifies one instance?
- **Registration**: is the entity registered by a separate form, by the
  first visit, or does it already exist in the partner's system (and if
  so, how does the case get created — import, sync, or re-registration)?
- **Expected sequence and cadence**: what visits are expected, in what
  order, at what interval — and does the cadence change across the arc?
- **State read and written**: what does each visit preload from the case,
  and what does it write back? (This is what makes progression
  measurable at all.)
- **Payability against history**: is the same activity twice payable? Is
  an out-of-order visit payable? Is there a per-entity cap over a
  window? **Answer this explicitly — silence here is what produces
  "any visit counts."**
- **`entity_id` composition**: the business key that expresses the
  answer above (see the lever, above).
- **Ownership**: is a visit payable only from the FLW assigned to that
  case, or from any FLW?
- **Progression vs payment**: does a stalled entity affect payment, or
  is progression monitored only? (Both are legitimate; leaving it
  undecided is not.)
- **End of arc**: what does "complete" mean for an entity, and what
  happens to the case — graduation, handover, closure?

**Additional sections to include in the PDD draft:**

- **Entity Lifecycle** — the entity, its states/phases, what moves it
  between them, the expected visit sequence, and what completion means.
- The **Evidence Model** gains an explicit *longitudinal clause* under
  Layer A: which case facts the payment predicate reads, and the
  resulting `entity_id`. A Layer A that reads only the current form's
  fields is the degradation described above.

### `focus-group`

The PDD describes FLW-facilitated group discussions producing qualitative
content. **The FGD operational model is attestation-form-only on
CommCare; all qualitative content (themes, quotes, post-section
summaries, post-FGD report, facilitator reflection) is captured
out-of-band in a Google Doc.** Facilitator training is correspondingly
out-of-band — OCS chatbot + handbook gdoc + coordinator-graded
practice-session audio review. No Learn app is produced. See
`docs/superpowers/specs/2026-05-15-focus-group-archetype-redefinition.md`.

**Additional questions to answer in step 3:**

- **Recruitment**: Who are the segments? How will participants be identified? What sample size per segment? Comparison groups and their justification?
- **Language**: Working language, and its CommCare language code? Facilitator language fluency? (The APP is now translated into the working language on top of an always-complete English source — PR #1463, superseding ace#968/#1391, 2026-08-17. Also ask which OTHER surfaces need the working language: training materials, facilitation, OCS chatbot. Translations are ACE-authored and carry `needs-review` — ask who reviews them, same as you would for the English.)
- **Facilitation skill level**: Existing skill assumed, or training required? Training surface is the per-opp **OCS chatbot** (loaded with the FGD Guide + Output Specification + handbook gdoc) plus a coordinator-graded practice-session audio review. The Learn app produced for focus-group is a **minimal sentinel** (one-form readiness gate, not a training curriculum) — it exists to satisfy Connect's API + gate attestation submissions on coordinator-confirmed practice-session-pass, NOT to carry training content. See `pdd-to-learn-app/SKILL.md § Archetypes § focus-group` for the sentinel spec.
- **Consent**: Verbal/written? Audio recording consent? Photo consent? Documented how?
- **Venue**: Neutral / facility / leader's compound? Each biases differently — which is acceptable?
- **Duration & compensation**: Expected session length? Participant opportunity cost compensated? Per-session facilitator + notetaker rate? Facilitator training stipend tied to practice-session-pass?
- **Question guide**: Sequencing (sensitive/program-specific questions last to avoid anchoring), prioritization (a 90-minute group covers 8–10 questions well, not 15+), warm-up questions, probing prompts.
- **Output spec — the gdoc structure**: What does a "good gdoc" look like? Per-section themes (3–6 bullets, with specifics), notable verbatim quotes (2–4 per section, role attribution like "mother" / "father" / "grandmother" not by name), level of consensus (strong / mixed / disagreement + justification), time spent per section, post-FGD report (top 5 things we heard, most-cited barriers, per-option reactions, surprises, recommendations), facilitator reflection (150–300 words). This structure goes in the **PDD's Output Specification** section and seeds both the gdoc template the facilitator fills out and the OCS chatbot's RAG content for post-session writing guidance.
- **Attestation form fields**: What does the per-session CommCare attestation form capture? Default: 5 fields — consent attestation (single yes/no, must be yes to submit), session date, venue (free text), GPS (geopoint), one evidence photo. Audio is NOT captured through CommCare (out-of-band, lives in Drive). The gdoc link is NOT captured (gdoc is written after submission). Everything else (participant count, segment, start/end times, per-section summaries, facilitator reflection) goes in the gdoc, not in the form. See `pdd-to-deliver-app/SKILL.md § Archetypes § focus-group` for the canonical 5-field list.

**Additional sections to include in the PDD draft:**

- **Recruitment Plan** — segments, sample sizes, identification mechanism, comparison groups.
- **Facilitation Protocol** — skill level, training surface (OCS chatbot + handbook gdoc + practice-session audio review), venue, language, consent, recording, compensation.
- **Question Guide** — ordered questions per section, with probes and warm-ups, and time allocation.
- **Output Specification** — **the gdoc structure** the facilitator fills in. Per-section format with concrete fields (themes, notable quotes, level of consensus, time spent, facilitator reflection). The Deliver app's attestation form captures *metadata and artifacts*, not this content — but the OCS chatbot's RAG content is seeded from this section so facilitators can ask "what should I put in section 3?" during write-up.

### `multi-stage`
The PDD has two or more sequenced stages with different archetypes. Treat the base sections as describing the overall intervention and create one **Stage X** subsection per stage, each declaring its own archetype and following that archetype's additional sections.

**Required for multi-stage PDDs:** an explicit **Stage Gate** subsection between every pair of stages, stating exactly what must be true at the end of stage N to proceed to stage N+1 (with go / no-go / iterate criteria).

## MCP Tools Used
- Google Drive: `drive_read_file` (pass `exportAs: 'text/markdown'` when re-reading the PDD **or `open-questions.md`** — both are rendered gdocs, and the default plain-text export drops the `#` heading markers and flattens pipe tables to one cell per line), `drive_create_doc_from_markdown` (the PDD and `open-questions.md` — human-facing prose; write `open-questions.md` in the two-section `## Open` / `## Archive` shape from § The durable open-questions doc, moving resolved rows into `## Archive` rather than annotating them in place — ace#1487), `drive_create_file` (machine-parsed YAML only), `drive_update_file`, `drive_download_binary` (binary/`.ccz`/`.xlsx` inputs)
- Google Sheets: `sheets_list_tabs`, `sheets_batch_read` (Google-Sheet inputs)
- Google Forms: `get_google_form_definition` (Google-Form inputs)

## Mode Behavior

- **Default (auto):** Author `decisions.yaml` (step 3a), draft PDD using
  those defaults, write PDD + gate brief, email summary to admin group,
  proceed. The decisions.yaml ships with the run; humans review post-hoc
  and re-run via `/ace:step idea-to-pdd <opp>/<run-id>` after editing if
  they want a different PDD.
- **Review:** Author `decisions.yaml` (step 3a), then **pause** before
  drafting the PDD. Emit an interim gate brief stating "Decisions log
  written; edit any defaults you want changed, then resume." On resume,
  re-read `decisions.yaml` and draft the PDD using the (possibly edited)
  values. Continue to PDD-final gate brief as today.

## Dry-Run Behavior
When `--dry-run` is active:
- Write the PDD to `ACE/<opp-name>/runs/<run-id>/1-design/idea-to-pdd.md` as normal
- Write the admin email summary (recipients, subject, body) to `comms-log/dry-run-idea-to-pdd.md`
- Do not send emails to the admin group
- State tracks as `dry-run-success`

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-08-13 | **CORRECTION — the randomization rule stands, its stated reason does not (ace#1213; ace#1121 reopened).** The entry below justified 'do not spec a per-attempt item draw' by claiming Connect's single `passing_score` makes a draw unusable. That argument only applies to a **variable-size** draw; the specified mechanism was a fixed 12-of-30, which keeps the denominator constant, so it never bit. And per Jonathan the same day, a per-attempt draw **is** expressible in XForms — a seeded `once(random())` selecting from a lookup-table/fixture nodeset, or hidden questions gated on `relevant`. What is actually missing is a **Nova authoring primitive** plus the complexity of that machinery. Step 4a's guidance is unchanged in effect (still: spec one fixed bank) but now states the reason correctly, points at `_app-component-library.md § Mechanisms a PDD must not assert` — **Table B**, buildable-but-unsupported — and adds an explicit instruction: **do not write that rotation is impossible**, and where a program genuinely needs it, file a Nova capability request. New standing rule in Step 4a: when uncertain whether a mechanism is platform-closed or merely unsupported, write *'ACE does not build this today'* rather than *'this is impossible'* — a false platform constraint in a Work Order outlives the constraint and forecloses the capability request someone should be making. | ACE team |
| 2026-08-13 | **Step 4a checks every enforcement mechanism against the known-unbuildable list before specifying it (ace#1213, closes ace#1121).** Phase 1 could spec a mechanism the platform cannot build and nothing caught it until Phase 3 — `idea-to-pdd-qa` passed 6/6 and `idea-to-pdd-eval` scored the PDD 7.97 `pass`. By then the PDD, the **Work Order** and the Phase-6 **training materials** all described a control that does not exist, and a build-time deviation memo does not retro-correct three shipped documents. Step 4a gains a leading hard check against `_app-component-library.md § Known-unbuildable mechanisms`: a listed mechanism MUST NOT be asserted as enforced; state the buildable approximation and name the residual (the shape `gps-accuracy-capture` already models), or raise an open question. The per-topic bullets are now explicitly the instances, and the list is the enumerable version that gets checked. Also adds the rule **do not spec a randomized or per-attempt item draw** — spec one fixed bank sized for the gate, and where retake-resistance genuinely matters raise it as an open question, noting that unlimited re-attempts against a fixed bank lets a worker pass by memorising the answers. **The RATIONALE shipped in this entry was wrong and is retracted — see the correction entry above; ace#1121 is reopened.** *Enforced (structurally):* `test/skills/known-unbuildable-mechanisms.test.ts`. | ACE team |
| 2026-05-15 | Pare attestation-form-fields question + Decisions Log to match the 5-field form: consent / date / venue / GPS / photo. Audio is out-of-band; gdoc_link is removed (gdoc is written after submission). Add `gps-verification-radius` and `gdoc-submission-window` decisions; recharacterize `audio-min-duration` and `audio-consent-fallback` as facilitator-protocol concerns (out-of-band, not in the form). | ACE team |
| 2026-05-15 | Recharacterize `payment-rate` and `per-session-rate` Decisions Log rows: PDD captures a **range** (not a fixed number), and the actual rate is **negotiated via the solicitation response** where the LLO proposes a number with rationale. The awarded LLO's proposed rate becomes the `connect.deliver_unit` payment_unit amount at Phase 4 setup. Pairs with `solicitation-create/SKILL.md § Process`'s "per-unit payment is negotiated, not declared" design principle. | ACE team |
| 2026-05-22 | **Retire the optional `idea.md` operator-seed input.** The 2026-05-05 refactor reduced `idea.md` to an optional `--idea FILE\|-` seed alongside the `inputs/` evidence pack; the dual-path persisted but was rarely used in practice and added cognitive load (eval rubric branches, manifest-vs-idea precedence, permission-scan URL extraction). Operators now put any free-text seed directly into `inputs/` as a regular source file. Removed: optional table row, idea.md read paragraph, idea.md-URL permission scan, "or no idea.md" branch of the missing-source error. The `--idea` flag and run-root `idea.md` artifact are gone. | ACE team |
| 2026-05-29 | **Spec-for-deployability guidance (ITN post-mortem, upstream half).** Added Step 4a: when the source/evidence model implies capture fidelity (GPS accuracy radius, enumerable answers, bucketed numerics), data-quality constraints, case write-back on follow-up visits, assessment enforcement (pre/post + threshold + item count + conditional result), or a non-English working language, the PDD MUST spec it explicitly rather than only naming the topic. A thin PDD produces a faithfully-thin app that the new app-eval fitness gates hard-fail. The cure is a deployable PDD. See `docs/superpowers/specs/2026-05-29-eval-fitness-gap.md`. | ACE team |
| 2026-07-28 | **A stated GPS accuracy tolerance may no longer be asserted as enforced (ace#1006).** Step 4a's capture-fidelity bullet used to say "spec accuracy-gated GPS (preferred + minimum accuracy, capture-gate)". No such gate is buildable — Nova rejects `validate` on `kind: geopoint`, and Connect's verification-flags form no longer renders `gps` / `gps_radius_meters` (ace#1013). Since the PDD's Evidence Model sentence flows verbatim into the Work Order, an enforced-sounding tolerance puts a promise ACE cannot keep into a contractual document. The bullet now requires accuracy-AWARE phrasing (captured + submitted + advisory + down-weighted in dedup) and forbids "rejected" / "must be ≤ X to submit" / "the app enforces" / "Connect enforces"; a genuine need for a hard gate is raised as an open question instead. | ACE team |
| 2026-08-02 | **A per-row qualifier and an aggregate over the same repeat must agree (ace#1123).** Step 4a's data-quality bullet now forbids pairing a per-row confirmation/eligibility question with an unfiltered `count()`/`sum()` over the same nodeset — the aggregate MUST carry the qualifier in its predicate. `hh-poverty-targeting` v2.1 specified a roster membership confirmation on screen 5 AND `count(/data/roster)` in the data-quality table; the build followed the table, asked the required question on every row, and ignored the answer. Household size is 31 of 102 attainable PPI points across a sharp band boundary, so one wrongly-retained member moved the score 21 points. Same family as ace#995 (dead `now()`) and ace#1006 (unenforceable GPS gate): a control that reads as configured everywhere and does nothing in the built app. | ACE team |
| 2026-08-02 | **Worked assessment items emitted by the PDD must be labelled ILLUSTRATIVE (ace#1120).** Step 4a's assessment-enforcement bullet now requires any worked example to be marked as illustrative of the required shape, never as mandated bank content — a PDD specifies the assessment blueprint; a specific quiz item is build content. All three of `hh-poverty-targeting` v2.1's worked items were guessed cold by both independent blind probes, and worked items anchor the tone of the ~21 items Phase 3 authors. Paired with the matching builder-side rule in `skills/pdd-to-learn-app/SKILL.md` (hardening or discarding a PDD example is PDD-compliant, not a deviation). | ACE team |
