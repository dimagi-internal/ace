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

> **Archetype-conditional. Skip this entire section for `focus-group` —
> the focus-group archetype does not produce a Learn app.** Facilitator
> training for FGDs lives in the per-opp OCS chatbot + handbook gdoc +
> coordinator-graded practice-session audio review. See
> `docs/superpowers/specs/2026-05-15-focus-group-archetype-redefinition.md`.
>
> For `atomic-visit` and `multi-stage` (where a stage uses atomic-visit
> data collection), fill out the sub-sections below. Multi-stage PDDs
> with a focus-group stage skip this section for that stage only.

### Learning Objectives
- [What must the FLW be able to do after training? List by module.]

### FLW Work-Unit Structure
The unit of FLW work depends on the archetype:

- **`atomic-visit`** — one FLW visit produces one structured delivery.
  Fill in:
  - Visit frequency: [daily / weekly / monthly]
  - Expected visits per FLW: [number]
  - Duration per visit: [minutes]
- **`multi-stage`** — per-stage. Declare each stage's archetype and fill
  in that archetype's bullets in the stage's own subsection.

### Forms
| Form Name | Purpose | Key Fields |
|-----------|---------|------------|
| | | |

## Facilitation Protocol (`focus-group` archetype only)

> Use this section in place of "Learn App Specification" when archetype is `focus-group`.

### Training surface
- **OCS chatbot** (per-opp, Phase 5) — primary reference for facilitation craft + post-session writing guidance. Loaded with the FGD Guide + Output Specification + handbook gdoc via the chatbot's RAG content.
- **Facilitator handbook gdoc** — the LLO's prep doc; distributed out-of-band, referenced from the OCS chatbot's RAG content.
- **Practice-session audio review** — pre-fielding certification gate. Facilitator records a practice FGD, uploads audio, coordinator reviews and either passes (cleared for live fielding) or fails-with-notes.

### Facilitator profile
- Native fluency in working language: [yes/no]
- Prior community-work experience required: [yes/no; minimum years if yes]
- Facilitator-to-group ratio: [1 facilitator + 1 notetaker per group / other]

### Session logistics
- Session length target: [minutes]; hard cap: [minutes]
- Per-session payment (facilitator + notetaker): [USD-equivalent range]
- Training stipend on practice-session-pass: [USD-equivalent]
- Venue acceptable list: [neutral community space / school room / community hall / courtyard / other-with-justification]
- Venue disallow list: [health facilities / leader compounds / private homes of high-status families / other]

### Recording + consent
- Audio minimum duration: [minutes; default 45]
- Audio consent fallback: [if any participant declines, audio device OFF whole session — notetaker only / other]
- Photo policy: [attendance sheet only, NO participant faces by default / other]

## Deliver App Specification

> Section content branches on `Archetype:`. Skip sub-sections that don't apply.

### Services Delivered
- [What does each completed FLW work-unit produce? For **atomic-visit**: per-beneficiary form + verification artifact. For **focus-group**: one completed FGD session attested by a small CommCare form + a separately-submitted Google Doc with the qualitative content. For **multi-stage**: per-stage entry.]

### Workflow
- [Step-by-step from work-unit start to submission.]

### Case Management
The "case" depends on the archetype:

- **`atomic-visit`** — one case per beneficiary; lifecycle `create → update → close`.
  Fill in:
  - Case types: [list]
  - Case lifecycle: [create → update → close criteria]
- **`focus-group`** — one case per session; case-create only on the
  attestation form. **No case lifecycle beyond per-session attestation
  submission.** Reviewer verification happens out-of-band (via Connect
  FormRepeater observation feedback), not via a separate Deliver form.
  Fill in:
  - Case type: [e.g. `fgd_session`]
  - Note: NOT per-beneficiary. The Deliver app is the **payment trigger
    only** — all qualitative content (per-section themes, quotes,
    post-FGD report, reflection) lives in a **separately-submitted
    Google Doc**. The attestation form captures session metadata +
    artifacts (audio, photo, gdoc link). See `Output Specification
    (gdoc structure)` below for the gdoc shape.
- **`multi-stage`** — per-stage. Declare each stage's archetype and
  follow its case-management shape.

### Output Specification (gdoc structure, `focus-group` archetype only)

> Use this subsection when archetype is `focus-group`. The gdoc is the
> qualitative-content surface; CommCare captures only metadata +
> artifacts (audio file, attendance photo, gdoc link) via the
> per-session attestation form.

The facilitator's session gdoc should contain:

- **Per-section summary** (one block per FGD section): themes
  (3-6 bullets with specifics — named barriers, named options, named
  motivators); notable verbatim quotes (2-4, role-attributed: "mother"
  / "father" / "grandmother", NOT by name); level of consensus
  (strong agreement / mixed / strong disagreement, with one-line
  justification); time spent (minutes).
- **Post-FGD report**: top 5 things we heard; most-cited barriers (rough
  frequency order); per-program-option reactions (one block per option
  described in the PDD's Question Guide); surprises; facilitator
  recommendations.
- **Facilitator reflection**: 150–300 words on what surprised them,
  what fell flat, what to do differently next time.

The OCS chatbot for this opp is loaded with this Output Specification so
facilitators can ask it "what should I put in section 3?" during
write-up. The attestation form's `gdoc_link` field captures a link to
this gdoc; the gdoc lives in the LLO's or ACE's shared Drive, not in
CommCare.

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
