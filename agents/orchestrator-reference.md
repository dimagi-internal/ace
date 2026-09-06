# ACE Orchestrator — Reference

This doc is the *reference* counterpart to `agents/ace-orchestrator.md`. It catalogs schemas, contracts, lifecycle invariants, and architectural diagrams that the orchestrator's procedure references. The procedure doc tells you WHAT to do; this doc tells you the SHAPE of what you're doing.

If you're executing `/ace:run`, read `agents/ace-orchestrator.md` first. Come here only when the procedure points you at a specific section.

---

## Agent Topology

The architectural rule and full topology table live in `CLAUDE.md § Agent topology` (the canonical source — every session loads it). Summary for the orchestrator's purposes:

- **The forms:** `ace-orchestrator` and `synthetic-data-and-workflows` (Phase 7, `Agent(canopy:ddd)`) are procedure docs read and executed inline by the top-level session; The other ten agents (`idea-to-design`, `scenarios-and-acceptance`, `commcare-setup`, `connect-setup`, `ocs-setup`, `qa-and-training`, `solicitation-management`, `execution-manager`, `closeout`, `ocs-tester`) are subagents dispatched via `Agent(...)` from level 0. Enforced by `test/agents/agent-topology.test.ts` + `test/lib/agent-depth.test.ts` — a subagent doc may dispatch, but every dispatch must be declared in `lib/agent-depth.ts` and the resulting chain must fit `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`.
- **Invocation in the procedure below:** "dispatch the X agent" means a top-level `Agent(X)` call (subagent rows in the CLAUDE.md table) or "read `agents/X.md` and execute it inline" (procedure-doc rows).
- **Why the forms differ:** a subagent may dispatch subagents, so form is a choice about context and about the human gate, not about permission. An inline procedure doc runs in its caller's context and costs no dispatch depth, so the work it nests starts a level higher; the two inline nodes in a run are inline because they own `AskUserQuestion` gates, which are withheld from subagents. Past the depth budget the `Agent` tool is silently withheld rather than erroring. `lib/agent-depth.ts` declares the graph and `test/lib/agent-depth.test.ts` holds the number.

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

# WHO ASKED FOR THIS RUN (optional — a manual /ace:run has no trigger).
# Populated at run init when /ace:run is dispatched from a turn.
triggered_by:
  surface: email|board|manual
  thread_id: <Gmail thread id>   # REQUIRED when surface: email
  requester: <email>
  requested_at: <ISO timestamp>

phases:
  idea-to-design:       # Phase 1
    idea-to-pdd: done|pending|error|dry-run-success|...
    pdd-to-work-order: pending
  scenarios-and-acceptance:  # Phase 2
    pdd-to-test-prompts: done|pending|...
    pdd-to-app-journeys: done|pending|...
  commcare-setup:       # Phase 3
    pdd-to-learn-app: pending
    pdd-to-deliver-app: pending
    app-connect-coverage: pending
    app-deploy: pending
    app-test-cases: pending
    app-release: pending
    app-release-qa: pending
  connect-setup:        # Phase 4
    connect-program-setup: pending
    connect-opp-setup: pending
  ocs-setup:            # Phase 5 — qa/eval split in 0.3.5; deep moved to /ace:qa-deep
    ocs-agent-setup: pending
    ocs-chatbot-qa-quick: pending
    ocs-chatbot-eval-quick: pending
  qa-and-training:        # Phase 6 — added 0.9.0; per-artifact training split 0.10.79–0.10.84; qa-plan retired in shallow/deep QA split
    app-screenshot-capture: pending
    training-llo-guide: pending
    training-flw-guide: pending
    training-quick-reference: pending
    training-faq: pending
    training-deck-generate: pending
    training-deck-render: pending         # skipped if ACE_TRAINING_DECK_TEMPLATE_ID unset
    training-onboarding-email: pending    # last — links to other docs by URL
  synthetic-data-and-workflows:  # Phase 7
    synthetic-narrative-plan: pending
    synthetic-data-generate: pending
    synthetic-workflow-seed: pending
    synthetic-workflow-polish: pending
    synthetic-walkthrough-spec: pending
    synthetic-walkthrough-run: pending    # canopy:walkthrough scores per scene
    synthetic-summary: pending            # pure aggregator
  solicitation-management:  # Phase 8 — added 0.12.0
    solicitation-create: pending
    llo-invite: pending               # repurposed 0.12.0: emails solicitation URL to PDD-named candidates
    solicitation-monitor: pending     # recurring (post-/ace:run, while solicitation open)
    solicitation-review: pending      # manual (HITL gate before award_response; only path that unblocks Phase 9)
  execution-management: # Phase 9 (renamed from llo-management 0.12.0)
    llo-onboarding: pending           # reads phases.solicitation-management.products.selected_llo (legacy fallback opp.yaml.selected_llo)
    llo-uat: pending
    llo-launch: pending
    timeline-monitor: pending         # recurring
    flw-data-review: pending          # recurring
    ocs-chatbot-qa-monitor: pending   # recurring
    ocs-chatbot-eval-monitor: pending # recurring
  closeout:             # Phase 10 (was Phase 9)
    opp-closeout: pending
    llo-feedback: pending
    learnings-summary: pending
    cycle-grade: pending

```

**Shape note.** The `phases:` map above is a LEGACY flat illustration —
it shows which *steps* each phase covers, not the literal nesting ACE
writes today. The authoritative per-phase block shape is
`phases.<phase>.{status, started_at, completed_at, verdict,
summary_artifact, steps: {<skill>: {status, verdict, artifact, ...}}}`
— see § Phase Write-Back Contract. Read the block above as a step
inventory, not as the on-disk schema.

(0.13.116: the legacy `gates:` top-level field was removed. Pause-point
status is derived from `phases.<phase>.status` + per-skill verdict
files at runtime; no separate field carries it. See § Pause Points.)

**Per-phase `products:` block.** Each `phases.<phase>` may carry an
`products:` map of typed state produced during that phase — Connect IDs
(`phases.connect-setup.products.connect`), OCS chatbot
(`phases.ocs-setup.products.ocs_chatbot`), solicitation + selected_llo
(`phases.solicitation-management.products.*`), synthetic
(`phases.synthetic-data-and-workflows.products.synthetic`). **Per-run
only** — every run is independent and creates its own entities. No
run reads from or writes to another run's `run_state.yaml`. Each
run's `products.*` is the complete record of that run.

The only cross-run reuse surface is `opp.yaml`, which holds opp-level
identifiers (Connect program UUID + URL + connect_int_id) that survive
across runs. Each run's `connect-opp-setup` records a copy of the
program identifiers into its own `products.connect.program` so the
run state file is self-contained for forking / debugging.

See `docs/superpowers/specs/2026-05-10-state-consolidation.md` for
historical context (the original design had cross-run inheritance via
a seed step; that was reverted in favour of run independence).

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
   keys set to `pending`. (Pre-0.13.116 init also seeded a top-level
   `gates:` map; that field was removed when the gate concept was
   replaced by Pause Points — see § Pause Points.)
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
- This opp's phase + step status, mode.
- Pointers to this opp's artifacts (Drive file IDs, app IDs, opp UUID,
  experiment ID).
- Open questions that are **about this opp** — pricing for this
  funder, country list for this rollout, LLO contacts for this program.
- Eval verdicts for this opp's runs.
- `phase_X_backlog` items that block **this opp** — a stuck Phase 4,
  a stub LLO invite that needs follow-up, a deferred screenshot capture.

**Out of scope** (do NOT write to `run_state.yaml` — they belong elsewhere):
- Bug reports about MCP atoms, skills, or tooling (write to GitHub
  issues on the ACE repo's `origin`; mention them in the resolving PR's
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

## Per-Phase Folder Lifecycle

Per-run artifacts live under `runs/<runId>/<N>-<phase>/...` (the 0.13.0
phase-prefixed layout). The orchestrator is responsible for materializing
each `<N>-<phase>/` folder before its phase agent runs, threading the
resulting `phaseFolderId` into the dispatch prompt, and refreshing the
run's `README.md` index after the phase completes.

Before dispatching each phase agent (`Agent(idea-to-design)`,
`Agent(scenarios-and-acceptance)`,
`synthetic-data-and-workflows` (inline procedure doc — same rule applies),
`Agent(connect-setup)`, `Agent(ocs-setup)`, `Agent(qa-and-training)`,
`Agent(solicitation-management)`, `Agent(execution-manager)`,
`Agent(closeout)`), the orchestrator MUST:

1. Look up the phase folder slug from `lib/artifact-manifest-roles.ts`
   `PHASE_FOLDERS`. **`PHASE_FOLDERS` in TypeScript is the source of
   truth — if this prose copy ever drifts, the TypeScript wins.**
   (Drift between this listing and the TS const has shipped at least
   once; if you find new drift, fix it here AND consider promoting the
   prose listing to a generated table.):
   - `design` → `1-design`
   - `commcare` → `3-commcare`
   - `connect` → `4-connect`
   - `ocs` → `5-ocs`
   - `qa-and-training` → `6-qa-and-training`
   - `synthetic-data-and-workflows` → `7-synthetic`
   - `solicitation-management` → `8-solicitation-management`
   - `execution-management` → `9-execution-manager`
   - `closeout` → `10-closeout`

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

**The README refresh is automatic — do NOT do it by hand.**
`verify_phase_artifacts` (call #3 of the boundary fence, unconditional on
every phase completion) rewrites `runs/<runId>/README.md` itself: it already
holds `runFolderId` and already reads the run's `run_state.yaml`, so it derives
the phase-status map via `lib/run-readme.ts::phaseStatusFromRunState` and
upserts the file. It reports `readme_refreshed: true|false` in its payload;
`false` (plus `readme_note`) means the refresh failed and never affects the
artifact verdict.

This replaced a prose instruction to "regenerate `README.md` with the updated
`phaseStatus` … after a phase completes", which required the orchestrator both
to remember an extra call and to hand-assemble the status map. On
`spark-facilitator/20260813-2126` neither happened: 8 phases completed and the
README shipped 96 rows all reading `pending`. `render_run_readme` remains for
RUN-INIT (step 7b) only.

### Phase-agent defensive folder contract (every phase agent's Step 0)

The orchestrator-side materialization above is the primary path, but it
is **not** the only writer of the `<N>-<phase>/` folder, and historically
the orchestrator dispatch has not reliably pre-created the folder or
threaded `phaseFolderId` into the prompt. So **every phase agent MUST
defensively own its own artifact folder as the first step of its
workflow** — never assume the orchestrator handed you a `phaseFolderId`.
Each phase agent's workflow opens with:

1. **`### Step 0: Phase folder setup (do this FIRST)`** — resolve-or-create
   the phase's `<N>-<phase>/` subfolder before any producer skill runs:
   `drive_create_folder({name: '<N>-<phase>', parentFolderId: <run-folder id>, findOrCreate: true})`
   (idempotent; returns the existing folder id on re-runs and resumes).
   Use the slug from the `PHASE_FOLDERS` table above.
2. **Pass THAT folder id to every producer skill** as its artifact
   `parentFolderId` — the producer outputs, QA + eval verdicts, and the
   phase summary all write into the `<N>-<phase>/` folder. **Never hand a
   producer the run-folder id as the write parent.** The only writes that
   stay at the run-folder root are the run-level files the orchestrator
   owns (`run_state.yaml`, `inputs-manifest.yaml`, `README.md`) plus
   `decisions.yaml` / `decisions.gdoc`.

**Why this is a per-agent requirement, not just orchestrator advice:** a
producer handed the run-folder id lands every artifact flat at the run
root, which fails the Phase boundary's `verify_phase_artifacts` (it walks
`<N>-<phase>/`) and forces the orchestrator to relocate the files
post-hoc. This class has now shipped on at least three phases — Phase 1
(jjackson/ace#623, bednet-spot-check/20260601-0651), Phase 8
(jjackson/ace#727), and Phase 2 (jjackson/ace#791,
bednet-spot-check/20260616-0618) — each fixed one agent at a time. The
durable fix is structural: **every** phase agent carries the Step 0 block,
so a new phase or a refactor can't silently drop it. Agents that carry it:
`idea-to-design`, `scenarios-and-acceptance`, `connect-setup`, `ocs-setup`,
`qa-and-training`, `synthetic-data-and-workflows`, `solicitation-management`
(and `commcare-setup` writes into `3-commcare/`). If you
add a phase agent, add its Step 0.

### Current/ shortcut refresh (Phase 4 + Phase 5 completion)

**After Phase 4 completes** — refresh shortcuts pointing at this run's
Phase 4 outputs. For each:

- `connect-opp-summary.md` → `runs/<runId>/4-connect/connect-opp-setup.md`
- `connect-program-summary.md` → `runs/<runId>/4-connect/connect-program-setup.md`

Steps:
1. Resolve the target file ID via `drive_list_folder` on
   `runs/<runId>/4-connect/` and find the matching filename.
2. Ensure `<opp>/current/` folder exists via
   `drive_create_folder(name='current', parentFolderId=<oppFolderId>,
   findOrCreate=true)`.
3. Call `drive_create_shortcut(name='<shortcut-name>',
   parentFolderId=<currentFolderId>, targetId=<resolved-target-file-id>,
   findOrReplace=true)`. The `findOrReplace=true` mode deletes any
   prior same-name shortcut before creating, so each new run cleanly
   overwrites the prior pointer.

**After Phase 5 completes** — same pattern for
`ocs-agent-config.md` → `runs/<runId>/5-ocs/ocs-agent-setup.md`.

The `drive_create_shortcut` MCP atom shipped in 0.13.0.

## Fork Points — Per-Opp vs Per-Run State

When forking a run (re-running phases or skills from a prior run, in
parallel or in isolation), every Drive artifact is either **per-opp**
(one copy, shared across all runs of the opp) or **per-run**
(sequestered under `runs/<run-id>/`, copied or re-derived per fork).
Confusing the two breaks forks: copying a per-opp file produces two
divergent calibration sources; failing to copy a per-run file leaves
the new run's verifier looking at the prior run's verdicts.

**Per-opp — DO NOT copy when forking; share across all runs.** All
declared in `lib/artifact-manifest.ts` with `scope: 'opp'` (or
implicitly via path lacking a `runs/` prefix):

| Path | Role |
|---|---|
| `ACE/<opp>/opp.yaml` | Identity (`display_name`, `slug`, `tags`, `created_at`, `created_by`) plus `connect.program.{id, url, connect_int_id}` — the durable Connect program reference reused across every run of the opp. Written by `connect-program-setup` on first create; subsequent runs read this to skip program-create. Every other piece of evolving state (Connect opportunity, OCS chatbot, solicitation, selected_llo, synthetic) is per-run and lives only in the producing run's `run_state.yaml.phases.<phase>.products.*`. Older opps may still carry stale `solicitation`/`selected_llo`/`synthetic`/`connect.opportunity`/`ocs_chatbot` blocks here from earlier dual-write iterations — no longer read or written; operator-cleaned-up when picking a release-candidate run. |
| `ACE/<opp>/inputs/` | Human-curated source pack. Read-only — every run's Phase 1 reads via the run-root inputs-manifest. |
| `ACE/<opp>/eval-calibration/known-issues.md` | Ground-truth catalogue every `-eval` rubric reads. Calibration survives across runs. |
| `ACE/<opp>/open-questions.md` | Deferred questions that accrete across runs until answered. |
| `ACE/<opp>/current/` | Shortcut folder pointing at the latest run's Phase 4/4 outputs (refreshed at phase completion — see § Current/ shortcut refresh). |

**Durable vs refreshed fields WITHIN the reused Connect program**
(jjackson/ace#1078). "Durable" applies to the program's *identity*, not
its *content*:

| Program field | Scope | Why |
|---|---|---|
| UUID (`id`), `organization_slug`, `delivery_type`, `currency`, `country`, `name` | **Durable per-opp** — never touched on reuse | Identity + reuse-lookup key; `connect_update_program` does not even accept delivery_type/currency/country |
| `description`, `budget`, `start_date`, `end_date` | **Refreshed per-run** — re-derived from the current run's PDD | Authored from the *creating* run's PDD; a later run's PDD can contradict the live, LLO-facing text (e.g. an enforced GPS gate the current PDD forbids). `connect-program-setup` § Step 3a reconciles via `lib/program-reconcile.ts` and updates (or `[WARN]`s per diverging field). Budget is a ceiling: Step 4a headroom keeps it *above* the PDD figure by design, so only live < PDD counts as divergence |

**Per-run — under `ACE/<opp>/runs/<run-id>/`; copy or re-derive when
forking:**

| Path | Role |
|---|---|
| `runs/<run-id>/run_state.yaml` | Lifecycle state — phase/step pointer, mode, `last_actor`, timestamps. New file at each new run-id. |
| `runs/<run-id>/README.md` | Per-run index. Written at run-init via `render_run_readme`, then refreshed automatically by `verify_phase_artifacts` at every phase boundary (derived from `run_state.yaml` — never hand-assembled). |
| `runs/<run-id>/inputs-manifest.yaml` | Frozen pointer-set captured at run start (`inputs/` file_ids). Snapshots that run's view of the source pack. |
| `runs/<run-id>/<N>-<phase>/<producer>.md` | Producer artifacts (PDDs, app summaries, training docs, screenshots, etc.). |
| `runs/<run-id>/<N>-<phase>/<producer>_verdict[-<mode>].yaml` | Producer self-evaluation (when the producing skill self-evaluates). |
| `runs/<run-id>/<N>-<phase>/<producer>-eval_verdict[-<mode>].yaml` | Eval-side judgment from the matching `*-eval` skill. |
| `runs/<run-id>/<N>-<phase>/<producer>_transcript[-<mode>].md` | QA-captured evidence (chatbot transcripts, etc.). |
| `runs/<run-id>/<N>-<phase>/<producer>_comms-log[-<mode>].md` | Reject-pause reasons, dry-run logs. |

**No top-level `verdicts/`, `gate-briefs/`, or `comms-log/`
directories.** Verdicts and comms-logs live next to their phase work
inside `<N>-<phase>/`. The `<skill>_gate-brief.md` artifact
(pre-0.13.116) is gone — the orchestrator synthesizes pause-time
summaries from verdict files at runtime (see § Pause Points). Any
legacy opp-level folders from older opps are read-only artifacts and
no longer written.

### Forking recipes

**Fork at phase boundary (today).** Re-run a phase (and everything
downstream) from a prior run's products:

1. Reuse the existing per-opp files (`opp.yaml`, `inputs/`,
   `eval-calibration/`, `open-questions.md`) — do not copy. The
   Connect program reference at `opp.yaml.connect.program` is the
   only cross-run identity that survives — the new run reads it and
   skips program-create. Everything else the new run produces fresh.
2. Mint a new run-id (`YYYYMMDD-HHMM` per § State Schema), create
   `runs/<new-run-id>/` and seed `run_state.yaml` per the defensive
   init in § State Schema.
3. For each upstream phase you want to keep, copy
   `runs/<prior-run-id>/<N>-<phase>/` into the new run's folder. Mark
   those phases `done` in the new `run_state.yaml`. Also copy the
   relevant `phases.<phase>.products.<block>` from the prior run's
   `run_state.yaml` into the new run's `run_state.yaml` so the new
   run's state is self-contained (no cross-run reads at runtime).
4. Phases you re-run will write fresh verdicts/transcripts/producer
   artifacts under the new run-id; the Producer Artifact Verifier
   (§ Producer Artifact Verifier) will check against the new
   run-folder's `<N>-<phase>/` only.

**Fork at skill boundary (future).** Re-run a single skill within a
phase without re-running the whole phase:

1. Delete the skill's `*_verdict*.yaml`, `*_transcript*.md`,
   `*_comms-log*.md`, and producer artifact under
   `runs/<run-id>/<N>-<phase>/`.
2. Set `phases.<phase>.<skill>: pending` in `run_state.yaml`.
3. The Phase Write-Back Verifier (§ Phase Write-Back Contract) will
   treat the skill as not-yet-completed and re-execute. Downstream
   skills in the same phase that already ran will NOT auto-rerun —
   delete their artifacts too if their inputs depended on the
   re-run skill's outputs.

**Skill-fork caveat.** External side effects (Connect program/opp
mutations, OCS chatbot deploys, HQ app uploads, LLO emails) are NOT
captured by the per-run folder. A skill-fork that re-runs an
external-mutation skill will either no-op (if the upstream atom is
idempotent — most are; see § External Mutations — Verify After
Create) or compound (if not). The producer-artifact verifier won't
catch this; the operator owns that judgment.

## Producer Artifact Verifier

After each phase completes (and write-back is verified), the
orchestrator MUST confirm every dispatched step actually produced the
files it declares in the artifact manifest. This is the structural
backstop for § Skill Invocation Discipline: even if the orchestrator
shortcuts a producer skill, the discipline violation surfaces at the
producing phase boundary instead of cascading into a downstream
consumer's pre-flight.

**Single-tool implementation:** `verify_phase_artifacts(runFolderId,
phase)` — a gdrive-server MCP tool that wraps
`lib/phase-closeout.ts::verifyPhaseArtifacts`. Walks the phase
subfolder under `runFolderId` two levels deep, diffs against every
`required: true` run-level entry the manifest declares for that
phase, and returns `{phase, ok, missing[], present_count,
expected_count, optional_present_count, summary}` where each
`missing` entry carries `{path, producedBy, description}`. The
boundary fence (`ace-orchestrator.md § Phase boundary fence`) calls
it in the parallel block alongside `classify_phase_writeback`, and
branches on `verify.ok=false` to silent-dispatch the missing
producer(s). `summary` is a narration-ready one-liner ("all N
required artifacts found (+M optional)") — echo it verbatim rather
than pairing `present_count/expected_count` into a fraction, since
`present_count` counts every file in the folder and `expected_count`
counts only the required set, so the ratio routinely exceeds 1.

**Products-level companion: `verify_phase_products(fileId, phase)`.**
`verify_phase_artifacts` checks Drive *files*; `verify_phase_products`
checks the run_state *typed handoffs* — the `phases.<phase>.products.<block>`
blocks ace-web's summary (`apps/opps/summary.py`) and downstream phases
read. Wraps `lib/phase-products-schema.ts::classifyPhaseProducts` against the
single-source schema (generated to `docs/phase-products-schema.json`, which
ace-web reads). Returns `{phase, status, ok, mode, issues[]}`: `mode:complete`
on a `done` phase (shape + required-key completeness), `mode:fragment`
in-flight (shape only), `mode:skipped` for phases with no products contract.
The boundary fence runs it as the third parallel check (alongside
`classify_phase_writeback` + `verify_phase_artifacts`) and branches on
`products.ok=false`. It catches the blank-summary-section drift class
(wrong nesting like `products.opportunity` vs `products.connect.opportunity`,
or a required handoff key never written) that neither of the other two sees
(jjackson/ace#705). Takes the run_state phase name (like
`classify_phase_writeback`), NOT the manifest short key.

**Why one tool, not a hand-rolled procedure.** A pre-PR-516 version
of this section walked the manifest in prose: list folder → call
`artifactsProducedBy(<skill>)` → diff. That's a 3-step model dance
prone to "LLM-pattern-matched-the-wrong-set" drift — and it was the
proximate cause of the bednet-spot-check 20260525-2013 missed-evals
incident (13 declared eval verdicts silently absent because the LLM
running each phase subagent skipped the dispatch and the boundary
had no deterministic signal). Bundling the dance into a single tool
that returns structured `{ok, missing[]}` makes the gate as hard
to drift past as `classify_phase_writeback` already is for
`run_state.yaml` shape.

**Skips.** Entries with `required: false` are not checked — they're
declared in the manifest for traceability but not for enforcement.
Templated paths (`<persona>` placeholders, dated `YYYY-MM-DD`
patterns) are pinned to `required: false` until the closeout gains
wildcard match support.

**Recovery message** the orchestrator should emit when an item
remains missing after the cap of 2 silent-dispatch attempts:

> `[BLOCKER]` Phase `<phase>` closeout: required artifact `<path>`
> not present after retries. Producer: `<producedBy>`. Likely cause:
> orchestrator inlined an artifact instead of invoking the skill
> (see § Skill Invocation Discipline). Recovery:
> `/ace:step <producedBy> <opp>/<run-id>` and re-run the orchestrator
> from this point.

**Why halt rather than warn.** A missing required artifact at a phase
boundary means the orchestrator's record of "what shipped" disagrees
with the on-disk reality. Continuing past that point hands divergent
state to downstream phases, which compounds the diagnosis cost. The
blocker message names the producing skill and gives the one-liner
recovery — `/ace:step` will re-run the producer cleanly because skills
are idempotent.

## The triggering thread is state, not a note (ace#1057)

A run dispatched from a turn is a **promise to a person**. Until #1057 it had
no structural link back to the thread that asked for it: run
`hh-poverty-targeting/20260728-0705` recorded its trigger only inside a
free-text `notes` entry ("Triggered by Jon on thread 19f86579142e6ba5"), which
nothing can read reliably.

The operating model already treats `thread_id` as **the routing key** for
inbound — `email-communicator` step 7 writes it to the comms-log and
`inbox-triage` matches on it. That edge was inbound-only, so the outbound
direction did not exist.

**The cost is measured.** Sophie Feintuch, 2026-07-29, thread
`19f86579142e6ba5`: *"Just checking if ACE is still working on this?"* — sent
while the run she was waiting for had been running two days and had completed
its last phase a few hours earlier. The failure is silent and always points the
same way: the person waiting concludes we stopped working.

**Close-out obligation.** When `triggered_by.thread_id` is set and the run
reaches a terminal state, call `pendingCloseoutNotice`
(`lib/triggering-thread.ts`), write the returned draft into the run's
comms-log, and surface it as an explicit **pending outbound** in the close-out
report.

- **Drafted, never sent.** Outbound stays approval-gated (review posture) and
  `bin/ace-email` remains the only send path. This adds a visible parked item,
  not an autonomous send.
- **A HALTED run still drafts.** Silence is the failure mode, not bad news —
  "Phase 8 is waiting on LLO selection" serves the counterpart far better than
  two days of nothing.
- **Nothing is drafted mid-run.** A progress ping is noise, and noise is how a
  real notice gets ignored.

"Remember to email the requester" is exactly the class of instruction that
fails under load — a Phase-8 halt at 13:55 and a Phase-7 completion at 15:45
are the moments nobody is thinking about the inbox. A drafted artifact makes
the omission visible instead of invisible.

## Phase Write-Back Contract

Every phase agent (subagent or procedure doc) MUST update
`run_state.yaml` on completion with the per-phase block shape below.
Without this, `/ace:status` misreports the run state, `opp-eval`'s
phase-rollup walks empty, and resume-after-interrupt logic can't tell
which phases already shipped.

**Source-of-truth implementation:** `lib/run-state-validator.ts` exports
`validateRunState(parsed)` (returns structured `{valid, errors, warnings}`)
and `classifyPhaseWriteBack(parsed, phaseName)` (returns one of
`'ok' | 'missing' | 'in_progress' | 'error' | 'blocked' | 'skipped' |
'malformed'`). Tests pin
every shape invariant the prose below describes — if you change either,
update the other. The orchestrator's silent-dispatch retry (§ Auto-retry
silent Agent dispatches in `ace-orchestrator.md`) treats `'missing'`,
`'in_progress'`, and `'malformed'` as retry triggers; `'error'` is a
real phase failure that halts.

**The status enums, stated inline (do not guess).** Writing a
plausible-but-unlisted word is not a typo class — it is a *re-dispatch* class:
`classify_phase_writeback` returns `malformed` for anything off these lists,
and the orchestrator reads `malformed` as "the agent claimed success but did
not write properly" and re-runs the whole phase. Two live examples cost a full
Phase-1 re-run each (`complete` instead of `done`, ace#992) and a Phase-3
misreport (`partial`, ace#1139).

| Level | Legal values |
|---|---|
| `phases.<phase>.status` | `pending` · `in_progress` · `done` · `complete`¹ · `partial`² · `error` · `blocked` · `skipped` |
| `phases.<phase>.steps.<step>.status` | `pending` · `in_progress` · `done` · `complete`¹ · `incomplete` · `partial`² · `error` · `skipped` · `deferred` |

¹ `complete` is an accepted **legacy synonym** for `done` at both levels —
accepted so an older run does not classify as `malformed`, but it emits a
validator warning. Write `done`. (Before ace#992 it was accepted at step level
and by `verify_phase_products`, and rejected at phase level: the same literal
string returned `ok: true` from two boundary fences and `malformed` from the
third on one run.)

² `partial` — see § `partial`: a phase that shipped but parked something, below.

**Required shape.** Each phase writes its own top-level
`phases.<phase-name>` block:

```yaml
phases:
  <phase-name>:
    status: in_progress | done | partial | error   # full enum in the table above
    started_at: <ISO timestamp>            # when the dispatch fired
    completed_at: <ISO timestamp>          # required when status: done | partial
    verdict: pass | proceed | proceed-with-warn | reject | halt-at-… | closed
                                            # phase-specific terminal disposition
                                            # `closed` is reserved for Phase 10 (closeout) —
                                            # terminal-phase synonym for `pass`
                                            # a `partial` phase names the gap here,
                                            # e.g. partial-producer-deferred
    summary_artifact: <Drive fileId>        # required if the phase produces a summary doc
    steps:
      <skill-name>:
        status: done | error | incomplete
        verdict: pass | warn | fail | incomplete | <skill-specific>
        started_at: <ISO>
        completed_at: <ISO>
        artifact: <relative path>           # REQUIRED when status: done — the primary artifact.
                                            # Any `*_artifact` key satisfies this:
                                            # summary_artifact / verdict_artifact /
                                            # catalog_artifact are what producers write and
                                            # what the validator accepts (ace#1293).
        file_id: <Drive fileId>             # REQUIRED when status: done — Drive file ID.
                                            # This is the `id` the create call ALREADY returned;
                                            # it is free to keep and is what ace-web links.
        artifacts:                          # additional Drive fileIds if the skill produces multiple
          <name>: <fileId>
```

**`artifact` is a family, not a literal key (ace#1293).** Every SKILL.md
Products section and every write-back example here models
`summary_artifact` / `verdict_artifact` / `catalog_artifact`, and that is what
agents write — so `validate_run_state` accepts **any** `*_artifact` key as the
step's pointer. It previously demanded a bare `artifact` and warned on all 18
`done` steps of a run with **zero errors**, across five phases and three
different code paths. A 100%-uniform miss is a contract gap, not a run defect.

**`file_id` is still owed, and it is nearly free.** ace-web needs a Drive id to
link (without it every step renders as an unfilled circle) and the per-step
Producer Artifact Verifier needs something to check. Every skill already holds
the `drive_create_doc_from_markdown` / `drive_create_file` response, whose `id`
is exactly this value — it is discarded today. Keep it. The validator reports
missing `file_id` **once per phase** with the step names rather than once per
step, because a warning list that is always 18 long is one nobody reads.

### `partial` — a phase that shipped but parked something

`partial` is a **terminal** phase status: *the phase is finished and its
downstream-facing handoff is final, but at least one declared producer or
`-eval` step did not ship.* It is what the verdict-gate rule in every phase
agent's § Completion mandates (`agents/commcare-setup.md` is the canonical
prose) — `done` overstates it, and `blocked`/`error` would wrongly halt
downstream phases that don't depend on the parked artifact.

Canonical shape:

```yaml
phases:
  commcare-setup:
    status: partial
    completed_at: <ISO>
    verdict: partial-producer-deferred      # or partial-evals-skipped,
                                            # passed-with-deferred-evals, …
                                            # the verdict NAMES the unshipped step
    status_note: >-
      app-test-cases shipped recipes/journey-learn.yaml; the Deliver smoke
      recipe is parked on ace#1081 + ace#1138.
    steps:
      app-test-cases:
        status: incomplete                  # or partial (synonym at step level)
```

How it classifies at all three boundary fences — they agree by construction:

| Fence | Result on a `partial` phase | Why |
|---|---|---|
| `validate_run_state` | **valid** | `partial` is in both enums |
| `classify_phase_writeback` | **`ok`** — terminal, NOT a retry trigger | the write-back is correct and the phase is finished; re-running would not un-park the producer |
| `verify_phase_products` | `{status: 'partial', mode: 'complete'}` — the **strict** required-key check runs | `partial` may park ARTIFACTS; it may never park the typed `products` handoff |
| `verify_phase_artifacts` | reports the parked files in `missing[]` | this is the loud channel for the gap — the artifact fence, not the status |

Read `classify='ok'` as "nothing to re-dispatch", not "the phase was good":
a `done` phase with `verdict: fail` has always returned `ok` too. Quality is
carried by `verdict`; the hole is carried by `verify_phase_artifacts.missing[]`
and the `status_note`. `partial` was deliberately NOT given its own
classifier return value — the return set is enumerated in the
`classify_phase_writeback` atom description, in `ace-orchestrator.md`'s
boundary-fence branch table, and in `agents/iterate-loop.md`'s clean gate, so a
new member would immediately become the next contract that disagrees with
itself. `partial` at step level is a synonym of `incomplete`.

**When NOT to use `partial`:** if the parked producer owns a *required*
`products` key (see `REQUIRED_PRODUCT_KEYS` in `lib/phase-products-schema.ts` —
e.g. `connect.opportunity.url`), `verify_phase_products` fails and the fence
heals or halts, exactly as it would on a `done` phase. That is intended: a gap
downstream cannot proceed past is `blocked`, not `partial`.

**`artifact` is required on every `status: done` step.** A step entry
with `status: done` but no `artifact` field renders as an unfilled circle
in ace-web (the UI keys the completion indicator on artifact presence,
not status). This is not cosmetic — it also means the Producer Artifact
Verifier cannot check whether the file actually landed on Drive. If a
step genuinely produces no file (e.g. `app-release` mutates HQ state
but doesn't write a standalone doc), write a one-line summary to Drive
and reference it. The cost of a trivial summary file is near-zero; the
cost of a missing `artifact` field is a silent gap in the run's audit
trail.

**Why:** `malaria-itn-app/20260523-0750` Phase 3 had `app-connect-coverage`
and `app-release` recorded as `status: complete, verdict: pass` with no
`artifact` field. ace-web rendered both as unfilled circles (5/7 done).
The steps did run — the orchestrator just didn't write the reference.

(0.13.116: there is no longer a separate `gates.<name>` flip step.
Pause-point status at runtime is derived from `phases.<phase>.status` +
the per-skill verdict files (`<phase>/<producer>-qa_result.yaml` and
`<phase>/<producer>-eval_verdict.yaml`). The Phase 8→9 halt is gated on
`selected_llo.org_slug` being non-null
(`phases.solicitation-management.products.selected_llo.org_slug` in the
current run's `run_state.yaml`, with legacy `opp.yaml.selected_llo.org_slug`
fallback until cleanup PR e), populated by manual
`/ace:step solicitation-review` — that mechanism preserves the HITL
checkpoint without needing a `gates.solicitation-review` field.)

**Use `update_yaml_file` with `merge: 'two-level'` for the patch.**
Each phase agent's write should look like:

```
update_yaml_file({
  fileId: <run_state.yaml fileId>,
  patch: {
    phases: { <phase-name>: { status, started_at, completed_at, verdict, summary_artifact, steps } },
    last_actor: <git config user.email>,
    last_actor_at: <ISO timestamp>,
  },
  merge: 'two-level',
})
```

**Why `two-level`, not the default `shallow`.** `update_yaml_file`'s
default `shallow` mode replaces each top-level key wholesale —
patching `phases: { 'idea-to-design': {...} }` would clobber every
other phase's entry under `phases:`, which is exactly the wrong
outcome when each phase agent owns one entry. `merge: 'two-level'`
recurses one level into object-valued top-level keys (`phases:`), so
each phase's patch leaves sibling phases' blocks intact. The
optimistic-concurrency CAS retry inside `update_yaml_file` handles
the race between concurrent writers (a second writer's first attempt
hits `revision_conflict`, re-reads, re-merges, re-writes once).
Top-level scalar keys (`last_actor`, `last_actor_at`) still replace
as expected — `two-level` only recurses where both base and patch
have an object at that key.

Phase agents MAY also use `update_yaml_file` with the default
`shallow` mode for one-shot whole-subtree replacements of a top-level
key. The contract above is specifically for incremental run_state.yaml
writes during a `/ace:run`.

**Writing `phases.<phase>.products.<block>`.** Products nest three
levels deep (`phases` → `<phase>` → `products` → `<block>`). A patch
like `phases: { <phase>: { products: { <block>: {...} } } }` is a
*partial* patch of the phase child — it does NOT resend the phase's
`status`/`steps`. **Use `merge: 'deep'` for these, never `two-level`.**
`two-level` replaces the entire `<phase>` child wholesale, silently
dropping `status`/`steps` and any sibling `products.<other-block>`
(the #572/#587 lost-update footgun). `deep` recursively merges at every
depth, so the partial products patch preserves every sibling. Two cases:

- **Single-writer block.** One skill produces the whole block (e.g.
  `connect-opp-setup` owns `products.connect`,
  `solicitation-create` owns `products.solicitation`). The skill
  accumulates in-memory through its steps and writes the consolidated
  block once at end-of-skill — via `merge: 'deep'`, so the write does
  not clobber the phase's `status`/`steps` set by the orchestrator (this
  is exactly the case that bit `app-deploy` on malaria-rdt 20260531-0739).
- **Multi-writer block.** Several skills produce different sub-keys
  of the same block within the same run (e.g. `products.synthetic` is
  written by `synthetic-data-generate` (top-level fields +
  `labs_opp_id`), `synthetic-workflow-seed` (`workflows.*`), and
  `synthetic-walkthrough-run` (`walkthroughs[]`)). With `merge: 'deep'`
  each writer's partial patch merges in cleanly, preserving the other
  writers' sub-keys automatically — no in-memory read-modify-write is
  required to protect siblings (it remains harmless belt-and-suspenders).
  The `update_yaml_file` CAS retry handles concurrent writers across
  skills within the same run.

(`two-level` is still correct for the orchestrator's own phase-completion
write, which resends the phase's COMPLETE child block — status, steps,
verdict, AND products — in one patch. The rule is: `two-level` only when
you resend the complete child; `deep` for every partial patch.)

Either way, every read and every write operates only on the current
run's `run_state.yaml`. Cross-run reads are not allowed.

Do NOT pair a manual `drive_read_file` + `drive_update_file` to
read-modify-write `run_state.yaml` from the agent — `update_yaml_file`
already does the read internally and its CAS retry is the
race-correctness mechanism. Skipping the tool to do it by hand
re-introduces the lost-update class of bug.

**Failure modes the contract prevents.**

- Phase agent says "done" in its return summary but the orchestrator's
  `/ace:status` view shows the phase as `pending` (run-state drift —
  observed in turmeric run 20260506-1304 on Phase 3 + Phase 4, filed as
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
required rows. Schema and YAML helpers live in `lib/decisions-schema.ts`.

**Run-init ingest — what a new run inherits (added 2026-08-27).** A new
run does NOT share a ledger with its predecessor; `decisions.yaml` stays
per-run. At run-init the orchestrator calls
`lib/decisions-ingest.ts::ingestPriorRun` with the **immediately-prior
run only**, plus the accumulated `human-decided` set. What it inherits is
weighted by WHERE the decision came from, never by how recent it is:

| prior status | carries as | meaning |
|---|---|---|
| `human-decided` | **binding** | a person ruled; honour it or record an explicit revision |
| `ai-default` | advisory | ACE chose; this run may freely decide better |
| `overridden` | advisory | an operator override of a run-control gate, not a durable design ruling |
| `superseded` | does not travel | history in the run that had it |

**AI defaults deliberately do NOT bind.** `duplicate-detection-key`
genuinely improved across runs — a naive fixed 15 m radius became a
ranked accuracy-weighted proximity queue — and a binding ledger would
have frozen the worse version. Prior AI decisions are evidence, not
authority.

**Read ONE run back, never the full history.** That is the anti-cruft
rule and it is not hypothetical: on 2026-08-19 the operator manually
reset `hh-poverty-targeting/open-questions.md` to "human-authored
decisions and human-owned open questions only", deleting everything ACE
had raised or re-derived across the previous six runs, so that run would
"derive its own findings from inputs/ rather than inheriting six runs of
prior ACE reasoning". `ingestPriorRun` is that rule executed
automatically. An AI default that stops being re-derived falls out on its
own — no expiry logic, no pruning job.

Before writing a row, check it against the inheritance with
`conflictsWithRuling`. A non-null result means the run is about to
overwrite something a human settled: honour it, or write the change as an
explicit revision naming the person to re-escalate to. The check matches
on `id` AND on `feedback_ref`, because a run that renames the question
would otherwise walk straight past the ruling — measured, one reviewer's
9 comments were raised under 22 different ids.

**Reviewer decision-overrides bind automatically (added 2026-07-25,
ace#933).** ace-web's Phases tab → Decisions panel lets a reviewer save
overrides to `ACE/<opp>/inputs/decision-overrides.yaml` without
triggering a run. The `decisions_append_rows` atom consumes that file at
the write boundary: any row a run raises whose `id` matches a saved
override is written with `override` + `status: overridden` +
`override_reasoning` (override value appended to `options` if missing,
preserving `override ∈ options`, ace#526). Phase skills keep emitting
`status: ai-default` rows and need no changes; the atom reports bound ids
in `overridesApplied`. Override ids the run never raises are ignored —
the file is opp-level and cumulative across review sessions. A malformed
overrides file fails the append LOUD (silently dropping an expert's
saved review is the failure mode this closes). Contract:
`lib/decision-overrides.ts`; writer spec: ace-web
`docs/specs/2026-07-24-decision-review-save-design.md`.

**The procedural authority for each phase is the per-step `Output`
block in its `agents/<phase>.md` file**, not the catalog in the writing
skill's `SKILL.md`. The catalog (the `## Decisions Log` section in each
producer skill) is a teaching device — listing the rows that commonly
qualify under the bar for that phase. The agent file's per-step `Output`
bullets are what the dispatched subagent treats as its checklist.
Documented catalogs without a matching per-step bullet produced silent
zero-write failures across Phase 2–9 on the malaria-itn-app run filed
as `jjackson/ace#399`; the fix was the per-step Output enumeration that
now lives in every downstream agent file. When you add a new skill that
writes anchor rows, BOTH must be updated together: the catalog in
`SKILL.md` AND the `Output:` bullet in the dispatching agent file. The
catalog alone is not load-bearing.

History: PR #1 of the decisions-log series shipped Phase 1
(`idea-to-pdd` + `pdd-to-work-order`). PR #4 added Decisions Log
catalogs to Phase 3–10 skills but did NOT update the agent files; that
gap was closed by the issue #399 fix.

## Recurring writers — TBD

Cron-driven skills (`solicitation-monitor`, `timeline-monitor`,
`flw-data-review`, `ocs-chatbot-{qa,eval}-monitor`) fire outside any
`/ace:run` invocation, which means they have no current run-id of
their own. They need a stable way to read and write opp-level state
under the "every run is independent — no run reads from or writes to
another run's `run_state.yaml`" rule.

This is **unresolved**. Open as part of the Phase 8+/8 redesign. Each
recurring skill's `SKILL.md` currently documents its own provisional
approach (often "read-only against the most recent run, no writes").
Do not codify a global rule here until the Phase 8+/8 architecture is
settled.

## Phase Write-Back Verifier — procedure

After each phase dispatch returns, the orchestrator (i.e., the
top-level Claude Code session running this procedure doc) MUST verify
the dispatched phase wrote its block back. This is the load-bearing
backstop — even if the phase agent's prose says "I updated state",
verify that the bytes landed.

After each `Agent(<phase>)` dispatch (subagent) or each
phase-subagent completion (commcare-setup):

1. `drive_read_file(<run_state.yaml fileId>)`.
2. Check `phases.<phase>.status`. Expected: `done` (or `partial` when a
   declared producer/eval was parked, or `error` on failure paths — see
   § Phase Write-Back Contract for the full enum). If absent or stuck at
   `pending` / `in_progress`: the agent forgot to write back. Fall through
   to step 3. Do NOT "fix" a `partial` to `done` — it is a terminal status
   carrying real signal, and overwriting it is how a parked producer
   becomes invisible.
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

## Pause Points

`/ace:run` may pause at named points where the next action affects external parties or where a phase boundary needs operator-level review. There is **no separate "gate-brief" artifact** — at each pause, the orchestrator reads the per-skill QA verdict (`<phase>/<producer>-qa_result.yaml`) + eval verdict (`<phase>/<producer>-eval_verdict.yaml`) directly and synthesizes a pause-time summary on the fly. The verdict files are the source of truth; the orchestrator is just the renderer.

**Pause points and per-mode behavior:**

| Checkpoint | Phase | `default` | `review` | `auto` |
|------|-------|-----------|----------|--------|
| After `idea-to-pdd` | 1 | **halt on `[BLOCKER]`** (no prompt) | always pause | **halt on `[BLOCKER]`** (no prompt) |
| After `app-deploy` | 3 | **halt on `[BLOCKER]`** (no prompt) | always pause | **halt on `[BLOCKER]`** (no prompt) |
| After `ocs-chatbot-eval --quick` | 5 | **halt on `[BLOCKER]`** (no prompt) | always pause | **halt on `[BLOCKER]`** (no prompt) |
| After `llo-invite` | 8 | never pause (passive solicitation invites) | always pause | never pause |
| **Phase 8→9 boundary** | 8→9 | **terminus, not a prompt** — the run ends | terminus | terminus |
| Before `llo-onboarding` | 9 | *unreachable — Phase 9 not live* | — | — |
| Before `llo-uat` send | 9 | *unreachable — Phase 9 not live* | — | — |
| Before `llo-launch` | 9 | *unreachable — Phase 9 not live* | — | — |
| Before `opp-closeout` | 10 | *unreachable — behind Phase 9* | — | — |

**Two different things, and only one of them is banned (0.13.1023).**

- **Asking a human a question and waiting** — ACE never does this in `default` or
  `auto`. Where it used to prompt, it decides, records the decision, and proceeds.
- **Halting because something is broken** — ACE absolutely still does this. A
  `[BLOCKER]` stops the run.

An earlier revision (0.13.1021) collapsed the two and made blockers
*record-and-continue*. That was wrong, and wrong in the most expensive direction:
it meant a run could reach the end with a known-broken artifact behind it, so
"the run finished" stopped being evidence that anything worked. **Reaching the end
of a run must mean everything worked.** That is the property being protected here.

So: on `[BLOCKER]`, write `phases.<phase>.status: blocked` with the reason and the
verdict paths, and **halt** — without asking anyone anything. The halt is
autonomous. A stopped run is a signal, not a question.

**`review` mode is unchanged and still pauses at every checkpoint.** It exists so an
operator can opt into a human checkpoint per phase; that is a deliberate request, not
ACE volunteering a question. It is the one mode that requires the orchestrator to run
at level 0, because `AskUserQuestion` is withheld from every subagent — worth knowing
before the orchestrator is ever dispatched (`CLAUDE.md § Agent topology`).

**Phase 9 / 10 rows are specification, not behavior.** `agents/execution-manager.md`
halts before any step while Phase 9 is not live. When it is enabled, those
external-comms gates cannot be `AskUserQuestion` prompts if the phase is a subagent —
that is the live meaning of the enablement checklist's *"re-validate the
external-comms pause points."*

**Synthesizing a pause-time summary.** At each pause, the orchestrator:

1. Reads the per-skill QA + eval verdict files for the upstream step (paths follow `<phase>/<producer>[-qa|-eval]_<artifact>.yaml`). Missing verdicts are fine — skip.
2. Aggregates the verdicts into a brief summary:
   - **Artifact under review:** path + one-line description (pulled from the producer's primary artifact).
   - **What to check:** auto-derived from any QA `failures[]` and eval auto-surfaced concerns.
   - **Severity surface:** any `[BLOCKER]` / `[WARN]` / `[INFO]` from the verdicts (eval has these explicitly; QA failures are always `[BLOCKER]`-equivalent).
3. **In `default` and `auto`: halts, without prompting.** If any `[BLOCKER]` is
   present, write `phases.<phase>.status: blocked` with a one-line reason and the
   contributing verdict paths, and stop the run there. Do NOT ask a question — the
   operator reads the state, not a modal. If there is no `[BLOCKER]`, continue
   silently; `[WARN]` and `[INFO]` never halt.
4. **In `review` only: presents via `AskUserQuestion`** with four options:
   - **Approve** — continue.
   - **Reject** — halt the run; log admin's reason in `comms-log/`.
   - **Iterate** — re-dispatch the upstream skill with the surfaced concerns as input (equivalent to a manual auto-fix loop).
   - **Inspect** — open the artifact path for a deeper look, then re-prompt.

There is no `gates.<name>` field to flip on approve/reject. The phase status (`phases.<phase>.status`) and the per-skill verdicts together carry the audit trail.

**Why no separate gate-brief artifact.** The `<skill>_gate-brief.md` artifact (used pre-0.13.116) was a producer-authored summary that duplicated the QA + eval verdict signal. With the QA/Eval split codified (PRs #146 / #149 / #160), the verdicts ARE the source of truth — the orchestrator can render the same summary from them at pause time. Removing the artifact eliminates a class of drift (gate-brief saying "all clear" while eval verdict shows BLOCKER) and removes coordination overhead between producing skills.

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

### Producers landed, only the summary + write-back are missing — finish inline

The boundary fence's heal instruction for `verify.ok=false` is "dispatch each
missing artifact's `producedBy` via `Skill(<producedBy>)`". That works for
artifacts a SKILL owns. It does not work for the one artifact every phase owns
itself — `<N>-<phase>/<phase>_summary.md`, whose `producedBy` in
`lib/artifact-manifest.ts` is the PHASE, and a phase is not a `Skill`
(dimagi-internal/ace#1505).

The shape is common enough to name, because incremental writes make it the
EXPECTED outcome of an interrupted phase rather than an exotic one: a phase
agent writes each artifact as it is produced, so when it dies late — an API
5xx, a context wall, an operator halt — every producer artifact is on Drive and
only the phase's own bookkeeping is missing. `verify_phase_artifacts` reports
`N-1 of N`, `classify_phase_writeback` reports `missing`/`in_progress`, and a
literal reading of the retry branch says re-dispatch the whole phase.

**Do not.** Re-dispatching re-runs every producer AND every `-eval` that
already completed — and an `-eval` is an LLM judge, so the second run draws a
DIFFERENT verdict that overwrites the first. The run silently takes a second
sample and keeps whichever landed last. That is strictly worse than the gap it
was trying to close.

When **every** artifact except the phase summary is present and its per-skill
verdicts are on Drive, finish inline at level 0:

1. Read the landed verdicts (`<producer>-qa_result.yaml`,
   `<producer>-eval_verdict.yaml`). They are the evidence; do not re-derive
   their content.
2. Write `<N>-<phase>/<phase>_summary.md` from them, and say in the summary
   that the phase was completed inline after an interruption, what the
   interruption was, and what was NOT re-run.
3. Write the phase block per § Phase Write-Back Contract, with `status_note`
   naming the same thing.
4. Record the interruption in `run_state.yaml.notes`.
5. Re-run the fence and require it green before advancing.

**Only when the producers actually landed.** If a PRODUCER artifact is
missing, heal that producer through its own skill first — this is finish-inline
for bookkeeping, never a way to skip work. That distinction is the same one
§ Skill Invocation Discipline draws: composing a producer's output inline is
always wrong; writing the phase's own summary from artifacts the producers
already wrote is not.

Live: `spark-facilitator/20260817-1610` Phase 2. A server-side 500 killed the
subagent after all five required artifacts had landed — the journeys eval
verdict wrote at 23:06:42Z, past the agent's last status line — leaving only
the summary and the write-back. Finishing inline preserved both eval verdicts;
re-dispatching would have re-rolled two LLM judges for nothing.

### External-resource phases: finish inline, don't re-dispatch on a malformed write-back

The re-dispatch rules above (§ State-as-canary, and the boundary fence's
`classify_phase_writeback='malformed' | 'in_progress'` → silent-Agent-retry
branch in `ace-orchestrator.md § Phase boundary fence`) assume re-dispatch
is cheap and idempotent. For phases that **mint an external resource**, that
assumption breaks — a fresh dispatch creates a *second* resource and orphans
the first, because most have no delete path:

- `ocs-setup` → clones a per-opp OCS chatbot
- `connect-setup` → creates a fresh Connect opportunity
- `solicitation-management` → publishes a labs solicitation

So before re-dispatching one of these on a `malformed` / `in_progress`
write-back, branch on `verify_phase_artifacts(runFolderId, phase)` **and**
the run_state `products.*` block:

- **`verify.ok=true` (required artifacts already on disk) OR the
  `products.*` block already records the external resource's id** → the
  agent did the substantive work and died (commonly a transport/socket
  error) *before* finalizing its write-back. **Finish the write-back
  INLINE** — read the per-step verdict files + the `products` block the
  agent already wrote, synthesize the missing
  `{status: done, verdict, completed_at, summary_artifact, steps}` fields,
  and patch via `update_yaml_file`. Write any missing *leaf* artifacts
  (e.g. a phase summary, a paired `-eval` verdict the agent hadn't reached)
  inline too. Do **NOT** re-dispatch the Agent — that orphans a second
  resource.
- **`verify.ok=false` AND no external-resource id recorded** → the agent
  died before creating the resource; re-dispatch is safe (clean idempotent
  start).

This is the one place the silent-retry default is wrong: re-dispatch heals
a *missing* phase, but for external-resource phases a *malformed-but-
substantively-complete* phase is healed by finishing the bookkeeping, not
by re-running the side effects.

Surfaced on `bednet-spot-check/20260528-0556`: the `ocs-setup` subagent
socket-dropped after cloning chatbot `12298` and landing its quick qa/eval
artifacts; the write-back classified `malformed`. Re-dispatch would have
cloned a second chatbot — instead the orchestrator finished inline (phase
summary + `ocs-widget-handoff-eval` verdict + the write-back, all from the
already-recorded `products.ocs_chatbot`), reusing the existing chatbot.

## Discipline — full text

Full source text for the rules consolidated into the procedure doc's
§ Anti-patterns and discipline. The procedure doc carries the
scannable list; this section preserves the original prose for
authors of new procedure docs and for historical traceability when an
incident is re-examined.

### Long-Running Skills — No Fake Background Tasks

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

#### When background IS appropriate

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

#### When polling IS appropriate

Some skills legitimately wait on upstream state changes (RAG indexing
in `ocs-agent-setup`, CCHQ build completion in `app-release`). For
those, poll the upstream service's status endpoint directly with a
**bounded retry policy**: max attempts, exponential backoff, hard
timeout, fail loud on exhaustion. Do not invent a "background task ID"
that the orchestrator can't actually verify is alive.

### Skill Invocation Discipline

When a procedure step says "Invoke X" or "Dispatch X", that means
**call the skill via `Skill(<name>)` (or `/ace:step <name>
<opp>/<run-id>` from a fresh session)**. Never compose a producer
skill's outputs inline from upstream artifacts even when you have
enough context to plausibly do so — and especially under context-budget
pressure across a long `/ace:run` where shortcutting any one step looks
cheap. Skills with multi-file output contracts (a master file plus a
sibling folder of per-item files; a yaml plus a recipes/ tree; a doc
plus a `verdicts/` entry) bind downstream skills to the on-disk layout,
not to the master file's content. The downstream pre-flight halts when
the sibling files are missing — by which time the inline shortcut is
several phases upstream and harder to attribute.

The canonical reproduction: turmeric run 20260509-0455. The orchestrator
inline-composed `3-commcare/app-test-cases.yaml` from the PDD + app
summaries instead of invoking `Skill(app-test-cases)`, which would have
emitted the per-journey recipe files (`app-test-cases/J*.yaml`) that
Phase 6's `app-screenshot-capture` reads. Phase 6 halted at pre-flight
with `incomplete`, no AVD time burned but five training docs rendered
without screenshots and had to be re-run.

Phase 3 (commcare-setup) was the highest-risk surface
because it executes inline at level-0 — there's no subagent boundary
between "the orchestrator decides what to do" and "the skill produces
the artifact." When in doubt, dispatch.

The post-phase artifact verifier in § Producer Artifact Verifier
enforces this rule mechanically; the rule itself is here so authors
of new procedure docs know not to design around it.

### External Mutations — Verify After Create

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
   write the diff (sent vs. stored) to the phase's
   `<producer>_comms-log.md`, surface it in the pause-time summary, do
   NOT proceed. Mismatch on a
   cosmetic/display field (descriptions, tags) is `[INFO]` — log and
   proceed.

The `turmeric-20260503-0835` Phase 4 run is the canonical example: a
malformed `connect_create_payment_unit` shipped values that didn't
match what was sent (`amount=500` vs sent `1.50`,
`required_deliver_units=[]` vs sent `[Vendor Visit]`). The skill
returned cleanly, Phase 4 graded `warn` on the eval, the orchestrator
auto-proceeded — and the malformation cascaded through
`is_setup_complete` to silently break Phase 8 invites and Phase 6
screenshot capture. A read-back at the producer would have converted
that multi-phase cascade into a single-skill halt with an obvious
field-diff in the pause-time summary.

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

### Per-phase batching, env, and Agent-serial rules

**Batch independent operations — for tool calls, not Agent dispatches.**
When a phase needs N independent **tool calls** (e.g. multiple
`drive_read_file` reads, multiple `nova_update_form` mutations,
multiple `connect_create_payment_unit` creates), dispatch them all in
a single assistant message. Sequential single-tool messages waste the
parallelism that the harness already supports.

**`Agent(...)` dispatches DO NOT parallelize the same way.** Claude
Code does not reliably run two `Agent` calls placed in one assistant
message in parallel; treat phase-agent and slash-command-driven agent
dispatches (e.g. `/nova:autobuild`) as serial. Phase 3's two Nova
builds, for instance, must run one after the other. This applies to
any future cross-phase orchestration too — idea-to-design, ocs-setup,
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

### Don't summarize and continue

The inline-artifact contract (§ Pre-flight & per-phase conventions)
breaks if the next phase's PDD is paraphrased rather than passed
verbatim. If you genuinely need to halt, write back
`phases.<current>.status: done` (or `error` with a one-line note) and
let the operator resume via `/ace:run <opp>/<run-id>` in a fresh
session. Never try to compress your own context to keep going — the
cure is worse than the disease.

### BLOCKER retry caps

Phase agents must not auto-redispatch identical payloads against the
same opaque failure. Cap at **3 same-class BLOCKER retries within one
phase, then halt the run**: write `phases.<phase>.status: error` and
`verdict: blocker-retry-cap` to `run_state.yaml`, surface `[BLOCKER]`
to the operator, and stop. (Pre-0.13.116 this paired with a
`gates.<phase>: failed` flip; gates removed —
`phases.<phase>.status: error` is now the sole signal.)

**Why:** turmeric Phase 4 retried `connect_create_opportunity` 3× on
an identical payload against the same opaque 500 before bisect proved
it deterministic (CI-659, the 50-char `short_description` trap). Leep
Phase 6 retried 5× across `/loop continue` cycles on the same
`runner_service_state=failed` class — burning hours that a circuit
breaker would have converted into a single operator halt.

### Cross-repo debug belongs in a subagent

When a phase blocks on an infrastructure or contract bug that needs
cross-repo development (ace-web, an MCP server, an upstream library),
do NOT debug at L0. Dispatch a single `general-purpose` subagent with
the prompt "find root cause, propose patch, return diff." The
orchestrator's job is run flow, not bisect.

**Why:** leep run `20260512-0418` had 1325 lines of L0 ace-web
cloud-emulator debugging between Agent dispatches (only 4 Agent calls
across 1448 lines total). Turmeric Phase 4 had ~24 min of L0 bisect
work that belonged in a research subagent. The user manually pivoted
in both runs ("I'll spin up another agent") — too late.

### Don't read-modify-write run_state.yaml

Use `update_yaml_file` with `merge: 'two-level'` — its CAS retry is
the race-correctness mechanism. A manual `drive_read_file` +
`drive_update_file` re-introduces the lost-update class of bug under
concurrent writes (multi-skill same-phase writers, or two operators
on the same opp).

`merge: 'two-level'` recurses one level into object-valued top-level
keys (`phases:`), so a single phase's patch leaves sibling phases'
blocks intact. The default `shallow` mode replaces each top-level key
wholesale and would clobber every other phase's entry under
`phases:`. Full mechanics in § Phase Write-Back Contract.

### Don't skip per-step `-eval` dispatch

Phase 3 (`commcare-setup`) is a subagent and dispatches its own evals. After each
producer skill (`pdd-to-learn-app`, `pdd-to-deliver-app`,
`app-release`), the procedure doc says to dispatch the matching
`-eval` skill — these are not optional. The inline execution surface
makes it easy to skip them ("the build succeeded, move on") but that
leaves `has_judge: true` skills without verdicts, and the Phase
Write-Back Contract's verdict-gate rule fires
(`phases.commcare-setup.verdict` cannot be `pass` when any
`has_judge: true` skill has `steps.<skill>-eval.status: deferred`).

**Why:** `malaria-itn-app/20260523-0750` Phase 3 ran all 7 producer
skills but 0 of 3 evals. The phase shipped `verdict: pass` without
any LLM-as-Judge quality signal. The same rule applies to any future
procedure doc executing producers inline.

### Don't add operator-confirmation on populated opps

The "do you want to overwrite live state?" gate is off-spec on
populated opps. `--mode default` already encodes the answer. The
named Pause Points (§ Pause Points) plus the Phase 8→9 boundary are
the only sanctioned pause locations. A populated-opp confirmation
prompt added to the orchestrator hides a skill bug rather than fixing
it.

Reuse-vs-rebuild is owned by each phase agent's skills, not by the
orchestrator. Each run is independent — no run reads from or writes
to another run's `run_state.yaml`. The only cross-run reuse surface
is `opp.yaml.connect.program.{id, url, connect_int_id}`, the durable
Connect program reference reused across every run. Everything else
(opportunity, OCS chatbot, solicitation) is per-run and recreated
fresh.

If you (the orchestrator session) genuinely encounter prior state you
can't classify as "reuse vs rebuild" by inspecting `opp.yaml`, that
is a **skill bug** — file an issue against the relevant phase agent's
skills, don't add an orchestrator-level confirmation prompt.

### Don't authorize Phase 6 soft-fail in the dispatch prompt

The AVD/Maestro auto-heal lives inside `mobile_ensure_avd_running`;
if it exhausts, the right answer is a `[BLOCKER]` halt that points
the operator at `/ace:mobile-bootstrap`, not "proceed with placeholder
screenshots and log `[WARN]`." Sentences along the lines of "if
`app-screenshot-capture` cannot run, proceed without screenshots" in
the Phase 6 dispatch prompt are off-spec — they reintroduce the
escape valve the heal was designed to retire. The phase agent itself
rejects this kind of override since 0.13.165 (see
`agents/qa-and-training.md` § Pre-flight checklist), but orchestrator
authors should not write it in the first place.

**Why:** leep run `20260511-0507` Phase 6 shipped no screenshots
because the dispatcher's prompt told the phase agent "don't halt
Phase 6 over dev-machine state" — but that "dev-machine state" was a
wedged Maestro gRPC server, which the heal could have fixed in ~90s.
Every run that quietly ships placeholders is a Phase 6 capability
gap we can't see in the verdict stream.

### On phase retry, pass the verdict fileId inline

On retry, pass the prior failed verdict's Drive `fileId` inline — do
NOT paraphrase. The retry agent reads the verdict directly from
Drive; the orchestrator's dispatch prompt cites the fileId (and the
producer artifact paths) rather than summarizing the failure mode.

**Why:** leep Phase 6 retry #5's dispatch prompt paraphrased
`phase5-block.md` as "selector-map gaps... `connect-baseline-screenshots`
to fix" — the subagent re-discovered the same gap from scratch each
cycle because it never saw the actual artifact. Paraphrase compresses
out the precise diagnosis the retry needs.

## Fix-and-ship subagent template — explicit merge confirmation

When the orchestrator (or any level-0 dispatcher) launches a
background fix-and-ship subagent, the subagent's final step MUST be a
confirmed terminal PR state. Returning after `gh pr merge --auto
--merge` is armed — without confirming the merge actually landed — is
the canonical failure mode that surfaced across all 6 fix-and-ship
dispatches in the turmeric 20260515-0536 cycle. Each one returned
"checks running" / "watchers armed" / "PR queued" and the operator had
to re-poll manually.

**The mechanics live in `skills/shipping`. Dispatch it; do not inline a
wait here.** This section previously carried a verbatim
`until [ … = MERGED ]; do sleep 30; done` loop and told dispatchers it
was "cheap (~6 calls per merge cycle)". Both halves were wrong: a
foreground `sleep` used to wait is **blocked by the harness Bash
contract**, so the loop never ran as written, and the fallback burned
the full 10-minute Bash timeout (`Exit code 143`) waiting on a PR that
merges in ~70 seconds. Measured 2026-08-17; reproducer and the
corrected backgrounded form are in `skills/shipping/SKILL.md § Step 2`.

### Dispatch it into its OWN worktree — `isolation: "worktree"`

**Every fix-and-ship dispatch MUST pass `isolation: "worktree"` to the
`Agent` tool.** Not a preference: a dispatched subagent inherits the
dispatcher's working directory, so without it the subagent runs
`git checkout -b`, `git add -A` and `scripts/version-bump.sh` **inside
the orchestrator's own worktree, concurrently with the orchestrator.**

Measured on `poverty-graduation/20260905-0924` (ace#2001). The Phase 1
subagent self-healed an issue and moved the branch out from under a live
`/ace:run`:

| Time | Actor | Event |
|---|---|---|
| 09:31:52 | orchestrator | commits its own fix on `emdash/ace-api-…` (→ PR #1988) |
| **09:48:13** | **Phase 1 subagent** | `checkout: moving from emdash/ace-api-… to fix/decision-vocabularies-doc-and-test` |
| 09:51:04 | Phase 1 subagent | `git add -A` + commit (→ PR #1995) |
| 10:08:16 | orchestrator | commits its NEXT fix — silently onto the subagent's branch |

Two PRs with unrelated titles still carry the same head branch, and both
merged with correct content:

```
$ gh pr view 1995 --json number,headRefName --jq '"#\(.number) head=\(.headRefName)"'
#1995 head=fix/decision-vocabularies-doc-and-test
$ gh pr view 1999 --json number,headRefName --jq '"#\(.number) head=\(.headRefName)"'
#1999 head=fix/decision-vocabularies-doc-and-test
```

**Nothing failed — that is the problem.** Both actors run `git add -A`,
so across the 09:48→09:51 window either one would have swept the other's
in-progress edits into its own commit. It didn't, only because the
orchestrator's tree happened to be clean; nothing enforced that. On the
same day, in a separate incident, a second agent dispatched into a shared
tree found it missing 10 files present on recent `main` — committing there
would have **deleted them from `main`**.

And it scales in exactly the direction § Self-heal sweep rule 2 pushes:
*"eleven self-healable issues is eleven dispatches, not the first few."*
Eleven background subagents each running `git checkout -b` and
`git add -A` in ONE worktree is a guaranteed collision, and every
resulting corruption is silent — `git add -A` cannot tell whose file it
is staging.

`isolation: "worktree"` gives the subagent its own git worktree,
auto-cleaned if unchanged, and the harness ENFORCES it: a worktree-isolated
agent's `git` invocation that cannot be proven to stay inside its own
worktree is refused outright rather than run. That is a stronger guarantee
than any instruction, which is the reason to prefer the flag over prose
telling the subagent to be careful.

**The backstop, for any dispatch path that forgets the flag:** the ship
loop records its branch and `scripts/version-bump.sh --expect-branch
<name>` refuses to bump if the branch moved — before any `git add -A`.
See `skills/shipping/SKILL.md § The ACE ship loop`. It catches BOTH sides
of the incident above: the subagent's checkout, and the orchestrator's
10:08 commit onto a branch it never chose.

### The dispatch prompt

Tell the subagent to run `skills/shipping` and return its Step 3 ship
checkpoint. Don't re-list the steps — that narrows scope and silently
skips skill-defined work (`CLAUDE.md`, dispatch-prompt discipline).

```
... (subagent does the fix + push + PR creation) ...

Run skills/shipping end to end. Return its Step 3 ship checkpoint
verbatim, plus the fields below.
```

### The filed remedy is a lead, not an instruction

`CLAUDE.md § File ACE issues mid-run` rule 1 makes the filer verify the
**premise**. Nothing makes anyone verify the **suggested fix**, and that
is the half a fix-and-ship subagent inherits and acts on. Measured across
2026-08-29..09-06, on issues whose premise was verified and correct, the
remedy failed in four distinct shapes:

| Shape | Case | What the filed remedy would have done |
|---|---|---|
| **wrong** | ace#2004 | hoist the auto-merge arm above the poll loop — which also hoists it above the ancestry guard in the same branch, so a run pointed at the wrong worktree **arms and merges a stranger's PR** instead of refusing. Strictly worse than the bug it fixed |
| **under-scoped** | ace#2027 | edit two rubric branches in place, giving each its own copy of the provider test. The eval already had the provider in hand; one gate hoisted above both branches was correct |
| **no-op** | ace#1768 | stop the doctor probe "scraping for a `public_id` the atom already returns" — the probe *already calls* the atom (`mcp/ocs/composite.ts:133`). Two of its three supporting observations were known artifacts, one documented 13 days before the issue was filed |
| **stale** | ace#1766 | apply a driver fix that had shipped in `f423ce12` the day after filing. Only the regression test its own last line asked for was still real |

A false PREMISE is cheap — one grep closes it. A false REMEDY costs a
full fix-agent investigation (~200k tokens each in the 2026-09-01
session) to discover, and if the subagent trusts it instead, it ships a
no-op that closes the issue and leaves the defect live. ace#1900.

**So: read the filed remedy as a lead, and run these two checks before
adopting any of it.** Both are cheap, and between them they cover all
four shapes:

1. **Staleness / no-op — re-read the cited `file:line` against current
   `origin/main`, not against the issue's quote.** `main` moves ~9×/day;
   an issue filed yesterday may describe code that no longer exists.
   `git show origin/main:<path> | sed -n '<n>,<m>p'`. If the cited code
   already does the thing, or the fix already shipped, the issue is
   **refuted** — close it `--reason "not planned"` citing the commit or
   the line. That is a successful sweep, not a failed one
   (`CLAUDE.md § Self-heal a filed issue`).
2. **Wrong / under-scoped — execute the remedy before adopting it.** If it
   is a matcher, run it against the real inputs and count the hits (ace#1827
   proposed a regex that matched **0 of 16** real payloads). If it is an
   edit, apply it and read what the surrounding code then requires — that
   is what exposes a duplicated check (#2027) or a guard hoisted out of its
   own precondition (#2004).

Never merge on "the issue said so." The issue is the only party that has
not run anything.

### Required fields in the subagent return

- PR URL
- **`Remedy:`** — one of `as-filed` / `re-derived` / `refuted`, plus one
  line of evidence. `as-filed` requires naming what you **ran** to
  confirm it (the re-read, the matcher's hit count, the applied diff) —
  "it looked right" is not `as-filed`, it is an unrun remedy. A return
  with no `Remedy:` line is incomplete in the same way "auto-merge armed"
  is: the dispatcher cannot tell a verified fix from an inherited guess.
- **Merge state** — `MERGED` / `OPEN` / `CLOSED`, read from
  `gh pr view --json state`, never inferred from auto-merge being armed
- For MERGED: `mergedAt`
- For OPEN: `mergeStateStatus` + why (checks running / DIRTY after
  rebase exhausted / check-failed), and for DIRTY-after-exhaustion
  which non-version files conflicted
- For a failed check: check name + first 200 chars of the failure log
- The next planned action

`OPEN` with a reason is a valid, useful return. "Auto-merge armed" is
not — it is the absence of a return.

See also: `CLAUDE.md § Plugin updates — NEVER locally patch` for the
end-to-end "bump → PR → wait → /ace:update" workflow this template
slots into.

## Pre-flight rationale

Relocated rationale for `ace-orchestrator.md § Pre-flight Checklist`.

**`nova_needs_auth_cache` halt class.** `nova_needs_auth_cache: {status:
fail}` means `plugin:nova:nova` is stuck in Claude Code's needs-auth
cache despite a valid `NOVA_API_KEY` — the architect would hallucinate
fabricated `app_id`s at Phase 3, and the only fix is a full Claude Code
restart. Catching it at pre-flight (second 0) instead of at Phase 3 Step 0
(~25 min in) saves the operator from running Phases 1–2 only to halt. See
jjackson/ace#582.

**What it does NOT cover — read `pass` narrowly (dimagi-internal/ace#1604).**
The probe is static: a stale cache FILE, plus `NOVA_API_KEY`'s PRESENCE.
Neither says anything about which principal the live Nova MCP connection
actually bound — a session can hold a resolvable Nova connection authed as a
completely different account and this block still reports a green `pass`
verdict (measured on `spark-facilitator/20260820-0817`). The emitted block now carries
a `scope:` line saying so. Principal identity is asserted in-session, where
it is observable: `ace-orchestrator.md § Pre-flight Step 2a` (the `list_apps`
check for a `pending`/`in_progress` `commcare-setup`) and
`commcare-setup.md § Step 0b`.

**`ocs_generation` halt class — and why preflight makes one live
exception.** Every other OCS check the doctor runs is env-presence or a
reachability GET; `ocs_shared_collection_team` proves a collection is
*reachable*, never that the model behind it can answer. So a dead,
revoked, or usage-capped team GENERATION provider stayed invisible until
Phase 5's quick gate — after Phases 1-4 and 6 had run. That class has now
cost two sessions: ace#743 (revoked key, 2026-06-09) and
bednet-check-2-visit/20260817-1720 (usage cap, 2026-08-19, where the
run's own config was flawless — 8/8 indexed, `pipeline_valid`, published
v2, channel enabled). ace#743's preventer shipped and worked, but it is a
*diagnosis* fix that fires inside Phase 5; #1516 is the *timing* fix.

Three details worth not rediscovering: (1) the generation provider is not
the one any env var names — `OCS_LLM_PROVIDER_ID` is the EMBEDDINGS
provider, so the probe discovers generation from
`ocs_inspect_chatbot`'s `pipeline.nodes[].llm.provider_id`; (2)
embeddings and generation sit on separate keys, so a probe that only
checked indexing reports green through this failure; (3) OCS masks the
real provider error behind a generic "intermittent load" fallback unless
`debug_mode` is on, so the block carries the session's `trace` URL —
open that, not the OCS error text, before calling it a platform outage.

`skip` is not `fail`. Live means it can be un-runnable (no session,
`--no-live`, env unset); treat `skip` as "unknown, proceed" and let
`ocs_auth` explain it.

**Don't probe `.env` before the doctor — anti-pattern.** Observed in real
sessions (2026-05-24 e2e-malaria-rdt, 2026-05-26 bednet-spot-check): the
orchestrator burns 2–3 turns probing `$CLAUDE_PLUGIN_DATA` (reliably empty
inside Claude Code), running `find ~/.claude -name .env`, grepping the
file, etc. — before running the doctor. Every one of those probes is
wasted: the doctor publishes all of it in one call.

**Why the explicit `$DATA` derivation.** The `e2e-malaria-rdt` 2026-05-24
session showed the orchestrator probing `$CLAUDE_PLUGIN_DATA/.env` with an
empty `$CLAUDE_PLUGIN_DATA`, resolving to `/.env`, failing, then fanning
out across multiple recovery probes before locating the real env file.
Defaulting to `$HOME/.claude/plugins/data/ace-ace` mirrors what
`bin/ace-doctor --preflight` already does and what the MCP servers'
`resolveKeyPath()` helper falls back to. The default is the canonical
install location on Claude Code 2.1+.

**Why fully-prefixed `ToolSearch`.** Empirically (2026-05-26
bednet-spot-check + 0.13.213 e2e-malaria-rdt sessions) the bare-name
`select:` shortcut resolves only built-in deferred tools (`TaskCreate`,
`TaskUpdate`, `EnterPlanMode`, …) — every plugin-registered atom returns
zero matches, costing a wasted ToolSearch turn every run. The
fully-prefixed form is deterministic. Built-in deferred tools load
alongside automatically via the same call.

## Run shape rationale

Relocated rationale for `ace-orchestrator.md § Pre-flight Step 4` ("Run
shape is structural, not flag-driven").

The pre-seeded run encodes its shape in a separate run-id's
`run_state.yaml` (seed prefix `done`/`verdict: seeded`, target phases
`pending`, gap+tail phases `skipped`). This replaced the
`--seed-from`/`--only` flag-interpretation that the headless runner
silently ignored (jjackson/ace#672) — behavior-via-markdown isn't honored
reliably, so run shape now lives in `run_state.yaml` where the
well-exercised resume path reads it.

## Incremental writes rationale

Relocated rationale for `ace-orchestrator.md § Per-phase conventions`
("Write artifacts to Drive incrementally").

Canonical incident: malaria-rdt/20260602-1409 Phase 6 dropped on
`FailedToOpenSocket` 3× ~13–77 min in; the first two dispatches batched
writes and lost all work (0/13 artifacts), while the third — instructed to
write each artifact as produced — left 11/13 on Drive when it dropped, so
a tightly scoped re-dispatch finished in minutes. This composes with
`verify_phase_artifacts`' `producedBy` per-artifact healing — both assume
each artifact lands on Drive independently, not in an end-of-phase batch.

## Dispatch-scope rationale

Relocated rationale for `ace-orchestrator.md § Per-phase conventions`
("Scope rule: the dispatch prompt MUST NOT narrow the agent's workflow").

`malaria-itn-app/20260523-0750` Phase 1 dispatch said "synthesize a PDD,
run QA+eval, write back" — the agent returned after 3 of 6 steps, silently
skipping the work order chain (Steps 2, 2.4, 2.5 in
`agents/idea-to-design.md`). The work order, its QA, and its eval were all
lost. Diagnosed as the same failure class in Phase 3 inline execution
where step entries lacked `artifact` fields.

## Silent-dispatch rationale

Relocated rationale for `ace-orchestrator.md § Per-phase conventions`
("Auto-retry silent Agent dispatches").

**Why structural, not text-match.** A confidently-worded "Phase 1
complete" return can be a lie; `classify_phase_writeback` reads the same
`phases.<phase>` source of truth `/ace:status` and `opp-eval` use, so if
the gate didn't flip the phase didn't ship regardless of the text. The
text-match secondary signal only catches the easy case (an empty return).

## Populated-opp contract

Relocated worked examples for `ace-orchestrator.md § Modes — default,
review, auto`.

**Reuse-vs-rebuild worked examples.** `connect-program-setup` reuses the
program; `connect-opp-setup`, `ocs-agent-setup`, and `solicitation-create`
each mint a fresh per-run entity recorded under their phase's `products.*`,
with stale prior-run entities operator-cleaned-up. Each new run still
produces a clean per-phase summary in its own slot, even when the
underlying live entity wasn't recreated. (See also § Fork Points.)

**Solicitations are scoped to a labs `program_id`, not the Connect
opportunity UUID.** Re-pointing a Connect opp at fresh HQ ids
(delete-and-recreate of the Connect opportunity) does NOT invalidate the
live solicitation. The public URL keeps working, the deadline keeps
counting down. See commcare-setup § Step 2 for the recovery contract.

## Why default mode looks like this

Relocated rationale for `ace-orchestrator.md § Why default mode looks like
this`.

Phases 1–5 are entirely internal to Dimagi — Nova builds apps in private
Firestore, `app-deploy` uploads CCZs to a Dimagi-controlled project space,
OCS chatbots are configured but not yet linked to any opportunity FLWs are
seeing. Operators historically rubber-stamped these gates 95%+ of the time
when nothing was wrong, which is why a ~36-minute idle gap was observed on
a recent e2e session waiting for an unattended `idea-to-pdd` approval.
Default mode treats the eval verdict (`[BLOCKER]` or not) as the
decision-maker and only stops the human for it when the model itself says
something is wrong.

Phase 9 onward involves real LLOs receiving real emails and real Connect
production state changes. There is no automatic eval that validates "is
this opp ready to send to outside parties?" — only human judgment can
clear that bar, so default mode insists on human review at every
external-comm point.

## Cross-repo dev exception rationale

Relocated rationale for `ace-orchestrator.md § Resuming after a halt`.

**Why.** leep run `20260512-0418` accumulated 540k
`cache_read_input_tokens`/turn while shipping 8 PRs (ace-web #312–#315,
ACE #246–#248) to fix cloud-emulator infrastructure. The user pivoted to a
second session at line 1215 — too late. Codifying this as policy, not
folklore.

**History note (do-not-reintroduce).** Earlier versions of the resume
section instructed the orchestrator to recommend splitting runs across
sessions on "populated opps" or "rich-PDD runs." That heuristic over-fit
on a 200K-context era and produced unnecessary operator friction in the
1M-context era — sessions self-halted at Phase 3 when they could have
completed end-to-end. Removed 0.13.122. If a future failure class
genuinely warrants proactive splitting, reintroduce the guidance with
concrete evidence, not heuristic extrapolation from token-budget anxiety.
