---
name: pdd-to-learn-app
description: >
  Build the CommCare Learn (training) app from the PDD via Nova's
  /nova:autobuild. Captures nova_app_id and writes a structure summary.
disable-model-invocation: false
---

# PDD to Learn App

Generate the Learn (training) app from the PDD using the Nova plugin
(`voidcraft-labs/nova-marketplace`, slash command `/nova:autobuild`).

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 1 | `1-design/idea-to-pdd.md` | source PDD; archetype + Learn App Specification drive the Nova brief |

## Products

- `3-commcare/pdd-to-learn-app_summary.md` — Learn-app structure summary (modules, forms, fields, `nova_app_id`)

## Process

1. **Read the PDD** from `ACE/<opp-name>/runs/<run-id>/1-design/idea-to-pdd.md` via Google Drive MCP.

1a. **Archetype check — focus-group uses the sentinel pattern.** If the
    PDD's `Archetype:` is `focus-group`, this skill still produces a
    Learn app, but a **minimal sentinel** — a single 1-form readiness
    check, not a full training curriculum. It satisfies the
    `connect_create_opportunity` non-null `learn_app` requirement AND
    gates whether the facilitator has completed the out-of-band training.
    Proceed to step 2 with the focus-group sentinel brief described in
    `## Archetypes § focus-group` below. For the sentinel rationale + the
    out-of-band training model, see reference.md § focus-group sentinel
    rationale.

    For `multi-stage` PDDs, follow the multi-stage branch below — each
    stage's Learn app shape depends on the stage's declared archetype.

2. **Extract the Learn app spec** from the PDD. The spec drives the Nova
   brief; what to extract depends on `archetype:` (see `## Archetypes` below).

3. **Compose a Nova brief** — a single natural-language description that
   `/nova:autobuild` consumes as its sole argument. Nova does not accept
   file paths or markdown attachments; whatever Nova needs to build the
   right app must be inline in the description string. The brief should:
   - Open with the app's purpose and target FLW persona (1–2 sentences)
   - State the archetype framing explicitly (e.g. "this is a facilitation
     training app, not a form-walkthrough app")
   - **Explicitly state this is a CommCare Connect Learn app and that
     every content form needs `connect.learn_module` and every quiz
     form needs `connect.assessment` per CommCare Connect's rules.**
     Load-bearing language — without it, autobuild often skips the
     per-form Connect blocks. For why, see reference.md § Connect-marker
     language is load-bearing.
   - Describe each module / form, in order
   - List the required Connectify fields (Learn Module, Assessment Score)
   - Reference the relevant PDD section when it shapes Nova's choices
   - **REQUIRED — Forbid angle-bracket placeholder notation in
     label/option/hint text.** Insert this paragraph **verbatim** into
     the brief, in its own paragraph, prefixed `REQUIRED:`:

     > REQUIRED: Do NOT use literal `<` or `>` characters in any form
     > label, option label, hint text, constraint message, or itext
     > value. Nova's XForm emitter does not entity-encode `<`/`>` in
     > label text, so a literal "<3 letters>" or "<number>" placeholder
     > becomes invalid XML when CCHQ parses the form during
     > `make_build` (CCHQ rejects with "Error parsing XML: StartTag:
     > invalid element name"). Use words ("three letters", "a number")
     > or backticks (`three letters`) for placeholder syntax. Same rule
     > for `&` and `"` in label text — write them out as words instead
     > of relying on entity encoding to land. This applies especially
     > to pattern-recognition / regex-style quiz options where it's
     > tempting to write `<country><number>.<number>` literally.

     For the upstream filing + the `app-release` Step 2.7 backstop, see
     reference.md § Angle-bracket placeholder ban.
   - **REQUIRED — Set `connect.learn_module.id` AND `connect.assessment.id`
     explicitly to short stable identifiers, separately from the human-
     readable `name`.** This is the load-bearing constraint; the ≤40-char
     name fallback below is just a safety net. Insert this paragraph
     **verbatim** into the brief, in its own paragraph, prefixed `REQUIRED:`:

     > REQUIRED: Every `connect.learn_module` and `connect.assessment`
     > block MUST include an explicit `id` field. The id is the Connect
     > slug — it MUST be short (8-20 chars), lowercase, snake_case, code-
     > like, and stable across renames of the human-readable name. Examples:
     > `m1_background`, `m6_sample_prep`, `m1_quiz`. Do NOT rely on Nova's
     > default derivation (`module_<index>_<slugify(name)>`) — that
     > conflates the Connect slug with the display name and trips Connect's
     > 50-char `LearnModule.slug` column on any name that slugifies past
     > ~40 chars. The `name` field is a separate, human-readable string
     > that can be any length and any character set — that's where the
     > descriptive title belongs. Vellum-authored apps (the human-driven
     > authoring path in HQ's form designer) separate these into two UI
     > fields ("Module ID" and "Name") and humans naturally pick short
     > identifiers; Nova's API exposes the same two fields but the
     > architect has to set both explicitly because there's no UI to
     > nudge the separation. See `docs/learnings/2026-05-17-connect-slug-length-50-char-trap.md`
     > § Generalization (Vellum-as-source-of-truth) for the full mechanism
     > + source citations.

   - **REQUIRED — `connect.learn_module.time_estimate` is in HOURS, not
     minutes.** Insert this paragraph **verbatim** into the brief, in its
     own paragraph, prefixed `REQUIRED:`:

     > REQUIRED: The `connect.learn_module.time_estimate` field is the
     > estimated time to complete the module in **HOURS**, not minutes.
     > Vellum's plugin help text says verbatim "Estimated time to complete
     > the module in hours" (`src/commcareConnect.js:158`) and Connect's
     > `LearnModule.time_estimate` model field docstring says "Estimated
     > hours to complete the module". For typical Learn modules this is
     > 1 (one hour) or 2; never a two-digit minute count. If a module
     > genuinely takes less than an hour, round up to 1 — Connect displays
     > the value in dashboards as hours-to-complete and FLW-onboarding
     > timing calculations downstream assume the unit.

   - **REQUIRED — Keep module/assessment names short enough that the
     derived slug fits Connect's 50-char column (FALLBACK).** This is the
     defense-in-depth fallback for cases where the explicit-id rule above
     is missed. Insert this paragraph **verbatim** into the brief, in its
     own paragraph, prefixed `REQUIRED:`:

     > REQUIRED: If you have not set `connect.learn_module.id` /
     > `connect.assessment.id` explicitly per the rule above, the `name`
     > field MUST be ≤ 40 characters as a fallback — Nova's default slug
     > derivation `module_<index>_<slugify(name)>` overflows Connect's
     > 50-char `LearnModule.slug` column on longer names and triggers an
     > opaque HTTP 500 from `connect_create_opportunity`. Prefer the
     > explicit-id rule above (cleaner; lets `name` be any length); this
     > clause exists only because architects sometimes skip the id field.

     For the reproducer, the `app-release` Step 6 backstop, and removal
     criteria, see reference.md § ≤40-char name fallback.
   - **REQUIRED — Architect must verify-then-retry every `add_fields`
     call.** Nova's `add_fields` has a partial-persistence quirk: a
     single call with N items often persists only the first few.
     Mid-build sessions where the architect skipped verification have
     shipped forms that look complete in the build summary but render
     with missing questions. Insert this paragraph **verbatim** into
     the brief, in its own paragraph, prefixed `REQUIRED:`:

     > REQUIRED: Nova's `add_fields` has a partial-persistence quirk.
     > After EVERY `add_fields` call, immediately call `get_form` and
     > count the persisted fields. If the count is less than what you
     > requested, re-issue `add_fields` for the missing fields and
     > re-verify. Repeat until counts match. Do not move on to the
     > next form before counts match — silent partial persistence on
     > form N becomes invisible once you start working on form N+1.

     For the full failure analysis, see reference.md § add_fields
     verify-then-retry.
   - **REQUIRED — `user_score` MUST be a PERCENTAGE (0-100), not a raw
     point sum.** Connect's `passing_score` field on each assessment is
     on a 0-100 scale — `passing_score: 80` means "pass at 80%."
     Insert this paragraph **verbatim** into the brief, in its own
     paragraph, prefixed `REQUIRED:`:

     > REQUIRED: The `user_score` hidden field on every quiz form MUST
     > compute a PERCENTAGE on the 0-100 scale, NOT a raw point sum.
     > Formula: `(q1_score + q2_score + ... + qN_score) * 100 div N`
     > where N is the total number of scored questions in that quiz.
     > For a 5-question quiz where each `qK_score` is `if(correct, 1, 0)`,
     > the calculate expression is:
     > `(#form/q1_score + #form/q2_score + #form/q3_score + #form/q4_score + #form/q5_score) * 100 div 5`
     > This produces 0 (0%), 20, 40, 60, 80, or 100 (100%).
     > Connect's `passing_score` is ALWAYS 80 (= 80%) for ACE-built
     > Learn apps. With percentage scoring, 80 means "at least 4 of 5
     > correct" on a 5-Q quiz, "at least 4 of 4" on a 4-Q quiz
     > (rounds to 100, so 3/4 = 75 < 80 = fail, 4/4 = 100 >= 80 = pass),
     > and "at least 7 of 8" on an 8-Q quiz (7/8 = 87.5 >= 80 = pass).
     > Do NOT emit `user_score` as a raw sum (e.g. 4 out of 5) — Connect
     > compares the raw number against 80 and the FLW always fails.

     For the reproducer, see reference.md § user_score percentage scoring.
   - **REQUIRED — Learn forms must NOT carry `<case>` blocks.** Connect's
     Learn-app contract is form-only; case state is the Deliver app's
     domain. Insert this paragraph **verbatim** into the brief, in its
     own paragraph, prefixed `REQUIRED:`:

     > REQUIRED: Learn forms must NOT create or update CommCare cases.
     > Do not declare a `case_type` on Learn modules, do not configure
     > registration forms to create cases, and do not bind any field to a
     > case property via `case_property_on`. Calibration scores, pass
     > flags, and assessment `user_score` MUST live as form-level hidden
     > fields only — Connect reads them via each form's `connect.assessment`
     > block, which is the right channel for cross-form Learn signal. If
     > a downstream Deliver-app query needs the FLW's calibration status
     > (e.g. "did this FLW pass the standardization gate?"), the answer
     > comes from Connect's per-FLW assessment-completion API, NOT from
     > a CommCare case property written by the Learn app.

   - **REQUIRED — Deployability (fitness) components.** A label-only
     curriculum + one trivial quiz is NOT a deployable training
     instrument; `pdd-to-learn-app-eval` **hard-fails** it. The canonical,
     parameterized text for each component lives in
     **[`skills/_app-component-library.md`](../_app-component-library.md)** —
     the single source of truth, paired 1:1 with the eval dimension that
     hard-fails a build omitting it. For each Learn component whose
     **Trigger** fires, open the library and insert that component's
     **Brief paragraph** into the brief **verbatim**, in its own
     paragraph, prefixed `REQUIRED:`, substituting any `<PARAM>`
     placeholders from the PDD. Emit-checklist (see the library for full
     text + triggers):

     - `assessment-gate` — trigger: PDD specifies a readiness /
       competency gate before delivery. (Gate stays Connect-side — Learn
       forms carry no case blocks per the rule above.)
     - `localization-layer` (Learn variant) — trigger: PDD names a
       working language other than English. **Hard-fail** dimension:
       English-only when the PDD names a working language fails the gate.

     Do NOT inline-paraphrase these — reference the library so the build
     and `pdd-to-learn-app-eval` stay symmetric. Skip a component whose
     trigger doesn't fire.

4. **Invoke `/nova:autobuild "<brief>"`.** This is a one-shot autonomous
   build — Nova will not ask clarifying questions. Capture from the
   response:
   - `app_id` — durable Nova handle, written to the summary as `nova_app_id`
   - Build summary
   - Any warnings Nova emits

4a. **Post-build field-count verification — runnable recipe (skill-side safety net).**

    The architect-brief language above puts retry-then-verify discipline
    on the architect agent. This step is the skill-side safety net for
    cases where the architect finished short. For the failure history
    behind this step, see reference.md § Step 4a safety net.

    **Always run this recipe before writing the success summary.** Not
    a prose contract — a numbered tool-call sequence the L0 LLM
    executes verbatim:

    1. **Build the expected field-count table** from the brief that was
       sent to `/nova:autobuild`. For each `(module, form)` pair the
       brief named, extract the field list. Persist as an in-memory
       map `expected[module][form] -> [field_id, ...]`. The brief is
       the source of truth — not the PDD prose, not the architect's
       return string.

    2. **Read the built app** via one `get_app({app_id})` call. Compare
       module + form names against the expected map. **Halt** if any
       expected `(module, form)` is missing — that's a structural gap
       the field-count recipe can't fix.

    3. **For every form in the expected map**, call
       `get_form({app_id, moduleIndex, formIndex})` (one call per form,
       batchable in parallel across forms). Collect:
       - `persisted_ids`: the set of `field.id` values present in the
         response. Hidden / label / group / repeat fields all count.
       - `persisted_count`: `len(persisted_ids)`.

    4. **Compute the diff per form.** `missing = expected[m][f] -
       persisted_ids`. **Also** compute `referenced_missing`: any field
       referenced in another field's `calculate` / `relevant` /
       Connect-marker `user_score` (the sum the Connect `assessment`
       block reads) that isn't in `persisted_ids`.
       (`validate_app` flags this class as "X references Y which
       doesn't exist in this form" — same shortfall, different
       detection path. Catching it here means we don't ship to
       `validate_app` with a known gap.)

    5. **If `missing ∪ referenced_missing` is empty across every form,
       proceed to step 5 (`/nova:show`).** No edit needed.

    6. **If non-empty for any form**, dispatch ONE `/nova:edit` call
       per affected form. Prompt template:

       ```
       /nova:edit <app_id> "Add the following missing fields to form
       <module-name> / <form-name>: <comma-separated field ids and
       their kind/calculate spec from the brief>. After each add_fields
       call, get_form and verify persistence. Do not return until every
       requested field is present."
       ```

       Re-run step 3 + step 4 after the edit returns.

    7. **Bounded loop, max 3 iterations.** If any form is still short
       after the third iteration, halt with a structured failure
       listing `<form-name>: <missing ids>` per offender, and do NOT
       write the success summary. The operator decides whether to
       /nova:edit manually, re-dispatch autobuild, or escalate.

    Why we run this even though `validate_app` will catch some shortfalls
    downstream: see reference.md § Step 4a safety net.

    Same shape as `app-connect-coverage` — verify+fix in a bounded
    loop, post-Nova.

4b. **Learn-marker compile pre-check (catch `connect_type: ""` before
    deploy) — runs at LEVEL 0.** Mirror of `pdd-to-deliver-app` § 4e.
    The autonomous architect (`Agent(nova:nova-architect-autonomous)`)
    **cannot set the app-level Connect type** — `update_app` /
    `generate_scaffold` are not in its tool allowlist — so a Learn app it
    builds can land with `connect_type: ""` even though every form already
    carries its `connect.learn_module` / `connect.assessment` block. The
    per-form `[Connect enabled]` flag is a **FALSE POSITIVE for compile**:
    with `connect_type: ""` the released CCZ ships with ZERO
    `<learn:module>` / `<learn:assessment>` markers, and Connect's
    HQ→Connect sync cannot register the learn module or the assessment
    gate. `app-release-qa` (Phase 3 Step 2.8) catches it post-release, but
    that is a full deploy→build→release cycle too late — assert it here,
    cheaply, on the already-built app.

    1. Call `get_app({app_id})`. Its summary header prints the app's
       Connect type (e.g. `Connect type: learn`); a standard app prints
       none.
    2. **Assert the header reads `Connect type: learn`.** Do NOT rely on
       the per-form `[Connect enabled]` flag — it is a false positive for
       compile (see above).
    3. On a miss, set it at LEVEL 0 — `update_app` is an architect
       allowlist gap just like the case-list-config family, but it IS
       available to the level-0 session that executes this skill. Call
       `update_app({app_id, connect_type: "learn"})`, then re-run
       `get_app` and re-assert. **Bounded loop, max 3 iterations.** If the
       header still does not read `Connect type: learn` after the third
       attempt (or `update_app` is itself unavailable), halt with a clear
       `learn-marker-wont-compile` failure and do NOT write the success
       summary.

    Reproducer: bednet-spot-check/20260615-0702 — the Learn app scaffolded
    `connect_type: ""`; the first released CCZ had `module=0`/
    `assessment=0`; an L0 `update_app(connect_type="learn")` + re-deploy +
    re-release healed it to `module=1`/`assessment=1`. The fix is this
    pre-check, NOT a `mcp/connect/backends/commcare.ts` change — the
    compile is correct given a correct `connect_type`. See jjackson/ace#783.

4c. **Conditional-result-label pre-check (catch the unconditional pass
    message before deploy) — runs at LEVEL 0.** This is the structural
    preventer for the exact gap `pdd-to-learn-app-eval § assessment_gating`
    hard-fails on: a quiz with an **unconditional** "Well done!" result
    label that fires regardless of score. The brief above (the
    `assessment-gate` component, § Step 3) REQUIRES conditional pass +
    fail/retry labels — but when the brief is hand-composed (e.g. the
    orchestrator executing this skill inline at L0) and the
    `assessment-gate` component paragraph is skipped, the architect emits
    one always-on congratulatory label. The eval catches it, but only
    **after** a full deploy→build→release cycle. Assert it here, cheaply,
    on the already-built blueprint.

    **Trigger:** the PDD specifies a readiness / competency gate before
    delivery (the same trigger that put the `assessment-gate` component in
    scope in § Step 3). If the PDD specifies no gate, skip this step.

    1. For each form carrying a `connect.assessment` block, call
       `get_form({app_id, moduleIndex, formIndex})`.
    2. **Assert the form has a genuine pass/fail result EXPERIENCE:** at
       least one `label` field whose `relevant` references
       `user_score >= <threshold>` (the PASS message) AND a separate
       `label` field whose `relevant` references `user_score < <threshold>`
       (the FAIL/retry message). A single result `label` with NO
       `relevant` condition (fires unconditionally) FAILS this assertion —
       that is the `assessment_gating` hard-gate trigger.
    3. On a miss, heal at LEVEL 0 (`edit_field` / `add_fields` are
       available to the level-0 session that executes this skill): add a
       `relevant: '#form/user_score >= <threshold>'` condition to the
       existing pass label, and `add_fields` a `result_fail` label with
       `relevant: '#form/user_score < <threshold>'` carrying retry
       guidance (review the content, answer again). Use `<threshold>` =
       the PDD's passing score (default 80). Then re-fetch via `get_form`
       and re-assert. **Bounded loop, max 3 iterations.** If the form
       still lacks a conditional pass+fail pair after the third attempt,
       halt with a clear `assessment-result-unconditional` failure and do
       NOT write the success summary.

    Note: the `relevant` XPath legitimately contains `<` / `>=`; that is
    an attribute expression Nova entity-encodes at compile, NOT label text
    — the angle-bracket ban (§ Step 3) applies only to label/option/hint
    TEXT, so a `user_score < 80` relevance is fine.

    Reproducer: bednet-spot-check/20260615-1309 — the inline Phase-3 Learn
    brief omitted the `assessment-gate` component paragraph; the architect
    built one unconditional result label; `pdd-to-learn-app-eval` hard-gated
    it (`assessment_gating` 2.0 → overall 6.58 → fail). An L0
    `edit_field`(relevant) + `add_fields`(result_fail) heal + re-deploy +
    re-release + re-eval lifted it to `assessment_gating` 5.0 → 7.29 / warn.
    Sibling run 20260615-0702 (conditional labels present) scored 7.10 / warn
    — the single dimension is the whole swing on this minimal opp. See
    jjackson/ace#787.

5. **(Optional) Inspect the built app** via `/nova:show <app_id>` to
   cross-check the structure against the PDD before writing the summary.

6. **Self-evaluate (LLM-as-Judge):**
   - Does the app structure match the PDD Learn spec?
   - Are all required Connectify fields configured (Learn Module,
     Assessment Score, passing score)?
   - For `focus-group`: does the app actually teach facilitation craft
     rather than form completion?

7. **Write the summary** to
   `ACE/<opp-name>/runs/<run-id>/3-commcare/pdd-to-learn-app_summary.md`. Required
   frontmatter:

   ```yaml
   ---
   nova_app_id: <id-returned-by-autobuild>
   nova_app_url: https://commcare.app/apps/<id-returned-by-autobuild>
   archetype: <atomic-visit | focus-group | multi-stage>
   ---
   ```

   Body content stays the same as before: module list, Connect
   configuration, decisions made, Nova warnings.

8. **Notify admin group** that Learn app generation is complete, with the
   Nova app URL and a link to the summary in GDrive.

## Archetypes

The Learn app's job depends on the PDD's `archetype:` field. Read it
before composing the brief.

### `atomic-visit`
Learn app teaches FLWs to **collect data** at individual visits. Standard
form-walkthrough Learn app: how to open a case, complete each form field,
what good vs. bad inputs look like (e.g., the photo standardization
protocol from the Evidence Model — Layer A), how to handle edge cases (no
stock, hostile vendor, duplicate), submission and case closure.

### `focus-group`

**Produce a minimal sentinel Learn app** — one module, one form, ~7
fields, both Connect markers (`connect.learn_module` +
`connect.assessment` with passing_score 1). It satisfies the
`connect_create_opportunity` non-null `learn_app` requirement AND is a
coordinator-confirmed in-app readiness gate. For the rationale, see
reference.md § focus-group sentinel rationale.

**Sentinel app spec (the Nova brief):**

- **App name:** `"<Opp display name> — Facilitator Readiness Check"`
  (e.g., "Malaria ITN FGD — Facilitator Readiness Check").
- **One module:** "Readiness Check" (case_type: `facilitator`).
- **One form:** "Briefing Acknowledgement" (case-create form,
  `connect.learn_module` set AND `connect.assessment` with
  `passing_score=1` and `user_score: #form/user_score`).

Fields (the complete sentinel form):

1. `intro` (label) — out-of-band training overview pointing the
   facilitator at the per-opp OCS chatbot + the LLO's handbook gdoc +
   the practice-session audio review the coordinator grades.
2. `case_name` (hidden, calculate `concat(#user/username, ' - readiness')`).
3. `acknowledge_readiness` (single_select yes/no, required, constraint
   `. = 'yes'` — the facilitator must answer `yes`, i.e. coordinator-
   confirmed practice-session-pass). Saves to case property
   `readiness_acknowledged`.
4. `acknowledgement_date` (date, required, default `today()`). Saves
   to `readiness_date`.
5. `q1_score` (hidden, `calculate: if(#form/acknowledge_readiness = 'yes', 1, 0)`).
6. `user_score` (hidden, `calculate: #form/q1_score`). Referenced by
   the `connect.assessment` block.
7. `result_label` (label) — readiness-acknowledged closing message.

The sentinel **does not duplicate or replace** the out-of-band training.
It's a thin in-app artifact whose only operational job is to gate
attestation submissions on coordinator-confirmed practice-session-pass.
The real facilitator training (OCS chatbot + handbook gdoc + coordinator-
graded practice-session audio review) lives out-of-band. For where that
training lives, the "why sentinel and not real training" rationale, and
the full archetype redefinition spec, see reference.md § focus-group
sentinel rationale.

### `multi-stage`
Generate one Learn app per stage that has its own delivery work,
branching on each stage's archetype. If only Stage 2 involves FLW
delivery, only that stage gets a Learn app. The Stage Gate from the PDD
determines whether Stage 2 training launches before or after Stage 1
results.

## MCP Tools Used

- **Google Drive MCP:** `drive_read_file`, `drive_create_file`
- **Nova plugin slash commands:** `/nova:autobuild`, `/nova:show`,
  `/nova:list`, `/nova:edit` (for follow-up tweaks)

The Nova plugin is installed separately
(`/plugin install nova@nova-marketplace`) and signs in via OAuth on first
use. ACE does not call Nova MCP tools by name; it invokes the user-facing
slash commands listed above. See
`playbook/integrations/nova-integration.md` for current status.

## Mode Behavior
- **Auto:** Build via `/nova:autobuild`, write summary, notify admin,
  proceed.
- **Review:** Build, write summary, present summary for review before
  proceeding.

## Dry-Run Behavior
When `--dry-run` is active:
- Do NOT call `/nova:autobuild` (Nova builds are durable side effects;
  a dry run that creates a real app would clutter Nova's app list).
- Write the composed brief and the intended Nova invocation to
  `comms-log/dry-run-pdd-to-learn-app.md` (recipients: nova / brief /
  expected Connectify fields).
- Do not write `app-summaries/learn-app-summary.md` (no `nova_app_id`
  to record).
- State tracks as `dry-run-success`.
