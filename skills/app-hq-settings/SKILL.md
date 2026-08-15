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
2. **Grid menu display** — both apps render as grids at BOTH levels: the
   app-root module menu (`use_grid_menus` app flag) and every module's
   form list (per-module `display_style: 'grid'`, which the suite
   generator only honors when the app-level `grid_form_menus == 'some'`).
   Three fields, two atoms — see Step 4 (dimagi-internal/ace#1082).

Both settings live on the **CCHQ draft** app document. This skill mutates
the draft only; `app-release` (Phase 3 Step 2.7, which runs immediately
after this skill) is what makes the versioned build and releases it so
the settings reach FLW devices. `app-release-qa` (Step 2.8) is the
downstream structural backstop that re-verifies both — but **each from a
different surface**, because grid is not observable in the CCZ at all
(dimagi-internal/ace#1009):

| Setting | Backstop surface | Halt class |
|---|---|---|
| Camera-only (`appearance="acquire"`) | released CCZ form XML | `camera-only-appearance-missing` |
| Grid menu display (all three fields) | `GET /a/<domain>/apps/source/<build_id>/` → `use_grid_menus` + `grid_form_menus` + `modules[].display_style` | `grid-menu-display-missing` |

The grid row is worth stating explicitly because the intuitive surfaces
both **lie**: `suite.xml` emits a bare `<menu id="mN">` with no style
attribute (searching a correctly-gridded released CCZ for `grid`,
case-insensitive, across every entry, returns nothing), and
`GET /api/v0.5/application/<id>/` serializes only
`['case_properties','case_type','forms','name','unique_id']` per module —
so it reads a misleading `None` for a module that IS set to grid. Until
ace#1009 this skill claimed `app-release-qa` re-verified grid "from the
released suite.xml"; that was false on both halves — the check did not
exist, and could not have passed if it had.

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
| Phase 3 § Step 2 | `run_state.yaml` `phases.commcare-setup.products.apps` | **PRIMARY**: `hq_app_id` per app (the draft apps to mutate) — run_state is the run's source of truth (CLAUDE.md; ace#1239) |
| Phase 3 § Step 2 | `3-commcare/app-deploy_summary.md` frontmatter | cross-check: `hq_domain` + the same app ids + `*_superseded_hq_app_id` lists |
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
  / `set_app_menu_display` mutations. See § Dry-Run Behavior.

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
  `commcare_patch_xform`, `commcare_set_menu_display`, and
  `commcare_set_app_menu_display` atoms all POST through the
  session-cookie + `X-CSRFToken` path (as does Step 4c's
  `GET /apps/source/` read-back, which 401s on ApiKey auth).
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

Read `run_state.yaml`
`phases.commcare-setup.products.apps.{learn,deliver}.hq_app_id` as the
**primary** id source (run_state is the run's source of truth —
dimagi-internal/ace#1239 inverted the old summary-first precedence,
which sent every downstream skill to a stale id after a mid-Phase-3
repair re-upload). Read `3-commcare/app-deploy_summary.md` frontmatter
for `hq_domain` and as the cross-check. On disagreement:

- If the summary's id appears in run_state's or the summary's own
  `<app>_superseded_hq_app_id` list → the summary is stale, not
  corrupt: **proceed with the run_state id**, log
  `[WARN] app-deploy_summary.md stale (superseded id <old>; using
  <new>)`, and note it in this skill's summary so the bookkeeping gap
  is visible.
- If the disagreement is NOT explained by a superseded-id entry (or
  run_state has no id at all) → **halt**: neither source can be
  trusted, and mutating a guessed app id returns 200 against the wrong
  app (the ace#1046 silent-wrong-target class). Name both values in
  the halt. Re-upload bookkeeping contract:
  `app-deploy` § HQ-id stability.

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
ACE_ROOT="${CLAUDE_PLUGIN_ROOT:-$(python3 -c "import json,os; d=json.load(open(os.path.expanduser('~/.claude/plugins/installed_plugins.json'))); print(d['plugins']['ace@ace'][0]['installPath'])")}"
WALK_OUT="$(npx --prefix "$ACE_ROOT" tsx "$ACE_ROOT/scripts/run-form-walk.ts" <hq_domain> <hq_app_id> --draft-only --with-fields --out-scratch)"
jq . "$WALK_OUT"
```

**`--draft-only` is REQUIRED at this pipeline position (ace#971, ace#1437).**
This skill runs at Phase 3 Step 2.65 — between `app-deploy` and `app-release` —
because it mutates the CCHQ *draft*, so it must land before the build is cut.
Without the flag the walk hard-requires a downloadable CCZ, and on a fresh run
the draft has never been built, so the command returns
`download_ccz failed: status=404`.

That 404 does not stay quiet. This skill is best-effort and fail-soft, so the
run proceeds with grid menu display never applied — and `app-release-qa`
(Step 2.8) BLOCKER-gates all three grid fields (ace#1082). The result is a
Phase 3 halt two steps later whose cause is three steps upstream and disguised
as a release-QA failure. That is the silent-degrade shape #971 was filed about,
and it came back through the doc: the code carried `--draft-only` while this
line did not, at the same installed version.

**`--with-fields` is REQUIRED for Step 3.** A plain `--draft-only` walk emits
uids only, and Step 3 triggers on forms carrying `kind: image` — so without it
the walk reports no field inventory and a literal reading skips the camera-only
patch (ace#994). Check `fields_available` in the output before evaluating
Step 3.

**Never pass a fixed `--out /tmp/ace-hq-<app>.json` (ace#1046).** That path
is shared across macOS users on this workstation: the write fails `EACCES`
when another account owns the existing file, and the follow-up read
**succeeds anyway** — returning a different session's walk of *different
apps*. That happened live on `bednet-spot-check/20260729-0002` at this exact
step; feeding those module ids to `commcare_set_menu_display` would have
gridded modules on two unrelated apps in prod HQ with a 200 and no error.
`--out-scratch` derives an unpredictable per-user path and prints it on
stdout, and every write is read back and asserted to carry the `domain` +
`app_id` this invocation asked for (`lib/scratch-file.ts`). If the script
throws `STALE_ARTIFACT`, **halt** — do not pass any id from that payload to a
write-side atom.

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

**CRITICAL (ace#994): a `--draft-only` walk emits NO field inventory unless
you pass `--with-fields`.** Plain `--draft-only` returns uids only — no
`fields`, no `form_path` — and Step 3 below triggers on forms carrying
`kind: image`. A literal reading therefore finds **zero** image-bearing forms
on a never-built draft and silently skips the camera-only patch, which is the
same fail-soft class #971 set out to close, one step downstream. It shipped
live on `spark-facilitator/20260727-1850`.

The walk now says which it is, in a top-level `fields_available`:

- `fields_available: true` — the inventory is real; "no `kind: image` fields"
  means there are none.
- `fields_available: false` — **nothing was collected.** Do NOT conclude the
  app has no image fields. Re-run the walk with `--with-fields` (opt-in
  because it costs a Playwright session, which plain `--draft-only`
  deliberately avoids) and use that result for Step 3.

`--with-fields` reads each form's source from the draft through the same
`/apps/browse/<app_id>/<form_unique_id>/source/` path Step 3 already uses via
`commcare_get_form_source`, so it needs no build.

### Step 3: Camera-only — `appearance="acquire"` (Deliver only)

Skip entirely when the PDD does not demand camera-only (Step 1) or when
`--app=learn`. Photos are Deliver-only in the Connect model; Learn forms
are case-less content/quiz forms and never carry image uploads.

**Pre-flight:** if the Step-2 walk reported `fields_available: false`, re-run it with
`--with-fields` before evaluating this step. A `false` there means the inventory was
never collected — treating it as "no image fields" is the ace#994 silent skip.

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
   XML to a scratch file created with
   `mktemp "${TMPDIR:-/tmp}/ace-hq-acquire-XXXXXX.xml"` — never a fixed
   `/tmp/ace-hq-acquire-<form_unique_id>.xml`, per ace#1046 above).
   The contract truth (verified 2026-07-13 against commcare-android:
   `QuestionWidget.ACQUIREFIELD = "acquire"`) is that the widget hides
   the gallery button when the appearance hint **contains** `acquire`;
   the canonical serialized form is
   `<upload ref="/data/<field>" mediatype="image/*" appearance="acquire">`.

   **Do NOT scan for a `<case>` block — the old pre-patch halt is
   DELETED (ace#1238).** This step used to refuse to patch any form whose
   `xform_xml` contained a `<case>` block, on the theory that
   `commcare_patch_xform` hits a Vellum-cache-drift class and `make_build`
   then rejects with "Cannot use Case Management UI if you already have a
   case block in your form."

   **That guard had no recorded reproducer, and it blocked Phase 3 on
   every run.** Stated plainly so nobody reinstates it from the same
   intuition:

   - It cited `skills/pdd-to-learn-app/reference.md` as its source. That
     file does not contain it.
   - The error string appears exactly ONCE in this repo — inside the
     guard's own justification. No learning doc, no issue, no run where
     it was observed.
   - Its own wording ("this should never fire on a Deliver photo form")
     is the tell: written from a hypothesis, not an observation.
   - Counter-evidence: Nova uploads these apps to HQ **with** the case
     block present and HQ builds them. Nova expresses every case write as
     a `SaveToCase` operation under `__nova_operations`, and that block
     literally contains a `<case>` element in the CommCare
     case-transaction namespace — so the guard fired on essentially every
     ACE Deliver app that writes case properties. Camera-only never
     applied, `app-release-qa` Step 2.8 then halted on
     `camera-only-appearance-missing`, and Phase 3 deadlocked: one step
     refusing to write the attribute the next refuses to proceed without.
   - Best read on its origin: the error is real in CommCare HQ, but it
     belongs to the **form-builder (Vellum) Case Management UI** — it
     fires when a human opens that tab on a form carrying a hand-authored
     case block. It is not a `make_build` validation of arbitrary XML,
     and ACE never opens Vellum; it patches by API and builds by API.

   A narrower scan would still be a guess. So: **patch unconditionally,
   and let `commcare_make_build` (Step 3.5) be the authority** — attempt
   the transition and treat the conflict as the signal, never a read-back
   flag standing in for it (CLAUDE.md § Conventions).

   **Breadcrumb only, never blocking:** if the fetched `xform_xml`
   carries a `<case>` element OUTSIDE `__nova_operations` (i.e. not the
   standard Nova `vellum:role="SaveToCase"` shape), record an `[INFO]`
   line in the Step 5 summary naming the form path — so if this class
   ever does bite, the run that hit it left evidence. Do **not** halt, do
   **not** skip the patch.

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

5. **Prove the patch against the builder — once per app, after all its
   forms are patched.** Call

   ```
   commcare_make_build({ domain, app_id, comment: 'app-hq-settings camera-only verification' })
   ```

   This is the authoritative answer to the case-block question step 2
   deliberately no longer tries to predict:

   - **Build succeeds** → the patch is safe. Proceed to Step 4. (The
     draft is unchanged by a build; `app-release` makes and releases its
     own build later.)
   - **Build rejects with "Cannot use Case Management UI if you already
     have a case block in your form"** → the drift class DID fire. **Halt
     loud**, surface the rejection verbatim plus every form patched in
     this pass, set `status: blocked`, and leave the camera-only residual
     UNresolved so `app-release-qa` Step 2.8 still sees an open gap. Do
     not attempt to re-patch around it — this is the case the guard
     exists for, and it wants human eyes.
   - **Any other build failure** → halt loud with the error; it is not
     this skill's class, but shipping past a failing build hides it from
     `app-release`.

   Skip when no form needed patching (all `already-acquire`) — there is
   nothing to prove.

### Step 4: Grid menu display (both Learn + Deliver — BOTH halves)

Grid display is three fields across two levels, and every one of them is
load-bearing (dimagi-internal/ace#1082; HQ contract:
`corehq/apps/app_manager/suite_xml/sections/menus.py:86-92`):

- `use_grid_menus` (app-level bool) — the app-ROOT menu of modules.
- `grid_form_menus` (app-level, `none|all|some`) — must be `'some'` for
  per-module `display_style` to have ANY effect in the generated suite;
  at the HQ default `'none'` the per-module writes are silently inert.
- `modules[].display_style` (per module) — each module's form list.

**4a. Per-module half.** For every module in scope (dedupe on
`module_unique_id` — the walk emits one row per form, so multiple forms
share a module uid):

```
commcare_set_menu_display({ domain, app_id, module_unique_id, display_style: 'grid' })
```

`display_style` defaults to `'grid'`, but pass it explicitly for clarity.
Idempotent: re-setting a module that is already grid is a harmless no-op
POST. A `200` (optionally with an `app_version` bump) confirms the edit;
on non-200 the atom throws — **halt loud** with the module uid + error.

**4b. App-level half.** Once per app:

```
commcare_set_app_menu_display({ domain, app_id })
```

Defaults (`use_grid_menus: true`, `grid_form_menus: 'some'`) are the
component's required values — pass no overrides. Idempotent for the same
reason as 4a. On non-200 the atom throws — **halt loud** with the app id +
error. (Under the hood this POSTs
`{"hq": {"use_grid_menus": true, "grid_form_menus": "some"}}` to
`edit_app_attr/<app_id>/all/` — the only route HQ exposes for these
flags; they are not in the per-attr allowlist.)

**4c. Verify BOTH halves from `/apps/source/`.** The POST status is not
proof (per "prove every write against a fresh authoritative read"). For
each app, GET the raw draft doc:

```
GET /a/<domain>/apps/source/<app_id>/
```

**Session-cookie auth required** — this endpoint 401s on
`Authorization: ApiKey` (ace#1082); use the `~/.ace/connect-session.json`
cookie jar like the atoms do. Assert all three: `use_grid_menus === true`,
`grid_form_menus === 'some'`, and every `modules[].display_style ===
'grid'`. Any miss → **halt loud** naming the app, the field, and the
observed value; do NOT resolve the grid residual. (Live-validated
2026-07-30 on connect-ace-prod Learn `7a512291fb5545a3812ab429e306dbea` +
Deliver `fc14076ff22d4b199451ea2cba4cd48f`: both read
`use_grid_menus: false, grid_form_menus: "none"` before and
`true / "some"` after, with all module `display_style` values untouched.)

### Step 5: Write summary + resolve residuals

Write `3-commcare/app-hq-settings_summary.md`:

```yaml
---
hq_domain: <domain>
learn_app_id: <hq-app-id>
deliver_app_id: <hq-app-id>
camera_only: applied | already-acquire | not-required-by-pdd
grid_menu: applied                # per-module display_style (Step 4a)
app_menu_flags: applied           # use_grid_menus + grid_form_menus (Step 4b, verified 4c)
learn_forms_patched: <N>          # always 0 (Learn has no image uploads)
deliver_forms_patched: <N>
learn_modules_gridded: <N>
deliver_modules_gridded: <N>
residuals_resolved:
  - camera-only-appearance-acquire
  - grid-menu-display
follow_ups: []
status: clean | partial | blocked
ran_at: <ISO-8601>
dry_run: false
---
```

Body: per-app table — per Deliver form, the image `<upload>` refs patched
(or `already-acquire`); per app, the list of module uids gridded; the
`commcare_make_build` result from Step 3.5; the residual-resolution note;
any follow-ups. Include one `[INFO]` line per patched form that carried a
`<case>` element outside `__nova_operations` (Step 3.2 breadcrumb) — an
observation, not a failure; the build already proved it harmless.

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
`patch_xform`, `set_menu_display`, or `set_app_menu_display` calls:

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
- Do NOT call `commcare_make_build` (Step 3.5) — dry-run patches nothing,
  so there is nothing to prove against the builder.
- Halt-loud on a `suite_xml` walk still applies in dry-run (the plan
  would be un-executable, so surface it).

## Failure modes

| Mode | Cause | Behavior |
|---|---|---|
| `form_unique_id_source: 'suite_xml'` | `ACE_HQ_USERNAME`/`ACE_HQ_API_KEY` missing or draft-app API unreachable | Halt before any mutation. Draft uids + module uids are unavailable; both atoms would reject (issue #108). Re-run with creds. |
| `module_unique_id: null` on a `draft_api` walk | draft-app API row malformed for that module | Halt that module, surface the form path. |
| `<upload>` already has non-`acquire` appearance | A deliberate appearance hint conflicts | Halt the form, surface the existing value; do not clobber. |
| `<case>` block OUTSIDE `__nova_operations` in a patched form | Non-standard app shape. Nova's own `SaveToCase` block carries a namespaced `<case>` element and is normal. The pre-patch halt that used to live here was DELETED (ace#1238) — it had no recorded reproducer and blocked Phase 3 on every run | **Not a failure mode.** Record an `[INFO]` breadcrumb with the form path and patch anyway; `commcare_make_build` (Step 3.5) is the authority. |
| `commcare_make_build` rejects with "Cannot use Case Management UI if you already have a case block in your form" (Step 3.5) | The Vellum-cache drift class actually fired — the authoritative signal, not the substring scan | Halt loud, surface the rejection verbatim + every form patched this pass, `status: blocked`, leave the camera-only residual open for `app-release-qa` Step 2.8. |
| `commcare_make_build` fails for any other reason (Step 3.5) | HQ rejected the build for an unrelated defect | Halt loud with the error; do not proceed to Step 4 or resolve residuals. |
| `XformConflictError` on `patch_xform` | Live form sha1 disagrees with the Step-1 token (concurrent edit) | Halt the form, surface the live sha1; operator re-fetches + retries. |
| `commcare_patch_xform` non-conflict failure | CCHQ rejected the patch | Halt loud, form path + response slice, `status: blocked`. |
| `commcare_set_menu_display` non-200 | CCHQ rejected the display-style edit | Halt loud, module uid + error, `status: blocked`. |
| `commcare_set_app_menu_display` non-200 | CCHQ rejected the app-attr edit | Halt loud, app id + error, `status: blocked`. |
| Step 4c read-back disagrees with a 200 POST | Write didn't take (or hit a superseded draft) | Halt loud naming app + field + observed value; leave the grid residual open. |

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
  - `commcare_make_build({domain, app_id, comment?})` — Step 3.5's
    authority on whether the patched form actually trips the Case
    Management UI drift class. Read the current signature in
    `docs/atom-schemas.md`; do not paraphrase it here.
  - `commcare_set_menu_display({domain, app_id, module_unique_id,
    display_style?}) → {status, app_version?}` — set a module's menu to
    grid (`display_style` defaults to `'grid'`). Draft-only; app-release
    ships it. Only takes suite effect once `grid_form_menus == 'some'`
    (the atom below sets that).
  - `commcare_set_app_menu_display({domain, app_id, use_grid_menus?,
    grid_form_menus?}) → {status, use_grid_menus, grid_form_menus,
    app_version?}` — set the app-level flags (defaults `true` / `'some'`
    are the component values). Draft-only; app-release ships it.
- **CLI wrappers (Bash):**
  - `scripts/run-form-walk.ts <domain> <app_id> [--build-id <hex>] [--draft-only [--with-fields]] [--out <path> | --out-scratch]` —
    read-only draft/CCZ walk. Emits per-form `form_unique_id` +
    `module_unique_id` (draft, from the `/api/v0.5/application/` overlay)
    + per-field `kind` (`image` for image `<upload>`s), plus the
    top-level `form_unique_id_source` gate. This skill relies on the
    `module_unique_id` + `kind: image` outputs added for it.

## Change log

| Date | Change | Author |
|------|--------|--------|
| 2026-07-17 | Initial version. Post-build/post-deploy apply-step for the two HQ-layer standing-instruction settings Nova can't set: camera-only `appearance="acquire"` on Deliver image uploads (#867) and grid menu display per module (both apps). Runs between `app-deploy` and `app-release`; mutates the draft only (app-release ships it, app-release-qa backstops it). Resolves the camera-only + grid `phases.commcare-setup.residuals[]` entries. Backed by the new `commcare_get_form_source` + `commcare_set_menu_display` atoms and a `run-form-walk` extension that emits draft `module_unique_id` + `kind: image`. Halts on `suite_xml` uid source (#108). App-root menu-display grid remains an unimplemented, deliberately-not-invented caveat surfaced as a follow-up. | ACE team |
| 2026-08-13 | **DELETED the pre-patch `<case>`-block halt; `commcare_make_build` is now the authority (ace#1238).** The guard predicted another system's rejection with a substring scan and was never checked against that system. It had **no recorded reproducer**: it cited `pdd-to-learn-app/reference.md`, which does not contain it; the error string "Cannot use Case Management UI…" appeared exactly once in the repo — inside the guard's own justification; and its wording ("this should never fire on a Deliver photo form") reads as hypothesis, not observation. Meanwhile Nova uploads these apps to HQ **with** a `<case>` element (its `SaveToCase` operation under `__nova_operations`) and HQ builds them, so the guard fired on essentially every ACE Deliver app that writes case properties: camera-only never applied, `app-release-qa` Step 2.8 then halted on `camera-only-appearance-missing`, and Phase 3 deadlocked on every run. Best read on the error's origin is the Vellum **Case Management UI** tab — a human opening that tab on a hand-authored case block — which ACE never touches (patch by API, build by API). A *narrower* scan would still be a guess, so the scan is gone: Step 3 patches unconditionally, new **Step 3.5** builds and treats an HQ rejection as the real signal, and a case block outside `__nova_operations` leaves a non-blocking `[INFO]` breadcrumb. Repro: `spark-facilitator/20260812-1635`, form `bf7eab18f4ad458286dc0e6b05b05f4d`. | ACE team |
| 2026-07-30 | **Grid Step 4 now sets BOTH halves (closes the apply side of dimagi-internal/ace#1082).** spark-facilitator/20260730-1718 proved the app-root flag was never set (`use_grid_menus: false` on both apps while all 8 modules read `display_style: grid`) — and HQ source proved worse: per-module `display_style` is INERT in the suite until app-level `grid_form_menus == 'some'` (`suite_xml/sections/menus.py:86-92`), so the "applied" per-module grids were doing nothing. New Step 4b calls the new `commcare_set_app_menu_display` atom (`edit_app_attr/<app_id>/all/` + JSON `{"hq": {...}}` — the only route; the flags are not in the per-attr allowlist, `views/apps.py:762,810-811`); new Step 4c verifies all three fields from `GET /apps/source/<app_id>/` (session-cookie auth — ApiKey 401s). Live-validated 2026-07-30 on the spark-facilitator apps. The `app-root-menu-grid-unverified` follow-up class is retired. | ACE team |
