# A household case CAN belong to two groups at once — two named child indices

**Date:** 2026-09-02
**Question owner:** Sophie Feintuch (PovGraduate framework), via thread `19f86579142e6ba5`
**Status:** ANSWERED — yes, proven end-to-end through the HQ build and install gate.

## The question

The PovGraduate framework commits to an optional group case above the household. Two of its
components need groups that hold different things — a VSLA group (savings-and-loan ledger) and a
business group (bank account, receives asset transfers). The design question was whether those
should be **one case type with a `group_kind` property** or **two case types**, and ACE's own
answer (2026-08-23) was that the deciding factor is not what each group holds but whether a
household can belong to **both at once**:

> "One case type with a type property keeps forms and lists shared, until a household holds both
> and 'which group' turns ambiguous. Two case types make the memberships unambiguous, at the cost
> of duplicating anything that works on either. Since you already suspect a household may hold
> both, pull that thread first."

ACE declined to guess at the time — "Case relationships are named, so more than one is
expressible in principle, but I have not built it and it is the platform's question to answer."
This is that throwaway build, per § "close the loop to the source of truth".

## The answer

**Yes.** A household case carries two simultaneous group memberships as two *named* child
indices, one per group case type. Nova expresses it, HQ builds it, and the resulting CCZ installs.

## Evidence chain

Every step observed, not inferred:

1. **Nova's blueprint accepts it.** `add_case_operations` takes `links` as an **array** per
   operation, each entry carrying its own `identifier`, `targetType`, `target` and
   `relationship` (`child` | `extension`). Three ops (create `vsla_group`, create
   `business_group`, create `household` with two links) were accepted without complaint.
2. **Nova's compiler emits standard CommCare multi-index XML:**
   ```xml
   <index>
     <vsla_membership     case_type="vsla_group"     relationship="child"/>
     <business_membership case_type="business_group" relationship="child"/>
   </index>
   ```
   with a bind wiring each index to its own group's `@case_id`.
3. **HQ accepted the upload and built it.** `make_build` returned version 1 with no errors — and
   HQ re-validates the app during the build, so a clean build is HQ's own verdict.
4. **The HQ-built CCZ installs and runs.** `commcare_validate_ccz --mode play` on the downloaded
   build: `verdict: pass`, `exit_code: 0`; the menu rendered and form entry initialised. (The
   trailing `NullPointerException ... "input" is null` is the CLI harness running out of stdin at
   "Press Return to proceed", not an app defect.)
5. **Both indices survived the HQ build** — re-extracted from `modules-0/forms-0.xml` inside the
   downloaded CCZ, not from Nova's output: one `<index>` block, two named children, both
   `relationship="child"`.

Throwaway artifacts (Nova app `e54ad294…`, HQ app `50ba82d6…` on `connect-ace-prod`) were both
soft-deleted after the run.

## Design implication

**Two case types is viable, and dual membership is not the reason to collapse them.** The
ambiguity ACE flagged — "which group" becoming undefined when a household holds both — does not
arise, because each membership is reached by its own *named* relationship
(`vsla_membership`, `business_membership`) rather than by a shared `parent` index. The cost ACE
named for two case types still stands (anything that must work on either group gets built twice),
but it is a cost, not a blocker.

## What this does NOT settle

Named precisely, because the platform question and the product question are different:

- **Connect-side navigation.** Whether a Connect case list can be entered from *either* parent, and
  whether "one list showing both kinds of group" works, is untested. That needs a deployed
  Connect opportunity and a device walk, not a CCZ.
- **Case-list configuration** against a two-parent case (`parent_select`, ancestor filters) was
  not exercised — the spike app carried no case list.
- **Submission-time persistence.** `play` proves the form *initialises*; it does not submit, so
  both indices persisting server-side after a real submission is inferred from the case XML being
  well-formed, not observed.

## A trap this run walked into

**A CCZ from Nova's `compile_app` is NOT install-validatable; validate the HQ-built one.** The
first `validate` attempt ran against `compile_app --format ccz` and failed with
`XPathSyntaxException: Couldn't understand the expression starting at this point: #form/question_...`
— the *starter field's* `vellum:nodeset="#form/question_1"`, a Vellum-internal reference HQ
rewrites when the app is saved through it. The parser aborts on the first error, so it never
reached the case block: that result was **inconclusive about the index structure, not negative**,
and reading it as a failure would have produced exactly the wrong answer to Sophie's question.
`app-release-qa` already validates the HQ-downloaded CCZ for this reason; a direct compile is a
wire format, not an installable app.
