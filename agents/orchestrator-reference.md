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

After each phase completes (and write-back is verified), the
orchestrator MUST confirm every dispatched step actually produced the
files it declares in the artifact manifest. This is the structural
backstop for § Skill Invocation Discipline: even if the orchestrator
shortcuts a producer skill, the discipline violation surfaces at the
producing phase boundary instead of cascading into a downstream
consumer's pre-flight.

**Procedure.** For each step recorded in `phases.<phase>.steps`:

1. Call `artifactsProducedBy(<skill-name>)` from
   `lib/artifact-manifest.ts`.
2. For each returned entry where `required: true` AND the path does
   NOT contain `YYYY-MM-DD` (dated/recurring artifacts are skipped),
   list the run folder's phase subfolder (`drive_list_folder` on
   `<runFolderId>/<N>-<phase>/`) and confirm the path exists. For
   directory entries (paths ending in `/`), confirm at least one file
   lives under the prefix.
3. If any required path is missing, halt loud with:

   > `[BLOCKER]` `<skill>` step recorded as done in
   > `phases.<phase>.steps.<skill>` but did not produce required
   > artifact `<path>`. Likely cause: orchestrator inlined an artifact
   > instead of invoking the skill (see § Skill Invocation Discipline).
   > Recovery: `/ace:step <skill> <opp>/<run-id>` and re-run the
   > orchestrator from this point.

**Skips.** Steps with `status: skipped`, `status: error`, or
`status: incomplete` are not checked — they are explicit non-completions
and downstream phases will surface their own gaps. Optional artifacts
(`required: false`) and dated/recurring artifacts (`YYYY-MM-DD` in the
path) are also skipped.

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
patching `phases: { 'design-review': {...} }` would clobber every
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
`shallow` mode for one-shot whole-subtree replacements (e.g.,
`opp.yaml.connect = {...}` to fully overwrite the connect block when
the Connect opp was deleted-and-recreated). The contract above is
specifically for incremental run_state.yaml writes during a `/ace:run`.

Do NOT pair a manual `drive_read_file` + `drive_update_file` to
read-modify-write `run_state.yaml` from the agent — `update_yaml_file`
already does the read internally and its CAS retry is the
race-correctness mechanism. Skipping the tool to do it by hand
re-introduces the lost-update class of bug.

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
inline-composed `2-commcare/app-test-cases.yaml` from the PDD + app
summaries instead of invoking `Skill(app-test-cases)`, which would have
emitted the per-journey recipe files (`app-test-cases/J*.yaml`) that
Phase 5's `app-screenshot-capture` reads. Phase 5 halted at pre-flight
with `incomplete`, no AVD time burned but five training docs rendered
without screenshots and had to be re-run.

The Phase 2 procedure doc (commcare-setup) is the highest-risk surface
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

### Don't summarize and continue

The inline-artifact contract (§ Pre-flight & per-phase conventions)
breaks if the next phase's PDD is paraphrased rather than passed
verbatim. If you genuinely need to halt, write back
`phases.<current>.status: done` (or `error` with a one-line note) and
let the operator resume via `/ace:run <opp>/<run-id>` in a fresh
session. Never try to compress your own context to keep going — the
cure is worse than the disease.
