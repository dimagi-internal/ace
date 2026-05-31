# ACE Orchestrator — Reference

This doc is the *reference* counterpart to `agents/ace-orchestrator.md`. It catalogs schemas, contracts, lifecycle invariants, and architectural diagrams that the orchestrator's procedure references. The procedure doc tells you WHAT to do; this doc tells you the SHAPE of what you're doing.

If you're executing `/ace:run`, read `agents/ace-orchestrator.md` first. Come here only when the procedure points you at a specific section.

---

## Agent Topology

The architectural rule and full topology table live in `CLAUDE.md § Agent topology` (the canonical source — every session loads it). Summary for the orchestrator's purposes:

- **The rule:** anything that calls `Agent` runs at level 0. `ace-orchestrator` and `commcare-setup` (Phase 3) are procedure docs read and executed inline by the top-level session because they dispatch further work; the other nine agents (`idea-to-design`, `scenarios-and-acceptance`, `connect-setup`, `ocs-setup`, `qa-and-training`, `synthetic-data-and-workflows`, `solicitation-management`, `execution-manager`, `closeout`, `ocs-tester`) are subagents dispatched via `Agent(...)` from level 0.
- **Invocation in the procedure below:** "dispatch the X agent" means a top-level `Agent(X)` call (subagent rows in the CLAUDE.md table) or "read `agents/X.md` and execute it inline" (procedure-doc rows).
- **Why the rule:** the `Agent` tool is unavailable to subagents; a node that nests further work cannot itself be a subagent. There are never two levels of `Agent` dispatch.

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
identifiers (Connect program UUID + URL + labs_int_id) that survive
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

## Per-Phase Folder Lifecycle

Per-run artifacts live under `runs/<runId>/<N>-<phase>/...` (the 0.13.0
phase-prefixed layout). The orchestrator is responsible for materializing
each `<N>-<phase>/` folder before its phase agent runs, threading the
resulting `phaseFolderId` into the dispatch prompt, and refreshing the
run's `README.md` index after the phase completes.

Before dispatching each phase agent (`Agent(idea-to-design)`,
`Agent(scenarios-and-acceptance)`,
`Agent(commcare-setup)` (inline procedure doc — same rule applies),
`Agent(connect-setup)`, `Agent(ocs-setup)`, `Agent(qa-and-training)`,
`Agent(synthetic-data-and-workflows)`,
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

After a phase completes, regenerate `README.md` with the updated
`phaseStatus` (e.g. `{ design: 'done', commcare: 'in-progress', ... }`)
via `generateRunReadme(runId, phaseStatus)` and write back to
`runs/<runId>/README.md` via `drive_update_file`. The README is the
operator's single-glance view of run state; keep it fresh.

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
| `ACE/<opp>/opp.yaml` | Identity (`display_name`, `slug`, `tags`, `created_at`, `created_by`) plus `connect.program.{id, url, labs_int_id}` — the durable Connect program reference reused across every run of the opp. Written by `connect-program-setup` on first create; subsequent runs read this to skip program-create. Every other piece of evolving state (Connect opportunity, OCS chatbot, solicitation, selected_llo, synthetic) is per-run and lives only in the producing run's `run_state.yaml.phases.<phase>.products.*`. Older opps may still carry stale `solicitation`/`selected_llo`/`synthetic`/`connect.opportunity`/`ocs_chatbot` blocks here from earlier dual-write iterations — no longer read or written; operator-cleaned-up when picking a release-candidate run. |
| `ACE/<opp>/inputs/` | Human-curated source pack. Read-only — every run's Phase 1 reads via the run-root inputs-manifest. |
| `ACE/<opp>/eval-calibration/known-issues.md` | Ground-truth catalogue every `-eval` rubric reads. Calibration survives across runs. |
| `ACE/<opp>/open-questions.md` | Deferred questions that accrete across runs until answered. |
| `ACE/<opp>/current/` | Shortcut folder pointing at the latest run's Phase 4/4 outputs (refreshed at phase completion — see § Current/ shortcut refresh). |

**Per-run — under `ACE/<opp>/runs/<run-id>/`; copy or re-derive when
forking:**

| Path | Role |
|---|---|
| `runs/<run-id>/run_state.yaml` | Lifecycle state — phase/step pointer, mode, `last_actor`, timestamps. New file at each new run-id. |
| `runs/<run-id>/README.md` | Per-run index regenerated after each phase via `generateRunReadme(...)`. |
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

## Phase Write-Back Contract

Every phase agent (subagent or procedure doc) MUST update
`run_state.yaml` on completion with the per-phase block shape below.
Without this, `/ace:status` misreports the run state, `opp-eval`'s
phase-rollup walks empty, and resume-after-interrupt logic can't tell
which phases already shipped.

**Source-of-truth implementation:** `lib/run-state-validator.ts` exports
`validateRunState(parsed)` (returns structured `{valid, errors, warnings}`)
and `classifyPhaseWriteBack(parsed, phaseName)` (returns one of
`'ok' | 'missing' | 'in_progress' | 'error' | 'malformed'`). Tests pin
every shape invariant the prose below describes — if you change either,
update the other. The orchestrator's silent-dispatch retry (§ Auto-retry
silent Agent dispatches in `ace-orchestrator.md`) treats `'missing'`,
`'in_progress'`, and `'malformed'` as retry triggers; `'error'` is a
real phase failure that halts.

**Required shape.** Each phase writes its own top-level
`phases.<phase-name>` block:

```yaml
phases:
  <phase-name>:
    status: in_progress | done | error
    started_at: <ISO timestamp>            # when the dispatch fired
    completed_at: <ISO timestamp>          # required when status: done
    verdict: pass | proceed | proceed-with-warn | reject | halt-at-… | closed
                                            # phase-specific terminal disposition
                                            # `closed` is reserved for Phase 10 (closeout) —
                                            # terminal-phase synonym for `pass`
    summary_artifact: <Drive fileId>        # required if the phase produces a summary doc
    steps:
      <skill-name>:
        status: done | error | incomplete
        verdict: pass | warn | fail | incomplete | <skill-specific>
        started_at: <ISO>
        completed_at: <ISO>
        artifact: <relative path>           # REQUIRED when status: done — the primary artifact
        file_id: <Drive fileId>             # REQUIRED when status: done — Drive file ID
        artifacts:                          # additional Drive fileIds if the skill produces multiple
          <name>: <fileId>
```

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

## Pause Points

`/ace:run` may pause at named points where the next action affects external parties or where a phase boundary needs operator-level review. There is **no separate "gate-brief" artifact** — at each pause, the orchestrator reads the per-skill QA verdict (`<phase>/<producer>-qa_result.yaml`) + eval verdict (`<phase>/<producer>-eval_verdict.yaml`) directly and synthesizes a pause-time summary on the fly. The verdict files are the source of truth; the orchestrator is just the renderer.

**Pause points and per-mode behavior:**

| Pause point | Phase | `default` | `review` | `auto` |
|------|-------|-----------|----------|--------|
| After `idea-to-pdd` | 1 | pause iff any `[BLOCKER]` from QA or eval | always pause | never pause* |
| After `app-deploy` | 3 | pause iff any `[BLOCKER]` | always pause | never pause* |
| After `ocs-chatbot-eval --quick` | 5 | pause iff any `[BLOCKER]` | always pause | never pause* |
| After `llo-invite` | 8 | never pause (passive solicitation invites) | always pause | never pause* |
| **Phase 8→9 boundary** | 8→9 | **always pause** (waits for `selected_llo`) | always pause | always pause |
| Before `llo-onboarding` | 9 | always pause (first 1-1 email to awardee) | always pause | always pause |
| Before `llo-uat` send | 9 | always pause (UAT instructions to awardee) | always pause | always pause |
| Before `llo-launch` | 9 | always pause (opp activation in Connect) | always pause | always pause |
| Before `opp-closeout` | 10 | always pause (Jira payment ticket) | always pause | always pause |

\*`auto` still pauses on `[BLOCKER]` — admins opted into auto mode for speed, not to ship known-broken work. The Phase 8→9 boundary + Phase 9 external-comms + Phase 10 closeout pauses are unconditional in all modes because they affect external parties.

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

The Phase 3 procedure doc (commcare-setup) is the highest-risk surface
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

Phase 3 (`commcare-setup`) executes inline at level 0. After each
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
is `opp.yaml.connect.program.{id, url, labs_int_id}`, the durable
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
background fix-and-ship subagent, the subagent's final step MUST be
an explicit poll loop that waits for a terminal PR state. Returning
after `gh pr merge --auto --merge` is armed — without confirming the
merge actually landed — is the canonical failure mode that surfaced
across all 6 fix-and-ship dispatches in the turmeric 20260515-0536
cycle. Each one returned "checks running" / "watchers armed" / "PR
queued" and the operator had to re-poll manually.

### Bad pattern (don't do this)

```
... (subagent does the fix + push + PR creation) ...

gh pr merge 333 --auto --merge

Return: PR #333 created and auto-merge armed. clean-install check
        is running.
```

The subagent has no idea whether the PR merged. The next dispatcher
either polls itself (defeats the point of backgrounding) or assumes
success (silently builds on un-merged work).

### Good pattern (canonical)

```
... (subagent does the fix + push + PR creation) ...

gh pr merge 333 --auto --merge

# Poll until terminal state: MERGED, DIRTY (needs rebase), or
# any FAILURE in the status check rollup.
until [ "$(gh pr view 333 --json state -q .state 2>/dev/null)" = "MERGED" ] || \
      [ "$(gh pr view 333 --json mergeStateStatus -q .mergeStateStatus 2>/dev/null)" = "DIRTY" ] || \
      gh pr view 333 --json statusCheckRollup -q '.statusCheckRollup[] | select(.conclusion=="FAILURE")' 2>/dev/null | grep -q .; do
  sleep 30
done

Return: PR #333 state=<MERGED|DIRTY|CHECK-FAILED>
        mergedAt=<timestamp-if-merged>
        failed-check=<name-if-failure>
```

If `DIRTY` surfaces, the subagent should resolve via
`bash scripts/version-bump.sh --rebase-first && git push --force-with-lease`
and re-enter the poll. If a check `FAILURE` surfaces, return the check
name + URL — the orchestrator decides whether to escalate or relaunch
with a fix.

The poll loop is cheap (one `gh pr view` per 30s; ~6 calls per merge
cycle) and is the only signal that distinguishes "merged" from "armed
but stuck."

### Required fields in the subagent return

- PR URL
- Final state (MERGED / DIRTY-after-rebase-exhausted / CHECK-FAILED /
  open-waiting-only-if-timeout)
- For MERGED: `mergedAt`
- For DIRTY-after-rebase-exhausted: which non-version files conflicted
- For CHECK-FAILED: check name + first 200 chars of failure log

See also: `CLAUDE.md § Plugin updates — NEVER locally patch` for the
end-to-end "bump → PR → poll → /ace:update" workflow this template
slots into.
