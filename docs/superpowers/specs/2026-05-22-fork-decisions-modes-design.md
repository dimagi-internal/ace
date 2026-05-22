# Fork modes for decisions — design

**Status:** Design approved. Implementation plan pending.
**Date:** 2026-05-22
**Touches:** ACE plugin (`lib/decisions-schema.ts`, decisions-aware skills, `fork-run` skill, migration) + ace-web (`apps/opps/fork.py`, serializer, `ForkDialog.tsx`).

## Motivation

The current fork dialog exposes two modes:

- `with-feedback` — copies upstream-of-fork step folders + carries forward `run_state.yaml`. Asks for a feedback string seeded into the new working session.
- `empty` — minimal `run_state.yaml`; no artifacts copied.

In practice, **forks always want the upstream artifacts** — if you want a clean slate you'd start a new opp. The interesting axis is decisions, not artifacts:

1. After phases 1–N populate `decisions.yaml` with a mix of AI defaults and human overrides, what should carry forward to the new run when you fork at phase N+1?
2. When phases re-run downstream, should they re-derive the AI defaults from scratch, or anchor on the prior run's choices?

Two modes are useful:

- **Keep only what the human committed to** — wipe AI defaults so the new run is free to re-derive, but preserve overrides as load-bearing constraints.
- **Keep everything upstream** — full continuity; you're forking to iterate on one downstream phase and want the rest unchanged.

The existing `with-feedback` / `empty` modes collapse into these two.

## Schema changes

`lib/decisions-schema.ts` — three changes:

1. **Rename `default:` field → `ai-default:`.** The name reflects what the field is: the AI's proposed default value. Immutable once written.
2. **Add `override:` field (optional).** Populated only when a human edits the row via `decisions-render` + `decisions-sync`. Effective value = `override` if present else `ai-default`.
3. **Drop `open` from the `status` enum.** Enum becomes `applied | overridden`. The `open` status was originally used to flag AI defaults requiring human attention while still proceeding — that's no longer a blocking semantic (the orchestrator doesn't pause on `open` anymore), so it collapses into `applied`.

New row shape:

```yaml
- id: deliver-unit-count
  phase: 3-commcare
  skill: pdd-to-deliver-app
  question: How many deliver_units per visit?
  ai-default: "3 forms per visit"        # AI's proposal; immutable
  override: "5 forms per visit"           # optional; present iff status=overridden
  options_considered: ["3 forms per visit", "5 forms per visit"]
  source: PDD §Workflow
  status: applied
  notes: …
```

When status flips from `applied` to `overridden`, the existing destructive write (replace `default:`, push old value to `options_considered`) is replaced by an additive write (populate `override:`). `options_considered` no longer needs to receive the original AI value on override — it's still there in `ai-default:`.

### Schema version bump

`DECISIONS_SCHEMA_VERSION` goes from `1` to `2`. Paired migration in `migrations/`:

- File: `migrations/0.13.<next>-decisions-ai-default-rename.md` (the conventional pattern; see `migrations/0.11.10-shallow-deep-qa.md`).
- Operation: for every `ACE/*/runs/*/decisions.yaml` on Drive:
  - Rename `default:` key → `ai-default:`
  - Map `status: open` → `status: applied`
  - Bump `schema_version: 1` → `2`
  - Idempotent (re-running is a no-op).

The migration is one-way. Older ACE plugin versions reading post-migration files will fail validation — accept this; the schema bump is the signal.

## Fork modes

Replace today's two modes (`with-feedback` / `empty`) with two new modes (`keep-overrides-only` / `keep-all`). Both:

- Copy upstream-of-fork step folders (existing `_copy_upstream_steps` logic, unchanged).
- Copy `run_state.yaml` from the source run.
- Seed a new working session with a system message + user message containing the operator's feedback string.
- Require non-empty `feedback`.

They differ in how `decisions.yaml` is carried forward:

| Mode | Rows copied to new run's `decisions.yaml` |
|---|---|
| `keep-overrides-only` | rows where `status == overridden` AND `phase_ordinal < fork_ordinal` |
| `keep-all` | rows where `phase_ordinal < fork_ordinal` |

In both modes, rows at or downstream of the fork-phase are dropped — those phases re-run from scratch and re-append their rows. The new run's `decisions.yaml` carries `schema_version: 2`, the same `opportunity` / `run_id` fields (run_id is the new run's id), a fresh `generated_at`, and the filtered `decisions` array.

`phase_ordinal` is derived from the row's `phase:` field (regex `^([1-9][0-9]*)-`) and compared to the fork-skill's phase ordinal (already computed by `fork.py:fork_run` as `fork_ordinal`).

### Why drop `empty` outright

The `empty` mode is rarely useful — it copies no artifacts, runs no upstream phases, and forwards no decisions. It overlaps almost entirely with "start a new run from scratch via `/ace:run <opp>`," which is the canonical fresh-run flow. Removing it simplifies the dialog and the API surface. The `forked_from: <src> (empty fork)` audit trail it used to write is unnecessary — fresh runs don't need that lineage.

## Surface area

### ACE plugin (this repo)

1. **`lib/decisions-schema.ts`** — bump `DECISIONS_SCHEMA_VERSION` to 2, rename field, add `override:` (optional), drop `open` from status enum.
2. **`migrations/0.13.<next>-decisions-ai-default-rename.md`** — one-shot Drive rewrite procedure (see § Schema version bump).
3. **`skills/idea-to-pdd/SKILL.md`** — update three sites referencing the `default:` field (lines 117, 125, 343 today) and the status enum description (drop `open`).
4. **`skills/decisions-sync/SKILL.md`** — change override semantics: populate `override:` instead of overwriting `ai-default:` and pushing the old value to `options_considered`.
5. **`skills/decisions-render/SKILL.md`** — gdoc label update: render `AI-default:` instead of `Default:`; render an `Override:` line when `override:` is present.
6. **`skills/fork-run/SKILL.md`** — replace mode names in the docs; remove the `empty` mode section.
7. **No new skills.** All changes ride on existing skill files.

### ace-web (sibling repo)

1. **`apps/opps/fork.py`** — `fork_run()`:
   - Replace `mode in {"with-feedback", "empty"}` validation with `mode in {"keep-overrides-only", "keep-all"}`.
   - Both modes execute the upstream-artifact copy + `run_state.yaml` carry-forward (the existing `with-feedback` path).
   - New helper `_copy_filtered_decisions(drive, src_run, dst_run_folder_id, fork_ordinal, mode)` that reads source `decisions.yaml`, applies the mode-specific filter, writes the new `decisions.yaml`.
   - Always require `feedback`.
2. **`apps/opps/serializers.py`** (`ForkRunSerializer` or wherever the mode field is validated) — update the choices list.
3. **`apps/opps/views.py`** (`opp_fork` view) — verify error codes still surface as `invalid-mode` / `feedback-required` per the existing contract.
4. **`apps/opps/tests/test_fork.py`** — replace mode-specific tests; add coverage for the filter logic per mode (rows kept vs dropped at the boundary).
5. **`frontend/src/components/opps/ForkDialog.tsx`** — two radio options instead of three; descriptions per § UI copy below; feedback textarea always visible and always required.

### UI copy

| Mode value | Label | Description |
|---|---|---|
| `keep-overrides-only` | "Keep only my overrides" | "Upstream artifacts copied. Only your explicit overrides carry forward; AI defaults are dropped so phases can re-derive them." |
| `keep-all` | "Keep all decisions" | "Upstream artifacts copied. All decisions made so far carry forward — both AI defaults and your overrides." |

Default selection: **`keep-all`**. Most fork usage is "iterate on phase N, leave the rest unchanged," for which `keep-all` is the safer choice.

## Backward compatibility

- **Existing decisions.yaml files:** rewritten in place by the migration. After migration, files have `schema_version: 2`, `ai-default:` keys, and no `open` statuses. Any in-flight runs reading the old format need the ACE plugin update before the migration runs.
- **Existing forks in flight:** fork dialog is replaced atomically when the UI ships. The API endpoint rejects `with-feedback` / `empty` with `code: invalid-mode` after the cut-over. Operators using the `fork-run` skill see the same error; the SKILL.md update names the new modes.
- **Run history:** preserved. Existing forked runs created with `with-feedback` keep working — their `run_state.yaml` and step folders are read-only artifacts; the mode that created them is irrelevant after creation.

## Roll-out order

1. **Ship ACE plugin PR first** — schema update + migration doc + skill updates. Run the migration against Drive in a separate dispatch (one-time).
2. **Ship ace-web PR second** — fork.py + serializer + tests + ForkDialog.tsx. Once merged + deployed, both fork surfaces (browser + skill) expose the new modes.
3. The two PRs are independent in terms of compile/test, but should land in this order so the ace-web filter sees post-migration `decisions.yaml` files when it tries to copy them.

## Non-goals

- **No changes to artifact-copy logic.** The existing `_copy_upstream_steps` and `run_state.yaml` carry-forward are unchanged.
- **No changes to the working-session seeding.** The system message + user message format stays as-is; only the mode name surfaces in the system message text.
- **No new fork-time validations beyond mode + feedback.** Things like "fork-phase must be > 1" are out of scope.
- **No retroactive renames in old decisions.yaml files outside the migration.** The migration is the one and only rewrite pass.

## Open questions

None at design-approval time. All schema, mode, and surface-area decisions were settled in brainstorming (see commits leading to this spec).

## Related

- `docs/superpowers/specs/2026-05-08-decisions-log-design.md` — original decisions-log spec.
- `docs/learnings/2026-05-14-fork-run-skill.md` — prior ace-web alignment work for the fork endpoint.
- `skills/fork-run/SKILL.md` — operator-facing wrapper.
- `~/emdash-projects/ace-web/apps/opps/fork.py` — fork backend.
