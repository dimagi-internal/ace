---
name: solicitation-review
description: >
  Phase 6 manual skill. Reads all solicitation responses, scores each
  against the published rubric, presents a recommendation to the human,
  and (after explicit HITL approval) calls award_response and populates
  opp.yaml.selected_llo. The only path that unblocks Phase 7.
---

# Solicitation Review

Manual skill — never runs in default `/ace:run`. Only via:

```
/ace:step solicitation-review --opp <opp-name>
```

This is the only skill that calls `award_response` (irreversible) and the
only skill that populates `opp.yaml.selected_llo` (which gates Phase 7).

## Inputs

- `opp.yaml.solicitation.solicitation_id`
- `opp.yaml.solicitation.public_url`
- `ACE/<opp-name>/solicitation/published.md` (rubric)
- `ACE/<opp-name>/solicitation/responses/*.md` (all responses)

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
   ACE/<opp-name>/solicitation/review/scoring-rubric.md
   ```

   Markdown table per response, with columns: criterion, weight, score
   (0-10), notes.

5. **Write `recommendation.md`.** Save:

   ```
   ACE/<opp-name>/solicitation/review/recommendation.md
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
   ACE/<opp-name>/solicitation/award-record.md
   ```

   Body: `response_id`, `awarded_at`, `awarded_org_slug`,
   `awarded_org_name`, `awarded_contact_email`, `award_amount`. On
   labs-side error: `status: failed` + the error envelope.

9. **Populate `opp.yaml.selected_llo`.** Only on a successful award:

   ```yaml
   selected_llo:
     org_slug: <returned>
     contact_email: <returned>
     source: solicitation
     response_id: <chosen>
   ```

   Also flip `opp.yaml.solicitation.status: awarded` and populate the
   `solicitation.awarded.*` block with full award details.

## Error handling

- **HITL gate timeout / no reply**: do not call `award_response`. Do not
  mutate `opp.yaml`. Exit cleanly so the human can re-run the skill.
- **Human replies `cancel`**: halt; do not write `award-record.md`.
- **`award_response` returns 4xx after approval**: write `award-record.md`
  with `status: failed` and the error envelope. **Do not** populate
  `selected_llo` (Phase 7 stays gated). Surface the error to the human
  and suggest contacting a labs admin if the award call must succeed
  out-of-band.
- **`list_reviews` shows ACE already reviewed all responses**: skip the
  scoring step (we don't re-score), proceed to step 4 from the existing
  reviews.
- **No responses at all**: write `recommendation.md` with `status: no_responses`,
  do not call `award_response`. Suggest extending the deadline (future
  `solicitation-monitor --extend-deadline` skill).

## Output

- `ACE/<opp-name>/solicitation/review/scoring-rubric.md`
- `ACE/<opp-name>/solicitation/review/recommendation.md`
- `ACE/<opp-name>/solicitation/award-record.md`
- `opp.yaml.selected_llo.*` populated (only on success)
- `opp.yaml.solicitation.status: awarded` (only on success)

## MCP Tools Used

- `connect-labs`: `list_responses`, `get_response`, `list_reviews`,
  `create_review`, `award_response`
- `ace-gdrive`: `drive_create_file`, `drive_update_file`,
  `drive_read_file`, `drive_list_folder`
