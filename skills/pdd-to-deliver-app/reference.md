# pdd-to-deliver-app — reference

Extended rationale, worked examples, and incident history for
`pdd-to-deliver-app/SKILL.md`. None of this is executable: the skill
executes the Process steps, decision rules, and verbatim `REQUIRED:`
blocks in SKILL.md. This file exists so that prose moved out of the
skill (to keep the per-run context small) is not lost.

## Marker mechanism

The `connect.deliver_unit` marker is set at the MODULE level via
`module_type` — not a nested `connect:{}` object and not a form field.
Do NOT instruct the architect to pass a `connect: {deliver_unit: {...}}`
object — `add_module` throws an opaque `"Unknown error"` and
`update_form` type-rejects it, and an architect that takes that path
ships a marker-less Deliver app (Connect surfaces no deliver unit →
Phase 4 cannot create a payment unit).

This mirrors the Learn marker mechanism
(`module_type: "connect.learn_module"` + `form_type:
"connect.assessment"`): an architect that gets Learn right first-try
gets Deliver right too once the brief names the mechanism. Verified live
on bednet-spot-check 20260601-1252; see jjackson/ace#660.

For the prompt-quality dependency that makes naming this load-bearing,
see `docs/learnings/2026-04-29-nova-connect-marker-bugs.md` § Bug 1.

## add_fields partial persistence

Nova's `add_fields` has a partial-persistence quirk: a single call with
N items often persists only the first few. The 19-field turmeric Deliver
form needed 5 `add_fields` calls to land all questions; mid-build
sessions where the architect skipped verification have shipped forms
that look complete in the build summary but render with missing
questions in the actual app.

For the full failure analysis, see
`docs/learnings/2026-04-29-nova-connect-marker-bugs.md` § Bug 3.

## entity_id business key

### Deployed-practice audit (why a business key, not the case id)

Grounded in deployed practice: across 6 real human-built Connect Deliver
apps (KMC, MBW; both atomic-create-payment and multi-visit), **0/6 use
the case id for `entity_id`** — all build a `concat(...)` business key
from form fields and persist it to a case property for downstream forms
to reuse. A single `/data/...` field path as `entity_id` is install-safe
(form fields resolve at `xforms-ready`) and `validate_app`-clean (it's a
real form reference) — the same shape the malaria-rdt run verified
end-to-end through `validate_app` + `make_build` + release +
`commcare-cli play`.

### Upstream (secondary)

Nova's `validate_app` reference oracle could be taught to recognize
`/data/case/@case_id` as a runtime-valid path (tracked at
[voidcraft-labs/nova-plugin#20](https://github.com/voidcraft-labs/nova-plugin/issues/20)),
but that's no longer load-bearing for ACE — `entity_id` should be a
business key regardless of whether the validator accepts the case id.

### History (why the case id was abandoned)

The prior rule prescribed `/data/case/@case_id` (case-create) /
`#case/case_id` (case-update) as a workaround for the Nova compiler
shape — see the reproducers `bednet-spot-check/20260525-1405`
(`#case/case_name`, failed on-device install) and `20260525-2022`
(`#case/case_id`, failed `commcare-cli.jar play`), and
`docs/learnings/2026-05-25-entity-id-misdiagnosis.md`. The 6-app audit
(jjackson/ace#586) showed the case id was the wrong target all along;
the fix is a business key, not a different case-id XPath.

## Step 4a safety net

Why we run the post-build field-count recipe even though `validate_app`
will catch some shortfalls downstream: `validate_app`'s
reference-integrity check only catches missing fields that ARE
referenced elsewhere. A `Post-Session Summary` form that's missing 1 of
7 section groups with no cross-reference between groups passes
`validate_app` cleanly and ships to the FLW silently incomplete. Step 4a
is the coverage-on-the-brief safety net `validate_app` is structurally
unable to provide.

The highest-risk surface is the FGD per-section summary form (~45-70
fields, 7 section groups); the partial-persistence class was first seen
on a sibling Learn-app build (jjackson/ace#303).

## Step 4d level-0 heal

Why this step lives in the skill (at level 0) and not in the architect
brief: these case-list-config atoms (`add_case_list_column` et al.) ARE
available to the level-0 Claude Code session that executes this skill,
even though they are absent from the autonomous architect's allowlist.
So the heal is a deterministic L0 operation: run it here, after the
autonomous build returns, rather than asking the architect to do
something its tools can't. (The upstream half — adding the
case-list-config family to the `nova:nova-architect-autonomous`
allowlist — is tracked separately and lives in the **external nova
plugin**, which is not editable from this repo. jjackson/ace#632.)
