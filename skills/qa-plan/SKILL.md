---
name: qa-plan
description: >
  Generate a complete QA test plan for an ACE opportunity from its design
  documents alone — PDD, app summaries, deployment summary, connect/ocs state.
  Output is a per-form test matrix, per-module Maestro walkthrough recipes,
  a screenshot manifest, and an LLO-facing UAT checklist. Step 1 of Phase 5
  (qa-and-training); upstream of `app-screenshot-capture` and
  `training-materials`.
---

# QA Plan

Generate the complete per-opp QA test plan as a set of artifacts derivable
purely from the design docs. **No live AVD is required during this skill** —
the AVD only comes in at Step 2 (`app-screenshot-capture`), which executes
the recipes this skill produces.

## Why this skill exists

Before this skill, Phase 5's `app-screenshot-capture` had to compose
walkthrough recipes from app summaries on the fly, and `training-materials`
had to invent the test-case structure underlying its FLW guide and
quick-reference. Both worked but produced inconsistent coverage —
required-field-empty paths, conditional-skip-logic branches, and Layer-B
coherence checks were sometimes missed. `qa-plan` makes the test plan a
**first-class, auditable artifact** with explicit coverage of the PDD's
Evidence Model, then hands a complete manifest down to the walkthrough +
training steps.

It also surfaces the QA plan as an output the LLO can review (the
`uat-checklist.md`), giving them concrete acceptance criteria before they
sign off on go-live.

## Process

### Step 1: Read the design docs

Read all of the following from Drive:

1. `ACE/<opp>/pdd.md` — the canonical opp spec, including Evidence Model
   (Layer A, B, C tables) and form-question definitions
2. `ACE/<opp>/test-prompts.md` — the OCS deep-eval prompt set; useful as a
   sanity check on PDD fact pinning
3. `ACE/<opp>/app-summaries/learn-app-summary.md` — Learn-app module list,
   form structure, Connect-block coverage
4. `ACE/<opp>/app-summaries/deliver-app-summary.md` — Deliver form fields,
   conditional-skip rules, required flags
5. `ACE/<opp>/deployment-summary.md` — released-build HQ ids, project-space
   domain
6. `ACE/<opp>/state.yaml` — Connect opp id, OCS chatbot id + widget URL,
   ACE test-user phone, finalize parameters

### Step 2: Generate the test matrix

Compose `ACE/<opp>/qa-plan/test-matrix.md`. Structure:

```markdown
# QA Test Matrix — <opp-name>

## Coverage summary
Total test cases: <N>
- Layer-A (delivery proof): <N> cases
- Layer-B (content coherence): <N> cases
- Conditional logic: <N> cases
- Boundary values: <N> cases
- Edge cases: <N> cases

## Per-form test cases

### Deliver form: <form-name>

| ID | Type | Test case | Expected | Layer | Linked screenshot |
|----|------|-----------|----------|-------|-------------------|
| TC-D-001 | happy-path | Submit complete form with all required fields | accepted, payable | A | sc-deliver-happy-final |
| TC-D-002 | required-empty | Omit photo (Q3) | rejected, "Photo required" | A | sc-deliver-photo-empty |
| TC-D-003 | conditional | Q11 = "no" → Q12 hidden | Q12 not displayed | B | sc-deliver-q11-no |
| TC-D-004 | conditional | Q11 = "yes" → Q12 shown + required | Q12 displayed; submit blocks if empty | B | sc-deliver-q11-yes |
| TC-D-005 | boundary | price = 0 | accepted (no min in PDD) | B | — |
...

### Learn assessment

| ID | Type | Test case | Expected | Linked screenshot |
|----|------|-----------|----------|-------------------|
| TC-L-001 | happy-path | Score ≥ 80% on assessment | pass, Deliver app unlocked | sc-assessment-pass |
| TC-L-002 | boundary | Score = 79 | fail, retake offered | sc-assessment-fail |
...
```

Coverage rules — emit at least one test case for each:

- Every required field in the Deliver form (Layer A)
- Every conditional skip-logic branch (Layer B)
- Every Connect verification flag set in Phase 3 (e.g., GPS-fence, photo-required, duplicate-detection within 15m)
- The Learn-app assessment passing threshold
- Every adversarial test prompt in `test-prompts.md` that maps to an in-app behavior
- The PDD's Evidence Model § Layer-B coherence rules (e.g., Q14=matte but Q13=bright yellow-orange → noted)

Each test case has a stable `ID` (TC-{D|L}-NNN) used in the screenshot manifest.

### Step 3: Generate per-module walkthrough recipes

For each module in the Learn-app summary AND for the Deliver form, call:

```
mobile_generate_recipe_for_module({
  summary: <app-summary content>,
  moduleName: <module name>,
  appKind: 'learn' | 'deliver'
})
```

The MCP atom uses the built-in Anthropic LlmFn (loaded from
`ANTHROPIC_API_KEY` in `.env`) and returns a Maestro YAML body. **Plumb the
test-matrix entries into the prompt** so the generated recipe captures
screenshots aligned with the test cases — e.g., when the module's form
has a required-photo field, the recipe should include a `takeScreenshot:
"sc-<test-case-id>"` step matching the manifest entry.

Write each recipe to:

```
ACE/<opp>/qa-plan/walkthrough-recipes/{learn,deliver}/module-N.yaml
```

Plus a manifest:

```
ACE/<opp>/qa-plan/walkthrough-recipes/manifest.yaml
```

linking each recipe to its parent module + test cases.

### Step 4: Generate the screenshot manifest

Write `ACE/<opp>/qa-plan/screenshot-manifest.yaml`:

```yaml
opp: <opp-name>
generated_at: <ISO>
recipe_source: ACE/<opp>/qa-plan/walkthrough-recipes/manifest.yaml

screenshots:
  - id: sc-deliver-happy-final
    test_case: TC-D-001
    recipe: walkthrough-recipes/deliver/module-1.yaml
    step_name: "deliver-happy-final"
    purpose: "Submitted complete vendor visit form — final 'Submitted' confirmation"
    used_in: [training-deck, training-video, llo-manager-guide]
    layer: A
  - id: sc-deliver-photo-empty
    test_case: TC-D-002
    recipe: walkthrough-recipes/deliver/module-1-photo-empty.yaml
    step_name: "deliver-photo-empty-error"
    purpose: "Required-photo validation error toast"
    used_in: [training-deck, faq]
    layer: A
  ...
```

The `used_in` field is what `training-materials` reads to know which
screenshots embed where. Common Connect screenshots (sign-in, claim opp,
sync) are **NOT** in this manifest — they live in
`ACE/_common/connect-screenshots/<connect-version>/manifest.yaml` and are
captured once per Connect-app version by the standalone
`connect-baseline-screenshots` skill.

### Step 5: Generate the UAT checklist

Write `ACE/<opp>/qa-plan/uat-checklist.md` — the LLO-facing acceptance
criteria. Different audience than test-matrix.md (which is engineer-facing).
Structure:

```markdown
# UAT Checklist — <opp-name>

Use this checklist to confirm the opp is ready for FLW deployment. Run
through it on your AVD or device after receiving the onboarding email.

## Pre-deployment confirmations (your LLO admin team)
- [ ] Connect opportunity is active and accepting invites
- [ ] Payment unit is configured at <amount> per visit, <max-total> max
- [ ] FLW invites have been sent to your roster
- [ ] You have access to the OCS support widget at <widget-URL>

## Per-FLW spot-checks (a sample of 2-3 FLWs)
- [ ] FLW completes the Learn app and scores ≥80% on assessment
- [ ] FLW takes a valid photo (MTN card visible, top-down, daylight) and form is accepted
- [ ] FLW takes a non-compliant photo (no MTN card) and the system rejects it
- [ ] Q12 only shows when Q11 = "yes"
- [ ] GPS auto-captures and is required (declined deliveries don't pay)
- [ ] Per-FLW per-day cap of 20 visits enforces
- [ ] Per-FLW per-market cap of 5 visits enforces
- [ ] Vendor-education message script feels appropriate for the local context (LLO judgment call)

## End-of-day field-data review
- [ ] At least one FLW's Day-1 deliveries appear in CommCare HQ
- [ ] Photos render at full resolution and color-card is visible
- [ ] No duplicate flags above 2% rate
```

### Step 6: Self-evaluate (LLM-as-Judge)

Score the QA plan across these dimensions and write
`ACE/<opp>/verdicts/qa-plan.yaml` (uniform verdict shape — see
`skills/README.md § Eval verdict shape`):

| Dimension | Weight | Criteria |
|-----------|--------|----------|
| Coverage | 35% | Every Layer-A required field has ≥1 test case. Every conditional skip-logic branch has ≥1 test case. Every Connect verification flag has ≥1 corresponding test case. |
| Recipe runnability | 25% | Each generated walkthrough YAML has a valid navigation skeleton (post-login → claim-opp → enter-Learn → tap-module-N) wired to live selectors, not LLM-fabricated placeholders. |
| Manifest integrity | 20% | Every test case in test-matrix.md has a corresponding screenshot manifest entry (or explicit `screenshot: none` if N/A). Every recipe step that calls `takeScreenshot` has a matching manifest entry. |
| UAT checklist actionability | 10% | Each checkbox is a concrete physical action the LLO can perform; no vague "verify the system works" placeholders. |
| Evidence-Model fidelity | 10% | Test cases trace back to specific Layer-A / Layer-B rows in the PDD's Evidence Model table. |

Threshold: 7.0/10. Below threshold → halt with the score in the verdict and
escalate. The downstream skills (app-screenshot-capture, training-materials)
read this verdict to confirm the qa-plan was approved before consuming.

## MCP tools used

- **`ace-gdrive`:** `drive_read_file`, `drive_list_folder`,
  `drive_create_folder`, `drive_create_file`
- **`ace-mobile`:** `mobile_generate_recipe_for_module`

## Mode behavior

- **Auto:** generate every artifact, halt only on a `[BLOCKER]` verdict.
- **Review:** show the test-matrix preview before walkthrough-recipe
  generation; pause at the qa-plan verdict.
- **Dry-run:** generate the matrix + uat-checklist + screenshot-manifest as
  normal but skip the `mobile_generate_recipe_for_module` calls (the LLM
  burns tokens). Stub recipe paths in the manifest. State tracks as
  `dry-run-success`.

## Failure modes

- **Anthropic API key missing.** `mobile_generate_recipe_for_module` returns
  `AnthropicLlmConfigError` from `mcp/mobile/backends/anthropic-llm.ts`.
  Halt with the operator-facing message pointing at `.env` re-injection
  via `op inject`.
- **App summary lacks module structure.** If neither H3 nor table format
  parses any modules, the recipe generator returns no YAML. Halt and
  surface — the upstream `app-summary` was malformed and needs a fix in
  Phase 2 before Phase 5 can run.
- **PDD missing Evidence Model.** This skill cannot generate Layer-A /
  Layer-B test coverage without the Evidence Model table. Halt with a
  clear pointer to the missing section in pdd.md.

## Change log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-30 | Initial version. New first-class skill in Phase 5 (qa-and-training, formerly training-prep). Generates test matrix + walkthrough recipes + screenshot manifest + UAT checklist from design docs alone. Pre-condition for `app-screenshot-capture` and `training-materials`. Surfaced by turmeric-20260429-2330 e2e: prior Phase 5 inferred the QA plan implicitly inside each downstream skill, leading to inconsistent coverage. (0.10.44) | ACE team |
