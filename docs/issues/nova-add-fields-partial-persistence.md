# Nova issue draft — `add_fields` silently persists only the first item of multi-item arrays

**Repo:** `voidcraft-labs/nova-plugin`
**Reporter:** ACE team (Dimagi)
**Severity:** Medium — silent partial commit; subsequent `validate_app` catches the resulting count mismatch, but architect has to notice and re-issue
**Affects:** every multi-field form build via `/nova:autobuild`
**Filed by ACE on:** 2026-04-30 (turmeric-20260429-2330 run)

## Summary

`mcp__plugin_nova_nova__add_fields` called with `fields=[<N items>]` (N ≥ 2) often persists only the **first** item; items 2..N are silently dropped. The MCP call ack's success. The dropped items are visible only by a follow-up `get_form` or `validate_app` (which then errors with a missing-fields message).

The workaround is for the calling agent to re-issue `add_fields` with the remaining fields. `add_fields` is idempotent on already-present field IDs, so the workaround converges — but each affected form burns 2–5 round trips that should have been one.

## Reproducer 1 — small array (Learn assessment quiz, 9 questions)

```
add_fields(form_id="form_assessment", fields=[<9 multiple-choice questions>])
  → response: {success: true}

get_form(form_id="form_assessment")
  → questions_count: 1   ← only the first question (`consent_required`) persisted

add_fields(form_id="form_assessment", fields=[<the same 9 questions>])
  → response: {success: true}

get_form(form_id="form_assessment")
  → questions_count: 9   ← now all persisted

validate_app() → {is_valid: true}
```

## Reproducer 2 — larger array (Deliver form, 19 questions)

Building a single 19-field form required FIVE `add_fields` invocations:

```
add_fields(N=19) → questions_count: 1   (Q1 only)
add_fields(N=18) → questions_count: 8   (Q2..Q8 added)
add_fields(N=11) → questions_count: 14  (Q9..Q14 added)
add_fields(N=5)  → questions_count: 18  (Q15..Q18 added)
add_fields(N=1)  → questions_count: 19  (Q19 added)
validate_app()   → {is_valid: true}
```

The progress is monotonic: each call adds at least one field but typically not all of the requested fields. The architect agent has no signal at the call site that anything went wrong — only the next `get_form` / `validate_app` reveals the mismatch.

## Steps to reproduce in your dev env

1. `create_app(name="repro", app_type="learn")`
2. `generate_schema(...)`, `generate_scaffold(...)`, `add_module(name="Quiz")`
3. `add_fields(form_id=<form>, fields=[<5 select1 questions>])`
4. `get_form(form_id=<form>)` — observe `questions_count: 1` (most likely)

This was 100% reproducible across both forms in our 2026-04-30 turmeric build.

## Hypothesized causes

We have no view into Nova internals; some plausible mechanisms:

1. **Per-field validation racing with batch insert.** The first field commits, the validator rejects subsequent fields against an already-stored "this form has N questions" invariant, and the array is truncated silently.
2. **Per-call serializer/buffer limit.** A serialization layer between MCP and the underlying app store that truncates the `fields[]` array after the first record.
3. **Atomicity bug in the storage layer.** The transaction commits only the first field; the remainder is held for a write that never happens.

## Proposed fix

Either:

- **Make `add_fields` atomic over the incoming `fields[]` array.** Either commit all fields or fail loudly with a clear error pointing at the offending element. No silent truncation.
- **Or: surface partial-commit explicitly.** Return `{success: true, persisted: [...field_ids...]}` so the caller can detect the truncation without a follow-up `get_form`.

If there's an internal per-call limit, document it in the tool description so callers can pre-chunk before invoking.

## ACE-side mitigation (already shipped)

ACE's `pdd-to-{learn,deliver}-app` skill prompts now include explicit guidance to the architect:

> After each `add_fields` call, immediately `validate_app` or `get_form`. If the persisted question count is short (Nova's known partial-persistence quirk), re-issue `add_fields` with the remaining items until counts match.

This produces clean builds at the cost of extra round trips. We'd love to retire this guidance once the upstream is fixed.

## Related Nova issues

- `voidcraft-labs/nova-plugin#1` — `update_form deliver_unit` schema only accepts `name`, runtime auto-fills broken `entity_id`/`entity_name`.
- `voidcraft-labs/nova-plugin#2` — `nova-architect-autonomous` occasionally returns from autobuild having taken zero or one bootstrap tool actions (early-stop). Often passes on retry.

This is filed as a sibling to those — distinct symptom, distinct root cause, but in the same family of "Nova mutation tools have silent failure modes that the architect has to compensate for."

## Evidence trail

- Build artifacts on Drive: `ACE/turmeric-20260429-2330/app-summaries/learn-app-summary.md` and `deliver-app-summary.md`
- ACE learnings doc with Bug 3 write-up: `docs/learnings/2026-04-29-nova-connect-marker-bugs.md` § Bug 3 (added 2026-04-30)
- Both reproducers above are taken verbatim from the turmeric-20260429-2330 nova-architect-autonomous transcripts.
