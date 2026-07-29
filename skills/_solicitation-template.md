# `solicitation-*` skill template

Shared conventions for ACE's Phase 8 solicitation skills:
`solicitation-create`, `solicitation-monitor`, `solicitation-review`,
plus their evals (`solicitation-create-eval`, `solicitation-review-eval`)
and the `llo-invite` invitation-side companion. All consume the
connect-labs MCP and share a contract around the `solicitation` and
`selected_llo` blocks under `run_state.yaml.phases.solicitation-management.products`
in the current run's state file. Per-run only — every `/ace:run`
publishes a fresh solicitation; awarded LLO lives only in the
producing run's state.

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

Phase 8 owns two `products` blocks under
`runs/<run-id>/run_state.yaml.phases.solicitation-management`. `products`
is the contract name — it is what `lib/phase-products-schema.ts` validates,
what the `verify_phase_products` atom checks, and what ace-web's summary
page reads. There is no `outputs` block:

```yaml
phases:
  solicitation-management:
    products:
      solicitation:
        # Audit trail — populated by solicitation-create, updated by
        # solicitation-monitor, finalized by solicitation-review.
        solicitation_id: <labs record id — an INTEGER, e.g. 10687, not a UUID>
        labs_program_id: <integer — labs's program id, NOT the Connect UUID>
        url: <same as public_url — ace-web reads `url` and falls back to `public_url`>
        public_url: https://labs.connect.dimagi.com/solicitations/<id>/
        manage_url: https://labs.connect.dimagi.com/solicitations/<id>/edit/
        deadline: <ISO date>
        status: open | closed | awarded
        # ACE-side bookkeeping — the Connect program / opp this solicitation
        # is INTENDED to feed into. Labs has no foreign-key link to either.
        # Free to update at any time without touching labs.
        connect_program_id: <Connect program UUID>
        connect_opportunity_id: <Connect opp UUID, may change pre-award if the opp is repointed>
        awarded:
          response_id: <labs response id>
          awarded_at: <ISO timestamp>
          awarded_org_slug: <Connect workspace slug>
          awarded_org_name: <LLO display name>
          awarded_contact_email: <LLO contact>
          award_amount: <number>

      selected_llo:
        # Narrow contract — the single block Phase 9 reads to know who
        # to onboard. Populated EXCLUSIVELY by solicitation-review after
        # human-in-the-loop approval.
        org_slug: <Connect workspace slug>
        contact_email: <LLO contact>
        source: solicitation
        response_id: <labs response UUID>
```

**URL shape is `/solicitations/<id>/` — there is NO `/labs/` prefix and no
`/grants/` segment.** `connect-labs/config/urls.py` mounts the solicitations
app at `/solicitations/`; the `/labs/` prefix is reserved for the
authenticated Labs UI (overview, login, explorer). See
`skills/solicitation-create/SKILL.md § Step 6`.

Every Phase 8 skill reads and writes only the current run's
`run_state.yaml`. Each `/ace:run` publishes a fresh solicitation; no
cross-run inheritance. The recurring `solicitation-monitor` runs
read-only against the most recent run; its `--close` mode is deferred
pending the Phase 8+/8 redesign.

**Per-run only.** Every read and write goes through the current
run's `run_state.yaml`. No cross-run reads. Each `/ace:run` publishes
a fresh solicitation; stale solicitations from prior runs are
operator-cleaned-up when picking a release-candidate run.

### `program_id` vs `labs_program_id`

Labs and Connect use different identifiers for the same program:

- `opp.yaml.connect.program.id` — the **Connect** program UUID
  (e.g. `cae9f0f5-...`). Written by `connect-program-setup` on first
  create; the durable cross-run reference reused across every run of
  the opp. Each run's `connect-opp-setup` copies it into
  `phases.connect-setup.products.connect.program.id` so the run state
  is self-contained.
- `phases.solicitation-management.products.solicitation.labs_program_id`
  — the **labs** integer program ID (e.g. `138`). Resolved by
  `solicitation-create` via a one-time `labs_context()` name match
  against the Connect program name, then cached at the durable
  `opp.yaml.connect.program.connect_int_id` location. Consumed by all
  three Phase 8 skills (`solicitation-create`, `solicitation-monitor`,
  `solicitation-review`) whenever they call labs MCP atoms that need
  program scope.

Despite the labs MCP schema declaring `program_id: string`, labs's
server-side `LabsRecord` adapter calls `int()` on it and rejects UUIDs
with `ValueError: invalid literal for int()`. Always pass the labs
integer id (as a string) to labs MCP, never the Connect UUID.

**Invariant:** `selected_llo.org_slug` is set if and only if
`solicitation.status == 'awarded'` and a human approved the award via
`solicitation-review`. Phase 9's `llo-onboarding` halts immediately if
this invariant is violated.

### Labs scoping invariant (load-bearing)

A labs solicitation is scoped to **one labs program** (`labs_program_id`)
and that's the only labs-side foreign key. There is **no** labs-side
foreign key to a specific Connect opportunity. The
`connect_opportunity_id` and `connect_program_id` fields under
`phases.solicitation-management.products.solicitation` are **ACE-side
bookkeeping** — ACE's record of which Connect opp the solicitation is
*intended* to feed into. Labs neither knows nor cares.

**Practical consequences:**

- The same solicitation is sometimes published *before* the Connect opp
  exists. `solicitation-create` fires when the program is set; the
  Connect opp wires up later in the same run or a later run.
- Repointing the Connect opp pre-award (e.g., `connect-opp-setup`
  delete-and-recreate to refresh app-wire fields after a Phase 3
  re-upload) **does not orphan or affect the labs solicitation**. The
  public solicitation URL keeps working, the deadline keeps counting
  down, and pending responses are unaffected. ACE just updates the
  `connect_opportunity_id` bookkeeping field.
- `solicitation-review` reads `connect_opportunity_id` at the moment of
  award and writes the awardee onto **that** opp via Phase 9. It does
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

All Phase 8 artifacts live under:
`ACE/<opp-name>/runs/<run-id>/8-solicitation-management/`

Per-skill subpaths:

**`lib/artifact-manifest.ts` is the authoritative registry.** If this table
ever disagrees with it, the manifest wins and this table is the bug — the
phase artifact fence (`verify_phase_artifacts`) validates against the
manifest, not against this file.

`required` below is the manifest's own flag — what `verify_phase_artifacts`
halts on. Note that only the eval verdict and the phase summary are
`required: true`; the draft/published pair is `required: false` because a
`--no-evals` or dry-run pass can legitimately stop short.

| Skill | Artifact path | `required` |
|---|---|---|
| `solicitation-create` | `solicitation-create_draft.md` | false |
| `solicitation-create` | `solicitation-create_published.md` | false |
| `solicitation-create-eval` | `solicitation-create-eval_verdict.yaml` | **true** |
| `llo-invite` | `llo-invite_invitations.md` | false — a no-op when the PDD names no `Preferred LLOs`; still write the file recording the skip |
| `solicitation-monitor` | `solicitation-monitor_responses/` (one file per response) | false |
| `solicitation-review` | `solicitation-review_scoring-rubric.md` | false |
| `solicitation-review` | `solicitation-review_recommendation.md` | false |
| `solicitation-review` | `solicitation-review_award-record.md` | false |
| `solicitation-review-qa` | `solicitation-review-qa_result.yaml` | false |
| `solicitation-review-eval` | `solicitation-review-eval_verdict.yaml` | false |
| (phase) | `solicitation-management_summary.md` | **true** |

## Phase 8 → Phase 9 boundary

Phase 8 is the first phase that publishes anything publicly (the
solicitation listing). Phase 9 is the first phase that contacts
specific LLOs (with the awarded LLO).

`solicitation-create` and `llo-invite` run in default `/ace:run`.
`solicitation-monitor` runs recurring while open.
`solicitation-review` is **manual only** — it requires human
approval before populating `selected_llo`. `/ace:run` halts at
Phase 8 close and waits for the operator to invoke
`/ace:step solicitation-review <opp>` once they've decided the
awardee.

Phase 9 entry gate:
`phases.solicitation-management.products.selected_llo.org_slug` in
the current run's `run_state.yaml` must be a non-empty string. The
orchestrator enforces this before dispatching
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
  `agents/ace-orchestrator.md` and Phase 9 entry-gate code).
- Connect-labs MCP adds/removes an atom (update inventory).
- Phase 8 sequencing changes.
