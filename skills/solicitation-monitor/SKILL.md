---
name: solicitation-monitor
description: >
  Recurring poll for solicitation responses. Modes: --quick (count
  only) / --monitor (full pull, default) / --close (final pull).
disable-model-invocation: true
---

# Solicitation Monitor

Recurring skill that runs while solicitation status is `open`. Invoked
by cron *outside* `/ace:run`, so it does NOT mint its own run-id —
instead it reads and updates the **most recent run's**
`run_state.yaml.phases.solicitation-management.outputs.solicitation`
per the recurring-writer rule in
`agents/orchestrator-reference.md § Recurring Writers`.

Mirrors the `ocs-chatbot-qa` recurring pattern (`--quick`/`--monitor`).

## Modes

- **`--quick`**: just count responses; do not pull bodies. Cheap.
  Suitable for the orchestrator's recurring tick.
- **`--monitor`** (default): for each new response, pull the body and
  write `solicitation/responses/<response_id>.md`.
- **`--close`**: same as `--monitor` but also flips the
  solicitation status from `open` to `closed`. Run once when the
  deadline passes.

## Inputs

Find the **most recent run-id** under `ACE/<opp-name>/runs/` (sort
descending lexically; run-ids are `YYYYMMDD-HHMM`). Read its
`run_state.yaml`. The relevant block lives at
`phases.solicitation-management.outputs.solicitation`. Read with
fallback to legacy `opp.yaml.solicitation` (pre-PR-b opps):

- `phases.solicitation-management.outputs.solicitation.solicitation_id`
  (legacy: `opp.yaml.solicitation.solicitation_id`)
- `phases.solicitation-management.outputs.solicitation.deadline`
  (legacy: `opp.yaml.solicitation.deadline`)
- `phases.solicitation-management.outputs.solicitation.labs_program_id`
  — labs **integer** program ID cached by `solicitation-create`
  (legacy: `opp.yaml.solicitation.labs_program_id`). Required for any
  `list_solicitations` / `get_solicitation` call (without scope, labs's
  `LabsRecord` API filters to `is_public=true` only, so the parent
  record of a private solicitation is invisible). Note: this is
  **not** the Connect program UUID — labs `int()`-parses the field.
  If the cached value is missing, fall back to the resolution recipe
  in `solicitation-create` step 5 (`labs_context` lookup by program
  name).
- `ACE/<opp-name>/runs/<run-id>/6-solicitation-management/llo-invite_invitations.md`
  (optional; for outstanding-invitee tracking)

## Process (--monitor)

1. **List responses.** Call:

   ```
   mcp__connect-labs__list_responses(solicitation_id: <id>)
   ```

   `list_responses` is a child query keyed by `solicitation_id` and does
   not require `program_id` scoping. **However**, if this skill ever
   needs to verify the parent record (e.g. `get_solicitation` to refresh
   the deadline or status from labs), the call **must** thread
   `program_id: <labs_program_id>` (read from outputs.solicitation;
   legacy fallback opp.yaml.solicitation.labs_program_id) or
   `organization_id` if program-less. Without scope, labs's prod-side
   filter strips non-public records and the parent appears missing —
   see the 0.13.4 fix note in `CHANGELOG.md` and labs PR #156. Pass the
   labs **integer** id, not the Connect UUID — labs `int()`-parses
   the field server-side.

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
   - Time-to-deadline (delta between `now()` and the cached `deadline`
     in `outputs.solicitation.deadline` / fallback
     `opp.yaml.solicitation.deadline`)
   - If `solicitation/invitations.md` exists: list of invitees who have
     not yet responded (match by `contact_email` or `organization_slug`).

4. **Append observation.** Append a single line to
   `ACE/<opp-name>/comms-log/observations.md`:

   ```
   <ISO-8601>  solicitation-monitor  <count> total responses (<+N> new since last tick), <H>h to deadline
   ```

5. **Update state** (mode = `--close` AND `now() > deadline` only).
   Patch the *producing run's* `run_state.yaml` (the most recent run
   identified in § Inputs) via `update_yaml_file` + `merge: 'two-level'`:

   ```yaml
   phases:
     solicitation-management:
       outputs:
         solicitation:
           status: closed
   ```

   The two-level merge replaces `outputs:` wholesale, so the patch
   must carry the **full** `outputs.solicitation` block — read the
   existing block first (via `drive_read_file`), set `status: closed`,
   write back. `update_yaml_file`'s CAS retry handles the race against
   a concurrent `/ace:run` writer.

   **Backward-compat:** also patch legacy
   `opp.yaml.solicitation.status` for opps whose readers haven't
   migrated yet. Strip this fallback in cleanup PR e.

   See `agents/orchestrator-reference.md § Recurring Writers` for the
   canonical rule.

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

- New files in `ACE/<opp-name>/runs/<most-recent-run-id>/6-solicitation-management/solicitation-monitor_responses/`
- Tick line in `ACE/<opp-name>/comms-log/observations.md`
- (`--close` only) `phases.solicitation-management.outputs.solicitation.status: closed` on the most recent run's `run_state.yaml`; backward-compat also `opp.yaml.solicitation.status: closed`.

## MCP Tools Used

- `connect-labs`: `list_responses`, `get_response`
- `ace-gdrive`: `drive_list_folder`, `drive_create_file`, `drive_read_file`,
  `drive_update_file`

## No eval companion

`solicitation-monitor` is read-only and recurring. Quality bar is captured
by `solicitation-review-eval` downstream.
