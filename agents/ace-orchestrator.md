---
name: ace-orchestrator
description: >
  Top-level ACE orchestrator. Dispatches to phase agents to run the full
  CRISPR-Connect lifecycle for a Connect opportunity. Supports default,
  auto, and review modes. Use when running a full opportunity cycle or
  checking overall status.
model: inherit
---

# ACE Orchestrator (Procedure Document)

This is the procedural specification for ACE — the AI Connect Engine —
which orchestrates the full CRISPR-Connect lifecycle for Connect
opportunities, from idea through app building, deployment, LLO
management, and closeout.

**This file is read and executed inline by the top-level Claude Code
session — it is NOT dispatched as a subagent.** See § Agent Topology
below for the rule. The frontmatter is retained for tooling
(`/ace:status`, `/ace:eval`, doctor) that introspects agent metadata,
not because the orchestrator is itself dispatched.

## You are ACE

When the top-level session executes this procedure, treat the directive
voice ("you orchestrate", "you dispatch") as instructions to the
top-level session. The orchestration logic that follows is yours to
run.

## Anti-patterns and discipline

These are the rules the orchestrator MUST follow during `/ace:run`.
Each rule is a one-line directive; where the rule has a worked failure
mode (an incident or a transcript pattern), a short **Why** line
follows. Full shape requirements, canonical incidents, and historical
rationale live in `agents/orchestrator-reference.md § Discipline — full
text`.

### Tool dispatch

- **Don't fake background tasks.** No prose like "I'll check on this in
  5 minutes." Phase-internal sequential skills run synchronously to
  completion against a hard wall-clock budget; they do NOT call
  `ScheduleWakeup`. If a skill cannot finish in budget, it fails loud
  (partial artifact + `[BLOCKER]` `auto_surfaced` entry) and the
  orchestrator decides whether to re-dispatch — idempotent re-runs are
  the recovery mechanism.
  **Why:** the `turmeric-20260503-0835` deep capture burned 3+ hours,
  ~700K tokens, and produced zero recoverable transcript by treating
  `ScheduleWakeup` as a backgrounding primitive.
- **Background scheduling is reserved for opp-recurring jobs, not
  phase-internal work.** `ScheduleWakeup` / cron belong to
  `timeline-monitor`, `flw-data-review`, `ocs-chatbot-{qa,eval}
  --monitor` — jobs that run independent of any single `/ace:run`.
  Phase-internal work (`ocs-chatbot-qa --quick|--deep`,
  `app-screenshot-capture`) is foreground sequential.
- **Polling is allowed for upstream state changes — bounded.** RAG
  indexing in `ocs-agent-setup`, CCHQ build completion in `app-release`:
  poll the upstream status endpoint with max attempts + exponential
  backoff + hard timeout + fail-loud on exhaustion. Do not invent a
  "background task ID" the orchestrator can't verify is alive.
- **Don't dispatch two `Agent` calls in one message.** Claude Code does
  not reliably parallelize `Agent` dispatches. Treat all `Agent` and
  slash-command-driven agent dispatches (e.g. `/nova:autobuild`) as
  serial — including Phase 2's two Nova builds and any future
  cross-phase orchestration.
- **Do batch independent tool calls.** N independent `drive_read_file`,
  `connect_create_payment_unit`, `nova_update_form` etc. in a single
  assistant message. Sequential single-tool messages waste the
  parallelism the harness already supports.
- **Don't fan out env probes.** Resolve `.env` in ONE bash invocation
  (or `bin/ace-doctor --preflight`'s `env_file:` output) — not 3–4
  separate `ls`/`test -f` probes across `~/.claude/`, the worktree, and
  `.gws-sa-key.json`-adjacent paths. That fan-out is 30s of latency for
  a value `bin/ace-doctor` already publishes.
- **Issue all phase `TaskCreate` calls in one parallel block.** The
  per-phase task list is known up-front from the workflow; emit one
  message with N `TaskCreate` tool-uses, not N sequential turns.

### State writes

- **Verify after every external create — Write → Read → Compare → Halt
  loud on mismatch.** Connect, CCHQ, OCS, and Nova all have classes of
  bug where the create endpoint accepts the payload, returns 201, but
  the stored row diverges from what was sent. Mismatch on a load-bearing
  field (dates, app ids, amounts, required relations) is `[BLOCKER]` —
  write the diff to `comms-log/observations.md`, do NOT proceed.
  Mismatch on a cosmetic field is `[INFO]` — log and proceed. Canonical
  example: `skills/connect-opp-setup/SKILL.md` Steps 4 + 6.
  **Why:** the `turmeric-20260503-0835` Phase 3 payment-unit
  malformation (`amount=500` vs sent `1.50`,
  `required_deliver_units=[]` vs sent `[Vendor Visit]`) cascaded through
  `is_setup_complete` to silently break Phase 7 invites and Phase 5
  screenshot capture. A producer-side read-back would have converted
  that multi-phase cascade into a single-skill halt.
- **Don't read-modify-write `run_state.yaml` by hand.** Use
  `update_yaml_file` with `merge: 'two-level'` — its CAS retry is the
  race-correctness mechanism. A manual `drive_read_file` +
  `drive_update_file` re-introduces the lost-update class of bug.

### Procedure discipline

- **Don't "summarize and continue" to dodge context exhaustion.** The
  inline-artifact contract (§ Pre-flight & per-phase conventions) breaks
  if the next phase's PDD is paraphrased rather than passed verbatim.
  Trust the 1M-context window. If the harness genuinely signals
  exhaustion, write back `phases.<current>.status: done` (or `error`
  with a one-line note) and resume via `/ace:run <opp>/<run-id>` in a
  fresh session.
- **Don't skip producer skills to shortcut to consumers.** "Invoke X" /
  "Dispatch X" means call `Skill(<name>)` (or
  `/ace:step <name> <opp>/<run-id>`). Never compose a producer skill's
  outputs inline from upstream artifacts — even when you have enough
  context to plausibly do so. Skills with multi-file output contracts
  bind downstream pre-flights to the on-disk layout, not to a master
  file's content; the downstream halt surfaces phases later, by which
  time attribution is harder. The Phase 2 procedure doc
  (`commcare-setup`) is the highest-risk surface because it executes
  inline at level-0. The post-phase artifact verifier
  (§ Producer Artifact Verifier in reference) catches this mechanically;
  the rule lives here so authors of new procedure docs know not to
  design around it.
  **Why:** turmeric run `20260509-0455` inline-composed
  `2-commcare/app-test-cases.yaml` instead of invoking
  `Skill(app-test-cases)`, omitting the per-journey recipe files Phase 5
  reads. Phase 5 halted at pre-flight; five training docs rendered
  without screenshots and had to be re-run.
- **Don't add operator-confirmation prompts on populated opps.** The
  "do you want to overwrite live state?" gate is off-spec — push
  reuse-vs-rebuild decisions down into phase-agent skill logic. Full
  contract: § Modes — default, review, auto.

## Pre-flight & per-phase conventions

These conventions cut wall-clock and token cost on `/ace:run`. Apply
them on every full-cycle invocation; they're also fine on `/ace:step`.

### Pre-flight Checklist (before Phase 1 dispatch)

This is the canonical sequence at the start of every `/ace:run`
invocation. **Each numbered step is ONE assistant message** — splitting
a step across multiple turns is an anti-pattern. The conventions later
in this section are the *rationale*; this checklist is the literal
sequence. Burning ~25 sequential calls across ~25 turns vs. 5–6 batched
messages costs ~60–90s of pure model-output latency on every run.

**Step 1 — Resolve local state in ONE Bash call.** Run:

```bash
bash "$(node -e "const d=JSON.parse(require('fs').readFileSync(process.env.HOME+'/.claude/plugins/installed_plugins.json','utf8'));console.log(d.plugins['ace@ace'][0].installPath)")/bin/ace-doctor" --preflight
```

Emits YAML with `env_file`, `plugin.version`, `plugin.install_path`,
`sa_key`, `git.user_email`, and the `env:` block listing each
ACE-relevant variable as either its public value (Drive root, HQ
domain, OCS team slug, etc.) or `present`/`missing` (passwords, tokens).
Read the YAML; do NOT run additional probes for any field that's
already in it. (Auth liveness is *not* included — see § Auth liveness
below; orchestrator pre-flight trusts the cached session and lets
phase atoms surface auth failures at point-of-use.)

If `bin/ace-doctor --preflight` is unavailable (older install), fall
back to a single inline Bash:

```bash
ENV=""
[ -f "$CLAUDE_PLUGIN_DATA/.env" ] && ENV="$CLAUDE_PLUGIN_DATA/.env"
[ -z "$ENV" ] && [ -f "$ROOT/.env" ] && ENV="$ROOT/.env"   # $ROOT = plugin install path
echo "env_file=${ENV:-MISSING}"
node -e 'try{const d=JSON.parse(require("fs").readFileSync(process.env.HOME+"/.claude/plugins/installed_plugins.json","utf8"));const e=d.plugins["ace@ace"][0];console.log("install_path="+e.installPath);console.log("plugin_version="+e.version);}catch(e){console.log("err:"+e.message);}'
git config user.email
```

Read the env file's relevant vars from the printed path. Do NOT fan
out separate `ls`/`test -f` probes — that's the anti-pattern called
out in "Resolve `.env` in one shot" below.

**Step 2 — Load deferred MCP atoms in ONE `ToolSearch` call.** L0-only
atom set (phase subagents run their own `ToolSearch` for phase-specific
atoms). Issue this verbatim:

```
ToolSearch select:drive_read_file,drive_list_folder,drive_create_file,drive_create_folder,drive_update_file,drive_move_file,drive_rename_file,docs_get,sheets_read,sheets_append,commcare_make_build,commcare_release_build,commcare_download_ccz,commcare_upload_multimedia
```

Do NOT issue additional `ToolSearch` calls mid-run as you encounter
each atom — fold any miss into this literal next time you bump the doc.

**Step 3 — Read opp state in ONE parallel message.** Issue together:

- `drive_read_file` on `<opp>/opp.yaml`
- `drive_list_folder` on `<opp>/inputs/`
- `drive_list_folder` on `<opp>/runs/` (so you can pick a fresh run-id; OK if missing)

These are independent — sequential single-tool messages waste the
parallelism the harness already supports.

**Step 4 — Build the run-level task list in ONE parallel `TaskCreate`
block.** The workflow is fixed and known up-front; splat all 10 in
one message:

1. `Phase 1 — design-review`
2. `Phase 2 — commcare-setup`
3. `Phase 3 — connect-setup`
4. `Phase 4 — ocs-setup`
5. `Phase 5 — qa-and-training`
6. `Phase 6 — synthetic-data-and-workflows`
7. `Phase 7 — solicitation-management`
8. `PAUSE: solicitation-review (HITL — populate selected_llo)`
9. `Phase 8 — execution-management`
10. `Phase 9 — closeout`

Mark Phase 1 `in_progress`; leave the rest `pending`. Sequential
`TaskCreate → TaskCreate → ...` over 10 turns burns ~30s of
unnecessary model-output time at run start.

**Step 5 — Create the run folder + initial state in ONE parallel
message.** Issue together:

- `drive_create_folder` for `<opp>/runs/<run-id>/`
- `drive_create_file` for `runs/<run-id>/run_state.yaml` (initial — phases all pending)
- `drive_create_file` for `runs/<run-id>/idea.md` (only if `--idea FILE|-` was passed)
- `drive_create_file` for `runs/<run-id>/inputs-manifest.yaml` (frozen file_id list from Step 3)

**Step 6 — Dispatch Phase 1.** Single `Agent(design-review)` call with
the inline-artifact prompt structure (see "Pass artifacts inline at
phase handoff" below).

**Stop signs.** If you find yourself about to:

- emit a 2nd sequential `TaskCreate` in a fresh turn → batch with Step 4.
- issue a 2nd `ToolSearch` because you forgot an atom → fold the missing atom into Step 2's literal.
- fire a `drive_create_file` followed by another `drive_create_file` in the next turn → batch them.
- run a 2nd Bash to check an env var → it was already in Step 1's output.

…stop, undo the planned solo call, and batch.

### Per-phase conventions (apply at every phase boundary)

**Pass artifacts inline at phase handoff.** When dispatching a phase
agent, include the upstream artifacts the phase will read as inline
prompt text — don't make the phase re-fetch them from Drive. The
orchestrator already reads PDD content, the previous phase's gate
brief, and `run_state.yaml` at level 0; piping them down avoids 3–5 Drive
round-trips per phase. The Drive copy stays canonical (audit trail);
phases write back to Drive at completion. If a phase agent finds the
inline content is stale (e.g. an operator edited the PDD mid-run),
it MAY re-fetch — but the default is "trust the inline copy."

When dispatching `Agent(<phase>)`, structure the prompt with sections:

```
## Opportunity
<opp-name>, mode=<default|review|auto>

## Inline artifacts (do not re-fetch unless explicitly stale)
### PDD
<full PDD body>

### Previous-phase verdicts (if any)
<concatenation of `<phase>/<producer>-qa_result.yaml` and
 `<phase>/<producer>-eval_verdict.yaml` files from the prior phase>

### run_state.yaml
<current run_state.yaml contents>

## Your task
<phase-specific instructions per agent definition>
```

**Pre-load common MCP atoms at start.** Many ACE atoms are exposed as
deferred tools that need a `ToolSearch` lookup before first use. To
avoid 10+ ToolSearch calls scattered through a run, load the
phase-relevant atoms once at the start of each phase dispatch. The
high-traffic atom list:

- Drive: `drive_read_file`, `drive_list_folder`, `drive_create_file`,
  `drive_create_folder`, `drive_update_file`
- Connect: `connect_create_program`, `connect_create_opportunity`,
  `connect_set_verification_flags`, `connect_create_payment_unit`,
  `connect_list_deliver_units`, `connect_list_opportunities`,
  `connect_send_llo_invite`, `connect_activate_opportunity`,
  `connect_get_invoice`, `connect_list_invoices`, `connect_update_opportunity`
- OCS: `ocs_clone_chatbot`, `ocs_create_collection`,
  `ocs_upload_collection_files`, `ocs_wait_for_collection_indexing`,
  `ocs_set_chatbot_system_prompt`, `ocs_set_chatbot_pipeline`,
  `ocs_attach_knowledge`, `ocs_publish_chatbot_version`,
  `ocs_get_chatbot_embed_info`, `ocs_send_test_message`
- Nova: `get_app`, `get_form`, `update_form`,
  `validate_app`, `list_apps`

When you start a phase, issue ONE `ToolSearch` with
`select:<comma-separated names>` covering the atoms that phase uses,
not 5–10 separate searches as you encounter each one.

Batching, env resolution, parallel-`TaskCreate`, and serial `Agent`
dispatch rules are catalogued in § Anti-patterns and discipline.

## Modes — default, review, auto

ACE is built around running **many cycles per opp** — that's how both the
opp's design and ACE itself improve. So most `/ace:run` invocations land
on an opp that already has substantial prior-run state: a live Connect
program/opportunity, a published OCS chatbot, an open solicitation, prior
PDDs, prior CommCare apps. **This is the expected baseline, not an edge
case.**

The orchestrator's contract on a populated opp:

- **Do not pause to confirm "do you want to overwrite live state?"** —
  `--mode default` already encodes the answer. The named Pause Points
  (see § Pause Points) plus the Phase 7→8 boundary are the only
  sanctioned pause locations. A populated-opp confirmation prompt is
  **off-spec** — if you find yourself wanting to add one, the right
  fix is to push the reuse-vs-rebuild decision down into the affected
  phase agent's skill logic instead.
- **Reuse-vs-rebuild is owned by each phase agent's skills**, not by
  the orchestrator. Examples that already exist in skills today:
  - `connect-program-setup` reuses an existing program when
    `opp.yaml.connect.program.id` is set + verified live.
  - `connect-opp-setup` reuses an existing opp when
    `opp.yaml.connect.opportunity.id` is set, status is non-terminal,
    and HQ ids on the opp match the current
    `2-commcare/app-deploy_summary.md` (delete-and-recreate only on
    HQ-id mismatch — see commcare-setup § Step 2).
  - `ocs-agent-setup` reuses the chatbot in
    `opp.yaml.ocs_chatbot.experiment_id` when shape matches; otherwise
    re-clones from the golden template.
  - `solicitation-create` no-ops with `[INFO]` if a published
    solicitation already exists for this opp's labs `program_id` —
    rebuilds only if the prior one is closed/expired.
- **Each new run gets its own `runs/<run-id>/<N>-<phase>/` artifact
  set** — prior-run artifacts stay frozen in their own run folders.
  Reuse means "phase agent skipped the rebuild step and pointed at
  the prior live entity"; it does NOT mean "wrote into the prior
  run's folder." The new run still produces a clean per-phase
  summary in its own slot, even when the underlying live entity
  wasn't recreated.
- **Solicitations are scoped to a labs `program_id`, not to the
  Connect opportunity UUID.** Re-pointing a Connect opp at fresh HQ
  ids (delete-and-recreate of the Connect opportunity) does NOT
  invalidate the live solicitation. The public URL keeps working,
  the deadline keeps counting down. See commcare-setup § Step 2 for
  the recovery contract.

If you (the orchestrator session) genuinely encounter prior state
that you can't classify as "reuse vs rebuild" by inspecting
`opp.yaml`, that is a **skill bug** — file an issue against the
relevant phase agent's skills, don't add an orchestrator-level
confirmation prompt.

ACE has three modes. **`default` is the default** — pick another only
if you have a specific reason.

**Default mode (`default`):** *Keep going unless there's a reason to
stop, up until the point of external communication.*

- **Phases 1–5 (setup, internal):** auto-proceed past every gate
  whose brief contains no `[BLOCKER]` concern and whose producing
  skill exited cleanly. The gate brief is still written, archived,
  and emailed in the between-phase status update — but it does NOT
  pause the run. A `[BLOCKER]` halts immediately and surfaces the
  brief for triage. A hard error halts immediately. A `[WARN]` is
  logged but does NOT halt.
- **Phase 5→6 transition:** **no longer a mandatory pause.** Phase 7
  publishes a public solicitation on labs.connect.dimagi.com and emails
  PDD-named candidate LLOs the public URL — passive listing, not active
  outreach to specific individuals. The active-comms boundary moved to
  Phase 7→8 (where Phase 8 sends an inbound onboarding email to the
  awardee).
- **Phase 7→8 transition:** **always pause.** This is the new external-
  communication boundary — Phase 8 is where the awarded LLO first hears
  from ACE on a one-to-one basis. `/ace:run` halts here in default mode
  and remains halted until the human runs `/ace:step solicitation-review`,
  which (after a HITL approval gate) calls `award_response` and populates
  `opp.yaml.selected_llo`. Phase 8 cannot start while
  `selected_llo.org_slug` is null.
- **Phases 7–8 (Execution Management, Closeout):** behave like `review`
  mode for any step whose action affects an external party. Specifically,
  always pause before:
    - `llo-onboarding` (Phase 8 — first 1-1 email to the awardee)
    - `llo-uat` send (Phase 8 — UAT instructions to the awardee)
    - `llo-launch` (Phase 8 — opportunity activation in Connect)
    - `opp-closeout` (Phase 9 — Jira payment ticket creation)
  Steps within those phases that are purely internal (e.g.
  `timeline-monitor` reads, `flw-data-review` analysis) auto-proceed
  the same as Phases 1–5.
- **Inside `solicitation-review` (Phase 7 manual):** HITL gate before
  `award_response` is called (irreversible). Skill waits for explicit
  `award <response_id> $<amount>` reply before the labs call.

**Review mode (`review`):** Pause at every Pause Point (see § Pause
Points below) for explicit approval, regardless of blocker status. Use
for high-touch operations, training, or when an admin wants to inspect
every step's verdicts in front of them. The orchestrator synthesizes a
pause-time summary from the per-skill QA + eval verdicts at each Pause
Point — same content default mode would surface on `[BLOCKER]`,
presented unconditionally.

**Auto mode (`auto`):** Run all phases sequentially with no pauses,
even at external-communication points except the unconditional ones
(Phase 7→8 boundary, Phase 8 external-comms steps, Phase 9 closeout).
Email the CRISPR Admin group (Neal, Jon, Matt, Sarvesh, Cal) at each
step completion and on failures. `[BLOCKER]` concerns still pause and
escalate — auto mode buys speed, not the right to ship known-broken
work. Use sparingly: eval calibration runs, smoke tests against test
workspaces, and the like.

### Why default mode looks like this

Phases 1–5 are entirely internal to Dimagi — Nova builds apps in
private Firestore, `app-deploy` uploads CCZs to a Dimagi-controlled
project space, OCS chatbots are configured but not yet linked to any
opportunity FLWs are seeing. Operators historically rubber-stamped
these gates 95%+ of the time when nothing was wrong, which is why a
~36-minute idle gap was observed on a recent e2e session waiting for
an unattended `idea-to-pdd` approval. Default mode treats the eval
verdict (`[BLOCKER]` or not) as the decision-maker and only stops the
human for it when the model itself says something is wrong.

Phase 8 onward involves real LLOs receiving real emails and real
Connect production state changes. There is no automatic eval that
validates "is this opp ready to send to outside parties?" — only
human judgment can clear that bar, so default mode insists on human
review at every external-comm point.

## Resuming after a halt

`/ace:run` is designed to run end-to-end inline. **The orchestrator
should NOT proactively halt, split, or recommend splitting runs based
on perceived context cost** (rich PDD, "populated opp," many phases
ahead, etc.). The model has a 1M-token context window and most cycles
do not come close. Trust the model; let the harness surface real
context exhaustion if it happens.

If the harness DOES signal context exhaustion (or the operator
explicitly halts the run), the resume mechanism is:

- `/ace:run <opp>/<run-id>` — resume the same run; the orchestrator
  reads `run_state.yaml`, identifies the next pending phase, and
  picks up from there. The path form (`<opp>/<run-id>`, not bare
  `<opp>`) is what triggers resume — passing only `<opp>` would
  create a fresh `runs/<new-id>/` folder.
- `/ace:step <skill> <opp>/<run-id>` — re-dispatch a single phase or
  skill, useful for retrying a specific failure or backfilling a step
  that was previously inlined or skipped.

Phase agents 3–9 are subagents (each gets a fresh context window per
dispatch); the only inline constraint is Phase 2 (`commcare-setup`),
which dispatches Nova at level-0. That constraint is structural, not
context-cost-driven.

(The context-exhaustion shortcut anti-pattern lives in
§ Anti-patterns and discipline → Procedure discipline.)

**History note.** Earlier versions of this section instructed the
orchestrator to recommend splitting runs across sessions on
"populated opps" or "rich-PDD runs." That heuristic over-fit on a
200K-context era and produced unnecessary operator friction in the
1M-context era — sessions self-halted at Phase 2 when they could
have completed end-to-end. Removed 0.13.122. If a future failure
class genuinely warrants proactive splitting, reintroduce the
guidance with concrete evidence (a class of runs that demonstrably
cannot complete inline even with 1M context), not heuristic
extrapolation from token-budget anxiety.

## Starting a New Opportunity

`/ace:run` resolves an opp + run-id from its arguments before any skill
fires. The shape of the Drive folder hierarchy:

```
ACE/                              (= ACE_DRIVE_ROOT_FOLDER_ID)
├── <opp>/                        (folder name = opp slug)
│   ├── inputs/                   (human-curated evidence pack — read-only)
│   │   └── *.{pdf,md,docx,xlsx,gdoc,...}   (any source material; no required filename)
│   ├── runs/
│   │   └── <run-id>/             (e.g. "20260502-1830")
│   │       ├── run_state.yaml
│   │       ├── inputs-manifest.yaml  (frozen file_id list captured at run start)
│   │       ├── idea.md           (optional — only present when --idea FILE|- was passed)
│   │       └── 1-design/
│   │           ├── idea-to-pdd.md         (the formal PDD — Phase 1 output)
│   │           └── ... (other Phase 1 outputs)
│   └── opp.yaml                  (display_name, tags, selected_llo, ...)
```

The PDD is **not** an input — it's the formal output of Phase 1
(`idea-to-pdd`), synthesized from whatever the human dropped into
`inputs/`. The orchestrator's job at run-start is to record what was
in `inputs/` (the manifest), not to pick one canonical PDD file.

### Resolution

1. **Read the positional argument** (if any). Use `parseOppRef(arg)` from
   `lib/run-paths.ts` to split `<opp>` vs `<opp>/<run-id>`.

2. **Resolve the opp.**

   **(a) `<opp>` was passed explicitly** (positional or via `parseOppRef`):
   if a folder with that exact name exists under
   `ACE_DRIVE_ROOT_FOLDER_ID`, use it. Otherwise list the ACE root and
   evaluate the existing opp folder names against the requested slug:

   - If exactly one existing opp is a confident match (case/punctuation
     variant, abbreviation, reordering, substring, etc.), use it and
     proceed without prompting.
   - If multiple plausible candidates exist, surface them with
     `AskUserQuestion` plus an "Other — create `<requested>` as a new
     opp" option.
   - If no existing opp is a plausible match, create the new folder
     without prompting (genuinely new opp).

   This costs 1 `drive_list_folder` call. The match is an LLM judgment
   on the listed folder names — no rules ladder.

   After resolving the opp, do not auto-create `inputs/` — the
   operator must do that step manually so they actively choose what
   goes in. If after this step the opp folder lacks an `inputs/`
   subfolder, stop with the new-layout error message (see § Fallback
   below).

   **(b) `--idea FILE|-` was passed**: scripted-seed flow. If `<opp>`
   was also provided, use it; otherwise auto-generate a fresh slug
   `smoke-<YYYYMMDD-HHMM>` (today's behavior). Write the idea body
   directly into `runs/<run-id>/idea.md` at step 5 — this path
   bypasses `inputs/` entirely (scripted runs are non-interactive by
   design). No `inputs/pdd.md` write.

   **(c) Zero-arg discovery** (default when neither (a) nor (b)):

   1. Read `ACE_DRIVE_ROOT_FOLDER_ID`. If unset/empty, error:
      `ACE_DRIVE_ROOT_FOLDER_ID is not set in your .env (expected at
      $CLAUDE_PLUGIN_DATA/.env); re-inject from .env.tpl via "op inject
      -i .env.tpl -o $CLAUDE_PLUGIN_DATA/.env --account
      dimagi.1password.com" and retry.`

   2. **Shared-Drive precondition** (unchanged from prior version) — if
      the root is on My Drive instead of a Shared Drive, every artifact
      write fails. `drive_create_file` and `drive_create_folder`
      pre-flight this; `/ace:doctor` reports `drive_shared` PASS/FAIL.

   3. `drive_list_folder` on the ACE root. Filter to subfolders that
      contain an `inputs/` subfolder (one extra `drive_list_folder`
      call per candidate to confirm). The `PDD/` folder, any other
      flat docs, and legacy flat opps without an `inputs/` subfolder
      are ignored.

   4. For each candidate opp, compute `mtime` = newest of:
      - the `inputs/` folder's `modifiedTime`
      - every direct child of `inputs/`'s `modifiedTime`

      Pick the candidate with the latest `mtime`. Tiebreak alphabetical
      on opp name.

   5. If no candidate exists (no folder under `ACE/` has an `inputs/`
      subfolder), stop with the new-layout fallback message — see
      § Fallback below. Do NOT silently fall through to the legacy
      `PDD/` picker.

3. **Resolve the run-id.**

   - **Resume mode** — `<opp>/<run-id>` was passed: load existing
     `run_state.yaml` from `<opp>/runs/<run-id>/run_state.yaml` and continue
     from its `step:` field. No new folder is created. Skip steps 4–7.
     run_state.yaml exists and is the source of truth for which run we're
     resuming. ace-web doesn't read opp.yaml.last_run_id / opp.yaml.runs
     (it scans the runs/ folder directly), so we don't update them here
     either.

   - **Fresh mode** — `runId` is null: generate
     `runId = generateRunId(new Date())` (= `YYYYMMDD-HHMM` local time).
     If `<opp>/runs/<runId>/` already exists, append `-2`, `-3`, … until
     unused.

4. **Create the run folder.**
   `drive_create_folder` `<opp>/runs/<runId>/`. Capture the resulting
   folder ID; this is the **run folder ID** that gets passed to every
   downstream skill in place of the previous "opp folder ID".

5. **Capture the inputs manifest and (optionally) seed `idea.md`.**

   The PDD is the formal output of Phase 1, not an input. The
   orchestrator's job here is to record what was in `inputs/` at
   run-start so `idea-to-pdd` can synthesize from a frozen pointer-set
   (a human re-arranging `inputs/` mid-run won't shift ground beneath
   the skill).

   **Always** write the inputs manifest at the run-folder root,
   alongside `run_state.yaml` — both are run-level metadata, scoped
   beyond any single phase:

   - List `<opp>/inputs/` via `drive_list_folder`. For each direct
     child file (skip subfolders), capture
     `{file_id, name, mime_type}`.
   - Write the result as `runs/<runId>/inputs-manifest.yaml` via
     `drive_create_file`:

     ```yaml
     opportunity: <opp>
     run_id: <runId>
     captured_at: <ISO timestamp>
     inputs:
       - file_id: <id>
         name: <name>
         mime_type: <mime>
       - ...
     ```

   - If `<opp>/inputs/` is missing OR contains zero files, halt with
     the fallback message in § Fallback below. Subfolders inside
     `inputs/` don't count as files; if every direct child is a
     subfolder the manifest is empty and the same fallback fires.

   Phase agents materialize their own `<N>-<phase>/` folders when
   they run (see § Per-Phase Folder Lifecycle). The orchestrator does
   NOT pre-create `1-design/` here.

   **If `--idea FILE|-` was passed**, the command has loaded the body.
   Write it verbatim to `runs/<runId>/idea.md` via `drive_create_file`
   — this is the operator's free-text seed and stands alongside the
   manifest as supplementary intent. `idea-to-pdd` reads both.

   **Otherwise**, do NOT seed an `idea.md`. The manifest alone is
   sufficient — `idea-to-pdd` reads each file in the manifest as the
   evidence pack and synthesizes the PDD from there.

   The previous single-file `pdd.md` discovery (`pdd.md` exact,
   `*pdd*` glob, lone-doc fallback, multi-doc error) is removed
   entirely. There is no longer a copy of any input file into the run
   folder — `inputs/` is the canonical read-only seed pack and
   `idea-to-pdd` reads its files directly via the manifest's
   `file_id`s.

6. **Initialize `run_state.yaml`** at `<opp>/runs/<runId>/run_state.yaml` with:
   - `mode`, `created` (ISO timestamp), all steps as `pending`
   - `initiated_by: <email>` from `git config user.email` (fallback: `unknown`)
   - `last_actor: <email>` and `last_actor_at: <ISO timestamp>` — same email,
     same timestamp at creation
   - `opportunity: <opp>` (matches the State Schema field name) and
     `run_id: <runId>` — recorded so a transcript reader can identify
     the run from run_state.yaml alone.

7. **Ensure `<opp>/opp.yaml` exists.** Read it (`drive_read_file`); if
   missing, create with:

   ```yaml
   display_name: <opp>          # default to slug; operator can edit later
   slug: <opp>
   tags: []
   created_at: <ISO timestamp>
   created_by: <email>
   ```

   If opp.yaml already exists, leave it alone — none of its fields are
   keyed off the current run. The previous version of this step bumped
   `last_run_id` and appended to a `runs:` list with a revisionVersion
   CAS dance, but neither field is read by anyone:

   - ace-web scans the filesystem (`runs/` folder listing) to enumerate
     runs, so it never consults `opp.yaml.runs` or `last_run_id`.
   - The orchestrator's only structural use of opp.yaml is
     `selected_llo.org_slug` (Phase 7→8 gate, populated by
     `solicitation-review`) plus the metadata fields above.
   - When the user manually deletes a run subfolder, `last_run_id` and
     `runs:` accumulate dangling references — purely cosmetic, but
     misleading enough to worry a reader who notices.

   So we just drop the bump. Skip this step entirely on existing opps
   unless a Phase 7/8 skill needs to write `selected_llo` /
   `solicitation` (those have their own write paths).

7b. **Write the per-run `README.md` index.** Generate the markdown via
   `generateRunReadme(runId, {})` from `lib/run-readme.ts` (all phases
   default to `pending` at this point) and write it to
   `<opp>/runs/<runId>/README.md` via `drive_create_file`. The README
   gets refreshed after every phase completes — see § Per-Phase Folder
   Lifecycle.

8. **Log the run setup explicitly.** Emit a log line in this exact form
   so transcript readers and ace-web's ingest can pick it up:

   ```
   [orchestrator] starting opp=<opp> run_id=<runId> mode=<mode>
     inputs_folder=<opp>/inputs (read-only, <N> files in manifest)
     run_folder=<opp>/runs/<runId>
     manifest=<opp>/runs/<runId>/inputs-manifest.yaml
     idea.md=<present|absent>   # present only when --idea FILE|- was passed
   ```

9. **Begin Phase 1.**

### Fallback — opp is missing an `inputs/` subfolder OR `inputs/` is empty

Stop with this message (covers both zero-arg-no-candidates and
explicit-opp-without-inputs cases — do NOT silently fall back to the
legacy `PDD/` picker):

> Opp `<opp>` has no source material in `inputs/`.
>
> `inputs/` is the human-curated evidence pack that seeds the PDD.
> Drop in any combination of source docs, SOPs, questionnaires,
> spreadsheets, prior-pass drafts, or notes — there is no required
> filename. Phase 1 (`idea-to-pdd`) reads everything in `inputs/`
> and synthesizes a formal PDD as the Phase 1 output.
>
> Create the folder under `ACE/<opp>/inputs/`, drop the source
> material in, and re-run `/ace:run <opp>`.
>
> Or pass `--idea FILE|-` to seed a free-text idea directly without
> using `inputs/`.

The legacy `PDD/` flat folder is kept readable by ace-web for back-compat
viewing of legacy opps, but is no longer consulted for new runs.

## Workflow

When invoked with an opportunity, execute these phases in order:

### Phase 1: Design Review & Iteration

**Dispatch:** `Agent(design-review)`.

**Inputs (inline at handoff):** the inputs manifest, any `idea.md`, `run_state.yaml`. See § Pre-flight & per-phase conventions → "Pass artifacts inline at phase handoff" for the prompt template.

**Atoms / skills used (orchestrator-visible only):** `Agent(design-review)`.

**Outputs:** PDD (`1-design/idea-to-pdd.md`); opp-specific test prompts derived from the PDD.

**Write-back:** `phases.design-review.{status, started_at, completed_at, verdict, summary_artifact, steps}` per § Phase Write-Back Contract (in reference). The boundary fence (§ Phase boundary fence) governs WHEN.

**Gate:** `[BLOCKER]` halts; pause-on-`idea-to-pdd` per § Pause Points (in reference).

### Phase 2: CommCare Setup

**Dispatch:** **inline procedure-doc `agents/commcare-setup.md`** — do NOT call `Agent(commcare-setup)`. Level-0 constraint, see Notes.

**Inputs (inline at handoff):** PDD, prior-phase verdicts (`1-design/idea-to-pdd-{qa_result,eval_verdict}.yaml`), `run_state.yaml`. See § Pre-flight & per-phase conventions → "Pass artifacts inline at phase handoff" for the template.

**Atoms / skills used (orchestrator-visible only):** inline execution of `agents/commcare-setup.md`, which itself dispatches `/nova:autobuild` for `pdd-to-learn-app` + `pdd-to-deliver-app` (each Nova call is `Agent(nova:nova-architect-autonomous)` at level 0).

**Outputs:** Learn app, Deliver app, deployed apps on CCHQ, test results (`2-commcare/app-test-cases.yaml` + `app-test-cases/J*.yaml`). (Training materials moved to Phase 5 (`qa-and-training`) in 0.9.0.)

**Write-back:** `phases.commcare-setup.{status, started_at, completed_at, verdict, summary_artifact, steps}` per § Phase Write-Back Contract (in reference). The boundary fence (§ Phase boundary fence) governs WHEN.

**Gate:** `[BLOCKER]` halts; pause-on-`app-deploy` per § Pause Points (in reference).

**Notes:** Phase 2 invokes `/nova:autobuild`, which dispatches the `nova:nova-architect-autonomous` subagent. That dispatch requires `Agent` at level 0 — running Phase 2 itself as a subagent would put Nova's dispatch at level 2 and fail. See § Agent Topology in reference. This is the only orchestrator-visible inline procedure-doc dispatch in the workflow.

### Phase 3: Connect Setup

**Dispatch:** `Agent(connect-setup)`.

**Inputs (inline at handoff):** PDD, Phase-2 verdicts (`2-commcare/{pdd-to-learn-app,pdd-to-deliver-app,app-deploy,app-test-cases}-{qa_result,eval_verdict}.yaml`), `2-commcare/app-deploy_summary.md`, `run_state.yaml`. See § Pre-flight & per-phase conventions → "Pass artifacts inline at phase handoff" for the template.

**Atoms / skills used (orchestrator-visible only):** `Agent(connect-setup)`.

**Outputs:** Program configured; Opportunity configured with verification rules and delivery/payment units (`3-connect/connect-program-setup.md`, `3-connect/connect-opp-setup.md`).

**Write-back:** `phases.connect-setup.{status, started_at, completed_at, verdict, summary_artifact, steps}` per § Phase Write-Back Contract (in reference). The boundary fence (§ Phase boundary fence) governs WHEN.

**Gate:** `[BLOCKER]` halts; no named pause point in default mode (see § Pause Points in reference).

**Notes:** LLO invite-list preparation moved to Phase 8 on 2026-04-20 — we don't commit to an invite roster until after the OCS chatbot has cleared its deep-eval gate. After Phase 3 completes, the orchestrator refreshes `current/` shortcuts (see § Per-Phase Folder Lifecycle in reference).

### Phase 4: OCS Setup

**Dispatch:** `Agent(ocs-setup)`.

**Inputs (inline at handoff):** PDD, opp-specific test prompts (`1-design/pdd-to-test-prompts.md`), Phase-3 verdicts (`3-connect/{connect-program-setup,connect-opp-setup}-{qa_result,eval_verdict}.yaml`), `run_state.yaml`. See § Pre-flight & per-phase conventions → "Pass artifacts inline at phase handoff" for the template.

**Atoms / skills used (orchestrator-visible only):** `Agent(ocs-setup)`.

**Outputs:** per-opp OCS chatbot cloned from the golden template with opp-specific RAG collection; quick smoke qa+eval passed; deep pre-launch qa+eval passed against opp-specific test prompts; embed credentials ready for Connect (`4-ocs/ocs-agent-setup.md`).

**Write-back:** `phases.ocs-setup.{status, started_at, completed_at, verdict, summary_artifact, steps}` per § Phase Write-Back Contract (in reference). The boundary fence (§ Phase boundary fence) governs WHEN.

**Gate:** `[BLOCKER]` halts; pause-on-`ocs-chatbot-eval --quick` per § Pause Points (in reference).

**Notes:** Each quality gate is a qa→eval pair — `ocs-chatbot-qa` captures a transcript, `ocs-chatbot-eval` grades it. Ends with a human-in-the-loop step to paste the widget credentials into the Connect opportunity until `update_opportunity` lands (CCC-301). After Phase 4 completes, the orchestrator refreshes `current/` shortcuts (see § Per-Phase Folder Lifecycle in reference).

### Phase 5: QA and Training

**Dispatch:** `Agent(qa-and-training)`.

**Inputs (inline at handoff):** PDD, Phase-2 outputs (`2-commcare/app-test-cases.yaml` + per-journey recipes under `2-commcare/app-test-cases/J*.yaml`), Phase-4 chatbot URL (`4-ocs/ocs-agent-setup.md`), `run_state.yaml`. See § Pre-flight & per-phase conventions → "Pass artifacts inline at phase handoff" for the template.

**Atoms / skills used (orchestrator-visible only):** `Agent(qa-and-training)`. Internally the agent runs `app-screenshot-capture` (executor — runs the smoke recipes from Phase 2's `app-test-cases.yaml`) → 5 per-artifact training skills in parallel (`training-llo-guide`, `training-flw-guide`, `training-quick-reference`, `training-faq`, `training-deck-outline`) → `training-deck-build` (sequential after deck-outline; skipped if `ACE_TRAINING_DECK_TEMPLATE_ID` unset) → `training-onboarding-email` (LAST — links by URL to other docs).

**Outputs:** Phase-5 artifacts under `5-qa-and-training/` — screenshot bundles, 5 training docs (LLO guide, FLW guide, quick reference, FAQ, deck outline), optional training deck build, onboarding email.

**Write-back:** `phases.qa-and-training.{status, started_at, completed_at, verdict, summary_artifact, steps}` per § Phase Write-Back Contract (in reference). The boundary fence (§ Phase boundary fence) governs WHEN.

**Gate:** `[BLOCKER]` halts; no named pause point in default mode (see § Pause Points in reference). Phase 5→6 is no longer a mandatory pause (§ Modes — default, review, auto).

**Notes:** All skills read upstream artifacts from Phases 1–4. No 1-1 LLO contact happens here — that begins in Phase 8. Phase 5 splits shallow (in `/ace:run`, ~5 LLM judges) vs deep (out-of-band via `/ace:qa-deep`); `llo-launch` (Phase 8) requires fresh deep verdicts.

### Phase 6: Synthetic Data and Workflows

**Dispatch:** `Agent(synthetic-data-and-workflows)`.

**Inputs (inline at handoff):** PDD, Phase-3 Connect identifiers (`3-connect/connect-opp-setup.md`), `run_state.yaml`. See § Pre-flight & per-phase conventions → "Pass artifacts inline at phase handoff" for the template.

**Atoms / skills used (orchestrator-visible only):** `Agent(synthetic-data-and-workflows)`. Internally: authors a story-coherent synthetic-data manifest from the PDD, generates fixture data via the connect-labs MCP, instantiates the LLO weekly review + program admin audit workflows, polishes them per-opp, and runs persona walkthroughs that produce stakeholder-ready HTML decks.

**Outputs:** synthetic narrative manifest; fixture FLW/visit/payment data; two demonstrative workflows (`llo_weekly_review`, `program_admin_audit`); per-persona walkthrough HTML decks; single one-page summary (`6-synthetic/synthetic-summary.md`).

**Write-back:** `phases.synthetic-data-and-workflows.{status, started_at, completed_at, verdict, summary_artifact, steps}` per § Phase Write-Back Contract (in reference). The boundary fence (§ Phase boundary fence) governs WHEN.

**Gate:** `[BLOCKER]` halts; **no phase pause** — `/ace:run` proceeds straight from Phase 6 to Phase 7 without halting (no run-time gate; see § Pause Points in reference).

**Notes:** **No irreversible external action.** The connect-labs `SyntheticOpportunity` row is reversible via `synthetic_disable`; workflows can be deleted via `workflow_delete`. See `agents/synthetic-data-and-workflows.md`.

### Phase 7: Solicitation Management

**Dispatch:** `Agent(solicitation-management)`.

**Inputs (inline at handoff):** PDD (with PDD-named candidate LLOs, if any), Phase-6 summary (`6-synthetic/synthetic-summary.md`), `run_state.yaml`. See § Pre-flight & per-phase conventions → "Pass artifacts inline at phase handoff" for the template.

**Atoms / skills used (orchestrator-visible only):** `Agent(solicitation-management)`. Internally the agent runs `solicitation-create` → `llo-invite` (default run, both auto).

**Outputs:** solicitation derived from the PDD published on labs.connect.dimagi.com via the `connect-labs` MCP; emails to PDD-named candidate LLOs containing the public URL (no-op if the PDD names no candidates — long-term flow).

**Write-back:** `phases.solicitation-management.{status, started_at, completed_at, verdict, summary_artifact, steps}` per § Phase Write-Back Contract (in reference). The boundary fence (§ Phase boundary fence) governs WHEN.

**Gate:** `[BLOCKER]` halts; **Phase 7→8 boundary always pauses in every mode** — `/ace:run` HALTS here at the new external-comms boundary. Phase 8 cannot start until `opp.yaml.selected_llo.org_slug` is populated, which only happens via the manual `/ace:step solicitation-review` (HITL-gated; calls `award_response`). See § Pause Points in reference.

**Notes:** The recurring `solicitation-monitor` skill polls labs for responses while the solicitation is open; runs OUTSIDE `/ace:run` (cron or manual dispatch). `solicitation` and `selected_llo` are separate `opp.yaml` blocks — only `solicitation-review` populates `selected_llo`.

### Phase 8: Execution Management

**Dispatch:** `Agent(execution-manager)`. **Entry gated on `opp.yaml.selected_llo.org_slug` being populated by Phase 7's `solicitation-review`.**

**Inputs (inline at handoff):** PDD, Phase-5 training artifacts (5 docs + onboarding email under `5-qa-and-training/`), Phase-4 chatbot URL (`4-ocs/ocs-agent-setup.md`), `opp.yaml.selected_llo`, `run_state.yaml`. See § Pre-flight & per-phase conventions → "Pass artifacts inline at phase handoff" for the template.

**Atoms / skills used (orchestrator-visible only):** `Agent(execution-manager)`.

**Outputs:** the awarded LLO onboarded (Connect program-level invite + ACE onboarding email with widget link); UAT completed; opportunity activated (go-live); ongoing monitoring active.

**Write-back:** `phases.execution-management.{status, started_at, completed_at, verdict, summary_artifact, steps}` per § Phase Write-Back Contract (in reference). The boundary fence (§ Phase boundary fence) governs WHEN.

**Gate:** `[BLOCKER]` halts; **always pauses before** `llo-onboarding` (first 1-1 email to awardee), `llo-uat` send (UAT instructions), and `llo-launch` (opp activation in Connect) — these are unconditional in all modes. See § Pause Points in reference.

**Notes:** Phase 8 is the first 1-1 LLO contact in the lifecycle. Recurring skills (`timeline-monitor`, `flw-data-review`, `ocs-chatbot-qa-monitor`, `ocs-chatbot-eval-monitor`) run on schedule during the active opportunity. `llo-launch` requires fresh deep verdicts (Phase 5 `/ace:qa-deep` output).

### Phase 9: Closeout

**Dispatch:** `Agent(closeout)`. **Triggered when the opportunity reaches its end date.**

**Inputs (inline at handoff):** Phase-8 outputs (LLO onboarding + UAT + go-live artifacts under `8-execution-manager/`), `opp.yaml.selected_llo`, `run_state.yaml`. See § Pre-flight & per-phase conventions → "Pass artifacts inline at phase handoff" for the template.

**Atoms / skills used (orchestrator-visible only):** `Agent(closeout)`.

**Outputs:** Invoices pulled; Jira payment ticket created; LLO feedback collected; learnings summarized; cycle graded.

**Write-back:** `phases.closeout.{status, started_at, completed_at, verdict, summary_artifact, steps}` per § Phase Write-Back Contract (in reference). The boundary fence (§ Phase boundary fence) governs WHEN.

**Gate:** `[BLOCKER]` halts; **always pauses before** `opp-closeout` (Jira payment ticket creation) — unconditional in all modes. See § Pause Points in reference.

**Notes:** Triggered by end-date, not by phase chaining — Phase 9 does NOT run automatically as part of `/ace:run` continuation from Phase 8. The closeout agent owns the trigger condition.

## Between Phases

After each phase completes:
1. Update `run_state.yaml` per § Phase Write-Back Contract below
2. **Verify the dispatched phase actually wrote its block** per § Phase
   Write-Back Verifier below (catches drift; orchestrator stubs in a
   minimal block + flips the gate if the agent forgot)
3. **Verify producer artifacts landed** per § Producer Artifact Verifier
   below (catches the inline-composition class of bug at the source
   phase rather than three phases later at a consumer's pre-flight)
4. In `auto` mode: send status email to admin group, continue
5. In `default` mode: continue silently for Phases 1→2, 2→3, 3→4, 4→5;
   **at the Phase 5→6 transition, pause unconditionally** with a
   Phase-5-complete summary and "ready to begin LLO contact?" prompt;
   for 6→7, pause if any external-comm step still pending review
6. In `review` mode: present summary and wait for approval to continue

## Phase boundary fence

The verifier's actions happen as the **IMMEDIATE next assistant
message** after the `Agent(<phase>)` tool_result returns. Not after a
solo "Phase X complete" status text in a separate turn. Not after a
solo `TaskUpdate` in a separate turn.

These actions are independent and MUST be batched into ONE parallel
message:

- `drive_read_file` on `run_state.yaml` (verifier read — used next turn).
- `drive_create_file` for the phase's gate-brief, if applicable.
- `TaskUpdate` marking the current phase `completed` and the next phase `in_progress`.
- `Skill(decisions-render)` to refresh the decisions gdoc (idempotent).

A one-line text summary ("Phase N complete: <verdict>") may accompany
these tool calls in the same message. It must NOT precede them in a
separate turn.

**Anti-pattern.** Boundary observed in real transcripts (each line a
separate assistant turn):

```
Turn N:    Agent(<phase>) tool_result
Turn N+1:  text "Phase 1 complete: proceed verdict, no blockers"
Turn N+2:  drive_read_file run_state.yaml
Turn N+3:  TaskUpdate
Turn N+4:  drive_create_file gate-brief.md
Turn N+5:  Skill(decisions-render)
Turn N+6:  Agent(<next-phase>)
```

That's ~5 wasted turns × seconds each × 8 boundaries per run
≈ 1.5–4 min of pure model-output latency per `/ace:run`.

**Right pattern.**

```
Turn N:    Agent(<phase>) tool_result
Turn N+1:  ONE message — drive_read_file + drive_create_file gate-brief
           + TaskUpdate + Skill(decisions-render). Optional one-line
           text summary in the same message.
Turn N+2:  (only if N+1's read showed the phase block missing)
           update_yaml_file stub fallback per "Procedure" below.
Turn N+3:  Agent(<next-phase>) with inline-artifact prompt.
```

If the phase returned a `[BLOCKER]` or hard error, replace Turn N+3
with a halt message — but Turn N+1 still happens (write-back is
mandatory regardless of verdict).

## Per-Step Eval Hook

Per-step `-eval` skills run **automatically** after their producing skill
in `/ace:run`. Each phase agent dispatches the matching `-eval` skill
immediately after the producing skill completes, before advancing to the
next step. Without this, the Workbench's "run → inspect → upgrade plugin
→ rerun → compare" loop has no per-step signal, and `opp-eval` rolls up
nothing to aggregate.

**Where the wiring lives.** Each phase agent owns its own producer→eval
pairing, listed in the agent's frontmatter `skills:` block via
`eval_skill: <name>` (or `inline-self-eval` if the producer judges its own
output). The orchestrator does not maintain a separate mapping table.

**Verdict-file naming convention** (the rule the web reader enforces):

```
runs/<run-id>/<phase>/<producer-skill>[-eval]_verdict[-<mode>].yaml
```

Each producer skill (and each `-eval` partner) writes its verdict next
to its primary artifact in the phase folder. The web reader matches on
the segment immediately before `_verdict` to attribute scores to the
producer skill row.

- `-eval` skills include `-eval` in their filename so the verdict is
  attributable to the eval partner: `idea-to-pdd-eval` writes
  `1-design/idea-to-pdd-eval_verdict.yaml`, NOT
  `1-design/idea-to-pdd_verdict.yaml`. The reader rolls eval scores up
  to the producer (`idea-to-pdd`) row by walking the eval→producer
  pair declared in the producing phase agent's frontmatter, not by
  parsing the filename.
- Skills that ARE their own row in the registry (no producer / eval
  split, e.g. `ocs-chatbot-eval`) keep their own name and a mode
  suffix: `4-ocs/ocs-chatbot-eval_verdict-{quick,deep}.yaml`,
  `8-execution-manager/ocs-chatbot-eval_verdict-monitor.yaml`.
- Skills that self-evaluate inline (no separate `-eval` skill — e.g.
  `app-screenshot-capture` and every per-artifact training skill
  (`training-llo-guide`, `training-flw-guide`,
  `training-quick-reference`, `training-faq`,
  `training-onboarding-email`, `training-deck-outline`)) write
  `<phase>/<self>_verdict[-<mode>].yaml`.

**Opt-out.** `/ace:run --no-evals` skips the per-step eval dispatch (the
producing skills still write their primary artifacts). Useful for fast
smoke iterations where the operator plans to run `/ace:eval --all`
afterward.

**Eval failures don't halt the run by default.** A per-step eval that
returns `verdict: fail` does NOT halt the orchestrator outside the named
Pause Points — the verdict is recorded for the dashboard / `opp-eval`,
and the run continues. The named Pause Points (see § Pause Points) still
apply, where `[BLOCKER]` concerns from the eval do halt. This keeps the
eval signal visible without making every rubric a hard halt.

**Backstop.** `/ace:eval --all <opp-name>` runs every applicable
per-step `-eval` skill against an existing opp's artifacts (the
verdict-discovery model: for each producer skill that has an artifact
in Drive AND a registered eval pair, dispatch the eval). Use this to
retroactively score older opps, or to re-grade after a rubric is
improved.

## Umbrella Eval

The `opp-eval` skill (dispatched via `/ace:eval <opp-name> --mode
quick|deep|monitor`) is an **umbrella aggregator** that rolls every
per-skill `-eval` verdict for an opportunity into a single run-level
scorecard and drafts improvement recommendations. It walks every
phase folder under `ACE/<opp-name>/runs/<run-id>/` collecting
`*_verdict*.yaml`, groups scores into 7 skill-category dimensions
(design, commcare, connect, ocs, solicitation, operate, closeout), and
writes a human scorecard + machine verdict + advisory gate brief.

opp-eval is **ad-hoc**, not part of the `--mode review` auto-pause
flow. It does not gate any phase. It can be run anytime during or
after an opportunity — mid-run for a health check, end-of-run for a
retrospective, or on a schedule (`--monitor` mode) for drift
detection. The orchestrator does not dispatch opp-eval automatically;
operators invoke it via `/ace:eval`.

As more per-skill `-eval` skills gain `## LLM-as-Judge Rubric`
sections and start writing to `verdicts/`, opp-eval automatically
picks them up via directory discovery — no change to opp-eval itself
is needed. Today most skills still self-evaluate inline (no separate
`-eval` skill, so no verdict YAML under `verdicts/`); opp-eval emits
`[INFO]` notes for those gaps, which is the forcing function for
future per-skill rubric work. When a rubric arrives and the skill
starts writing `verdicts/<skill>-<mode>.yaml`, opp-eval picks it up on
the next run.

## Error Handling

If a skill fails:
1. Log the error in `run_state.yaml`
2. In `auto` mode: email the admin group with error details, continue to next step if possible
3. In `default` mode: a hard error halts the run regardless of phase — present the error and ask how to proceed (retry, skip, abort). The "keep going" principle applies to clean steps, not to errors
4. In `review` mode: present the error and ask how to proceed (retry, skip, abort)

## Dry-Run Mode

When `--dry-run` is passed to `/ace:run`:
- All skills execute normally — reading inputs, generating outputs, writing to GDrive
- Effectful skills (those that send emails, publish apps, create tickets, or call external APIs) write their intended actions to `comms-log/dry-run-<step>.md` instead of executing
- LLM-as-Judge evaluation still runs at each step
- Gates still apply per the active mode (default/review/auto)
- `run_state.yaml` tracks steps as `dry-run-success` or `dry-run-blocked` instead of `success` or `blocked`
- Pass the dry-run flag to all phase agents

## Sandbox Mode

When `--sandbox` is passed to `/ace:run`:
- MCP servers route external API calls to staging endpoints (Connect staging, CommCare staging project space)
- MCP servers read `ACE_SANDBOX=true` environment variable to determine endpoint routing
- Can be combined with `--dry-run` for maximum safety

## Post-Run: ace-web Transcript Upload (optional)

When `/ace:run` is invoked with `--ace-web-url URL`, after all phases
complete (or on fatal error) the orchestrator dispatches the
`upload-transcript` skill with the current transcript path and the
provided base URL. This is a best-effort hook — an upload failure is
logged but does not alter the run's success/failure status.

Requirements:
- `ACE_WEB_PAT_TOKEN` must be set in the environment (per-human PAT
  minted via `/ace:ace-web-pat-mint`). If absent, log a warning and
  skip the upload.
- The transcript path is whatever the operator is writing stream-json to
  (typically `$JSONL_PATH` in a scripted run). If not resolvable, skip.

This is the only ace-web dependency in the ACE plugin. Without
`--ace-web-url` the plugin is entirely standalone.

