---
name: app-hq-settings
description: >
  Apply the two HQ-layer standing-instruction settings Nova can't set at
  build time — camera-only photo capture (appearance="acquire" on Deliver
  image uploads) and grid menu display on every module — to the deployed
  draft apps, then resolve the matching Phase-3 residuals. Runs between
  app-deploy and app-release.
disable-model-invocation: false
---

# App HQ Settings

Post-build, post-deploy step that **applies** the two HQ-layer
standing-instruction settings Nova has no schema for and therefore
cannot set when it builds an app:

1. **Camera-only photo capture** — every image `<upload>` control in the
   Deliver app carries `appearance="acquire"` so the on-device widget
   hides the CHOOSE IMAGE gallery button (verification-story requirement,
   dimagi-internal/ace#867).
2. **Grid menu display** — every module (menu) in both the Learn and
   Deliver apps renders as a grid rather than a list.

Both settings live on the **CCHQ draft** app document. This skill mutates
the draft only; `app-release` (Phase 3 Step 2.7, which runs immediately
after this skill) is what makes the versioned build and releases it so
the settings reach FLW devices. `app-release-qa` (Step 2.8) is the
downstream structural backstop that re-verifies both from the released
suite.xml + form XML.

## Why this skill exists

Nova's blueprint schema has no field for the image-widget `appearance`
hint and no field for per-module menu display style, so a Nova-built app
lands on CCHQ with gallery-upload-permitting photo questions and
list-style menus regardless of what the PDD demands. Historically these
two toggles were recorded as build-memo prose ("camera-only photo + Grid
menu-display need HQ app-builder flip") and never performed — on
`hh-poverty-targeting/20260702-1456` the flip sat in the memo, was never
applied, and Phase 6 shipped training materials contradicting the live
app (a deck claiming "no gallery option, on purpose" over a widget
showing CHOOSE IMAGE). This skill is the automated apply-step that closes
that gap, and it clears the `phases.commcare-setup.residuals[]` entries
that track the two toggles so the residual state reflects reality.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 3 § Step 2 | `3-commcare/app-deploy_summary.md` frontmatter | `hq_domain`, `learn_app_id`, `deliver_app_id` (the draft apps to mutate) |
| Phase 3 § Step 2 | `run_state.yaml` `phases.commcare-setup.products.apps` | cross-check of the same HQ app ids + friendly names |
| Phase 3 residual tracking | `run_state.yaml` `phases.commcare-setup.residuals[]` | the camera-only + grid entries this skill resolves once applied |
| Phase 1 (context) | `1-design/idea-to-pdd.md` | whether the PDD demands camera-only capture — the acquire pass is PDD-conditional, mirroring `app-release-qa` Step 4 |
| Env | `ACE_HQ_USERNAME` / `ACE_HQ_API_KEY` | required so `run-form-walk` can overlay draft `form_unique_id` + `module_unique_id` from the draft-app API (issue #108) |

Flags:

- `<opp-name>/<run-id>` — positional, required. Resolves the opp's run
  folder.
- `--app=learn|deliver|both` — default `both`. (Camera-only always
  targets Deliver only regardless; grid targets whatever `--app` selects.)
- `--dry-run` — compute what WOULD be patched/gridded and write a dry-run
  summary; make NO `get_form_source` / `patch_xform` / `set_menu_display`
  mutations. See § Dry-Run Behavior.

## Products

- `3-commcare/app-hq-settings_summary.md` — per app: forms whose image
  uploads were patched to `acquire`, modules gridded, residuals resolved,
  and any follow-ups (e.g. the app-root menu caveat). Frontmatter shape in
  § Process Step 5.
- Resolved `phases.commcare-setup.residuals[]` entries for camera-only +
  grid (marked applied) — see Step 5.

## Prerequisites

- The CCHQ user backing `ACE_HQ_USERNAME` needs a role with `edit_apps`
  on the target project space (same requirement as `app-release` and
  `app-multimedia-coverage`; standard `Admin` includes it). The
  `commcare_patch_xform` and `commcare_set_menu_display` atoms both POST
  through the session-cookie + `X-CSRFToken` path.
- `ACE_HQ_USERNAME` + `ACE_HQ_API_KEY` must be set so `run-form-walk`
  can reach the draft-app API and overlay draft uids. Without them the
  walk falls back to suite.xml uids (`form_unique_id_source: 'suite_xml'`)
  and null `module_unique_id`s — both are REJECTED by the atoms
  (issue #108). **Halt if the walk reports `suite_xml`** (Step 2).

## Process

Inputs resolved from the run folder; ordering is Deliver-then-Learn is
irrelevant here (no orphan-pruning hazard as in `app-multimedia-coverage`
— this skill uploads nothing).

### Step 1: Read HQ app ids

Read `3-commcare/app-deploy_summary.md` frontmatter for `hq_domain`,
`learn_app_id`, and `deliver_app_id`. Cross-check against
`run_state.yaml` `phases.commcare-setup.products.apps.{learn,deliver}.hq_app_id`
— if they disagree, halt (a re-upload happened after the summary was
written; re-read the canonical ids per `app-deploy` § HQ-id stability).

Read `1-design/idea-to-pdd.md` (or the run's PDD copy) to decide whether
camera-only capture is demanded. If the PDD does NOT demand camera-only
photo capture, skip Step 3 entirely and record
`camera_only: not-required-by-pdd` in the summary (mirrors
`app-release-qa`'s `camera_only_uploads: not-required-by-pdd`). Grid
(Step 4) is unconditional.

### Step 2: Enumerate forms + modules via run-form-walk (draft uids)

For each app in scope, enumerate its forms and modules against the
**draft** with `run-form-walk`:

```bash
npx tsx scripts/run-form-walk.ts <hq_domain> <hq_app_id> --out /tmp/ace-hq-<app>.json
```

(No `--build-id` — this skill targets the draft, so let the walk download
the current draft CCZ. The draft-app API overlay is what supplies the
canonical uids regardless of which CCZ was walked.)

The walk emits per form: `form_unique_id` (draft), `module_unique_id`
(draft, from `modules[N].unique_id`), `form_path`, and per-field `kind` —
image-bearing forms carry at least one field with `kind: image` (an
`<upload mediatype="image/*">` control). It also emits a top-level
`form_unique_id_source`.

**CRITICAL (issue #108): halt if `form_unique_id_source: 'suite_xml'`.**
suite.xml uids are a build-only CCHQ variant that `commcare_patch_xform`
REJECTS, and in that fallback mode `module_unique_id` comes back `null`
(so `commcare_set_menu_display` has nothing valid to target either).
Re-run with `ACE_HQ_USERNAME` / `ACE_HQ_API_KEY` set, or pass the draft
uids explicitly. Do not proceed with a `suite_xml` walk.

Likewise, if any module this skill needs to grid has `module_unique_id:
null` despite a `draft_api` source, halt for that module and surface the
form path — the draft-app API row was malformed.

### Step 3: Camera-only — `appearance="acquire"` (Deliver only)

Skip entirely when the PDD does not demand camera-only (Step 1) or when
`--app=learn`. Photos are Deliver-only in the Connect model; Learn forms
are case-less content/quiz forms and never carry image uploads.

For each Deliver form that the walk reports with ≥1 `kind: image` field:

1. `commcare_get_form_source({ domain, app_id, form_unique_id })` →
   `{ xform_xml, sha1 }`. Use the **draft** `form_unique_id` from the
   walk.
2. In `xform_xml`, for **every** image `<upload>` control (any
   `<upload>` whose `mediatype` starts with `image/`), ensure it carries
   `appearance="acquire"`:
   - If the element already has `appearance` and its value contains
     `acquire`, leave it unchanged (**idempotent — no-op**).
   - If it has `appearance` without `acquire`, this is a conflicting
     hint — halt the form and surface the existing value rather than
     clobber a deliberate appearance (report path + `<upload ref>` +
     observed value).
   - Otherwise add `appearance="acquire"` to the `<upload>` start tag.

   Mirror `scripts/run-xform-patch.ts`'s XML handling conventions
   (in-place attribute edit on the parsed body element; write the mutated
   XML to a temp file such as `/tmp/ace-hq-acquire-<form_unique_id>.xml`).
   The contract truth (verified 2026-07-13 against commcare-android:
   `QuestionWidget.ACQUIREFIELD = "acquire"`) is that the widget hides
   the gallery button when the appearance hint **contains** `acquire`;
   the canonical serialized form is
   `<upload ref="/data/<field>" mediatype="image/*" appearance="acquire">`.

   **Case-block / Vellum-cache guard (from
   `skills/pdd-to-learn-app/reference.md`):** `commcare_patch_xform`
   hits a Vellum-cache-drift class if a patched form carries a `<case>`
   block — `make_build` then rejects with "Cannot use Case Management UI
   if you already have a case block in your form." Learn forms are
   case-less and photos are Deliver-only, so this pass is structurally
   safe — but **keep the guard**: before patching, scan the fetched
   `xform_xml` for a `<case>` block; if one is present, halt the form and
   surface it rather than risk the drift (this should never fire on a
   Deliver photo form; if it does, the app shape is unexpected and wants
   human eyes).

3. `commcare_patch_xform({ domain, app_id, form_unique_id, new_xform_xml_path: <temp>, sha1: <from step 1> })`.
   Pass the mutated XML via `new_xform_xml_path` (patched Deliver forms
   are routinely 12K+ chars and blow past tool-call arg-size limits when
   inlined). Pass the `sha1` from Step 1 as the concurrency token.

   If **no** `<upload>` needed changing (all already carried `acquire`),
   skip the patch for that form and record it as `already-acquire`
   (idempotent re-run).

4. On `XformConflictError`, halt the form and surface the live sha1 (a
   concurrent edit happened between the read and the patch); the operator
   re-fetches and retries. On any other patch failure, **halt loud** with
   the form path + the error (see § Failure modes).

### Step 4: Grid menu display (both Learn + Deliver, per module)

For every module in scope (dedupe on `module_unique_id` — the walk emits
one row per form, so multiple forms share a module uid):

```
commcare_set_menu_display({ domain, app_id, module_unique_id, display_style: 'grid' })
```

`display_style` defaults to `'grid'`, but pass it explicitly for clarity.
Idempotent: re-setting a module that is already grid is a harmless no-op
POST. A `200` (optionally with an `app_version` bump) confirms the edit;
on non-200 the atom throws — **halt loud** with the module uid + error.

**App-root "Modules Menu Display" caveat (flagged in the atom).**
`commcare_set_menu_display` sets ONE module's display style. Whether the
app-ROOT top-level menu (the grid-vs-list of the list of modules) needs a
SEPARATE app-level flag (e.g. `use_grid_menus` on the app doc via a
different `edit_app_attr`-style endpoint) is UNVERIFIED and deliberately
not implemented. **Do NOT invent an endpoint.** After this skill applies
per-module grid and `app-release` ships the build, `app-release-qa` /
suite.xml is the check that confirms whether the root menu also gridded.
If the root menu proves to still be a list and the PDD/journeys require a
root grid, record it in the summary as an explicit `follow-up:
app-root-menu-grid-unverified` line (NOT a resolved residual) so a human
can probe + implement the app-level flag separately.

### Step 5: Write summary + resolve residuals

Write `3-commcare/app-hq-settings_summary.md`:

```yaml
---
hq_domain: <domain>
learn_app_id: <hq-app-id>
deliver_app_id: <hq-app-id>
camera_only: applied | already-acquire | not-required-by-pdd
grid_menu: applied
learn_forms_patched: <N>          # always 0 (Learn has no image uploads)
deliver_forms_patched: <N>
learn_modules_gridded: <N>
deliver_modules_gridded: <N>
residuals_resolved:
  - camera-only-appearance-acquire
  - grid-menu-display
follow_ups: []                    # e.g. [app-root-menu-grid-unverified]
status: clean | partial | blocked
ran_at: <ISO-8601>
dry_run: false
---
```

Body: per-app table — per Deliver form, the image `<upload>` refs patched
(or `already-acquire`); per app, the list of module uids gridded; the
residual-resolution note; any follow-ups.

Then **clear the resolved residuals** from
`phases.commcare-setup.residuals[]`. Phase 6 (`qa-and-training`) treats a
residual as OPEN by its mere **presence** — the entry shape is
`{what, where_to_apply, verifiable_by}` with **no `status` field**, and the
mechanism is "standing state, repeated every run until cleared" (see
`agents/qa-and-training.md` residuals pre-flight). So resolution means
**removing** the entry, not annotating it — a status-flip would leave Phase 6
still reading it as open. Read the current run's
`phases.commcare-setup.residuals[]`, drop the two entries this skill applied —
the camera-only entry (`what` ≈ "camera-only photo capture — flip appearance to
acquire…") and the grid entry (menu-display) — and write the **filtered array**
back. The audit trail lives in `app-hq-settings_summary.md`
(`residuals_resolved`), not in the cleared array.

Clear an entry ONLY after its toggle was actually applied this run; a
skipped/failed toggle leaves its residual in place (see Failure modes).
`app-release-qa` (Step 2.8) is the independent backstop — if the released CCZ
lacks `acquire`/grid it halts loud regardless of residual state, so clearing
here is safe. Because removing an array element is a **replace**, not a
deep-merge add, write the filtered list back with
`mcp__plugin_ace_ace-gdrive__update_yaml_file` scoped to
`phases.commcare-setup.residuals` — set that single key to the filtered array
(overwrite the list). Do NOT use `merge: 'deep'` (it can only add/update
entries, never remove one), and keep the write scoped to that one key so sibling
phase state is untouched (`app-deploy` § Step 6; jjackson/ace#572).

If the camera-only pass was skipped (`not-required-by-pdd`), still resolve
the camera-only residual if one exists, annotating
`resolution: not-required-by-pdd` — the standing instruction is satisfied
(no gallery-permitting photo question to fix).

### Step 6: Idempotency + halt-loud

- **Idempotent** end to end: re-running finds every image upload already
  carrying `acquire` (records `already-acquire`, patches nothing) and
  re-sets grid on already-grid modules (harmless no-op). A second run over
  a clean opp mutates nothing and writes `status: clean`.
- **Halt loud on any patch/grid failure**: surface the exact form path
  (Step 3) or module uid (Step 4) plus the error, set `status: blocked`,
  do NOT resolve the affected residual, and stop. A partial application
  (some forms patched, one failed) writes `status: partial` with the
  failed form named and leaves the camera-only residual UNresolved.

## Dry-Run Behavior

`--dry-run` executes Steps 1–2 (read ids, run the walk) and then
**computes** what Steps 3–4 WOULD do, making **no** `get_form_source`,
`patch_xform`, or `set_menu_display` calls:

- Enumerate the Deliver forms with `kind: image` fields and list the
  image `<upload>` refs it would ensure carry `acquire` (read from the
  walk's field inventory — the walk itself is read-only, so it is
  allowed; the `get_form_source` fetch that would confirm current
  appearance is NOT made).
- Enumerate the modules (per app) it would set to grid, by
  `module_unique_id`.
- Write the dry-run summary to
  `comms-log/dry-run-app-hq-settings-<YYYY-MM-DD>.md` (same frontmatter
  shape as Step 5 with `dry_run: true` and `status: dry-run-success`),
  listing the would-patch forms + would-grid modules.
- Do NOT resolve any residual; do NOT write
  `3-commcare/app-hq-settings_summary.md`.
- Halt-loud on a `suite_xml` walk still applies in dry-run (the plan
  would be un-executable, so surface it).

## Failure modes

| Mode | Cause | Behavior |
|---|---|---|
| `form_unique_id_source: 'suite_xml'` | `ACE_HQ_USERNAME`/`ACE_HQ_API_KEY` missing or draft-app API unreachable | Halt before any mutation. Draft uids + module uids are unavailable; both atoms would reject (issue #108). Re-run with creds. |
| `module_unique_id: null` on a `draft_api` walk | draft-app API row malformed for that module | Halt that module, surface the form path. |
| `<upload>` already has non-`acquire` appearance | A deliberate appearance hint conflicts | Halt the form, surface the existing value; do not clobber. |
| `<case>` block in a form being patched (Vellum-cache guard) | Unexpected app shape (should never happen on a Deliver photo form) | Halt the form, surface it; `make_build` would otherwise reject in `app-release`. |
| `XformConflictError` on `patch_xform` | Live form sha1 disagrees with the Step-1 token (concurrent edit) | Halt the form, surface the live sha1; operator re-fetches + retries. |
| `commcare_patch_xform` non-conflict failure | CCHQ rejected the patch | Halt loud, form path + response slice, `status: blocked`. |
| `commcare_set_menu_display` non-200 | CCHQ rejected the display-style edit | Halt loud, module uid + error, `status: blocked`. |
| App-root menu still a list after release | `set_menu_display` covers modules, not the app-root flag (unresolved caveat) | Record `follow-up: app-root-menu-grid-unverified` in the summary; do NOT invent an endpoint. `app-release-qa`/suite.xml is the check. |

## MCP tools used

- **Google Drive:** `drive_read_file`, `drive_create_file`,
  `drive_update_file` (summary), `update_yaml_file` (residual resolution).
- **ace-connect (CCHQ atoms):**
  - `commcare_get_form_source({domain, app_id, form_unique_id}) →
    {xform_xml, sha1}` — read the draft form's current XForm XML + the
    sha1 concurrency token.
  - `commcare_patch_xform({domain, app_id, form_unique_id,
    new_xform_xml|new_xform_xml_path, sha1?})` — POST the mutated XForm
    XML adding `appearance="acquire"`. Prefer `new_xform_xml_path` for
    real forms (arg-size limits); pass exactly one of the two payload
    args. Pass the `sha1` from `get_form_source` as the concurrency token.
  - `commcare_set_menu_display({domain, app_id, module_unique_id,
    display_style?}) → {status, app_version?}` — set a module's menu to
    grid (`display_style` defaults to `'grid'`). Draft-only; app-release
    ships it. App-root caveat above.
- **CLI wrappers (Bash):**
  - `scripts/run-form-walk.ts <domain> <app_id> [--out <path>]` —
    read-only draft/CCZ walk. Emits per-form `form_unique_id` +
    `module_unique_id` (draft, from the `/api/v0.5/application/` overlay)
    + per-field `kind` (`image` for image `<upload>`s), plus the
    top-level `form_unique_id_source` gate. This skill relies on the
    `module_unique_id` + `kind: image` outputs added for it.

## Change log

| Date | Change | Author |
|------|--------|--------|
| 2026-07-17 | Initial version. Post-build/post-deploy apply-step for the two HQ-layer standing-instruction settings Nova can't set: camera-only `appearance="acquire"` on Deliver image uploads (#867) and grid menu display per module (both apps). Runs between `app-deploy` and `app-release`; mutates the draft only (app-release ships it, app-release-qa backstops it). Resolves the camera-only + grid `phases.commcare-setup.residuals[]` entries. Backed by the new `commcare_get_form_source` + `commcare_set_menu_display` atoms and a `run-form-walk` extension that emits draft `module_unique_id` + `kind: image`. Halts on `suite_xml` uid source (#108). App-root menu-display grid remains an unimplemented, deliberately-not-invented caveat surfaced as a follow-up. | ACE team |
