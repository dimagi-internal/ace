---
name: solicitation-create
description: >
  Phase 6 step 1 (auto, default run). Translate the approved PDD into a
  solicitation payload, derive evaluation criteria via labs's
  generate_criteria endpoint, and publish the solicitation via the
  connect-labs MCP. Captures solicitation_id and public_url for downstream
  skills.
---

# Solicitation Create

Phase 6 default-run skill. Builds and publishes the solicitation in one
shot — ACE always publishes, never drafts. The solicitation can be edited
post-publish via the labs UI without affecting responses.

## Inputs

- `ACE/<opp-name>/inputs/pdd.md` — approved PDD (intervention, scope, success criteria, total_budget, optional Solicitation section)
- `ACE/<opp-name>/opp.yaml` — program_id, archetype, opp display name

## Process

1. **Read the PDD.** Extract the fields per the table below. The PDD's
   `## Solicitation` section is optional; defaults apply when fields are
   missing or use placeholder values like `[EOI | RFP — default EOI]`.

2. **Build the solicitation payload:**

   | Field | Source |
   |---|---|
   | `title` | `<solicitation_type>: <pdd.title> — <pdd.archetype>` |
   | `solicitation_type` | PDD `## Solicitation` → `Solicitation type` (default `EOI`) |
   | `description` | PDD `## Problem Statement` + `## Intervention Design` (concatenate with a blank line) |
   | `scope_of_work` | PDD `## Learn App Specification` + `## Deliver App Specification` + `## Success Metrics` (concatenated) |
   | `budget` | PDD `## Budget` → `Estimated cost` value, parsed as a number |
   | `deadline` | `now() + (response_window_days || 14)` days, ISO-8601 UTC |
   | `evaluation_criteria` | derived by `generate_criteria` (see step 3) |
   | `response_template` | PDD `## Solicitation` → `Response template` list, or the default 6-question set if empty |
   | `status` | `published` |
   | `program_id` | `opp.yaml.program_id` |

3. **Derive evaluation criteria.** Call:

   ```
   mcp__connect-labs__generate_criteria(
     scope_text: <description + scope_of_work>,
     archetype: <pdd.archetype>
   )
   ```

   Capture the structured rubric (criteria + weights) into the payload's
   `evaluation_criteria` field.

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
   ACE/<opp-name>/solicitation/draft.md
   ```

   Include all fields from the payload as a structured YAML-frontmatter +
   prose body, so the `solicitation-create-eval` rubric can re-read it.

5. **Publish.** Call:

   ```
   mcp__connect-labs__create_solicitation(<payload>)
   ```

   Capture the returned `solicitation_id`, `public_url`, and `manage_url`.

6. **Write `published.md`.** Save:

   ```
   ACE/<opp-name>/solicitation/published.md
   ```

   Body: full payload as written, returned IDs/URLs, deadline in absolute
   ISO-8601 form, the AI-derived `evaluation_criteria` (so
   `solicitation-review` and `solicitation-monitor` have the rubric
   without re-fetching from labs).

7. **Update `opp.yaml`.** Add a `solicitation:` block:

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

- `ACE/<opp-name>/solicitation/draft.md` (audit)
- `ACE/<opp-name>/solicitation/published.md` (live state)
- `opp.yaml.solicitation.{solicitation_id, public_url, deadline, status: open}` populated
- `opp.yaml.selected_llo.*` stubbed (null until award)

## MCP Tools Used

- `connect-labs`: `generate_criteria`, `create_solicitation`
- `ace-gdrive`: `drive_create_file`, `drive_read_file`, `drive_update_file`

## Mode Behavior

- **Auto:** Publish in one pass.
- **Review:** Pause after Step 6, present `published.md` for human
  approval before mutating `opp.yaml`. (The publish itself already
  happened — review-mode is about the local state mutation, not the
  external call. If review rejects, the human can call labs's
  `update_solicitation` to draft or close the solicitation.)
- **Dry-run:** Steps 1-4, skip steps 5-7. Verdict with `dry_run: true`.
