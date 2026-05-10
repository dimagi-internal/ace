# ACE Orchestrator — Reference

This doc is the *reference* counterpart to `agents/ace-orchestrator.md`. It catalogs schemas, contracts, lifecycle invariants, and architectural diagrams that the orchestrator's procedure references. The procedure doc tells you WHAT to do; this doc tells you the SHAPE of what you're doing.

If you're executing `/ace:run`, read `agents/ace-orchestrator.md` first. Come here only when the procedure points you at a specific section.

---

## Agent Topology

The architectural rule and full topology table live in `CLAUDE.md § Agent topology` (the canonical source — every session loads it). Summary for the orchestrator's purposes:

- **The rule:** anything that calls `Agent` runs at level 0. `ace-orchestrator` and `commcare-setup` (Phase 2) are procedure docs read and executed inline by the top-level session because they dispatch further work; the other seven agents (`design-review`, `connect-setup`, `ocs-setup`, `qa-and-training`, `execution-manager`, `closeout`, `ocs-tester`) are subagents dispatched via `Agent(...)` from level 0.
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
   `PHASE_FOLDERS`. **`PHASE_FOLDERS` in TypeScript is the source of
   truth — if this prose copy ever drifts, the TypeScript wins.**
   (Drift between this listing and the TS const has shipped at least
   once; if you find new drift, fix it here AND consider promoting the
   prose listing to a generated table.):
   - `design` → `1-design`
   - `commcare` → `2-commcare`
   - `connect` → `3-connect`
   - `ocs` → `4-ocs`
   - `qa-and-training` → `5-qa-and-training`
   - `synthetic-data-and-workflows` → `6-synthetic`
   - `solicitation-management` → `7-solicitation-management`
   - `execution-management` → `8-execution-manager`
   - `closeout` → `9-closeout`

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

## Producer Artifact Verifier

(populated in Task 5)

## Phase Write-Back Contract

(populated in Task 5)

## Phase Write-Back Verifier — procedure

(populated in Task 5)

## Pause Points

(populated in Task 6)

## Touching State — Operator Capture

(populated in Task 7)
