---
name: solicitation-create
description: >
  Translate the PDD into a solicitation payload, derive evaluation
  criteria, and publish via connect-labs MCP. Captures solicitation_id.
disable-model-invocation: true
---

# Solicitation Create

Phase 8 default-run skill. Builds and publishes the solicitation in one
shot — ACE always publishes, never drafts. The solicitation can be edited
post-publish via the labs UI without affecting responses.

See `skills/_solicitation-template.md` for the shared
`phases.solicitation-management.products.solicitation` contract and
connect-labs MCP atom inventory.

## Per-run solicitations are expected, not a bug

**Every `/ace:run` publishes a FRESH solicitation under the same
Connect program — by design.** This skill does NOT detect already-open
solicitations on the program and does NOT close-or-coordinate against
them. Two operational facts make multiple open solicitations correct:

1. **Solicitations are run-scoped audit trails.** Each run's
   solicitation captures *that run's* intent (PDD wording, criteria,
   indicative budget, archetype, deadline). Different runs ship
   different PDD revisions; merging them under one solicitation would
   lose the audit trail.
2. **Launch is operator-coordinated, not skill-coordinated.** The
   typical opp will only have **one** solicitation actually launched
   to candidate LLOs (the chosen release-candidate run's). The other
   open solicitations live in the labs portal until the operator picks
   one to drive Phase 9 from. Stale solicitations are
   operator-cleaned-up via `connect-labs delete_solicitation` or the
   labs UI when picking a release-candidate run.

If you (the agent reading this skill) notice multiple open
solicitations on the same Connect program and feel the urge to
"deduplicate" or "warn-and-prompt," resist. It's not a footgun; it's
how per-run independence is meant to look at the solicitation surface.
The same pattern applies to per-run Connect opportunities and OCS
chatbots — see `agents/ace-orchestrator.md § Modes` for the broader
"each run gets its own live entity; stale ones are operator-managed"
contract.

## Inputs

- `ACE/<opp-name>/inputs/pdd.md` — approved PDD (intervention, scope, success criteria, total_budget, optional Solicitation section)
- `ACE/<opp-name>/opp.yaml` — `connect.program.id` (Connect UUID),
  archetype, opp display name, organization_slug, optional cached
  `connect.program.labs_int_id` (labs integer mirror of the Connect
  program)
- `ACE/<opp-name>/runs/<run-id>/4-connect/connect-program-setup.md` —
  the Connect program **name** (used to resolve the labs integer
  program_id via `labs_context`; see Step 5)

## Products

- `6-solicitation-management/solicitation-create_summary.md` — solicitation_id, public_url, deadline, audit trail
- `run_state.yaml.phases.solicitation-management.products.solicitation` block populated (id, public_url, deadline, status: open, labs_program_id, connect_program_id, connect_opportunity_id). Per-run only — each run of the opp publishes a fresh solicitation. Operator-cleaned-up when picking a release-candidate run.

## Process

> **Design principle: per-unit payment is negotiated, not declared.** The
> labs solicitation `data` schema deliberately has no `per_unit_payment`
> structured field — and we should not push for one. Per-unit payment
> shape varies by archetype (per-visit / per-session / per-stage) and
> within each archetype the right rate is opp-and-LLO-specific.
> Solicitations express payment as a **range with rationale in
> `scope_of_work` prose** (e.g. "Per verified session: 80–120 USD-equivalent,
> facilitator + notetaker combined") and the **`questions` block asks
> the responding LLO to propose their actual rate + why** (q6 in the
> default template). The awarded LLO's proposed rate becomes the
> `connect.deliver_unit` payment_unit amount at Phase 4 setup time. Do
> not embed a fixed per-unit number as the load-bearing economic; the
> range + the question + the LLO's response are the load-bearing parts.

1. **Read the PDD.** Extract the fields per the table below. The PDD's
   `## Solicitation` section is optional; defaults apply when fields are
   missing or use placeholder values like `[EOI | RFP — default EOI]`.

2. **Build the solicitation `data` payload.** All fields below go inside
   the `data` object that wraps the application-level body of the labs
   record. Scoping (`program_id` / `organization_id`) is sibling-level,
   not inside `data` — see step 4.

   | data-object field | Source |
   |---|---|
   | `title` | `<solicitation_type>: <pdd.title> — <pdd.archetype>` |
   | `solicitation_type` | PDD `## Solicitation` → `Solicitation type` (default `EOI`) |
   | `description` | PDD `## Problem Statement` + `## Intervention Design` (concatenate with a blank line) |
   | `scope_of_work` | **Archetype-branched.** See § Scope-of-work composition below. |
   | `budget` | PDD `## Budget` → `Estimated cost` value, parsed as a number |
   | `deadline` | `now() + (response_window_days || 14)` days, ISO-8601 UTC |
   | `evaluation_criteria` | composed locally — see step 3 |
   | `questions` | PDD `## Solicitation` → `Response template`, mapped to `[{id, text, type: 'text', required: false}]`, or the default 6-question set if empty |
   | `status` | `'active'` (publishes immediately; `'draft'` for dry-run mode) |
   | `is_public` | `true` (so unsolicited orgs can find it on the public list) |

   **`is_public: true` flips the server-side public ACL flag** (the
   field the `/solicitations/` marketplace query actually filters on).
   That means the title, description, scope_of_work, and questions
   become readable by any unauthenticated visitor. Before calling
   `create_solicitation`, scan the composed payload and confirm:

   - `description` contains no names, dates of birth, phone numbers,
     addresses, or health data
   - `scope_of_work` references the LLO target population in
     aggregate terms (e.g. "households in Kerala") rather than naming
     specific people, facilities, or identifiable program participants
   - `questions` ask for capability self-disclosure, not for PII

   If the PDD body itself contains PII that would propagate into the
   solicitation, halt and surface a `[BLOCKER]` naming the offending
   field — do NOT publish a redacted version silently, because the
   PDD is the operator's source of truth and they need to know it
   needs scrubbing.

   **Scope-of-work composition** (archetype-branched, since the PDD
   section names differ):

   - **`atomic-visit`** / **`multi-stage`**: concatenate PDD
     `## Learn App Specification` + `## Deliver App Specification` +
     `## Success Metrics`.
   - **`focus-group`**: the FGD PDD has no `## Learn App Specification`
     (the focus-group archetype emits `## Facilitation Protocol`
     instead — see `templates/pdd-template.md` + `pdd-to-learn-app/SKILL.md
     § Archetypes § focus-group`). Concatenate PDD `## Facilitation
     Protocol` + `## Deliver App Specification` + `## Question Guide` +
     `## Recruitment Plan` (sample size targets) + `## Success Metrics`
     + `## Evidence Model` (Layer A/B/C). Open with a "PER VERIFIED
     SESSION, THREE ARTIFACTS" block listing (1) audio recording with
     45-min minimum + audio-off consent-decline branch, (2) per-session
     Google Doc with three blocks (per-section summary / post-FGD
     report / facilitator reflection) + the 72h SLA, (3) 5-field
     CommCare attestation form (consent / session_date / venue / gps /
     photo) with an explicit "NOT in the form" callout so applicant
     LLOs don't assume a 28-field atomic-visit form.

3. **Compose evaluation criteria locally.** Read the PDD's archetype,
   intervention summary, and success criteria. Draft a structured rubric
   inline using the same archetype-aware judgment that
   `solicitation-create-eval` would apply. Default rubric shape:
   `[{ id, label, weight: 0..1, scale: 10 }, ...]` summing to 1.0.

   - **`atomic-visit`** (4-axis starter): FLW deployment scale,
     geographic-fit, supervision model, data-quality track record.
   - **`focus-group`** (6-axis starter — research-stage opps need
     deeper rubric than CHW-deployment opps):
     1. **Qualitative-research experience** (weight ~0.20) — prior
        FGD or in-depth-interview engagements; ability to produce
        usable session-level qualitative content.
     2. **Facilitator skill & language fit** (weight ~0.20) — named
        facilitators with matching local-language fluency + 2+ years
        community-research experience.
     3. **Homogeneous-group recruitment** (weight ~0.15) — ability to
        recruit separate mother / father / grandmother groups in the
        same community without selection bias toward
        LLO-program-favored families.
     4. **Coordinator capacity for gdoc review** (weight ~0.15) —
        rolling-basis review of facilitator gdocs against the PDD's
        Output Specification.
     5. **Audio handling out-of-band** (weight ~0.10) — minimum-45-min
        audio capture, secure Drive-based storage, consent-decline
        fallback to notetaker-only.
     6. **Timeline + per-session payment economics** (weight ~0.20) —
        ability to field within window, comfortable with
        per-attestation-form-submission payment structure.
   - **`multi-stage`**: emphasize stage-gate discipline, archetype
     fluency across stages, transition-management. For each stage with
     its own archetype, fold in 2-3 axes from that archetype's starter.

   **Note (0.13.3):** the earlier 0.12.0 SKILL.md called
   `mcp__connect-labs__generate_criteria` here. That atom does not exist
   in the labs MCP today (the underlying `/api/generate-criteria/` HTTP
   endpoint exists but isn't surfaced as a tool). When labs does expose
   it, we can swap this local composition step for an MCP call without
   changing the rest of the skill.

   **Default 6-question response template, archetype-branched** (used
   when PDD doesn't override):

   For `atomic-visit` / `multi-stage`:
   1. Describe your prior experience deploying CHW programs in this archetype.
   2. How will you recruit and train FLWs for this scope?
   3. What is your timeline for fielding once awarded?
   4. What is your supervision model?
   5. Do you have local-language capacity matching the target geography?
   6. Provide a budget breakdown for the proposed scope.

   For `focus-group` (CHW-deployment vocabulary is wrong; swap to
   qualitative-research vocabulary):
   1. Describe your prior qualitative-research experience (FGDs,
      in-depth interviews) — topic, segment counts, working language,
      and what synthesis output you produced.
   2. How will you recruit homogeneous mother / father / grandmother
      groups without overweighting households with prior LLO program
      history?
   3. What is your timeline from award to first practice-session-pass
      certification, and from award to first live FGD?
   4. Describe your coordinator capacity to review facilitator gdocs
      against an Output Specification rubric on a rolling basis.
   5. What local-language fluency do your named facilitators have, and
      what audio-recording equipment do you have available?
   6. Provide a per-session budget breakdown (facilitator +
      notetaker + participant compensation + venue + coordinator
      review amortized).

4. **Write the draft for traceability.** Save the full payload + the
   AI-derived rubric to:

   ```
   ACE/<opp-name>/runs/<run-id>/6-solicitation-management/solicitation-create_draft.md
   ```

   Include all fields from the payload as a structured YAML-frontmatter +
   prose body, so the `solicitation-create-eval` rubric can re-read it.

5. **Resolve the labs program_id (integer).** The labs MCP expects the
   labs **integer** program ID, *not* the Connect program UUID. Despite
   the schema's `program_id: string`, labs `int()`-parses it internally
   and rejects UUIDs with `ValueError: invalid literal for int()`.

   Resolve in this order:

   1. **Fast path:** if `opp.yaml.connect.program.labs_int_id` is set
      (cached at program-create time by `connect-program-setup`, or
      backfilled by a prior `solicitation-create` run), use it
      directly. This is the durable opp-level cache.
   2. **Lookup:** call `mcp__connect-labs__labs_context()`. Find the
      organization by `opp.yaml.organization_slug` (default
      `ai-demo-space`); within it, find the program whose `name` matches
      the Connect program name from
      `runs/<run-id>/4-connect/connect-program-setup.md` (the markdown
      summary written by `connect-program-setup`). Capture the
      program's integer `id`.
   3. **Cache:** write the result to
      `opp.yaml.connect.program.labs_int_id` via `update_yaml_file`
      (`merge: 'two-level'` — `connect:` is the top-level key with
      `program` as a sub-object). This is opp-level state (the
      program is reused across runs, so its labs int mirror is also
      opp-level). Also carry the value into this run's
      `phases.solicitation-management.products.solicitation.labs_program_id`
      via Step 9's consolidated write so the run state is
      self-contained.
   4. **Halt** with a `[BLOCKER]` if no name match — likely the Connect
      program exists but was never mirrored to labs (labs creates
      shadow programs on first opportunity sync). Surface the Connect
      program name and the list of labs programs the caller can see.

6. **Publish.** Call:

   ```
   mcp__connect-labs__create_solicitation(
     program_id: <resolved labs_program_id as string>,
     data: {
       title: ...,
       solicitation_type: ...,
       description: ...,
       scope_of_work: ...,
       budget: ...,
       deadline: ...,
       evaluation_criteria: [...],
       questions: [...],
       status: 'active',
       is_public: true,
     }
   )
   ```

   The atom requires `data` (object) and at least one of `program_id` /
   `organization_id` (both strings). Application-level fields go inside
   `data` — flat top-level fields (e.g. just sending `title` next to
   `program_id`) get dropped by the labs adapter and the create returns
   without the values being persisted.

   Capture the returned `id` (the labs record id) into `solicitation_id`.
   The response also includes `experiment` (echo of the program_id) and
   the data object as written. Public URL pattern:
   `${LABS_BASE_URL}/solicitations/<id>/`. Manage URL pattern:
   `${LABS_BASE_URL}/solicitations/<id>/edit/`. **NO `/labs/` prefix** —
   `connect-labs/config/urls.py` mounts the solicitations app at
   `/solicitations/`, not `/labs/solicitations/`. The `/labs/` prefix is
   reserved for the authenticated Labs UI (overview, login, explorer).

   **Verify reachability before recording the URL.** After publish,
   issue a HEAD against the constructed public URL and confirm 200. A
   404 here means either the URL pattern doesn't match the current labs
   URLconf (regression on labs side) or the record's envelope `public`
   flag didn't flip (regression on MCP side — see PRs
   commcare-connect#162/164/165 for the canonical contract). Either way,
   surface as `[BLOCKER]` rather than writing a broken URL into
   `run_state.yaml`. This catches the class of bug where the MCP
   reports `is_public: true` but the public listing page renders empty
   (verified jjackson/ace e2e malaria-itn-app run 20260517-1829).

7. **Verify the round-trip.** Immediately after publish, call:

   ```
   mcp__connect-labs__get_solicitation(
     solicitation_id: <returned id>,
     program_id: <same labs_program_id used on create>,
   )
   ```

   This catches the silent-misconfig class where the create succeeds but
   the record is unreachable on subsequent reads. Without `program_id`,
   the labs `LabsRecord` API filters to `is_public=true` only — so a
   newly-created `is_public: false` solicitation (or any future change in
   default visibility) would round-trip as "not found." Always pass
   `program_id` on read so the prod-side membership check authorizes the
   private record. If the verification call returns no record or a
   different `id`, halt and surface the mismatch — do not proceed to
   write `published.md` or mutate `opp.yaml`.

8. **Write `published.md`.** Save:

   ```
   ACE/<opp-name>/runs/<run-id>/6-solicitation-management/solicitation-create_published.md
   ```

   Body: full payload as written, returned IDs/URLs, deadline in absolute
   ISO-8601 form, the AI-derived `evaluation_criteria` (so
   `solicitation-review` and `solicitation-monitor` have the rubric
   without re-fetching from labs).

9. **Write the consolidated solicitation outputs block** to the
   current run's `run_state.yaml.phases.solicitation-management.products.solicitation`
   via `update_yaml_file` + `merge: 'two-level'`:

   ```yaml
   phases:
     solicitation-management:
       products:
         solicitation:
           solicitation_id: <returned>
           labs_program_id: <integer resolved in step 5>
           public_url: <returned>
           manage_url: <returned>
           type: <EOI|RFP>
           published_at: <now ISO-8601>
           deadline: <computed ISO-8601>
           status: open
           awarded:
             response_id: null
             awarded_at: null
             awarded_org_slug: null
             awarded_org_name: null
             awarded_contact_email: null
             award_amount: null
   ```

   The two-level merge replaces `products:` wholesale under
   `solicitation-management`. This skill is the sole writer of
   `products.solicitation` within the run; `solicitation-review`
   updates the same block in place at award time (within the same
   run).

   `selected_llo` is stubbed by `solicitation-review` on award, not
   here. `selected_llo` lives at
   `phases.solicitation-management.products.selected_llo`.

   **No write to `opp.yaml.solicitation`.** Solicitations are per-run
   — every `/ace:run` publishes a fresh solicitation; stale ones from
   prior runs are operator-cleaned-up when picking a release-candidate
   run.

## Error handling

- **Labs MCP unreachable** (proxy returns transport error): halt with a
  doctor-style message pointing at `/ace:doctor`'s `[Connect Labs]`
  section.
- **`create_solicitation` returns 4xx**: preserve `draft.md`, halt,
  surface the error verbatim. Do not retry — most 4xx is a payload
  schema mismatch or the program_id is wrong.
- **`generate_criteria` returns degenerate output** (empty list, single
  criterion): write what was returned, mark `evaluation_criteria` as
  `needs-review` in `published.md`, still publish. Criteria are editable
  post-publish via labs UI without losing responses.
- **`opp.yaml.program_id` missing**: halt with "run Phase 4
  (`connect-setup`) first to register a Connect program." The Connect
  UUID is the upstream evidence that a labs-side program will exist;
  without it there is nothing to look up in `labs_context`.
- **`labs_context` returns no name match for the Connect program**:
  halt. Surface the Connect program name we tried to match plus the list
  of labs programs visible under the org. The remediation is usually
  one of: (a) labs's program shadow was created with a different
  display name (rename via the labs UI); (b) the Connect program was
  created in an org the caller can't see in labs_context (PAT scope
  mismatch); (c) the program was created so recently that labs hasn't
  synced yet — wait a minute and re-run. Do **not** publish a
  solicitation under a guessed labs_program_id.

## Output

- `ACE/<opp-name>/runs/<run-id>/6-solicitation-management/solicitation-create_draft.md` (audit)
- `ACE/<opp-name>/runs/<run-id>/6-solicitation-management/solicitation-create_published.md` (live state)
- `run_state.yaml.phases.solicitation-management.products.solicitation.{solicitation_id, public_url, deadline, status: open, labs_program_id, ...}` populated (per-run only).
- `opp.yaml.connect.program.labs_int_id` cached on first resolution (durable opp-level — the labs program int matches the Connect program UUID; reused across runs).
- `selected_llo` is left untouched here (populated by `solicitation-review` on award at `products.selected_llo`).

## MCP Tools Used

- `connect-labs`: `labs_context` (resolve Connect program name → labs
  integer program_id, when not cached), `create_solicitation`,
  `get_solicitation` (round-trip verification — pass `program_id`)
- `ace-gdrive`: `drive_create_file`, `drive_read_file`,
  `drive_update_file`, `update_yaml_file` (write
  `phases.solicitation-management.products.solicitation` to
  `run_state.yaml`; cache `opp.yaml.connect.program.labs_int_id` on
  first resolution)

## Mode Behavior

- **Auto:** Publish in one pass.
- **Review:** Pause after Step 6, present `published.md` for human
  approval before mutating `run_state.yaml`. (The publish itself
  already happened — review-mode is about the local state mutation,
  not the external call. If review rejects, the human can call labs's
  `update_solicitation` to draft or close the solicitation.)
- **Dry-run:** Steps 1-4, skip steps 5-7. Verdict with `dry_run: true`.

## Decisions Log

This skill writes load-bearing defaults to the per-run
`ACE/<opp-name>/runs/<run-id>/decisions.yaml`. The bar criterion and
schema live in `skills/idea-to-pdd/SKILL.md § Decisions Log Convention`
(canonical authority). The list below catalogs decisions that commonly
qualify under the bar for this phase — a working template, not a
required set. The skill applies the bar criterion and emits whatever
rows meet it; the catalog is a teaching device that improves over time.

### Common load-bearing decisions for Phase 8

| ID | Question | Map to surface |
|---|---|---|
| `solicitation-type` | EOI vs RFP vs custom? | `solicitation-create-eval`; affects who applies and at what fidelity |
| `response-deadline` | Days from publish to deadline (default 14)? | `solicitation-create` schema; gates Phase 8→9 timing |
| `response-template-choice` | Stock template vs opp-custom response form? | `solicitation-create` content; downstream `solicitation-review` rubric input |

The orchestrator's Phase Write-Back Verifier (`agents/ace-orchestrator.md`
§ Phase Write-Back Contract § Decisions log clause) enforces the
contract; the renderer (`skills/decisions-render`) regenerates the gdoc
at end of every phase.

Each row this skill writes uses `phase: 8-solicitation-management` and
`skill: solicitation-create`.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-05-08 | Add `## Decisions Log` section: 3 anchor rows (solicitation-type, response-deadline, response-template-choice) + bar-criterion reference. Pairs with decisions-log PR #4 (Phase 3-10 writes). | ACE team (decisions-log PR #4) |
| 2026-05-15 | Three archetype-branches added for `focus-group`: (1) scope_of_work concatenation in Step 2 — FGD PDD has no `## Learn App Specification` (uses `## Facilitation Protocol` instead); the scope opens with a "PER VERIFIED SESSION, THREE ARTIFACTS" block listing audio + gdoc + 5-field attestation form with explicit "NOT in the form" callout. (2) evaluation_criteria in Step 3 — focus-group goes from a 4-axis sketch to a 6-axis starter rubric (qualitative-research experience, facilitator skill + language, homogeneous-group recruitment, coordinator gdoc-review capacity, audio handling out-of-band, timeline + per-session payment economics). (3) default questions in Step 3 — swap CHW-deployment vocabulary for qualitative-research vocabulary on q1 + q5 + q6. Prompted by `malaria-itn-fgd/20260514-2352` Phase 8 observations. | ACE team |
| 2026-05-15 | Codify the **"per-unit payment is negotiated, not declared"** design principle at the top of `## Process`. Solicitations express payment as a range with rationale in `scope_of_work` prose; the `questions` block asks the responding LLO to propose their actual rate + why. Closes the loop on the "labs `per_unit_payment` schema gap" surfaced in Phase 8 — it's not a gap, it's an intentional design choice (per-unit shape varies by archetype; the rate is opp-and-LLO-specific and negotiated through the response). | ACE team |
