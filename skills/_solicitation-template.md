# `solicitation-*` skill template

Shared conventions for ACE's Phase 7 solicitation skills:
`solicitation-create`, `solicitation-monitor`, `solicitation-review`,
plus their evals (`solicitation-create-eval`, `solicitation-review-eval`)
and the `llo-invite` invitation-side companion. All consume the
connect-labs MCP and share a contract around the `solicitation` and
`selected_llo` blocks under `run_state.yaml.phases.solicitation-management.outputs`.
(Pre-PR-b opps still carry these blocks under `opp.yaml.solicitation` /
`opp.yaml.selected_llo` — fallback reads remain until cleanup PR e.)

This is a **reference document**, not a skill. It is not invoked.
Excluded from the skill catalog because the filename starts with `_`.

## Skeleton

```markdown
# <Skill Name>

(1-3 sentence framing — what this skill does in the solicitation
lifecycle, what blocks it on entry, what it unblocks on exit.)

## Inputs

(Drive paths + opp.yaml blocks + labs MCP queries.)

## Process

(Per-skill specifics.)

## Error handling

(How to fail vs. retry vs. halt.)

## Output

(Drive artifacts + opp.yaml mutations.)

## MCP Tools Used

See `skills/_eval-template.md § MCP Tools Used (stock)` for the Drive
block. Plus connect-labs atoms (per skill — see "Atom inventory" below).

## Mode Behavior

See `skills/_eval-template.md § Mode Behavior (stock)`.
```

## run_state.yaml contract

Phase 7 owns two `outputs` blocks under
`runs/<run-id>/run_state.yaml.phases.solicitation-management`:

```yaml
phases:
  solicitation-management:
    outputs:
      solicitation:
        # Audit trail — populated by solicitation-create, updated by
        # solicitation-monitor, finalized by solicitation-review.
        id: <labs solicitation UUID>
        labs_program_id: <integer — labs's program id, NOT the Connect UUID>
        public_url: https://labs.connect.dimagi.com/grants/solicitation/<id>/
        deadline: <ISO date>
        status: open | closed | awarded
        # ACE-side bookkeeping — the Connect program / opp this solicitation
        # is INTENDED to feed into. Labs has no foreign-key link to either.
        # Free to update at any time without touching labs.
        connect_program_id: <Connect program UUID>
        connect_opportunity_id: <Connect opp UUID, may change pre-award if the opp is repointed>
        awarded:
          response_id: <labs response UUID>
          awardee_org_slug: <Connect workspace slug>
          awarded_at: <ISO timestamp>
          awarded_by: <human operator>

      selected_llo:
        # Narrow contract — the single block Phase 8 reads to know who
        # to onboard. Populated EXCLUSIVELY by solicitation-review after
        # human-in-the-loop approval. (Migrates in PR c — pre-PR-c writers
        # still emit to opp.yaml.selected_llo.)
        org_slug: <Connect workspace slug>
        contact_email: <LLO contact>
        source: solicitation
        response_id: <labs response UUID>
```

The blocks are inherited across runs via the orchestrator's run-init
seed step (see `agents/ace-orchestrator.md § Step 6b`), so every
Phase 7 skill reads only the current run's `run_state.yaml`. The
recurring `solicitation-monitor` updates the producing run's state
directly — see `agents/orchestrator-reference.md § Recurring Writers`.

**Backward-compat reads.** Each consumer reads new location first,
falls back to legacy `opp.yaml.solicitation` / `opp.yaml.selected_llo`
for opps that pre-date PRs b/c. Fallbacks strip in cleanup PR e.

### `program_id` vs `labs_program_id`

Labs and Connect use different identifiers for the same program:

- `opp.yaml.program_id` (top-level) — the **Connect** program UUID
  (e.g. `cae9f0f5-...`). Written by `connect-program-setup` in Phase 3
  and consumed by Connect-side skills (`llo-onboarding`, `llo-launch`,
  etc.). Migration of this field is part of PR a (Connect block) — it
  also surfaces at `phases.connect-setup.outputs.connect.program.id`.
- `phases.solicitation-management.outputs.solicitation.labs_program_id`
  — the **labs** integer program ID (e.g. `138`). Resolved by
  `solicitation-create` via a one-time `labs_context()` name match
  against the Connect program name, then cached. Consumed by all three
  Phase 7 skills (`solicitation-create`, `solicitation-monitor`,
  `solicitation-review`) whenever they call labs MCP atoms that need
  program scope. (Pre-PR-b: legacy
  `opp.yaml.solicitation.labs_program_id`.)

Despite the labs MCP schema declaring `program_id: string`, labs's
server-side `LabsRecord` adapter calls `int()` on it and rejects UUIDs
with `ValueError: invalid literal for int()`. Always pass the labs
integer id (as a string) to labs MCP, never the Connect UUID.

**Invariant:** `selected_llo.org_slug` is set if and only if
`solicitation.status == 'awarded'` and a human approved the award via
`solicitation-review`. Phase 8's `llo-onboarding` halts immediately if
this invariant is violated.

### Labs scoping invariant (load-bearing)

A labs solicitation is scoped to **one labs program** (`labs_program_id`)
and that's the only labs-side foreign key. There is **no** labs-side
foreign key to a specific Connect opportunity. The
`connect_opportunity_id` and `connect_program_id` fields under
`phases.solicitation-management.outputs.solicitation` are **ACE-side
bookkeeping** — ACE's record of which Connect opp the solicitation is
*intended* to feed into. Labs neither knows nor cares.

**Practical consequences:**

- The same solicitation is sometimes published *before* the Connect opp
  exists. `solicitation-create` fires when the program is set; the
  Connect opp wires up later in the same run or a later run.
- Repointing the Connect opp pre-award (e.g., `connect-opp-setup`
  delete-and-recreate to refresh app-wire fields after a Phase 2
  re-upload) **does not orphan or affect the labs solicitation**. The
  public solicitation URL keeps working, the deadline keeps counting
  down, and pending responses are unaffected. ACE just updates the
  `connect_opportunity_id` bookkeeping field.
- `solicitation-review` reads `connect_opportunity_id` at the moment of
  award and writes the awardee onto **that** opp via Phase 8. It does
  not require the value to have been stable since the solicitation was
  published.
- Skills that worry about "the labs solicitation will 404 if I delete
  the Connect opp" are wrong. Re-check the assumption against this
  invariant before treating opp delete-and-recreate as expensive.

This invariant is the source of truth for downstream skill logic that
touches the solicitation/opp boundary. If you find yourself writing a
guard like "halt because the solicitation is wired to the opp,"
re-read this section.

## Atom inventory (connect-labs MCP)

| Skill | Atoms used |
|---|---|
| `solicitation-create` | `create_solicitation` |
| `solicitation-monitor` | `list_responses`, `get_response`, `get_solicitation` |
| `solicitation-review` | `list_responses`, `get_response`, `create_review`, `award_response` |
| `llo-invite` | None (uses `email-communicator` skill — labs is public-listing only here) |

`generate_criteria` is **not** an MCP tool — it's an HTTP endpoint
that lives on labs.connect.dimagi.com. `solicitation-create` derives
criteria locally from the PDD instead. (Common confusion: some
historical docs claimed it as a 10th MCP atom — that was incorrect.)

## Drive paths

All Phase 7 artifacts live under:
`ACE/<opp-name>/runs/<run-id>/6-solicitation-management/`

Per-skill subpaths:

| Skill | Artifact path |
|---|---|
| `solicitation-create` | `solicitation-create_summary.md` |
| `solicitation-monitor` | `solicitation-monitor_responses/<response_id>.yaml` |
| `solicitation-review` | `solicitation-review_award-record.md` + verdict |
| `llo-invite` | `llo-invite_outbound-emails/<llo>.md` |

## Phase 7 → Phase 8 boundary

Phase 7 is the first phase that publishes anything publicly (the
solicitation listing). Phase 8 is the first phase that contacts
specific LLOs (with the awarded LLO).

`solicitation-create` and `llo-invite` run in default `/ace:run`.
`solicitation-monitor` runs recurring while open.
`solicitation-review` is **manual only** — it requires human
approval before populating `selected_llo`. `/ace:run` halts at
Phase 7 close and waits for the operator to invoke
`/ace:step solicitation-review <opp>` once they've decided the
awardee.

Phase 8 entry gate:
`phases.solicitation-management.outputs.selected_llo.org_slug` (or
legacy `opp.yaml.selected_llo.org_slug` for pre-PR-c opps) must be a
non-empty string. The orchestrator enforces this before dispatching
`Agent(execution-manager)`.

## Why human-in-the-loop on review

The award decision is irrevocable from Connect's perspective (it
records the awardee and the funding split). ACE intentionally does
NOT auto-award based on rubric scores alone — the rubric ranks
candidates, but a human selects the awardee. This keeps ACE off the
hook for the most consequential decision in the cycle.

`solicitation-review-eval` grades whether ACE's top-ranked
recommendation matched the human's pick (detection-rate metric).
That's a calibration signal, not a decision input.

## When to update this template

Edit when:
- The run_state.yaml contract changes (then also update
  `agents/ace-orchestrator.md` and Phase 8 entry-gate code).
- Connect-labs MCP adds/removes an atom (update inventory).
- Phase 7 sequencing changes.
