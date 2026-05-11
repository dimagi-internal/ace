---
name: solicitation-monitor
description: >
  Recurring poll for solicitation responses. Modes: --quick (count
  only) / --monitor (full pull, default) / --close (final pull).
disable-model-invocation: true
---

# Solicitation Monitor

Recurring skill that runs while solicitation status is `open`. Invoked
by cron *outside* `/ace:run`, so it does NOT mint its own run-id.

**Architecture TBD.** Each `/ace:run` is independent — no run reads
from or writes to another run's `run_state.yaml`. The recurring monitor
violates that invariant by definition (it has no run-id of its own).
The right cross-run write semantics for cron-driven monitors will be
designed alongside the Phase 7+/8 redesign (awarding, execution,
closeout). Until then this skill operates in **read-only** mode against
the most recent run's `run_state.yaml` — it pulls responses from labs
and writes them to per-response markdown files in
`ACE/<opp-name>/runs/<most-recent-run-id>/6-solicitation-management/solicitation-monitor_responses/`,
but does NOT mutate `outputs.solicitation.status` (the `--close` mode
is deferred — operators manually flag a closed solicitation at award
time via `solicitation-review`).

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
`run_state.yaml`. Read (no write) from
`phases.solicitation-management.outputs.solicitation`:

- `solicitation_id`
- `deadline`
- `labs_program_id` — labs **integer** program ID cached by
  `solicitation-create`. Required for any `list_solicitations` /
  `get_solicitation` call (without scope, labs's `LabsRecord` API
  filters to `is_public=true` only, so the parent record of a private
  solicitation is invisible). Note: this is **not** the Connect
  program UUID — labs `int()`-parses the field. Also available at
  `opp.yaml.connect.program.labs_int_id` as the durable opp-level
  cache.
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
   `program_id: <labs_program_id>` (read from
   `outputs.solicitation.labs_program_id` or
   `opp.yaml.connect.program.labs_int_id`) or `organization_id` if
   program-less. Without scope, labs's prod-side filter strips
   non-public records and the parent appears missing — see the 0.13.4
   fix note in `CHANGELOG.md` and labs PR #156. Pass the labs
   **integer** id, not the Connect UUID — labs `int()`-parses the
   field server-side.

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
   - Time-to-deadline (delta between `now()` and `deadline` in
     `outputs.solicitation.deadline`)
   - If `solicitation/invitations.md` exists: list of invitees who have
     not yet responded (match by `contact_email` or `organization_slug`).

4. **Append observation.** Append a single line to
   `ACE/<opp-name>/comms-log/observations.md`:

   ```
   <ISO-8601>  solicitation-monitor  <count> total responses (<+N> new since last tick), <H>h to deadline
   ```

5. **`--close` mode is currently a no-op for state.** The cross-run
   write semantics are TBD pending Phase 7+/8 redesign (see top of
   file). For now, `--close` behaves identically to `--monitor` (full
   response pull + tick line) without flipping
   `outputs.solicitation.status`. Operators manually flag a closed
   solicitation at award time via `solicitation-review`, which writes
   `outputs.solicitation.status: awarded` to the current
   `/ace:run` invocation's `run_state.yaml`.

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
- No `run_state.yaml` or `opp.yaml` mutations pending Phase 7+/8 redesign.

## MCP Tools Used

- `connect-labs`: `list_responses`, `get_response`
- `ace-gdrive`: `drive_list_folder`, `drive_create_file`, `drive_read_file`,
  `drive_update_file`

## No eval companion

`solicitation-monitor` is read-only and recurring. Quality bar is captured
by `solicitation-review-eval` downstream.
