# Consolidate evolving state into run_state.yaml

**Date:** 2026-05-10 (revised 2026-05-11)
**Status:** Implemented + corrected. See § Correction addendum below before reading the rest of this doc.
**Owner:** ACE

> **Naming note (2026-05-11, 0.13.166):** the block originally named
> `phases.<phase>.outputs.<block>` was renamed to
> `phases.<phase>.products.<block>` for clarity — see CHANGELOG 0.13.166.
> Inline references in this spec have been updated; the rest of the prose
> still uses "outputs" where it reads naturally as English.

## Correction addendum (2026-05-11)

This doc as originally drafted had two structural mistakes that
landed in PRs a-d and were reverted in PR f:

1. **The seed step is gone.** The original design had the orchestrator
   copy `phases.<phase>.products.*` forward from the most recent prior
   run at run init. **Runs are independent** — every `/ace:run` is a
   bubble; no run reads from or writes to another run's
   `run_state.yaml`. The seed step was deleted.
2. **No recurring-writer rule.** The original design had cron-driven
   monitors mutate the producing run's state. **Recurring writers are
   TBD** alongside the Phase 7+/8 redesign (awarding, execution,
   closeout). `solicitation-monitor` is read-only against the most
   recent run; its `--close` mode is deferred.

The actual mental model (correction):

- **`opp.yaml`** holds identity (display_name, slug, tags, created_at,
  created_by) **plus the durable Connect program reference** at
  `connect.program.{id, url, labs_int_id}`. The Connect program is
  the one cross-run-reused entity; `connect-program-setup` writes it
  on first create.
- **Every other entity** (Connect opportunity, OCS chatbot,
  solicitation, selected_llo, synthetic data + workflows +
  walkthroughs) is created **fresh per run** and lives only in that
  run's `run_state.yaml.phases.*.products.*`. Stale entities from
  abandoned runs are operator-cleaned-up when picking a release-
  candidate run.
- Each run's `products.connect` includes a **copy** of the program
  reference (read from `opp.yaml.connect.program` at run time) so the
  run state file is self-contained for forking / debugging.

The rest of this doc is the original design as drafted. Read it for
history; the implementation (and `agents/orchestrator-reference.md`)
reflects the corrected model.

## Goal

`opp.yaml` becomes a thin identity file. `run_state.yaml` becomes the single
source of truth for every piece of state that evolves across the lifecycle of an
opportunity. `connect-state.yaml` goes away.

After this refactor:

- `opp.yaml` contains only: `display_name`, `slug`, `tags`, `created_at`,
  `created_by`. Read at run init by the orchestrator and by ace-web's opp-list
  view. Never mutated by any phase skill.
- `run_state.yaml` carries every block any skill or recurring job needs to read
  or write: phase progress, verdicts, Connect identifiers, OCS chatbot,
  solicitation, awarded LLO, synthetic data + workflows.
- Cross-run inheritance happens once, at run init, when the orchestrator seeds
  the new run's `run_state.yaml` from the prior run's. Skills never walk across
  runs.

## Background

The repo has accumulated three stores for "state that survives a single phase":

1. `opp.yaml` at the opp root — currently carries identity fields plus the
   `selected_llo`, `solicitation`, `synthetic.*`, `connect`, and `ocs_chatbot`
   blocks. Read by 15+ skills; written by ~10.
2. `connect-state.yaml` at the opp root — Connect program/opp UUIDs and ACE
   test-user invite metadata. Overlaps in purpose with `opp.yaml.connect`
   (both written by `connect-opp-setup`, both read by Phase 5 / 8).
3. `run_state.yaml` at `runs/<run-id>/` — per-run phase progress, verdicts,
   timestamps. Already governed by the Phase Write-Back Contract.

The overlap is genuine: `connect-opp-setup` today writes UUIDs to
`opp.yaml.connect` AND test-user metadata to `connect-state.yaml`. There is no
principled split — it's just where each field landed. A perf-lens PR (#217)
recently added a fourth pattern (rich `opp.yaml.ocs_chatbot` block for cross-run
chatbot reuse) and was reverted in #221 because the architecture wasn't clear
enough to guide placement. This design fixes that.

## Target architecture

### opp.yaml — identity only

```yaml
display_name: "Turmeric malaria FLW pilot"
slug: turmeric
tags: [phase-2-vertical-slice]
created_at: 2026-04-12T15:30:00Z
created_by: jjackson@dimagi.com
```

That's the whole file. ace-web reads it to render the opp list. The orchestrator
reads it at run init. Nothing else reads or writes it.

### run_state.yaml — source of truth for evolving state

Existing shape (governed by Phase Write-Back Contract):

```yaml
phases:
  <phase-name>:
    status: in_progress | done | error
    started_at: ...
    completed_at: ...
    verdict: pass | proceed | reject | ...
    summary_artifact: <fileId>
    steps:
      <skill>:
        status: ...
        verdict: ...
        artifacts: { ... }
```

New addition — `products` block per phase for typed cross-run state:

```yaml
phases:
  connect-setup:
    status: done
    completed_at: 2026-05-08T14:00:00Z
    verdict: pass
    steps: { ... }
    products:
      connect:
        program:
          id: <UUID>
          url: <CONNECT_BASE_URL>/a/<org>/program/<uuid>/
        opportunity:
          id: <UUID>
          url: <CONNECT_BASE_URL>/a/<org>/opportunity/<uuid>/
          labs_int_id: <integer | null>
        ace_test_user:
          invited_phone: ${ACE_E2E_PHONE}
          invited_at: 2026-05-08T14:02:11Z

  ocs-setup:
    products:
      ocs_chatbot:
        experiment_id: <UUID>
        widget_url: ...

  synthetic-data-and-workflows:
    products:
      synthetic:
        generated_at: ...
        labs_opp_id: ...
        workflows:
          llo_weekly_review_id: ...
          program_admin_audit_id: ...
        walkthroughs:
          - persona: program-admin
            run_id: 2026-05-09-1430
            ...

  solicitation-management:
    products:
      solicitation:
        solicitation_id: ...
        labs_program_id: ...
        deadline: ...
        status: open | closed
        connect_opportunity_id: ...
      selected_llo:
        org_slug: ...
        contact_email: ...
        source: solicitation-review
        response_id: ...
        program_application_id: ...
```

The `products` block is *typed cross-run state* — fields that subsequent runs
inherit. Distinct from `steps.*.artifacts`, which is per-run scratch (Drive
fileIds for this run's verdicts, transcripts, etc.).

## Cross-run inheritance — orchestrator seeds at run init

Skills do not search across runs. When `/ace:run` mints a new run-id, the
orchestrator does this once:

1. List `ACE/<opp>/runs/` and pick the most recently modified prior run-id (if
   any).
2. Read that run's `run_state.yaml`.
3. For each phase, copy `phases.<phase>.products` into the new run's
   `run_state.yaml` as the starting value. Leave `status`, `verdict`,
   `started_at`, `completed_at`, `steps` empty — those are this run's to fill.
4. Write the seeded `run_state.yaml` to the new run folder.

From that point on, every skill reads only the current run's `run_state.yaml`.
Reuse decisions ("is there already a Connect opp for this opp?") read
`phases.connect-setup.products.connect` in the current run, exactly the same
shape whether the value was just produced or inherited.

Forking from a specific prior run is the same operation with a chosen source
run-id instead of "most recent."

### Why this works for reuse semantics

Today the orchestrator reuses an existing Connect opp when
`opp.yaml.connect.opportunity.id` is set. After this refactor, the same check
reads `phases.connect-setup.products.connect.opportunity.id` from the current
run's `run_state.yaml` — which the orchestrator seeded from the prior run at
run init. The reuse decision is structurally identical; the storage path
changed.

## Recurring writers — mutate the producing run's state

Some jobs run on cron, outside any `/ace:run` invocation:
`solicitation-monitor`, `timeline-monitor`, `flw-data-review`,
`ocs-chatbot-{qa,eval}-monitor`. They need to mutate state without owning a
run-id.

**Rule:** a recurring writer mutates the `run_state.yaml` of the run that
*produced* the block it's updating.

Example: `solicitation-monitor` updates
`phases.solicitation-management.products.solicitation.status` from `open` to
`closed`. The block was produced by `solicitation-create` during run
`2026-05-01-0900`. The monitor reads `runs/2026-05-01-0900/run_state.yaml`,
patches the field, writes back. No new run-id is minted.

The monitor finds the producing run by inheritance chain: the most recent run's
`products.solicitation` was seeded from its parent, all the way back to the one
that originally created it. In practice the monitor reads the most recent run's
state (since the seeded chain converges on the same producing source) and the
patch propagates forward on the next `/ace:run` via the seed step.

This violates a strict "every state mutation owned by a unique run" purity but
matches the actual semantics: the state belongs to the work that produced it,
the monitor is bookkeeping.

### Open subtlety: which run holds the canonical copy?

After several `/ace:run`s, every run's `run_state.yaml` has `products.solicitation`
(inherited via seed). If `solicitation-monitor` flips `status: closed` on run
A's state, but run B (later) was seeded from run A *before* the close, run B's
state is stale.

**Resolution.** The monitor writes to the *most recent* run's `run_state.yaml`
— that's the one any future seed step will copy from. Older runs' copies are
read-only history. If the monitor needs to flip while a `/ace:run` is in flight,
the standard `update_yaml_file` CAS retry handles it (one writer wins, the other
re-reads and re-merges).

This is documented as the canonical recurring-writer pattern in
`agents/orchestrator-reference.md § Recurring Writers` (new section in PR e).

## Backward compatibility

Each migration PR has every skill that touches the block read **new location
first, fall back to old location**:

```
Read sequence:
  1. run_state.yaml.phases.<phase>.products.<block>   (new — preferred)
  2. opp.yaml.<block>                                 (old — fallback)
  3. connect-state.yaml                               (old — Connect block only)
```

Writes go **only to the new location** from the migration PR forward.

This lets existing opps (e.g., `turmeric`) keep working: their existing
`opp.yaml.solicitation` block is still read until the next `/ace:run` writes
fresh state to `run_state.yaml`, at which point the new location takes over.

Old opp.yaml fields are not deleted by the migration — operators may have
hand-edited annotations. The final cleanup PR (PR e) strips fallbacks once
every live opp has run at least once on the new shape.

## Out of scope

- **Operator-edited fields in `opp.yaml`.** Turmeric has hand-edited fields like
  `widget_pasted_into_connect`, `collection_id_per_opp`. These are personal
  annotations, not load-bearing. They stay where they are; nothing breaks.
- **OCS chatbot cross-run reuse.** PR #217's idea (reverted in #221) was an
  optimization, not a correctness issue. After this refactor lands, the shape
  for re-introducing it is obvious: `phases.ocs-setup.products.ocs_chatbot` with
  inheritance via the seed step. Pick it up in a later PR.
- **ace-web's fork-a-run feature.** Today's implementation works against the
  current shape and will continue working through the migration (each PR keeps
  backward-compat reads). After PR e strips fallbacks, the fork operation
  simplifies to "copy run X's run_state.yaml into a new run-id" — a one-step
  inheritance instead of "copy opp.yaml fields + clone state."
- **New MCP atoms.** No discovery helper, no new ace-gdrive atoms. The
  orchestrator's seed step is implemented with existing `drive_list_folder` +
  `drive_read_file` + `update_yaml_file`.

## PR sequence

Each PR is independently shippable and reversible. Read-old-and-new fallbacks
keep all live opps working through the entire sequence.

### PR a — Connect block migration

Move `opp.yaml.connect.*` AND `connect-state.yaml` into
`run_state.yaml.phases.connect-setup.products.connect`. The two stores collapse
in one PR.

**Skills changed (write):**
- `connect-opp-setup` — writes `phases.connect-setup.products.connect.*` instead
  of `opp.yaml.connect` and `connect-state.yaml`.
- `connect-program-setup` — same pattern for the program sub-block.

**Skills changed (read):**
- `connect-opp-setup` reuse check (program/opp reuse decisions).
- `synthetic-data-generate` (reads `labs_int_id`).
- `llo-launch`, `llo-uat`, `app-screenshot-capture` (read test-user metadata).

**Orchestrator changes:**
- Add the seed-from-prior-run step at run init (the mechanism every later PR
  also relies on — first PR introduces it).

**Manifest changes:**
- `lib/artifact-manifest.ts` — drop the `connect-state.yaml` entry; update
  `opp.yaml`'s description.

### PR b — Solicitation block migration

Move `opp.yaml.solicitation` to
`run_state.yaml.phases.solicitation-management.products.solicitation`.

**Skills changed:** `solicitation-create` (write), `solicitation-monitor`
(write — first use of the recurring-writer pattern; documents the rule in the
SKILL.md), `solicitation-review` (read), `connect-opp-setup` (reads
`solicitation.connect_opportunity_id` in step 7 — needs the fallback).

**Doc changes:** `agents/orchestrator-reference.md § Recurring Writers` new
section.

### PR c — selected_llo block migration

Move `opp.yaml.selected_llo` to
`run_state.yaml.phases.solicitation-management.products.selected_llo`.

**Skills changed:** `solicitation-review` (write), `llo-onboarding` (read —
Phase 8 entry gate), `llo-launch`, `llo-uat`, `llo-invite`, and recurring
monitors (`timeline-monitor`, `flw-data-review`, `ocs-chatbot-qa-monitor`,
`ocs-chatbot-eval-monitor`).

**Orchestrator changes:** Phase 8 entry gate in `agents/ace-orchestrator.md` —
reads new location with fallback.

**Doc changes:** `skills/_solicitation-template.md` references update.

### PR d — Synthetic block migration

Move `opp.yaml.synthetic.*` (including nested `synthetic.workflows` and
`synthetic.walkthroughs[]`) to
`run_state.yaml.phases.synthetic-data-and-workflows.products.synthetic`.

**Skills changed:** `synthetic-data-generate` (write
`generated_at`, `labs_opp_id`), `synthetic-workflow-seed` (write
`workflows.*`), `synthetic-walkthrough-run` (append to `walkthroughs[]`),
`synthetic-summary` (read), `synthetic-workflow-polish` (read), all
`*-eval` skills that read these (`synthetic-summary-eval`,
`synthetic-workflow-seed-eval`, `synthetic-workflow-polish-eval`,
`synthetic-data-generate-eval`).

**Note on walkthroughs[].** This is the only block that's *append-only*
across runs. Today every walkthrough run appends to `opp.yaml.synthetic.walkthroughs[]`
in place. After migration: each run's walkthrough appends to *its own*
`products.synthetic.walkthroughs[]`. The seed step at run init copies the
prior run's list forward, so the chain stays continuous. Operators reviewing
walkthrough history read the most recent run's state.

### PR e — Docs sweep + fallback removal

- Rewrite `agents/orchestrator-reference.md § Fork Points` per-opp/per-run
  classification. `opp.yaml` becomes identity-only. `connect-state.yaml` is
  removed from the per-opp list. The per-run list grows to include every block
  moved in PRs a-d.
- Rewrite `CLAUDE.md § Improvement cycles & canopy` paragraph that names the
  per-opp files.
- Update `lib/artifact-manifest.ts` `opp.yaml` description to reflect the thin
  shape.
- Strip read-old-and-new fallbacks added in PRs a-d. Skills now read only the
  new location.

**Gate:** before this PR, every live opp must have run at least once on the
new shape (so its `run_state.yaml.phases.*.products.*` is populated). Verify by
checking each opp's most recent run's state file.

## Estimate

- PR a (Connect — two stores collapsing, first introduction of seed step):
  ~6h including QA on turmeric.
- PRs b/c/d (each one block): ~4-5h each including QA.
- PR e (docs + fallback strip): ~3h.
- **Total: ~25-30h across 5 PRs.**

Skills are largely prose, but every read/write path change needs to be
exercised against a live opp (turmeric is canonical) before landing. The seed
step in PR a is the only new orchestrator mechanism — once that's in, PRs b-d
are mechanical patches.

## Working agreements

- Design doc reviewed and merged before any migration PR opens.
- One block per migration PR. No bundling.
- Read-old-and-new in every migration PR; new writes only to new location.
- Don't delete existing `opp.yaml` content during migration — let old fields
  age out, strip in PR e.
- Each PR exercised against turmeric end-to-end before merge.
- Use `superpowers:subagent-driven-development` to run PRs b-d in parallel
  once PR a's seed step has landed (they touch disjoint blocks, no read
  dependencies between them).
