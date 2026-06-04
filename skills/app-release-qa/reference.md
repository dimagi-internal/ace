# app-release-qa — reference

Extended rationale and incident history for `app-release-qa/SKILL.md`.
None of this is executable: the skill executes the Process steps,
decision branches, atom calls, and halt conditions in SKILL.md. This
file exists so that prose moved out of the skill (to keep the per-run
context small) is not lost.

## Naming + verdict-file history

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

## Geopoint bind-type fidelity — rationale + reproducer

Why the Step 4 geopoint bind-type check is a `[BLOCKER]`: a
`type="xsd:string"` bind for a geopoint field means the released build
is a stale / downgraded compilation. On device CommCare renders it as a
plain text box (no GPS Capture widget), the FLW can't capture a fix, and
the standard hidden `selected-at(<gps>, 0|1|3)` lat/lon/accuracy calcs
throw `Calculation Error … list with only 1 element` at runtime the
moment the field is non-empty. This passes every other gate —
`validate_app`, `make_build`, the structural counts, AND `commcare-cli
play` (the `selected-at` calcs are init-guarded `if(gps='','',…)`, so
they don't fire at form-init; the fault only surfaces at answer-time). It
is invisible without the explicit bind-type check.

Canonical incident: malaria-rdt run 20260602-1409 (jjackson/ace#686) —
released CCZ had `<bind nodeset=".../gps" type="xsd:string">` while a
fresh Nova compile of the same app yielded `type="geopoint"` (Nova not at
fault; the build was stale). This corrected the wrong #593 "GPS is
plain-text-by-design" note in the selector map + CHANGELOG.

## Runtime install validation (Step 4.5) — what each mode catches

Steps 3–4 are structural — they parse the CCZ + match counts against the
Nova blueprint, but never bind any XPath expression. That leaves a real
failure class uncovered: a CCZ whose XPath references resolve to nothing
at form-init time (e.g. a `connect.deliver_unit.entity_id` bound to a
`#case/<calculated-field>` on a case-create form, where the calculate
hasn't fired yet). On the device, CommCare rejects the CCZ with "A part
of your application is invalid." Static counts + parse don't catch this;
the runtime form-init path does.

`dimagi/commcare-core`'s `commcare-cli.jar` ships two subcommands used in
series — they cover different defect classes:

| Mode | Speed | What it catches | Verified against bednet Deliver CCZ |
|---|---|---|---|
| **`validate`** | ~2s | Parser-class (malformed XForm/suite/profile XML, missing namespaces, structurally broken CCZs) | PASSES — does not catch the runtime-binding class |
| **`play`** | ~5–10s | Runtime form-init defects: `XPathTypeMismatchException` from `FormDef.initAllTriggerables` → `Recalculate.eval` chain (this IS the bednet bug class) | FAILS with `failing_binding: /data/du_bednet_visit/deliver`, `unresolved_xpath: instance(commcaresession)/session/data/case_id` |

The `cli-form-init-error` class IS the bednet class. Reproducer:
`bednet-spot-check/20260525-1405` Phase 6 — Deliver app's
`connect.deliver_unit.entity_id: #case/case_name` substitution (from
since-reverted PR #445) passed every Phase 3 static gate AND
`commcare-cli validate` but failed `commcare-cli play` with
`XPathTypeMismatchException` from `FormDef.initAllTriggerables` — the
same XPath-binding failure CommCare's mobile runtime hits when it shows
"A part of your application is invalid." The fix usually lives in the
producing skill — see `docs/learnings/2026-05-25-entity-id-misdiagnosis.md`
for the canonical case and
`docs/learnings/2026-05-25-bednet-smoke-phase6-install-rejection.md`
§ Preventer 2.
