---
name: solicitation-create
description: >
  Translate the PDD into a solicitation payload, derive evaluation
  criteria, and publish via connect-labs MCP. Captures solicitation_id.
disable-model-invocation: true
---

# Solicitation Create

Phase 6 default-run skill. Builds and publishes the solicitation in one
shot — ACE always publishes, never drafts. The solicitation can be edited
post-publish via the labs UI without affecting responses.

See `skills/_solicitation-template.md` for the shared `opp.yaml.solicitation`
contract and connect-labs MCP atom inventory.

## Inputs

- `ACE/<opp-name>/inputs/pdd.md` — approved PDD (intervention, scope, success criteria, total_budget, optional Solicitation section)
- `ACE/<opp-name>/opp.yaml` — program_id, archetype, opp display name

## Outputs

- `6-solicitation-management/solicitation-create_summary.md` — solicitation_id, public_url, deadline, audit trail
- `opp.yaml.solicitation` block populated (id, public_url, deadline, status: open)

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

5. **Publish.** Call:

   ```
   mcp__connect-labs__create_solicitation(
     program_id: <opp.yaml.program_id as string>,
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

6. **Verify the round-trip.** Immediately after publish, call:

   ```
   mcp__connect-labs__get_solicitation(
     solicitation_id: <returned id>,
     program_id: <same program_id used on create>,
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

7. **Write `published.md`.** Save:

   ```
   ACE/<opp-name>/runs/<run-id>/6-solicitation-management/solicitation-create_published.md
   ```

   Body: full payload as written, returned IDs/URLs, deadline in absolute
   ISO-8601 form, the AI-derived `evaluation_criteria` (so
   `solicitation-review` and `solicitation-monitor` have the rubric
   without re-fetching from labs).

8. **Update `opp.yaml`.** Add a `solicitation:` block:

   ```yaml
   solicitation:
     solicitation_id: <returned>
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

   Also stub a `selected_llo:` block:

   ```yaml
   selected_llo:
     org_slug: null
     contact_email: null
     source: null
     response_id: null
   ```

   These will be populated by `solicitation-review` on award.

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
  (`connect-setup`) first to register a Connect program." `program_id` is
  required by labs's `create_solicitation`.

## Output

- `ACE/<opp-name>/runs/<run-id>/6-solicitation-management/solicitation-create_draft.md` (audit)
- `ACE/<opp-name>/runs/<run-id>/6-solicitation-management/solicitation-create_published.md` (live state)
- `opp.yaml.solicitation.{solicitation_id, public_url, deadline, status: open}` populated
- `opp.yaml.selected_llo.*` stubbed (null until award)

## MCP Tools Used

- `connect-labs`: `create_solicitation`, `get_solicitation` (round-trip
  verification — pass `program_id`)
- `ace-gdrive`: `drive_create_file`, `drive_read_file`, `drive_update_file`

## Mode Behavior

- **Auto:** Publish in one pass.
- **Review:** Pause after Step 6, present `published.md` for human
  approval before mutating `opp.yaml`. (The publish itself already
  happened — review-mode is about the local state mutation, not the
  external call. If review rejects, the human can call labs's
  `update_solicitation` to draft or close the solicitation.)
- **Dry-run:** Steps 1-4, skip steps 5-7. Verdict with `dry_run: true`.
