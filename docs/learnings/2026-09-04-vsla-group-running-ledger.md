# A group case CAN carry a running financial ledger — but the property reads as TEXT

**Date:** 2026-09-04
**Question owner:** Sophie Feintuch (PovGraduate framework), via thread `19f86579142e6ba5`
**Status:** ANSWERED — yes, proven through the HQ build and CommCare's install-time validator.
**Sibling:** [[2026-09-02-household-dual-group-membership]] — the same thread's other group-level
platform question, answered the same way.

## Why this exists

ACE told the framework's author, on 2026-08-23:

> "A group-level financial ledger is buildable: a group case carrying balances as case properties,
> households as child cases, updated visit over visit. Nothing blocks the running-balance pattern."

That was **reasoning, not evidence** — the same shape as two other claims on that thread that later
needed correcting. Component 7 (Savings / VSLA) is specified around a running ledger
("contributions, loans issued and repaid, fund balances, per-member share value, cycle share-out,
evolving state rather than a status property that flips"), so the claim is load-bearing for a
component that is still to be authored. This is the throwaway build that settles it.

## The answer

**Yes** — and the working pattern is a hidden `calculate` field with a `caseWrite`, not a case
operation. Verified generated XPath from the HQ-built CCZ:

```
<bind nodeset="/data/fund_balance_after" type="xsd:string"
      calculate="(if(instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id]/fund_balance = '', 0,
                    number(instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id]/fund_balance))
                  + /data/member_contribution) - /data/loan_disbursed"/>

<bind nodeset="/data/case/update/fund_balance" calculate="/data/fund_balance_after"
      relevant="count(/data/fund_balance_after) > 0"/>
```

It reads the selected group's current balance out of `casedb`, guards the first meeting's empty
value to 0, applies contributions and loans, and writes the result back to the same property.
That is a real running balance across visits.

## Two mechanics that are NOT guessable, and both bite

**1. A case property reads as TEXT. Arithmetic must coerce it.** Nova's `arith` expression refuses
a raw property read outright:

```
An expression in case operation "update_fund_balance" is not valid here:
arith requires numeric operands; left got 'text'.
```

That is a *helpful* failure — the alternative in raw XPath is a silent string concatenation, so a
balance of 100 plus a contribution of 50 becomes `"10050"`. Wrap the read in `number()`, and pair
it with an empty-to-zero guard because the first meeting has no prior balance to read.

**2. A running balance needs a FOLLOWUP form; a survey form cannot do it.** Both the `session`
operation target and any case-property reference are refused on a standalone form:

```
The session target is available only when the module selects one case before opening its forms.
A case-property or relationship expression requires a case selected before this form opens.
```

CommCare's own validator confirms the shape once it is right — the installed app tree shows the
followup form gating on case selection:

```
|- VSLA groups
|- |- Entry: Weekly VSLA meeting
      |Select: Case
      | Group |
```

## A declaration ordering trap

**A case property must be declared before anything can reference it, and `create_form` enforces
this where `add_fields` did not.** A label referencing `#vsla_group/fund_balance` was accepted by
`add_fields` on a *survey* form, then the identical reference was refused inside `create_form` for
a *followup* form:

```
Field "balance_carried_in" ... references a case property that doesn't exist on this case type:
Case type "vsla_group" has no property "fund_balance"
```

Coherent once seen (a survey form has no case context, so its case-ref is meaningless and
unchecked) but it means a survey form can carry a dangling case reference. The way out is that a
field's own `caseWrite` declares the property, so a single hidden field may both **declare** and
**self-reference** it — which is exactly what the working pattern above does.

Nova also validates that every case-list column points at a declared property, so ordering matters
there too: set the case type with a `case_name` column first, add the writer, then add the column.

## Evidence chain

1. Nova accepted the blueprint (followup form, hidden calculate + `caseWrite`).
2. HQ accepted the upload and `make_build` returned v1 clean — HQ re-validates during the build.
3. `commcare_validate_ccz --mode validate` on the **downloaded** build: `verdict: pass`,
   `exit_code: 0`, and the app tree renders the case-selection step.
4. The arithmetic above was re-extracted from `modules-0/forms-1.xml` **inside that CCZ**, not from
   Nova's compiler output.

Throwaway artifacts (Nova app `b3e846e5…`, HQ app `d0ff65c2…` on `connect-ace-prod`) both
soft-deleted after the run.

## What this does NOT settle

- **Submission-time persistence.** `validate` proves the app installs and parses; nothing submitted
  two successive meetings and read the balance back. The XPath is correct by inspection, and the
  read path (`casedb`) is CommCare's own, but the round trip is unobserved.
- **Concurrency.** Two workers recording meetings for the same group offline both compute from the
  balance they synced with, so the later submission overwrites rather than adds. That is inherent
  to last-write-wins case properties, not a Nova limitation, and it is a real design question for
  Component 7 — a ledger of transaction *rows* (one child case per transaction, summed for
  display) does not have it. Worth settling before the component is authored.
- **Per-member share value and cycle share-out**, which need per-member state rather than one
  group total.
- **The group-meeting deliver unit** — the other half of the 2026-08-23 claim — is untested here.
