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

Renamed from `app-release-smoke` 2026-05-27 — "smoke" understated the
role. The skill is the structural QA partner for `app-release` (same
shape as `idea-to-pdd-qa` partners `idea-to-pdd`): it produces a
deterministic pass/fail verdict on the released artifact, gated on
multiple structural + runtime checks. No LLM-as-Judge; pure
verification. The `-qa` suffix matches the rest of ACE's producer/QA
pairing convention. Verdict file moved from
`app-release-smoke_verdict.yaml` to `app-release-qa_result.yaml`
matching the existing QA-skill artifact convention.

## Why this skill exists

A `validate_app` PASS at Nova-build time + a successful `make_build`
+ `release_build` at CCHQ-time is necessary but not sufficient — none
of those checks verify that the **released CCZ artifact** (the bytes
that Connect's HQ→Connect sync and the AVD's CommCare runtime
actually consume) carries the right structural markers. Three real
incident classes this would have caught:

1. **`commcare-form-patch` over-stripping (2026-05-22, malaria-rdt
   run 20260522-1002).** The form-patch skill was incorrectly stripping
   `<learn:assessment>` wrapper elements from the released Learn CCZ.
   Connect's HQ→Connect sync silently failed to register learn modules
   for the opp because the wrappers were gone. The bug shipped through
   Phase 4 with no symptom; only surfaced at Phase 6 when training-
   deck-build had nothing to anchor on. This skill catches the missing
   wrappers at Phase 3 § Step 2.8 — same release cycle, immediate halt.

2. **Nova partial-persistence bug 3 (silent field omissions).** Nova's
   `add_fields` occasionally persists only the first N of M requested
   fields. The Nova-side blueprint says "8 fields" but the released
   CCZ has 5. `validate_app` and `make_build` both pass because the
   form is structurally valid; the omission is silent. This skill
   compares form-by-form field counts (released CCZ vs. Nova
   blueprint) and halts on mismatch.

3. **CCHQ build-rejection swallowed (rare but observed).** The
   `release_build` call returns 200 but the CCZ is actually a stub
   (zero-byte forms, no suite.xml). The current `app-release` skill
   trusts the 200 response. This skill does a real download + zip-
   parse, so a stub release is structurally detectable.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 3 § Step 2 | `3-commcare/app-deploy_summary.md` | HQ app ids (Learn + Deliver) |
| Phase 3 § Step 2.7 | `3-commcare/app-release_summary.md` | Released build ids per app |
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
canonical signal is "Nova said 17, CCZ has 14" — that's the silent-
omission class from incident #2.

If the canonical field-count comparison is over-conservative (false
positives on auto-generated binds), the skill can WARN instead of
halt — but the operator should see the count in the verdict.

### Step 4.5: Runtime install validation via `commcare-cli.jar`

Steps 3–4 are **structural** — they parse the CCZ + match counts
against the Nova blueprint, but never bind any XPath expression.
That leaves a real failure class uncovered: a CCZ whose XPath
references resolve to nothing at form-init time (e.g. a
`connect.deliver_unit.entity_id` bound to a `#case/<calculated-field>`
on a case-create form, where the calculate hasn't fired yet). On the
device, CommCare rejects the CCZ with "A part of your application is
invalid." Static counts + parse don't catch this; the runtime form-init
path does.

`dimagi/commcare-core`'s `commcare-cli.jar` ships two subcommands; use
**both** in series — they cover different defect classes:

| Mode | Speed | What it catches | Verified against bednet Deliver CCZ |
|---|---|---|---|
| **`validate`** | ~2s | Parser-class (malformed XForm/suite/profile XML, missing namespaces, structurally broken CCZs) | PASSES — does not catch the runtime-binding class |
| **`play`** | ~5–10s | Runtime form-init defects: `XPathTypeMismatchException` from `FormDef.initAllTriggerables` → `Recalculate.eval` chain (this IS the bednet bug class) | FAILS with `failing_binding: /data/du_bednet_visit/deliver`, `unresolved_xpath: instance(commcaresession)/session/data/case_id` |

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
   `[1,0]`, …) to cover every form's `initAllTriggerables`.

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
   - **`validate: pass` + `play: fail`** → halt with `[BLOCKER]` `cli-form-init-error` naming `failing_binding` + `unresolved_xpath` + `parser_message`. This IS the bednet class — the most common cause is a `connect.deliver_unit.entity_id` (or `entity_name`) bound to a runtime-unresolvable XPath. The fix usually lives in the producing skill (see `docs/learnings/2026-05-25-entity-id-misdiagnosis.md` for the canonical case).

**Operator one-time setup (only when `input_error: 'jar_not_found'` fires):**

```bash
/ace:setup
```

That's it. `/ace:setup` auto-downloads the latest tagged `commcare-cli.jar`
asset from `dimagi/commcare-core`'s GitHub releases (picks up
`commcare_2.63.0` today, ~10MB) via `gh release download`, which
transparently handles draft→stable URL transitions. The jar is cached at
`$CLAUDE_PLUGIN_DATA/commcare-cli.jar`; a sidecar `.version` file records
which release the bytes came from so `/ace:doctor` can detect drift.

Refresh to the latest release at any time:
```bash
/ace:setup --force-install
```

Pin to a specific build (e.g. CI cache or a local debug jar):
```bash
export ACE_COMMCARE_CLI_JAR=/absolute/path/to/commcare-cli.jar
```

Java 17+ required (matches the existing AVD-tooling JDK requirement).
`/ace:doctor` reports `commcare_cli_jar` presence + cached version + a
`java -jar … help` freshness probe.

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
- `cli-form-init-error` — `commcare-cli.jar play` (the runtime form-init
  gate) surfaced an `XPathTypeMismatchException` / `Calculation Error` /
  `Logic references … which is not a valid question or value` during
  `FormDef.initAllTriggerables`. The CCZ parses fine but at least one
  form's XPath binding can't be resolved at form-init. **This IS the
  bednet bug class** — the canonical reproducer is a
  `connect.deliver_unit.entity_id` (or `entity_name`) bound to a
  runtime-unresolvable XPath like `#case/<calculated-field>` on a
  case-create form. Verdict YAML's `per_app.<app>.cli_validate.play.{failing_binding,
  unresolved_xpath, parser_message}` name the exact defect. Halt loud;
  the operator's fix is usually a `pdd-to-{learn,deliver}-app` re-build
  flipping the entity_id substitution per
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

## MCP tools used

- ace-connect: `commcare_download_ccz`, `commcare_validate_ccz`
- nova: `get_app`
- ace-gdrive: `drive_read_file`, `drive_create_file`

## Change log

| Date | Change | Author |
|------|--------|--------|
| 2026-05-22 | Initial version. Replaces the prior (reverted) "move app-screenshot-capture to Phase 3" attempt. AVD-free structural verification on released CCZ — would have caught the malaria-rdt 20260522-1002 form-patch over-stripping at Phase 3 instead of Phase 6, and catches Nova partial-persistence silent field omissions. Full AVD smoke (`app-screenshot-capture`) stays in Phase 6 where Connect state is available. | ACE team |
| 2026-05-25 | **Add Step 4.5 — runtime install validation via `commcare-cli.jar`.** Two-mode wrapper: `validate` (fast, ~2s, catches parser-class defects like malformed XForm XML) + `play` (slower, ~5-10s, catches form-init runtime XPath defects). Reproducer: `bednet-spot-check/20260525-1405` Phase 6 — Deliver app's `connect.deliver_unit.entity_id: #case/case_name` substitution (from since-reverted PR #445) passed every Phase 3 static gate AND `commcare-cli validate` but failed `commcare-cli play` with `XPathTypeMismatchException` from `FormDef.initAllTriggerables` — same XPath-binding failure CommCare's mobile runtime hits when it shows "A part of your application is invalid." Operator setup: `/ace:setup` auto-downloads the latest tagged `commcare-cli.jar` (picks up `commcare_2.63.0` today) via `gh release download`. `[BLOCKER]` on `cli-validate-parser-error` (structural defect) or `cli-form-init-error` (runtime-binding defect — IS the bednet class); `[WARN]` on `cli-validator-unavailable` (jar not downloaded — structural Steps 3–4 still authoritative). MCP atom `commcare_validate_ccz` accepts `ccz_path` (preferred, no base64 in context) or `ccz_base64` (legacy fallback). See `docs/learnings/2026-05-25-bednet-smoke-phase6-install-rejection.md` § Preventer 2. | ACE team |
