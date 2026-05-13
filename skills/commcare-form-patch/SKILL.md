---
name: commcare-form-patch
description: >
  Apply surgical CCHQ form-XML patches when Nova's compile_app emits
  output Connect rejects, then re-build + re-release. Workaround skill.
disable-model-invocation: true
---

# CommCare Form Patch (TEMPORARY)

This skill is a band-aid. It exists because Nova's `compile_app` ships
two known-broken render shapes that Connect's `/opportunity/init/`
rejects with HTTP 500, and Nova's blueprint API gives ACE no way to
correct them upstream. The skill patches the resulting CommCare HQ
form XML directly, then re-builds and re-releases the app so the next
Connect setup attempt sees a Connect-compatible CCZ.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Operator-authored | `commcare-patches.yaml` (per-opp) | declarative patch-class list to apply |
| Phase 3 | `3-commcare/app-deploy_summary.md` | HQ app IDs to target |

## Products

- `3-commcare/commcare-form-patch_summary.md` — patches applied per form, re-built/re-released build IDs

## Removal criteria

Delete this skill (and the backing `commcare_patch_xform` atom) once
nova-plugin#5 + #6 ship and a clean LEEP-style Connect-setup e2e
succeeds without it.

## Bugs this skill works around

- **nova-plugin#5** — `compile_app` always emits `<user_score/>` (empty)
  inside the Connect `<assessment>` block on every quiz form, even when
  the blueprint sets `connect.assessment.user_score: "/data/total_score"`.
- **nova-plugin#6** — setting `connect: null` on a quiz form (the
  obvious ACE-side workaround) is silently auto-restored to the broken
  shape on the next compile, so we cannot avoid the bad render via
  Nova; the patch must happen post-Nova at CCHQ.
- **nova-plugin#7 (suspected, surfaced 2026-05-03)** — `compile_app` emits
  the entire `<assessment xmlns="http://commcareconnect.com/data/v1/learn">`
  wrapper element + its binds even though the canonical working Learn app
  (Turmeric, `76fd5f0e2834454bb946bdf9ae9bff71`) has ZERO `commcareconnect`
  references in suite.xml, profile.ccpr, or any form XML. Connect's
  `/opportunity/init/` rejects ANY app carrying the in-form markup —
  populating `user_score` is necessary but not sufficient. Connect derives
  the assessment relationship from the suite-level module/form metadata,
  not from in-form markup.

## Patch classes

| Class | Selector | Action | When to use |
|-------|----------|--------|-------------|
| **`assessment-removal`** *(recommended)* | Form contains a wrapper element whose body is exactly one `<assessment xmlns="…connect…">…</assessment>` block | Strip the wrapper element + its `<bind>` references entirely | Default for Connect Learn apps. Matches the working Turmeric pattern; unblocks `/opportunity/init/`. |
| `user-score` | Form contains an empty `<user_score/>` inside a `commcareconnect`-namespaced `<assessment>` block | Rewrite to `<user_score>/data/total_score</user_score>` | Legacy class. Necessary but not sufficient — Connect rejects the wrapper element regardless. Kept for diagnostic use; prefer `assessment-removal`. |

`assessment-removal` is a strict superset: any form fixed by `user-score`
is also fixed by `assessment-removal`, plus assessment-removal removes the
wrapper element that Connect was already going to reject.

**Apply assessment-removal to LEARN apps only.** Connect's
`/opportunity/init/` parser only chokes on Learn-side connect markup;
Deliver-app `<deliver>` wrappers are tolerated. More importantly,
patching the deliver form via `edit_form_attr` triggers a CCHQ
"Cannot use Case Management UI if you already have a case block" build
error on the next `commcare_make_build`, because the patched form drifts
from the metadata Vellum cached. Verified live 2026-05-03 against
LEEP Deliver `f4b4cb06962441718081a6f9ab502262` — patch + build cycle
fails until the form is reverted to the released v1 XML.

## Removal criteria

This skill (and the `commcare_patch_xform` atom + the
`applyUserScorePatch` / `applyAssessmentRemovalPatch` helpers backing
it) MUST be deleted when ALL of:

1. nova-plugin#5 (compile_app emits populated `<user_score>...</user_score>`)
   ships and is deployed to Nova prod.
2. nova-plugin#6 (`connect: null` on a quiz form is honored, not
   auto-restored) ships and is deployed.
3. nova-plugin#7 (compile_app does NOT emit the in-form `commcareconnect`
   assessment wrapper for quiz forms — matches the working Turmeric Learn
   render) ships and is deployed.
4. A clean re-run of `leep-paint-collection` Phase 4 succeeds with no
   patch step needed (`commcare-patches.yaml` empty or absent;
   `connect_create_opportunity` returns 201 with a real opp UUID).

When that's true: remove `skills/commcare-form-patch/`,
`mcp/connect/backends/commcare.ts::patchXform`/`applyUserScorePatch`/
`applyAssessmentRemovalPatch`/`XformConflictError`, the
`commcare_patch_xform` tool registration in `mcp/connect-server.ts`, the
`test/mcp/connect/unit/commcare-patch-xform.test.ts` suite, and the
`test/fixtures/cchq/leep-quiz-form-empty-user-score.xml` fixture. Drop
the per-opp `commcare-patches.yaml` files and the `phase_3_backlog`
entry tracking this in each affected opp's `run_state.yaml`.

The `phase_3_backlog` entry tracking removal in the leep opp's
`run_state.yaml` is the load-bearing TODO; if it goes stale, the skill
will drift out of the codebase silently while the bugs are still open.

## Process

Inputs:
- `<opp-name>` — the only positional argument. Resolves the opp's
  Drive folder (`ACE/<opp-name>/`).

This skill targets ONE app at a time *per patches.yaml entry*. The
default LEEP-style invocation patches the Learn app (which has all 6
quiz forms in scope for nova-plugin#5).

1. **Read `3-commcare/app-deploy_summary.md`.** Pull `hq_domain`, `learn_app_id`,
   `deliver_app_id`, and the latest `releases.{learn,deliver}.build_id`
   from the frontmatter. These are the source of truth for which CCHQ
   project + apps to patch.

2. **Read or generate `commcare-patches.yaml`.** Look for
   `ACE/<opp-name>/commcare-patches/commcare-patches.yaml`. Schema:

   ```yaml
   patches:
     - app: learn         # learn | deliver
       app_id: <32-char hex>            # CCHQ app id (matches deployment-summary)
       patch_class: assessment-removal  # recommended; or 'user-score' for legacy diagnostic
       targets: auto                    # auto = discover all matching forms via CCZ scan
       # OR explicit:
       # targets:
       #   - { module: 0, form: 1, form_unique_id: 6f3d3ad3ed9d44e5b4107c0a1210dd10 }
   ```

   **Default behavior (auto-generate when missing).** When this skill
   runs as Step 2.8 of `/ace:run` and `commcare-patches.yaml` doesn't
   exist on Drive, write a single-entry default:
   `app: learn`, `app_id` from the deployment summary,
   `patch_class: assessment-removal`, `targets: auto`. This is the
   correct shape for every Nova-built Learn app today. The yaml lands
   on Drive so subsequent runs are explicit and re-runnable.

   **No-op contract.** With `targets: auto`, the skill scans the
   released Learn CCZ for wrapper-bearing forms. If the count is
   zero — which will be the case as soon as nova-plugin#7 ships and
   `compile_app` stops emitting wrappers — the skill writes a single
   `[INFO] commcare-form-patch: 0 wrapper-bearing forms found in
   released Learn CCZ; no-op` line to `comms-log/observations.md`,
   skips the build/release cycle, and exits cleanly. So adding this
   skill to `/ace:run` doesn't impose a wall-clock cost on opps whose
   Learn apps are already clean.

3. **Resolve form unique_ids per patch entry.** Call
   `commcare_download_ccz({domain, app_id, build_id})` for the entry's
   app, decode the base64 CCZ, parse `suite.xml`, and read every
   `<xform><resource id="...">` for the bare `unique_id`. The `id` IS
   the 32-char hex form unique_id used by `edit_form_attr`. Map each
   `./modules-N/forms-M.xml` location back to a `(module, form)`
   index pair for human-readable reporting.

   For `targets: auto`, scan each `forms-*.xml` entry inside the CCZ
   and select forms that match the patch class's selector:
   - `assessment-removal` → form contains a wrapper element whose body
     is exactly one `<assessment xmlns="…connect…">…</assessment>`
     block. (The `applyAssessmentRemovalPatch` helper in
     `mcp/connect/backends/commcare.ts` exposes the same matcher and
     reports the `removedWrappers` array on success.)
   - `user-score` → form contains the literal `<user_score/>` (or
     `<user_score />`, or `<user_score></user_score>`) inside a
     Connect-namespaced `<assessment>` block. (The
     `applyUserScorePatch` helper exposes the same matcher.)

4. **Apply the patch class to each target form.**

   For `assessment-removal`:
   - Download the live form XML from the CCZ entry from Step 3.
   - Run `applyAssessmentRemovalPatch(xml)`. If `patched === false`,
     the form is already clean — log and skip (idempotent). If
     `patched === true`, log the `removedWrappers` array (one per
     stripped quiz wrapper) and proceed to step 5.

   For `user-score`:
   - Download the live form XML from the CCZ entry from Step 3.
   - Run `applyUserScorePatch(xml)`. If `patched === false`, the form
     is already clean — log and skip (idempotent). If `patched === true`,
     proceed to step 5.

5. **POST the patch via `commcare_patch_xform`.** For each target:
   ```
   commcare_patch_xform({
     domain: <hq_domain>,
     app_id: <hq_app_id>,
     form_unique_id: <32-char hex>,
     new_xform_xml: <patched XForm XML>,
     // sha1: omit for now — concurrency conflict is unlikely in
     // single-operator ACE flows; add when needed
   })
   ```
   On `XformConflictError`, halt the entry and surface the live sha1
   so the operator can decide whether to re-fetch + retry. On other
   errors, halt and surface the response body — almost always a CCHQ
   form-validation message.

6. **Make a new build + release it.** `commcare_make_build` followed by
   `commcare_release_build` for each patched app. Capture the new
   `build_id` and `version`. (Without this step the patches stay on
   the draft only and Connect cannot see them — Connect reads released
   builds.)

7. **Verify the release with a CCZ re-fetch.** Call
   `commcare_download_ccz` against the new build, decode, and assert
   for each patched form (per patch class):

   - `assessment-removal` →
     - Zero `commcareconnect` references in the form XML
     - Zero `<assessment xmlns="…connect…">` blocks
     - Each `removedWrappers[i]` is gone (no occurrence of the wrapper
       element name in either body or binds)
   - `user-score` →
     - Zero `<user_score\s*/>` matches
     - At least one `<user_score>/data/total_score</user_score>` match

   If any assertion fails, halt — the patch did not stick.

8. **Write `ACE/<opp-name>/commcare-patches/patch-report-<YYYY-MM-DD>.md`.**
   Frontmatter + summary table:
   ```yaml
   ---
   app: learn
   app_id: <32-char hex>
   patch_class: user-score
   prior_build_id: <32-char hex>
   new_build_id: <32-char hex>
   forms_targeted: <N>
   forms_patched: <N>
   forms_already_clean: <N>
   verified_in_release: true | false
   ran_at: <ISO timestamp>
   ---
   ```
   List every (module, form, unique_id) row with before/after status.

9. **Update `run_state.yaml`.** Set
   `phases.commcare-setup.commcare-form-patch: done`,
   `cchq_apps.<app>_build_id` to the new release build_id, and
   `phase_3_backlog` with the removal-criteria reminder if not already
   tracked. Bump `last_actor` / `last_actor_at`.

## MCP Tools Used

- **Google Drive:** `drive_read_file`, `drive_create_file`,
  `drive_update_file`, `drive_create_folder`, `drive_list_folder`
- **ace-connect (CCHQ atoms):**
  - `commcare_download_ccz` — fetch + inflate the CCZ to discover form
    unique_ids and verify post-release.
  - `commcare_patch_xform` — POST `/apps/edit_form_attr/<app_id>/<form_unique_id>/xform/`
    with the new XForm XML. Auth via the same Playwright session as
    every other `commcare_*` atom.
  - `commcare_make_build` — POST `/apps/save/<app_id>/`, returns the
    new build id.
  - `commcare_release_build` — POST `/apps/view/<app_id>/releases/release/<build_id>/`,
    sets `is_released: true`.

## Mode Behavior

- **Auto:** Read patches.yaml (or generate the LEEP-default if absent),
  resolve targets, patch, build, release, verify, write report, update
  state. No human gate.
- **Review:** Same flow, but pause after Step 4 (patch staged in
  memory) and present the per-form before/after diff for operator
  approval. Resume on confirmation.

## Dry-Run Behavior

When `--dry-run` is active:
- Run Steps 1–4 (read-only — discover targets, derive patches).
- Skip Step 5 (no `commcare_patch_xform` calls).
- Skip Steps 6–7 (no build / release / verify).
- Write the would-patch list to
  `ACE/<opp-name>/comms-log/dry-run-commcare-form-patch-<YYYY-MM-DD>.md`.
- State tracks as `dry-run-success`.

## Failure Modes

- **`XformConflictError`** — CCHQ's live form sha1 disagrees with the
  caller-supplied sha1 (concurrent edit). Re-fetch the latest CCZ,
  re-derive the patch, retry. Non-retryable in the same form-state.
- **HTTP 500 on `edit_form_attr/.../xform/`** — almost always a
  malformed XForm XML payload (broken bind, invalid XPath in a
  calculate, missing namespace). Surface the response body slice.
- **Verify step fails (Step 7)** — the new release CCZ still contains
  the assessment markup (or `<user_score/>`) for at least one patched
  form. Either the patch itself was wrong (helper bug), CCHQ silently
  rejected it, OR the build/release step picked up an older draft.
  Halt with the per-form before/after dump.
- **`commcare-patches.yaml` references an app not in
  `3-commcare/app-deploy_summary.md`** — operator added a stale or incorrect
  entry. Fail loudly rather than guess.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-05-03 | Initial version. Temporary workaround for nova-plugin#5 + nova-plugin#6 — both upstream Nova bugs gate Phase 4 e2e for any LEEP-style Connect Learn app with the standard quiz scaffold. Backed by the new `commcare_patch_xform` atom in `mcp/connect/backends/commcare.ts` and the pure `applyUserScorePatch` helper. Single patch class shipping today: `user-score`. Removal criteria documented. | ACE team |
| 2026-05-03 | Added `assessment-removal` patch class after live root-cause analysis showed `user-score` alone is insufficient: Connect's `/opportunity/init/` rejects ANY Learn app whose forms carry `commcareconnect`-namespaced `<assessment>` markup, regardless of whether `user_score` is populated. The reference working app (Turmeric Learn `76fd5f0e2834454bb946bdf9ae9bff71`) has zero `commcareconnect` references in suite.xml, profile.ccpr, or any form XML — the assessment relationship is derived from suite-level metadata. New helper `applyAssessmentRemovalPatch` strips the wrapper element + binds entirely. Filed as suspected nova-plugin#7. `assessment-removal` is now the recommended class for new opps; `user-score` retained for diagnostic use. | ACE team |
