---
name: app-connect-coverage
description: >
  Verify every form in a Nova-built Learn or Deliver app has the right
  CommCare Connect markers, auto-fix via Nova edits, loop until clean.
disable-model-invocation: false
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
| `learn` | quiz-only, **the gating post-test** (single/multi_select questions + `user_score` hidden) | `assessment: { user_score: { parts: [{ kind: "field-ref", uuid: <user_score field uuid> }] } }` |
| `learn` | quiz-only, **a baseline pre-test** (same shape, but NOT the gate) | `learn_module` only — **never `assessment`** (ace#1131) |
| `learn` | content + quiz mixed | both `learn_module` and `assessment` |
| `deliver` | registration form | `deliver_unit: { name, entity_id?, entity_name? }` — both expressions take the `{ parts: […] }` shape, never an XPath string |
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
- `Connect type` ("learn", "deliver", or absent — abort with a clear
  error if absent but the PDD/skill caller expected a Connect app)
- The **complete** module + form list, **with their uuids**

**Nova is uuid-addressed.** Since the 2026-07-31 migration (ace#1132)
no Nova tool accepts `moduleIndex` / `formIndex` / `fieldId`; every
addressed call takes `moduleUuid` / `formUuid` / `fieldUuid`, regex-checked
as canonical lowercase RFC UUIDs. `get_app` is the resolver — its
blueprint prints `[uuid <rfc-uuid>]` on every module, form, and field:

```
- Module "CBF Registration" [uuid b60055c1-…] (case_type: cbf)
  - Form "CBF Registration" [uuid c3deb000-…] (registration, 12 fields)
    [Connect enabled]
```

Build the `(module, form) -> {moduleUuid, formUuid}` map from this ONE
response and carry it through Steps 3 and 4. If `pdd-to-*-app_summary.md`
already carries a `nova_uuids:` block, prefer it and use `get_app` to
confirm it is still current. `search_blueprint({query, app_id})` resolves
a single semantic name if you're missing one.

**Capturing the COMPLETE form list here is load-bearing for Step 4** —
`configure_connect` clears the Connect block off any form you omit.

### Step 2: Per-form expectation

For each form, decide the expected `connect` block deterministically
where possible, with one LLM-judgment fallback when the form is
ambiguous:

**Deliver app — decide by ROLE, not by type.** Same rule the Learn
branch below states for the pre-test, and for the same reason: an unpaid
registration form has exactly the shape of a paid one.

1. **Read what the PDD declares payable** — § Deliver App Specification,
   plus the typed handoff
   `run_state.yaml…products.pdd.program_parameters.payable_stage`. Map
   each form to `payable` / `not-payable`. That mapping is your job; what
   it IMPLIES is `deliver-expectations.ts`, so call it rather than
   re-deriving:

   ```ts
   import { decideDeliverExpectations, classifyDeliverObservation }
     from './deliver-expectations';
   const decisions = decideDeliverExpectations(forms); // forms carry pddRole
   ```

2. A form the PDD marks **not payable** expects **no** `deliver_unit`,
   whatever its Nova type. An observed `deliver_unit` there is `extra` —
   a defect to **REMOVE**, never a match to preserve.
3. A form the PDD marks **payable** expects
   `deliver_unit: { name: <form name> }`, whatever its Nova type
   (`registration`, `followup`, `close`, `survey`). Multiple payable
   forms each get their own — each is a distinct delivery action.
4. **Only when the PDD is silent** does shape get a vote: label-only
   `survey` → `task: { name, description }`; `registration` →
   `deliver_unit`; otherwise LLM judgment from the form's purpose and
   fields, defaulting to `deliver_unit`. Every fallback sets
   `fellBack: true` and **must be recorded in the report** — a
   defaulted answer is not a known one.

**Why this is role-keyed (ace#1327).** On `bednet-check-2-visit` the PDD's
operating rule R2 is *"only the follow-up visit is paid; registration is
not"* — a requirement, taught in the Learn app and tested by an item in the
gating assessment. The registration form is therefore built with no
`deliver_unit` on purpose. Type-keyed, it classified `missing` and Step 4
would have **fixed** it: a deliver_unit on a form the programme says is
never payable, which Phase 4 can then wire a payment unit to, so the program
pays for the stage it explicitly does not pay for. And the repair runs
through `configure_connect`, which is **REPLACE-ALL** — a wrong expectation
rewrites the whole participant set. The mirror failure is quieter: the paid
form on that app is `type: close`, which no row covered, so it reached the
right answer by *defaulting* rather than by knowing.

**Learn app:**
- Form has zero `single_select` / `multi_select` / `text` inputs (only
  `label` and `hidden` kinds) → `learn_module` only.
- Form has a `user_score` hidden field AND select inputs → at minimum
  `assessment: { user_score: { parts: [{ kind: "field-ref", uuid:
  <the user_score field's uuid from the Step 1 map> }] } }` — **but ONLY if
  this form is the gating post-test.** A `user_score` + selects shape does NOT
  by itself mean the form is the gate: a **baseline pre-test has exactly the
  same shape** and must carry `learn_module` only. Decide by role, not by
  shape — the gate is the form the PDD's Deliver-unlock threshold refers to,
  normally the last assessment in module order. **EXACTLY ONE form per Learn
  app may carry `connect.assessment`** (`_app-component-library.md §
  assessment-gate`): Connect stores one `passing_score` per app and uses
  any-passed semantics, so a second marked form lets a worker be recorded
  `passed=True` off the ungated baseline bank (ace#1131). If you find a
  pre-test carrying `assessment`, that is a defect to **remove**, not coverage
  to preserve — this rule previously said "quiz-only → assessment" with no
  pre/post distinction, so a coverage pass would add it straight back.
  Expression
  sub-configs are structured since 2026-07-31 — an XPath string here is
  rejected, and comparing a string expectation against the structured
  value Nova returns misclassifies a correct form as `wrong`, which
  triggers a needless `configure_connect` and its replace-all footgun
  (Step 4a). If the form ALSO
  has substantial label content explaining concepts (ratio of label
  fields to question fields ≥ 1), include `learn_module` too. ACE's
  default PDD pattern uses Form 0 = content, Form 1 = quiz, so this
  rule rarely fires "both" but the heuristic is content-aware.
- Form name contains "Knowledge check", "Quiz", "Assessment", or
  "Test" → assessment.
- Otherwise → ask LLM judgment with the form's field structure.

### Step 3: Per-form verification

**Issue all per-form `get_form` reads in ONE parallel message** — they
target distinct `(moduleUuid, formUuid)` pairs, share no state, and a
typical Connect app has 4–12 forms across Learn + Deliver. Batched,
the reads complete in ~one round-trip; sequentially, ~7s × N forms
adds 30–80s per coverage pass with no benefit.

For each form:
- Call `get_form({app_id, moduleUuid, formUuid})` using the Step 1 map
  (in the parallel block above)
- Compare actual `form.connect` to expected
- Classify:
  - `match` — actual matches expected
  - `missing` — actual has no `connect` block
  - `partial` — has some expected sub-blocks, missing others
  - `wrong` — has `connect` but with different sub-block (e.g.
    `task` where we expected `deliver_unit`)

### Step 4: Auto-fix

Two tools, **opposite semantics**. Picking the wrong one is the single
most damaging mistake this skill can make, so branch explicitly:

| Situation | Tool |
|---|---|
| App-level Connect mode is absent/wrong, OR any form is `missing` (not currently participating), OR a form must stop participating | **`configure_connect`** — one atomic call carrying the COMPLETE participant set |
| A form that ALREADY participates has a `partial` / `wrong` sub-config (e.g. right `deliver_unit`, bad `entity_id`) | **`update_form({connect})`** — per-form, additive |

#### 4a. `configure_connect` — the whole-app path

> **⚠ REPLACE-ALL, not a patch.** Upstream's own words: *"learn/deliver
> requires the complete nonempty UUID-addressed participant set, and every
> unlisted form becomes auxiliary."* **Every form absent from
> `participants[]` has its existing Connect block CLEARED.** Calling this
> with only the forms you wanted to *fix* deletes the markers off all the
> forms that were already correct — turning a marker-repair into a
> marker-deletion, which is strictly worse than the gap you came to close.
> This is the exact inverse of `update_form({connect})`.

So the participant list must be **every form that should carry a Connect
block after this call** — the `match` forms included, not just the broken
ones. Build it from the Step 1 complete form list unioned with the Step 2
expectations:

```
configure_connect({
  app_id,
  mode: "learn" | "deliver",
  participants: [
    { formUuid: "<uuid>", connect: { learn_module: { name, description, time_estimate } } },
    { formUuid: "<uuid>", connect: { assessment: { user_score: { parts: [
        { kind: "field-ref", uuid: "<user_score field uuid>" } ] } } } },
    { formUuid: "<uuid>", connect: { deliver_unit: { name } } },
    …every other participating form…
  ]
})
```

Sub-config values that are expressions (`assessment.user_score`,
`deliver_unit.entity_id` / `entity_name`) take the **structured**
`{parts: [...]}` shape — a plain XPath string is rejected. Part kinds:
`text` · `field-ref` · `path-ref` · `case-ref` · `user-ref` ·
`user-property-ref`. Omit each block's `id` and let Nova derive it.
`learn_module.time_estimate` is in **hours** despite upstream's schema
saying minutes (nova-plugin#36).

`mode: null` turns Connect off and clears every form block — never call
that as a "reset" mid-repair.

#### 4b. `update_form` — the single-form refinement path

`update_form({app_id, moduleUuid, formUuid, connect})` refines a form
that already participates: omitted sub-configs keep their current value,
a stated one replaces it. It **cannot** enable Connect, switch mode, add
a participant, or clear the whole slot (a whole-slot null is refused).
Use it only for a genuine one-form additive tweak.

**Batch these when there are several.** Dispatch all `update_form` calls
for a single iteration in **one assistant message** (multiple tool-use
blocks side by side). They are independent — each targets a distinct
`(moduleUuid, formUuid)` pair — and Nova does not require ordering.

#### 4c. Re-fetch gate (both paths)

After EVERY mutation, re-fetch via `get_form({app_id, moduleUuid,
formUuid})` to confirm the change took effect. Batch the re-fetches in
one message.

**After a `configure_connect` call, re-fetch EVERY form, not just the
ones you changed** — that is the only way to catch an accidentally-cleared
participant. Any form that carried a Connect block before the call and
does not after it is a replace-all mistake: rebuild the full participant
list and re-issue.

Nova validates on write and **applies nothing on rejection** ("Nothing
was changed"), naming the exact problem — so a rejected call is safe to
read and retry against; there is no partial-apply state to defend
against.

### Step 5: Confirm save-time validation raised no errors

Nova's platform-rule validation (broken XPath, schema mismatches,
missing required references) runs **server-side at save time on every
mutation** — there is no callable `validate_app` tool at the L0/user
surface (jjackson/ace#821; still absent from the live 63-tool surface as
of 2026-07-31). Any Step 4 mutation that violated a platform rule failed
at the `configure_connect` / `update_form` call itself — surface those
errors directly. The per-mutation `get_form` re-fetch (Step 4c) remains
the structural gate that the intended change actually persisted.

### Step 6: Loop or exit

If Step 4 found nothing to fix AND no Step 4 mutation errored (Step
5), the app is clean. Exit with success.

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

| formUuid | Form name | Expected | Before | After | Action |
|---|---|---|---|---|---|
| c3deb000-… | New vendor visit | deliver_unit | missing | match | Fixed via configure_connect (full participant set) |
| 4452f12b-… | Follow-up | deliver_unit | partial | match | Fixed via update_form (entity_id only) |
| ... |

## Validation result
<save-time validation outcome: any mutation errors surfaced in Step 5,
or "no mutations issued / all mutations accepted at save time">

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

- **No app-level `Connect type` but the PDD specified a Connect app.**
  Recoverable in-place since 2026-07-31: `configure_connect({app_id,
  mode, participants})` sets the app-level mode and every form block
  atomically (Step 4a). Only halt and re-run
  `pdd-to-{learn,deliver}-app` if that call fails after 3 iterations, or
  if the app's module/form structure is itself wrong (a misclassified
  build, not a missing marker).
- **Partial `participants[]` cleared correct forms.** The
  `configure_connect` replace-all footgun (Step 4a). Symptom: the
  Step 4c re-fetch shows forms that were `match` before the call now
  `missing`. Recovery is another `configure_connect` with the COMPLETE
  set — the state is fully recoverable, but it costs an iteration, so
  build the full list before the first call.
- **`update_form` delivers empty `entity_id`/`entity_name` on re-fetch
  (defensive).** Fixed upstream (nova-plugin#6). If Step 4's re-fetch
  ever shows empty entity fields after a mutation, exit `blocked`.
  Don't retry — treat it as a regression.
- **Save-time validation misses malformed deliver_unit binds
  (defensive).** Don't rely on Nova's save-time platform validation
  alone to catch coverage failures — Step 4's per-mutation re-fetch is
  the actual gate.
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
- `app-language-conformance` — when the PDD names a working language,
  verify the app carries it as a **real CommCare language** (`get_languages`:
  English still `sourceLanguage`, the working language present, `out-of-date`
  = 0) rather than as stacked or parenthetical translations inside single
  labels, and that there is no in-app language-selector *question*. ACE
  builds a real per-language layer as of 2026-08-17 (PR #1463, superseding ace#968/#1391 — see
  `_app-component-library.md § app-language-layer`). **This check has
  inverted twice** — it required inline translations until 2026-08-14, then
  required English-only until 2026-08-17 — so implement it against the
  current component brief, not against memory
- `app-summary-coverage` — verify the human-readable
  `app-summaries/*.md` written to Drive matches the live blueprint
  (catches stale summaries after edits)

Each one stays single-concern and follows the same shape so the
verify+fix discipline is reliable across concerns.

## MCP tools used

- Google Drive: `drive_read_file`, `drive_create_file`
- Nova: `get_app` (blueprint + uuid map), `search_blueprint` (single-name
  uuid resolver), `get_form`, `configure_connect` (app mode + complete
  participant set), `update_form` (single-form additive refinement)

Signatures live in `docs/atom-schemas.md` and Nova's own `tools/list`;
`playbook/integrations/nova-integration.md § The 2026-07-31 uuid-addressing
migration` carries the division of labour and the replace-all warning.

## Change log

| Date | Change | Author |
|------|--------|--------|
| 2026-08-14 | **Step 2's Deliver branch is now role-keyed, not type-keyed (ace#1327).** It expected `deliver_unit` from `type === "registration"`, so a deliberately-unpaid registration form classified `missing` and Step 4 would have added a deliver_unit to a form the PDD says is never payable — via `configure_connect`, which is replace-all. It also had no row for a paid `close`-type form, which reached the right answer only by defaulting. Expectations now come from the PDD's payable-stage declaration; shape votes only when the PDD is silent, and every fallback is recorded. New verdict `extra` (a deliver_unit on an unpaid form is a defect to REMOVE) mirrors the Learn side's pre-test rule (ace#1131). Decision extracted to `deliver-expectations.ts` with a two-form fixture pair — paid/unpaid roles swapped — so the type-keyed reading cannot come back. | ACE team |
| 2026-08-11 | **Finished the 2026-07-31 expression migration in Step 2 (residual of ace#1132/#1133).** Step 4a's `configure_connect` example already emitted the structured `{parts: […]}` shape, but the Step 2 decision table and the Learn per-form rule still specified the `assessment` slot's `user_score` as the bare XPath string `#form/user_score`. The skill therefore computed a string *expectation*, compared it against the structured value Nova returns, and classified correct forms as `wrong`; the "fix" is then a `configure_connect` call, which is replace-all and can clear markers off every form omitted from `participants[]`. Same residual fixed in `pdd-to-deliver-app` for `entity_id`/`entity_name` (case-CREATE now shows `field-ref` parts, case-UPDATE `case-ref` parts, the optional per-form suffix a `text` part). Preventer added: `test/skills/nova-uuid-addressing.test.ts` now fails on any skill documenting `user_score`/`entity_id`/`entity_name` as a string — the pre-existing uuid lint only inspected spelled-out tool-call argument lists, so a shape stated in prose or a table was invisible to it. | ACE team |
| 2026-04-29 | Initial version. First in the post-Nova verify+fix family. Detection of Connect markers per form, auto-fix via `nova_update_form`, loop until clean or until a known Nova-side blocker is hit. Documents the pattern for future `app-<concern>-coverage` siblings. (0.10.7) | ACE team |
| 2026-04-29 | Smoke-tested live against `turmeric-market-survey-2026-04-29-coverage`. Skill exited `clean` in one iteration on the Learn side, `blocked` in one iteration on the Deliver side. Updates from the run: (a) bug description was inverted — Nova INJECTS empty `entity_id`/`entity_name`, doesn't strip them; (b) `nova_validate_app` returns `success: true` despite the malformed deliver_unit, so the per-mutation re-fetch in Step 4 is the actual gate (validate_app is necessary but not sufficient). Both findings folded back into Failure Modes. (0.10.12) | ACE team |
| 2026-07-31 | **Migrated to uuid addressing and split the fix path in two (ace#1132, ace#1133).** Nova's 2026-07-31 redeploy moved its whole surface from `moduleIndex`/`formIndex`/`fieldId` to `moduleUuid`/`formUuid`/`fieldUuid` — this skill's read/fix loop named uncallable operations. Step 1 now builds the `(module, form) -> uuid` map from the single `get_app` blueprint (which prints `[uuid …]` on every module/form/field) and captures the COMPLETE form list; Step 3's batched reads pass `{moduleUuid, formUuid}`. Step 4 is split because the two Connect tools have **inverted** semantics: `configure_connect` (new, replaces the removed `update_app({connect_type})`) sets app mode + every form block atomically but is **REPLACE-ALL** — any form omitted from `participants[]` has its Connect block CLEARED, so a partial list turns a marker-repair into a marker-deletion — while `update_form({connect})` stays per-form and additive and cannot enable Connect or add a participant. Added the matching re-fetch rule (after `configure_connect`, re-fetch EVERY form, not just the changed ones) and a `Partial participants[] cleared correct forms` failure mode. Expression sub-configs now take the structured `{parts: […]}` shape, not XPath strings. Contract pinned by `scripts/probe-nova-contract.ts`. | ACE team |
