# Multi-run-per-opp revival + canonical input packs

**Date:** 2026-05-02
**Status:** design approved; pending plan
**Scope:** ACE plugin + ace-web. Drive layout change.
**Supersedes:** the single-run-per-opp convention introduced in `docs/plans/2026-04-20-drop-multi-run-simplify.md` (in the ace-web repo).

## Problem

`/ace:run` zero-arg today generates a slug like `smoke-20260502-1830` and prompts the user to pick a PDD from a flat `PDD/` folder. Two problems:

1. **The slug carries no topic information.** Every fresh run looks like `smoke-*`, so you can't tell at a glance which run was about turmeric vs cosmetics. The "strong-match auto-confirm" in the picker never fires (slug stem is always `smoke`, no PDD filename starts with `smoke`).
2. **Inputs to a topic are scattered.** A topic's PDD lives in `ACE/PDD/`, but supporting docs (sample paper forms, interview guides) have nowhere canonical to live. The user wants to iterate the same topic over many runs (turmeric ×5–10 e2e cycles over the next month or two while skills stabilize), and each run currently leaves an unrelated top-level slug folder.

## Solution: opp folders contain `inputs/` and `runs/`

```
ACE/                                  (= ACE_DRIVE_ROOT_FOLDER_ID)
├── turmeric/                         (one folder per opp; folder name = opp slug)
│   ├── inputs/                       (canonical input pack — read-only by orchestrator)
│   │   ├── pdd.md                    (the PDD — required)
│   │   ├── sample-paper-form.pdf     (optional supporting docs)
│   │   └── notes.md
│   ├── runs/
│   │   ├── 20260502-1830/            (run-id = local YYYYMMDD-HHMM)
│   │   │   ├── idea.md               (copy of inputs/pdd.md, written at run start)
│   │   │   ├── state.yaml
│   │   │   ├── pdd.md                (output of idea-to-pdd skill — distinct from inputs/pdd.md)
│   │   │   ├── verdicts/
│   │   │   ├── scorecards/
│   │   │   ├── gate-briefs/
│   │   │   ├── comms-log/
│   │   │   ├── app-summaries/
│   │   │   ├── connect-setup/
│   │   │   ├── ocs-setup/
│   │   │   ├── qa-plan/
│   │   │   ├── screenshots/
│   │   │   ├── training-materials/
│   │   │   └── ... (every existing per-skill subfolder)
│   │   ├── 20260502-2200/
│   │   └── 20260503-0900/
│   └── opp.yaml                      (opp-level metadata; see § opp.yaml)
├── cosmetics-fgd-pilot/
│   ├── inputs/{...}
│   └── runs/{...}
└── PDD/                              (legacy flat folder — kept readable for back-compat reads)
```

Two clean top-level concepts: **opp** (the topic, stable, one folder per topic) and **run** (one execution of the lifecycle on that opp, fresh per `/ace:run` invocation).

## `/ace:run` semantics

| Invocation | Behavior |
|---|---|
| `/ace:run` | Discover newest opp by `inputs/` mtime → fresh run on that opp |
| `/ace:run <opp>` | Skip discovery; use that opp; fresh run |
| `/ace:run <opp>/<run-id>` | Resume that specific run (read its existing `state.yaml`) |
| `/ace:run --idea FILE` | Existing scripted-seed flow; creates ad-hoc opp folder if `<opp-name>` not also passed |

### Zero-arg discovery (the load-bearing change)

1. Read `ACE_DRIVE_ROOT_FOLDER_ID`. If unset/empty, error out with the same actionable message as today.
2. `drive_list_folder` on the ACE root. Filter to subfolders that contain an `inputs/` subfolder.
3. For each candidate, compute mtime = newest of (the `inputs/` folder's modifiedTime + every direct child of `inputs/`). Tiebreak alphabetical on opp name.
4. Pick newest. Folder name = `<opp>`.
5. Generate `<run-id>` = `date +%Y%m%d-%H%M` (local time). On the second-or-later invocation in the same minute, append `-2`, `-3`, etc., to disambiguate.
6. `drive_create_folder ACE/<opp>/runs/<run-id>/`.
7. Find PDD inside `inputs/`: prefer file named `pdd.md`/`pdd.gdoc`, else first file with `pdd` in its name (case-insensitive), else lone document file. If multiple ambiguous candidates and no `pdd*` match, error.
8. Read PDD body via `drive_read_file`. Write to `runs/<run-id>/idea.md` with `drive_create_file`.
9. Init `runs/<run-id>/state.yaml` with mode, created timestamp, all steps `pending`, `initiated_by` from `git config user.email`.
10. Read or create `<opp>/opp.yaml`; set `last_run_id: <run-id>`.
11. Begin Phase 1.

### Fallback when no opp has an `inputs/` folder

Stop with an error that explains the new layout and gives a one-line howto:

> No opps with an `inputs/` subfolder found under your ACE Drive root.
>
> Create one: in Drive, make `ACE/<your-opp-slug>/inputs/`, drop your PDD as `pdd.md` (and any supporting docs), then re-run `/ace:run`.

Do NOT silently fall back to the legacy `PDD/` picker — the picker exists for back-compat reads, not for new runs. Forcing a one-time setup is better than ambiguous resolution.

### Resume vs fresh

- `/ace:run <opp>/<run-id>` (resume): orchestrator reads existing `state.yaml`; behavior matches today's resume-from-state path. The run-id includes a `-` so the parser unambiguously distinguishes `<opp>/<run-id>` from a single slug.
- All other forms: fresh run; never resumes.

## opp.yaml

A small per-opp metadata file written at opp root:

```yaml
display_name: Turmeric Market Survey
slug: turmeric
last_run_id: 20260502-1830
tags: []                       # reserved for grouping UI; unused initially
created_at: 2026-05-02T18:30:00Z
created_by: ace@dimagi-ai.com
```

Created lazily on the first run. Updated on every run to bump `last_run_id`. Never deleted.

`display_name` defaults to the slug; the user can edit it manually in the file. ace-web reads it for the opp list.

## ACE plugin changes

1. **`agents/ace-orchestrator.md` § Starting a New Opportunity** — rewrite for `inputs/` discovery + `runs/<run-id>/` creation. Threads `<opp>`, `<run-id>` through to all phase agents and per-skill dispatches.
2. **`commands/run.md`** — argument grammar grows to `<opp>` and `<opp>/<run-id>` forms; the zero-arg flow above is documented as the smart default.
3. **Per-skill artifact paths** — every skill that writes an artifact already takes a folder ID from the orchestrator. The orchestrator now passes `<opp-folder>/runs/<run-id>/` instead of `<slug-folder>/`. Most skill code does not change; only the orchestrator's path computation changes.
4. **`lib/artifact-manifest.ts`** — paths remain syntactically the same (relative to the run folder, e.g., `verdicts/<skill>-eval-deep.yaml`). Two new entries:
   - `inputs/` (read-only, `producedBy: 'external'`)
   - `opp.yaml` (opp-level, `producedBy: 'orchestrator'`)
5. **`bin/ace-doctor`** — new checks:
   - At least one `<opp>/inputs/pdd.md` exists somewhere under the Drive root (else INFO: "no input packs yet — see /ace:run for setup").
   - `ACE_E2E_AUTH_TOKEN` is set in `.env` (gap discovered while building this spec — token was checked into `deploy/aws/task-definition.json` but doctor didn't validate it).
6. **`commands/status.md` (`/ace:status`)** — output reorganized: list opps (one line per opp folder), each opp expands to its runs sorted newest-first.

## ace-web changes

1. **`apps/opps/sync.py`** — revive the structured-layout reader (still alive as dead-code from the 2026-04-20 drop; see `docs/plans/2026-04-20-drop-multi-run-simplify.md § Notes on deferred work`). Wire it for the new shape:
   - opp discovery: list `ACE/`, keep folders that have `inputs/`
   - run discovery: list `<opp>/runs/`
   - state parser: `<opp>/runs/<run-id>/state.yaml`
2. **`apps/opps/views.py` + URLs** — re-enable `/api/opps/<opp>/runs/<run-id>/...` endpoints (the structured shape is already in `apps/opps/urls.py`; views need to actually serve them again).
3. **Workbench UI** (`frontend/src/pages/OppWorkbenchPage.tsx`) — run-selector dropdown at the top of the opp page. Default = latest run. Compare-two-runs endpoint (`/api/opps/<slug>/compare`) comes back online and the existing side-by-side compare UI (PR #147, commit `1695cf3`) is wired to it.
4. **Opp list** (`/opps`) — one row per opp folder, showing display_name, last-run timestamp, run count, last-run scorecard chip.
5. **Transcript-ingest linkage** — `POST /api/ingest/upload` already accepts optional `opp_slug` / `opp_run_id` / `opp_step_skill` multipart fields. Plugin's `upload-transcript` skill sends `<opp>` for slug and `<run-id>` for run_id. No backend change.

## Migration & back-compat

- **Legacy flat opps** (`turmeric`, `turmeric-20260429-2330`, `turmeric-dogfood-20260427`, etc.): user will manually delete from Drive. No migration script.
- **Legacy `PDD/` flat folder**: kept readable; doctor logs INFO if still present. Not used by zero-arg discovery.
- **ace-web's flat-layout reader**: kept alive for ~1 week post-launch so any in-flight legacy opps remain visible while user finishes deleting. Drop in a follow-up commit (≤500 LOC, the deletion already inventoried in the 2026-04-20 plan's deferred-work note).
- **`commands/upload-transcript`**: already accepts `opp_slug` + `opp_run_id` separately; the new shape just sends both fields populated where today only `opp_slug` was used.

## Risks & open issues

- **Drive folder mtime is unreliable as a "what was I working on" signal.** If the user touches an old PDD for a typo fix, that opp jumps to newest. Acceptable: zero-arg is a convenience; explicit `/ace:run <opp>` always wins.
- **Run-id collisions within the same minute.** Append `-2`, `-3` (see step 5 above). In practice unlikely outside automated test loops.
- **Two `pdd.md` files in the system per run** — `inputs/pdd.md` (the canonical input) and `runs/<run-id>/pdd.md` (the orchestrator's output of the `idea-to-pdd` skill). Confusing on first read; spec keeps the names because changing either breaks too much. Orchestrator log line on run start should explicitly call out the two paths.
- **Plugin↔ace-web ordering.** Plugin lands first (writes the new layout); ace-web ships the multi-run reader within 24h or the Workbench shows nothing for new opps in the gap. Acceptable: user can still observe runs via Drive directly during the gap.

## Testing strategy

- **Plugin unit tests:** mock Drive client; assert that zero-arg `/ace:run` produces `<opp>/runs/<run-id>/state.yaml` and `<opp>/opp.yaml` with the expected fields.
- **Plugin integration:** fresh end-to-end on `turmeric` opp via `tools/walkthrough/run_chat_e2e.py` against deployed ace-web — gates the launch.
- **ace-web tests:** new fixture-driven tests under `apps/opps/tests/` for the new structured-layout reader (parallel to the existing flat-layout tests).
- **Doctor:** add unit test for the `inputs/pdd.md` discovery and `ACE_E2E_AUTH_TOKEN` env check.

## Out of scope (followups)

1. **Cross-run trends UI.** Per-run scorecard already exists; an opp-level trend chart is a follow-up, easy once the structured reader is back.
2. **Tag-based grouping.** `opp.yaml.tags` field is reserved; UI for filtering/grouping by tag is a follow-up.
3. **Legacy flat-layout reader removal.** ~500 LOC deletion in `apps/opps/sync.py` + related; do once the user has confirmed all legacy opps deleted from Drive.
4. **Drive-side "create input pack" wizard** (small UI in ace-web that mkdirs `<opp>/inputs/` and uploads a PDD). Manual today; nice-to-have later.
