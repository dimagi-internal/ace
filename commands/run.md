---
description: Run the full CRISPR-Connect lifecycle for an opportunity
argument-hint: [<opp-name>] [--mode auto|review] [--idea FILE|-] [--ace-web-url URL] [--dry-run] [--sandbox]
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, Agent, AskUserQuestion]
---

# /ace:run

Run the full CRISPR-Connect lifecycle for a Connect opportunity.

## Arguments
- `<opp-name>` — slug for the opp folder in Drive. **Optional.** If omitted,
  default to `smoke-<YYYYMMDD-HHMM>` using the current time.
- `--mode auto|review` — execution mode (default: `review`).
- `--idea FILE|-` — pre-seed `idea.md` from a file path, or `-` for stdin.
  When provided, skip the interactive PDD-picker described below.
  Content is uploaded verbatim to `ACE/<opp-name>/idea.md` via
  `drive_create_file`.
- `--ace-web-url URL` — after the orchestrator completes, invoke the
  `upload-transcript` skill to POST the run's stream-json transcript to
  `<URL>/api/ingest/upload`. **Smart default:** if this flag is omitted
  *and* `ACE_E2E_AUTH_TOKEN` is set in the environment, default to
  `https://labs.connect.dimagi.com/ace`. If the env var is not set,
  skip the upload silently. Explicit `--ace-web-url` always wins
  (including `--ace-web-url ''` to force-disable).
- `--dry-run` — execute all skills but log effectful actions to
  `comms-log/dry-run-<step>.md` instead of performing them. Emails are
  not sent, apps are not published, tickets are not created. LLM-as-Judge
  and gates still apply. State tracks as `dry-run-success` or
  `dry-run-blocked`.
- `--sandbox` — route external API calls to staging endpoints. Connect
  calls go to staging Connect, CommCare calls go to the staging project
  space. Requires staging URLs configured in MCP server settings. Can be
  combined with `--dry-run`.

## Smart-default UX (zero-arg happy path)

The intended minimum invocation is literally `/ace:run` (or
`/ace:run <slug>`). When no `--idea` is provided, the orchestration
procedure discovers a PDD on Drive and prompts the operator to confirm.
See § Starting a New Opportunity in `agents/ace-orchestrator.md` for
the full resolution flow. Short version:

1. Resolve slug (from arg, or auto-generate `smoke-<timestamp>`).
2. Read `ACE_DRIVE_ROOT_FOLDER_ID` from the environment. If unset/empty,
   stop with an actionable error pointing at `op inject` (see
   `agents/ace-orchestrator.md` § Starting a New Opportunity step 2(c).0).
   Do not silently fall through to inline/paste.
3. Locate the PDDs folder under `ACE_DRIVE_ROOT_FOLDER_ID` (matches
   `/PDD/i` or `/Program Design Doc/i`).
4. List files in that folder, sort by slug-stem match then modifiedTime.
5. `AskUserQuestion` with the top ~5 options + "Other: paste Drive doc
   ID" + "Abort". **Confirmation is always shown** — even when exactly
   one file matches — to guard against domain-mismatched PDDs.
6. Fetch the chosen PDD via `drive_read_file`, write it to
   `ACE/<slug>/idea.md`, continue the lifecycle.

## Process

1. Parse arguments. Default mode is `review`. If `<opp-name>` is missing,
   generate `smoke-<YYYYMMDD-HHMM>` using `date +%Y%m%d-%H%M`.

1a. Resolve `--ace-web-url` default:
   - If the flag was explicitly passed (including an empty string),
     use that value (empty string = disable upload).
   - Otherwise, if `$ACE_E2E_AUTH_TOKEN` is non-empty, set
     `--ace-web-url=https://labs.connect.dimagi.com/ace` implicitly and
     tell the operator "defaulting --ace-web-url to labs".
   - Otherwise, leave unset (skip the post-run upload hook).

1b. If `--idea` was provided, read its body:
   - If the value is `-`, read stdin until EOF.
   - Otherwise treat the value as a file path; read its bytes as UTF-8.
   Pass the body through to the orchestrator alongside the slug so the
   "Starting a New Opportunity" flow can skip its PDD-picker.

2. **Execute the orchestration procedure inline at top-level.** Read
   `agents/ace-orchestrator.md` and follow it as a procedure document
   from this (top-level) Claude Code session. Do **not** dispatch
   `Agent(ace-orchestrator)` — the orchestrator is a procedure doc, not
   a subagent (see `CLAUDE.md` § Agent topology). The reason this
   matters: the orchestrator dispatches per-phase agents and (for
   Phase 2) the Nova architect, all of which require the `Agent` tool.
   `Agent` is only available at level 0; running the orchestrator as a
   subagent would put it at level 1 and break every dispatch.

   Inputs to thread through:
   - Slug
   - Execution mode
   - Idea body (if `--idea` was provided)
   - Dry-run flag (if set)
   - Sandbox flag (if set)
   - Any existing state from GDrive (if resuming)

3. After the orchestration procedure completes (all phases run or a
   gate halts the run), if `--ace-web-url` is non-empty (explicit or
   defaulted):
   - Resolve the path of the current stream-json transcript (the `.jsonl`
     file the operator is recording, typically via
     `claude -p --output-format stream-json > <file>`). If the transcript
     path is not available in the run context, log a warning and skip
     the upload — do not fail the overall run.
   - Dispatch the `upload-transcript` skill with:
     - `base_url=<URL>`
     - `transcript_path=<resolved-path>`
     - `opp_slug=<opp-name>` so the uploaded Session is linked under the
       opp in the Workbench's linked-chats panel (strongly recommended
       — without it the transcript is an orphan upload)
     - `opp_run_id=r1` (current single-run convention)
   - Log the returned `session_slug` and the viewable URL
     (`<URL>/chat/<session_slug>`) to the operator's console.

The orchestration procedure handles all phases in step 2.
