---
name: solicitation-monitor
description: >
  Phase 6 recurring skill. Polls labs for new responses while the
  solicitation is open, writes one file per response to
  ACE/<opp>/runs/<run-id>/6-solicitation-management/solicitation-monitor_responses/, and appends a tick line to the
  observation log. Three modes: --quick (count only), --monitor (full
  pull, default), --close (final pull when deadline passes).
---

# Solicitation Monitor

Recurring skill that runs while `opp.yaml.solicitation.status == open`.
Mirrors the `ocs-chatbot-qa` recurring pattern (`--quick`/`--monitor`).

## Modes

- **`--quick`**: just count responses; do not pull bodies. Cheap.
  Suitable for the orchestrator's recurring tick.
- **`--monitor`** (default): for each new response, pull the body and
  write `solicitation/responses/<response_id>.md`.
- **`--close`**: same as `--monitor` but also flips
  `opp.yaml.solicitation.status` from `open` to `closed`. Run once when
  the deadline passes.

## Inputs

- `opp.yaml.solicitation.solicitation_id`
- `opp.yaml.solicitation.deadline`
- `opp.yaml.program_id` — required for any `list_solicitations` /
  `get_solicitation` call (without scope, labs's `LabsRecord` API filters
  to `is_public=true` only, so the parent record of a private
  solicitation is invisible)
- `ACE/<opp-name>/runs/<run-id>/6-solicitation-management/llo-invite_invitations.md` (optional; for outstanding-
  invitee tracking)

## Process (--monitor)

1. **List responses.** Call:

   ```
   mcp__connect-labs__list_responses(solicitation_id: <id>)
   ```

   `list_responses` is a child query keyed by `solicitation_id` and does
   not require `program_id` scoping. **However**, if this skill ever
   needs to verify the parent record (e.g. `get_solicitation` to refresh
   the deadline or status from labs), the call **must** thread
   `program_id: <opp.yaml.program_id>` (or `organization_id` if program-
   less). Without scope, labs's prod-side filter strips non-public
   records and the parent appears missing — see the 0.13.4 fix note in
   `CHANGELOG.md` and labs PR #156.

2. **Diff against local state.** Read existing files in
   `ACE/<opp-name>/runs/<run-id>/6-solicitation-management/solicitation-monitor_responses/` (each is named
   `<response_id>.md`). For each new response:

   ```
   mcp__connect-labs__get_response(response_id: <id>)
   ```

   Write the body to `solicitation/responses/<response_id>.md`. Body
   includes: response_id, submitted_at, organization, contact, the answers
   to each question in the response template, and any attachments.

3. **Summarize inflow.** Compute:
   - Total responses received
   - Responses received since the last monitor tick
   - Time-to-deadline (delta between `now()` and
     `opp.yaml.solicitation.deadline`)
   - If `solicitation/invitations.md` exists: list of invitees who have
     not yet responded (match by `contact_email` or `organization_slug`).

4. **Append observation.** Append a single line to
   `ACE/<opp-name>/comms-log/observations.md`:

   ```
   <ISO-8601>  solicitation-monitor  <count> total responses (<+N> new since last tick), <H>h to deadline
   ```

5. **Update `opp.yaml`.** If mode is `--close` AND `now() > deadline`, set
   `opp.yaml.solicitation.status: closed`.

## Process (--quick)

Steps 1, 3 (counts only), 4. Skip body pulls and per-response file writes.

## Process (--close)

Same as `--monitor`, plus the status flip in step 5.

## Error handling

Read-only skill from labs's perspective; failures are non-fatal.
On error, log "monitor failed: <reason>" to
`ACE/<opp-name>/comms-log/observations.md` and exit without halting the
orchestrator. The next tick retries.

## Output

- New files in `ACE/<opp-name>/runs/<run-id>/6-solicitation-management/solicitation-monitor_responses/`
- Tick line in `ACE/<opp-name>/comms-log/observations.md`
- (`--close` only) `opp.yaml.solicitation.status: closed`

## MCP Tools Used

- `connect-labs`: `list_responses`, `get_response`
- `ace-gdrive`: `drive_list_folder`, `drive_create_file`, `drive_read_file`,
  `drive_update_file`

## No eval companion

`solicitation-monitor` is read-only and recurring. Quality bar is captured
by `solicitation-review-eval` downstream.
