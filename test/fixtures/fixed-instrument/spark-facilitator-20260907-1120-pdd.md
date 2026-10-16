# Spark Facilitator — Connect Pilot for FCAP Community Meeting Facilitation

**Archetype:** longitudinal-visits
**Opportunity:** spark-facilitator
**Run:** 20260907-1120
**Status:** Draft for review — Phase 1 output, not a partner-agreed document
**Prepared by:** ACE (Dimagi's AI Connect Engine), 7 September 2026
**Supersedes:** run 20260906-2233 (fresh run; design synthesized from `inputs/`, not inherited)
**Sources:** FCAP App & M&E structured extract (Enock Tusingwire's workbook, 2026-07-24) · Malawi Green FCAP CommCare app v1392 (.ccz, 2026-07-24) · FCAP Structure, Phases, and Activities (Spark, 2026-07-21) · FIYP Overview (Spark, 2026-07-21) · Spark MicroGrants Program Model Research Brief (ACE, 2026-07-13) · Spark Q&A — Enock's answers to ACE's 3 design questions (2026-07-24) · `open-questions.md` (opp-level ledger, all 21 open rows)

---

## Overview

This pilot puts a CommCare Connect payment layer under the work that Spark MicroGrants' Community Based Facilitators (CBFs) already do: facilitating weekly community meetings through the Facilitated Collective Action Process (FCAP). A CBF records each community meeting on a mobile form; Connect verifies the record against a partner-stated field predicate and pays per verified meeting. The pilot covers the FCAP Goal Setting subphase (steps 1–7, roughly three months) for a cohort of about 12 communities in Malawi, one CBF per community.

The design deliberately does **not** propose a payment rate. No source states what Spark pays CBFs today, and inventing a band would put a fabricated anchor into a contractual document. The rate is routed to the responding organisation, who must justify it against the workload this document quantifies.

---

## 1. Archetype

**`longitudinal-visits`.**

The entity followed over time is the **community** (village). It is visited repeatedly, in an ordered sequence, and it carries state between visits — which FCAP step it has reached, how many meetings it has held on that step, whether community-wide savings have started. The visits are not interchangeable: Step 2 (elections and bylaws) is a different piece of facilitation from Step 5 (savings).

Why not the alternatives:

- **Not `atomic-visit`.** Someone in this programme can ask *"is this community on track through Goal Setting?"* — a question `atomic-visit` cannot answer, because it has no entity to track. Its duplicate-detection question is purely cross-sectional and cannot express *a duplicate within this community's own step sequence*, which is exactly the payment rule this design needs.
- **Not `multi-stage`.** Communities move through FCAP steps **independently and asynchronously**, each on its own clock. `multi-stage` stages the *programme* on one clock with a management go/no-go gate between stages, and would build a separate Learn app, Deliver app and payment unit per stage. Here there is one app set and one payment unit for the whole pilot window, and the "gate" is data the meetings themselves write.

---

## 2. Problem Statement

Spark MicroGrants runs FCAP, a roughly two-year village-driven planning and microgrant process, through Community Based Facilitators drawn from the communities themselves. The FCAP Structure document describes 4 phases and 78 activities; Goal Setting alone is 7 steps over about 3 months of weekly meetings.

Three things are true at once in the source material:

1. **The facilitation work is the programme.** Community outcomes depend on whether meetings actually happen, whether attendance is broad, and whether people other than the loudest members speak. Spark's own indicator set measures exactly this — household attendance, female attendance, overall participation, female participation, and a "% communities in green" quality composite.
2. **The record already exists.** Spark's Malawi Green FCAP app (v1392) has a Village Monitoring Form completed by the CBF after every community meeting, capturing attendance, participation, savings and the FCAP activity covered.
3. **What the CBF is paid, and on what basis, is not documented anywhere in the source material.** ACE's own research brief lists CBF compensation as the first of six things it could not learn from public sources. Enock's Q&A confirms the CBF is the person to verify and compensate, but not what they currently receive.

So the problem this pilot addresses is narrow and concrete: **there is a well-defined unit of facilitation work, a well-defined record of it, and no mechanism that reliably converts one into a payment to the person who did it.** Connect supplies that mechanism. The pilot tests whether the conversion is trustworthy — whether a meeting recorded as conducted was conducted, whether the record is complete enough to pay on, and whether the resulting payment cadence matches how the work actually arrives.

**What this pilot is not.** It is not a change to FCAP, not an evaluation of FCAP, and not an intervention on communities. It is a payment and verification layer for facilitators. The four-arm FCAP randomised controlled trial described in ACE's research brief is a separate activity and this pilot is designed to stay clear of its instrument (see §5).

---

## 3. Intervention Design

### 3.1 The paid unit

One **verified community meeting** for one community at one FCAP step.

A meeting is verified when the CBF's Community Meeting Record carries, in the raw field codes reused verbatim from Spark's own instrument:

```
meeting_conducted   = yes
meeting_type        = community_meeting
```

This predicate is partner-stated. Enock Tusingwire named it directly in his 2026-07-24 answers ("A meeting is confirmed to have happened when, in the Village Monitoring Form: `meeting_conducted` = Yes AND `meeting_type` = Community meeting"). ACE re-verified both fields exist and are required in the shipped app — `modules-0/forms-4.xml` lines 146 and 150.

> **Note on codes.** Enock's answer quoted the **display labels** ("Yes", "Community meeting"). The underlying option values in the app are lowercase snake_case: `yes` and `community_meeting`. The pilot uses the raw codes, so a later reconciliation against Spark's own submissions is a join rather than a re-mapping.

A **committee meeting** is not a payable unit. This is the single most counter-intuitive rule in the design — a committee meeting is real work — and it comes straight from the partner's own verification predicate.

### 3.2 What makes the design longitudinal

Payability depends on the community's history, not only on the current form:

- A community's meetings are attributed to the **FCAP step** they cover.
- Up to **3 meetings per community per FCAP step** are payable. Steps routinely take more than one meeting — weekly cadence over roughly 13 weeks against 7 steps averages about 1.9 meetings per step — so a one-per-step rule would leave genuine continuation facilitation unpaid.
- Beyond 3, a meeting is **recorded but not payable**.

> **Requirement, not mechanism.** The requirement is: *a community's 4th and later meetings on the same FCAP step are recorded in full but earn nothing.*
> *Mechanism (advisory):* the payment business key is `concat(<community case id>, '-', <pilot_fcap_step>, '-', min(<step_meeting_index>, 3))`, so a 4th meeting produces a key that Connect has already paid and collapses on Connect's own deduplication. Phase 3 may implement this differently; doing so is a normal build choice, not a deviation.

### 3.3 Reused vs net-new — the explicit split

Spark's v1392 app is authoritative ground truth and the pilot is designed around it rather than in ignorance of it.

| Element | Status | Evidence |
|---|---|---|
| Verification predicate (`meeting_conducted`, `meeting_type`) | **Reused verbatim**, raw codes and field paths | `forms-4.xml:146,150` |
| Attendance and participation fields | **Reused verbatim** (`hh_represented_at_the_meeting`, `male_attendance`, `female_attendance`, `male_participants`, `female_participants`) | `forms-4.xml` |
| Participation ≤ attendance constraints | **Reused verbatim** | `forms-4.xml` constraint on `male_participants`, `female_participants` |
| Savings block (`currently_saving` and its dependants) | **Reused, with one disclosed deviation** — see §5.3 | `forms-4.xml:221–228` |
| Community enrolment GPS | **Reused pattern** — mirrors Spark's Village Profile Form exactly | `forms-0.xml` geopoint bind |
| Per-meeting GPS | **NET-NEW** — Spark's Village Monitoring Form has zero geopoint binds | verified: `forms-4.xml` has 0 `type="geopoint"` |
| Household-count denominator | **NET-NEW** — captured at pilot enrolment; Spark's app does not retain a usable one (§5.2) | `forms-0.xml`, `forms-1.xml` |
| Per-step meeting counter | **NET-NEW** — needed for the payment key; Spark keeps no per-step counter | `forms-4.xml` case update block |
| Connect markers | **NET-NEW** — Spark's app has none at all | `grep -rl commcareconnect` over all 60 form XMLs returns 0 files |
| Learn app | **NET-NEW** — Spark's training content is out of scope (§4) | — |

**The pilot runs a parallel app; it does not instrument Spark's.** Spark's v1392 carries **zero** Connect markers, so adding them would be first instrumentation of an application a live four-arm RCT depends on. That is not ACE's call to make unilaterally. Reusing Spark's exact field paths and raw value codes keeps a future migration cheap either way, and whether Spark would prefer that end state is an open question (§15).

---

## 4. Learn App Specification

**Working language:** English source, with Chichewa (`nya`) and Tumbuka (`tum`). This matches the language set of Spark's own Malawi Green FCAP app and of the FIYP media library.

> The app carries labels, choices, hints and assessment items in Chichewa and Tumbuka on top of an always-complete English source. These translations are **ACE-authored and land marked `needs-review`**. Native-speaker review is a normal downstream obligation, exactly like review of the English copy — it is **not** claimed as complete at delivery.

**Runtime default:** English. Spark's own app opens in English (`profile.ccpr`: `<property key="cur_locale" value="en" force="false"/>`), so English-first matches what a CBF already using the Spark app expects. CommCare's runtime language switcher remains available.

**Scope discipline.** This Learn app teaches the **pilot's recording and payment rules**. It does not reproduce Spark's facilitation curriculum — Spark has invested in that separately (FIYP: 35 presenter-to-camera videos, 12 community videos, 280+ slides, a custom offline content player). Duplicating it would be both wasteful and presumptuous.

### 4.1 Modules

| # | Module | Purpose |
|---|---|---|
| 1 | The facilitator role in this pilot | What the pilot is, what it does and does not change about FCAP, who is paid and for what |
| 2 | Running an effective community meeting | Facilitation quality as it bears on data reliability — inclusive participation, ensuring quieter members speak, why attendance breadth matters |
| 3 | Recording the meeting | The Community Meeting Record screen by screen, in order |
| 4 | Counting attendance and participation | The counting rules, and why participation can never exceed attendance |
| 5 | Savings reporting | When the savings block applies (FCAP Step 5 onward) and why it is absent before then |
| 6 | Payment rules | What makes a meeting payable, the per-step cap, and what is recorded but unpaid |

Module 2 is the module whose quality most affects data reliability. Spark's FIYP library contains an interview/walkthrough titled *"Running an Effective Meeting"* filmed with a real CBF, which maps onto it directly; whether Spark can share those assets is an open question (§15), and the module is written to stand alone if not.

### 4.2 Assessment

- **Bank size: 12 items. Threshold: 80% (10 of 12).** One fixed bank.
- Items cover all six counter-intuitive payment rules (§8.2) plus the higher-consequence recording operations, giving weighted coverage comfortably above the 0.50 feasibility floor.
- **Retakes are unlimited against a fixed bank.** This is a known softening of the gate: a worker can in principle pass by memorising answers. Per-attempt item rotation is *expressible* in XForms and is **not** a platform impossibility — what is missing is an authoring primitive in ACE's build toolchain today. It is carried as an open question and a capability request, not designed around (§15).

> **Illustrative item — the required shape, not mandated content.** *"A CBF facilitates a committee meeting on Tuesday and a community meeting on Thursday, both for the same community and the same FCAP step. How many payable meetings has she recorded?"* → 1. Phase 3 authors the bank and may harden or discard this item.

---

## 5. Deliver App Specification

**Working language:** as §4. **Case type:** community.

Two forms: **Community Enrolment** (once per community) and **Community Meeting Record** (per meeting).

### 5.1 Community Enrolment

Registers the community case and captures the denominators the pilot's percentage metrics need.

| Field | Type | Constraint | Notes |
|---|---|---|---|
| `community_name` | text | required | |
| `district` | select | required | Set from the awarded organisation's response |
| `traditional_authority` | select | required | |
| `number_of_households` | integer | required, ≤ 400 | Constraint reused verbatim from Spark's Village Profile Form |
| `average_household_size` | decimal | required, 4–12 | Constraint reused verbatim from Spark's Village Profile Form |
| `cbf_name` | text | required | The owning CBF |
| `enrolment_gps` | geopoint + accuracy | required | Mirrors Spark's `gps_coordinates_of_the_community`; not net-new |
| `pilot_fcap_step` | integer | default 1 | Initialises the step pointer |
| `step_meeting_index` | integer | default 0 | Initialises the per-step counter |

**Unlike Spark's own form, the pilot writes `number_of_households` and `average_household_size` to the case.** Spark's Village Profile Form asks both as required, constrained fields and then discards them — see §5.2.

### 5.2 The household-denominator problem (verified, and load-bearing)

Spark's attendance and savings indicators are percentages of *"total # households in community"*. That denominator does not usably exist in the source app, for three compounding reasons, all verified in v1392:

1. **The Village Profile Form asks and discards it.** `number_of_households` (required, `constraint=". <= 400"`) and `average_household_size` (required, 4–12) are both asked — and neither appears in that form's `<case><update>` block.
2. **The case value is seeded to literal zero.** `forms-0.xml` carries `<bind nodeset="/data/hh_tt" calculate="0"/>` feeding `<bind nodeset="/data/case/update/hh_count_tt" calculate="/data/hh_tt" .../>`.
3. **`hh_count_tt` is a ratcheted count of *registered* households**, raised one at a time by the RCT Household Registration Form (`forms-1.xml`: `household_counter = hh_count_tt + 1`) — not the community's household count, and it reads **0** until RCT registration has run.

Consequence: at Goal Setting time, an attendance percentage computed against `hh_count_tt` is undefined or absurd. **The pilot capturing its own enrolment count is therefore the only figure that exists — not a workaround.**

### 5.3 Community Meeting Record — screen-by-screen flow

Every field below is answerable from what the CBF knows or has observed **at that point in the sequence**. No field is a function of a later screen's answer, and nothing is assigned and then recoded.

| Screen | Fields | Relevance / constraint |
|---|---|---|
| 1 | Select community (case list) | Only communities this CBF owns |
| 2 | `date_of_meeting`; `meeting_gps` + accuracy | GPS captured at the venue |
| 3 | `meeting_conducted` (`yes` / `no`) | required |
| 3a | `not_conducted_reason` | shown only when `meeting_conducted = no`; form then ends — recorded, not payable |
| 4 | `meeting_type` (`community_meeting` / `committee_meeting`) | required |
| 5 | `pilot_fcap_step` — pre-filled from the case, CBF confirms or advances | required |
| 6 | `hh_represented_at_the_meeting`, `male_attendance`, `female_attendance` | integers, required |
| 7 | `male_participants`, `female_participants` | required; `male_participants ≤ male_attendance`, `female_participants ≤ female_attendance` — reused verbatim from Spark |
| 8 | `male_leader_attendence`, `female_leader_attendence`, `partner_staff_attendance` | required |
| 9 | `currently_saving`; then `hh_saving`, `males_saving`, `females_saving`, `amt_savings` | **whole block shown only when `pilot_fcap_step ≥ 5`**; the four detail fields shown only when `currently_saving = 1` |
| 10 | `step_completed` (yes/no); `meeting_notes` (free text, ≤ 500 chars) | `step_completed = yes` advances the pointer and resets the per-step counter |

**Derived and written back to the case:** `Total_Attendance` (= male + female attendance), `Total_participation` (= male + female participants), `date_of_meeting`, `pilot_fcap_step`, `step_meeting_index`.

**Aggregate/qualifier agreement.** Every savings aggregate the pilot reports is computed **only over meetings where `currently_saving = 1`**; no savings figure is derived from an unfiltered count of meetings. Likewise participation rates are computed against `Total_Attendance`, never against attendance-eligible households.

### 5.4 The savings-block deviation (disclosed, not silent)

Spark's `currently_saving` bind is `required="true()"` with **no relevance condition** (`forms-4.xml:221`) — it is asked at every meeting, including Goal Setting steps 1–4, before community-wide savings are introduced at Step 5 (*"Initiative Pathway & Savings ... establish a community-wide savings system"*).

**The pilot gates the block on `pilot_fcap_step ≥ 5`.** A CBF should not be required to answer a question that cannot yet have a meaningful answer. This is a deliberate deviation from the source instrument and is disclosed rather than made quietly.

It also raises a question back to Spark's M&E: their *"% of Communities saving"* indicator may be biased downward by pre-Step-5 meetings that structurally cannot report savings. That is Spark's call, not ACE's (§15).

### 5.5 Location capture

Each meeting submits a location fix **with its accuracy value**. An on-screen advisory tells the CBF when the reading is poor and invites them to retry.

> Location is **captured and submitted for observability**, and readings worse than 50 m are flagged and down-weighted in review. It is **not** a payment gate, it is **not** part of the deduplication key, and nothing in the app or in Connect refuses a submission on the basis of it.

Per-meeting GPS is genuinely net-new for Spark — their Village Monitoring Form has no geopoint at all, while five other forms in the same app do (`forms-0`, `forms-1`, `forms-2`, `forms-10`, `forms-11`). Enrolment GPS mirrors their existing practice; the per-meeting fix does not. Whether it is acceptable to Spark and to communities meeting in public is an open question (§15), and the design keeps it out of the payment path precisely so that answering "no" costs nothing.

---

## 6. Entity Lifecycle

**Entity:** the community. **Case type:** community. **One case per community**, owned by one CBF (Malawi, Uganda and Ghana are 1 CBF per community; Rwanda is 2 — see §15).

| State | Meaning | What moves it |
|---|---|---|
| Enrolled | Community case exists; `pilot_fcap_step = 1` | Community Enrolment form |
| In step *N* | Working through FCAP step *N* (1 ≤ *N* ≤ 7) | Meeting records accumulate; `step_meeting_index` increments |
| Step *N* complete | `step_completed = yes` recorded | Pointer advances to *N*+1; counter resets to 0 |
| Pilot complete | Meetings recorded through FCAP Step 7 (Vision) | Closes the pilot window for that community |

### 6.1 State vocabulary — Spark's own step names, verbatim

A community's state in the pilot **is the FCAP step it is working on**. The seven values below are the community case's `pilot_fcap_step` and are the exact option set the Deliver app's step picker must offer. Labels are transcribed verbatim from Spark's published *FCAP Structure, Phases, and Activities* guide — they are **not** ACE's words and must not be paraphrased in the build.

| `pilot_fcap_step` | Step name (verbatim) |
|---|---|
| 1 | Our Partnership |
| 2 | Community Dynamics, Governance & Leadership |
| 3 | Understanding the Present – Situational Analysis |
| 4 | Getting to the Future – Microgrant Pathway & Goals |
| 5 | Initiative Pathway & Savings |
| 6 | Advocacy Pathway |
| 7 | Vision |

The case-lifecycle table above and this vocabulary describe two different things and do not conflict: the table is the community case's **progression** (registered → working a step → step closed → pilot done), while this is the **state value** carried in `pilot_fcap_step` at any moment. Step 5 is the boundary the savings block keys on (§5.4); Step 7 closes the pilot window.

> Phase 3 reads the `entity_state_taxonomy` row in § 14 — not this prose — so the two are transcriptions of one another and must stay in step.

**Expected sequence and cadence:** weekly meetings advancing through steps 1–7 over roughly 3 months (Enock Q&A §1: weekly during the planning phase, monthly in other phases; FCAP Structure: Goal Setting ≈ 3 months).

**Payability against history:**
- The same FCAP step is payable up to **3** times per community.
- Beyond that, meetings are recorded but not payable.
- A meeting is payable **only from the CBF who owns the community case**.
- **Progression does not affect payment** (§7.3).

**Completion:** for pilot purposes a community completes at FCAP Step 7 (Vision), which closes the Goal Setting subphase. Full FCAP graduation is roughly 21.5 months away and out of window; the pilot does not model it.

---

## 7. Evidence Model

### 7.1 Layer A — automated, per submission

Applied to every Community Meeting Record:

1. **The verification predicate.** `meeting_conducted = yes` AND `meeting_type = community_meeting`. Partner-stated; anything else is recorded and not payable.
2. **Ownership.** The submitting CBF owns the community case.
3. **Longitudinal clause — the case facts the payment predicate reads.** Layer A reads the community case's `pilot_fcap_step` and `step_meeting_index`, not just the current form. The resulting deduplication key is `concat(<case id>, '-', <pilot_fcap_step>, '-', min(<step_meeting_index>, 3))`, which is what makes the 3-per-step cap real and what prevents the same meeting being filed twice.
4. **Internal consistency.** `male_participants ≤ male_attendance`, `female_participants ≤ female_attendance`, both enforced in-form as constraints reused from Spark's own instrument.
5. **Completeness.** All required fields for the relevant step present.

> Without clause 3 this archetype degrades silently into `atomic-visit` — the prose stays longitudinal while the payment predicate quietly becomes "any meeting counts." It is stated here explicitly for that reason.

Location is **not** a Layer A criterion. It is captured, submitted with accuracy, and used only in review.

### 7.2 Layer B — human review sample

A **Partner Trainer observes and reviews at least 20%** of recorded meetings, using the instrument Spark already has: the Facilitator Quality Monitoring Form and the Facilitator Monitoring Form (RCT) in menu2 of their own app, both completed by a Partner Trainer after visiting a community meeting.

Layer B checks what Layer A structurally cannot: whether a meeting recorded as conducted actually happened, and whether it was facilitated competently enough for the attendance and participation numbers to mean anything.

> **Caveat, stated plainly.** The 20% sample assumes Partner Trainer capacity that **no source quantifies**. Supervision ratios (Partner Trainer → CBFs, Field Officer → communities) are unmeasured in every source ACE has, and this is the one place that unknown becomes load-bearing. The 12-CBF cohort was sized to sit under any plausible ratio, which defers the question rather than answering it. It is binding at any scale beyond the pilot (§15).

### 7.3 Layer C — out of scope

Independent community-side verification (calling or visiting community members to confirm a meeting occurred) is **not** in scope for this pilot. It would need consent design and a contact roster that neither the source material nor the pilot produces.

### 7.4 Progression is monitored, not priced

On-time step progression is reported as a metric and does **not** affect payment. A community can stall for reasons a competent CBF does not control — season, a contested secret-ballot election (FCAP Step 2), a delayed microgrant tranche, or an external review turnaround (FCAP Step 13). Pricing progression would move programme risk onto the lowest-paid actor in the chain. Spark's own on-time-progression indicator is reported here (§8, P3) without being priced.

---

## 8. Success Metrics

### 8.1 Primary metrics

The primary metric is an **upstream proxy**, and is labelled as such honestly. The programme's goal is community self-determination and completed community-designed projects; the pilot window ends at FCAP Step 7, long before any project launches. What the pilot can measure is whether facilitation reliably happened and was reliably paid for.

| # | Metric | Definition | Target |
|---|---|---|---|
| P1 | Verified meeting rate | Payable meetings ÷ scheduled meetings across the cohort | ≥ 85% |
| P2 | Payment integrity | Payable meetings that Connect actually paid, first time, without manual intervention | ≥ 98% |
| P3 | On-time step progression | Communities reaching FCAP Step 7 within the pilot window ÷ enrolled communities | ≥ 75% (reported, not priced) |
| P4 | Layer B agreement | Reviewed meetings where the Partner Trainer's observation agrees the meeting occurred as recorded | ≥ 95% |

### 8.2 Secondary metrics (reused from Spark's own indicator set)

| # | Metric | Definition |
|---|---|---|
| S1 | Household attendance | Households represented ÷ households recorded at enrolment |
| S2 | Female attendance | Women attending ÷ total attending |
| S3 | Overall participation | People who spoke ÷ people who attended |
| S4 | Female participation | Women who spoke ÷ women who attended |
| S5 | Communities saving | Communities reporting `currently_saving = 1` ÷ communities at FCAP Step ≥ 5 |

S1–S4 are lifted verbatim from Spark's monitoring framework so the pilot's numbers are directly comparable with theirs. **S5 deliberately restricts the denominator to communities at Step 5 or later** — computing it over all communities, as the source framework does, mixes in meetings that structurally cannot report savings (§5.4).

### 8.3 Counter-intuitive rules the pilot must teach

These are the six rules a competent facilitator would not guess, and they drive the Learn assessment bank:

1. A committee meeting is real work and is **not** payable.
2. Participation can never exceed attendance.
3. Only 3 meetings per FCAP step are payable; the 4th is recorded and earns nothing.
4. Savings questions are absent before FCAP Step 5 — their absence is correct, not a bug.
5. A meeting that did **not** happen is still recorded (with a reason) and is not payable.
6. Payment is per verified meeting — not per hour, not per attendee, not per household.

---

## 9. Target Population

**Direct beneficiaries of the payment layer:** approximately **12 Community Based Facilitators**, one per community.

**Communities:** approximately **12**, in one Malawi district. The district, Traditional Authority and candidate communities are **not named in any source** and are set by the responding organisation, not by ACE.

**Community members reached:** not projected. The honest position is that the household count per community is *captured at enrolment* and cannot be projected beforehand — Spark's own instrument constrains it to ≤ 400 households with an average household size of 4–12, which bounds it but does not estimate it. ACE's research brief cites a public figure of roughly 64 participants at a typical weekly meeting; that is context, not a target, and is not used in any pilot metric.

---

## 10. FLW Requirements

**Who:** Community Based Facilitators. Enock confirmed directly that the CBF — not the Partner Trainer, Finance Officer, or GRM Focal Person — is the person to verify and compensate.

**Count:** ~12, one per community (Malawi is 1 CBF per community).

**Skills assumed:** CBFs are elected from their own communities and trained by Spark or its partner on the FCAP process. The pilot assumes **facilitation competence already exists** and trains only on recording and payment rules.

**Equipment — the go/no-go dependency.** Connect requires a smartphone and a PersonalID. **The source material points against assuming CBFs have either.** Spark's own FIYP programme provisions offline-first Samsung A9 tablets (~$150) with headphones and power banks, and distributes content *"via file share rather than download"* — a stack chosen because connectivity could not be assumed. This is the single largest go/no-go risk on the opportunity, and the solicitation requires the responding organisation to confirm smartphone and connectivity availability explicitly (§12, §15).

### 10.1 Workload and what is not paid

Per CBF across the ~3-month pilot window:

- **Expected payable meetings: ~13** (weekly cadence × ~13 weeks, one community per CBF).
- **Structural ceiling: 21** (7 steps × 3 payable per step). The cap therefore has generous headroom and binds only where a step genuinely overruns.
- **Rate of arrival: ~4.3 payable meetings per CBF per month** during Goal Setting.

**Work the pilot does not pay for.** Naming this is mandatory, because the payable unit is one meeting while the working day is not:

1. Travel to and from the community.
2. Meeting preparation and reviewing the step guide.
3. Mobilising attendance — notices and reminders, which the FCAP Structure document describes as part of the process from Step 1.
4. Committee meetings (`meeting_type = committee_meeting`).
5. The 4th and later meeting on the same FCAP step.
6. Follow-up with community members between meetings.
7. **Potential double entry** into Spark's own Village Monitoring Form, if the pilot record turns out to be *in addition to* rather than *instead of* it — at ~4.3 meetings per month, unpaid under a unit that pays once (§15).

**Effective earnings cannot be computed, and that is the finding, not an omission.** Two inputs are missing and neither is ACE's to invent: **no rate is proposed** (§10.2), and **no district is named**, so there is no local market floor to compare against. This is precisely why the solicitation requires the responding organisation to propose a rate *and justify it against the workload inventory above*. What can be stated is the structure: a CBF is paid for one event per week while the surrounding preparation, travel, mobilisation and follow-up are unpaid, so gross-per-payable-meeting materially overstates earnings per day of field time.

**The income cliff, stated but not priced.** Meeting cadence drops from weekly to monthly once Planning ends (Enock Q&A §1) — roughly a fourfold fall in monthly payable volume for a role that continues another ~16 months. Roughly 24 of a CBF's ~40 lifetime FCAP meetings fall in the first 5.5 months of 21.5. **The pilot ends inside Goal Setting and never reaches the cliff**, so it is disclosed here and not priced. Any extension past Planning must address it, whether by a phase-differentiated rate or a retainer (§15).

### 10.2 Payment rate

**No rate band is proposed.**

No source states what Spark pays CBFs today — volunteer, stipend, or per-activity — and ACE's own research brief lists it as the first thing it could not learn. Proposing a band would put a fabricated anchor into a document that becomes contractual. The responding organisation proposes a per-meeting rate **with written justification against §10.1**, and the awarded rate becomes the Connect payment unit amount at Phase 4 setup.

---

## 11. LLO Preference

**FOCCAD** is identified from the source material as Spark's Malawi Green FCAP delivery partner: the Partner Trainer Exit Form covers *"recovery of FOCCAD resources assigned to trainer"*, and the app carries a `foccad_activities` lookup table.

**FOCCAD is therefore a candidate to invite, not a selection.** No source states that FOCCAD would run this pilot, and Spark has not been asked. The solicitation is published to the labs marketplace and FOCCAD is named as a candidate alongside it.

---

## 12. Solicitation

- **Type:** EOI
- **Deadline:** 14 days from publication
- **Response template:** default

The rate is unproposed and the geography unset, so this solicitation gathers capability and a costed proposal rather than bidding a fixed scope. Responses must state:

1. **CBF smartphone and connectivity availability** — explicitly, per §10. This is a go/no-go input.
2. **District, Traditional Authority, and candidate communities** entering FCAP Goal Setting in the pilot window.
3. **A proposed per-meeting rate with written justification** against the workload and unpaid-work inventory in §10.1.
4. **Current CBF compensation arrangements**, if any.
5. **Partner Trainer capacity** available to support the Layer B review sample.

---

## 13. Timeline

| Stage | Duration |
|---|---|
| Solicitation open | 14 days |
| Award, onboarding, CBF training and Learn completion | ~2 weeks |
| Community enrolment | ~1 week |
| Pilot delivery window — FCAP Goal Setting, steps 1–7 | ~13 weeks (~3 months) |
| Review and closeout | ~2 weeks |
| **Total** | **~5 months** |

The delivery window is set by FCAP's own Goal Setting duration (~3 months per the FCAP Structure document), not by an ACE convenience choice.

---

## 14. Program Parameters

| Key | Value |
|---|---|
| `archetype` | `longitudinal-visits` |
| `learn_passing_score` | `80` |
| `assessment_items` | `12` |
| `payment_rate_min` | *not proposed — set by solicitation response* |
| `payment_rate_max` | *not proposed — set by solicitation response* |
| `payment_rate_currency` | `MWK` (or `USD` equivalent, per response) |
| `payment_rate_unit` | `verified community meeting` |
| `daily_cap_per_flw` | `2` |
| `total_cap_per_flw` | `21` |
| `flw_count_min` | `12` |
| `flw_count_max` | `12` |
| `expected_reach_min` | `12` (communities) |
| `expected_reach_max` | `12` (communities) |
| `expected_reach_households` | *captured at enrolment; not projected* |
| `entity_id_grain` | `concat(case_id, '-', pilot_fcap_step, '-', min(step_meeting_index, 3))` |
| `entity_state_taxonomy` | 1=Our Partnership (steps 1); 2=Community Dynamics, Governance & Leadership (steps 2); 3=Understanding the Present – Situational Analysis (steps 3); 4=Getting to the Future – Microgrant Pathway & Goals (steps 4); 5=Initiative Pathway & Savings (steps 5); 6=Advocacy Pathway (steps 6); 7=Vision (steps 7) [source: FCAP Structure, Phases, and Activities (Spark, shared 2026-07-21).pdf] |
| `cap_rationale` | 7 FCAP steps × 3 payable meetings per step = 21 structural maximum; ~13 expected at weekly cadence |
| `verification_predicate` | `meeting_conducted = yes AND meeting_type = community_meeting` |
| `working_language` | `en` (source), `nya`, `tum` |
| `app_runtime_default_language` | `en` |
| `verification_layers` | `A+B` |
| `layer_b_review_sample` | `≥ 20%` |
| `solicitation_type` | `EOI` |
| `solicitation_deadline_days` | `14` |

---

## 15. Open Questions

This section reconciles **every one of the 21 rows** in the opportunity's durable `open-questions.md` ledger. All 21 were read — the 7 passed inline at handoff plus the 14 that were not, read from the ledger directly. No row is carried forward unreconciled.

**Summary: 0 resolved · 18 carried forward · 3 contradictions.** Two contradictions were recorded by the prior run and have been **independently re-verified rather than inherited on faith**; one is **new to this run** and contradicts evidence the prior run recorded as verified.

### 15.1 Contradictions (loud)

**⚠ C1 — `fcap-step-numbering` — prior run's contradiction UPHELD, re-verified.**
The prior run recorded that the FCAP Structure PDF's header states 24 steps while its body carries 25 `Step N:` headings, with 19 used twice. **Re-verified and confirmed.** A naive line-anchored enumeration returns 24 and appears to refute it; the second Step 19 is preceded by a form-feed page break (`\f`) and is missed. A whitespace-tolerant count gives exactly 25 headings — numbers 1–24 each once, plus a second 19:
- `Step 19: Transition Timeline` (closing Phase 2)
- `Step 19: Needs, Pathways, Goal(s), and Vision` (opening Phase 3)

Their objectives differ, which argues they are distinct steps, but the document does not say. The pilot declares only steps 1–7 and does not renumber the arc. **No pilot payment is affected either way.** Owner: Spark.

**⚠ C2 — `household-count-denominator` — prior run's contradiction UPHELD, with one correction to its evidence.**
The mechanism and its consequence are exactly as the prior run recorded, and are re-verified in §5.2 above. **One correction:** the prior run quoted a single bind, `<bind nodeset="/data/case/update/hh_count_tt" calculate="0"/>`. That exact bind does not exist. The seeding happens through **two** binds — `<bind nodeset="/data/hh_tt" calculate="0"/>` feeding `<bind nodeset="/data/case/update/hh_count_tt" calculate="/data/hh_tt" relevant="count(/data/hh_tt) &gt; 0"/>`. The conclusion is unchanged: `hh_count_tt` is seeded to zero at registration and thereafter ratchets as a count of *registered* households. Owner: Spark / ACE.

**⚠ C3 — `phase-pointer-maintenance` — NEW contradiction, raised by this run.**
The ledger row states, as re-verified by run 20260906-2233, that *"m0f3 is the only writer of `phase`"*. **That is false.** Four forms write `/data/case/update/phase` in v1392:
- `modules-0/forms-0.xml:273` (Village Profile Form, via `Current_FCAP_Stage`)
- `modules-0/forms-3.xml:1277` (Village Profile Update Form)
- `modules-0/forms-5.xml:537` (Goal & Pathway Tracker)
- `modules-0/forms-8.xml:1773`

The **load-bearing half of the row is confirmed**: `forms-4.xml` (Village Monitoring) does not write `phase` — its `<case><update>` block contains only `Total_Attendance`, `Total_Participation`, `date_of_meeting`, `project_id` and `village`. So ACE's position is unchanged (the pilot maintains its own `pilot_fcap_step` and never writes Spark's `phase`). But the supporting claim was wrong, and phase ownership in Spark's app is **more distributed than recorded** — which matters if Spark ever asks ACE to instrument their own app, because four forms would need consideration, not one. Owner: Spark / ACE.

### 15.2 Carried forward (18)

| id | Blocking | Status this run |
|---|---|---|
| `cbf-smartphones-and-connectivity` | **Go/no-go** | Carried forward, **strengthened**. Re-read of the FIYP overview confirms Spark provisions Samsung A9 tablets, headphones and power banks, offline-first, *"provisioned via file share rather than download"* — a stack chosen because connectivity could not be assumed. Connect requires a smartphone and a PersonalID. The solicitation requires explicit confirmation. |
| `cbf-compensation-baseline` | Before Phase 8 | Carried forward. The largest unknown; no source addresses it. ACE continues to propose **no** rate band and routes the number to the response with required written justification, now judged against §10.1's workload inventory. |
| `pilot-district-and-communities` | Before Phase 4 | Carried forward. District, Traditional Authority and communities remain ACE projections; set by solicitation response. |
| `pilot-record-instead-of-or-in-addition` | Before Phase 6 | Carried forward. Only Spark can answer — the Village Monitoring Form feeds a live RCT and ACE cannot decide to displace it. Cost carried as unpaid-work row 7 in §10.1. |
| `supervision-ratios` | Before Phase 8 | Carried forward. Still unquantified by any source, and now explicitly load-bearing: §7.2's ≥20% Layer B sample assumes Partner Trainer capacity nobody has measured. |
| `per-step-payable-cap-value` | Before Phase 8 | Carried forward. Independently re-derived this run: ~13 expected meetings against 7 steps ≈ 1.9/step, so a cap of 3 has headroom and binds only on overrun. Still an ACE inference with no partner input. |
| `continuation-meeting-reduced-payment` | Before Phase 8 | Carried forward, unchanged. Past the 3-per-step cap real facilitation earns zero; a reduced continuation rate remains the better answer if Spark wants one. |
| `cross-phase-income-cliff` | Before Phase 8 | Carried forward. Re-derived from Enock Q&A §1 and FCAP durations. The pilot ends inside Goal Setting and never reaches the cliff, so it is stated (§10.1) and not priced. |
| `progression-affects-payment` | Post-pilot | Carried forward. Pilot position restated and reasoned in §7.4: monitoring-only. |
| `gps-capture-acceptability` | Before Phase 3 | Carried forward. Re-verified: five geopoint binds exist (`forms-0/1/2/10/11`), and `forms-4` has zero — so enrolment GPS is not net-new and only the per-meeting fix is. Acceptability and consent remain unanswered; the design keeps GPS out of the payment path so a "no" costs nothing. |
| `savings-block-relevance-deviation` | Before Phase 3 | Carried forward. Re-verified at `forms-4.xml:221` — `required="true()"`, no `relevant` attribute. The pilot gates on step ≥ 5 and discloses the deviation (§5.4). Spark's own indicator bias question remains open for them. |
| `lookup-table-provisioning` | Before Phase 3 | Carried forward. Re-verified: all 12 tables appear only as `jr://fixture/item-list:` itemset **references**; `unzip -l` shows no fixture data files in the CCZ. The pilot mints its own step codes 1–7 with labels read verbatim from the FCAP Structure PDF, and carries a reconciliation residual. |
| `household-count-denominator` | Before Phase 3 | See **C2** — contradiction upheld. |
| `fcap-step-numbering` | Before Phase 3 | See **C1** — contradiction upheld. |
| `phase-pointer-maintenance` | Before Phase 3 | See **C3** — new contradiction. |
| `connect-markers-in-sparks-own-app` | Before closeout | Carried forward. Re-verified independently: `grep -rl commcareconnect` across all 60 form XMLs returns **0 files**, as does a search for the legacy `learn:` prefix. Instrumenting Spark's app would be first instrumentation of a live RCT's instrument. |
| `fiyp-media-assets` | Before Phase 3 | Carried forward, not blocking. The specific ask is the *"Running an Effective Meeting"* interview/walkthrough for Learn Module 2 (§4.1). |
| `app-runtime-default-language` | Before Phase 6 | Carried forward as **Spark's call**, with ACE's position now evidenced: Spark's own app opens in English (`cur_locale = en`), so the pilot is English-first. Translations are ACE-authored and `needs-review`, not native-speaker reviewed. |
| `proposal-generator-boundary` | Before any Proposal Development extension | Carried forward. Non-blocking — the Goal Setting pilot window ends at Step 7. |
| `rwanda-two-cbf-attribution` | Before expansion | Carried forward. Two design elements assume 1:1 and both break at 2:1 — case ownership (§7.1 clause 2) and the `entity_id` grain, which would collapse two co-facilitators onto one payable key. Malawi, Uganda and Ghana are unaffected. |
| `assessment-item-rotation` | Non-blocking | Carried forward. Framing re-confirmed as correct: rotation is expressible in XForms and is **not** a platform impossibility — what is missing is an authoring primitive. A capability request to file, not a limitation to design around. Relevant because §4.2 allows unlimited retakes against a fixed 12-item bank. |

*(The table lists 21 rows; three of them point to §15.1 rather than restating the contradiction.)*

### 15.3 New questions raised by this run

| Question | Owner |
|---|---|
| Spark's `currently_saving` is asked at every meeting with no relevance condition. Does that bias Spark's own *"% of Communities saving"* indicator downward, by including pre-Step-5 meetings that structurally cannot report savings? | Spark M&E |
| Phase ownership in v1392 is distributed across four forms, not one (C3). If Spark ever wants Connect markers in their own app, which form is authoritative for phase movement? | Spark |

---

## 16. Stress Test Results

Self-evaluation against the 5-question rubric. Two or more non-`pass` grades would block approval.

### 1. Executability — **pass**

An organisation could start from this document without blocking clarifying questions on the *design*. The verification predicate is field-level and partner-stated (§3.1); the Deliver form is specified screen by screen with relevance conditions and constraints (§5.3); the Learn modules and assessment gate are enumerated (§4); the entity lifecycle and state transitions are explicit (§6).

**Answerability walk performed.** Each of the 10 screens in §5.3 was walked in order against what the CBF knows at that point. Every field is answerable in sequence: location and date precede the meeting-conducted question; meeting type and step precede the counts; participation follows attendance (and is constrained against it); the savings block is gated on a step pointer already established at screen 5. **No field is a function of a later screen's answer, and no value is assigned and then recoded** — the recode pattern that this check exists to catch does not appear.

The genuinely unspecified items — district, communities, rate — are unspecified *deliberately*, are named as solicitation inputs (§12), and are questions for the responding organisation rather than gaps in the design.

### 2. Verifiability — **pass**

Every payable claim resolves to a concrete artifact and a checkable predicate. Layer A is a deterministic field test over a submitted form plus two case facts, with the deduplication key written out (§7.1). Layer B names a real instrument that already exists in the partner's own app rather than inventing a review process (§7.2). Layer C is explicitly out of scope with a stated reason rather than being quietly assumed.

The design also avoids claiming verification it cannot deliver: location is stated as captured, submitted with accuracy, advisory and down-weighted in review — **not** as a gate, not as part of the dedup key, and with no claim that the app or Connect refuses anything on the basis of it.

### 3. Measurability — **pass**

Four primary metrics with definitions and numeric targets (§8.1), five secondary metrics lifted verbatim from Spark's own indicator framework so the numbers are comparable with theirs (§8.2). Denominators are explicit throughout, and where the source framework's denominator is unusable the document says so and substitutes a defined one (§5.2, and S5's restriction to Step ≥ 5).

The primary metric is labelled an **upstream proxy** rather than being dressed as an outcome measure — the pilot window ends before any community project launches, and the document says that plainly.

### 4. Stage-gate clarity — **pass**

Single-stage pilot; no inter-stage gate is required. The entity-level progression that could be mistaken for staging is fully specified instead (§6): states, what moves an entity between them, and what completion means. The boundary to any *next* stage is also stated — the pilot ends at FCAP Step 7, and §10.1 names the income cliff that any extension past Planning must address before it is priced.

### 5. Resource realism — **partial**

The capability half is sound: CBFs are elected community members already trained on FCAP, the pilot assumes facilitation competence and trains only on recording and payment rules, and the cohort is sized to sit under any plausible supervision ratio.

**Graded `partial`, not `pass`, and deliberately so.** The rubric requires costing the labour, and effective earnings **cannot be computed here** because two inputs are missing and neither is ACE's to invent: no rate is proposed (§10.2) and no district is named, so there is no local market floor to compare against. Per the rubric's own instruction, this is stated rather than papered over with an assumed rate.

What the document does supply, and what makes the `partial` an honest floor rather than an omission: the payable volume is quantified (~13 expected meetings per CBF, ceiling 21, ~4.3/month), **seven categories of unpaid work are enumerated** (§10.1), the structural point is made that gross-per-meeting materially overstates earnings per day of field time, and the solicitation is written to require the responding organisation to justify its proposed rate *against that inventory* (§12.3). Two open questions carry the residual — `cbf-compensation-baseline` and `cross-phase-income-cliff`.

### Result

**4 pass, 1 partial → approved.** One non-`pass` check is below the two-check block threshold. The `partial` is a genuine and irreducible property of the current input set — a rate cannot be responsibly proposed from source material that nowhere states what CBFs are paid — and it is routed to the solicitation rather than resolved by invention.

### Waived / not applicable

- **Reviewer comments:** none exist. `drive_list_comments` was run with `includeResolved: true` against the PDD and Work Order of the three most recent prior runs (`20260906-2233`, `20260828-0703`, `20260820-0817`) — all returned zero threads. No reviewer-comment disposition table is therefore included.
- **Layer C:** out of scope with a stated reason (§7.3), not an oversight.
