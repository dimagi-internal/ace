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

## Agent Topology

The architectural rule and full topology table live in `CLAUDE.md § Agent topology` (the canonical source — every session loads it). Summary for the orchestrator's purposes:

- **The rule:** anything that calls `Agent` runs at level 0. `ace-orchestrator` and `commcare-setup` (Phase 2) are procedure docs read and executed inline by the top-level session because they dispatch further work; the other seven agents (`design-review`, `connect-setup`, `ocs-setup`, `qa-and-training`, `execution-manager`, `closeout`, `ocs-tester`) are subagents dispatched via `Agent(...)` from level 0.
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

The state file at `ACE/<opp-name>/run_state.yaml` tracks:
- Current phase and step
- Mode (auto or review)
- Timestamps for each completed step
- Gate approvals (who approved, when)
- Any errors or manual interventions
- Operator identity — see § State Schema below

## State Schema

`run_state.yaml` top-level fields (added in 0.3.3 for admin-group legibility):

```yaml
opportunity: <opp-name>
run_id: <YYYYMMDD-HHMM>     # multi-run layout (v0.11.0+); the run folder name
mode: default|review|auto
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
    app-test-cases: pending
  connect-setup:        # Phase 3
    connect-program-setup: pending
    connect-opp-setup: pending
  ocs-setup:            # Phase 4 — qa/eval split in 0.3.5; deep moved to /ace:qa-deep
    ocs-agent-setup: pending
    ocs-chatbot-qa-quick: pending
    ocs-chatbot-eval-quick: pending
  qa-and-training:        # Phase 5 — added 0.9.0; per-artifact training split 0.10.79–0.10.84; qa-plan retired in shallow/deep QA split
    app-screenshot-capture: pending
    training-llo-guide: pending
    training-flw-guide: pending
    training-quick-reference: pending
    training-faq: pending
    training-deck-outline: pending
    training-deck-build: pending          # skipped if ACE_TRAINING_DECK_TEMPLATE_ID unset
    training-onboarding-email: pending    # last — links to other docs by URL
  solicitation-management:  # Phase 7 — added 0.12.0
    solicitation-create: pending
    llo-invite: pending               # repurposed 0.12.0: emails solicitation URL to PDD-named candidates
    solicitation-monitor: pending     # recurring (post-/ace:run, while solicitation open)
    solicitation-review: pending      # manual (HITL gate before award_response; only path that unblocks Phase 8)
  execution-management: # Phase 8 (renamed from llo-management 0.12.0)
    llo-onboarding: pending           # reads opp.yaml.selected_llo (populated by Phase 7 solicitation-review)
    llo-uat: pending
    llo-launch: pending
    timeline-monitor: pending         # recurring
    flw-data-review: pending          # recurring
    ocs-chatbot-qa-monitor: pending   # recurring
    ocs-chatbot-eval-monitor: pending # recurring
  closeout:             # Phase 9 (was Phase 8)
    opp-closeout: pending
    llo-feedback: pending
    learnings-summary: pending
    cycle-grade: pending

```

(0.13.116: the legacy `gates:` top-level field was removed. Pause-point
status is derived from `phases.<phase>.status` + per-skill verdict
files at runtime; no separate field carries it. See § Pause Points.)

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

**Defensive `run_state.yaml` init on bypass paths.** `/ace:run` initializes
`run_state.yaml` as part of "Starting a New Opportunity." But operators can
bypass the orchestrator (via `/ace:step <skill> <opp>`, or by dispatching
a phase agent directly with the `Agent` tool — only valid for the phase
agents that are subagents per § Agent Topology; `commcare-setup` cannot
be dispatched this way and must be invoked inline at top-level). Every
entry path that touches state must tolerate a missing `run_state.yaml`:

1. If `ACE/<opp-name>/run_state.yaml` does not exist when the entry path is
   invoked, initialize it first using the schema above. Required fields:
   `opportunity`, `mode` (default `default`), `created` (ISO now),
   `initiated_by` (`git config user.email` or `unknown`), `last_actor` +
   `last_actor_at` (same email + timestamp), all `phases.<phase>.<skill>`
   keys set to `pending`, all `gates.<gate>` set to `pending`.
2. Then proceed with the skill dispatch.

`commands/step.md` owns this defensive init for the `/ace:step` path.
Agent-tool dispatches are expert paths and assumed to know what they're
doing — but phase agents should still not crash on a missing `run_state.yaml`
read; they should skip the status update with a single-line warning and
let the operator fix the state gap explicitly.

## Scope boundaries — what goes in `run_state.yaml`

`run_state.yaml` is **per-run, per-opp**. Skills must keep it scoped to
this opp's lifecycle and not let plugin-wide concerns leak in.

**In scope** (write to `run_state.yaml`):
- This opp's phase + step status, gate decisions, mode.
- Pointers to this opp's artifacts (Drive file IDs, app IDs, opp UUID,
  experiment ID).
- Open questions that are **about this opp** — pricing for this
  funder, country list for this rollout, LLO contacts for this program.
- Eval verdicts for this opp's runs.
- `phase_X_backlog` items that block **this opp** — a stuck Phase 3,
  a stub LLO invite that needs follow-up, a deferred screenshot capture.

**Out of scope** (do NOT write to `run_state.yaml` — they belong elsewhere):
- Bug reports about MCP atoms, skills, or tooling (write to GitHub
  issues on jjackson/ace; mention them in the resolving PR's
  CHANGELOG entry).
- Upstream service bugs (Nova, Connect, OCS) — file as issues on the
  upstream repo (e.g. voidcraft-labs/nova-plugin#7), reference from
  the patch skill's removal-criteria block.
- Cross-opp learnings or pattern observations — write to the canopy
  run log (`.claude/pm/runs/<date>-<lens>.md`).
- Recurring sweeps or cleanup tasks that apply to every opp — those
  are skill-design or doctor-lint asks, not per-opp state.

**Why this matters:** new sessions reading `run_state.yaml` should see
what's open *for this opp*. Mixing in plugin-wide findings creates
noise that operators have to mentally subtract on every read, and the
findings rot in place because no skill is responsible for plugin-wide
follow-up. The 0.11.4 LEEP rename surfaced 3 such entries in
`phase_X_backlog` that described MCP bugs, all already resolved
upstream — kept in the per-opp log for "audit," but actually
unreadable signal.

**Doctor lint (added 0.11.6).** `/ace:doctor` now scans every opp's
`run_state.yaml` `phase_X_backlog` entries and warns when an entry's
`location` field references files outside `ACE/<opp>/` (e.g.
`mcp/connect/backends/...`, `skills/<name>/`, `lib/<name>.ts`) — those
should live in GitHub issues, not per-opp state.

## Cruft management — `archive:` block convention

`open_questions:` and `phase_X_backlog:` accumulate **resolved
entries** because the long-standing convention has been to annotate
them in place ("RESOLVED 2026-05-03 by ACE 0.10.91 — …") rather than
remove them. Net effect: a 12-entry `open_questions:` list where 4
are actually open and 8 are historical record dressed as work items.

**The convention (added 0.11.7):** when a skill resolves an entry, it
**moves** the entry to a top-level `archive:` block instead of
annotating in place. The archive preserves the audit trail without
polluting the live work list.

`archive:` shape mirrors the source:

```yaml
archive:
  open_questions:
    - id: createOpportunity-mcp-backend
      summary: …  (preserved verbatim)
      owner: …
      resolution_phase: resolved-in-0.10.91
      default_in_use: …
      resolved_at: 2026-05-03T15:30:00Z   # added when moving to archive
      resolved_by: ace-engineering         # who resolved it (skill, agent, or operator)
      resolution_note: …                   # one-sentence summary of the fix
  phase_2_backlog:
    - id: commcare-download-ccz-marker-counter-bug
      …  (same shape; original location field preserved)
      resolved_at: …
      resolved_by: …
      resolution_note: …
  phase_3_backlog: [...]
  # phase_4_backlog, phase_5_backlog, phase_6_backlog as needed
```

The three `resolved_*` fields are **the only fields added** when
moving an entry from live to archive — nothing else changes, so the
audit trail is intact and grep-able.

**Consumers:** `/ace:status`, opp-eval, the orchestrator's "what's
open" sweeps, and any skill computing per-opp readiness must IGNORE
the `archive:` block. Treat it as a frozen historical record, not as
work-in-progress signal.

**Doctor lint (added 0.11.7).** `/ace:doctor state-yaml-cruft <opp>`
scans `run_state.yaml` for entries that look resolved but still live
in the active list — heuristics: `resolution_phase: resolved-in-…`,
`default_in_use:` starts with `(resolved`, `summary:` begins with
`RESOLVED ` or contains a `RESOLVED in <version>` marker. Surfaces
each one as a candidate for the operator to move into `archive:`.
This is a NUDGE lint, not auto-fix — the operator decides what's
truly resolved vs partially-resolved.

**When to write to `archive:` directly vs annotate-then-move:** if a
skill resolves an entry as part of its run (e.g. `connect-opp-setup`
finishes and resolves the `createOpportunity-mcp-backend` open
question), it MAY move the entry directly to `archive:` with the
three `resolved_*` fields populated. If the resolution happens
ad-hoc (operator notices a stale entry in a future session), the
operator runs the cruft lint, decides which to archive, and moves
them.

**Why the lint NUDGES rather than auto-archives:** "RESOLVED in
0.10.67" markers can apply to a fix that hasn't been verified
end-to-end on this opp yet — auto-archiving would lose that signal.
The operator is the one who knows whether a marked-resolved entry is
truly closed in this opp's context.

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

## Long-Running Skills — No Fake Background Tasks

ACE has no real background-task primitive for phase-internal work.
`ScheduleWakeup` defers the *agent*; it doesn't background actual work
on a side thread. Treating it as backgrounding produces an
unobservable, unrecoverable, unbounded loop — which is exactly what
killed the `turmeric-20260503-0835` deep capture (3+ hours, ~700K
tokens, zero progress, no recoverable transcript). The rule is:

**Phase-internal sequential skills run synchronously to completion,
with a hard wall-clock budget. They do NOT call `ScheduleWakeup`.**

If a skill cannot finish in budget, it fails loud — writes a partial
artifact, returns a `[BLOCKER]` `auto_surfaced` entry, and lets the
orchestrator decide whether to re-dispatch (idempotent re-runs are the
recovery mechanism, not deferred wakeups).

Concrete shape every long-running skill must have:

1. **Wall-clock budget**, declared in a `## Wall-Clock Budget` section.
   Both per-unit (per-prompt, per-form, per-screenshot) and suite-level
   caps. Track elapsed with `date +%s` checkpoints.
2. **Liveness probe before the work loop.** A cheap (<5s) one-shot
   call against the upstream service that distinguishes "service is
   responsive" from "absence of output." Catches dead sessions before
   the budget burns.
3. **Incremental writes for recovery.** Every captured unit goes to
   the artifact file as it completes. Never "build everything in
   memory and write at the end" — a mid-loop kill that way loses
   everything.
4. **Resume-from-partial at start.** Read any existing artifact and
   skip already-completed units. Re-running the skill is cheap and
   idempotent.
5. **Three-strike circuit breaker.** If three consecutive units fail
   (timeout, error response), abort the loop — burning the rest of
   the budget produces noise, not signal.

### When background IS appropriate

`ScheduleWakeup` and cron-style scheduling are reserved for **recurring
jobs that run independent of any particular run**:

- `timeline-monitor` — recurring during active opp, fires per LLO
  milestone calendar
- `flw-data-review` — recurring during active opp, fires per FLW
  submission window
- `ocs-chatbot-qa --monitor` / `ocs-chatbot-eval --monitor` —
  recurring during active opp for drift detection

These are legitimately parallel-to-the-main-run; they don't gate any
phase. Phase-internal work (`ocs-chatbot-qa --quick` / `--deep`,
`app-screenshot-capture`, etc.) is foreground sequential
and is NOT eligible for this pattern.

### When polling IS appropriate

Some skills legitimately wait on upstream state changes (RAG indexing
in `ocs-agent-setup`, CCHQ build completion in `app-release`). For
those, poll the upstream service's status endpoint directly with a
**bounded retry policy**: max attempts, exponential backoff, hard
timeout, fail loud on exhaustion. Do not invent a "background task ID"
that the orchestrator can't actually verify is alive.

## External Mutations — Verify After Create

Every external-system write must be followed by a read-back. The
write's response alone is not authoritative — Connect, CCHQ, OCS, and
Nova all have classes of bug where the create endpoint accepts the
payload, returns 201, but the stored row diverges from what was sent
(wrong field mapping, silent overrides, server-side defaults
clobbering, async hydration gaps). Skills that don't read-back hand
silently-corrupted state to downstream phases.

The rule:

1. **Write** via the mutating atom (`connect_create_opportunity`,
   `connect_create_payment_units`, `commcare_make_build`,
   `ocs_set_chatbot_pipeline`, etc.).
2. **Read** via the matching getter (`connect_get_opportunity`,
   `connect_list_payment_units`, `commcare_download_ccz`,
   `ocs_get_chatbot`).
3. **Compare** every field the skill set against the read-back
   response.
4. **Halt loud on mismatch.** Mismatch on a load-bearing field
   (dates, app ids, amounts, required-relations) is a `[BLOCKER]` —
   write the diff (sent vs. stored) to `comms-log/observations.md`,
   surface in the gate brief, do NOT proceed. Mismatch on a
   cosmetic/display field (descriptions, tags) is `[INFO]` — log and
   proceed.

The `turmeric-20260503-0835` Phase 3 run is the canonical example: a
malformed `connect_create_payment_unit` shipped values that didn't
match what was sent (`amount=500` vs sent `1.50`,
`required_deliver_units=[]` vs sent `[Vendor Visit]`). The skill
returned cleanly, Phase 3 graded `warn` on the eval, the orchestrator
auto-proceeded — and the malformation cascaded through
`is_setup_complete` to silently break Phase 7 invites and Phase 5
screenshot capture. A read-back at the producer would have converted
that multi-phase cascade into a single-skill halt with an obvious
field-diff in the gate brief.

**Canonical example:** `skills/connect-opp-setup/SKILL.md` Steps 4
and 6 (added 0.11.11). Every skill that creates external state should
follow this pattern.

**When read-back is overkill:** for read-only or write-once-read-once
operations (a single `drive_create_file` whose content is the artifact
itself, a one-shot status flip whose state is naturally observed
downstream), the read-back collapses into the next skill's natural
input read. The rule is "every write before a state-dependent
downstream skill" — not literally every write.

This rule is the producer-side complement to the per-skill `-eval`
rubrics in `skills/<*>-eval/SKILL.md`. The eval correctly grades the
captured artifact post-hoc; verify-after-create catches the same
class of bug at the source, before the bad state ships downstream.

## Performance Conventions

These conventions cut wall-clock and token cost on `/ace:run`. Apply
them on every full-cycle invocation; they're also fine on `/ace:step`.

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

**Batch independent operations — for tool calls, not Agent dispatches.**
When a phase needs N independent **tool calls** (e.g. multiple
`drive_read_file` reads, multiple `nova_update_form` mutations,
multiple `connect_create_payment_unit` creates), dispatch them all in
a single assistant message. Sequential single-tool messages waste the
parallelism that the harness already supports.

**`Agent(...)` dispatches DO NOT parallelize the same way.** Claude
Code does not reliably run two `Agent` calls placed in one assistant
message in parallel; treat phase-agent and slash-command-driven agent
dispatches (e.g. `/nova:autobuild`) as serial. Phase 2's two Nova
builds, for instance, must run one after the other. This applies to
any future cross-phase orchestration too — design-review, ocs-setup,
etc. always serialize when dispatched together.

**Resolve `.env` in one shot, not by probing.** ACE's installed `.env`
lives at `${CLAUDE_PLUGIN_DATA}/.env` with one documented fallback at
`<plugin-root>/.env` for dev checkouts. Run a single bash that prints
the resolved path:

```bash
[ -f "$CLAUDE_PLUGIN_DATA/.env" ] && echo "$CLAUDE_PLUGIN_DATA/.env" || \
  ([ -f "$(dirname "$0" 2>/dev/null)/../.env" ] && echo "$(dirname "$0")/../.env") || \
  echo "MISSING"
```

(or, equivalently, derive the path from
`installed_plugins.json["plugins"]["ace@ace"][0]["installPath"]`.) Do
NOT fan out 3–4 separate `ls`/`test -f` probes across `~/.claude/`,
the worktree, and `.gws-sa-key.json`-adjacent paths — that's
30s of latency for a value `bin/ace-doctor` already publishes as
`env_file:` in its output.

**Issue all phase TaskCreate calls in one parallel block.** When you
set up the run-level task list (one `TaskCreate` per phase plus the
external-comm pause), emit them as a single assistant message with
multiple `TaskCreate` tool-use blocks. Sequential
`TaskCreate → TaskCreate → TaskCreate` over 7+ turns burns ~30s of
unnecessary model-output time at run start. The whole task list is
known up-front from the workflow below — there's no dependency on
prior responses.

## Per-Phase Folder Lifecycle

Per-run artifacts live under `runs/<runId>/<N>-<phase>/...` (the 0.13.0
phase-prefixed layout). The orchestrator is responsible for materializing
each `<N>-<phase>/` folder before its phase agent runs, threading the
resulting `phaseFolderId` into the dispatch prompt, and refreshing the
run's `README.md` index after the phase completes.

Before dispatching each phase agent (`Agent(design-review)`,
`Agent(commcare-setup)` (inline procedure doc — same rule applies),
`Agent(connect-setup)`, `Agent(ocs-setup)`, `Agent(qa-and-training)`,
`Agent(solicitation-management)`, `Agent(execution-manager)`,
`Agent(closeout)`), the orchestrator MUST:

1. Look up the phase folder slug from `lib/artifact-manifest-roles.ts`
   `PHASE_FOLDERS`:
   - `design` → `1-design`
   - `commcare` → `2-commcare`
   - `connect` → `3-connect`
   - `ocs` → `4-ocs`
   - `qa-and-training` → `5-qa-and-training`
   - `solicitation-management` → `6-solicitation-management`
   - `execution-management` → `7-execution-manager`
   - `closeout` → `8-closeout`

2. Call `drive_create_folder(name='<N>-<phase>',
   parentFolderId=<runFolderId>, findOrCreate=true)`. The
   `findOrCreate=true` mode (default since 0.11.9) reuses an existing
   same-named folder; this is safe to call repeatedly across resumed
   runs.

3. Capture the resulting folder ID as `phaseFolderId`.

4. Dispatch the phase agent with BOTH `runFolderId` AND `phaseFolderId`
   in its prompt. Phase agents pass `phaseFolderId` to their skills as
   the `parentFolderId` for writes.

Skills that write artifacts under the phase folder use `phaseFolderId`
as their write parent. Skills that READ artifacts from earlier phases
need only the `runFolderId` plus the path relative to it (e.g.
`1-design/idea-to-pdd.md`); they walk the folder tree to find the
file.

After a phase completes, regenerate `README.md` with the updated
`phaseStatus` (e.g. `{ design: 'done', commcare: 'in-progress', ... }`)
via `generateRunReadme(runId, phaseStatus)` and write back to
`runs/<runId>/README.md` via `drive_update_file`. The README is the
operator's single-glance view of run state; keep it fresh.

### Current/ shortcut refresh (Phase 3 + Phase 4 completion)

**After Phase 3 completes** — refresh shortcuts pointing at this run's
Phase 3 outputs. For each:

- `connect-opp-summary.md` → `runs/<runId>/3-connect/connect-opp-setup.md`
- `connect-program-summary.md` → `runs/<runId>/3-connect/connect-program-setup.md`

Steps:
1. Resolve the target file ID via `drive_list_folder` on
   `runs/<runId>/3-connect/` and find the matching filename.
2. Ensure `<opp>/current/` folder exists via
   `drive_create_folder(name='current', parentFolderId=<oppFolderId>,
   findOrCreate=true)`.
3. Call `drive_create_shortcut(name='<shortcut-name>',
   parentFolderId=<currentFolderId>, targetId=<resolved-target-file-id>,
   findOrReplace=true)`. The `findOrReplace=true` mode deletes any
   prior same-name shortcut before creating, so each new run cleanly
   overwrites the prior pointer.

**After Phase 4 completes** — same pattern for
`ocs-agent-config.md` → `runs/<runId>/4-ocs/ocs-agent-setup.md`.

The `drive_create_shortcut` MCP atom shipped in 0.13.0.

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
(Training materials moved to Phase 5 (`qa-and-training`) in 0.9.0.)

### Phase 3: Connect Setup
Dispatch to the **connect-setup** agent.
This phase produces: Program configured, Opportunity configured with verification
rules and delivery/payment units. LLO invite-list preparation moved to Phase 8
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

### Phase 5: QA and Training
Dispatch `Agent(qa-and-training)`. The agent runs
`app-screenshot-capture` (executor — runs the smoke recipes from
Phase 2's `app-test-cases.yaml`) → 5 per-artifact training skills in parallel
(`training-llo-guide`, `training-flw-guide`, `training-quick-reference`,
`training-faq`, `training-deck-outline`) → `training-deck-build` (sequential
after deck-outline; skipped if `ACE_TRAINING_DECK_TEMPLATE_ID` unset) →
`training-onboarding-email` (LAST — links by URL to other docs). All
skills read upstream artifacts from Phases 1-4. No 1-1 LLO contact
happens here — that begins in Phase 8.

### Phase 7: Solicitation Management
Dispatch `Agent(solicitation-management)`. The agent runs
`solicitation-create` → `llo-invite` (default run, both auto). Publishes
a solicitation derived from the PDD on labs.connect.dimagi.com via the
`connect-labs` MCP, then emails PDD-named candidate LLOs the public URL
(no-op if the PDD names no candidates — long-term flow).

After this phase completes, `/ace:run` HALTS at the new external-comms
boundary (Phase 7→8). Phase 8 cannot start until
`opp.yaml.selected_llo.org_slug` is populated, which only happens via
the manual `/ace:step solicitation-review` (HITL-gated; calls
`award_response`).

The recurring `solicitation-monitor` skill polls labs for responses
while the solicitation is open; runs OUTSIDE `/ace:run` (cron or manual
dispatch).

### Phase 8: Execution Management
Dispatch to the **execution-manager** agent. Phase 8 entry is gated on
`opp.yaml.selected_llo.org_slug` being populated by Phase 7's
`solicitation-review`.

This phase produces: the awarded LLO onboarded (Connect program-level
invite + ACE onboarding email with widget link), UAT completed,
opportunity activated (go-live), ongoing monitoring active. This phase
has recurring skills (timeline-monitor, flw-data-review,
ocs-chatbot-qa-monitor, ocs-chatbot-eval-monitor) that run on schedule
during the active opportunity.

### Phase 9: Closeout
Dispatch to the **closeout** agent. Triggered when the opportunity reaches its
end date.
This phase produces: Invoices pulled, Jira payment ticket created, LLO feedback
collected, learnings summarized, cycle graded.

## Between Phases

After each phase completes:
1. Update `run_state.yaml` per § Phase Write-Back Contract below
2. **Verify the dispatched phase actually wrote its block** per § Phase
   Write-Back Verifier below (catches drift; orchestrator stubs in a
   minimal block + flips the gate if the agent forgot)
3. In `auto` mode: send status email to admin group, continue
4. In `default` mode: continue silently for Phases 1→2, 2→3, 3→4, 4→5;
   **at the Phase 5→6 transition, pause unconditionally** with a
   Phase-5-complete summary and "ready to begin LLO contact?" prompt;
   for 6→7, pause if any external-comm step still pending review
5. In `review` mode: present summary and wait for approval to continue

## Phase Write-Back Contract

Every phase agent (subagent or procedure doc) MUST update
`run_state.yaml` on completion with the per-phase block shape below.
Without this, `/ace:status` misreports the run state, `opp-eval`'s
phase-rollup walks empty, and resume-after-interrupt logic can't tell
which phases already shipped.

**Required shape.** Each phase writes its own top-level
`phases.<phase-name>` block:

```yaml
phases:
  <phase-name>:
    status: in_progress | done | error
    started_at: <ISO timestamp>            # when the dispatch fired
    completed_at: <ISO timestamp>          # required when status: done
    verdict: pass | proceed | proceed-with-warn | reject | halt-at-…
                                            # phase-specific terminal disposition
    summary_artifact: <Drive fileId>        # required if the phase produces a summary doc
    steps:
      <skill-name>:
        status: done | error | incomplete
        verdict: pass | warn | fail | incomplete | <skill-specific>
        started_at: <ISO>
        completed_at: <ISO>
        artifacts:                          # whatever Drive fileIds the skill produced
          <name>: <fileId>
```

(0.13.116: there is no longer a separate `gates.<name>` flip step.
Pause-point status at runtime is derived from `phases.<phase>.status` +
the per-skill verdict files (`<phase>/<producer>-qa_result.yaml` and
`<phase>/<producer>-eval_verdict.yaml`). The Phase 7→8 halt is gated on
`opp.yaml.selected_llo.org_slug` being non-null, populated by manual
`/ace:step solicitation-review` — that mechanism preserves the HITL
checkpoint without needing a `gates.solicitation-review` field.)

**Use `update_yaml_file` for the patch.** Each phase agent's write
should look like:

```
update_yaml_file({
  fileId: <run_state.yaml fileId>,
  patch: {
    phases: { <phase-name>: { status, started_at, completed_at, verdict, summary_artifact, steps } },
    last_actor: <git config user.email>,
    last_actor_at: <ISO timestamp>,
  },
})
```

`update_yaml_file` does a top-level shallow merge — sibling top-level
keys are preserved automatically. The agent should NOT read the full
`phases:` block, mutate it locally, and write it back; that races with
the orchestrator and other concurrent writers. Patch only the keys
this phase owns.

**Failure modes the contract prevents.**

- Phase agent says "done" in its return summary but the orchestrator's
  `/ace:status` view shows the phase as `pending` (run-state drift —
  observed in turmeric run 20260506-1304 on Phase 2 + Phase 3, filed as
  `jjackson/ace#116`).
- `opp-eval` rollup misses the phase entirely because there's no
  `phases.<phase>.steps.*.verdict` to walk.
- Resume after interrupt re-dispatches a phase that already shipped,
  because the orchestrator can't tell from artifact existence alone
  whether the phase was meant to complete that work or whether it was
  in-progress and crashed.

**Decisions log clause (added 2026-05-08).** Every phase MUST also
append rows to `ACE/<opp>/runs/<run-id>/decisions.yaml` for any
load-bearing default the phase applied that meets the bar criterion
(see [`docs/superpowers/specs/2026-05-08-decisions-log-design.md`](../docs/superpowers/specs/2026-05-08-decisions-log-design.md) §
Scope and `skills/idea-to-pdd/SKILL.md` § Decisions Log Convention §
Bar criterion). Each phase's primary writing skill owns the rows it
writes. The orchestrator stub-fills + warns post-phase if a phase
wrote zero rows AND the calibration set for that phase has any
required rows. PR #1 covers Phase 1 (`idea-to-pdd`); Phase 2–9 writes
ship in PR #3 of the decisions-log series. Schema and YAML helpers
live in `lib/decisions-schema.ts`.

## Phase Write-Back Verifier

After each phase dispatch returns, the orchestrator (i.e., the
top-level Claude Code session running this procedure doc) MUST verify
the dispatched phase wrote its block back. This is the load-bearing
backstop — even if the phase agent's prose says "I updated state",
verify that the bytes landed.

**Procedure.** After each `Agent(<phase>)` dispatch (subagent) or each
inline procedure-doc completion (commcare-setup):

1. `drive_read_file(<run_state.yaml fileId>)`.
2. Check `phases.<phase>.status`. Expected: `done` (or `error` on
   failure paths). If absent or stuck at `pending` / `in_progress`:
   the agent forgot to write back. Fall through to step 3.
3. Write a fallback stub via `update_yaml_file`:

   ```yaml
   phases:
     <phase>:
       status: done                         # or error if the dispatch returned error
       completed_at: <now>
       verdict: <best-guess from agent's return text, or "unknown">
       summary_artifact: <fileId if the agent reported one in its return>
       write_back_warning: |
         Phase agent did not write phases.<phase> block on its own;
         orchestrator filled in this stub. The phase actually completed
         (artifacts in Drive prove it), but per-step verdicts and
         intermediate state are unrecoverable. See agents/ace-orchestrator.md
         § Phase Write-Back Contract.
   ```

4. **Re-render the decisions log gdoc.** After verifying the phase
   wrote back its rows to `decisions.yaml` (see § Phase Write-Back
   Contract § Decisions log clause), invoke `Skill(decisions-render)`
   against the run-id. The renderer produces
   `ACE/<opp>/runs/<run-id>/decisions.gdoc` — a prose Google Doc at
   one stable URL — and is idempotent across re-runs. Capture the
   gdoc's `webViewLink` and inject it into the next pause-time
   summary's `Decisions Log:` line (when a Pause Point fires). The
   renderer is fast (one batchUpdate
   call); failure is `[WARN]` not `[BLOCKER]` — the YAML is the
   source of truth, the gdoc is just the rendering.

5. Continue to the next phase.

This is a NUDGE, not a halt — the run continues. The
`write_back_warning` field surfaces the contract violation for
follow-up (and for `/ace:doctor state-yaml-cruft` to grep on). The
class-level fix is to tighten the agent's `### Completion` section
(see each `agents/<phase>.md` for the contract reference).

**Why "loud-but-non-fatal".** The phase actually shipped its
artifacts to Drive — the run's deliverable is intact. Halting on a
write-back gap would convert a cosmetic issue into a hard failure
that the operator has to manually resume past, which is a worse
operator experience than auto-stub + warning.

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

## Pause Points

`/ace:run` may pause at named points where the next action affects external parties or where a phase boundary needs operator-level review. There is **no separate "gate-brief" artifact** — at each pause, the orchestrator reads the per-skill QA verdict (`<phase>/<producer>-qa_result.yaml`) + eval verdict (`<phase>/<producer>-eval_verdict.yaml`) directly and synthesizes a pause-time summary on the fly. The verdict files are the source of truth; the orchestrator is just the renderer.

**Pause points and per-mode behavior:**

| Pause point | Phase | `default` | `review` | `auto` |
|------|-------|-----------|----------|--------|
| After `idea-to-pdd` | 1 | pause iff any `[BLOCKER]` from QA or eval | always pause | never pause* |
| After `app-deploy` | 2 | pause iff any `[BLOCKER]` | always pause | never pause* |
| After `ocs-chatbot-eval --quick` | 4 | pause iff any `[BLOCKER]` | always pause | never pause* |
| After `llo-invite` | 7 | never pause (passive solicitation invites) | always pause | never pause* |
| **Phase 7→8 boundary** | 7→8 | **always pause** (waits for `selected_llo`) | always pause | always pause |
| Before `llo-onboarding` | 8 | always pause (first 1-1 email to awardee) | always pause | always pause |
| Before `llo-uat` send | 8 | always pause (UAT instructions to awardee) | always pause | always pause |
| Before `llo-launch` | 8 | always pause (opp activation in Connect) | always pause | always pause |
| Before `opp-closeout` | 9 | always pause (Jira payment ticket) | always pause | always pause |

\*`auto` still pauses on `[BLOCKER]` — admins opted into auto mode for speed, not to ship known-broken work. The Phase 7→8 boundary + Phase 8 external-comms + Phase 9 closeout pauses are unconditional in all modes because they affect external parties.

**Synthesizing a pause-time summary.** At each pause, the orchestrator:

1. Reads the per-skill QA + eval verdict files for the upstream step (paths follow `<phase>/<producer>[-qa|-eval]_<artifact>.yaml`). Missing verdicts are fine — skip.
2. Aggregates the verdicts into a brief summary:
   - **Artifact under review:** path + one-line description (pulled from the producer's primary artifact).
   - **What to check:** auto-derived from any QA `failures[]` and eval auto-surfaced concerns.
   - **Severity surface:** any `[BLOCKER]` / `[WARN]` / `[INFO]` from the verdicts (eval has these explicitly; QA failures are always `[BLOCKER]`-equivalent).
3. Presents via `AskUserQuestion` with four options:
   - **Approve** — continue.
   - **Reject** — halt the run; log admin's reason in `comms-log/`.
   - **Iterate** — re-dispatch the upstream skill with the surfaced concerns as input (equivalent to a manual auto-fix loop).
   - **Inspect** — open the artifact path for a deeper look, then re-prompt.

There is no `gates.<name>` field to flip on approve/reject. The phase status (`phases.<phase>.status`) and the per-skill verdicts together carry the audit trail.

**Why no separate gate-brief artifact.** The `<skill>_gate-brief.md` artifact (used pre-0.13.116) was a producer-authored summary that duplicated the QA + eval verdict signal. With the QA/Eval split codified (PRs #146 / #149 / #160), the verdicts ARE the source of truth — the orchestrator can render the same summary from them at pause time. Removing the artifact eliminates a class of drift (gate-brief saying "all clear" while eval verdict shows BLOCKER) and removes coordination overhead between producing skills.

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
  `7-execution-manager/ocs-chatbot-eval_verdict-monitor.yaml`.
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
│   └── opp.yaml                  (display_name, last_run_id, tags, ...)
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
   skip discovery, use that opp. If the folder doesn't exist under
   `ACE_DRIVE_ROOT_FOLDER_ID`, **first check for a typo**: list the
   ACE root, compute Levenshtein distance from the requested slug to
   each existing opp folder name, and:

   - if exactly one existing opp is at distance ≤ 2 (and the requested
     slug is at least 4 characters), surface a one-question
     `AskUserQuestion`: "Did you mean `<best-match>`? [Yes / No, create
     `<requested>` anyway]". On "Yes", switch to the matched opp and
     continue; on "No", proceed to create the new folder.
   - if zero existing opps are at distance ≤ 2, create the new folder
     with no prompt (genuinely new opp).
   - if 2+ existing opps tie at the lowest distance ≤ 2, surface them
     as a multi-option `AskUserQuestion` plus an "Other — create
     `<requested>` as a new opp" option.

   This costs 1 `drive_list_folder` call and catches the
   "tumeric → turmeric" class of typo without a full re-invocation of
   `/ace:run`. Skip the check on review mode only if the operator
   explicitly passed `--no-fuzzy-opp` (currently unsupported; reserve
   the flag name).

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
     State.yaml exists; opp.yaml's last_run_id and runs: list already
     record this run.

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

7. **Update `<opp>/opp.yaml`.** Read it (`drive_read_file`); if missing,
   create with:

   ```yaml
   display_name: <opp>          # default to slug; operator can edit later
   slug: <opp>
   last_run_id: <runId>
   tags: []
   created_at: <ISO timestamp>
   created_by: <email>
   ```

   If present, update only `last_run_id` and append `<runId>` to a
   running list under `runs:` (optional — primarily for ace-web's
   ergonomics; ace-web can also derive it from `runs/`).

   **Concurrency: pair the read+write with `revisionVersion` CAS.**
   `drive_read_file` returns a `revisionVersion` in its result; pass
   that exact string as `ifMatchRevisionId` to the subsequent
   `drive_update_file`. If the update returns
   `Error: revision_conflict: …`, another writer (likely a parallel
   `/ace:run`) modified opp.yaml in between — re-read, re-merge,
   re-write **once**. If a second conflict fires, log it and continue
   (the run is still safe; only the runs list is best-effort). This
   replaces the previous read-merge-overwrite pattern, which silently
   dropped a run-id when two `/ace:run` invocations raced.

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

## Touching State — Operator Capture

**Path note (multi-run layout, v0.11.0+):** `run_state.yaml` lives at
`ACE/<opp>/runs/<run-id>/run_state.yaml`, not at the opp root. The
run-id is established by the orchestrator's "Starting a New
Opportunity" step 3; phase agents and skill dispatches inherit it.
The `/ace:step` bypass path receives `<opp>/<run-id>` from its
positional arg (see `commands/step.md`).

Every skill invocation, whether via `/ace:run` or `/ace:step`, must update
`last_actor` and `last_actor_at` in `run_state.yaml` *before* dispatching the
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

### State-as-canary contract

`run_state.yaml` is the orchestrator's heartbeat. Every skill must
mark its progress so resumption logic can distinguish "in progress"
from "stalled" without inferring from artifact absence.

**Before starting work**, the skill (or the dispatcher invoking it)
writes:

```yaml
phases:
  <phase>:
    <step>: in_progress
last_actor: <git config user.email>
last_actor_at: <ISO timestamp>
```

**On clean completion**, write `<step>: done`.

**On hard failure or timeout**, write `<step>: error` (with optional
`<step>_error: <one-line>` adjacent) — never leave it in `in_progress`.

**Resume agents** that read `run_state.yaml` and find a step in
`in_progress` apply this rule:

- `last_actor_at` ≤ 15 min ago → assume the prior session is still
  alive; re-entering would race. Halt with a clear "another session
  appears to be working this opp" message and the offending field.
- `last_actor_at` > 15 min ago → treat as **dead**, not "still
  running." The skill is idempotent (per § Long-Running Skills —
  No Fake Background Tasks); re-dispatch from the artifact-checkable
  resumption point. Do NOT poll-wait for a phantom completion.

This rule is the single biggest preventer of the
`turmeric-20260503-0835` failure mode: an `in_progress` field that
nobody updates becomes an unbounded waiting loop. The 15-min
threshold balances "let a slow but live skill finish" against "don't
wait on a dead one." Tighten or loosen per skill if needed via a
documented exception in the skill's SKILL.md.
