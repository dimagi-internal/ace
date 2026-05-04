# Run-folder readability: phase prefixes, skill-named artifacts, layout bug fixes

**Date:** 2026-05-03
**Status:** design draft; pending approval
**Scope:** ACE plugin Drive layout under `ACE/<opp>/runs/<run-id>/`. Affects every skill that writes to Drive, the artifact manifest, fixtures, ace-doctor, and ace-web's reader.
**Predecessor:** `2026-05-02-ace-run-multi-run-revival-design.md` (introduced the `inputs/`+`runs/` opp shape; this spec restructures *inside* a run folder).

## Problem

Walking through the most recent run (`leep-paint-collection/runs/20260503-2128/`) end-to-end in Drive, several friction points and one real bug surfaced:

1. **Two `verdicts/` folders** at the run root. Drive permits duplicate folder names per parent and some skill is creating-new instead of finding-existing. `idea-to-pdd.yaml` lives in one; the other 5 verdicts are in the sibling. Reader can't tell which is canonical.
2. **Stray retry artifact** `2026-05-03-connect-opp-setup-attempt-3.md` written at the **opp** root, not in any run. Looks like a dropped write — should have lived inside the run that was attempting it.
3. **Empty `eval-reports/`** — manifest says it's where `ocs-chatbot-eval` puts human-readable reports; on disk it's empty. Either the skill silently routed elsewhere or the folder is dead.
4. **No phase signal in the run folder.** Top-level files (`idea.md`, `pdd.md`, `commcare-setup-summary.md`, `deployment-summary.md`, `test-prompts.md`) sort alphabetically with no phase indication. A new reader has to know the lifecycle by heart to make sense of the order.
5. **Two naming conventions side-by-side.** Top-level files use *artifact names* (`idea.md`, `pdd.md`, `deployment-summary.md`). Files inside `gate-briefs/` and `verdicts/` use *skill names* (`idea-to-pdd.md`, `pdd-to-learn-app.yaml`). Reader has to maintain a mental "skill ↔ artifact" map.
6. **Opp-vs-run scope is invisible.** `connect-opp-summary.md`, `connect-program-summary.md`, `ocs-agent-config.md` live at the opp root — produced by a run but stored at opp scope as "current truth." Nothing in the name says so, and you can't tell which run produced the current version.
7. **Phase-tagging in `lib/artifact-manifest.ts` is stale.** The `Phase` enum is 6-phase (`design | commcare | connect | ocs | operate | closeout`) but CLAUDE.md says we run 7 phases since 0.9.0 (qa-and-training is Phase 5, llo-manager is Phase 6). Artifacts produced in Phase 5 are mis-tagged `operate` (mobile-recipes, screenshots) or even `commcare` (every `training-materials/*` file, despite the 0.9.0 relocation note in CLAUDE.md). The manifest is the source of truth — fixing names without fixing this leaves a permanent drift.

## Solution

A phase-prefixed run layout, one naming convention everywhere, and a small `current/` shortcut layer at opp root so "what's the latest of X" is a one-click answer.

### New run-folder layout

```
ACE/<opp>/
├── opp.yaml
├── inputs/                          (unchanged — see 2026-05-02 spec)
├── current/                         (NEW: shortcuts into the latest run; see § current/)
│   ├── connect-opp-summary.md       → runs/<latest>/3-connect/connect-opp-setup.md
│   ├── connect-program-summary.md   → runs/<latest>/3-connect/connect-program-setup.md
│   └── ocs-agent-config.md          → runs/<latest>/4-ocs/ocs-agent-setup.md
└── runs/<run-id>/
    ├── run_state.yaml
    ├── README.md                    (auto-generated index — table of phases→artifacts→producing skill)
    ├── 1-design/
    │   ├── idea.md                                  (input copy; only file that keeps its non-skill name — see § naming rule)
    │   ├── idea-to-pdd.md                           (was pdd.md)
    │   ├── idea-to-pdd_gate-brief.md                (was gate-briefs/idea-to-pdd.md)
    │   ├── idea-to-pdd_verdict.yaml                 (was verdicts/idea-to-pdd.yaml)
    │   └── pdd-to-test-prompts.md                   (was test-prompts.md)
    ├── 2-commcare/
    │   ├── pdd-to-learn-app_summary.md              (was app-summaries/learn-app-summary.md)
    │   ├── pdd-to-learn-app_verdict.yaml            (was verdicts/pdd-to-learn-app.yaml)
    │   ├── pdd-to-deliver-app_summary.md
    │   ├── pdd-to-deliver-app_verdict.yaml
    │   ├── app-connect-coverage_learn.md            (was app-coverage/learn-connect-coverage.md)
    │   ├── app-connect-coverage_deliver.md
    │   ├── app-deploy_summary.md                    (was deployment-summary.md)
    │   ├── app-deploy_gate-brief.md
    │   ├── app-release_verdict.yaml
    │   ├── commcare-setup_summary.md                (was commcare-setup-summary.md; agent-level synthesis)
    │   └── app-test/
    │       ├── test-plan.md
    │       ├── test-results.md
    │       └── bugs.md
    ├── 3-connect/
    │   ├── connect-program-setup.md                 (was connect-setup/program.md)
    │   ├── connect-program-setup_verdict.yaml
    │   ├── connect-opp-setup.md                     (was connect-setup/opportunity.md)
    │   └── connect-opp-setup_gate-brief.md
    ├── 4-ocs/
    │   ├── ocs-agent-setup.md                       (was ocs-agent-config.md at opp root)
    │   ├── ocs-setup_widget-handoff.md              (was ocs-setup/widget-handoff.md)
    │   ├── ocs-chatbot-qa_transcript-quick.md       (was qa-captures/YYYY-MM-DD-…-quick.md)
    │   ├── ocs-chatbot-qa_transcript-deep.md
    │   ├── ocs-chatbot-eval_verdict-quick.yaml      (was verdicts/ocs-chatbot-eval-quick.yaml)
    │   ├── ocs-chatbot-eval_verdict-deep.yaml
    │   ├── ocs-chatbot-eval_report-deep.md          (was eval-reports/YYYY-MM-DD-ocs-eval.md)
    │   └── ocs-chatbot-eval_gate-brief-deep.md
    ├── 5-qa-and-training/
    │   ├── qa-plan.md
    │   ├── app-screenshot-capture_manifest.yaml     (was screenshots/manifest.yaml)
    │   ├── screenshots/                             (kept as a folder — many binaries)
    │   ├── training-llo-guide.md                    (was training-materials/llo-manager-guide.md)
    │   ├── training-flw-guide.md
    │   ├── training-quick-reference.md
    │   ├── training-faq.md
    │   ├── training-onboarding-email.md
    │   ├── training-deck-outline.md
    │   └── training-deck-build.url                  (Slides URL pointer)
    ├── 6-llo-manager/
    │   ├── llo-invite_list.md                       (was connect-setup/invites.md)
    │   ├── llo-invite_gate-brief.md
    │   ├── llo-onboarding_comms-log.md              (was comms-log/onboarding-emails.md)
    │   ├── llo-uat_results.md                       (was uat/uat-results.md)
    │   ├── llo-launch_record.md                     (was launch/launch-record.md)
    │   ├── llo-launch_gate-brief.md
    │   ├── timeline-monitor/                        (folder — recurring; one file per check)
    │   │   └── 2026-05-04.md
    │   ├── flw-data-review/                         (folder — recurring)
    │   │   └── 2026-05-04.md
    │   └── ocs-chatbot-eval_report-monitor/         (folder — recurring)
    │       └── 2026-05-04.md
    └── 7-closeout/
        ├── opp-closeout_invoices.md
        ├── llo-feedback.md
        ├── learnings-summary.md
        ├── learnings-summary_new-pdd.md             (optional)
        ├── cycle-grade.md
        └── opp-eval/                                (umbrella eval, ad-hoc)
            ├── opp-eval_scorecard-deep.md
            ├── opp-eval_verdict-deep.yaml
            └── trend.md
```

### Naming rule (one convention everywhere)

**Every artifact is `<producing-skill>[_<role>].<ext>`**, with two clearly-bounded exceptions:

- `idea.md` — keeps its name because `producedBy: 'external'` (no skill produced it; the orchestrator copies it from `inputs/pdd.md`).
- `run_state.yaml`, `README.md` — orchestrator-owned run-scope metadata; not skill outputs.

The optional `_<role>` slot disambiguates when one skill emits multiple artifacts. Underscore was chosen as the skill↔role separator because skill names are kebab-case-only and roles may themselves be hyphenated (`gate-brief`, `verdict-deep`, `transcript-monitor`); `_` keeps the boundary unambiguous AND keeps the filename to a single trailing `.<ext>` (avoiding the `.role.ext` compound-extension trap that breaks mailers, gh CLI mime-sniffing, and Drive's own export):

| Skill | Role | Filename |
|---|---|---|
| `app-deploy` | (single output) | `app-deploy_summary.md` |
| `app-deploy` | gate-brief | `app-deploy_gate-brief.md` |
| `pdd-to-learn-app` | summary | `pdd-to-learn-app_summary.md` |
| `pdd-to-learn-app` | verdict | `pdd-to-learn-app_verdict.yaml` |
| `ocs-chatbot-qa` | transcript-quick | `ocs-chatbot-qa_transcript-quick.md` |
| `ocs-chatbot-eval` | verdict-deep | `ocs-chatbot-eval_verdict-deep.yaml` |
| `connect-opp-setup` | (single output) | `connect-opp-setup.md` |
| `cycle-grade` | (single output) | `cycle-grade.md` |

Skills with exactly one artifact omit the role suffix entirely — `connect-opp-setup.md`, `cycle-grade.md`, `qa-plan.md`, `idea-to-pdd.md`. Single-output is the common case; the underscore appears only where it earns its keep.

Roles come from a closed vocabulary defined in `lib/artifact-manifest.ts`: `summary | gate-brief | verdict | report | transcript | scorecard | manifest | list | record | comms-log | results | new-pdd | invoices | widget-handoff`. Variants append a hyphenated qualifier (`verdict-deep`, `verdict-quick`, `transcript-monitor`). Adding a new role is a one-line manifest change.

### Phase-prefixed folders

- Folder names: `1-design`, `2-commcare`, `3-connect`, `4-ocs`, `5-qa-and-training`, `6-llo-manager`, `7-closeout`. The number prefix gives sort order; the slug matches the agent name in `agents/` (so the folder structure mirrors the agent topology in CLAUDE.md).
- The `Phase` enum in `lib/artifact-manifest.ts` is updated to the 7-phase form: `'design' | 'commcare' | 'connect' | 'ocs' | 'qa-and-training' | 'llo-manager' | 'closeout'`. Mis-tagged manifest entries get re-tagged: training-materials → `qa-and-training`, mobile-recipes/screenshots → `qa-and-training`, llo-invite/onboarding/uat/launch → `llo-manager`.

### `current/` shortcuts at opp root

After every run, the orchestrator updates Drive shortcuts under `ACE/<opp>/current/` to point at the latest-run version of the small set of "treat as current truth" artifacts:

- `connect-opp-summary.md` → `runs/<latest>/3-connect/connect-opp-setup.md`
- `connect-program-summary.md` → `runs/<latest>/3-connect/connect-program-setup.md`
- `ocs-agent-config.md` → `runs/<latest>/4-ocs/ocs-agent-setup.md`

Shortcuts (not copies) so editing the underlying file edits the truth, not a stale snapshot. The set is small and intentional — extending it is a manifest change.

### Auto-generated `README.md` per run

A short markdown table written by the orchestrator at run-start (and updated as phases complete). Columns: phase folder · artifact filename · producing skill · status (pending/done/skipped). Renders cleanly in Drive's Docs viewer; doubles as a sanity check that the run is well-formed.

## Bug fixes (independent of the rename)

Three bugs surfaced during the audit are fixed regardless of whether the layout change ships:

1. **Duplicate `verdicts/` folders.** `mcp/google-drive-server.ts` `drive_create_folder` already accepts a `parentFolderId` but does not check for an existing same-named folder before creating. Fix: add a "find-or-create" mode (default-on for skill writes) that lists the parent and reuses an existing folder by exact name match. Caught by a new `bin/ace-doctor` check that flags duplicate folder names under any run folder.
2. **Stray opp-root `2026-05-03-connect-opp-setup-attempt-3.md`.** Audit trace through `skills/connect-opp-setup/SKILL.md` — find which write resolved its `parentFolderId` to the opp root instead of the run folder, fix at the call site. Add a `bin/ace-doctor` check that flags any opp-root file outside a known whitelist (`opp.yaml`, `current/*`, `inputs/`, `runs/`).
3. **Empty `eval-reports/`.** Either remove the folder from the manifest if dead, or wire `ocs-chatbot-eval` to actually write there. Decision in this spec: kill the folder; the report becomes `ocs-chatbot-eval_report-deep.md` inside `4-ocs/` per the new layout.

## ACE plugin changes

1. **`lib/artifact-manifest.ts`** — primary source of truth for the rename:
   - `Phase` enum → 7 phases (add `qa-and-training`, `llo-manager`; drop `operate`).
   - Every entry's `path` rewritten to the new `<phase-folder>/<skill>[.<role>].<ext>` form.
   - Re-tag mis-phased entries (training-materials, mobile-recipes/screenshots, llo-* artifacts).
   - Add `role` field to `ArtifactEntry` (closed vocabulary listed above).
   - `validateFixture` updated to walk phase-prefixed paths.
2. **Every `SKILL.md` that writes a Drive artifact** — update its "Output" section path. Mechanical: each skill's path is one entry in the manifest; a small `scripts/sync-skill-paths.ts` can grep+rewrite the output sections from the manifest as the source.
3. **`agents/ace-orchestrator.md`** — phase loop creates the `<N>-<phase>/` subfolder, threads it down as the `parentFolderId` for that phase's skills.
4. **`agents/ace-orchestrator.md` § run-start** — write `README.md`; update `current/` shortcuts on phase completion.
5. **`mcp/google-drive-server.ts`** — `drive_create_folder` gains a `findOrCreate: boolean` parameter (default `true` for skill writes); add `drive_create_shortcut` atom for the `current/` layer.
6. **`bin/ace-doctor`** — new checks: duplicate folder names under a run, opp-root files outside whitelist, `current/` shortcuts present and resolve.
7. **`commands/status.md`** — `/ace:status` output reorganized to show phase folders.
8. **`test/fixtures/`** — every fixture under `test/fixtures/{CRISPR-Test-001,002,003-Turmeric}` re-laid-out under the new shape. The fixture-manifest test already validates path conformance — update it to the new manifest, fixtures will fail loudly until they're moved.

## ace-web changes

1. **`apps/opps/sync.py`** — structured-layout reader walks `<phase-folder>/<skill>[.<role>].<ext>` instead of the current flat layout. New phase-aware grouping in the response shape.
2. **`OppWorkbenchPage.tsx`** — phase tabs become first-class (one tab per `1-design`/`2-commcare`/...); each tab lists its artifacts with the producing skill chip.
3. **Run comparison view** — already exists (PR #147); adapts trivially since the phase folders give natural grouping for diffs.

## Migration

One-time migration script `migrations/0.12.0-phase-prefix.ts` covering both fixtures and live Drive opps:

1. For every opp folder under the Drive root, walk every `runs/<run-id>/`.
2. For each existing path that maps to a manifest entry, `drive_move_file` it to the new phase-prefixed path.
3. Coalesce duplicate `verdicts/` folders into one (move children, then delete the empty sibling).
4. Move stray opp-root files into their owning run folder (the attempt-3 retry case).
5. Create `current/` shortcuts on every opp pointing at the latest run.
6. Delete `eval-reports/` and any other now-dead folder names from the prior layout.

Idempotent: re-running on an already-migrated opp is a no-op (manifest paths already resolve). Dry-run mode (`--check`) walks without writing.

## Risks & open issues

- **Migration is on live Drive data.** Mitigation: dry-run mode required; user runs `--check` against the 4 opps in their Drive root and reviews the planned moves before `--apply`. Each move is a `drive_move_file` (atomic; same fileId, just changes parent) so partial failure is recoverable.
- **`SKILL.md` path rewrites are repetitive.** Mitigation: `scripts/sync-skill-paths.ts` generates the "Output" section from the manifest. Reviewing 36 small mechanical PR-diff hunks is still real work — accept it.
- **ace-web reader changes ship in lockstep.** Plugin lands first (writes new layout); ace-web's reader change must follow within a session or the Workbench page goes blank for new runs. Same risk profile as the 2026-05-02 multi-run revival; handled the same way.
- **Closed role vocabulary.** Adding a new role later means a manifest change AND careful naming review. Acceptable: today's set covers every existing artifact and the vocabulary is short enough to read in one screen.
- **Naming gets longer.** `pdd-to-learn-app_summary.md` is 27 chars vs. the old `learn-app-summary.md` at 20. Drive UI handles this fine; the readability win (skill provenance in the filename) is the whole point.
- **Underscore is unusual in this codebase.** Existing skill, agent, and command names are kebab-case-only. Introducing `_` solely as the skill↔role separator inside artifact filenames is a localized convention — explicitly NOT a green light to use underscores anywhere else (skill names, folder names, agent names all stay kebab-case). The lint in `lib/artifact-manifest.ts` enforces this: only artifact `path` strings are allowed an underscore, and only at the skill↔role boundary.

## Testing strategy

- **Manifest unit tests:** lint that every `path` matches `<phase-folder>/<skill>[.<role>].<ext>` (or is one of the two exceptions). Lint that `<skill>` exists in `skills/`.
- **Fixture validation:** the existing `test/fixtures/artifact-manifest.test.ts` becomes the migration's test bed — it fails until fixtures are moved.
- **Doctor checks:** unit-test the dup-folder + stray-opp-root-file detectors against synthetic Drive responses.
- **Migration dry-run:** run on the 4 opps in user's Drive (`leep-paint-collection`, `cosmetics-fgd-pilot`, `turmeric`, plus whatever else); diff the planned moves against the manifest; user signs off before `--apply`.
- **End-to-end:** one fresh `/ace:run` on `turmeric` after migration; new run lands in the new layout; `/ace:status` and `/ace:doctor` both clean.

## Out of scope

1. **Breaking change for older opps with no `inputs/` folder.** They predate the 2026-05-02 spec; user said they're being deleted. Migration script ignores them.
2. **Renaming inside the `inputs/` folder.** Inputs are user-curated; we don't rename them.
3. **Renaming Slides/Sheets templates** (`ACE Training Deck Template`, etc.). Out of scope — they live at the Drive root, not under any opp.
4. **A schema-level "what is an artifact" change** (e.g., introducing typed artifact records instead of free markdown). Possibly a future spec; orthogonal to layout.
