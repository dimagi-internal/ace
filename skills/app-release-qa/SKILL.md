---
name: app-release-qa
description: >
  Phase 3 § Step 2.8 — structural + install-time QA on the released
  Learn + Deliver CCZs. Downloads each CCZ via commcare_download_ccz,
  parses the zip + suite.xml + form XMLs, verifies form counts +
  Connect-marker presence match the Nova blueprint, then runs
  commcare-cli `validate` + `play` as install-time runtime gates.
  AVD-free, Connect-free — purely CCHQ-side. Halts loud on mismatch.
disable-model-invocation: false
---

# App Release QA

Structural + install-time QA on the released CCZ artifacts at the end
of Phase 3. Catches CCZ-marker drops, form-count drift vs. Nova
blueprint, XForm parse errors, and install-time runtime binding
failures at the source. No AVD, no Connect opp dependency — runs
against CommCare HQ's REST API only.

Structural QA partner for `app-release` (no LLM-as-Judge; deterministic
pass/fail on the released artifact). A `validate_app` PASS + a successful
`make_build` / `release_build` is necessary but not sufficient — none of
those verify that the **released CCZ artifact** carries the right
structural markers. For the naming history and the three incident classes
this catches, see reference.md.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 3 § Step 2 | `3-commcare/app-deploy_summary.md` | HQ app ids (Learn + Deliver) |
| Phase 3 § Step 2.7 | `3-commcare/app-release_summary.md` | Released build ids per app |
| Phase 1 | `1-design/idea-to-pdd.md` | Payable-visit rules — whether the PDD demands camera-only photo capture (the `appearance="acquire"` check in Step 4) — and the stated per-module training durations (the `time_estimate` plausibility check in Step 4) |
| Nova MCP | `get_app({app_id})` for each Nova app id | Blueprint structure (modules, forms, fields per form, Connect marker presence) — the canonical structural truth for cross-reference |
| HQ `ACE_HQ_DOMAIN` env | — | `connect-ace-prod` (the project space the apps released to) |

## Products

- `3-commcare/app-release-qa_result.yaml` — structural verdict (see § Output schema below)

No screenshots, no per-app summaries — the structural deltas live in
the verdict YAML.

## Process

### Step 1: Read upstream artifacts

- Read `3-commcare/app-deploy_summary.md` → extract Learn HQ app id + Deliver HQ app id.
- Read `3-commcare/app-release_summary.md` → extract Learn released build id + Deliver released build id.
- Read both Nova blueprints via `get_app({app_id: <nova_id>})` for cross-reference. (The Nova app ids are referenced in the deploy summary as `nova_app_id`.)

If any of these inputs are missing, halt with a structured error
naming the missing artifact + the upstream skill that should have
produced it.

### Step 2: Download released CCZs

For each app (Learn, Deliver), call:

```
commcare_download_ccz({
  domain: <ACE_HQ_DOMAIN>,
  app_id: <hq_app_id>,
  build_id: <released_build_id>,
  include_multimedia: false,
})
```

The atom returns the CCZ as base64-encoded zip bytes inside a JSON
envelope. Decode the base64. Verify the resulting bytes start with
the zip magic `PK\x03\x04`. If not, halt with `download-failed`.

### Step 3: Parse zip + suite.xml + form XMLs

For each downloaded CCZ:

1. Unzip into an in-memory file tree (or temp dir; clean up at end).
2. Read `suite.xml` from the zip root. Parse as XML.
3. For each `<menu>` / `<entry>` in suite.xml, identify the per-form
   XForm path (typically `modules-N/forms-M.xml`).
4. For each form XForm path, read + parse the XForm XML.

If any parse fails (zip malformed, suite.xml missing, XForm XML
malformed), halt with the specific class:
- `cczunzip-failed`
- `suite-xml-missing-or-malformed`
- `xform-parse-failed` (with the form path + the parser error message)

### Step 4: Structural verification per app

For each app, compute:

**Form count.** Count of XForm XMLs in the zip vs. count from Nova
`get_app` blueprint. Mismatch → halt with `form-count-mismatch`
(`expected N, got M`).

> **Match Connect markers by NAMESPACE, never by a `<learn:` prefix.**
> Nova emits these markers as **default-namespace** elements — there is
> no `xmlns:learn` declaration anywhere in the CCZ, so a literal
> `grep '<learn:module'` returns **0 on a perfectly clean app** and
> fires a spurious `learn-marker-missing` / `deliver-marker-missing`
> [BLOCKER] on every release. The wire format is:
>
> ```xml
> <module    xmlns="http://commcareconnect.com/data/v1/learn" id="m0_pretest">
> <assessment xmlns="http://commcareconnect.com/data/v1/learn" id="m5_posttest">
> <deliver   xmlns="http://commcareconnect.com/data/v1/learn" id="du_meeting">
> ```
>
> Match on **local name + the `http://commcareconnect.com/data/v1/learn`
> namespace URI**, which is exactly how Connect's own
> `sync_learn_modules_and_deliver_units` matches them. **Preferred:** don't
> re-grep at all — read `projected_connect_state` from
> `commcare_download_ccz`, which already matches by namespace URI and is
> the same projection Connect's sync consumes. See jjackson/ace#680.

**Learn-specific (only for the Learn app):**

- Each Nova form whose blueprint declares `connect.learn_module` MUST
  have a `module` element in the `…/data/v1/learn` namespace in its
  XForm XML (equivalently: a `learn_modules[]` entry in
  `projected_connect_state`).
- Each Nova form whose blueprint declares `connect.assessment` MUST
  have an `assessment` element in that same namespace (equivalently: an
  `assessments[]` entry).
- Per nova-plugin#7 closure (2026-05-22): these wrappers are
  **required** for Connect's HQ→Connect sync to register learn
  modules. Their absence is a structural defect.

Mismatch → halt with `learn-marker-missing` (with the form path +
which marker is absent). Before halting, re-check by namespace — a
prefix-grep false negative is the single most likely cause of this
halt firing on a clean build.

**`time_estimate` plausibility-as-hours (dimagi-internal/ace#1077).**
The unit of `connect.learn_module.time_estimate` is **HOURS** — resolved
against Connect source 2026-07-30: the model help_text says "Estimated
hours" (`commcare_connect/opportunity/models.py:297`), the PM dashboard
renders the raw value as `f"{value}hr"`
(`commcare_connect/opportunity/tables.py:1677-1678`), ingest is a
straight `int()` passthrough with no conversion
(`commcare_connect/opportunity/app_xml.py:107-108`), and the FLW-facing
mobile app sums the raw values into "Estimated time: %d hours"
(commcare-android `ConnectJobIntroFragment.kt:64-77`). Nova's tool-schema
description says "Estimated minutes" — stale, filed as
voidcraft-labs/nova-plugin#36 — so an architect that obeyed the schema
description ships a 20-minute module that renders as **"20 hours"** on
every FLW's onboarding screen. Marker *presence* checks cannot see this;
the VALUE must be read.

Run the pure helper over the Learn app:

```ts
import { checkLearnModuleTimeEstimates, formatTimeEstimateReport }
  from '../../lib/time-estimate-check';
const report = checkLearnModuleTimeEstimates(
  projected.learn_modules.map((m) => ({
    moduleId: m.slug,
    timeEstimate: m.time_estimate,
    budgetedMinutes: pddBudgets[m.slug],  // minutes; omit when the PDD is silent
  })),
);
```

`projected` is `projected_connect_state` from `commcare_download_ccz`
(its `learn_modules[].time_estimate` carries the CCZ marker value —
exactly what Connect's sync will store). `pddBudgets` comes from the
PDD: read each module's stated duration in MINUTES from the training
design (e.g. "Modules budgeted 10–20 minutes each"); when the PDD states
no duration for a module, omit the key and the helper falls back to
absolute plausibility bounds. The helper flags, per module:

- `missing` / `non-positive` / `non-integer` — `[BLOCKER]`.
- `minutes-not-hours` — the value tracks the module's MINUTE budget (or
  is an unbudgeted two-digit count): the ace#1077 signature. `[BLOCKER]`.
- `out-of-range` — wrong vs. the budget's hour conversion
  (`max(1, ceil(minutes/60))`): `[BLOCKER]` when >2x expected,
  `[WARN]` otherwise.

`severity: 'blocker'` → halt with `[BLOCKER]`
`learn-module-time-estimate-implausible` (include
`formatTimeEstimateReport(report)`). `[WARN]`-only → record and
continue. Record per-app (Learn only) under `time_estimates` in the
verdict: `pass | { modules_checked, violations: [...] }`.

**Deliver-specific (only for the Deliver app):**

- Each Nova form whose blueprint declares `connect.deliver_unit` MUST
  have a `deliver` element in the `…/data/v1/learn` namespace
  (equivalently: a `deliver_units[]` entry in
  `projected_connect_state`).
- Each Nova form whose blueprint declares `connect.task` MUST have a
  `task` element in that same namespace (equivalently: a
  `task_units[]` entry).

Mismatch → halt with `deliver-marker-missing` (with the form path +
which marker is absent). The same namespace re-check applies before
halting.

**Field count per form.** For each form in the Nova blueprint, count
the `<input>` / `<select1>` / `<select>` / `<upload>` / `<bind>`
elements in the XForm and compare against the Nova blueprint's field
count. Mismatch by more than 0 → halt with `field-count-mismatch`
(per form: `expected N, got M`). The check tolerates Nova's
auto-generated bind elements (which inflate the count somewhat); the
canonical signal is the silent-omission class ("Nova said 17, CCZ has
14").

If the comparison is over-conservative (false positives on
auto-generated binds), WARN instead of halt — but record the count in
the verdict.

**Geopoint bind-type fidelity (cross-cutting — Learn + Deliver).**
A `kind: geopoint` field MUST compile to an XForm bind of
`type="geopoint"`. A `type="xsd:string"` bind means the released build
is a stale / downgraded compilation, invisible to every other gate
(`validate_app`, `make_build`, the structural counts above, AND
`commcare-cli play` — the `selected-at(<gps>, 0|1|3)` calcs are
init-guarded, so they don't fire at form-init). For the failure
mechanism + reproducer, see reference.md § Geopoint bind-type fidelity.

Detect it two ways (run both; either firing is a `[BLOCKER]`):

1. **Nova cross-reference (primary).** For each form, call
   `get_form({app_id: <nova_id>, moduleIndex, formIndex})` and collect
   every field whose `kind` is `geopoint`. Assert the released CCZ's
   form XML has `<bind nodeset="…/<field-id>" type="geopoint">` for each.
2. **CCZ-internal fingerprint (no Nova dependency).** In each form XML,
   find every hidden `calculate` of the shape
   `selected-at(<X>, 0|1|3)` (the lat/lon/accuracy split). The referenced
   node `<X>` is a geopoint by construction; assert `<X>`'s own bind is
   `type="geopoint"`, not `xsd:string`.

Mismatch → halt with `[BLOCKER]` `geopoint-bind-downgrade`
(naming the field path + the observed bind type + "re-build & re-release
the app from the current Nova blueprint, which compiles geopoint
correctly"). Record per-app under `geopoint_binds` in the verdict.

**Camera-only photo capture (`appearance="acquire"`) — PDD-conditional
(dimagi-internal/ace#867).** When the PDD / payable-visit rules /
journeys require live-camera-only photo capture, every image `<upload>`
node in the Deliver form XML MUST carry an `appearance` attribute
containing `acquire`. Contract truth (verified 2026-07-13 against
commcare-android source: `QuestionWidget.ACQUIREFIELD = "acquire"`;
`ImageWidget` hides the CHOOSE IMAGE gallery button when the appearance
hint contains it — and verified live on connect-ace-prod app
`d36493197a2749d49335e02678eed2ff` build v4, where the flip produced
exactly `<upload ref="/data/dwelling_photo" mediatype="image/*"
appearance="acquire">`). A missing attribute when the PDD demands
camera-only means the released app permits gallery uploads — breaking
the verification story and any training material asserting camera-only
(hh-poverty-targeting/20260702-1456 shipped a deck claiming "no gallery
option, on purpose" over a widget showing CHOOSE IMAGE).

Mismatch → halt with `[BLOCKER]` `camera-only-appearance-missing`
(naming the form path + the `<upload>` ref + "apply the camera-only
appearance flip (HQ app builder or Nova) and re-release, then re-run
app-release-qa"). Record per-app under `camera_only_uploads` in the
verdict. When the PDD does NOT demand camera-only capture, skip the
check and record `camera_only_uploads: not-required-by-pdd`.

**Grid menu display — always, both apps (dimagi-internal/ace#1009).**
`app-hq-settings` sets `display_style = 'grid'` on every module of both
apps and then declares this skill its downstream backstop. Until ace#1009
that backstop did not exist, so the setting shipped with **zero**
verification — the "applied but never verified" shape that #867 / #971 /
#994 exist to prevent.

**Read it from the raw app doc, NOT from the CCZ and NOT from the REST
API.** Both intuitive surfaces silently lie:

- `suite.xml` emits a bare `<menu id="m0">` with no style attribute.
  Searching a *correctly gridded* released CCZ for the substring `grid`
  (case-insensitive, across every zip entry) returns **nothing**. A
  suite.xml-sourced grid check could never pass, no matter how right the
  app is.
- `GET /api/v0.5/application/<app_id>/` serializes only
  `['case_properties','case_type','forms','name','unique_id']` per
  module. `display_style` is absent, so this surface reads `None` for a
  module that IS grid — a false negative waiting for whoever reaches for
  the obvious API first.

The authoritative surface is the raw app doc, which works against both
the draft app id and a released build id:

```
GET /a/<ACE_HQ_DOMAIN>/apps/source/<released_build_id>/
```

(authenticated with the `~/.ace/connect-session.json` cookie jar, same as
Step 2's download — the endpoint 401s on `ApiKey` auth). For each app,
assert **all three** grid fields (dimagi-internal/ace#1082):

- `use_grid_menus === true` — the app-ROOT menu of modules;
- `grid_form_menus === 'some'` — without it the suite generator ignores
  every per-module `display_style` (HQ
  `suite_xml/sections/menus.py:86-92`), so asserting only the per-module
  half is what let ace#1082 sit unnoticed;
- **every** entry in `modules[]` has `display_style == 'grid'`.

Any miss → halt with `[BLOCKER]` `grid-menu-display-missing` (naming the
app, the field — and for a module miss, the module index + `unique_id` —
plus the observed value and "re-run `app-hq-settings`, re-release, then
re-run app-release-qa"). Record per-app under `grid_menu_display` in the
verdict: `{ use_grid_menus, grid_form_menus, modules_checked,
modules_gridded, non_grid: [...] }`.

(Until ace#1082 the app-level flags were carried here as an INFO-only
caveat — `hh-poverty-targeting/20260728-0705` read `use_grid_menus:
False` on both apps while all 9 module menus were "grid", and
spark-facilitator/20260730-1718 additionally proved `grid_form_menus:
'none'` was rendering those module grids inert. `app-hq-settings` Step 4b
now sets both app-level flags via `commcare_set_app_menu_display`, so all
three fields are asserted as blockers.)

**Constraint locality — always, every form with constraints
(dimagi-internal/ace#980).** A `constraint` must be satisfiable on the
screen where it fires. Run the pure helper over each form XML:

```ts
import { checkConstraintLocality, formatConstraintLocalityReport }
  from '../../lib/constraint-locality';
const report = checkConstraintLocality(formXml);
```

It flags any constraint referencing a question or repeat the user cannot
edit from that screen, resolving hidden calculates transitively (so
indirection can't launder a foreign reference) and allowing the two
legitimate shapes: a self-reference (`.`) and a cardinality gate placed
**immediately** after the repeat it guards.

This check is **mechanical on purpose.** The class is 100% detectable
from the binds, and the LLM rubric missed it twice in one form:
`pdd-to-deliver-app-eval` scored `hh-poverty-targeting/20260722-1341`
8.5/10 while it shipped a GPS-accuracy rule on a later yes/no question
(message: "recapture the location", on a screen with no location widget)
and a roster-minimum rule on an unrelated zone question. A domain expert
found both on first read. Judgment is the wrong tool for a property this
crisp — hence a parser, and `lib/constraint-locality.test.ts` pins the
real defective binds as its negative control.

The checker is **screen-aware**, not question-aware: a group carrying
`appearance="field-list"` renders all its questions on ONE scrollable
screen, so a constraint referencing a sibling inside the same field-list
is **local** — the FLW scrolls up and fixes it in place. That is the
shape `skills/_app-component-library.md § data-quality-constraints`
*mandates* (`under_5 <= household_size`), and treating it as a violation
meant a correctly-authored app could not clear this step
(dimagi-internal/ace#1019).

Each violation carries a `severity`:

- `blocker` — the constraint never references the node it is bound to, so
  **no answer the user can give on that screen clears it**. The ace#980
  class: "recapture the location" on a screen with no location widget.
- `warn` — the reference crosses a screen boundary, but the constraint
  also references its own node, so lowering/changing the answer in front
  of the user satisfies it. Annoying, not a dead end.

Severity is decided structurally (does the expression mention its own
nodeset?), never by scanning the message text — ACE forms are routinely
multilingual, and a phrase list would mis-grade every localized form.

`severity: 'blocker'` → halt with `[BLOCKER]` `non-local-constraint`
(naming each field, the foreign node, and "move the constraint onto the
node it is about"). `severity: 'warn'` → emit `[WARN]`
`cross-screen-constraint` and continue. Record per-app under
`constraint_locality` in the verdict:
`{ constraints_checked, violations: [...] }` (each violation carrying its
`severity`). Zero violations records `constraint_locality: pass`.

**Relevance reachability — always, every form with relevance conditions
(dimagi-internal/ace#996).** The temporal sibling of the check above: a
`relevant` clause must be *decidable by the time the form walks past the
field it gates*. Same module:

```ts
import { checkRelevanceReachability, formatRelevanceReachabilityReport }
  from '../../lib/constraint-locality';
```

It flags any `relevant` referencing a field answered LATER, resolving
calculates transitively so a hidden calculate over a later answer inherits
that answer's position and can't launder it. Two severities:

- `whollyUnreachable: true` — every reference is later, so the field can
  **never** display. `[BLOCKER]`.
- `whollyUnreachable: false` — some clauses resolve in time, others never
  contribute. `[WARN]` — the field shows on some paths and silently not on
  others, which is how `outcome_note` submitted empty on exactly the two
  outcomes it existed to capture.

Record per-app under `relevance_reachability`. Same rationale as constraint
locality: mechanically detectable from bind order, so it is a parser rather
than a rubric line.

### Step 4.5: Runtime install validation via `commcare-cli.jar`

Steps 3–4 are **structural** and never bind any XPath expression,
leaving an install-time class uncovered: a CCZ whose XPath references
resolve to nothing at form-init (CommCare rejects it on-device with "A
part of your application is invalid"). `dimagi/commcare-core`'s
`commcare-cli.jar` ships two subcommands; use **both** in series:
`validate` (~2s, parser-class) and `play` (~5–10s, runtime form-init
defects — `XPathTypeMismatchException` from
`FormDef.initAllTriggerables`). For what each mode catches + the bednet
reproducer, see reference.md § Runtime install validation.

**Procedure** — for each app (Learn, Deliver):

1. **`validate` (parser-class pre-screen, fast):**

   ```
   commcare_validate_ccz({
     ccz_path: <local path to the released CCZ on disk>,  // preferred — no 10KB base64 round-trip through model context
     // OR ccz_base64: <if not on disk yet> — exactly one of the two
     mode: "validate",
   })
   ```

2. **`play` (the authoritative install-time gate, slower):**

   ```
   commcare_validate_ccz({
     ccz_path: <same path>,
     mode: "play",
     entry_path: [0, 0],   // first module → first form (default)
   })
   ```

   For multi-module apps, invoke `play` once per module (`[0,0]`,
   `[1,0]`, …) to cover every form's `initAllTriggerables`. **Fire all
   per-module `play` calls in parallel** (one assistant turn, multiple
   `commcare_validate_ccz` tool calls) — they read the same on-disk CCZ
   read-only and differ only by `entry_path`, so there's no ordering
   dependency. Likewise, run the Learn and Deliver `validate`/`play`
   checks concurrently rather than one app fully before the other. Await
   all results, then branch on the worst verdict. (Each call is its own
   short-lived JVM; serial execution just adds ~8s/module of dead wall time.)

3. **Response shape (both modes):**

   ```
   { verdict: 'pass' | 'fail',
     exit_code: <int>,
     // play-mode only:
     failing_binding?: '/data/du_bednet_visit/deliver',
     unresolved_xpath?: 'instance(commcaresession)/session/data/case_id',
     // both modes:
     parser_message?: 'XPathTypeMismatchException: Calculation Error: …',
     failed_resource?: 'jr://resource/modules-0/forms-0.xml',  // validate only
     stdout: <truncated to 4KB>,
     stderr: <truncated to 4KB>,
     timed_out: <bool>,
     // present only on input errors:
     input_error?: 'jar_not_found' | 'ccz_not_found' | 'ccz_empty' | 'usage',
     input_error_path?: <path>,
   }
   ```

4. **Branch:**

   - **Both modes `verdict: 'pass'`** → record per-app `cli_validate: {validate: pass, play: pass}` and continue.
   - **`input_error: 'jar_not_found'`** (either mode) → emit `[WARN]` `cli-validator-unavailable` with the setup remediation below; continue. Structural Steps 3–4 still authoritative.
   - **`validate verdict: 'fail'`** → halt with `[BLOCKER]` `cli-validate-parser-error` naming `parser_message` + `failed_resource`. Don't bother running `play` — `validate` already proved the CCZ is structurally broken.
   - **`validate: pass` + `play: fail`** → halt with `[BLOCKER]` `cli-form-init-error` naming `failing_binding` + `unresolved_xpath` + `parser_message` (see § Failure modes for the bednet class + fix).
   - **`play verdict: 'skipped'`** → emit `[INFO]` naming `skip_reason`; **do NOT halt**. The form was never opened, so nothing about form-init was observed either way. Today the only reason is `empty-case-list`: the module's case list rendered zero rows, so the walk died in case-list rendering before form entry. `play` seeds one open case per case type declared in the CCZ's `suite.xml`, so this now only fires when a case-list **filter** excludes the generic seed (it carries `case_type` / `case_name` / `owner_id` and no other properties). Record `cli_validate.play: {verdict: skipped, skip_reason, seeded_case_types}` so the coverage gap is legible rather than silently reported as a pass.

   **Case seeding (dimagi-internal/ace#1088).** Every ACE Deliver app's
   payable form is a `followup` on a case type, and the restore used to
   seed zero cases — so `play` could not reach any of them and this gate
   had **never once** exercised `initAllTriggerables` on an ACE Deliver
   followup form, while reporting `fail` on clean builds. `play` now
   derives the case types from `suite.xml` and seeds one open case each,
   and derives the menu walk from the same file (a case datum inserts a
   case-list screen, and `detail-confirm` a confirmation screen, between
   the module and form choices). Nothing is sent after form entry —
   stray keystrokes are typed as *answers*, and a `0` on a date question
   raises `IllegalArgumentException: Invalid cast of data [0] to type
   Date`, which reads as a CCZ defect.

   **What seeding does not cover** — say so rather than implying the gate
   is now complete:
   - Case lists whose `<filter>` keys on a case **property**. The seed
     carries no properties, so such a list is still empty → `skipped`.
   - Case **search** / registry entries (`<query>` screens) and any datum
     screen other than a plain entity list.
   - `entry_path` where the form index is non-zero on a case-managed
     module: the walk assumes the caller's second index is the form, and
     a module with 2+ forms behind a case list has not been exercised.
     ACE calls this as `[0,0]`, `[1,0]`, … (one per module, form 0), which
     is the calibrated path.

**Operator one-time setup (only when `input_error: 'jar_not_found'` fires):**

```bash
/ace:setup
```

`/ace:setup` auto-downloads the latest tagged `commcare-cli.jar` from
`dimagi/commcare-core` releases and caches it at
`$CLAUDE_PLUGIN_DATA/commcare-cli.jar`. Refresh with `/ace:setup
--force-install`; pin a specific build with `export
ACE_COMMCARE_CLI_JAR=/absolute/path/to/commcare-cli.jar`. Java 17+
required. `/ace:doctor` reports jar presence + cached version.

### Step 5: Write verdict

Write `3-commcare/app-release-qa_result.yaml`. Shape:

```yaml
skill: app-release-qa
target: <opp>
run_id: <run-id>
ran_at: <ISO-8601>
schema_version: 1
verdict: pass | fail
overall_score: <number>  # 10.0 on pass, 0 on fail
per_app:
  learn:
    hq_app_id: <id>
    build_id: <id>
    form_count_blueprint: <int>
    form_count_ccz: <int>
    form_count_match: true | false
    learn_module_markers:
      blueprint_count: <int>
      ccz_count: <int>
      match: true | false
    assessment_markers:
      blueprint_count: <int>
      ccz_count: <int>
      match: true | false
    field_counts:
      - form_path: modules-0/forms-0.xml
        blueprint_count: <int>
        ccz_count: <int>
        match: true | false
      - ...
    cli_validate:
      validate:
        verdict: pass | fail | unavailable
        exit_code: <int>
        failed_resource: <descriptor when verdict=fail, optional>
        parser_message: <exception:msg when verdict=fail, optional>
      play:
        verdict: pass | fail | unavailable | skipped
        exit_code: <int>
        entry_path: [0, 0]
        failing_binding: </data/...> # when verdict=fail
        unresolved_xpath: <xpath>    # when verdict=fail
        parser_message: <exception:msg>
  deliver:
    hq_app_id: <id>
    build_id: <id>
    form_count_blueprint: <int>
    form_count_ccz: <int>
    form_count_match: true | false
    deliver_unit_markers:
      blueprint_count: <int>
      ccz_count: <int>
      match: true | false
    task_markers:
      blueprint_count: <int>
      ccz_count: <int>
      match: true | false
    field_counts: [...]
    cli_validate:
      validate:
        verdict: pass | fail | unavailable
        exit_code: <int>
        failed_resource: <optional>
        parser_message: <optional>
      play:
        verdict: pass | fail | unavailable | skipped
        exit_code: <int>
        entry_path: [0, 0]
        failing_binding: <optional>
        unresolved_xpath: <optional>
        parser_message: <optional>
# Per-app blocks additionally carry (both apps; see Step 4):
#   time_estimates:        pass | { modules_checked, violations: [...] }   # Learn app only
#   camera_only_uploads:   pass | not-required-by-pdd | [<offending upload refs>]
#   geopoint_binds:        pass | [<offending field paths>]
#   constraint_locality:   pass | { constraints_checked, violations: [...] }
#   relevance_reachability: pass | { checked, unreachable: [...], partial: [...] }
#   grid_menu_display:     { use_grid_menus, grid_form_menus,
#                            modules_checked, modules_gridded, non_grid: [...] }
#                          # all three fields are BLOCKER-gated (ace#1082)
auto_surfaced_concerns:
  - severity: BLOCKER | WARN | INFO
    message: "..."
blockers: [...]
```

Use `verdict: unavailable` when `commcare_validate_ccz` returned
`input_error: jar_not_found` (the operator hasn't built the jar yet).
Pair with a `[WARN]` `auto_surfaced_concerns` entry pointing at the
Step 4.5 setup block. Use `verdict: fail` only for real install-time
defects.

## Mode behavior

- Auto: write the verdict, halt on first BLOCKER.
- Review: same — this is a structural check with no human-judgment
  step.
- Dry-run: do the downloads + parses, write the verdict, but mark
  status as `dry-run-success` / `dry-run-blocked` instead of
  `pass` / `fail`.

## Failure modes

- `download-failed` — CCHQ returned non-zip bytes or an error. Likely
  a transient CCHQ issue or a wrong build_id. Operator action: verify
  the build_id in `app-release_summary.md` matches the released build.
- `cczunzip-failed` — zip decode failed. Likely a corrupted release.
  Re-run `app-release` to remake + re-release.
- `suite-xml-missing-or-malformed` / `xform-parse-failed` — Nova
  emitted invalid XML. Halt; re-run `pdd-to-{learn,deliver}-app`.
- `form-count-mismatch` — Nova said N forms, CCZ has M. Likely Nova
  partial-persistence on form creation. Re-run the build.
- `cli-validate-parser-error` — `commcare-cli.jar validate` (the
  parser-class pre-screen) surfaced an `XFormParseException` /
  `InvalidStructureException` / `InvalidResourceException` /
  `UnresolvedResourceException`. The CCZ is structurally broken at the
  XML / suite / profile level. Halt loud; root cause is upstream in
  `pdd-to-{learn,deliver}-app` (Nova emitted malformed XML). No need to
  also run `play` — the structural defect is authoritative.
- `cli-form-init-error` — `commcare-cli.jar play` surfaced an
  `XPathTypeMismatchException` / `Calculation Error` /
  `Logic references … which is not a valid question or value` during
  `FormDef.initAllTriggerables`: at least one form's XPath binding can't
  resolve at form-init. **This IS the bednet bug class** (see reference.md
  § Runtime install validation). Verdict YAML's
  `per_app.<app>.cli_validate.play.{failing_binding, unresolved_xpath,
  parser_message}` name the exact defect. The most common cause is a
  `connect.deliver_unit.entity_id` (or `entity_name`) bound to a
  runtime-unresolvable XPath. Halt loud; the operator's fix is usually a
  `pdd-to-{learn,deliver}-app` re-build flipping the
  entity_id substitution per
  `docs/learnings/2026-05-25-entity-id-misdiagnosis.md`.
- `cli-validator-unavailable` — `commcare-cli.jar` not on the operator's
  machine (resolved jar path returned `input_error: jar_not_found`). This
  is `[WARN]`, not `[BLOCKER]` — Steps 3–4 still gate structural defects;
  this just means the install-time gate is off. Operator fix: run
  `/ace:setup` (auto-downloads the latest jar from
  `dimagi/commcare-core` releases).
- `learn-module-time-estimate-implausible` — a
  `connect.learn_module.time_estimate` in the released Learn CCZ is not
  plausible **as hours** against the PDD's stated module duration (the
  unit is hours end-to-end in Connect; a raw minute count renders as
  "N hours" on every FLW's onboarding screen — see Step 4 +
  dimagi-internal/ace#1077 + voidcraft-labs/nova-plugin#36). Operator
  fix: re-run `pdd-to-learn-app` (its brief carries the resolved hours
  instruction with source citations), re-release, then re-run
  `app-release-qa`.
- `learn-marker-missing` / `deliver-marker-missing` — released CCZ
  doesn't carry the Connect-marker wrappers Connect's sync requires.
  Halt; investigate Nova-side OR check if any post-build patcher
  (which should be none — `commcare-form-patch` was removed in
  PR #423) is stripping markers.
- `field-count-mismatch` — silent field omission. Re-run the build
  (Nova partial-persistence is usually fixed on retry).
- `geopoint-bind-downgrade` — a `kind:geopoint` field compiled to an
  XForm bind `type="xsd:string"` instead of `type="geopoint"` in the
  released CCZ (stale / downgraded build; see reference.md § Geopoint
  bind-type fidelity). Operator fix: re-build & re-release the app from
  the **current** Nova blueprint (Nova compiles geopoint correctly
  today), then re-run `app-release-qa` to confirm `type="geopoint"`.
- `camera-only-appearance-missing` — the PDD demands live-camera-only
  photo capture but an image `<upload>` node in the released Deliver
  form XML has no `appearance` containing `acquire`, so the on-device
  widget shows CHOOSE IMAGE (gallery uploads permitted; see Step 4
  + dimagi-internal/ace#867). Operator fix: apply the camera-only
  appearance flip (HQ app builder or Nova), re-release, then re-run
  `app-release-qa` to confirm the attribute is in the released CCZ.
- `grid-menu-display-missing` — the released app's raw doc
  (`/a/<domain>/apps/source/<build_id>/`) fails any of the three grid
  fields: `use_grid_menus != true`, `grid_form_menus != 'some'`, or a
  module with `display_style != 'grid'` — so `app-hq-settings` either
  didn't run, fail-softed, ran a pre-ace#1082 version that only set the
  per-module half, or was applied to a draft that was superseded before
  the release (see Step 4 + dimagi-internal/ace#1009 + #1082). Operator
  fix: re-run `app-hq-settings`, re-release, then re-run
  `app-release-qa`. Do **not** try to confirm this from `suite.xml` or
  `GET /api/v0.5/application/` — neither carries `display_style`, and the
  REST API reads a misleading `None` for a correctly-gridded module.
- `non-local-constraint` — a `constraint` in the released form XML
  references a question or repeat the user cannot edit from the screen
  where it fires, so the error is unfixable in place and the FLW must
  navigate backward to a question that gave no sign of a problem (see
  Step 4 + dimagi-internal/ace#980). Operator fix: move the constraint
  onto the node it is actually about — a GPS-accuracy rule onto the
  geopoint itself, a repeat-cardinality rule onto the repeat or a gate
  immediately after it — then re-release and re-run `app-release-qa`.
  Only `severity: 'blocker'` violations halt; questions sharing an
  `appearance="field-list"` group are one screen and are not violations
  at all (ace#1019).
- `cross-screen-constraint` — `[WARN]`, not a halt. A `constraint` reaches
  into another screen, but it also references its own node, so the FLW
  clears it by changing the answer in front of them. Worth tightening
  (move the rule onto the screen that owns both numbers) but it does not
  trap anyone, so it never blocks a release.

## MCP tools used

- ace-connect: `commcare_download_ccz`, `commcare_validate_ccz`
- nova: `get_app` (form/marker counts), `get_form` (per-field `kind` for the geopoint bind-type check)
- ace-gdrive: `drive_read_file`, `drive_create_file`
- CCHQ HTTP probe (no atom yet): authenticated
  `GET /a/<domain>/apps/source/<build_id>/` for the grid menu-display
  check — the only surface that exposes `modules[].display_style` (see
  Step 4). A dedicated app-source atom on `ace-connect` would be the
  natural home (ace#1009 names it as an optional follow-up); until one
  exists this is a raw session-cookie GET.
