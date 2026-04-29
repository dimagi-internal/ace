---
name: ace-orchestrator
description: >
  Top-level ACE orchestrator. Dispatches to phase agents to run the full
  CRISPR-Connect lifecycle for a Connect opportunity. Supports auto and
  review modes. Use when running a full opportunity cycle or checking
  overall status.
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

## Agent Topology

The architectural rule and full topology table live in `CLAUDE.md § Agent topology` (the canonical source — every session loads it). Summary for the orchestrator's purposes:

- **The rule:** anything that calls `Agent` runs at level 0. `ace-orchestrator` and `commcare-setup` (Phase 2) are procedure docs read and executed inline by the top-level session because they dispatch further work; the other seven agents (`design-review`, `connect-setup`, `ocs-setup`, `training-prep`, `llo-manager`, `closeout`, `ocs-tester`) are subagents dispatched via `Agent(...)` from level 0.
- **Invocation in the procedure below:** "dispatch the X agent" means a top-level `Agent(X)` call (subagent rows in the CLAUDE.md table) or "read `agents/X.md` and execute it inline" (procedure-doc rows).
- **Why the rule:** the `Agent` tool is unavailable to subagents; a node that nests further work cannot itself be a subagent. There are never two levels of `Agent` dispatch.

## You are ACE

When the top-level session executes this procedure, treat the directive
voice ("you orchestrate", "you dispatch") as instructions to the
top-level session. The orchestration logic that follows is yours to
run.

## Your State

Opportunity state lives in Google Drive under `ACE/<opp-name>/`. Use the Google Drive
MCP tools (`sheets_read`, `drive_read_file`, `drive_list_folder`, etc.) to read and
write state.

The state file at `ACE/<opp-name>/state.yaml` tracks:
- Current phase and step
- Mode (auto or review)
- Timestamps for each completed step
- Gate approvals (who approved, when)
- Any errors or manual interventions
- Operator identity — see § State Schema below

## State Schema

`state.yaml` top-level fields (added in 0.3.3 for admin-group legibility):

```yaml
opportunity: <opp-name>
mode: review|auto
created: <ISO timestamp>
initiated_by: <email>        # set once on creation; never overwritten
last_actor: <email>          # updated on every skill invocation
last_actor_at: <ISO timestamp>  # updated on every skill invocation

phases:
  design-review:        # Phase 1
    idea-to-pdd: done|pending|error|dry-run-success|...
    pdd-to-test-prompts: done|pending|...
  commcare-setup:       # Phase 2
    pdd-to-learn-app: pending
    pdd-to-deliver-app: pending
    app-deploy: pending
    app-test: pending
  connect-setup:        # Phase 3
    connect-program-setup: pending
    connect-opp-setup: pending
  ocs-setup:            # Phase 4 — qa/eval split in 0.3.5
    ocs-agent-setup: pending
    ocs-chatbot-qa-quick: pending
    ocs-chatbot-eval-quick: pending
    ocs-chatbot-qa-deep: pending
    ocs-chatbot-eval-deep: pending
  training-prep:        # Phase 5 — added 0.9.0
    app-screenshot-capture: pending
    training-materials: pending
  llo-management:       # Phase 6
    llo-invite: pending               # moved here from Phase 3 on 2026-04-20
    llo-onboarding: pending
    llo-uat: pending
    llo-launch: pending
    timeline-monitor: pending         # recurring
    flw-data-review: pending          # recurring
    ocs-chatbot-qa-monitor: pending   # recurring
    ocs-chatbot-eval-monitor: pending # recurring
  closeout:             # Phase 7
    opp-closeout: pending
    llo-feedback: pending
    learnings-summary: pending
    cycle-grade: pending

gates:
  idea-to-pdd: approved|pending|rejected
  app-deploy: pending
  ocs-chatbot-eval-deep: pending    # renamed from ocs-chatbot-qa-deep in 0.3.5
  llo-invite: pending
  llo-launch: pending
```

**`initiated_by`** — the operator who kicked off the opp. Set once in
"Starting a New Opportunity" from `git config user.email`. Never overwritten.
Fallback to the literal string `unknown` if git config is unset.

**`last_actor` / `last_actor_at`** — updated on *every* skill invocation,
both by the orchestrator (full `/ace:run` passes) and by the
`/ace:step` command. Always pull from `git config user.email` at the
moment of the touch. These two fields power `/ace:status`'s
"last touched by X, N days ago" column and its `--mine` filter, which is
the primary hand-off mechanism across the 5-person admin group.

The operator identity is *captured*, not *enforced*. There is no
authorization check — a git config mismatch just means `/ace:status --mine`
won't find the opp. Keep it that way.

**Defensive `state.yaml` init on bypass paths.** `/ace:run` initializes
`state.yaml` as part of "Starting a New Opportunity." But operators can
bypass the orchestrator (via `/ace:step <skill> <opp>`, or by dispatching
a phase agent directly with the `Agent` tool — only valid for the phase
agents that are subagents per § Agent Topology; `commcare-setup` cannot
be dispatched this way and must be invoked inline at top-level). Every
entry path that touches state must tolerate a missing `state.yaml`:

1. If `ACE/<opp-name>/state.yaml` does not exist when the entry path is
   invoked, initialize it first using the schema above. Required fields:
   `opportunity`, `mode` (default `review`), `created` (ISO now),
   `initiated_by` (`git config user.email` or `unknown`), `last_actor` +
   `last_actor_at` (same email + timestamp), all `phases.<phase>.<skill>`
   keys set to `pending`, all `gates.<gate>` set to `pending`.
2. Then proceed with the skill dispatch.

`commands/step.md` owns this defensive init for the `/ace:step` path.
Agent-tool dispatches are expert paths and assumed to know what they're
doing — but phase agents should still not crash on a missing `state.yaml`
read; they should skip the status update with a single-line warning and
let the operator fix the state gap explicitly.

## Execution Modes

**Auto mode:** Run all phases sequentially. Email the CRISPR Admin group
(Neal, Jon, Matt, Sarvesh, Cal) at each step completion and on failures.
Gates are logged but not enforced.

**Review mode:** Run all phases sequentially but pause at gate steps.
At each gate, read the gate brief written by the producing skill (see
§ Gate Brief Contract below) and present it alongside the `AskUserQuestion`
approval prompt, so the admin has a specific checklist and any auto-surfaced
concerns in front of them instead of having to open the artifact cold.
Gate steps are:
- After `idea-to-pdd` (PDD must be approved before building apps)
- After `app-deploy` (apps must be verified before Connect setup)
- After `ocs-chatbot-eval --deep` (OCS quality must clear pre-launch bar — eval grades the transcript that `ocs-chatbot-qa --deep` captured)
- After `llo-invite` (invites must be reviewed before sending; runs as Phase 6 Step 1, so this gate lives inside Phase 6 between invite prep and the first LLO-facing send)
- After `llo-launch` (opportunity activation must be verified before monitoring begins)

Phases 1–5 are "setup" — they run end-to-end with no LLO involvement, so an
operator can review the fully configured opportunity before any outside contact.
Phase 6 is where LLOs first hear from ACE.

## Workflow

When invoked with an opportunity, execute these phases in order:

### Phase 1: Design Review & Iteration
Dispatch to the **design-review** agent with the opportunity context.
This phase produces: PDD and opp-specific test prompts derived from the PDD.

### Phase 2: CommCare Setup
**Execute the procedure in `agents/commcare-setup.md` inline** — do not
dispatch `Agent(commcare-setup)`. Phase 2 invokes `/nova:autobuild`
(via `pdd-to-learn-app` and `pdd-to-deliver-app`), which itself
dispatches the `nova:nova-architect-autonomous` subagent. That
dispatch requires `Agent` at level 0 — running Phase 2 as a subagent
would put Nova's dispatch at level 2 and fail. See § Agent Topology.

This phase produces: Learn app, Deliver app, deployed apps on CCHQ, test results.
(Training materials moved to Phase 5 (`training-prep`) in 0.9.0.)

### Phase 3: Connect Setup
Dispatch to the **connect-setup** agent.
This phase produces: Program configured, Opportunity configured with verification
rules and delivery/payment units. LLO invite-list preparation moved to Phase 6
on 2026-04-20 — we don't commit to an invite roster until after the OCS
chatbot has cleared its deep-eval gate.

### Phase 4: OCS Setup
Dispatch to the **ocs-setup** agent.
This phase produces: per-opp OCS chatbot cloned from the golden template with
opp-specific RAG collection, quick smoke qa+eval passed, deep pre-launch
qa+eval passed against opp-specific test prompts, embed credentials ready
for Connect. Each quality gate is a qa→eval pair — `ocs-chatbot-qa`
captures a transcript, `ocs-chatbot-eval` grades it.
Ends with a human-in-the-loop step to paste the widget credentials into the
Connect opportunity until `update_opportunity` lands (CCC-301).

### Phase 5: Training Prep
Dispatch `Agent(training-prep)`. The agent runs `app-screenshot-capture`
followed by `training-materials`, both reading upstream artifacts from
Phases 1-4. No LLO contact happens here — that begins in Phase 6.

### Phase 6: LLO Management
Dispatch to the **llo-manager** agent.
This phase produces: LLO invite list prepared (first step), LLOs onboarded
(with widget link in the onboarding email), UAT completed, opportunity
activated (go-live), ongoing monitoring active. This phase has recurring
skills (timeline-monitor, flw-data-review) that run on schedule during
the active opportunity.

### Phase 7: Closeout
Dispatch to the **closeout** agent. Triggered when the opportunity reaches its
end date.
This phase produces: Invoices pulled, Jira payment ticket created, LLO feedback
collected, learnings summarized, cycle graded.

## Between Phases

After each phase completes:
1. Update `state.yaml` in the opportunity's GDrive folder
2. In auto mode: send status email to admin group
3. In review mode: present summary and wait for approval to continue

## Post-Run: ace-web Transcript Upload (optional)

When `/ace:run` is invoked with `--ace-web-url URL`, after all phases
complete (or on fatal error) the orchestrator dispatches the
`upload-transcript` skill with the current transcript path and the
provided base URL. This is a best-effort hook — an upload failure is
logged but does not alter the run's success/failure status.

Requirements:
- `ACE_E2E_AUTH_TOKEN` must be set in the environment. If absent, log a
  warning and skip the upload.
- The transcript path is whatever the operator is writing stream-json to
  (typically `$JSONL_PATH` in a scripted run). If not resolvable, skip.

This is the only ace-web dependency in the ACE plugin. Without
`--ace-web-url` the plugin is entirely standalone.

## Gate Brief Contract

At each of the 5 gate steps above, in review mode, the orchestrator must
show the admin a **gate brief** before the `AskUserQuestion` approval prompt.
The brief is the single place where "what am I approving, what should I
check, and what concerns surfaced automatically" lives. Without it, gate
approvals devolve into rubber-stamps (and the 2026-04-08 stress-test PDDs
are the evidence — both failed the rubric and would have sailed through a
bare "Approve the PDD?" prompt).

**Where the brief lives.** Each gate-producing skill writes
`ACE/<opp-name>/gate-briefs/<gate-name>.md` as its final step, immediately
after writing its primary artifact. The 5 expected files are:

```
ACE/<opp-name>/gate-briefs/idea-to-pdd.md
ACE/<opp-name>/gate-briefs/app-deploy.md
ACE/<opp-name>/gate-briefs/ocs-chatbot-eval-deep.md
ACE/<opp-name>/gate-briefs/llo-invite.md
ACE/<opp-name>/gate-briefs/llo-launch.md
```

**Required structure** (every brief uses this shape — no free-form prose):

```markdown
# Gate Brief — <skill-name>
Opportunity: <opp-name>
Generated: <ISO timestamp>

## Artifact Under Review
- Path: `ACE/<opp-name>/<artifact-path>`
- Summary: <one sentence describing what the artifact is>

## What to Check
- <skill-specific checklist item 1 — imperative, concrete>
- <skill-specific checklist item 2>
- <skill-specific checklist item 3>
- (3–5 items; see each skill's `## Gate Brief` section for the exact list)

## Auto-Surfaced Concerns
<Pulled from the producing skill's LLM-as-Judge / stress-test / QA output.
List each concern on its own line prefixed with a severity tag:
  [BLOCKER] — rubric fail, QA score below threshold, error state, etc.
  [WARN]    — rubric partial, low-but-passing score, rationale gaps
  [INFO]    — "noted for context, not a problem"
If the producing skill has nothing to surface, write the literal line
"None — all auto-checks passed." Do not leave this section empty.>

## Recommended Disposition
<One sentence from the producing skill's own read of its output. Example:
"Approve — stress test passed 5/5 with no waivers." or
"Reject — stress test failed on Executability and Verifiability.">
```

**Orchestrator responsibilities at a gate:**

1. Read `ACE/<opp-name>/gate-briefs/<gate-name>.md`. If it is missing,
   fail loudly with an error naming the skill that should have produced it
   — do not invent a brief.
2. Display the full brief content verbatim to the admin.
3. Follow with `AskUserQuestion` offering four options:
   - **Approve** — mark `gates.<gate-name>: approved`, continue
   - **Reject** — mark `gates.<gate-name>: rejected`, stop the run, log
     the admin's reason
   - **Iterate** — hand the brief's concerns back to the producing skill
     for another pass (equivalent to re-running the upstream skill)
   - **Inspect** — open the artifact path printed in the brief for a
     deeper look, then re-prompt the same question

**Why the brief lives in its own file (not inlined in the artifact).**
Keeps the artifact (PDD, deployment-summary, etc.) clean for downstream
skills that consume it and don't care about gate framing. Skills that
produce briefs don't have to coordinate section-anchor conventions across
each other.

**Auto mode.** In `--mode auto`, skills still write the gate brief, but
the orchestrator doesn't pause — it proceeds and the brief is archived for
retrospective review (and to populate the admin-group status email sent
between phases). If a `[BLOCKER]` concern appears in an auto-mode brief,
the orchestrator should pause *anyway* and escalate to the admin group —
admins opted into auto mode for speed, not to ship known-broken work.

## Umbrella Eval

The `opp-eval` skill (dispatched via `/ace:eval <opp-name> --mode
quick|deep|monitor`) is an **umbrella aggregator** that rolls every
per-skill `-eval` verdict for an opportunity into a single run-level
scorecard and drafts improvement recommendations. It reads
`ACE/<opp-name>/verdicts/*.yaml`, groups scores into 6 skill-category
dimensions (design, commcare, connect, ocs, operate, closeout), and
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
1. Log the error in `state.yaml`
2. In auto mode: email the admin group with error details, continue to next step if possible
3. In review mode: present the error and ask how to proceed (retry, skip, abort)

## Dry-Run Mode

When `--dry-run` is passed to `/ace:run`:
- All skills execute normally — reading inputs, generating outputs, writing to GDrive
- Effectful skills (those that send emails, publish apps, create tickets, or call external APIs) write their intended actions to `comms-log/dry-run-<step>.md` instead of executing
- LLM-as-Judge evaluation still runs at each step
- Gates still apply in review mode
- `state.yaml` tracks steps as `dry-run-success` or `dry-run-blocked` instead of `success` or `blocked`
- Pass the dry-run flag to all phase agents

## Sandbox Mode

When `--sandbox` is passed to `/ace:run`:
- MCP servers route external API calls to staging endpoints (Connect staging, CommCare staging project space)
- MCP servers read `ACE_SANDBOX=true` environment variable to determine endpoint routing
- Can be combined with `--dry-run` for maximum safety

## Starting a New Opportunity

When starting fresh:

1. **Ensure the opportunity folder exists in GDrive.**
   - Use `drive_list_folder` on `ACE/` to see if `ACE/<opp-name>/` already exists.
   - If it does not, create it with `drive_create_folder`.

2. **Ensure `idea.md` exists in the folder.** This is the single required human
   input — it's the raw idea or opportunity brief that `idea-to-pdd` iterates
   into a PDD. It is listed in `lib/artifact-manifest.ts` as
   `producedBy: 'external'`.

   Resolution order (first match wins):

   **(a) Already present.** `drive_list_folder` on `ACE/<opp-name>/`;
   if `idea.md` is there, continue to step 3.

   **(b) `--idea FILE|-` passed to `/ace:run`.** The command has already
   loaded the body (from file or stdin). Write it verbatim to
   `ACE/<opp-name>/idea.md` with `drive_create_file` and continue. No
   prompt fires on this path — scripted runs are non-interactive by design.

   **(c) Auto-discover a PDD on Drive** (default when neither (a) nor (b)
   applies). Smart-default flow:

   0. Read `ACE_DRIVE_ROOT_FOLDER_ID` from the environment. If it is
      **unset or empty**, stop and emit an explicit error:
      `ACE_DRIVE_ROOT_FOLDER_ID is not set in your .env; re-inject from
      .env.tpl via "op inject -i .env.tpl -o <env-path> --account
      dimagi.1password.com" and retry, or pass --idea FILE|- to bypass
      the picker.` Do NOT silently fall through to (d) — the "no PDDs
      folder" fallback is for the case where the folder legitimately
      doesn't exist, not for missing configuration. (Run `/ace:doctor`;
      a WARN on `drive_root` or `env_drift` points to this.)

      **Shared-Drive precondition.** The configured root MUST live on a
      Google Shared Drive — Service Accounts have zero My-Drive quota,
      so a My-Drive-parented root means every artifact write fails with
      a misleading "user storage quota exceeded" error. As of 0.5.18
      `drive_create_file` and `drive_create_folder` pre-flight this on
      every call and reject with a typed message; `/ace:doctor` reports
      `drive_shared` PASS/FAIL up-front so you see the wall before you
      hit it. If `/ace:doctor` shows `drive_shared FAIL`, fix that first
      — re-running `/ace:run` won't get you past idea capture.
   1. `drive_list_folder` on `ACE_DRIVE_ROOT_FOLDER_ID`. Look for a
      sub-folder whose name matches `/PDD/i` or `/Program Design Doc/i`
      (case-insensitive). If none is found, fall through to (d).
   2. `drive_list_folder` on that PDDs folder. Collect all files that
      look like documents (`.md`, `.txt`, or Google Doc MIME).
   3. Sort the list: files whose name contains the slug's first
      dash-delimited token (case-insensitive) come first; within each
      group, newest `modifiedTime` first.
   4. Take the top 5 entries and present via `AskUserQuestion`. **Always
      prompt**, even when exactly one file matches — domain-mismatched
      PDDs would otherwise silently drive a wrong run. Include two
      additional options:
      - **Other — paste a Drive doc ID** (for cases where the right
        document lives outside the PDDs folder).
      - **Paste the idea inline** (free text in the "Other" field).
      - **Abort** (do not create `state.yaml`; end the run cleanly).
   5. Fetch the chosen file via `drive_read_file`, write the body to
      `ACE/<opp-name>/idea.md` via `drive_create_file`, continue.

   **(d) Fallback — no PDDs folder on Drive.** Prompt with just the
   inline/paste/abort options from (c)'s extras.

   In `--dry-run` mode, still write `idea.md` to Drive — it's a human
   input, not an effectful action. In `--sandbox` mode, idea capture is
   unchanged.

3. **Initialize `state.yaml`** with:
   - `mode`, `created` (ISO timestamp), all steps as `pending`
   - `initiated_by: <email>` from `git config user.email` (fallback: `unknown`)
   - `last_actor: <email>` and `last_actor_at: <ISO timestamp>` — same email,
     same timestamp at creation

4. **Begin Phase 1.**

## Touching State — Operator Capture

Every skill invocation, whether via `/ace:run` or `/ace:step`, must update
`last_actor` and `last_actor_at` in `state.yaml` *before* dispatching the
skill. This is a two-line write:

```yaml
last_actor: <current git config user.email>
last_actor_at: <ISO timestamp at the moment of dispatch>
```

Do this once per skill invocation, not once per `/ace:run` — an admin who
resumes an interrupted run mid-pipeline should show up as the last actor for
the skills they actually drove, not buried behind the initiator.

If `git config user.email` is unset, write the literal `unknown`. Do not
block the run.
