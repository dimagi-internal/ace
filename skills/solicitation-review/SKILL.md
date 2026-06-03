---
name: solicitation-review
description: >
  Score solicitation responses, recommend an awardee, and (after HITL
  approval) call award_response and populate selected_llo.
disable-model-invocation: true
---

# Solicitation Review

Manual skill — never runs in default `/ace:run`. Only via:

```
/ace:step solicitation-review --opp <opp-name>
```

This is the only skill that calls `award_response` (irreversible) and the
only skill that populates `selected_llo` (which gates Phase 9). Writes to
`phases.solicitation-management.products.selected_llo` in the current run's
`run_state.yaml` only.

## Inputs

Read from the current run's `run_state.yaml.phases.solicitation-management.products.solicitation`:

- `solicitation_id`
- `public_url`
- `labs_program_id` — labs **integer** program ID cached by
  `solicitation-create` (also available at
  `opp.yaml.connect.program.connect_int_id` as the durable opp-level
  cache). Required for any `get_solicitation` / `list_solicitations` /
  `update_solicitation` call. Labs's `LabsRecord` read path filters
  to `is_public=true` without scope, and `update_solicitation` runs an
  underlying read first — so private solicitations 404 on every call
  until `program_id` is passed. Note: this is **not** the Connect
  program UUID — labs `int()`-parses the field. If both locations are
  empty, fall back to the resolution recipe in `solicitation-create`
  step 5 (`labs_context` lookup by program name).
- `ACE/<opp-name>/runs/<run-id>/8-solicitation-management/solicitation-create_published.md` (rubric)
- `ACE/<opp-name>/runs/<run-id>/8-solicitation-management/solicitation-monitor_responses/*.md` (all responses)

## Process

1. **Pull all responses fresh.** Call:

   ```
   mcp__connect-labs__list_responses(solicitation_id: <id>)
   ```

   For each response, call `get_response` even if the local cache exists
   (responses may have been edited).

2. **Score each response.** Read the rubric from `published.md` (the
   `evaluation_criteria` block). For each response, score every criterion
   on its declared scale (typically 1-10) and compute a weighted total.
   Use the same archetype-aware judgment that
   `solicitation-create-eval` uses on the rubric itself.

3. **Optionally write to labs.** For each response, call:

   ```
   mcp__connect-labs__create_review(
     response_id: <id>,
     scores: { <criterion_id>: <score>, ... },
     notes: "<reasoning>"
   )
   ```

   This puts ACE's scores in the labs audit trail. Idempotent — call
   `list_reviews` first and skip if a review by `ace@dimagi-ai.com`
   already exists for this response.

4. **Write `scoring-rubric.md`.** Save the per-response, per-criterion
   scores to:

   ```
   ACE/<opp-name>/runs/<run-id>/8-solicitation-management/solicitation-review_scoring-rubric.md
   ```

   Markdown table per response, with columns: criterion, weight, score
   (0-10), notes.

5. **Write `recommendation.md`.** Save:

   ```
   ACE/<opp-name>/runs/<run-id>/8-solicitation-management/solicitation-review_recommendation.md
   ```

   Body: ranked list of candidates with reasoning. Top candidate gets a
   `> Recommended awardee` callout block. Include differentiators (what
   sets the top candidate apart from #2/#3) and any flagged-as-unscoreable
   responses.

6. **HITL gate.** Present `recommendation.md` to the human and ask:

   > "Confirm awarding response_id=<top> ($<amount>) to <org_name>? Reply
   > with `award <response_id> $<amount>` to confirm, or `cancel` to
   > halt."

   Wait for an explicit reply. **Do not call `award_response` without
   one.** If the human picks a different response_id or amount, use
   those.

7. **Call `award_response`.** On confirm:

   ```
   mcp__connect-labs__award_response(
     response_id: <chosen>,
     amount: <chosen_amount>
   )
   ```

8. **Write `award-record.md`.**

   ```
   ACE/<opp-name>/runs/<run-id>/8-solicitation-management/solicitation-review_award-record.md
   ```

   Body: `response_id`, `awarded_at`, `awarded_org_slug`,
   `awarded_org_name`, `awarded_contact_email`, `award_amount`. On
   labs-side error: `status: failed` + the error envelope.

9. **Flip the labs-side status to `awarded`.** Call:

   ```
   mcp__connect-labs__update_solicitation(
     solicitation_id: <id>,
     program_id: <labs_program_id as string>,
     update_data: { status: 'awarded' },
   )
   ```

   `update_solicitation` does a read-then-merge under the hood, so
   `program_id` is mandatory for non-public records — without it the
   underlying `get_record_by_id` returns no row and the merge fails.
   Pass the labs **integer** id (resolved from
   `phases.solicitation-management.products.solicitation.labs_program_id`
   or `opp.yaml.connect.program.connect_int_id`), not the Connect UUID —
   labs `int()`-parses the field. Treat 4xx here as non-fatal:
   `award_response` already succeeded, so write a
   `status_update_failed` note into `award-record.md` and continue.
   The award is durable; the labs-side status flip can be retried
   out-of-band via the labs UI.

10. **Populate `selected_llo` and update solicitation status.** Only
    on a successful award, write to the current run's
    `run_state.yaml` via `update_yaml_file` + `merge: 'deep'`.
    Read the existing `products.solicitation` block first, set
    `status: awarded` and populate the `awarded.*` block, then write
    both `products.solicitation` and `products.selected_llo` in one
    consolidated payload. `deep` merges these under the
    `solicitation-management` phase block while preserving its `status`,
    `steps`, etc. — `two-level` would replace the whole phase block
    wholesale and drop them (#572/#587):

    ```yaml
    phases:
      solicitation-management:
        products:
          solicitation:
            # preserved from solicitation-create + the read above...
            status: awarded
            awarded:
              response_id: <chosen>
              awarded_at: <ISO>
              awarded_org_slug: <returned>
              awarded_org_name: <returned>
              awarded_contact_email: <returned>
              award_amount: <approved $>
          selected_llo:
            org_slug: <returned>
            contact_email: <returned>
            source: solicitation
            response_id: <chosen>
    ```

    **No write to `opp.yaml.selected_llo` or `opp.yaml.solicitation`.**
    These are per-run only. Phase 9 (`llo-onboarding`) reads
    `selected_llo` from the same `run_state.yaml`.

## Error handling

- **HITL gate timeout / no reply**: do not call `award_response`. Do not
  mutate `run_state.yaml` or `opp.yaml`. Exit cleanly so the human can
  re-run the skill.
- **Human replies `cancel`**: halt; do not write `award-record.md`.
- **`award_response` returns 4xx after approval**: write `award-record.md`
  with `status: failed` and the error envelope. **Do not** populate
  `selected_llo` (Phase 9 stays gated). Surface the error to the human
  and suggest contacting a labs admin if the award call must succeed
  out-of-band.
- **`list_reviews` shows ACE already reviewed all responses**: skip the
  scoring step (we don't re-score), proceed to step 4 from the existing
  reviews.
- **No responses at all**: write `recommendation.md` with `status: no_responses`,
  do not call `award_response`. Suggest extending the deadline (future
  `solicitation-monitor --extend-deadline` skill).

## Output

- `ACE/<opp-name>/runs/<run-id>/8-solicitation-management/solicitation-review_scoring-rubric.md`
- `ACE/<opp-name>/runs/<run-id>/8-solicitation-management/solicitation-review_recommendation.md`
- `ACE/<opp-name>/runs/<run-id>/8-solicitation-management/solicitation-review_award-record.md`
- `phases.solicitation-management.products.selected_llo.*` populated (only on success; per-run only)
- `phases.solicitation-management.products.solicitation.{status: awarded, awarded.*}` populated (only on success; per-run only)

## MCP Tools Used

- `connect-labs`: `list_responses`, `get_response`, `list_reviews`,
  `create_review`, `award_response`, `update_solicitation` (status flip
  to `awarded` — pass `program_id`)
- `ace-gdrive`: `drive_create_file`, `drive_update_file`,
  `drive_read_file`, `drive_list_folder`
