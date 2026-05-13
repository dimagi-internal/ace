---
name: app-connect-coverage
description: >
  Verify every form in a Nova-built Learn or Deliver app has the right
  CommCare Connect markers, auto-fix via Nova edits, loop until clean.
disable-model-invocation: true
---

# App Connect Coverage

Make every form in a Connect Learn or Deliver app expose the metadata
Connect's runtime needs to enumerate `LearnModule`, `Assessment`,
`DeliverUnit`, and `TaskUnit` records. Nova's autobuild can silently
skip these even when its system prompt knows about them, and a future
edit (e.g. adding a question, splitting a module) can drop them again.
Don't trust first-pass output — verify and fix in a loop.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 3 | `3-commcare/pdd-to-learn-app_summary.md` or `pdd-to-deliver-app_summary.md` | source `nova_app_id` |
| Nova MCP | `get_app({app_id: <nova_app_id>})` | live blueprint (form list, marker presence) |

## Products

- `3-commcare/app-connect-coverage_summary.md` — per-form marker coverage report and any Nova edits applied

## Why this skill exists

Connect's per-opportunity sync (verified 2026-04-29 against
`dimagi/commcare-connect:commcare_connect/opportunity/app_xml.py`) reads
form XML from the released CCZ and yields `DeliverUnit` /
`LearnModule` / `Assessment` records from elements in the
`http://commcareconnect.com/data/v1/learn` namespace:

```python
def extract_deliver_unit(xml):
    for block in xml.findall(f".//{XMLNS_PREFIX}deliver"):
        slug = block.get("id"); name = get_element_text(block, "name")
        yield DeliverUnit(slug, name)
```

That XML element comes from Nova's `connect.deliver_unit` block on the
form. If Nova didn't set it, the CCZ has no marker, Connect's sync
returns 200 / "Delivery unit sync completed." with **zero** units, and
the opp is stuck — `connect-opp-setup` finishes the create but the
wizard's payment-unit step has no deliver units to attach. That dead
end is **silent** without this skill.

This skill turns "did Nova set Connect markers correctly?" from a
silent Phase 4 mystery into a Phase 3 deterministic check.

## Scope

Per-form Connect-block coverage:

| App `Connect type` | Form pattern | Expected `connect` block |
|---|---|---|
| `learn` | content-only (labels, no inputs) | `learn_module: { name, description, time_estimate }` |
| `learn` | quiz-only (single/multi_select questions + `user_score` hidden) | `assessment: { user_score: "#form/user_score" }` |
| `learn` | content + quiz mixed | both `learn_module` and `assessment` |
| `deliver` | registration form | `deliver_unit: { name }` |
| `deliver` | label-only delivery / no case action | `task: { name, description }` |

Out of scope (separate sibling skills): multimedia attachments,
localization coverage, accessibility, app-summary completeness. Each
gets its own `app-<concern>-coverage` skill following the same
verify+fix pattern.

## Process

Inputs:
- `app_id` — Firestore Nova app id (from `app-summaries/{learn,deliver}-app-summary.md`)
- `pdd.md` — for context when heuristics are ambiguous

The skill targets ONE app at a time. Phase 3 runs it twice (once per
app). Each run is bounded by a max iteration count (default 3) to
prevent infinite Nova loops.

### Step 1: Read the blueprint

Call `get_app({app_id})`. Extract:
- `connect_type` ("learn", "deliver", or "none" — abort with a clear
  error if "none" but the PDD/skill caller expected a Connect app)
- Module list with form indices

### Step 2: Per-form expectation

For each form, decide the expected `connect` block deterministically
where possible, with one LLM-judgment fallback when the form is
ambiguous:

**Deliver app:**
- Form `type === "registration"` → expect `deliver_unit: { name: <form name> }`.
  If multiple registration forms, each gets its own deliver_unit (each
  is a distinct delivery action).
- Form `type === "survey"` with no inputs (only labels) →
  `task: { name, description }`.
- Otherwise → ask LLM judgment with the form's purpose + field types
  visible. Default to `deliver_unit` when in doubt; record the
  decision in the report.

**Learn app:**
- Form has zero `single_select` / `multi_select` / `text` inputs (only
  `label` and `hidden` kinds) → `learn_module` only.
- Form has a `user_score` hidden field AND select inputs → at minimum
  `assessment: { user_score: "#form/user_score" }`. If the form ALSO
  has substantial label content explaining concepts (ratio of label
  fields to question fields ≥ 1), include `learn_module` too. ACE's
  default PDD pattern uses Form 0 = content, Form 1 = quiz, so this
  rule rarely fires "both" but the heuristic is content-aware.
- Form name contains "Knowledge check", "Quiz", "Assessment", or
  "Test" → assessment.
- Otherwise → ask LLM judgment with the form's field structure.

### Step 3: Per-form verification

**Issue all per-form `get_form` reads in ONE parallel message** — they
target distinct moduleIndex/formIndex pairs, share no state, and a
typical Connect app has 4–12 forms across Learn + Deliver. Batched,
the reads complete in ~one round-trip; sequentially, ~7s × N forms
adds 30–80s per coverage pass with no benefit. Same shape as Step 4's
batched mutations.

For each form:
- Call `get_form({app_id, moduleIndex, formIndex})` (in the parallel block above)
- Compare actual `form.connect` to expected
- Classify:
  - `match` — actual matches expected
  - `missing` — actual has no `connect` block
  - `partial` — has some expected sub-blocks, missing others
  - `wrong` — has `connect` but with different sub-block (e.g.
    `task` where we expected `deliver_unit`)

### Step 4: Auto-fix (parallel dispatch)

For each `missing` / `partial` / `wrong` form, call
`update_form` with the expected `connect`
object. After EVERY mutation, re-fetch via `nova_get_form` to confirm
the change took effect (catches the "validator silently strips
fields" failure mode — see § Known Nova bugs below).

**Batch the mutations.** A typical Connect app has 5–12 forms across
both Learn and Deliver. Dispatch all `update_form` calls for a single
iteration in **one assistant message** (multiple tool-use blocks side
by side), then dispatch all the `get_form` re-fetches in one message.
Two batched roundtrips beat 24 sequential ones — saves 20–40 sec per
coverage pass and avoids token churn from interleaved tool results.
The mutations are independent (each targets a distinct moduleIndex/
formIndex pair); Nova does not require ordering.

### Step 5: Validate the app

Call `validate_app({app_id})`. This is Nova's
own platform-rule validator — it catches CommCare-side issues like
broken XPath, schema mismatches, missing required references.
Surface any errors directly.

### Step 6: Loop or exit

If Step 4 found nothing to fix AND Step 5 returned no errors, the app
is clean. Exit with success.

If Step 4 fixed things, go back to Step 2 (re-derive expectations
against the now-mutated app, in case our edits revealed new issues).

After max iterations (default 3), exit with failure listing the
remaining gaps. Don't loop forever — Nova bugs can prevent
convergence (see below).

### Step 7: Report

Write `ACE/<opp-name>/app-coverage/<app-type>-connect-coverage.md`:

```yaml
---
app_id: <nova app_id>
app_type: learn | deliver
connect_type: <from blueprint>
iterations: <N>
status: clean | blocked | partial
forms_total: <N>
forms_compliant: <N>
forms_fixed: <N>
forms_blocked: <N>
---

# Connect Coverage Report — <App Name>

## Summary
<one-paragraph: was the app already clean, did we fix it, did we hit a Nova bug>

## Per-form coverage

| m/f | Form name | Expected | Before | After | Action |
|---|---|---|---|---|---|
| 0/0 | New vendor visit | deliver_unit | missing | match | Fixed via update_form |
| ... |

## Validation result
<output of validate_app>

## Known-issue blockers
<if any forms remain blocked, list them with the upstream issue ref>
```

## Mode behavior

- **Auto:** verify, auto-fix, loop, exit clean or surface blockers.
- **Review:** same, but pause before Step 4 and present the
  expected-vs-actual diff for operator approval.

## Dry-run behavior

When `--dry-run` is active:
- Run Steps 1–3 (read-only verify).
- Skip Step 4 (no mutations).
- Write the would-fix list to `comms-log/dry-run-app-connect-coverage-<app-type>.md`.
- State tracks as `dry-run-success`.

## Failure modes

- **`connect_type === "none"` but PDD specified a Connect app.** Nova's
  autobuild fundamentally misclassified the app. This skill can't
  recover — re-run `pdd-to-{learn,deliver}-app` with a stronger
  Connect-type signal in the spec. Halt with clear error.
- **Nova bug — `update_form` re-injects empty `entity_id`/`entity_name`
  on `connect.deliver_unit`** even when the operator passes a clean
  payload of just `{name}`. Confirmed live 2026-04-29: the mutation
  ack's, but the re-fetch shows the empty entity fields back. The
  `name` change DOES take effect, but the malformed binding stays.
  When Step 4's re-fetch shows the entity fields still empty, exit
  `blocked` with a pointer to `voidcraft-labs/nova-plugin#1`.
  Don't retry — the bug isn't transient.
- **`validate_app` is blind to the deliver_unit bug.** Confirmed live
  2026-04-29: the Nova platform validator returns `{success: true}`
  for an app whose `connect.deliver_unit` has empty `entity_id`/
  `entity_name`. Don't rely on `validate_app` alone to catch coverage
  failures — Step 4's per-mutation re-fetch is the actual gate.
  `validate_app` is necessary but not sufficient. (See nova-plugin#1
  for the upstream tracker.)
- **Iteration budget exhausted (3+ rounds with no convergence).**
  Either the heuristic is wrong (we keep "fixing" something that
  Nova then resets) or there's an unknown Nova bug. Halt with the
  full per-iteration delta dumped to the report so the operator can
  diagnose.

## Reusable pattern

This is the first of a planned family of `app-<concern>-coverage`
skills. The shared shape:

1. **Bounded read-only verify pass** that derives expectations from
   the PDD and compares to the Nova blueprint.
2. **Per-item auto-fix** via Nova mutation tools, with a re-fetch
   gate after each fix.
3. **Platform validate** as the final coherence check.
4. **Bounded loop** with a max-iteration ceiling.
5. **Coverage report** in a uniform shape under
   `ACE/<opp-name>/app-coverage/`.
6. **Known-bug taxonomy** that distinguishes "we can fix this" from
   "upstream blocker" so the operator gets unambiguous direction.

Future siblings:
- `app-multimedia-coverage` — verify form labels referencing image
  resources have the resource files attached, fix by re-running Nova
  asset-generation or by uploading from PDD-referenced sources
- `app-localization-coverage` — for multi-language opps, verify each
  form has translations for every label
- `app-summary-coverage` — verify the human-readable
  `app-summaries/*.md` written to Drive matches the live blueprint
  (catches stale summaries after edits)

Each one stays single-concern and follows the same shape so the
verify+fix discipline is reliable across concerns.

## MCP tools used

- Google Drive: `drive_read_file`, `drive_create_file`
- Nova: `get_app`, `get_form`, `update_form`,
  `validate_app`

## Change log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-29 | Initial version. First in the post-Nova verify+fix family. Detection of Connect markers per form, auto-fix via `nova_update_form`, loop until clean or until a known Nova-side blocker is hit. Documents the pattern for future `app-<concern>-coverage` siblings. (0.10.7) | ACE team |
| 2026-04-29 | Smoke-tested live against `turmeric-market-survey-2026-04-29-coverage`. Skill exited `clean` in one iteration on the Learn side, `blocked` in one iteration on the Deliver side. Updates from the run: (a) bug description was inverted — Nova INJECTS empty `entity_id`/`entity_name`, doesn't strip them; (b) `nova_validate_app` returns `success: true` despite the malformed deliver_unit, so the per-mutation re-fetch in Step 4 is the actual gate (validate_app is necessary but not sufficient). Both findings folded back into Failure Modes. (0.10.12) | ACE team |
