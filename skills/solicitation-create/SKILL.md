---
name: solicitation-create
description: >
  Translate the PDD into a solicitation payload, derive evaluation
  criteria, and publish via connect-labs MCP. Captures solicitation_id.
disable-model-invocation: true
---

# Solicitation Create

Phase 7 default-run skill. Builds and publishes the solicitation in one
shot — ACE always publishes, never drafts. The solicitation can be edited
post-publish via the labs UI without affecting responses.

See `skills/_solicitation-template.md` for the shared
`phases.solicitation-management.outputs.solicitation` contract and
connect-labs MCP atom inventory.

## Inputs

- `ACE/<opp-name>/inputs/pdd.md` — approved PDD (intervention, scope, success criteria, total_budget, optional Solicitation section)
- `ACE/<opp-name>/opp.yaml` — `connect.program.id` (Connect UUID),
  archetype, opp display name, organization_slug, optional cached
  `connect.program.labs_int_id` (labs integer mirror of the Connect
  program)
- `ACE/<opp-name>/runs/<run-id>/3-connect/connect-program-setup.md` —
  the Connect program **name** (used to resolve the labs integer
  program_id via `labs_context`; see Step 5)

## Outputs

- `6-solicitation-management/solicitation-create_summary.md` — solicitation_id, public_url, deadline, audit trail
- `run_state.yaml.phases.solicitation-management.outputs.solicitation` block populated (id, public_url, deadline, status: open, labs_program_id, connect_program_id, connect_opportunity_id). Per-run only — each run of the opp publishes a fresh solicitation. Operator-cleaned-up when picking a release-candidate run.

## Process

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
   | `scope_of_work` | PDD `## Learn App Specification` + `## Deliver App Specification` + `## Success Metrics` (concatenated) |
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

3. **Compose evaluation criteria locally.** Read the PDD's archetype,
   intervention summary, and success criteria. Draft a structured rubric
   inline using the same archetype-aware judgment that
   `solicitation-create-eval` would apply:

   - **`atomic-visit`**: emphasize FLW deployment scale, geographic-fit,
     supervision model, data-quality track record.
   - **`focus-group`**: emphasize facilitator skill, language/cultural
     fit, audio-equipment access, transcription/synthesis capability.
   - **`multi-stage`**: emphasize stage-gate discipline, archetype
     fluency across stages, transition-management.

   Default rubric shape: `[{ id, label, weight: 0..1, scale: 10 }, ...]`
   summing to 1.0.

   **Note (0.13.3):** the earlier 0.12.0 SKILL.md called
   `mcp__connect-labs__generate_criteria` here. That atom does not exist
   in the labs MCP today (the underlying `/api/generate-criteria/` HTTP
   endpoint exists but isn't surfaced as a tool). When labs does expose
   it, we can swap this local composition step for an MCP call without
   changing the rest of the skill.

   **Default 6-question response template** (used when PDD doesn't
   override): "Describe your prior experience deploying CHW programs in
   this archetype.", "How will you recruit and train FLWs for this
   scope?", "What is your timeline for fielding once awarded?", "What is
   your supervision model?", "Do you have local-language capacity matching
   the target geography?", "Provide a budget breakdown for the proposed
   scope."

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
      `runs/<run-id>/3-connect/connect-program-setup.md` (the markdown
      summary written by `connect-program-setup`). Capture the
      program's integer `id`.
   3. **Cache:** write the result to
      `opp.yaml.connect.program.labs_int_id` via `update_yaml_file`
      (`merge: 'two-level'` — `connect:` is the top-level key with
      `program` as a sub-object). This is opp-level state (the
      program is reused across runs, so its labs int mirror is also
      opp-level). Also carry the value into this run's
      `phases.solicitation-management.outputs.solicitation.labs_program_id`
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
   `${LABS_BASE_URL}/labs/solicitations/<id>/`. Manage URL pattern:
   `${LABS_BASE_URL}/labs/solicitations/<id>/edit/`.

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
   current run's `run_state.yaml.phases.solicitation-management.outputs.solicitation`
   via `update_yaml_file` + `merge: 'two-level'`:

   ```yaml
   phases:
     solicitation-management:
       outputs:
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

   The two-level merge replaces `outputs:` wholesale under
   `solicitation-management`. This skill is the sole writer of
   `outputs.solicitation` within the run; `solicitation-review`
   updates the same block in place at award time (within the same
   run).

   `selected_llo` is stubbed by `solicitation-review` on award, not
   here. `selected_llo` lives at
   `phases.solicitation-management.outputs.selected_llo`.

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
- **`opp.yaml.program_id` missing**: halt with "run Phase 3
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
- `run_state.yaml.phases.solicitation-management.outputs.solicitation.{solicitation_id, public_url, deadline, status: open, labs_program_id, ...}` populated (per-run only).
- `opp.yaml.connect.program.labs_int_id` cached on first resolution (durable opp-level — the labs program int matches the Connect program UUID; reused across runs).
- `selected_llo` is left untouched here (populated by `solicitation-review` on award at `outputs.selected_llo`).

## MCP Tools Used

- `connect-labs`: `labs_context` (resolve Connect program name → labs
  integer program_id, when not cached), `create_solicitation`,
  `get_solicitation` (round-trip verification — pass `program_id`)
- `ace-gdrive`: `drive_create_file`, `drive_read_file`,
  `drive_update_file`, `update_yaml_file` (write
  `phases.solicitation-management.outputs.solicitation` to
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

### Common load-bearing decisions for Phase 7

| ID | Question | Map to surface |
|---|---|---|
| `solicitation-type` | EOI vs RFP vs custom? | `solicitation-create-eval`; affects who applies and at what fidelity |
| `response-deadline` | Days from publish to deadline (default 14)? | `solicitation-create` schema; gates Phase 7→8 timing |
| `response-template-choice` | Stock template vs opp-custom response form? | `solicitation-create` content; downstream `solicitation-review` rubric input |

The orchestrator's Phase Write-Back Verifier (`agents/ace-orchestrator.md`
§ Phase Write-Back Contract § Decisions log clause) enforces the
contract; the renderer (`skills/decisions-render`) regenerates the gdoc
at end of every phase.

Each row this skill writes uses `phase: 7-solicitation-management` and
`skill: solicitation-create`.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-05-08 | Add `## Decisions Log` section: 3 anchor rows (solicitation-type, response-deadline, response-template-choice) + bar-criterion reference. Pairs with decisions-log PR #4 (Phase 2-9 writes). | ACE team (decisions-log PR #4) |
