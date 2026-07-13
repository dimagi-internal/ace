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
| Phase 1 | `1-design/idea-to-pdd.md` | Payable-visit rules — whether the PDD demands camera-only photo capture (the `appearance="acquire"` check in Step 4) |
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

**Learn-specific (only for the Learn app):**

- Each Nova form whose blueprint declares `connect.learn_module` MUST
  have a `<learn:module>` (namespaced) element in its XForm XML.
- Each Nova form whose blueprint declares `connect.assessment` MUST
  have a `<learn:assessment>` (namespaced) element in its XForm XML.
- Per nova-plugin#7 closure (2026-05-22): these wrappers are
  **required** for Connect's HQ→Connect sync to register learn
  modules. Their absence is a structural defect.

Mismatch → halt with `learn-marker-missing` (with the form path +
which marker is absent).

**Deliver-specific (only for the Deliver app):**

- Each Nova form whose blueprint declares `connect.deliver_unit` MUST
  have a `<learn:deliver>` (namespaced) element in its XForm XML.
- Each Nova form whose blueprint declares `connect.task` MUST have a
  `<learn:task>` (namespaced) element.

Mismatch → halt with `deliver-marker-missing` (with the form path +
which marker is absent).

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

## MCP tools used

- ace-connect: `commcare_download_ccz`, `commcare_validate_ccz`
- nova: `get_app` (form/marker counts), `get_form` (per-field `kind` for the geopoint bind-type check)
- ace-gdrive: `drive_read_file`, `drive_create_file`
