# Program Design Document (PDD)

## Opportunity: [Name]
**Date:** [Date]
**Author:** [Name]
**Archetype:** [atomic-visit | focus-group | multi-stage]

> **Archetype guidance.** ACE skills branch on this field. Pick the closest single archetype, or `multi-stage` for PDDs that combine archetypes across stages (then declare each stage's archetype in its section header — see Stage examples below). The current supported archetypes are:
>
> - **`atomic-visit`** — one FLW visit produces one structured delivery (photo + GPS + form). Verification is automated. Examples: turmeric market survey, household-level data collection. **Default if unspecified.**
> - **`focus-group`** — one FLW-facilitated group session produces qualitative content (audio + per-domain summaries + attendance). Verification mixes automated session-level checks with AI-assisted content evaluation. Example: vaccine-hesitancy Stage 1.
> - **`multi-stage`** — combines two or more archetypes across sequenced stages, each with its own gate. Stage 1 may be `focus-group`, Stage 2 may be `atomic-visit`, etc. Example: full vaccine-hesitancy PDD.
>
> Adding a new archetype is a framework change — see `skills/README.md` (when it exists) or the `## Archetypes` section of any skill that branches on it.

---

## Problem Statement
[What health/development problem does this intervention address?]

## Intervention Design
[How does the intervention work? What is the mechanism of change?]

## Learn App Specification

> Section content branches on `Archetype:`. Skip sub-sections that don't apply.

### Learning Objectives
- [What must the FLW be able to do after training? List by module.]

### FLW Work-Unit Structure
The unit of FLW work depends on the archetype:

- **`atomic-visit`** — one FLW visit produces one structured delivery.
  Fill in:
  - Visit frequency: [daily / weekly / monthly]
  - Expected visits per FLW: [number]
  - Duration per visit: [minutes]
- **`focus-group`** — one FLW-facilitated group session is the unit.
  Fill in:
  - Session length: [target minutes; hard cap]
  - Sessions per facilitator: [number across pilot]
  - Post-session writing budget: [minutes per session to draft summary + report]
  - Submission window: [hours after session end; default 48]
- **`multi-stage`** — per-stage. Declare each stage's archetype and fill
  in that archetype's bullets in the stage's own subsection.

### Forms
| Form Name | Purpose | Key Fields |
|-----------|---------|------------|
| | | |

## Deliver App Specification

> Section content branches on `Archetype:`. Skip sub-sections that don't apply.

### Services Delivered
- [What does each completed FLW work-unit produce? For atomic-visit: per-beneficiary form + verification artifact. For focus-group: per-session summary + audio + attendance. For multi-stage: per-stage entry.]

### Workflow
- [Step-by-step from work-unit start to submission.]

### Case Management
The "case" depends on the archetype:

- **`atomic-visit`** — one case per beneficiary; lifecycle `create → update → close`.
  Fill in:
  - Case types: [list]
  - Case lifecycle: [create → update → close criteria]
- **`focus-group`** — one case per session; lifecycle
  `planned → in_progress → awaiting_summary → submitted → verified` (or `flagged`).
  Fill in:
  - Case type: [e.g. `fgd_session`]
  - Close criteria: [Layer A + Layer B verification both pass]
  - Note: NOT per-beneficiary. The Deliver app captures session
    metadata + facilitator reporting fields, not per-participant
    outcomes.
- **`multi-stage`** — per-stage. Declare each stage's archetype and
  follow its case-management shape.

## Target Population
- Beneficiary criteria: [who]
- Geographic scope: [where]
- Expected reach: [number of beneficiaries]

## FLW Requirements
- Number of FLWs: [number]
- Skills/qualifications: [list]
- Geographic distribution: [description]

## LLO Preference
- Preferred LLOs: [names, if known]
- LLO criteria: [what capabilities are needed]

## Solicitation
> Phase 7 (Solicitation Management) reads this section to publish a solicitation
> on labs.connect.dimagi.com that LLOs respond to. All fields below are optional
> — defaults apply if omitted, and the long-term flow (where ACE doesn't pre-name
> LLOs) leaves Preferred LLOs above empty so the solicitation goes to the public
> labs portal.
- Solicitation type: [EOI | RFP — default EOI]
- Response window: [number of days; default 14]
- Response template: [optional list of questions for responders; if empty, falls back to a default 6-question template covering experience, recruitment, timeline, supervision, language capacity, and budget]

## Success Metrics
| Metric | Target | Measurement Method |
|--------|--------|--------------------|
| | | |

## Evidence Model

> **What this section is for.** ACE downstream skills (`connect-opp-setup`, `app-test`, `flw-data-review`, `cycle-grade`) read this section to know what to verify, what to test for, what to analyze, and how to grade. The goal is **one place** where the PDD declares "what counts as a good delivery," using a consistent vocabulary across all archetypes.
>
> Three layers, increasing in cost and decreasing in automatability:
>
> - **Layer A — Delivery proof** (the thing happened). Automated, hard gates. Used by `connect-opp-setup` to set verification rules.
> - **Layer B — Content proof** (it was done properly). AI-assisted or structured human review. Used by `app-test` and `flw-data-review`.
> - **Layer C — Cross-delivery quality** (the data is useful). AI synthesis across deliveries. Used by `flw-data-review` and `cycle-grade`.
>
> Every PDD must fill in all three layers, even if Layer C is "not applicable, single-shot delivery." Worked examples for both `atomic-visit` and `focus-group` archetypes are in `docs/examples/pdd-stress-test-observations.md`.

| Layer | Purpose | Captured by | Verified by |
|---|---|---|---|
| **A — Delivery proof** | [What artifacts prove the delivery happened?] | [Form field, photo, audio, GPS, attendance, etc.] | [Automated check — what condition must hold?] |
| **B — Content proof** | [What artifacts prove the delivery was done properly?] | [Per-domain summary, photo content, form-field substance, etc.] | [AI-assisted check or structured human review — what's the rubric?] |
| **C — Cross-delivery quality** | [What patterns across deliveries indicate the dataset is useful?] | [Theme variance across segments, outlier detection, saturation, etc.] | [AI synthesis or analyst review — or "N/A — single delivery"] |

## Timeline
- Start date: [date]
- End date: [date]
- Key milestones:
  - [Milestone 1]: [date]
  - [Milestone 2]: [date]

## Budget
- Estimated cost: [amount]
- Payment structure: [per visit / per delivery / fixed]
