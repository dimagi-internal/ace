# Learning: Nova autobuild silently skips CommCare Connect markers; `deliver_unit` runtime injects invalid XPath; `add_fields` partial persistence

**Date**: 2026-04-29 (initial), updated 2026-04-30 with Bug 3 + Bug 1 mitigation confirmation
**Context**: turmeric-market-survey-2026-04-28 dogfood and turmeric-20260429-2330 follow-up. After Phase 3 Step 2 created the Connect opp, `Sync Deliver Units` returned `Delivery unit sync completed.` but `connect_list_deliver_units` came back empty. Root cause traced through Connect's source (`commcare_connect.opportunity.app_xml.get_deliver_units_for_app`) to the released CCZ's form XML lacking `<learn:deliver>` elements.
**Status**: Active — bugs 1, 2, and 3 are in `voidcraft-labs/nova-plugin` and need upstream fixes. ACE-side mitigations shipped in 0.10.5; Bug 1 mitigation **confirmed working** in 2026-04-30 turmeric-20260429-2330 run (explicit Connect language in autobuild brief → markers populated on first try with non-empty entity expressions).

## Problem

ACE's pipeline produces Connect opps that silently can't enumerate deliver units:

1. Phase 1: PDD declares the opp as `archetype: atomic-visit` with a Deliver app.
2. Phase 2: `pdd-to-deliver-app` runs `/nova:autobuild`, which produces a Nova blueprint with `Connect type: deliver` at the app level but **no `connect` block on any form** (no `deliver_unit`, no `task`).
3. Phase 2: `app-deploy` uploads to CCHQ. The upload succeeds — there's no validation rule on CCHQ that requires Connect markers.
4. Phase 2 Step 2.5: `app-release` makes a build + releases it. The build succeeds.
5. Phase 3 Step 2: `connect-opp-setup` creates the opp. The opp lands in `draft`. Connect's `Sync Deliver Units` runs against the released CCZ, finds zero `<learn:deliver>` elements, returns 200 / "Delivery unit sync completed.", populates zero deliver units.
6. The wizard's `Add Payment Unit` form needs at least one deliver unit checkbox; with none, the operator is stuck.

## Root cause

Connect's sync logic (verified by reading `commcare_connect/opportunity/app_xml.py` on dimagi/commcare-connect main):

```python
def get_deliver_units_for_app(deliver_app) -> list[DeliverUnit]:
    form_xmls = get_form_xml_for_app(deliver_app)  # downloads CCZ
    return list(itertools.chain.from_iterable(
        extract_deliver_units(form_xml) for form_xml in form_xmls
    ))

def extract_deliver_unit(xml):
    for block in xml.findall(f".//{XMLNS_PREFIX}deliver"):  # XMLNS = http://commcareconnect.com/data/v1/learn
        slug = block.get("id")
        name = get_element_text(block, "name")
        yield DeliverUnit(slug, name)
```

So Connect's contract is: each deliver-unit form's XML must contain
`<learn:deliver id="..."><learn:name>...</learn:name></learn:deliver>`.

That XML element comes from Nova's `connect.deliver_unit` block on the
form. Two Nova bugs prevent it from getting there:

### Bug 1: Autobuild *sometimes* skips the Connect markers (prompt-quality dependent)

Nova's `nova-architect-autonomous` prompt (the operating instructions
returned by `get_agent_prompt(mode="autonomous_build")`) contains an
explicit `## CommCare Connect` section:

> **Deliver apps** track service delivery for payment. Each Connect form gets
> `deliver_unit`, `task`, or both — they are independent sub-configs

In practice the agent **only follows this rule when the user spec
echoes it back** — i.e., the spec mentions `connect.deliver_unit`,
`connect.task`, or directly references CommCare Connect's per-form
rules. With a vague spec ("build a deliver app for vendor visits"),
the agent sets `Connect type: deliver` at the app level and forgets to
propagate to the form. With an explicit spec mentioning the rules,
the agent produces the full structure on first try with non-empty
`entity_id` / `entity_name` XPath expressions and a CCZ containing
the right namespaced markers.

**Updated reproducer (2026-04-29):**
- Vague spec → blueprint missing `connect` on every form, CCZ has zero
  `<learn:deliver>` markers
- Explicit spec ("This is a Connect Deliver app — every form needs the
  appropriate `connect.deliver_unit` block per CommCare Connect's
  rules") → blueprint has `connect.deliver_unit` AND `connect.task`
  AND non-empty entity expressions on first try, CCZ has both
  `<deliver>` and `<task>` elements in the right namespace, builds
  + releases cleanly.

So this is more "the prompt's CommCare Connect section is
under-weighted" than "autobuild ignores Connect entirely." A short
upstream fix probably looks like one of:
- Hard-code the connect-block setup as part of the autobuild
  completion contract whenever `Connect type` is `learn`/`deliver`
- Or strengthen the architect prompt's CommCare Connect section so
  it survives minimal specs.

**ACE-side mitigation:** the `pdd-to-deliver-app` and
`pdd-to-learn-app` skills should always include explicit Connect
language verbatim in their prompt to `/nova:autobuild`, even though
the architect prompt has it. Belt and suspenders. The
`app-connect-coverage` skill remains as the post-build catch-all for
the "vague spec slipped through" case — but with proper prompt
discipline upstream it should usually be a no-op.

### Bug 2: `update_form deliver_unit` schema only accepts `name`, runtime auto-fills broken `entity_id`/`entity_name`

Workaround for Bug 1 is to run `/nova:edit` and call `update_form` per
form to add the missing `connect.deliver_unit` block. But:

```
nova_update_form(connect={deliver_unit: {name: "Vendor visit"}})
  → form.connect.deliver_unit = {
      name: "Vendor visit",
      entity_id: "",
      entity_name: ""
    }
```

The runtime adds two extra fields with empty defaults. On the next
upload, CCHQ's build rejects with:

```
Validation Error:
  Problem with bind for /data/connect_deliver/deliver/entity_id
  contains invalid calculate expression []
  Bad node: org.javarosa.xpath.parser.ast.ASTNodeAbstractExpr
```

Passing `entity_id`/`entity_name` in the `update_form` call doesn't
work — the schema validator strips them (the published JSONSchema for
`deliver_unit` declares only `name`). Result: there's no path for ACE
to set non-empty values via the public Nova API.

Note: Bug 2 affects only `deliver_unit`. `learn_module` and
`assessment` ship clean — empty `learn_module: {name, description,
time_estimate}` doesn't have a hidden bind that breaks. Confirmed by
re-uploading the turmeric Learn app after `update_form` fixes — the
released CCZ has `<learn:module>` blocks in all 10 forms.

**Important scope note (added 2026-04-30):** Bug 2 is triggered by
`update_form` mutations adding `connect.deliver_unit` *post-hoc*.
Nova's `autobuild` path does NOT go through `update_form` for the
initial connect block — it emits the form with the connect block
inline at form-creation time, with non-empty entity expressions.
Confirmed in the 2026-04-30 turmeric-20260429-2330 run: the Deliver
build's self-report showed `connect.deliver_unit` populated with slug
`vendor_visit` and clean entity bindings on first try. Bug 2 only
bites when `app-connect-coverage` (the post-build safety net) issues
`update_form` to fix a missed marker. With Bug 1 properly mitigated
upstream — i.e., explicit Connect language in the autobuild brief,
which `pdd-to-{learn,deliver}-app` now does — coverage is rarely a
no-op and Bug 2 is rarely triggered.

### Bug 3: `add_fields` partial persistence on first call (added 2026-04-30)

Symptom: `add_fields` called with N items in `fields[]` sometimes
persists only the **first** item; the others are silently dropped.
Severity scales with N. Workaround: re-issue `add_fields` with the
remaining items (the call is idempotent on already-present field IDs).

**Reproducer 1 — turmeric-20260429-2330 Learn build, 2026-04-30:**

```
add_fields(form_id="form_assessment", fields=[<9 quiz questions>])
  → ack: success
get_form(form_id="form_assessment")
  → questions_count: 1   ← only consent_required persisted, 8 dropped
add_fields(form_id="form_assessment", fields=[<the same 9 questions>])
  → ack: success
get_form(form_id="form_assessment")
  → questions_count: 9   ← all persisted on second call
validate_app() → valid
```

**Reproducer 2 — turmeric-20260429-2330 Deliver build, 2026-04-30:**

Same symptom, more pronounced. Building a 19-field single form
required FIVE `add_fields` invocations:

```
add_fields(N=19) → questions_count: 1   (Q1 only)
add_fields(N=18 remaining) → questions_count: 8  (added Q2..Q8)
add_fields(N=11 remaining) → questions_count: 14 (added Q9..Q14)
add_fields(N=5 remaining)  → questions_count: 18 (added Q15..Q18)
add_fields(N=1 remaining)  → questions_count: 19 (added Q19)
validate_app() → valid
```

The progress is monotonic and `add_fields` is idempotent on already-
present fields, so the workaround is just "re-issue until
`questions_count` matches expected." But the architect agent has to
notice the mismatch via `validate_app` or `get_form`, which adds
2–4 round trips per affected form.

The Learn-build architect required only one re-issue (small array,
small drop). The Deliver-build architect was the worst-case — 4
re-issues for one form. Both are wasted wall-clock and produce
noisier traces than necessary; the smaller the chunks the architect
sends, the fewer re-issues — but small chunks waste even more wall-
clock. The right place to fix is upstream.

Suspected cause: `add_fields` is internally not atomic over the
incoming array — likely a race between insert and validate, where
only the first field commits before validation rejects subsequent
ones. Or a bound on a per-call serializer buffer that truncates
after the first record. Either way, it's not specced behavior and
the partial result is silent.

**ACE-side mitigation:** the `pdd-to-{learn,deliver}-app` skill
prompts to nova-architect now mention this oddity explicitly so the
architect issues `validate_app` or `get_form` immediately after each
`add_fields` and re-issues if the count is short. This is in the
"third-attempt" Learn-build prompt and in the Deliver-build prompt
(where the architect handled it cleanly). Net: one extra round trip
per affected form, no failed builds. Belt-and-suspenders only —
upstream fix obviates this entirely.

## Fix / Key takeaway

### ACE-side mitigation (shipped 0.10.5)

`app-release` now:
1. **Pre-flight (Step 3):** calls `nova_get_form` on every form, asserts
   `connect.deliver_unit`/`learn_module`/`assessment` is present per
   the form's purpose, and surfaces a clear "missing markers" error
   pointing to `/nova:edit` if not.
2. **Post-release CCZ verification (Step 6):** downloads the released
   CCZ, greps for `<learn:deliver>` / `<learn:module>` elements, and
   confirms the count matches the expected form count. Catches the
   case where the Nova blueprint has markers but the build emits XML
   without them (i.e., bug 2 propagating silently to a 200 build).

These don't *fix* the bug — they just turn it into a clear actionable
error rather than a silent Phase 3 dead-end.

### Upstream fixes needed in voidcraft-labs/nova-plugin

1. **Bug 1:** harden the autobuild flow to actually call `update_form`
   with `connect.deliver_unit` (or `learn_module`/`assessment`) on
   every form when `Connect type` is `deliver`/`learn`. Possibly add
   a post-build validator in Nova itself. (Workable mitigation: the
   ACE skills now include explicit Connect language in every brief,
   confirmed effective on 2026-04-30 turmeric-20260429-2330.)
2. **Bug 2:** either:
   - Omit empty `entity_id`/`entity_name` from the form bind generation
     (don't emit `/data/connect_deliver/deliver/entity_id` if the value
     is empty), OR
   - Expose `entity_id`/`entity_name` as input params on the public
     `update_form` `deliver_unit` schema, with sensible default
     expressions when not provided (e.g., `entity_id: uuid()`,
     `entity_name: case_name` or similar), OR
   - Auto-derive sensible defaults inside Nova at form-emit time,
     based on the form's case_type registration.
3. **Bug 3 (added 2026-04-30):** make `add_fields` atomic over the
   incoming `fields[]` array — either commit all fields or none.
   Surface a clear error if the array hits any internal limit, rather
   than silently truncating to the first element. If the underlying
   issue is per-field validation racing with insertion, queue the
   inserts and validate at the end of the call. ACE-side mitigation
   (re-issue until count matches) is workable but produces 2–5x the
   round trips of a clean call.

### Operational note

The Learn-app side of the pipeline works end-to-end as of 2026-04-29 —
once `update_form` was called per form to set `learn_module`/`assessment`,
the build, release, and CCZ-verification all succeeded. So the
pipeline architecture is sound; the bugs are isolated to the Deliver
side's `entity_id`/`entity_name` runtime injection.

## Sibling reference

- Connect's sync logic: `dimagi/commcare-connect:commcare_connect/opportunity/app_xml.py`
- Connect's namespace constant: `XMLNS = "http://commcareconnect.com/data/v1/learn"`
- ACE skill: `skills/app-release/SKILL.md` § Known Nova bugs
- Affected dogfood: `ACE/turmeric-market-survey-2026-04-28/`
