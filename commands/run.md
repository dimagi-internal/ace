---
description: Run the full ACE lifecycle for an opportunity
argument-hint: [<opp>[/<run-id>]] [--mode default|review|auto] [--ace-web-url URL] [--dry-run] [--sandbox] [--no-evals]
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, Agent, AskUserQuestion]
---

# /ace:run

Run the full ACE lifecycle for a Connect opportunity.

- Phase 5 (OCS) and Phase 6 (apps) run **shallow** QA only. Deep
  quality assessment is a separate command — see /ace:qa-deep <opp>.
  Phase 8 activation will refuse to proceed without fresh deep
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
- `--ace-web-url URL` — on run exit, invoke the `upload-transcript`
  skill to POST the run's stream-json transcript to
  `<URL>/api/ingest/upload`.

  **Uploading is OFF by default and requires an explicit opt-in.** A
  session transcript is the operator's whole working record — every
  command, path, and reply — so shipping it to a shared server is a
  decision the operator makes, never one ACE infers. There are exactly
  two ways to turn it on:

  | Opt-in | Effect |
  |---|---|
  | `--ace-web-url URL` on the invocation | upload to `URL` for this run |
  | `ACE_WEB_UPLOAD_SESSIONS=1` in the resolved `.env` | upload to `--ace-web-url` if given, else `$ACE_WEB_BASE_URL` |

  Neither present → **no upload**, silently. `--ace-web-url ''` forces
  it off even when `ACE_WEB_UPLOAD_SESSIONS=1`.

  **A present `ACE_WEB_PAT_TOKEN` is NOT an opt-in.** This used to be a
  "smart default" — the upload switched itself on whenever the token was
  set. Since `/ace:setup` provisions that token as a matter of course,
  every operator who ran setup was uploading silently. Holding a
  credential is not consent to use it; do not reintroduce this
  (`test/session-upload-opt-in.test.ts` fails if you do).

  **Pre-flight gate (when the upload is opted in).** Before starting
  Phase 1, verify `ACE_WEB_PAT_TOKEN` is present and non-empty in the
  resolved `.env`. If missing, stop the run with:

  > The ace-web transcript upload is enabled (`<which opt-in>`) but
  > `ACE_WEB_PAT_TOKEN` is unset in `<resolved-env-path>`. The upload
  > would fail with an authentication error after the full lifecycle
  > had already burned runtime. Mint a per-human PAT via
  > `/ace:ace-web-pat-mint` (one-time per machine, ~30s gh-style
  > browser flow), or turn the upload off (drop `--ace-web-url` /
  > unset `ACE_WEB_UPLOAD_SESSIONS`).

  Failing fast here is right *because* the upload was asked for. When
  it wasn't opted in there is nothing to check and nothing to warn
  about.
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
**No `--seed-from` / `--only` flags.** Starting mid-pipeline with a frozen
upstream prefix is not a flag — it's **fork-then-resume**: fork a golden run
(the `fork-run` skill / ace-web fork endpoint), which writes a new run whose
`run_state.yaml` already encodes the shape (seed prefix `done`/`verdict:
seeded`, target phases `pending`, gap+tail phases `skipped`), then `/ace:run
<opp>/<new-run-id>` to resume it. The orchestrator's resume path runs the
`pending` phases in order, steps over `skipped`, and ends when no `pending`
phase remains — so "run only 3,4,6 then stop" is structural, no flag
interpretation. The iteration loop (`/ace:iterate`) does this automatically.
The old flags were dropped because the headless runner ignored them
(jjackson/ace#672); see `agents/ace-orchestrator.md § Run shape is structural`
and the `fork-run` skill.

## Smart-default UX (zero-arg happy path)

The intended minimum invocation is literally `/ace:run`. With no args,
the orchestrator picks the most-recently-touched opp (by `inputs/`
mtime under the ACE Drive root) and starts a fresh run on it. No PDD
picker prompt fires — the operator chose what goes in `inputs/`
once, and zero-arg trusts that choice. Anything in `inputs/` becomes
seed material for the PDD; there is no required filename.

Resolution:

1. Read `ACE_DRIVE_ROOT_FOLDER_ID`. Stop with an actionable error
   if unset.
2. List `ACE/`. Find subfolders containing an `inputs/` subfolder.
3. Pick the candidate with the newest `inputs/` mtime; folder name = `<opp>`.
4. If no candidate exists, stop with the new-layout setup message.
5. Generate `runId` = `YYYYMMDD-HHMM` (collision-suffixed).
6. `mkdir <opp>/runs/<runId>/`; capture
   `runs/<runId>/inputs-manifest.yaml` (frozen pointer-set of every
   direct child file under `inputs/`). No input file is copied — the
   PDD is synthesized at Phase 1 from the manifest.
7. Init `run_state.yaml`; update `opp.yaml.last_run_id`.
8. Begin Phase 1.

See `agents/ace-orchestrator.md` for full detail.

## Process

1. Parse arguments. Default mode is `default`. The positional argument
   may be `<opp>`, `<opp>/<run-id>`, or omitted; pass it through to the
   orchestrator's discovery step (see `agents/ace-orchestrator.md
   § Starting a New Opportunity`). The orchestrator handles slug
   generation and resume-detection — `commands/run.md` does NOT
   pre-generate a slug here.

1a. Resolve whether the transcript upload is enabled (default: **no**):
   - If `--ace-web-url` was explicitly passed, use that value — an empty
     string disables the upload and wins over everything below.
   - Otherwise, if `$ACE_WEB_UPLOAD_SESSIONS` is `1`, enable the upload
     against `$ACE_WEB_BASE_URL` and tell the operator: "session upload
     ON via ACE_WEB_UPLOAD_SESSIONS → `<url>`" — so it is never a
     surprise that it happened.
   - Otherwise, **disabled**. Do not consult `ACE_WEB_PAT_TOKEN`; a
     provisioned credential is not an opt-in (see the flag docs above).
     Say nothing — a run that isn't uploading has nothing to report.

2. **Execute the orchestration procedure inline at top-level.** Read
   `agents/ace-orchestrator.md` and follow it as a procedure document
   from this (top-level) Claude Code session. Do **not** dispatch
   `Agent(ace-orchestrator)` — the orchestrator is a procedure doc, not
   a subagent (see `CLAUDE.md` § Agent topology). The reason this
   matters: the orchestrator dispatches per-phase agents and (for
   Phase 3) the Nova architect, all of which require the `Agent` tool.
   `Agent` is only available at level 0; running the orchestrator as a
   subagent would put it at level 1 and break every dispatch.

   Inputs to thread through:
   - Slug
   - Execution mode
   - Dry-run flag (if set)
   - Sandbox flag (if set)
   - Any existing state from GDrive (if resuming)

3. When the upload is enabled (step 1a), dispatch `upload-transcript`
   on **every exit path** — not just a clean finish. Concretely: all
   phases completed, a gate halted the run, a `[BLOCKER]` stopped it, an
   upstream dependency died, an unrecoverable error was hit, *or* you
   are ending the session early to hand off (context budget, a resume
   boundary, the operator saying stop). The runs worth reviewing are
   disproportionately the ones that did not finish; a rule that only
   fires on success collects exactly the wrong sample. If a phase is
   mid-flight, upload anyway and let the partial record stand.

   Dispatch the `upload-transcript` skill with:
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
