---
description: Run the full CRISPR-Connect lifecycle for an opportunity
argument-hint: [<opp-name> --mode auto|review] [--idea FILE|-] [--ace-web-url URL] [--dry-run] [--sandbox]
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, Agent, AskUserQuestion]
---

# /ace:run

Run the full CRISPR-Connect lifecycle for a Connect opportunity.

## Arguments
- `<opp-name>` — name of the opportunity (used as the GDrive folder name)
- `--mode auto|review` — execution mode (default: review)
- `--idea FILE|-` — pre-seed `idea.md` from a file path, or `-` for stdin. When provided, skip the interactive `AskUserQuestion` prompt in "Starting a New Opportunity" step 2. Content is uploaded verbatim to `ACE/<opp-name>/idea.md` via `drive_create_file`.
- `--ace-web-url URL` — optional. After the orchestrator completes (success or failure), invoke the `upload-transcript` skill to POST the current session's stream-json transcript to `<URL>/api/ingest/upload`. Requires `ACE_E2E_AUTH_TOKEN` in the environment. No-op if absent. On upload success, logs the resulting chat URL (`<URL>/chat/<session_slug>`) to the operator.
- `--dry-run` — execute all skills but log effectful actions to `comms-log/dry-run-<step>.md` instead of performing them. Emails are not sent, apps are not published, tickets are not created. LLM-as-Judge and gates still apply. State tracks as `dry-run-success` or `dry-run-blocked`.
- `--sandbox` — route external API calls to staging endpoints. Connect calls go to staging Connect, CommCare calls go to the staging project space. Requires staging URLs configured in MCP server settings. Can be combined with `--dry-run`.

## Process

1. Parse arguments. Default mode is `review` if not specified.

1a. If `--idea` was provided, read its body:
   - If the value is `-`, read stdin until EOF.
   - Otherwise treat the value as a file path; read its bytes as UTF-8.
   Pass the body through to the orchestrator alongside the opportunity name so the "Starting a New Opportunity" flow can skip its interactive prompt.

2. Dispatch to the **ace-orchestrator** agent with:
   - Opportunity name
   - Execution mode
   - Idea body (if `--idea` was provided)
   - Dry-run flag (if set)
   - Sandbox flag (if set)
   - Any existing state from GDrive (if resuming)

3. After the orchestrator returns, if `--ace-web-url` was provided:
   - Resolve the path of the current stream-json transcript (the `.jsonl` file the operator is recording, typically via `claude -p --output-format stream-json > <file>`). If the transcript path is not available in the run context, log a warning and skip the upload — do not fail the overall run.
   - Dispatch the `upload-transcript` skill with `base_url=<URL>` and `transcript_path=<resolved-path>`.
   - Log the returned `session_slug` and the viewable URL (`<URL>/chat/<session_slug>`) to the operator's console.

The orchestrator handles all phases in step 2.
