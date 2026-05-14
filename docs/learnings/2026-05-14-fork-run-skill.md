# Fork-run skill — ace-web alignment gaps

**Status:** Skill landed; ace-web alignment fixes pending (filed as a separate issue).

The ACE-side `fork-run` skill wraps `POST /api/opps/<slug>/runs/<run_id>/fork` on ace-web. The endpoint works structurally — copies upstream step folders, creates a working session, returns a new run-id — but two gaps mean the forked run isn't quite seamlessly addressable by ACE's own tooling. Documenting both here so operators know what to verify after a fork.

## Gap 1: run-id format mismatch

**Symptom:** ace-web's fork creates run-ids `run-001`, `run-002`, … (sequential per opp). ACE generates run-ids `YYYYMMDD-HHMM` (date-stamped). After a fork:

```
ACE/turmeric/runs/
├── 20260513-2243/    ← original ACE run
└── run-001/          ← fork created by ace-web
```

`/ace:run turmeric/run-001` might work depending on how the orchestrator resolves `<run-id>` — current code assumes `YYYYMMDD-HHMM` format for new runs but may accept arbitrary directory names for resume. Worth a live test.

**Proposed fix** (ace-web side): make the fork endpoint generate `YYYYMMDD-HHMM` ids (current time + collision suffix) instead of `run-NNN`. Aligns with ACE's convention; no ACE-side changes needed.

`apps/opps/fork.py:_next_run_id` is the function to change.

## Gap 2: state file naming

**Symptom:** ACE renamed the per-run state file from `state.yaml` to `run_state.yaml` in plugin v0.11.3 (per `CLAUDE.md § Improvement cycles & canopy`). ace-web's `apps/opps/fork.py:114-117` still searches for `state.yaml`:

```python
src_state = next(
    (f for f in drive.list_files(src_run.id) if f.name == "state.yaml"), None,
)
```

On a current-ACE run there IS no `state.yaml` — there's a `run_state.yaml`. So the carry-forward block doesn't fire. The new run gets created but has no state file at all in `with-feedback` mode. In `empty` mode, a tiny `state.yaml` is written (with the old name).

The orchestrator's resume path (`agents/ace-orchestrator.md`) reads `run_state.yaml`. Without it, the new run can't be resumed by `/ace:run` — the orchestrator has no idea what phases are done.

**Proposed fix** (ace-web side): replace the literal `"state.yaml"` with `"run_state.yaml"` in `fork.py`. One-character file rename + the upload-file call below. Two-line change, no schema migration needed.

## Why these are stuck "filed" not "fixed"

Both fixes are in the ace-web repo, not the ACE plugin repo. The ACE plugin can document the gap and ship a workaround (the `fork-run` skill could rename the file post-fork as a repair step), but the cleaner fix is server-side. Worth filing an issue against ace-web and letting it land there.

**Workaround (ACE-side):** post-fork repair step in the skill could:

1. `drive_list_folder` the new run folder
2. Find any `state.yaml`, rename to `run_state.yaml`
3. If neither exists, fetch the source run's `run_state.yaml`, write it as `run_state.yaml` in the new run (with `forked_from: <src>` added)

Could ship as part of `fork-run` SKILL.md if the ace-web fix is slow to land. For now, the SKILL.md surfaces the gap and asks operators to verify.

## Validation context for the next fork dispatch

When forking `turmeric/20260513-2243` at `from_skill: app-test-cases` (Phase 6 boundary):

- The fork should copy:
  - `1-design/` (Phase 1 artifacts)
  - `2-scenarios/` (Phase 2)
  - `3-commcare/` (Phase 3)
  - `4-connect/` (Phase 4)
  - `5-ocs/` (Phase 5)
- The fork should NOT copy:
  - `6-qa-and-training/` (the phase we're re-running)
  - `7-synthetic-data/` (downstream of fork)
  - `8-solicitation-management/` (downstream)

Verify post-fork: the new run folder has folders 1-5 but NOT 6+. If state.yaml is named `state.yaml`, manually rename to `run_state.yaml` before invoking `/ace:run`. Until ace-web ships the fixes, this is the operator's responsibility.

## Pointer for the ace-web fix

The ace-web file paths in the user's local checkout:

- `~/emdash-projects/ace-web/apps/opps/fork.py` (the two-line state.yaml rename + the run-id format change)
- `~/emdash-projects/ace-web/apps/opps/tests/test_fork.py` (update expected run-id pattern + state filename)
