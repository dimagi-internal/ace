---
description: Run the full CRISPR-Connect lifecycle for an opportunity
argument-hint: [<opp>[/<run-id>]] [--mode default|review|auto] [--idea FILE|-] [--ace-web-url URL] [--dry-run] [--sandbox] [--no-evals]
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, Agent, AskUserQuestion]
---

# /ace:run

Run the full CRISPR-Connect lifecycle for a Connect opportunity.

- Phase 4 (OCS) and Phase 5 (apps) run **shallow** QA only. Deep
  quality assessment is a separate command — see /ace:qa-deep <opp>.
  Phase 7 activation will refuse to proceed without fresh deep
  verdicts (run /ace:qa-deep before go-live).

## Arguments
- `<opp>` or `<opp>/<run-id>` — **optional positional**.
  - Bare `<opp>` (e.g., `turmeric`): use that opp; create a fresh
    `runs/<run-id>/` folder.
  - `<opp>/<run-id>` (e.g., `turmeric/20260502-1830`): resume that
    specific run by reading its existing `state.yaml`.
  - **Omitted (zero-arg)**: discover the opp whose `inputs/` folder
    has the newest mtime, fresh run there. See
    `agents/ace-orchestrator.md § Starting a New Opportunity` for the
    full discovery flow.
- `--mode default|review|auto` — execution mode (default: `default`).
  - `default` — auto-proceed through internal Phases 1–5 unless a gate
    brief surfaces a `[BLOCKER]` or a hard error occurs. Always pause
    before any action that affects external parties (LLO contact,
    opportunity activation, Jira ticket creation). This is the
    intended day-to-day mode: keep moving until there's a real reason
    to stop or until the next action would touch the outside world.
  - `review` — pause at every one of the 5 gate steps for explicit
    approval. Use for high-touch operations or training.
  - `auto` — never pause for any gate. For unattended batch runs
    (e.g. eval calibration). `[BLOCKER]` concerns still escalate.
- `--idea FILE|-` — pre-seed a free-text `idea.md` from a file path, or `-`
  for stdin. Operator-supplied seed; stands alongside the inputs/
  evidence-pack manifest as supplementary intent. Content is uploaded
  verbatim to `ACE/<opp>/runs/<run-id>/idea.md` via `drive_create_file`.
  Most runs do not need this flag — the inputs/ evidence pack alone is
  sufficient seed material for `idea-to-pdd`.
- `--ace-web-url URL` — after the orchestrator completes, invoke the
  `upload-transcript` skill to POST the run's stream-json transcript to
  `<URL>/api/ingest/upload`. **Smart default:** if this flag is omitted
  *and* `ACE_WEB_PAT_TOKEN` is set in the environment, default to
  `https://labs.connect.dimagi.com/ace`. If the env var is not set,
  skip the upload silently. Explicit `--ace-web-url` always wins
  (including `--ace-web-url ''` to force-disable).

  **Pre-flight gate (when `--ace-web-url` is set explicitly).** Before
  starting Phase 1, verify `ACE_WEB_PAT_TOKEN` is present and
  non-empty in the resolved `.env`. If missing, stop the run with:

  > `--ace-web-url` was set but `ACE_WEB_PAT_TOKEN` is unset in
  > `<resolved-env-path>`. The post-run upload would fail with an
  > authentication error after the full lifecycle had already burned
  > runtime. Mint a per-human PAT via `/ace:ace-web-pat-mint` (one-time
  > per machine, ~30s gh-style browser flow) or drop `--ace-web-url`.

  This is the explicit-flag case only. The smart-default path silently
  skips the upload when the token is missing — it's not user-asked,
  so the run shouldn't error.
- `--dry-run` — execute all skills but log effectful actions to
  `comms-log/dry-run-<step>.md` instead of performing them. Emails are
  not sent, apps are not published, tickets are not created. LLM-as-Judge
  and gates still apply. State tracks as `dry-run-success` or
  `dry-run-blocked`.
- `--sandbox` — route external API calls to staging endpoints. Connect
  calls go to staging Connect, CommCare calls go to the staging project
  space. Requires staging URLs configured in MCP server settings. Can be
  combined with `--dry-run`.
- `--no-evals` — skip per-step `-eval` skill dispatch. Producing skills
  still write their primary artifacts and inline self-evals; only the
  separate `-eval` rubrics (e.g. `idea-to-pdd-eval`,
  `pdd-to-learn-app-eval`, `connect-program-setup-eval`) are bypassed.
  Use for fast smoke iterations; run `/ace:eval --all <opp>` afterward
  to backfill the verdicts. See `agents/ace-orchestrator.md §
  Per-Step Eval Hook` for what this opts out of.

## Smart-default UX (zero-arg happy path)

The intended minimum invocation is literally `/ace:run`. With no args,
the orchestrator picks the most-recently-touched opp (by `inputs/`
mtime under the ACE Drive root) and starts a fresh run on it. No PDD
picker prompt fires — the operator chose what goes in `inputs/`
once, and zero-arg trusts that choice. Anything in `inputs/` becomes
seed material for the PDD; there is no required filename.

Resolution:

1. If `--idea FILE|-` was passed, scripted-seed flow: write the idea
   body to `runs/<run-id>/idea.md` directly (operator free-text seed).
   Manifest capture still runs from `inputs/` if it exists.
2. Else read `ACE_DRIVE_ROOT_FOLDER_ID`. Stop with an actionable error
   if unset.
3. List `ACE/`. Find subfolders containing an `inputs/` subfolder.
4. Pick the candidate with the newest `inputs/` mtime; folder name = `<opp>`.
5. If no candidate exists, stop with the new-layout setup message.
6. Generate `runId` = `YYYYMMDD-HHMM` (collision-suffixed).
7. `mkdir <opp>/runs/<runId>/`; capture
   `runs/<runId>/inputs-manifest.yaml` (frozen pointer-set of every
   direct child file under `inputs/`). No input file is copied — the
   PDD is synthesized at Phase 1 from the manifest.
8. Init `run_state.yaml`; update `opp.yaml.last_run_id`.
9. Begin Phase 1.

See `agents/ace-orchestrator.md` for full detail.

## Process

1. Parse arguments. Default mode is `default`. The positional argument
   may be `<opp>`, `<opp>/<run-id>`, or omitted; pass it through to the
   orchestrator's discovery step (see `agents/ace-orchestrator.md
   § Starting a New Opportunity`). The orchestrator handles slug
   generation and resume-detection — `commands/run.md` does NOT
   pre-generate a slug here.

1a. Resolve `--ace-web-url` default:
   - If the flag was explicitly passed (including an empty string),
     use that value (empty string = disable upload).
   - Otherwise, if `$ACE_WEB_PAT_TOKEN` is non-empty, set
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
   defaulted), dispatch the `upload-transcript` skill with:
     - `base_url=<URL>`
     - `opp_slug=<opp>` so the uploaded Session is linked under the
       opp in the Workbench's linked-chats panel (strongly recommended
       — without it the transcript is an orphan upload)
     - `opp_run_id=<run-id>` (the run-id the orchestrator generated;
       see `agents/ace-orchestrator.md § Starting a New Opportunity` step 3)

   The skill auto-discovers the transcript path under
   `~/.claude/projects/<encoded-cwd>/*.jsonl` (Claude Code writes a
   per-session log there for both interactive and headless runs — same
   discovery `claude --resume` uses). To override, pass an explicit
   `transcript_path=<path>` (e.g. when the operator wrote stream-json
   to a custom file via `claude -p --output-format stream-json > <file>`).
   When the skill finds no transcript at all it returns success with an
   `[INFO]` skip log; the overall run is not failed.

   Log the returned `session_slug` and the viewable URL
   (`<URL>/chat/<session_slug>`) to the operator's console.

The orchestration procedure handles all phases in step 2.
